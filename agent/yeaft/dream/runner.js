/**
 * dream/runner.js.
 *
 * Orchestrates one full dream pass:
 *
 *   trigger
 *     ↓
 *   enumerateSessions()                  via opts.listSessions()
 *     ↓
 *   for each session with newCount ≥ MIN_NEW_PER_GROUP (auto)
 *                    or > 0 (manual)
 *                    or prior messages in a scoped manual session rerun:
 *       loadDiff()                     via opts.loadSessionDiff(sessionId, sinceId)
 *       applyOverlap()                 via opts.loadOverlapPreamble(...)
 *       segment()                      segmentDiff(...)
 *       triage segments                → session-local actions[]
 *
 *   mergeByTarget()                    → per-target actions
 *   for each merged target:
 *       applyMergedTarget()            (snapshot + UPDATE/CREATE + atomic write)
 *
 *   bookkeep:
 *     for each processed session:
 *       session .dream-state ←
 *         { lastDreamMessageId: tail of real diff,
 *           lastDreamAt: nowIso,
 *           messageCount: <after> }
 *
 *   pruneOldSnapshots()
 *
 *   onProgress emits dream_progress events that the web bridge forwards
 *   as `yeaft_output` messages so the debug panel can render live state
 *  . All events flow through the same channel; no new
 *   WebSocket message type is introduced.
 *
 * Everything that touches a shell of the system (LLM, message store,
 * scope listing, topic tree) is injected. The default exports below
 * are pure orchestration.
 */

import { existsSync } from 'fs';
import { join } from 'path';

import { listScopes, readSummary } from '../memory/store.js';
import {
  DEFAULT_LIMITS,
} from './limits.js';
import { clearDreamError, readSessionState, writeSessionState, writeDreamError } from './state.js';
import { segmentDiff, truncateMessage, estimateMessagesTokens } from './segment.js';
import { triageGroupSegments } from './triage.js';
import { mergeByTarget } from './merge.js';
import { applyMergedTarget } from './apply.js';
import { extractAndWriteMemorySegments } from './segment-extract.js';
import { tsForBackup, pruneOldSnapshots } from './snapshot.js';

