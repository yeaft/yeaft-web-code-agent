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
  it('persists header model selection to the active group config when groupId is provided', async () => {
    const store = makeStore();
    store.unifyAgentId = 'agent-1';
    store.groupCrudRequest = async (op, data) => ({ ok: true, op, groupId: data.groupId, config: data.config });

    const res = await store.switchUnifyModel('provider/model-a', 'grp-a');

    expect(res).toEqual({
      ok: true,
      op: 'update_config',
      groupId: 'grp-a',
      config: { model: 'provider/model-a' },
    });
    expect(store.unifyModel).toBe('provider/model-a');
    expect(store.sent).toEqual([]);
  });

  it('keeps the legacy session-level switch only when no groupId is available', async () => {
    const store = makeStore();
    store.unifyAgentId = 'agent-1';

    await store.switchUnifyModel('provider/model-b', null);

    expect(store.sent).toEqual([{ type: 'unify_model_switch', model: 'provider/model-b', agentId: 'agent-1' }]);
  });

  it('resolves group_crud_result with config so callers can observe persisted group model', () => {
    const store = makeStore();
    let resolved = null;
    store._groupCrudPending = new Map([
      ['req-1', { resolve: (value) => { resolved = value; } }],
    ]);
    globalThis.window.Pinia = {
      ...globalThis.Pinia,
      useGroupsStore: () => ({ applyCrudResult: () => {} }),
    };

    store.handleUnifyOutput({
      event: {
        type: 'group_crud_result',
        requestId: 'req-1',
        ok: true,
        op: 'update_config',
        groupId: 'grp-a',
        config: { model: 'provider/model-c' },
      },
    });

    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      op: 'update_config',
      groupId: 'grp-a',
      config: { model: 'provider/model-c' },
    }));
  });
});
