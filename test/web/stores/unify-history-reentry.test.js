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
const { handleUnifyHistoryChunk } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');

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
  store.sendWsMessage = function sendWsMessage(msg) { this.sent.push(msg); };
  return store;
}

describe('Unify group history re-entry', () => {
  it('hydrates the active Fun group on Unify entry even when stale rows are cached for that group', () => {
    const store = makeStore();
    store.unifyConversationId = 'unify-1';
    store.unifyAgentId = 'agent-1';
    store.currentAgent = 'agent-1';
    store.unifyActiveGroupFilter = 'grp_fun';
    store.messagesMap = {
      'unify-1': [
        { type: 'user', content: 'old cached Fun message', groupId: 'grp_fun' },
      ],
    };

    store.enterUnify('agent-1');

    expect(store.sent).toEqual([{
      type: 'unify_load_history',
      agentId: 'agent-1',
      limit: 50,
      groupId: 'grp_fun',
    }]);
    expect(store.unifyGroupHistoryState.grp_fun).toEqual(expect.objectContaining({
      loaded: false,
      loading: true,
    }));
  });

  it('hydrates Fun group on group switch even when stale rows are cached for that group', () => {
    const store = makeStore();
    store.unifyConversationId = 'unify-1';
    store.unifyAgentId = 'agent-1';
    store.unifyActiveGroupFilter = 'grp_other';
    store.messagesMap = {
      'unify-1': [
        { type: 'user', content: 'old cached Fun message', groupId: 'grp_fun' },
      ],
    };

    store.setActiveGroupFilter('grp_fun');

    expect(store.sent).toEqual([{
      type: 'unify_load_history',
      agentId: 'agent-1',
      limit: 50,
      groupId: 'grp_fun',
    }]);
  });

  it('does not rehydrate a group that already completed history loading in this UI lifecycle', () => {
    const store = makeStore();
    store.unifyConversationId = 'unify-1';
    store.unifyAgentId = 'agent-1';
    store.unifyActiveGroupFilter = 'grp_other';
    store.unifyGroupHistoryState = {
      grp_fun: { loaded: true, loading: false, hasMore: false, oldestSeq: 1, count: 2 },
    };
    store.messagesMap = {
      'unify-1': [
        { type: 'user', content: 'already loaded Fun message', groupId: 'grp_fun' },
      ],
    };

    store.setActiveGroupFilter('grp_fun');

    expect(store.sent).toEqual([]);
  });

  it('merges loaded Fun history with cached rows instead of replacing the pane with old content', () => {
    const store = makeStore();
    store.unifyConversationId = 'unify-1';
    store.unifyActiveGroupFilter = 'grp_fun';
    store.messagesMap = {
      'unify-1': [
        { type: 'user', content: 'new Fun message typed before re-entry', groupId: 'grp_fun' },
      ],
    };

    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'grp_fun',
      messages: [
        { id: 'm0001', role: 'user', content: 'old Fun message', groupId: 'grp_fun' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual([
      'old Fun message',
      'new Fun message typed before re-entry',
    ]);
  });
});
