/**
 * sessions/coordinator.js — Session Coordinator.
 *
 * Ported from groups/coordinator.js as part of the chat+group → session
 * unification. Persists envelopes to a SessionHandle's jsonl-log and
 * dispatches user-text turns to target VPs via pre-flow's selection
 * matrix.
 *
 * N=1 (the old "chat") and N>1 (the old "group") are handled by the same
 * logic — chat is just the degenerate case where pre-flow's @-mention
 * matrix always falls back to the lone roster member.
 *
 * This module does NOT run the engine. It only:
 *   1. Persists the message (via SessionHandle.appendMessage)
 *   2. Asks pre-flow which VPs should respond
 *   3. Calls deliver(vpId, envelope) per target
 */

import { parseMentions, selectRespondingVps } from './pre-flow.js';

export { parseMentions };

/**
 * @param {import('./session-store.js').SessionHandle} sessionHandle
 * @param {{ deliver?: (vpId:string, envelope:any) => void, perGroupFanOut?: number }} [options]
 */
export function createCoordinator(sessionHandle, options = {}) {
  const deliver = options.deliver || (() => {});
  const fanOutCap = options.perGroupFanOut ?? 16;

  function ingest(input, opts = {}) {
    if (!input || typeof input !== 'object') {
      throw new Error('ingest: input required');
    }
    if (typeof input.text !== 'string') {
      throw new Error('ingest: input.text required (string)');
    }
    const meta = sessionHandle.getMeta();
    if (!meta) throw new Error('session not initialised (call createSession first)');

    const isRouteForwardInjection = input?.meta?.injectedBy === 'route_forward';
    const fromUser = input.from === 'user'
      || input.role === 'user'
      || isRouteForwardInjection;
    const mentions = parseMentions(input.text);

    const persistInput = {};
    const ephemeral = {};
    for (const [k, v] of Object.entries(input)) {
      if (typeof k === 'string' && k.startsWith('_')) {
        ephemeral[k] = v;
      } else {
        persistInput[k] = v;
      }
    }
    {
      const leaked = Object.keys(persistInput).filter((k) => typeof k === 'string' && k.startsWith('_'));
      if (leaked.length > 0) {
        throw new Error(`coordinator.ingest: ephemeral fields leaked into persisted record: ${leaked.join(', ')}`);
      }
    }
    const stored = sessionHandle.appendMessage({
      ...persistInput,
      mentions,
      role: input.role || (fromUser ? 'user' : 'assistant'),
    });

    const selection = selectRespondingVps({
      meta,
      fromUser,
      mentions,
      sender: input.from,
      fanOutCap,
      taskMembers: opts.taskMembers,
    });

    if (selection.reason === 'vp-author-no-text-routing') {
      return {
        message: stored,
        dispatched: [],
        fallback: null,
        errors: [],
        skipped: 'vp-author-no-text-routing',
      };
    }

    if (selection.reason === 'broadcast') {
      const envelope = makeEnvelope(stored, meta, 'broadcast', ephemeral);
      for (const vpId of selection.dispatched) deliver(vpId, envelope);
      return {
        message: stored,
        dispatched: selection.dispatched,
        fallback: null,
        errors: selection.errors,
        broadcast: true,
        truncatedAtFanOutCap: !!selection.truncatedAtFanOutCap,
      };
    }

    if (selection.reason === 'mention') {
      for (const vpId of selection.dispatched) {
        deliver(vpId, makeEnvelope(stored, meta, 'mention', ephemeral));
      }
      return {
        message: stored,
        dispatched: selection.dispatched,
        fallback: null,
        errors: selection.errors,
      };
    }

    if (selection.reason === 'fallback' && selection.fallback) {
      deliver(selection.fallback, makeEnvelope(stored, meta, 'fallback', ephemeral));
      return {
        message: stored,
        dispatched: selection.dispatched,
        fallback: selection.fallback,
        errors: selection.errors,
      };
    }

    return {
      message: stored,
      dispatched: [],
      fallback: null,
      errors: selection.errors,
    };
  }

  return {
    session: sessionHandle,
    ingest,
    parseMentions,
  };
}

function makeEnvelope(msg, meta, trigger, ephemeral = {}) {
  return {
    sessionId: meta.id,
    taskId: msg.taskId || null,
    msg,
    trigger,
    ...ephemeral,
  };
}
