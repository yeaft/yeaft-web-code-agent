/**
 * sessions/pre-flow.js — explicit pre-flow stage for Yeaft (session-scoped).
 *
 * Ported from groups/pre-flow.js as part of the chat+group → session
 * unification. Scope strings use the unified `session/<id>` /
 * `session/<id>/vp/<vp>` shape instead of the legacy
 * `group/<g>` / `chat/<c>` shapes.
 *
 * NOTE: the old groups/pre-flow.js is still in place — callers (web-bridge,
 * coordinator) will switch over in Phase A6/A7. Do not delete the old file
 * until every importer has been migrated.
 */

import { runPreflow as runFtsPreflow } from '../memory/preflow.js';

/** Matches `@vp-id` where id is [A-Za-z0-9_-]+. Captures the id. */
const MENTION_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_-]*)/g;

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
 * Pure VP-selection for a session. Returns the list of VP ids that should
 * respond to a user turn — mention / @all / fallback to first roster
 * member. (Sessions have no `defaultVpId` field; the first VP in `vpIds`
 * is the fallback.)
 *
 * @param {{
 *   meta: { id: string, vpIds: string[] },
 *   fromUser: boolean,
 *   mentions: string[],
 *   sender?: string,
 *   fanOutCap?: number,
 *   taskMembers?: string[],
 * }} input
 */
export function selectRespondingVps(input) {
  const meta = input?.meta;
  if (!meta) {
    return { dispatched: [], fallback: null, errors: [{ error: 'no_session_meta' }], reason: 'no-default' };
  }
  const fanOutCap = Number.isFinite(input.fanOutCap) ? input.fanOutCap : 16;
  const taskMembers = Array.isArray(input.taskMembers) ? input.taskMembers : null;
  const mentions = Array.isArray(input.mentions) ? input.mentions : [];
  const roster = Array.isArray(meta.vpIds) ? meta.vpIds : [];

  if (!input.fromUser) {
    return {
      dispatched: [],
      fallback: null,
      errors: [],
      reason: 'vp-author-no-text-routing',
    };
  }

  if (mentions.includes('all')) {
    const expanded = roster.filter((v) => v !== input.sender).slice(0, fanOutCap);
    const scoped = taskMembers ? expanded.filter((v) => taskMembers.includes(v)) : expanded;
    return {
      dispatched: scoped,
      fallback: null,
      errors: [],
      reason: 'broadcast',
      truncatedAtFanOutCap: roster.length - 1 > fanOutCap,
    };
  }

  if (mentions.length > 0) {
    const dispatched = [];
    const errors = [];
    for (const vpId of mentions) {
      if (!roster.includes(vpId)) {
        errors.push({ vpId, error: 'not_in_roster' });
        continue;
      }
      if (taskMembers && !taskMembers.includes(vpId)) {
        errors.push({ vpId, error: 'not_in_task_members' });
        continue;
      }
      if (!dispatched.includes(vpId)) dispatched.push(vpId);
    }
    return { dispatched, fallback: null, errors, reason: 'mention' };
  }

  const fallback = roster[0] || null;
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

function scopeHeading(scope) {
  if (scope === 'user') return '## Memory: User';
  let m = /^session\/([^/]+)\/vp\/(.+)$/.exec(scope);
  if (m) return `## Memory: VP ${m[2]}`;
  m = /^session\/([^/]+)$/.exec(scope);
  if (m) return `## Memory: Session ${m[1]}`;
  if (scope.startsWith('vp/')) return `## Memory: VP ${scope.slice(3)}`;
  return `## Memory: ${scope}`;
}

export function formatPickedForInjection(picked) {
  if (!picked || picked.length === 0) return '';
  const byScope = new Map();
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
    parts.push('');
  }
  return parts.join('\n').trim();
}

/**
 * Canonical scope list for a session VP turn:
 *   ['user', 'session/<id>', 'session/<id>/vp/<vp>']
 *
 * @param {{ sessionId?: string, vpId?: string, extra?: string[] }} ctx
 */
export function buildRelevantScopes({ sessionId, vpId, extra } = {}) {
  const scopes = ['user'];
  if (sessionId) {
    scopes.push(`session/${sessionId}`);
    if (vpId) scopes.push(`session/${sessionId}/vp/${vpId}`);
  }
  if (Array.isArray(extra)) {
    for (const s of extra) {
      if (s && !scopes.includes(s)) scopes.push(s);
    }
  }
  return scopes;
}

export function runMemoryPreflow(index, opts) {
  if (!index) {
    return { profile: '', entries: [], formatted: '', meta: { skipped: 'no-index' } };
  }
  const userMsg = (opts?.userMsg || '').trim();
  if (!userMsg) {
    return { profile: '', entries: [], formatted: '', meta: { skipped: 'no-user-msg' } };
  }

  const relevantScopes = buildRelevantScopes({
    sessionId: opts.sessionId,
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

  const userSeg = (result.picked || []).find((p) => p.scope === 'user');
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