/**
 * @typedef {Object} RunDreamOpts
 * @property {string} root                    — memory root, e.g. ~/.yeaft/memory
 * @property {boolean} [manual=false]         — manual trigger overrides newCount<20 skip
 * @property {string[]} [scopeFilter]         — optional: only dream these targets; scoped manual session triggers rerun the current session when there are prior messages but no new cursor delta ('*' allowed)
 * @property {(req: {pass:string, prompt:string, system:string}) => Promise<string>} llm
 * @property {() => Promise<Array<string>>} listSessions   — return all session ids (incl. '_no-session')
 * @property {(sessionId: string) => Promise<number>} countMessages   — total message count for a session
 * @property {(sessionId: string, sinceMessageId: string|null) => Promise<Array<object>>} [loadSessionDiff]
 * @property {(sessionId: string, sinceMessageId: string|null) => Promise<Array<object>>} [loadGroupDiff] — legacy alias for loadSessionDiff
 * @property {(sessionId: string, beforeMessageId: string|null, count: number) => Promise<Array<object>>} loadOverlapPreamble
 * @property {() => Promise<Array<{path:string, summary:string}>>} [listTopicSummaries]
 * @property {(target: string) => Promise<Array<{path:string, summary:string}>>} [siblingTopicsFor]
 * @property {import('../memory/index-db.js').SegmentIndex|null} [segmentIndex] — optional derived FTS segment index to sync after segment writes
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

  // 1. enumerate sessions
  const sessionIds = await safeCall(opts.listSessions, []);
  const filter = Array.isArray(opts.scopeFilter) ? new Set(opts.scopeFilter) : null;
  const sessionFilter = deriveSessionFilter(filter);
  const sessionsReport = [];
  const sessionTriages = [];
  const processedSessions = [];

  // 2. per-session: skip / segment / triage
  // Topic summaries are resolved inside the per-session loop
  // them inside the per-session loop instead of once up front.
  const resolveTopicSummaries = async (sessionId) => {
    if (opts.listTopicSummaries) {
      return await safeCall(() => opts.listTopicSummaries(sessionId), []);
    }
    return await defaultListTopicSummaries(opts.root, sessionId, opts.language).catch(() => []);
  };

  for (const sessionId of sessionIds) {
    // Current-session manual dream passes are the one case where scopeFilter
    // must constrain enumeration too: clicking the conversation header means
    // "dream this session now", not "triage every session and then only apply
    // sessions/<id>". Pure target filters such as ['user'] still triage every
    // session so their hard-rule actions can contribute to the requested scope.
    if (sessionFilter && !sessionFilter.has(sessionId)) {
      sessionsReport.push({ sessionId, new: 0, status: 'skipped', reason: 'scope-filtered' });
      continue;
    }
    const state = await readSessionState(opts.root, sessionId);
    const beforeCount = await safeCall(() => opts.countMessages(sessionId), 0);
    const newCount = Math.max(0, beforeCount - (state.messageCount || 0));

    const rerunScopedManual = !!opts.manual
      && sessionFilter
      && sessionFilter.has(sessionId)
      && newCount === 0
      && beforeCount > 0;

    if (newCount === 0 && !rerunScopedManual) {
      sessionsReport.push({ sessionId, new: 0, status: 'skipped', reason: 'no-new-messages' });
      continue;
    }
    if (!opts.manual && newCount < limits.MIN_NEW_PER_GROUP) {
      sessionsReport.push({ sessionId, new: newCount, status: 'skipped', reason: 'below-threshold' });
      continue;
    }

    onProgress({ phase: 'load-diff', sessionId });
    const diffCursor = rerunScopedManual ? null : state.lastDreamMessageId;
    const loadDiff = opts.loadSessionDiff || opts.loadGroupDiff;
    const diffNew = await safeCall(() => loadDiff(sessionId, diffCursor), []);
    if (!diffNew || diffNew.length === 0) {
      sessionsReport.push({ sessionId, new: newCount, status: 'skipped', reason: 'empty-diff' });
      continue;
    }
    const overlapMessages = state.lastDreamMessageId && !rerunScopedManual
      ? await safeCall(
          () => opts.loadOverlapPreamble
            ? opts.loadOverlapPreamble(sessionId, state.lastDreamMessageId, limits.DREAM_OVERLAP)
            : [],
          [],
        )
      : [];
    const taggedOverlap = overlapMessages.map(m => ({ ...m, kind: 'overlap', body: truncateMessage(m.body || '') }));
    const taggedNew = diffNew.map(m => ({ ...m, kind: 'new', body: truncateMessage(m.body || '') }));
    const fullDiff = [...taggedOverlap, ...taggedNew];

    const segments = segmentDiff(fullDiff, limits.MAX_DIFF_TOKENS_PER_TRIAGE, limits.DREAM_OVERLAP);
    onProgress({ phase: 'triage', sessionId, status: 'running', segments: segments.length });

    let actions;
    try {
      const topicSummaries = await resolveTopicSummaries(sessionId);
      actions = await triageGroupSegments({
        sessionId,
        segments,
        topicSummaries,
        llm: dreamLlmForSession(opts.llm, sessionId),
        onProgress,
        language: opts.language,
      });
    } catch (err) {
      sessionsReport.push({ sessionId, new: newCount, status: 'error', error: err.message });
      onProgress({ phase: 'triage', sessionId, status: 'error', error: err.message });
      // Journal the failure on disk so operators can see WHY dream is
      // not advancing without having to enable `config.debug`. Best-
      // effort — `writeDreamError` swallows its own I/O errors.
      await writeDreamError(opts.root, `sessions/${sessionId}`, {
        phase: 'triage',
        message: err.message,
        stack: err.stack,
        rawSnippet: err.rawSnippet,
      });
      continue;
    }

    onProgress({ phase: 'triage', sessionId, status: 'done', actions: actions.length });
    sessionTriages.push({ sessionId, diff: fullDiff, actions });

    const tailId = lastMessageId(diffNew);
    processedSessions.push({ sessionId, tailId, beforeCount, newCount, segments: segments.length, actions: actions.length });
    sessionsReport.push({ sessionId, new: newCount, segments: segments.length, actions: actions.length, status: 'triaged', rerun: rerunScopedManual || undefined });
  }

  // 3. merge
  const mergedTargets = mergeByTarget(sessionTriages);
  const targetsToApply = filter && filter.size > 0 && !filter.has('*')
    ? mergedTargets.filter(t => filter.has(t.target) || filter.has(`sessions/${sourceSessionId(t)}`))
    : mergedTargets;

  onProgress({ phase: 'merge', targets: targetsToApply.length });

  // 4. apply
  const targetsReport = [];
  for (const merged of targetsToApply) {
    try {
      const r = await applyMergedTarget(merged, {
        root: opts.root,
        ts,
        llm: dreamLlmForSession(opts.llm, sourceSessionId(merged)),
        limits,
        nowIso: opts.nowIso || (() => nowIso),
        onProgress,
        siblingTopicsFor: opts.siblingTopicsFor,
        language: opts.language,
      });
      await clearDreamError(opts.root, merged.target);
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
        rawSnippet: err.rawSnippet,
      });
    }
  }

  // 5. extract atomic H2 memory segments. The apply step above keeps the
  // coarse summary layer (`summary.md`); this step keeps bounded, evidence-
  // backed current details in segment-formatted `memory.md`.
  const segmentReports = [];
  for (const triage of sessionTriages) {
    const appliedTargets = new Set(targetsReport.filter(r => r.status === 'done').map(r => r.target));
    const targets = triage.actions.map(a => a.scope).filter(scope => appliedTargets.has(scope));
    if (targets.length === 0) continue;
    try {
      onProgress({ phase: 'extract-segments', sessionId: triage.sessionId, status: 'running', targets: targets.length });
      const r = await extractAndWriteMemorySegments({
        root: opts.root,
        sessionId: triage.sessionId,
        messages: triage.diff,
        targets,
        llm: dreamLlmForSession(opts.llm, triage.sessionId),
        language: opts.language,
        nowIso: opts.nowIso || (() => nowIso),
        segmentIndex: opts.segmentIndex || null,
      });
      await clearDreamError(opts.root, `sessions/${triage.sessionId}`);
      segmentReports.push({ sessionId: triage.sessionId, status: 'done', ...r });
      onProgress({ phase: 'extract-segments', sessionId: triage.sessionId, status: 'done', ...r });
    } catch (err) {
      segmentReports.push({ sessionId: triage.sessionId, status: 'error', error: err.message });
      onProgress({ phase: 'extract-segments', sessionId: triage.sessionId, status: 'error', error: err.message });
      await writeDreamError(opts.root, `sessions/${triage.sessionId}`, {
        phase: 'extract-segments',
        message: err.message,
        stack: err.stack,
      });
    }
  }

  // 6. bookkeep — only when at least one apply for this session's actions
  // succeeded. We use a permissive policy: if ANY merged-target apply
  // succeeded for a session's contributed actions, advance that session's
  // cursor. (If everything errored, we keep the cursor so next run
  // retries.)
  const successfulTargets = new Set(targetsReport.filter(r => r.status === 'done').map(r => r.target));
  for (const pg of processedSessions) {
    const contributed = (sessionTriages.find(g => g.sessionId === pg.sessionId) || { actions: [] })
      .actions.map(a => a.scope);
    const anySuccess = contributed.some(t => successfulTargets.has(t));
    if (!anySuccess) continue;
    if (pg.tailId) {
      await writeSessionState(opts.root, pg.sessionId, {
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
    sessions: processedSessions.length,
    targets: targetsReport.length,
    duration,
    backupsKept: pruned.kept.length,
    backupsRemoved: pruned.removed.length,
  });

  return {
    startedAt: nowIso,
    durationMs: duration,
    sessions: sessionsReport,
    targets: targetsReport,
    memorySegments: segmentReports,
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

function deriveSessionFilter(filter) {
  if (!filter || filter.size === 0 || filter.has('*')) return null;
  const sessions = [];
  for (const scope of filter) {
    if (typeof scope !== 'string') continue;
    const m = /^sessions\/([^/]+)$/.exec(scope);
    if (m && m[1]) sessions.push(m[1]);
  }
  return sessions.length > 0 ? new Set(sessions) : null;
}

function dreamLlmForSession(llm, sessionId) {
  return (req = {}) => llm({ ...req, sessionId: req.sessionId || sessionId || null });
}

function sourceSessionId(mergedTarget) {
  const src = Array.isArray(mergedTarget?.sources) ? mergedTarget.sources[0] : null;
  return src && typeof src.sessionId === 'string' ? src.sessionId : '';
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

async function defaultListTopicSummaries(root, sessionId, language) {
  const all = await listScopes({ root });
  const out = [];
  for (const sc of all) {
    if (sc.kind !== 'group-topic') continue;
    if (sc.sessionId !== sessionId) continue;
    const summary = await readSummary(sc, { root, language });
    out.push({ path: sc.path.join('/'), summary });
  }
  return out;
}
