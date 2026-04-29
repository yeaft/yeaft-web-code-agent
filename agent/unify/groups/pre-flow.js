/**
 * groups/pre-flow.js — explicit pre-flow stage for Unify.
 *
 * Pre-flow is the "before any VP runs" stage. It is responsible for:
 *
 *   (1) VP selection — which VP(s) respond to this user turn?
 *       (added in GC.1 Commit B; today the @-mention dispatch matrix
 *       lives in groups/coordinator.js)
 *
 *   (2) Memory recall — what memory gets pre-injected into each
 *       responding VP's prompt? (this Commit A: thin wrapper around
 *       memory/preflow.js's FTS5 recall.)
 *
 * Right now this module owns only (2). Commit B moves (1) in too.
 *
 * Why a wrapper module instead of calling memory/preflow.js directly:
 *   - Single import surface for the full pre-flow stage.
 *   - Stable seam for the engine — when Commit B adds VP-selection
 *     and Commit C goes parallel, callers keep importing from here.
 *   - Lets us format FTS hits into the {profile, entries, formatted}
 *     shape the engine already consumes from recallV2.
 */

import { runPreflow as runFtsPreflow } from '../memory/preflow.js';

/**
 * Build the heading for a single scope's formatted memory block.
 *
 * Mirrors recall-v2's formatRecallV2 heading style so the system
 * prompt looks the same to the LLM whether recall came from FTS
 * (here) or from per-scope file reads (recall-v2).
 *
 * @param {string} scope
 * @returns {string}
 */
function scopeHeading(scope) {
  if (scope === 'user') return '## Memory: User';
  if (scope.startsWith('group/')) return `## Memory: Group ${scope.slice(6)}`;
  if (scope.startsWith('vp/')) return `## Memory: VP ${scope.slice(3)}`;
  if (scope.startsWith('feature/')) return `## Memory: Feature ${scope.slice(8)}`;
  if (scope.startsWith('topic/')) return `## Memory: Topic ${scope.slice(6)}`;
  return `## Memory: ${scope}`;
}

/**
 * Format FTS picked segments into the prompt-ready string.
 *
 * Picked segments are grouped by scope (preserving the FTS rerank
 * order within each scope group), then rendered as markdown blocks
 * with one heading per scope.
 *
 * @param {Array<{scope: string, body: string, tags?: string[], kind?: string}>} picked
 * @returns {string}
 */
export function formatPickedForInjection(picked) {
  if (!picked || picked.length === 0) return '';
  const byScope = new Map();
  // Preserve insertion order (which is rerank order within each scope).
  for (const seg of picked) {
    const scope = seg.scope || 'unknown';
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(seg);
  }
  const parts = [];
  for (const [scope, segs] of byScope.entries()) {
    parts.push(scopeHeading(scope));
    for (const s of segs) {
      const body = (s.body || '').trim();
      if (body) parts.push(body);
    }
    parts.push('');   // blank line between scopes
  }
  return parts.join('\n').trim();
}

/**
 * @typedef {object} MemoryPreflowOptions
 * @property {string}         userMsg              The user's message
 * @property {string}         [groupId]            Active group, if any
 * @property {string}         [vpId]               Responding VP id, if any
 * @property {string}         [featureId]          Active feature, if any
 * @property {string[]}       [extraScopes]        Additional scopes to include
 * @property {string[]}       [currentTags]        Contextual tags for rerank
 * @property {number}         [topK]               Max FTS rows fetched (default 50)
 * @property {number}         [budgetTokens]       Token budget for picked segments
 */

/**
 * @typedef {object} MemoryPreflowResult
 * @property {string}                   profile      User-scope summary (best-effort)
 * @property {object[]}                 entries      Picked segments (raw)
 * @property {string}                   formatted    Prompt-ready string
 * @property {object}                   meta         Raw FTS preflow metadata
 */

/**
 * Build the canonical scope list for a given (groupId, vpId, featureId).
 * Always includes 'user'. The order is significant — preflow.js's scope
 * filter accepts/rejects by membership, and the formatter renders in
 * order.
 *
 * @param {{groupId?: string, vpId?: string, featureId?: string, extra?: string[]}} ctx
 * @returns {string[]}
 */
export function buildRelevantScopes({ groupId, vpId, featureId, extra } = {}) {
  const scopes = ['user'];
  if (groupId) scopes.push(`group/${groupId}`);
  if (vpId) scopes.push(`vp/${vpId}`);
  if (featureId) scopes.push(`feature/${featureId}`);
  if (Array.isArray(extra)) {
    for (const s of extra) {
      if (s && !scopes.includes(s)) scopes.push(s);
    }
  }
  return scopes;
}

/**
 * Run memory pre-flow for one VP turn. Thin wrapper around
 * `memory/preflow.js::runPreflow` that:
 *
 *   - resolves canonical scope list from {groupId, vpId, featureId},
 *   - invokes FTS5 recall,
 *   - formats picked segments for prompt injection.
 *
 * Returns the engine-consumable {profile, entries, formatted, meta}
 * shape so the existing recall pipeline can swap in without changes.
 *
 * @param {import('../memory/index-db.js').SegmentIndex} index
 * @param {MemoryPreflowOptions} opts
 * @returns {MemoryPreflowResult}
 */
export function runMemoryPreflow(index, opts) {
  if (!index) {
    return { profile: '', entries: [], formatted: '', meta: { skipped: 'no-index' } };
  }
  const userMsg = (opts?.userMsg || '').trim();
  if (!userMsg) {
    return { profile: '', entries: [], formatted: '', meta: { skipped: 'no-user-msg' } };
  }

  const relevantScopes = buildRelevantScopes({
    groupId: opts.groupId,
    vpId: opts.vpId,
    featureId: opts.featureId,
    extra: opts.extraScopes,
  });

  const result = runFtsPreflow(index, {
    userMsg,
    relevantScopes,
    ownVpId: opts.vpId || null,
    currentTags: opts.currentTags || [],
    topK: opts.topK,
    budgetTokens: opts.budgetTokens,
  });

  // Best-effort profile: pick any user-scope segment body.
  const userSeg = (result.picked || []).find(p => p.scope === 'user');
  const profile = userSeg ? (userSeg.body || '').trim() : '';

  const formatted = formatPickedForInjection(result.picked || []);

  return {
    profile,
    entries: result.picked || [],
    formatted,
    meta: {
      keywords: result.keywords,
      ftsQuery: result.ftsQuery,
      pickedTokens: result.pickedTokens,
      droppedCount: result.droppedCount,
      hitCount: (result.hits || []).length,
    },
  };
}
