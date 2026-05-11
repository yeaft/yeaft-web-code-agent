/**
 * dream-v2/runner.js.
 *
 * Orchestrates one full dream pass:
 *
 *   trigger
 *     ↓
 *   enumerateGroups()                  via opts.listGroups()
 *     ↓
 *   for each group with newCount ≥ MIN_NEW_PER_GROUP (auto)
 *                    or > 0 (manual):
 *       loadDiff()                     via opts.loadGroupDiff(groupId, sinceId)
 *       applyOverlap()                 via opts.loadOverlapPreamble(...)
 *       segment()                      segmentDiff(...)
 *       triageGroupSegments()          → group-local actions[]
 *
 *   mergeByTarget()                    → per-target actions
 *   for each merged target:
 *       applyMergedTarget()            (snapshot + UPDATE/CREATE + atomic write)
 *
 *   bookkeep:
 *     for each processed group:
 *       group .dream-state ←
 *         { lastDreamMessageId: tail of real diff,
 *           lastDreamAt: nowIso,
 *           messageCount: <after> }
 *
 *   pruneOldSnapshots()
 *
 *   onProgress emits dream_progress events that the web bridge forwards
 *   as `unify_output` messages so the debug panel can render live state
 *  . All events flow through the same channel; no new
 *   WebSocket message type is introduced.
 *
 * Everything that touches a shell of the system (LLM, message store,
 * scope listing, topic tree) is injected. The default exports below
 * are pure orchestration.
 */

import { existsSync } from 'fs';
import { join } from 'path';

import { listScopes, readSummary } from '../memory/store-v2.js';
import {
  DEFAULT_LIMITS,
} from './limits.js';
import { readGroupState, writeGroupState, writeDreamError } from './state.js';
import { segmentDiff, truncateMessage, estimateMessagesTokens } from './segment.js';
import { triageGroupSegments } from './triage.js';
import { mergeByTarget } from './merge.js';
import { applyMergedTarget } from './apply.js';
import { tsForBackup, pruneOldSnapshots } from './snapshot.js';

/**
 * @typedef {Object} RunDreamOpts
 * @property {string} root                    — memory root, e.g. ~/.yeaft/memory
 * @property {boolean} [manual=false]         — manual trigger overrides newCount<20 skip
 * @property {string[]} [scopeFilter]         — optional: only dream these targets (still respects newCount per group; '*' allowed)
 * @property {(req: {pass:string, prompt:string, system:string}) => Promise<string>} llm
 * @property {() => Promise<Array<string>>} listGroups   — return all group ids (incl. '_no-group')
 * @property {(groupId: string) => Promise<number>} countMessages   — total message count for a group
 * @property {(groupId: string, sinceMessageId: string|null) => Promise<Array<object>>} loadGroupDiff
 * @property {(groupId: string, beforeMessageId: string|null, count: number) => Promise<Array<object>>} loadOverlapPreamble
 * @property {() => Promise<Array<{path:string, summary:string}>>} [listTopicSummaries]
 * @property {(target: string) => Promise<Array<{path:string, summary:string}>>} [siblingTopicsFor]
 * @property {(event: object) => void} [onProgress]
 * @property {object} [limits]                — override DEFAULT_LIMITS
 * @property {() => string} [nowIso]
 */

/**
 * Run one dream pass. Returns a structured report consumed by the
 * debug panel (and tests).
 *
 * @param {RunDreamOpts} opts
 */
