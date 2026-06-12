import { describe, it, expect, afterEach } from 'vitest';

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
const { handleAgentList } = await import('../../../web/stores/helpers/handlers/agentHandler.js');

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

afterEach(() => {
  delete window.Pinia.useSessionsStore;
});

describe('Yeaft session restore hydration', () => {
  it('bootstraps session_ready once an agent appears after entering Yeaft', () => {
    const store = makeStore();

    store.enterYeaft();
    expect(store.currentView).toBe('yeaft');
    expect(store.yeaftAgentId).toBeNull();
    expect(store.sent.some(m => m.type === 'yeaft_load_history')).toBe(false);

    handleAgentList(store, {
      agents: [{ id: 'agent-1', online: true, conversations: [] }],
    });

    expect(store.yeaftAgentId).toBe('agent-1');
    expect(store.sent).toContainEqual({ type: 'select_agent', agentId: 'agent-1', silent: true });
    expect(store.sent).toContainEqual({
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 0,
      sessionId: null,
    });
  });

  it('lets forced metadata bootstrap retry only when no identical request is in flight', () => {
    const store = makeStore();

    store.currentView = 'yeaft';
    store.yeaftAgentId = 'agent-1';
    store.currentAgent = 'agent-1';
    store.currentAgentInfo = { id: 'agent-1', online: true };
    store.yeaftBootstrapMetaLoadingKey = 'agent-1:__none__';

    expect(store.requestYeaftSessionBootstrap({ forceSessionReady: true })).toBe(false);
    expect(store.sent.filter(m => m.type === 'yeaft_load_history')).toEqual([]);

    store.yeaftBootstrapMetaLoadingKey = null;
    expect(store.requestYeaftSessionBootstrap({ forceSessionReady: true })).toBe(true);
    expect(store.sent).toContainEqual({
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 0,
      sessionId: null,
    });

    store.sent = [];
    store.yeaftSessionReady = true;
    store.yeaftModel = 'model-a';
    store.yeaftStatus = { tools: [], skills: [], mcpServers: [] };

    handleAgentList(store, {
      agents: [{ id: 'agent-1', online: true, conversations: [] }],
    });

    expect(store.sent.filter(m => m.type === 'yeaft_load_history')).toEqual([]);
  });

  it('hydrates active group history even when restored group id is unchanged by snapshot', () => {
    const store = makeStore();
    const sessionsStore = {
      activeSessionId: 'grp-1',
      applySnapshot(groups) {
        expect(groups).toEqual([{ id: 'grp-1', name: 'Restored' }]);
        this.activeSessionId = 'grp-1';
      },
    };
    window.Pinia.useSessionsStore = () => sessionsStore;

    store.currentView = 'yeaft';
    store.yeaftAgentId = 'agent-1';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftSessionReady = true;
    store.yeaftModel = 'model-a';
    store.yeaftStatus = { tools: [], skills: [], mcpServers: [] };

    store.handleYeaftOutput({
      agentId: 'agent-1',
      event: {
        type: 'group_list_updated',
        groups: [{ id: 'grp-1', name: 'Restored' }],
      },
    });

    expect(store.yeaftActiveSessionFilter).toBe('grp-1');
    expect(store.yeaftSessionHistoryState['grp-1']).toMatchObject({ loading: true, loaded: false });
    expect(store.sent).toContainEqual({
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 5,
      sessionId: 'grp-1',
    });
  });

  it('does not duplicate forced unchanged-group hydration while history is loading', () => {
    const store = makeStore();
    const sessionsStore = {
      activeSessionId: 'grp-1',
      applySnapshot(groups) {
        expect(groups).toEqual([{ id: 'grp-1', name: 'Restored' }]);
        this.activeSessionId = 'grp-1';
      },
    };
    window.Pinia.useSessionsStore = () => sessionsStore;

    store.currentView = 'yeaft';
    store.yeaftAgentId = 'agent-1';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftSessionReady = true;
    store.yeaftModel = 'model-a';
    store.yeaftStatus = { tools: [], skills: [], mcpServers: [] };

    store.handleYeaftOutput({
      agentId: 'agent-1',
      event: {
        type: 'group_list_updated',
        groups: [{ id: 'grp-1', name: 'Restored' }],
      },
    });
    expect(store.sent.filter(m => m.type === 'yeaft_load_history')).toHaveLength(1);

    store.sent = [];
    store.handleYeaftOutput({
      agentId: 'agent-1',
      event: {
        type: 'group_list_updated',
        groups: [{ id: 'grp-1', name: 'Restored' }],
      },
    });

    expect(store.sent.filter(m => m.type === 'yeaft_load_history')).toEqual([]);
  });
});

describe('Yeaft message reload', () => {
  it('reloads the active Yeaft session messages without reloading the page', () => {
    const store = makeStore();
    window.Pinia.useSessionsStore = () => ({ activeSessionId: 'grp-1' });

    store.currentView = 'yeaft';
    store.yeaftAgentId = 'agent-1';
    store.yeaftConversationId = 'yeaft-conv';
    store.messagesMap['yeaft-conv'] = [
      { id: 'old-user', type: 'user', content: 'old', sessionId: 'grp-1' },
      { id: 'old-assistant', type: 'assistant', content: 'old reply', sessionId: 'grp-1' },
    ];

    expect(store.reloadYeaftMessages()).toBe(true);

    expect(store.messagesMap['yeaft-conv']).toEqual([]);
    expect(store.yeaftSessionHistoryState['grp-1']).toMatchObject({ loading: true, loaded: false });
    expect(store.sent.at(-1)).toEqual({
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      limit: 5,
      sessionId: 'grp-1',
    });
  });
});
