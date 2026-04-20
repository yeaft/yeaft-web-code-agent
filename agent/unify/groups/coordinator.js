/**
 * coordinator.js — Group Coordinator (task-334b).
 *
 * Consumes user/VP messages, persists them to the group's 334o jsonl-log,
 * parses @-mentions (user-posted only), and dispatches to target RoleInstances'
 * `inputQueue`. Aligned with architecture §5 / §6:
 *
 *   - Text @-mentions trigger routing ONLY for `role === 'user'` messages.
 *     VP-authored @ mentions are surface noise; VPs dispatch via the
 *     route_forward tool (334d), not free text.
 *   - `@all` fans out to every roster member except the sender (perGroupFanOut
 *     cap honoured via options).
 *   - Unknown @-targets return `{ error: 'not_in_roster' }` in the dispatch
 *     report; coordinator does not mutate roster on stranger mentions.
 *   - No @-mention on a user message → falls back to `defaultVpId` via
 *     resolveFallbackVp (architecture G2).
 *   - taskId: if the inbound message carries `taskId`, dispatch is scoped to
 *     task.members — passed in via `options.taskMembers` (task storage lives
 *     in 334n; coordinator only enforces the filter when the caller provides
 *     the member list).
 *
 * This module DOES NOT run the engine. It only:
 *   1. Persists the message (via GroupHandle.appendMessage)
 *   2. Resolves the list of target vpIds
 *   3. Calls a user-supplied deliver(vpId, envelope) per target
 *
 * That lets 334c (RoleInstance/Engine) own how a target is actually woken up
 * (inputQueue push, status transition, etc) without coordinator owning it.
 */

import { isMember, resolveFallbackVp } from './roster.js';

/** Matches `@vp-id` where id is [A-Za-z0-9_-]+. Captures the id. */
const MENTION_RE = /(^|\s)@([A-Za-z0-9_][A-Za-z0-9_-]*)/g;

/**
 * Extract an ordered, unique list of @-mentions from a text string.
 * Recognises the literal token `@all` as broadcast.
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
 * Build a Group Coordinator bound to a single GroupHandle.
 *
 * @param {import('./group-store.js').GroupHandle} group
 * @param {Object} [options]
 * @param {(vpId:string, envelope:any)=>void} [options.deliver]  called per target
 * @param {number} [options.perGroupFanOut=16]   @all cap (arch §5.3)
 * @returns {GroupCoordinator}
 */
export function createCoordinator(group, options = {}) {
  const deliver = options.deliver || (() => {});
  const fanOutCap = options.perGroupFanOut ?? 16;

  /**
   * Ingest one message. Returns a dispatch report describing what would/did
   * go out to RoleInstances.
   *
   * @param {{
   *   from: string,              // 'user' | vpId
   *   role?: 'user'|'assistant',
   *   text: string,
   *   taskId?: string|null,
   *   meta?: any,
   *   id?: string, ts?: string,
   * }} input
   * @param {{ taskMembers?: string[] }} [opts]
   *   When taskId is set, restricts dispatch to vps in taskMembers (334n owns
   *   the list). If omitted, coordinator will not filter.
   */
  function ingest(input, opts = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('ingest: input required');
    }
    if (typeof input.text !== 'string') {
      throw new Error('ingest: input.text required (string)');
    }
    const meta = group.getMeta();
    if (!meta) throw new Error('group not initialised (call createGroup first)');

    const fromUser = input.from === 'user' || input.role === 'user';
    const mentions = parseMentions(input.text);

    // Persist first — audit log / replay works even if dispatch has bugs.
    const stored = group.appendMessage({
      ...input,
      mentions,
      role: input.role || (fromUser ? 'user' : 'assistant'),
    });

    // VP-authored messages: persist but do NOT dispatch (§6: no text @ routing)
    if (!fromUser) {
      return {
        message: stored,
        dispatched: [],
        fallback: null,
        errors: [],
        skipped: 'vp-author-no-text-routing',
      };
    }

    // @all broadcast
    if (mentions.includes('all')) {
      const roster = meta.roster.filter((v) => v !== input.from).slice(0, fanOutCap);
      const scoped = opts.taskMembers
        ? roster.filter((v) => opts.taskMembers.includes(v))
        : roster;
      const envelope = makeEnvelope(stored, meta, 'broadcast');
      for (const vpId of scoped) deliver(vpId, envelope);
      return {
        message: stored,
        dispatched: scoped,
        fallback: null,
        errors: [],
        broadcast: true,
        truncatedAtFanOutCap: meta.roster.length - 1 > fanOutCap,
      };
    }

    // Explicit @-mentions
    if (mentions.length > 0) {
      const dispatched = [];
      const errors = [];
      for (const vpId of mentions) {
        if (!isMember(meta, vpId)) {
          errors.push({ vpId, error: 'not_in_roster' });
          continue;
        }
        if (opts.taskMembers && !opts.taskMembers.includes(vpId)) {
          errors.push({ vpId, error: 'not_in_task_members' });
          continue;
        }
        dispatched.push(vpId);
        deliver(vpId, makeEnvelope(stored, meta, 'mention'));
      }
      return { message: stored, dispatched, fallback: null, errors };
    }

    // No @-mention → fallback
    const fallback = resolveFallbackVp(meta);
    if (!fallback) {
      return {
        message: stored,
        dispatched: [],
        fallback: null,
        errors: [{ error: 'no_default_vp' }],
      };
    }
    if (opts.taskMembers && !opts.taskMembers.includes(fallback)) {
      return {
        message: stored,
        dispatched: [],
        fallback: null,
        errors: [{ vpId: fallback, error: 'not_in_task_members' }],
      };
    }
    deliver(fallback, makeEnvelope(stored, meta, 'fallback'));
    return { message: stored, dispatched: [fallback], fallback, errors: [] };
  }

  return {
    group,
    ingest,
    parseMentions,
  };
}

function makeEnvelope(msg, meta, trigger) {
  return {
    groupId: meta.id,
    taskId: msg.taskId || null,
    msg,
    trigger, // 'broadcast' | 'mention' | 'fallback'
  };
}

/**
 * @typedef {Object} GroupCoordinator
 * @property {import('./group-store.js').GroupHandle} group
 * @property {(input:any, opts?:any)=>DispatchReport} ingest
 * @property {(text:string)=>string[]} parseMentions
 */

/**
 * @typedef {Object} DispatchReport
 * @property {any}       message
 * @property {string[]}  dispatched
 * @property {string|null} fallback
 * @property {Array<{vpId?:string, error:string}>} errors
 * @property {boolean=}  broadcast
 * @property {boolean=}  truncatedAtFanOutCap
 * @property {string=}   skipped
 */
