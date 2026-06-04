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
const { handleYeaftHistoryChunk } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');

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

describe('Yeaft group history re-entry', () => {
  it('hydrates the active Fun group on Yeaft entry even when stale rows are cached for that group', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-1';
    store.currentAgent = 'agent-1';
    store.yeaftActiveSessionFilter = 'grp_fun';
    store.messagesMap = {
      'yeaft-1': [
        { type: 'user', content: 'old cached Fun message', groupId: 'grp_fun' },
      ],
    };

    store.enterYeaft('agent-1');

    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 5,
      groupId: 'grp_fun',
    }]);
    expect(store.yeaftSessionHistoryState.grp_fun).toEqual(expect.objectContaining({
      loaded: false,
      loading: true,
    }));
  });

  it('hydrates Fun group on group switch even when stale rows are cached for that group', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-1';
    store.yeaftActiveSessionFilter = 'grp_other';
    store.messagesMap = {
      'yeaft-1': [
        { type: 'user', content: 'old cached Fun message', groupId: 'grp_fun' },
      ],
    };

    store.setActiveSessionFilter('grp_fun');

    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 5,
      groupId: 'grp_fun',
    }]);
  });


  it('requests metadata only on Yeaft entry until the group snapshot selects an active group', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-1';
    store.currentAgent = 'agent-1';
    store.yeaftActiveSessionFilter = null;

    store.enterYeaft('agent-1');

    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 0,
      groupId: null,
    }]);
    expect(store.yeaftSessionHistoryState).toEqual({});
    expect(store.yeaftLoadingMoreHistory).toBe(false);
  });

  it('merges local placeholder rows into an existing agent conversation on session_ready replay', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-local-1';
    store.messagesMap = {
      'yeaft-agent-1': [
        { id: 'old', type: 'user', content: 'cached row', timestamp: 10, groupId: 'grp_fun' },
      ],
      'yeaft-local-1': [
        { id: 'new', type: 'user', content: 'local row', timestamp: 20, groupId: 'grp_fun' },
      ],
    };

    store.handleYeaftOutput({
      event: {
        type: 'session_ready',
        conversationId: 'yeaft-agent-1',
        model: 'sonnet',
        availableModels: [],
        skills: [],
        mcpServers: [],
        tools: [],
      },
    });

    expect(store.messagesMap['yeaft-agent-1'].map(m => m.id)).toEqual(['old', 'new']);
    expect(store.messagesMap['yeaft-local-1']).toBeUndefined();
  });

  it('hydrates the active group after session_ready replays the group snapshot', () => {
    const store = makeStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-local-1';
    store.yeaftAgentId = 'agent-1';
    store.sent = [];

    const sessionsStore = {
      activeSessionId: null,
      groups: {},
      groupOrder: [],
      applySnapshot(groups) {
        const arr = Array.isArray(groups) ? groups : [];
        this.groups = Object.fromEntries(arr.map((g) => [g.id, g]));
        this.groupOrder = arr.map((g) => g.id);
        if (!this.activeSessionId && this.groupOrder.length > 0) this.activeSessionId = this.groupOrder[0];
      },
    };
    const previousWindow = globalThis.window;
    globalThis.window = {
      ...(previousWindow || {}),
      Pinia: {
        ...((previousWindow && previousWindow.Pinia) || {}),
        useSessionsStore: () => sessionsStore,
      },
    };

    try {
      store.handleYeaftOutput({
        event: {
          type: 'group_list_updated',
          groups: [{ id: 'grp_fun', name: 'Fun', roster: ['linus'], defaultVpId: 'linus' }],
        },
      });
    } finally {
      globalThis.window = previousWindow;
    }

    expect(store.yeaftActiveSessionFilter).toBe('grp_fun');
    expect(store.yeaftLoadingMoreHistory).toBe(true);
    expect(store.yeaftSessionHistoryState.grp_fun).toEqual(expect.objectContaining({
      loaded: false,
      loading: true,
    }));
    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 5,
      groupId: 'grp_fun',
    }]);
  });

  it('sends an afterSeq delta request when a group already has a cursor in this UI lifecycle', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-1';
    store.yeaftActiveSessionFilter = 'grp_other';
    store.yeaftSessionHistoryState = {
      grp_fun: { loaded: true, loading: false, hasMore: false, oldestSeq: 1, count: 2, latestSeq: 42 },
    };
    store.messagesMap = {
      'yeaft-1': [
        { type: 'user', content: 'already loaded Fun message', groupId: 'grp_fun' },
      ],
    };

    store.setActiveSessionFilter('grp_fun');

    // Always-ask delta: when a cursor exists, send afterSeq instead of
    // limit. The agent will reply with zero rows if nothing's new.
    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      groupId: 'grp_fun',
      afterSeq: 42,
    }]);
  });

  it('merges loaded Fun history with cached rows instead of replacing the pane with old content', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftActiveSessionFilter = 'grp_fun';
    store.messagesMap = {
      'yeaft-1': [
        { type: 'user', content: 'new Fun message typed before re-entry', groupId: 'grp_fun' },
      ],
    };

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      groupId: 'grp_fun',
      messages: [
        { id: 'm0001', role: 'user', content: 'old Fun message', groupId: 'grp_fun' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual([
      'old Fun message',
      'new Fun message typed before re-entry',
    ]);
  });

  it('syncs currentAgent to the entered Yeaft agent so sidebar + Files panel follow it', () => {
    const store = makeStore();
    // Chat auto-selected the first agent; user now opens Yeaft for a different agent.
    store.currentAgent = 'agent-1';
    store.yeaftActiveSessionFilter = 'grp_fun';

    store.enterYeaft('agent-2');

    expect(store.yeaftAgentId).toBe('agent-2');
    // selectAgent emits a select_agent WS message — observing that side-effect
    // is how we prove currentAgent will sync (the handler flips currentAgent
    // when the server acks; the WS emission is the contract we control).
    expect(store.sent).toEqual(expect.arrayContaining([
      { type: 'select_agent', agentId: 'agent-2' },
    ]));
  });
});
