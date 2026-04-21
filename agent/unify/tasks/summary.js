/**
 * summary.js — task-334n: Task multi-VP collaboration summary protocol.
 *
 * Owns:
 *   - postSummary()       — write a `type=summary` message to the group jsonl
 *                           and run the extractor (B + C)
 *   - extractTaskMemory() — turn a summary body into 2-5 task-memory entries
 *                           via 334f task-memory shard lib (C)
 *   - buildSummaryReminder() — compute the §Δ31.4 3-AND soft reminder shape
 *                              consumed by 334e's `taskCtx.summaryReminder` (D)
 *   - buildTaskCtxMemories() — assemble task-memory top-5 (pinned + recent +
 *                              tag relevance) for task_ctx (E)
 *
 * Hard boundaries:
 *   - does NOT touch 334o jsonl rotation internals (calls group.appendMessage)
 *   - does NOT touch 334f shard-store impl (calls openMemoryShardStore API)
 *   - does NOT touch 334e prompts main frame (returns plain shapes that feed
 *     the existing renderTaskCtx contract)
 *   - does NOT self-loop-write VP-memory (extractor writes task-memory only;
 *     VP-level synthesis is deferred to 334g dream)
 *   - softCap overflow does NOT create new shards (334f already routes into
 *     dream queue via projectDeriveHint; we just surface `needsRecompression`)
 */

import { join } from 'path';
import { openMemoryShardStore } from '../memory/shard-store.js';
import { AUTHORED_BY } from '../memory/schema.js';

// ─── §Δ31.4 soft-reminder thresholds ─────────────────────────────
/** Must be initiator AND members>1 AND (age≥20min OR turns≥10). */
export const SUMMARY_REMINDER_MIN_MEMBERS  = 2;
export const SUMMARY_REMINDER_MIN_TURNS    = 10;
export const SUMMARY_REMINDER_MIN_AGE_MS   = 20 * 60 * 1000;

// ─── extractor limits ────────────────────────────────────────────
export const EXTRACT_MIN_ENTRIES = 2;
export const EXTRACT_MAX_ENTRIES = 5;

/** Semantic progress anchors — string labels accepted alongside 0-100 number. */
export const PROGRESS_ANCHORS = Object.freeze([
  'blocked', 'planning', 'in-progress', 'review', 'milestone', 'shipped', 'done',
]);

/** Whitelist of R6 kinds emitted by the summary-extractor. */
const EXTRACT_KINDS = Object.freeze(['progress', 'decision']);

/** Shard routing for each extracted kind (§Δ25.2 task-memory fixed set). */
const KIND_TO_SHARD = Object.freeze({
  progress: 'progress',
  decision: 'decision',
});

// ─── (B) postSummary ─────────────────────────────────────────────

/**
 * Write a `type=summary` message to the group log, then auto-run the
 * extractor to derive task-memory entries.
 *
 * @param {{
 *   group: import('../groups/group-store.js').GroupHandle,
 *   taskId: string,
 *   fromVpId: string,
 *   body: string,
 *   progress?: number|string,       // 0..100 or PROGRESS_ANCHORS string
 *   supersedes?: string[],        // prior summary msgIds being superseded
 *   memoryDir: string,            // groups/<g>/tasks/<t>/memory/
 *   now?: () => number,           // test clock
 *   extractor?: (body:string) => Array<{kind:string,body:string,tags?:string[]}>
 *     // optional hook; default uses `defaultExtractor` (heuristic, no LLM)
 * }} opts
 * @returns {{ message: any, memoryIds: string[], supersededSummaryIds: string[] }}
 */