export async function runDream(opts) {
  if (!opts || !opts.root) throw new Error('runDream: opts.root required');
  if (!opts.llm) throw new Error('runDream: opts.llm required');
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const nowIso = (opts.nowIso ? opts.nowIso() : new Date().toISOString());
  const ts = tsForBackup(new Date(nowIso));
  const startedAt = Date.now();

  onProgress({ phase: 'start', manual: !!opts.manual, ts });

  // 1. enumerate groups
  const groupIds = await safeCall(opts.listGroups, []);
  const filter = Array.isArray(opts.scopeFilter) ? new Set(opts.scopeFilter) : null;
  const groupsReport = [];
  const groupTriages = [];
  const processedGroups = [];

  // 2. per-group: skip / segment / triage
  const topicSummaries = opts.listTopicSummaries
    ? await safeCall(opts.listTopicSummaries, [])
    : await defaultListTopicSummaries(opts.root).catch(() => []);

  for (const groupId of groupIds) {
    // NOTE: scopeFilter is applied at the merge/apply stage, not here.
    // A filter like ['user'] still requires triaging every group so their
    // hard-rule actions can contribute to the user target.
    const state = await readGroupState(opts.root, groupId);
    const beforeCount = await safeCall(() => opts.countMessages(groupId), 0);
    const newCount = Math.max(0, beforeCount - (state.messageCount || 0));

    if (newCount === 0) {
      groupsReport.push({ groupId, new: 0, status: 'skipped', reason: 'no-new-messages' });
      continue;
    }
    if (!opts.manual && newCount < limits.MIN_NEW_PER_GROUP) {
      groupsReport.push({ groupId, new: newCount, status: 'skipped', reason: 'below-threshold' });
      continue;
    }

    onProgress({ phase: 'load-diff', groupId });
    const diffNew = await safeCall(() => opts.loadGroupDiff(groupId, state.lastDreamMessageId), []);
    if (!diffNew || diffNew.length === 0) {
      groupsReport.push({ groupId, new: newCount, status: 'skipped', reason: 'empty-diff' });
      continue;
    }
    const overlapMessages = state.lastDreamMessageId
      ? await safeCall(
          () => opts.loadOverlapPreamble
            ? opts.loadOverlapPreamble(groupId, state.lastDreamMessageId, limits.DREAM_OVERLAP)
            : [],
          [],
        )
      : [];
    const taggedOverlap = overlapMessages.map(m => ({ ...m, kind: 'overlap', body: truncateMessage(m.body || '') }));
    const taggedNew = diffNew.map(m => ({ ...m, kind: 'new', body: truncateMessage(m.body || '') }));
    const fullDiff = [...taggedOverlap, ...taggedNew];

    const segments = segmentDiff(fullDiff, limits.MAX_DIFF_TOKENS_PER_TRIAGE, limits.DREAM_OVERLAP);
    onProgress({ phase: 'triage', groupId, status: 'running', segments: segments.length });

    let actions;
    try {
      actions = await triageGroupSegments({
        groupId,
        segments,
        topicSummaries,
        llm: opts.llm,
        onProgress,
        language: opts.language,
      });
    } catch (err) {
      groupsReport.push({ groupId, new: newCount, status: 'error', error: err.message });
      onProgress({ phase: 'triage', groupId, status: 'error', error: err.message });
      // Journal the failure on disk so operators can see WHY dream is
      // not advancing without having to enable `config.debug`. Best-
      // effort — `writeDreamError` swallows its own I/O errors.
      await writeDreamError(opts.root, `group/${groupId}`, {
        phase: 'triage',
        message: err.message,
        stack: err.stack,
      });
      continue;
    }

    onProgress({ phase: 'triage', groupId, status: 'done', actions: actions.length });
    groupTriages.push({ groupId, diff: fullDiff, actions });

    const tailId = lastMessageId(diffNew);
    processedGroups.push({ groupId, tailId, beforeCount, newCount, segments: segments.length, actions: actions.length });
    groupsReport.push({ groupId, new: newCount, segments: segments.length, actions: actions.length, status: 'triaged' });
  }

  // 3. merge
  const mergedTargets = mergeByTarget(groupTriages);
  const targetsToApply = filter && filter.size > 0 && !filter.has('*')
    ? mergedTargets.filter(t => filter.has(t.target))
    : mergedTargets;

  onProgress({ phase: 'merge', targets: targetsToApply.length });

  // 4. apply
  const targetsReport = [];
  for (const merged of targetsToApply) {
    try {
      const r = await applyMergedTarget(merged, {
        root: opts.root,
        ts,
        llm: opts.llm,
        limits,
        nowIso: opts.nowIso || (() => nowIso),
        onProgress,
        siblingTopicsFor: opts.siblingTopicsFor,
        language: opts.language,
      });
      targetsReport.push({ ...r, sources: merged.sources.length, status: 'done' });
    } catch (err) {
      targetsReport.push({
        target: merged.target,
        kind: merged.kind,
        sources: merged.sources.length,
        status: 'error',
        error: err.message,
      });
      onProgress({ phase: 'apply', target: merged.target, status: 'error', error: err.message });
      // Journal apply-stage failures into the target scope's directory
      // (`<root>/<merged.target>/.dream-last-error.json`). Same rationale
      // as the triage catch above.
      await writeDreamError(opts.root, merged.target, {
        phase: 'apply',
        message: err.message,
        stack: err.stack,
      });
    }
  }

  // 5. bookkeep — only when at least one apply for this group's actions
  // succeeded. We use a permissive policy: if ANY merged-target apply
  // succeeded for a group's contributed actions, advance that group's
  // cursor. (If everything errored, we keep the cursor so next run
  // retries.)
  const successfulTargets = new Set(targetsReport.filter(r => r.status === 'done').map(r => r.target));
  for (const pg of processedGroups) {
    const contributed = (groupTriages.find(g => g.groupId === pg.groupId) || { actions: [] })
      .actions.map(a => a.scope);
    const anySuccess = contributed.some(t => successfulTargets.has(t));
    if (!anySuccess) continue;
    if (pg.tailId) {
      await writeGroupState(opts.root, pg.groupId, {
        lastDreamMessageId: pg.tailId,
        lastDreamAt: nowIso,
        messageCount: pg.beforeCount,
      });
    }
  }

  // 6. prune backups
  const pruned = await pruneOldSnapshots(opts.root, limits.DREAM_BACKUP_KEEP);

  const duration = Date.now() - startedAt;
  onProgress({
    phase: 'done',
    groups: processedGroups.length,
    targets: targetsReport.length,
    duration,
    backupsKept: pruned.kept.length,
    backupsRemoved: pruned.removed.length,
  });

  return {
    startedAt: nowIso,
    durationMs: duration,
    groups: groupsReport,
    targets: targetsReport,
    backups: pruned,
    ts,
  };
}

// ─── helpers ──────────────────────────────────────────────────

function lastMessageId(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].id) return messages[i].id;
  }
  return null;
}

async function safeCall(fn, fallback) {
  try {
    if (typeof fn !== 'function') return fallback;
    const v = await fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

async function defaultListTopicSummaries(root) {
  const all = await listScopes({ root });
  const out = [];
  for (const sc of all) {
    if (sc.kind !== 'topic') continue;
    const summary = await readSummary(sc, { root });
    out.push({ path: sc.path.join('/'), summary });
  }
  return out;
}
