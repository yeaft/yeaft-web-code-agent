import { describe, it, expect } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useChatStore } = await import('../../../web/stores/chat.js');

function makeStore() {
  const schema = useChatStore();
  const state = schema.state();
  const store = {
    ...state,
    sent: [],
  };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  // Override after binding actions; otherwise the real websocket helper tries
  // to use a live browser connection in this store-unit test.
  store.sendWsMessage = function sendWsMessage(msg) { this.sent.push(msg); };
  return store;
}

describe('chat store model switching', () => {
  it('persists header model selection to the active session config when sessionId is provided', async () => {
    // Field rename note (refactor sweep 2026-06-08): switchYeaftModel
    // forwards `sessionId` (not legacy `groupId`) on the update_config
    // CRUD payload. Server reads `msg.sessionId`.
    const store = makeStore();
    store.yeaftAgentId = 'agent-1';
    store.sessionCrudRequest = async (op, data) => ({ ok: true, op, sessionId: data.sessionId, config: data.config });

    const res = await store.switchYeaftModel('provider/model-a', 'grp-a');

    expect(res).toEqual({
      ok: true,
      op: 'update_config',
      sessionId: 'grp-a',
      config: { model: 'provider/model-a' },
    });
    expect(store.yeaftModel).toBe('provider/model-a');
    expect(store.sent).toEqual([]);
  });

  it('keeps the legacy session-level switch only when no sessionId is available', async () => {
    const store = makeStore();
    store.yeaftAgentId = 'agent-1';

    await store.switchYeaftModel('provider/model-b', null);

    expect(store.sent).toEqual([{ type: 'yeaft_model_switch', model: 'provider/model-b', agentId: 'agent-1' }]);
  });

  it('resolves session_crud_result with config so callers can observe persisted session model', () => {
    // Read side still accepts `groupId` from the wire for deploy-window
    // compat — the resolved value preserves whatever the server sent.
    const store = makeStore();
    let resolved = null;
    store._sessionCrudPending = new Map([
      ['req-1', { resolve: (value) => { resolved = value; } }],
    ]);
    globalThis.window.Pinia = {
      ...globalThis.Pinia,
      useSessionsStore: () => ({ applyCrudResult: () => {} }),
    };

    store.handleYeaftOutput({
      event: {
        type: 'session_crud_result',
        requestId: 'req-1',
        ok: true,
        op: 'update_config',
        sessionId: 'grp-a',
        config: { model: 'provider/model-c' },
      },
    });

    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      op: 'update_config',
      sessionId: 'grp-a',
      config: { model: 'provider/model-c' },
    }));
  });
});