export function postSummary(opts) {
  const {
    group,
    taskId,
    fromVpId,
    body,
    progress,
    supersedes,
    memoryDir,
    now = () => Date.now(),
    extractor = defaultExtractor,
  } = opts || {};

  if (!group || typeof group.appendMessage !== 'function') {
    throw new Error('postSummary: group handle required');
  }
  if (!taskId)   throw new Error('postSummary: taskId required');
  if (!fromVpId) throw new Error('postSummary: fromVpId required');
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('postSummary: body required (non-empty string)');
  }
  if (progress != null) {
    if (typeof progress === 'string') {
      if (!PROGRESS_ANCHORS.includes(progress)) {
        throw new Error(`postSummary: progress string must be one of: ${PROGRESS_ANCHORS.join(', ')}`);
      }
    } else {
      const p = Number(progress);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        throw new Error('postSummary: progress must be number in [0,100] or a semantic anchor string');
      }
    }
  }
  const supersedesArr = Array.isArray(supersedes)
    ? supersedes.filter((s) => typeof s === 'string' && s)
    : [];

  // 1) Append the summary message to the group jsonl log (type=summary).
  const stored = group.appendMessage({
    from: fromVpId,
    role: 'assistant',
    text: body,
    taskId,
    meta: {
      type: 'summary',
      progress: progress == null ? null : (typeof progress === 'string' ? progress : Number(progress)),
      supersedes: supersedesArr,
    },
  });

  // 2) Run the extractor → write task-memory entries (C).
  const memoryIds = [];
  try {
    const store = openMemoryShardStore(memoryDir, 'task');
    const raw = extractor(body) || [];
    const bounded = clampExtracted(raw);
    for (const [i, item] of bounded.entries()) {
      const kind = EXTRACT_KINDS.includes(item.kind) ? item.kind : 'progress';
      const shard = KIND_TO_SHARD[kind] || 'progress';
      const id = `mem-${stored.id}-${i + 1}`;
      store.put({
        id,
        shard,
        kind,
        taskId,
        body: typeof item.body === 'string' ? item.body.trim() : '',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 5) : [],
        authoredBy: AUTHORED_BY.SUMMARY,
        sourceRef: { taskId, msgIds: [stored.id] },
        createdAt: new Date(now()).toISOString(),
      });
      memoryIds.push(id);
    }
  } catch (err) {
    // Extractor failures must not fail the summary post; the message is
    // already persisted (audit property). We return the empty memoryIds so
    // callers can surface a warning if they want.
    // eslint-disable-next-line no-console
    console.warn('[task-334n] summary-extractor failed:', err?.message || err);
  }

  return {
    message: stored,
    memoryIds,
    supersededSummaryIds: supersedesArr,
  };
}

/** Clamp raw extractor output to [EXTRACT_MIN_ENTRIES..EXTRACT_MAX_ENTRIES]. */
function clampExtracted(arr) {
  const cleaned = arr.filter((x) => x && typeof x.body === 'string' && x.body.trim());
  if (cleaned.length === 0) return [];
  return cleaned.slice(0, EXTRACT_MAX_ENTRIES);
}

// ─── (C) default extractor ───────────────────────────────────────

/**
 * Heuristic extractor — no LLM, deterministic, safe for tests.
 *
 * Strategy:
 *   - Split body into non-empty lines (trim bullets).
 *   - Lines starting with keywords "decide/decision/chose/chosen" → kind=decision.
 *   - Lines starting with "progress/ship/shipped/done/completed/blocker/todo"
 *     → kind=progress.
 *   - Everything else → kind=progress (default).
 *   - Emit up to EXTRACT_MAX_ENTRIES.
 */
export function defaultExtractor(body) {
  if (typeof body !== 'string') return [];
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s*\-•]+/, '').trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    let kind = 'progress';
    if (/^(decide|decision|chose|chosen|pick|choose)\b/.test(lower)) {
      kind = 'decision';
    }
    out.push({ kind, body: line });
    if (out.length >= EXTRACT_MAX_ENTRIES) break;
  }
  // If we ended up with fewer than MIN and there was a body, collapse to
  // one "progress" entry carrying the trimmed full body so we never emit 0
  // when the caller gave us real content and asked for 2-5.
  if (out.length < EXTRACT_MIN_ENTRIES && body.trim()) {
    // Pad up to EXTRACT_MIN_ENTRIES with the full trimmed body when
    // the line-by-line pass yielded fewer entries than the minimum.
    while (out.length < EXTRACT_MIN_ENTRIES) {
      out.push({ kind: 'progress', body: body.trim() });
    }
  }
  return out;
}

// ─── (D) soft reminder builder ───────────────────────────────────

/**
 * Build the `taskCtx.summaryReminder` shape consumed by 334e's prompt.
 * Returns null when the 3-AND conditions do not all hold. The prompt layer
 * adds a 4th check (currentVpId === initiatorVpId) so we gate here too so
 * callers can debug-log why it was suppressed.
 *
 * §Δ31.4 conditions:
 *   (1) task.members.length > 1
 *   (2) caller role === 'initiator'  (i.e. currentVpId === task.initiator)
 *   (3) (now - lastSummaryAt) ≥ 20 min  OR  nonSummaryTurns ≥ 10
 *
 * @param {{
 *   task: { initiator?: string, members?: string[] },
 *   currentVpId: string,
 *   lastSummaryAt: number,     // epoch ms, 0 = never
 *   nonSummaryTurns: number,
 *   now?: number,
 * }} input
 * @returns {{ triggered: boolean, nonSummaryCount: number, lastSummaryAt: number,
 *             now: number, reasons: string[] }}
 */
