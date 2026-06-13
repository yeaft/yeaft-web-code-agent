/**
 * yeaft-agentlist-loop.test.js — regression guard for the Yeaft "open a
 * session and it spins select_agent / yeaft_load_history / yeaft_vp_subscribe
 * forever" bug.
 *
 * Root cause (June 12): handleAgentList's reconnect-restore branch ran a
 * history catch-up (`requestYeaftSessionBootstrap({ catchUpHistory: true })`)
 * on EVERY agent_list. agent_list is a routine broadcast (status flips,
 * turn_completed, latency pings — ~20 server call sites), and the catch-up
 * predicate `shouldCatchUpLoadedYeaftSession` re-arms after each
 * history_loaded resets `loading:false`. So a loaded session re-fired
 * yeaft_load_history on every broadcast, and each reply (session_ready) made
 * the client re-send yeaft_vp_subscribe.
 *
 * Fix: only catch up on a GENUINE reconnect, gated by the one-shot
 * `_yeaftReconnectCatchUpPending` flag (set by the websocket onclose handler,
 * consumed+cleared here). Routine agent_list → no catch-up → no loop.
 *
 * The test drives the REAL production code: `handleAgentList` from
 * agentHandler.js and the real `requestYeaftSessionBootstrap` action bound
 * onto a synthetic store (same harness style as yeaft-history-reentry).
 */
import { describe, it, expect } from 'vitest';

// chat.js → auth.js does `const { defineStore } = Pinia` against a global
// Pinia (CDN in the browser). Shim it + window for Node-side tests.
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = globalThis.Pinia.defineStore || ((_id, options) => () => options);
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  _m: {},
  getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};

const { useChatStore } = await import('../../../web/stores/chat.js');
const { handleAgentList } = await import('../../../web/stores/helpers/handlers/agentHandler.js');

const AGENT_ID = 'user_1:C1';
const SESSION_ID = 'sess-1';

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

  // In Yeaft view, on the agent, with the active session already fully
  // loaded and a known latestSeq cursor (the steady state after first load).
  store.currentView = 'yeaft';
  store.currentAgent = AGENT_ID;
  store.yeaftAgentId = AGENT_ID;
  store.yeaftConversationId = 'yeaft-1';
  store.yeaftActiveSessionFilter = SESSION_ID;
  store.yeaftSessionReady = true;
  store.yeaftModel = 'sonnet';
  store.yeaftStatus = { skills: [], mcpServers: [], tools: [] };
  store.yeaftSessionHistoryState = {
    [SESSION_ID]: { loaded: true, loading: false, hasMore: false, oldestSeq: 1, count: 3, latestSeq: 42 },
  };
  return store;
}

function agentListMsg() {
  return { type: 'agent_list', agents: [{ id: AGENT_ID, name: 'C1', online: true, conversations: [] }] };
}

const loadHistoryCount = (store) => store.sent.filter(m => m.type === 'yeaft_load_history').length;

describe('Yeaft agent_list does not loop history catch-up', () => {
  it('sends NO yeaft_load_history on routine agent_list for a loaded session (no reconnect)', () => {
    const store = makeStore();
    // Simulate the storm: many routine agent_list broadcasts back-to-back.
    for (let i = 0; i < 5; i++) handleAgentList(store, agentListMsg());
    expect(loadHistoryCount(store)).toBe(0);
    // And no vp_subscribe churn either (that rides on session_ready, which
    // only the catch-up round-trip would have produced).
    expect(store.sent.some(m => m.type === 'yeaft_vp_subscribe')).toBe(false);
  });

  it('runs exactly ONE catch-up after a genuine reconnect, then stops', () => {
    const store = makeStore();
    // Websocket onclose set this one-shot flag on a real drop.
    store._yeaftReconnectCatchUpPending = true;

    handleAgentList(store, agentListMsg());

    const catchUps = store.sent.filter(m => m.type === 'yeaft_load_history');
    expect(catchUps).toHaveLength(1);
    expect(catchUps[0]).toMatchObject({ type: 'yeaft_load_history', sessionId: SESSION_ID, afterSeq: 42 });
    // Flag consumed — subsequent routine broadcasts do not re-fire.
    expect(store._yeaftReconnectCatchUpPending).toBe(false);

    for (let i = 0; i < 3; i++) handleAgentList(store, agentListMsg());
    expect(loadHistoryCount(store)).toBe(1);
  });

  it('still bootstraps metadata when session_ready state is missing (no catch-up needed)', () => {
    const store = makeStore();
    // Status not yet loaded → needSessionReady path; but no reconnect flag.
    store.yeaftSessionReady = false;
    store.yeaftModel = null;
    store.yeaftStatus = null;

    handleAgentList(store, agentListMsg());

    const loads = store.sent.filter(m => m.type === 'yeaft_load_history');
    // One metadata-only request (limit:0), NOT a history catch-up (no afterSeq).
    expect(loads).toHaveLength(1);
    expect(loads[0].afterSeq).toBeUndefined();
    expect(loads[0].limit).toBe(0);
  });
});

