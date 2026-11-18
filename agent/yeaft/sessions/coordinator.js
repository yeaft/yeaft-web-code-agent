/**
 * coordinator.js — Group Coordinator (task-334b).
 *
 * Consumes user/VP messages, persists them to the group's 334o jsonl-log,
 * and dispatches user-text turns to target RoleInstances'
 * `inputQueue`.
 *
 * As of GC.1 Commit B, VP-selection (parseMentions + dispatch matrix:
 * mention / @all / fallback / vp-author no-op) lives in
 * `groups/pre-flow.js` so the same logic can be invoked directly by
 * the parallel fan-out path in web-bridge.js. Coordinator's job is now
 * narrower: persist the message and translate the selection result
 * into deliver() calls.
 *
 * This module DOES NOT run the engine. It only:
 *   1. Persists the message (via GroupHandle.appendMessage)
 *   2. Asks pre-flow for the list of target vpIds
 *   3. Calls a user-supplied deliver(vpId, envelope) per target
 */

import { isSessionSceneId, SESSION_ASSISTANT_ID } from './scene-ids.js';
import { parseMentions, selectRespondingVps } from './pre-flow.js';

// Re-export so existing importers (`createCoordinator(...).parseMentions`,
// or modules importing `parseMentions` from coordinator) keep working
// without churn. New code should import from `./pre-flow.js` directly.
export { parseMentions };

