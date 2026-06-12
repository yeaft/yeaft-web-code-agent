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
const { handleMessage } = await import('../../../web/stores/helpers/messageHandler.js');

function makeStore() {
  const schema = useChatStore();
  const state = schema.state();
  const store = { ...state, sent: [] };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  store.sendWsMessage = function sendWsMessage(msg) { this.sent.push(msg); };
  store.selectAgent = function selectAgent(agentId) {
    this.currentAgent = agentId;
    this.currentAgentInfo = this.agents.find((a) => a.id === agentId) || null;
  };
  store.checkPendingRecovery = function checkPendingRecovery() {};
  return store;
}

function status(model, refreshing = false, refreshError = null) {
  return {
    type: 'yeaft_status',
    model,
    availableModels: [{ id: model, provider: 'p', label: model }],
    skills: 1,
    mcpServers: [],
    tools: 2,
    refreshing,
    refreshError,
    refreshedAt: 100,
  };
}

describe('Yeaft per-agent model cache', () => {
  it('hydrates cached model candidates from agent_list before entering Yeaft', () => {
    const store = makeStore();

    handleMessage(store, {
      type: 'agent_list',
      agents: [
        { id: 'agent-a', name: 'A', online: true, conversations: [], yeaftStatus: status('a-model') },
      ],
    });

    store.enterYeaft('agent-a');

    expect(store.yeaftModel).toBe('a-model');
    expect(store.yeaftAvailableModels.map((m) => m.id)).toEqual(['a-model']);
    expect(store.yeaftModelsRefreshing).toBe(false);
  });

  it('switches to the target agent cached model list instead of reusing the previous agent list', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'agent_list',
      agents: [
        { id: 'agent-a', name: 'A', online: true, conversations: [], yeaftStatus: status('a-model') },
        { id: 'agent-b', name: 'B', online: true, conversations: [], yeaftStatus: status('b-model') },
      ],
    });

    store.enterYeaft('agent-a');
    expect(store.yeaftAvailableModels.map((m) => m.id)).toEqual(['a-model']);

    store.enterYeaft('agent-b');
    expect(store.yeaftModel).toBe('b-model');
    expect(store.yeaftAvailableModels.map((m) => m.id)).toEqual(['b-model']);
  });

  it('keeps the old model list visible when a background refresh fails', () => {
    const store = makeStore();
    store.enterYeaft('agent-a');
    store.handleYeaftOutput({ agentId: 'agent-a', event: status('good-model') });

    store.handleYeaftOutput({
      agentId: 'agent-a',
      event: {
        type: 'yeaft_status',
        model: 'good-model',
        refreshing: false,
        refreshError: 'provider down',
        refreshedAt: 200,
      },
    });

    expect(store.yeaftAvailableModels.map((m) => m.id)).toEqual(['good-model']);
    expect(store.yeaftModelRefreshError).toBe('provider down');
    expect(store.yeaftModelsRefreshing).toBe(false);
  });
});
