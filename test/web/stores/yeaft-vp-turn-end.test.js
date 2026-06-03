/**
 * yeaft-vp-turn-end.test.js
 *
 * The agent emits vp_turn_end when a VP hand-off ends the current VP turn
 * without waiting for a normal result frame. The store must remove that turn
 * from activeVpTurns so the VP list stops showing an abortable/thinking turn.
 */
import { describe, it, expect, beforeAll } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  capturedOptions = options;
  return () => ({});
};
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

let capturedOptions = null;
let actions;

beforeAll(async () => {
  await import('../../../web/stores/chat.js');
  if (!capturedOptions) throw new Error('chat store defineStore was not captured');
  actions = capturedOptions.actions;
});

function mkStore() {
  return {
    yeaftConversationId: 'yeaft-conv',
    activeVpTurns: {},
    vpStatuses: {},
    _sessionCrudPending: new Map(),
    yeaftVpTyping: {},
    connectionState: 'connected',
    messagesMap: {},
  };
}

describe('chat store — vp_turn_end', () => {
  it('removes the ended VP turn from activeVpTurns', () => {
    const store = mkStore();

    actions.handleYeaftOutput.call(store, {
      conversationId: 'yeaft-conv',
      groupId: 'grp_fun',
      vpId: 'linus',
      turnId: 'turn_forward:linus',
      event: {
        type: 'vp_turn_start',
        groupId: 'grp_fun',
        vpId: 'linus',
        threadId: 'thr_forward',
        turnId: 'turn_forward:linus',
        title: 'Forward bug',
        ts: 1770000000000,
      },
    });

    expect(store.activeVpTurns['turn_forward:linus']).toMatchObject({
      vpId: 'linus',
      threadId: 'thr_forward',
      isStreaming: true,
    });

    actions.handleYeaftOutput.call(store, {
      conversationId: 'yeaft-conv',
      groupId: 'grp_fun',
      vpId: 'linus',
      turnId: 'turn_forward:linus',
      event: {
        type: 'vp_turn_end',
        groupId: 'grp_fun',
        vpId: 'linus',
        threadId: 'thr_forward',
        turnId: 'turn_forward:linus',
        stopReason: 'tool_handoff',
      },
    });

    expect(store.activeVpTurns).toEqual({});
  });
});