// Bug 1 (v0.1.96x): an AGENT PROCESS restart (deploy/update) keeps the
// web↔server websocket alive, so the onclose latch never fires and the Yeaft
// session is left un-reloaded. handleAgentList must detect the restart edge
// (offline→online of a KNOWN agent, or a version bump) and arm the same
// one-shot catch-up — WITHOUT re-introducing the per-broadcast loop.
function agentRecord({ online = true, version = 'v1' } = {}) {
  return { id: AGENT_ID, name: 'C1', online, version, conversations: [] };
}
function agentListWith(rec) {
  return { type: 'agent_list', agents: [rec] };
}

describe('Yeaft reloads the session when the agent process restarts', () => {
  it('triggers exactly ONE catch-up on an offline→online transition of the known agent', () => {
    const store = makeStore();
    // Seed a prior list where the agent is KNOWN but offline (the restart blip).
    store.agents = [agentRecord({ online: false, version: 'v1' })];

    handleAgentList(store, agentListWith(agentRecord({ online: true, version: 'v1' })));

    const catchUps = store.sent.filter(m => m.type === 'yeaft_load_history');
    expect(catchUps).toHaveLength(1);
    expect(catchUps[0]).toMatchObject({ type: 'yeaft_load_history', sessionId: SESSION_ID, afterSeq: 42 });
    expect(store._yeaftReconnectCatchUpPending).toBe(false);

    // Steady online afterwards → no further catch-up.
    for (let i = 0; i < 3; i++) handleAgentList(store, agentListWith(agentRecord({ online: true, version: 'v1' })));
    expect(loadHistoryCount(store)).toBe(1);
  });

  it('triggers a catch-up on a version bump even if the agent never appeared offline', () => {
    const store = makeStore();
    // Agent was online at v1; a deploy bumps it to v2 with no observed offline frame.
    store.agents = [agentRecord({ online: true, version: 'v1' })];

    handleAgentList(store, agentListWith(agentRecord({ online: true, version: 'v2' })));

    const catchUps = store.sent.filter(m => m.type === 'yeaft_load_history');
    expect(catchUps).toHaveLength(1);
    expect(catchUps[0]).toMatchObject({ type: 'yeaft_load_history', sessionId: SESSION_ID, afterSeq: 42 });
  });

  it('does NOT treat the first-ever agent_list (cold start) as a restart', () => {
    const store = makeStore();
    // No prior agents list at all (page just loaded). The agent appearing
    // online for the first time is enterYeaft's job, not a restart catch-up.
    store.agents = [];

    handleAgentList(store, agentListWith(agentRecord({ online: true, version: 'v1' })));

    // Session already loaded + ready → nothing should be sent.
    expect(loadHistoryCount(store)).toBe(0);
  });

  it('does NOT trigger when the agent stays online at the same version', () => {
    const store = makeStore();
    store.agents = [agentRecord({ online: true, version: 'v1' })];
    for (let i = 0; i < 4; i++) handleAgentList(store, agentListWith(agentRecord({ online: true, version: 'v1' })));
    expect(loadHistoryCount(store)).toBe(0);
  });

  it('does NOT trigger a restart catch-up when NOT in Yeaft view', () => {
    const store = makeStore();
    store.currentView = 'chat';
    store.agents = [agentRecord({ online: false, version: 'v1' })];
    handleAgentList(store, agentListWith(agentRecord({ online: true, version: 'v2' })));
    // Not in yeaft view → no yeaft bootstrap. (Chat reconnect uses sync_messages.)
    expect(loadHistoryCount(store)).toBe(0);
    expect(store._yeaftReconnectCatchUpPending).toBeFalsy();
  });
});
