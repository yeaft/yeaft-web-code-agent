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
const {
  handleUnifyHistoryChunk,
  reconcileUnifyHistoryMessages,
} = await import('../../../web/stores/helpers/handlers/conversationHandler.js');

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


  it('hydrates the active group after session_ready replays the group snapshot', () => {
    const store = makeStore();
    store.currentView = 'unify';
    store.unifyConversationId = 'unify-local-1';
    store.unifyAgentId = 'agent-1';
    store.sent = [];

    const groupsStore = {
      activeGroupId: null,
      groups: {},
      groupOrder: [],
      applySnapshot(groups) {
        const arr = Array.isArray(groups) ? groups : [];
        this.groups = Object.fromEntries(arr.map((g) => [g.id, g]));
        this.groupOrder = arr.map((g) => g.id);
        if (!this.activeGroupId && this.groupOrder.length > 0) this.activeGroupId = this.groupOrder[0];
      },
    };
    const previousWindow = globalThis.window;
    globalThis.window = {
      ...(previousWindow || {}),
      Pinia: {
        ...((previousWindow && previousWindow.Pinia) || {}),
        useGroupsStore: () => groupsStore,
      },
    };

    try {
      store.handleUnifyOutput({
        event: {
          type: 'group_list_updated',
          groups: [{ id: 'grp_fun', name: 'Fun', roster: ['linus'], defaultVpId: 'linus' }],
        },
      });
    } finally {
      globalThis.window = previousWindow;
    }

    expect(store.unifyActiveGroupFilter).toBe('grp_fun');
    expect(store.unifyLoadingMoreHistory).toBe(true);
    expect(store.unifyGroupHistoryState.grp_fun).toEqual(expect.objectContaining({
      loaded: false,
      loading: true,
    }));
    expect(store.sent).toEqual([{
      type: 'unify_load_history',
      agentId: 'agent-1',
      limit: 50,
      groupId: 'grp_fun',
    }]);
  });

  it('rehydrates a group even if it completed history loading earlier in this UI lifecycle', () => {
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

    expect(store.sent).toEqual([{
      type: 'unify_load_history',
      agentId: 'agent-1',
      limit: 50,
      groupId: 'grp_fun',
    }]);
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

  it('two stale clients converge to the same authoritative latest group tail', () => {
    const latest = [
      { id: 'm0002', role: 'user', content: 'latest question', groupId: 'grp_fun', ts: '2026-05-27T00:00:02.000Z' },
      { id: 'm0003', role: 'assistant', content: 'latest answer', groupId: 'grp_fun', speakerVpId: 'linus', ts: '2026-05-27T00:00:03.000Z' },
    ];
    const a = makeStore();
    const b = makeStore();
    for (const store of [a, b]) {
      store.unifyConversationId = 'unify-1';
      store.unifyActiveGroupFilter = 'grp_fun';
    }
    a.messagesMap = { 'unify-1': [{ id: 'stale-a', type: 'user', content: 'stale a', groupId: 'grp_fun' }] };
    b.messagesMap = { 'unify-1': [{ id: 'stale-b', type: 'assistant', content: 'stale b', groupId: 'grp_fun' }] };

    for (const store of [a, b]) {
      reconcileUnifyHistoryMessages(store, {
        conversationId: 'unify-1',
        groupId: 'grp_fun',
        messages: latest,
        count: latest.length,
      });
    }

    expect(a.messagesMap['unify-1']).toEqual(b.messagesMap['unify-1']);
    expect(a.messagesMap['unify-1'].map(m => m.content)).toEqual(['latest question', 'latest answer']);
    expect(a.messagesMap['unify-1'][1]).toEqual(expect.objectContaining({ speakerVpId: 'linus', vpId: 'linus' }));
  });

  it('repeated authoritative group history replay does not duplicate messages', () => {
    const store = makeStore();
    store.unifyConversationId = 'unify-1';
    store.unifyActiveGroupFilter = 'grp_fun';
    const payload = {
      conversationId: 'unify-1',
      groupId: 'grp_fun',
      messages: [
        { id: 'm0001', role: 'user', content: 'q', groupId: 'grp_fun' },
        { id: 'm0002', role: 'assistant', content: 'a', groupId: 'grp_fun' },
      ],
      count: 2,
    };

    reconcileUnifyHistoryMessages(store, payload);
    reconcileUnifyHistoryMessages(store, payload);

    expect(store.messagesMap['unify-1'].map(m => m.id)).toEqual(['m0001', 'm0002']);
  });

  it('authoritative group history preserves persisted tool-call shape', () => {
    const store = makeStore();
    store.unifyConversationId = 'unify-1';
    store.unifyActiveGroupFilter = 'grp_fun';

    reconcileUnifyHistoryMessages(store, {
      conversationId: 'unify-1',
      groupId: 'grp_fun',
      messages: [
        {
          id: 'm0002',
          role: 'assistant',
          content: '',
          groupId: 'grp_fun',
          speakerVpId: 'linus',
          toolCalls: [{ id: 'call-1', name: 'Bash', input: { command: 'npm test' } }],
        },
        { id: 'm0003', role: 'tool', content: 'ok', groupId: 'grp_fun', toolCallId: 'call-1' },
      ],
      count: 2,
    });

    expect(store.messagesMap['unify-1']).toEqual([
      expect.objectContaining({ type: 'tool-use', toolName: 'Bash', toolInput: { command: 'npm test' }, speakerVpId: 'linus', toolCallId: 'call-1' }),
      expect.objectContaining({ type: 'tool_result', content: 'ok', toolCallId: 'call-1' }),
    ]);
  });

  it('syncs currentAgent to the entered Unify agent so sidebar + Files panel follow it', () => {
    const store = makeStore();
    // Chat auto-selected the first agent; user now opens Unify for a different agent.
    store.currentAgent = 'agent-1';
    store.unifyActiveGroupFilter = 'grp_fun';

    store.enterUnify('agent-2');

    expect(store.unifyAgentId).toBe('agent-2');
    // selectAgent emits a select_agent WS message — observing that side-effect
    // is how we prove currentAgent will sync (the handler flips currentAgent
    // when the server acks; the WS emission is the contract we control).
    expect(store.sent).toEqual(expect.arrayContaining([
      { type: 'select_agent', agentId: 'agent-2' },
    ]));
  });
});
