/**
 * groups/pre-flow.js — explicit pre-flow stage for Yeaft.
 *
 * Pre-flow is the "before any VP runs" stage. It owns:
 *
 *   (1) VP selection — which VP(s) respond to this user turn?
 *       Pure function `selectRespondingVps({meta, fromUser, mentions,
 *       sender, taskMembers, fanOutCap})` that mirrors the legacy
 *       coordinator dispatch matrix: mention → broadcast → fallback to
 *       defaultVpId, with VP-authored messages routed via the explicit
 *       route_forward tool instead of free-text @-mentions.
 *
 *   (2) Memory recall — what memory gets pre-injected into each
 *       responding VP's prompt? Thin wrapper around
 *       memory/preflow.js's FTS5 recall.
 *
 * Commit C will flip the caller (web-bridge.js) to fan out responding
 * VPs in parallel via Promise.all.
 *
 * Why one module: a single import surface for the full pre-flow stage,
 * a stable seam for the engine, and a place to format FTS hits into the
 * {profile, entries, formatted} shape the engine already consumes.
 */

import { runPreflow as runFtsPreflow } from '../memory/preflow.js';
import { resolveFallbackVp, resolveMemberId } from './roster.js';

/** Matches `@vp-id` where id is [A-Za-z0-9_-]+. Captures the id. */
const MENTION_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_-]*)/g;

/**
 * Extract an ordered, unique list of @-mentions from a text string.
 * Recognises the literal token `@all` as broadcast.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseMentions(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @typedef {object} SelectionInput
 * @property {object}   meta          GroupHandle meta (roster + defaultVpId)
 * @property {boolean}  fromUser      true = user-authored; false = VP-authored
 * @property {string[]} mentions      Already-parsed @-mentions
 * @property {string=}  sender        VP id when fromUser=false
 * @property {number}   [fanOutCap=16]
 * @property {string[]=} taskMembers  When set, restricts dispatch to this list
 */

/**
 * @typedef {object} SelectionResult
 * @property {string[]} dispatched              VP ids that should respond
 * @property {string|null} fallback             The fallback vp, if any
 * @property {Array<{vpId?:string,error:string}>} errors
 * @property {'mention'|'broadcast'|'fallback'|'vp-author-no-text-routing'|'no-default'} reason
 * @property {boolean=} truncatedAtFanOutCap
 */

/**
 * Pure VP-selection step of pre-flow. Returns ids only — caller owns
 * persistence + envelope construction + deliver().
 *
 * @param {SelectionInput} input
 * @returns {SelectionResult}
 */
export function selectRespondingVps(input) {
  const meta = input.meta;
  if (!meta) {
    return { dispatched: [], fallback: null, errors: [{ error: 'no_group_meta' }], reason: 'no-default' };
  }
  const fanOutCap = Number.isFinite(input.fanOutCap) ? input.fanOutCap : 16;
  const taskMembers = Array.isArray(input.taskMembers) ? input.taskMembers : null;
  const mentions = Array.isArray(input.mentions) ? input.mentions : [];

  // VP-authored messages: never auto-route through @-mentions; VPs hand
  // off through the explicit route_forward tool instead.
  if (!input.fromUser) {
    return {
      dispatched: [],
      fallback: null,
      errors: [],
      reason: 'vp-author-no-text-routing',
    };
  }

  // @all broadcast — fan out to every roster member except the sender,
  // honouring fanOutCap and taskMembers.
  if (mentions.includes('all')) {
    const roster = meta.roster.filter((v) => v !== input.sender).slice(0, fanOutCap);
    const scoped = taskMembers ? roster.filter((v) => taskMembers.includes(v)) : roster;
    return {
      dispatched: scoped,
      fallback: null,
      errors: [],
      reason: 'broadcast',
      truncatedAtFanOutCap: meta.roster.length - 1 > fanOutCap,
    };
  }

  // Explicit @-mentions
  if (mentions.length > 0) {
    const dispatched = [];
    const errors = [];
    for (const vpId of mentions) {
      const canonicalVpId = resolveMemberId(meta, vpId);
      if (!canonicalVpId) {
        errors.push({ vpId, error: 'not_in_roster' });
        continue;
      }
      if (taskMembers && !taskMembers.includes(canonicalVpId)) {
        errors.push({ vpId, error: 'not_in_task_members' });
        continue;
      }
      if (!dispatched.includes(canonicalVpId)) dispatched.push(canonicalVpId);
    }
    return { dispatched, fallback: null, errors, reason: 'mention' };
  }

  // No @-mention → fallback to defaultVpId (architecture G2)
  const fallback = resolveFallbackVp(meta);
  if (!fallback) {
    return {
      dispatched: [],
      fallback: null,
      errors: [{ error: 'no_default_vp' }],
      reason: 'no-default',
    };
  }
  if (taskMembers && !taskMembers.includes(fallback)) {
    return {
      dispatched: [],
      fallback: null,
      errors: [{ vpId: fallback, error: 'not_in_task_members' }],
      reason: 'no-default',
    };
  }
  return {
    dispatched: [fallback],
    fallback,
    errors: [],
    reason: 'fallback',
  };
}


/**
 * Build the heading for a single scope's formatted memory block.
 *
 * Heading style is the original recall-v2 format, kept so the system
 * prompt the LLM sees stays stable across the FTS migration.
 *
 * @param {string} scope
 * @returns {string}
 */
function scopeHeading(scope) {
  if (scope === 'user') return '## Memory: User';
  // Nested chat scopes first.
  let m = /^chat\/([^/]+)\/vp\/(.+)$/.exec(scope);
  if (m) return `## Memory: VP ${m[2]}`;
  m = /^chat\/([^/]+)$/.exec(scope);
  if (m) return `## Memory: Chat ${m[1]}`;
  // Nested group scopes.
  m = /^group\/([^/]+)\/vp\/(.+)$/.exec(scope);
  if (m) return `## Memory: VP ${m[2]}`;
  m = /^group\/([^/]+)\/user$/.exec(scope);
  if (m) return `## Memory: Group ${m[1]} (user)`;
  m = /^group\/([^/]+)\/feature\/(.+)$/.exec(scope);
  if (m) return `## Memory: Feature ${m[2]}`;
  m = /^group\/([^/]+)\/topic\/(.+)$/.exec(scope);
  if (m) return `## Memory: Topic ${m[2]}`;
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
 * Build the canonical scope list for a given (groupId, vpId).
 * Always includes 'user'. The order is significant — preflow.js's scope
 * filter accepts/rejects by membership, and the formatter renders in
 * order.
 *
 * (2026-05-13: `featureId` scope dropped along with the Feature system.)
 *
 * @param {{groupId?: string, vpId?: string, extra?: string[]}} ctx
 * @returns {string[]}
 */
export function buildRelevantScopes({ groupId, chatId, vpId, extra } = {}) {
  const scopes = ['user'];
  if (chatId) {
    scopes.push(`chat/${chatId}`);
    if (vpId) scopes.push(`chat/${chatId}/vp/${vpId}`);
  } else if (groupId) {
    scopes.push(`group/${groupId}`);
    scopes.push(`group/${groupId}/user`);
    if (vpId) scopes.push(`group/${groupId}/vp/${vpId}`);
  }
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
    chatId: opts.chatId,
    vpId: opts.vpId,
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
