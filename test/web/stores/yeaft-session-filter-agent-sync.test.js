/**
 * yeaft-session-filter-agent-sync.test.js — regression for PR #1119 review
 * finding #2 (Fowler, Important).
 *
 * After `yeaftAgentId` was removed, agent-level Yeaft ops (global cancelYeaft,
 * MCP / search settings, reset) route by `currentAgent`. `setActiveSessionFilter`
 * is reachable from callers that do NOT pre-`selectAgent`
 * (restoreActiveYeaftSessionFromStatuses, the group_list_updated snapshot
 * handler, YeaftPage.onSelectGroupV2). If those land on a session owned by a
 * different agent, `currentAgent` must follow — otherwise the next agent-level
 * op silently targets the wrong agent.
 *
 * This pins that `setActiveSessionFilter` self-heals `currentAgent` /
 * `currentAgentInfo` to the active session's owner and emits the select_agent
 * frame, while session-scoped history still routes to the owner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = { ...(typeof options.state === 'function' ? options.state() : {}) };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, { enumerable: true, get() { return getter(instance); } });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };

// Mock sessions store: session-b is owned by agent-b, session-a by agent-a.
const sessionsStore = {
  sessionById: (id) => ({
    'session-a': { id: 'session-a', agentId: 'agent-a' },
    'session-b': { id: 'session-b', agentId: 'agent-b' },
  }[id] || null),
};
globalThis.window = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  Pinia: { useSessionsStore: () => sessionsStore },
};
globalThis.document = { addEventListener: vi.fn(), removeEventListener: vi.fn(), documentElement: { setAttribute() {}, classList: { toggle() {} } } };

const { useChatStore } = await import('../../../web/stores/chat.js');

function primeStore() {
  const store = useChatStore();
  const sent = [];
  store.currentView = 'yeaft';
  store.currentAgent = 'agent-a';
  store.currentAgentInfo = { id: 'agent-a', name: 'A' };
  store.agents = [{ id: 'agent-a', name: 'A', online: true }, { id: 'agent-b', name: 'B', online: true }];
  store.yeaftActiveSessionFilter = 'session-a';
  store.yeaftSessionAgentById = {};
  store.yeaftConversationIdsByAgent = {};
  store.yeaftConversationId = null;
  store.yeaftSessionHistoryState = {};
  store.messagesMap = {};
  store.activeConversations = [];
  store.agentSwitching = false;
  store.sendWsMessage = (m) => { sent.push(m); };
  store._sent = sent;
  return store;
}

describe('setActiveSessionFilter self-heals currentAgent to the session owner', () => {
  beforeEach(() => { localStorage._m.clear(); });

  it('switches currentAgent / currentAgentInfo when landing on a cross-agent session', () => {
    const store = primeStore();
    store.setActiveSessionFilter('session-b', { force: true });

    expect(store.currentAgent).toBe('agent-b');
    expect(store.currentAgentInfo).toEqual({ id: 'agent-b', name: 'B', online: true });
    // select_agent frame emitted so the server-side binding follows too.
    expect(store._sent.some(m => m.type === 'select_agent' && m.agentId === 'agent-b')).toBe(true);
    // Session-scoped history routes to the owner, never the stale page agent.
    const hist = store._sent.find(m => m.type === 'yeaft_load_history' && m.sessionId === 'session-b');
    expect(hist).toBeTruthy();
    expect(hist.agentId).toBe('agent-b');
    // Per-session owner cache recorded for downstream sends/aborts.
    expect(store.yeaftSessionAgentById['session-b']).toBe('agent-b');
  });

  it('does not emit a redundant select_agent when the owner is already current', () => {
    const store = primeStore();
    store.yeaftActiveSessionFilter = null;
    store.setActiveSessionFilter('session-a', { force: true });

    expect(store.currentAgent).toBe('agent-a');
    expect(store._sent.some(m => m.type === 'select_agent')).toBe(false);
  });
});
