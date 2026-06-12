/**
 * fix-yeaft-session-per-agent
 *
 * `setActiveSessionFilter` is invoked from two flows that can cross agents:
 *   1. Unified sidebar click on a session that belongs to a different agent
 *      (YeaftSidebar.onSelectGroup → chat.selectAgent + sessionsStore.setActive
 *      → YeaftPage.onSelectGroupV2 → setActiveSessionFilter).
 *   2. SessionCreateModal resume row click (same shape, modal-local).
 *
 * Before this fix, `yeaft_load_history` was sent with `agentId: this.yeaftAgentId`,
 * which only ever updates inside `enterYeaft()`. So the load_history was routed
 * to the wrong agent (or to no agent at all), and the main pane stayed empty
 * while the per-agent sessions snapshot for the *other* agent silently went
 * stale. The fix derives the target agent from the sessions store (session.agentId)
 * first, then falls back to currentAgent, then to yeaftAgentId — and syncs
 * yeaftAgentId so downstream calls (send, abort, model-switch) route correctly.
 */
import { describe, it, expect } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  _data: {},
  getItem(k) { return this._data[k] ?? null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
};

const { useChatStore } = await import('../../../web/stores/chat.js');

function makeStore() {
  const schema = useChatStore();
  const state = schema.state();
  const store = { ...state, sent: [] };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  store.sendWsMessage = function sendWsMessage(msg) { this.sent.push(msg); };
  return store;
}

function withSessionsStore(sessions, fn) {
  const previousWindow = globalThis.window;
  globalThis.window = {
    ...(previousWindow || {}),
    Pinia: {
      ...((previousWindow && previousWindow.Pinia) || {}),
      useSessionsStore: () => ({
        sessionById: (id) => sessions[id] || null,
      }),
    },
  };
  try { return fn(); }
  finally { globalThis.window = previousWindow; }
}

describe('Yeaft cross-agent session routing (setActiveSessionFilter)', () => {
  it('routes yeaft_load_history to the session\'s owning agent, not the current yeaftAgentId', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-A';   // user originally entered yeaft on A
    store.currentAgent = 'agent-A';
    store.yeaftActiveSessionFilter = null;

    withSessionsStore({
      'grp_b_session': { id: 'grp_b_session', agentId: 'agent-B' },
    }, () => {
      store.setActiveSessionFilter('grp_b_session');
    });

    // The load_history MUST go to agent-B (session owner), not agent-A.
    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-B',
      sessionId: 'grp_b_session',
      limit: 5,
    }]);
  });

  it('syncs yeaftAgentId to the new agent so subsequent sends route correctly', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-A';
    store.currentAgent = 'agent-A';

    withSessionsStore({
      'grp_b_session': { id: 'grp_b_session', agentId: 'agent-B' },
    }, () => {
      store.setActiveSessionFilter('grp_b_session');
    });

    expect(store.yeaftAgentId).toBe('agent-B');
  });

  it('falls back to currentAgent when the sessions store has no row for the id (stale snapshot)', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-A';
    store.currentAgent = 'agent-C';   // user just clicked an agent header

    withSessionsStore({}, () => {
      store.setActiveSessionFilter('grp_unknown');
    });

    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-C',
      sessionId: 'grp_unknown',
      limit: 5,
    }]);
    expect(store.yeaftAgentId).toBe('agent-C');
  });

  it('falls back to yeaftAgentId when neither sessions store nor currentAgent help', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-1';
    store.yeaftAgentId = 'agent-A';
    store.currentAgent = null;

    withSessionsStore({}, () => {
      store.setActiveSessionFilter('grp_x');
    });

    expect(store.sent).toEqual([{
      type: 'yeaft_load_history',
      agentId: 'agent-A',
      sessionId: 'grp_x',
      limit: 5,
    }]);
  });

  it('does not re-send when the same session is selected again without force', () => {
    const store = makeStore();
    store.yeaftAgentId = 'agent-A';
    store.yeaftActiveSessionFilter = 'grp_same';

    withSessionsStore({
      'grp_same': { id: 'grp_same', agentId: 'agent-A' },
    }, () => {
      store.setActiveSessionFilter('grp_same');
    });

    expect(store.sent).toEqual([]);
  });

  it('re-sends load_history when force:true even if the session matches', () => {
    const store = makeStore();
    store.yeaftAgentId = 'agent-A';
    store.yeaftActiveSessionFilter = 'grp_same';

    withSessionsStore({
      'grp_same': { id: 'grp_same', agentId: 'agent-A' },
    }, () => {
      store.setActiveSessionFilter('grp_same', { force: true });
    });

    expect(store.sent).toHaveLength(1);
    expect(store.sent[0]).toMatchObject({
      type: 'yeaft_load_history',
      agentId: 'agent-A',
      sessionId: 'grp_same',
    });
  });
});