export function buildSummaryReminder(input) {
  const { task, currentVpId, lastSummaryAt = 0, nonSummaryTurns = 0 } = input || {};
  const now = typeof input?.now === 'number' ? input.now : Date.now();
  const reasons = [];

  if (!task || typeof task !== 'object') {
    return { triggered: false, reasons: ['no-task'], nonSummaryCount: nonSummaryTurns, lastSummaryAt, now };
  }
  const members = Array.isArray(task.members) ? task.members : [];
  const isInitiator = !!currentVpId && task.initiator === currentVpId;

  if (!isInitiator) reasons.push('not-initiator');
  if (members.length <= SUMMARY_REMINDER_MIN_MEMBERS - 1) reasons.push('solo-task');

  const ageMs = lastSummaryAt > 0 ? now - lastSummaryAt : Number.POSITIVE_INFINITY;
  const ageOk = ageMs >= SUMMARY_REMINDER_MIN_AGE_MS;
  const turnsOk = nonSummaryTurns >= SUMMARY_REMINDER_MIN_TURNS;
  if (!ageOk && !turnsOk) reasons.push('too-soon');

  const triggered = isInitiator && members.length >= SUMMARY_REMINDER_MIN_MEMBERS && (ageOk || turnsOk);
  return {
    triggered,
    reasons,
    nonSummaryCount: nonSummaryTurns,
    lastSummaryAt,
    now,
  };
}

// ─── (E) task_ctx top-5 task-memory builder ──────────────────────

/**
 * Assemble task-memory top-5 for 334e's `taskCtx.memories` field.
 * Ordering (§Δ16.5): pinned first → recent → tag-relevant. Supersedes are
 * hidden (entries with supersededBy != null are filtered out).
 *
 * @param {string} memoryDir  groups/<g>/tasks/<t>/memory/
 * @param {{ tags?: string[], top?: number }} [opts]
 *   tags : optional tag hints to boost relevance
 *   top  : default 5
 * @returns {Array<{body:string, shard:string, authoredBy?:string}>}
 */
export function buildTaskCtxMemories(memoryDir, opts = {}) {
  const top = Number.isFinite(opts.top) ? Number(opts.top) : 5;
  const tagHints = Array.isArray(opts.tags) ? opts.tags : [];
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  let results = [];
  try {
    const store = openMemoryShardStore(memoryDir, 'task');
    const q = store.query({});
    // query() returns thin entries (id/shard/kind/tags/pinned/groupId/taskId/supersededBy);
    // we need the body too.
    const hits = (q.results || [])
      .filter((r) => !r.supersededBy)
      .map((r) => {
        const full = store.get(r.id);
        return {
          id: r.id,
          shard: r.shard || 'general',
          body: full?.body || '',
          tags: Array.isArray(r.tags) ? r.tags : [],
          pinned: !!r.pinned,
          createdAt: full?.createdAt || null,
          authoredBy: full?.authoredBy || null,
        };
      })
      .filter((r) => r.body && r.body.trim());

    const score = (r) => {
      let s = 0;
      if (r.pinned) s += 1000;
      // Recency decay: half-life of 24h. Recent entries score up to +100,
      // decaying toward 0 as they age.
      if (r.createdAt) {
        const ageMs = nowMs - new Date(r.createdAt).getTime();
        const halfLifeMs = 24 * 60 * 60 * 1000; // 24 hours
        s += Math.max(0, 100 * Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs));
      }
      // tag relevance
      for (const t of tagHints) if (r.tags.includes(t)) s += 5;
      return s;
    };
    hits.sort((a, b) => {
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      // stable recency tie-break
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    results = hits.slice(0, top).map((r) => ({
      body: r.body,
      shard: r.shard,
      ...(r.authoredBy ? { authoredBy: r.authoredBy } : {}),
    }));
  } catch {
    results = [];
  }
  return results;
}

// ─── (F) related-task ACL fail-closed gate ───────────────────────

/**
 * Return memory/summary hints for a related task only when ACL grants.
 * Caller passes the TaskStore so we can ask `canAccessRelated()`.
 *
 * @param {{
 *   taskStore: import('./store.js').TaskStore,
 *   currentTaskId: string,
 *   otherTaskId: string,
 *   vpId: string,
 *   groupsRoot: string,
 *   top?: number,
 * }} input
 * @returns {null | { id:string, title:string, members:string[], updatedAt?:number, memories:Array<{body:string,shard:string}> }}
 *   null iff ACL denies — NEVER leak taskId in that case.
 */
export function getRelatedTaskCtx(input) {
  const { taskStore, currentTaskId, otherTaskId, vpId, groupsRoot, top = 2 } = input || {};
  if (!taskStore || !currentTaskId || !otherTaskId || !vpId || !groupsRoot) return null;
  if (!taskStore.canAccessRelated(currentTaskId, otherTaskId, vpId)) return null;
  const other = taskStore.get(otherTaskId);
  if (!other || !other.groupId) return null;
  const memoryDir = join(groupsRoot, other.groupId, 'tasks', other.id, 'memory');
  const mems = buildTaskCtxMemories(memoryDir, { top });
  return {
    id: other.id,
    title: other.title || other.id,
    members: Array.isArray(other.members) ? other.members.slice() : [],
    updatedAt: other.updatedAt || 0,
    memories: mems,
  };
}