/**
 * Build a Group Coordinator bound to a single GroupHandle.
 *
 * @param {import('./session-store.js').GroupHandle} group
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
    if (!meta) throw new Error('group not initialised (call createSession first)');

    // `fromUser` drives `selectRespondingVps` — when true, the @-mention
    // matrix runs (mention/broadcast/fallback). When false, VPs cannot
    // text-@-route (VP-authored free text is surface noise per arch §6).
    //
    // route_forward injection is a special case: the message is VP-authored
    // (role='assistant') but it MUST trigger dispatch (target VP needs to
    // run). We detect it via `meta.injectedBy === 'route_forward'` and
    // treat it as "user-like" for dispatch purposes only. Persistence still
    // honours the caller's `role` field so the on-disk record correctly
    // attributes the turn to the sending VP, not to the user.
    const inputMeta = input?.meta && typeof input.meta === 'object' ? input.meta : {};
    const routingIntent = input?._routingIntent && typeof input._routingIntent === 'object'
      ? input._routingIntent
      : null;
    const isRouteForwardInjection = inputMeta.injectedBy === 'route_forward';
    const isRouteForwardResultInjection = inputMeta.injectedBy === 'route_forward_result';
    const isTaskResultInjection = inputMeta.injectedBy === 'task_result';
    const fromUser = input.from === 'user'
      || input.role === 'user'
      || isRouteForwardInjection
      || isRouteForwardResultInjection
      || isTaskResultInjection;
    const forcedRouteTarget = (isRouteForwardInjection || isRouteForwardResultInjection || isTaskResultInjection)
      && typeof inputMeta.routeTargetVpId === 'string'
      ? inputMeta.routeTargetVpId.trim()
      : (isRouteForwardInjection && typeof inputMeta.routeForwardTarget === 'string'
        ? inputMeta.routeForwardTarget.trim()
        : '');
    const sceneTurn = fromUser && !isRouteForwardInjection && !isRouteForwardResultInjection && !isTaskResultInjection
      && isSessionSceneId(input._sceneId);
    const mentions = sceneTurn ? [] : routingIntent
      ? (routingIntent.broadcast === true ? ['all'] : routingIntent.targetVpIds.slice())
      : (forcedRouteTarget ? [forcedRouteTarget] : parseMentions(input.text));

    // Persist first — audit log / replay works even if dispatch has bugs.
    //
    // Convention: any field on `input` that starts with `_` is treated
    // as ephemeral and is forwarded to the envelope (so per-turn driver
    // payloads — image base64 blocks, prompt suffixes — reach the LLM
    // call) but is NEVER passed to appendMessage. The jsonl-log must
    // stay lean: base64 in audit history would blow up replay.
    //
    // The split is enforced structurally — see the assertion below the
    // partition loop. Don't loosen it. If a new ephemeral key is added,
    // it gets the `_` prefix at its source and inherits the protection
    // for free; no allowlist to maintain.
    const persistInput = {};
    const ephemeral = {};
    for (const [k, v] of Object.entries(input)) {
      if (typeof k === 'string' && k.startsWith('_')) {
        ephemeral[k] = v;
      } else {
        persistInput[k] = v;
      }
    }
    // Structural guarantee: nothing with a `_` prefix may reach the
    // jsonl-log via `persistInput`. If this ever throws, the `_` rule
    // got bypassed — fix the caller, not this assertion.
    {
      const leaked = Object.keys(persistInput).filter((k) => typeof k === 'string' && k.startsWith('_'));
      if (leaked.length > 0) {
        throw new Error(`coordinator.ingest: ephemeral fields leaked into persisted record: ${leaked.join(', ')}`);
      }
    }
    const stored = group.appendMessage({
      ...persistInput,
      mentions,
      role: input.role || (fromUser ? 'user' : 'assistant'),
    });

    if (sceneTurn) {
      const target = SESSION_ASSISTANT_ID;
      const outcome = deliver(target, makeEnvelope(stored, meta, 'fallback', ephemeral));
      const ok = outcome !== false && outcome?.ok !== false;
      return { message: stored, dispatched: ok ? [target] : [], fallback: ok ? target : null,
        errors: ok ? [] : [{ vpId: target, error: outcome?.error || 'delivery_rejected' }] };
    }

    // Ask pre-flow which VPs (if any) should respond.
    const selection = selectRespondingVps({
      meta: isTaskResultInjection && isSessionSceneId(input._sceneId) && forcedRouteTarget === SESSION_ASSISTANT_ID
        ? { roster: [SESSION_ASSISTANT_ID], defaultVpId: SESSION_ASSISTANT_ID } : meta,
      fromUser,
      mentions,
      sender: input.from,
      fanOutCap,
      taskMembers: opts.taskMembers,
    });

    // VP-authored: persist but no dispatch.
    if (selection.reason === 'vp-author-no-text-routing') {
      return {
        message: stored,
        dispatched: [],
        fallback: null,
        errors: [],
        skipped: 'vp-author-no-text-routing',
      };
    }

    const deliverSelected = (vpIds, trigger) => {
      const dispatched = [];
      const errors = [];
      for (const vpId of vpIds) {
        const outcome = deliver(vpId, makeEnvelope(stored, meta, trigger, ephemeral));
        if (outcome === false || outcome?.ok === false) {
          errors.push({ vpId, error: outcome?.error || 'delivery_rejected' });
        } else {
          dispatched.push(vpId);
        }
      }
      return { dispatched, errors };
    };

    if (selection.reason === 'broadcast') {
      const delivered = deliverSelected(selection.dispatched, 'broadcast');
      return {
        message: stored,
        dispatched: delivered.dispatched,
        fallback: null,
        errors: [...selection.errors, ...delivered.errors],
        broadcast: true,
        truncatedAtFanOutCap: !!selection.truncatedAtFanOutCap,
      };
    }

    if (selection.reason === 'mention') {
      const delivered = deliverSelected(selection.dispatched, 'mention');
      return {
        message: stored,
        dispatched: delivered.dispatched,
        fallback: null,
        errors: [...selection.errors, ...delivered.errors],
      };
    }

    if (selection.reason === 'fallback' && selection.fallback) {
      const delivered = deliverSelected([selection.fallback], 'fallback');
      return {
        message: stored,
        dispatched: delivered.dispatched,
        fallback: delivered.dispatched.includes(selection.fallback) ? selection.fallback : null,
        errors: [...selection.errors, ...delivered.errors],
      };
    }

    // no-default / nothing to dispatch
    return {
      message: stored,
      dispatched: [],
      fallback: null,
      errors: selection.errors,
    };
  }

  return {
    group,
    ingest,
    parseMentions,
  };
}

function makeEnvelope(msg, meta, trigger, ephemeral = {}) {
  return {
    sessionId: meta.id,
    taskId: msg.taskId || null,
    msg,
    trigger, // 'broadcast' | 'mention' | 'fallback'
    // Ephemeral fields (any `_`-prefixed key on coord.ingest input).
    // Used to ferry per-turn payloads (e.g. image base64 blocks) that
    // must reach the driver but must NOT be persisted to the group log.
    ...ephemeral,
  };
}

/**
 * @typedef {Object} GroupCoordinator
 * @property {import('./session-store.js').GroupHandle} group
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
