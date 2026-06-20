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
const { handleAgentList, detectYeaftAgentRestart } = await import('../../../web/stores/helpers/handlers/agentHandler.js');

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

describe('Yeaft early history frames', () => {
  it('moves the active Yeaft conversation from local placeholder to the agent conversation id', () => {
    const store = makeStore();
    store.yeaftConversationId = 'yeaft-local-agent-1';
    store.yeaftConversationIdsByAgent = { [AGENT_ID]: 'yeaft-local-agent-1' };
    store.activeConversations = ['yeaft-local-agent-1'];
    store.messagesMap = { 'yeaft-local-agent-1': [{ id: 'local-old', type: 'user', content: 'draft', timestamp: 1, sessionId: SESSION_ID }] };
    store.handleAssistantOutputFrame = (conversationId, data) => {
      store.messagesMap[conversationId].push({ id: data.message?.id, type: data.type, content: data.message?.content, timestamp: 2, sessionId: SESSION_ID });
    };

    store.handleYeaftOutput({
      conversationId: 'yeaft-real-1',
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      data: { type: 'user', message: { id: 'm0002', content: 'hello' } },
    });

    expect(store.yeaftConversationId).toBe('yeaft-real-1');
    expect(store.yeaftConversationIdsByAgent[AGENT_ID]).toBe('yeaft-real-1');
    expect(store.activeConversations).toEqual(['yeaft-real-1']);
    expect(store.messagesMap['yeaft-local-agent-1']).toBeUndefined();
    expect(store.messagesMap['yeaft-real-1'].map(m => m.content)).toEqual(['draft', 'hello']);
  });
});

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

// Bug 1 (v0.1.96x): an AGENT PROCESS restart (deploy/update/crash) keeps the
// web↔server websocket alive, so the onclose latch never fires and the Yeaft
// session is left un-reloaded. handleAgentList must detect the restart edge
// and arm the same one-shot catch-up — WITHOUT re-introducing the
// per-broadcast loop.
//
// CRITICAL contract: the server DELETES an agent from its map on disconnect
// (server/ws-agent.js handleAgentDisconnect → agents.delete), so a restart
// broadcasts as present(v1) → ABSENT → present(v2). The agent is NEVER
// reported present-but-`online:false`. These tests replay that real frame
// sequence, driving the production handleAgentList (which maintains the
// persisted `_yeaftAgentSeen` snapshot across the absent frame).
function agentRecord({ online = true, version = 'v1' } = {}) {
  return { id: AGENT_ID, name: 'C1', online, version, conversations: [] };
}
function presentFrame(rec) {
  return { type: 'agent_list', agents: [rec] };
}
function absentFrame() {
  // Agent removed from the server map → not in the list at all.
  return { type: 'agent_list', agents: [] };
}

describe('detectYeaftAgentRestart (pure)', () => {
  it('no edge on cold start (seen=null)', () => {
    expect(detectYeaftAgentRestart(null, agentRecord({ online: true }))).toBe(false);
  });
  it('edge when a previously-online agent comes back online (same version)', () => {
    expect(detectYeaftAgentRestart({ id: AGENT_ID, online: false, version: 'v1' }, agentRecord({ online: true, version: 'v1' }))).toBe(true);
  });
  it('edge on a version bump while staying online', () => {
    expect(detectYeaftAgentRestart({ id: AGENT_ID, online: true, version: 'v1' }, agentRecord({ online: true, version: 'v2' }))).toBe(true);
  });
  it('no edge while steadily online at the same version', () => {
    expect(detectYeaftAgentRestart({ id: AGENT_ID, online: true, version: 'v1' }, agentRecord({ online: true, version: 'v1' }))).toBe(false);
  });
  it('no edge when the agent is absent/offline now (wait for it to return)', () => {
    expect(detectYeaftAgentRestart({ id: AGENT_ID, online: true, version: 'v1' }, undefined)).toBe(false);
  });
  it('no false edge on a version bump if either version is null (old agents)', () => {
    expect(detectYeaftAgentRestart({ id: AGENT_ID, online: true, version: null }, agentRecord({ online: true, version: 'v2' }))).toBe(false);
    expect(detectYeaftAgentRestart({ id: AGENT_ID, online: true, version: 'v1' }, agentRecord({ online: true, version: null }))).toBe(false);
  });
});

describe('Yeaft reloads the session when the agent process restarts', () => {
  it('triggers exactly ONE catch-up across present → ABSENT → present (plain restart, same version)', () => {
    const store = makeStore();
    // First frame: agent present & online (prime the seen-snapshot, no edge).
    handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v1' })));
    expect(loadHistoryCount(store)).toBe(0);

    // Agent disconnects → removed from the list entirely.
    handleAgentList(store, absentFrame());
    expect(loadHistoryCount(store)).toBe(0);

    // Restarted process reconnects → present again (same version, e.g. crash/bounce).
    handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v1' })));

    const catchUps = store.sent.filter(m => m.type === 'yeaft_load_history');
    expect(catchUps).toHaveLength(1);
    expect(catchUps[0]).toMatchObject({ type: 'yeaft_load_history', sessionId: SESSION_ID, afterSeq: 42 });
    expect(store._yeaftReconnectCatchUpPending).toBe(false);

    // Steady online afterwards → no further catch-up.
    for (let i = 0; i < 3; i++) handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v1' })));
    expect(loadHistoryCount(store)).toBe(1);
  });

  it('triggers a catch-up on present(v1) → present(v2) when the absent frame coalesced away', () => {
    const store = makeStore();
    handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v1' })));
    // Deploy: new version with no observed gap (broadcasts coalesced).
    handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v2' })));

    const catchUps = store.sent.filter(m => m.type === 'yeaft_load_history');
    expect(catchUps).toHaveLength(1);
    expect(catchUps[0]).toMatchObject({ type: 'yeaft_load_history', sessionId: SESSION_ID, afterSeq: 42 });
  });

  it('does NOT treat the first-ever agent_list (cold start) as a restart', () => {
    const store = makeStore();
    // No prior snapshot (page just loaded). The agent appearing online for
    // the first time is enterYeaft's job, not a restart catch-up.
    expect(store._yeaftAgentSeen).toBeFalsy();
    handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v1' })));
    expect(loadHistoryCount(store)).toBe(0);
  });

  it('does NOT trigger when the agent stays online at the same version', () => {
    const store = makeStore();
    for (let i = 0; i < 4; i++) handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v1' })));
    expect(loadHistoryCount(store)).toBe(0);
  });

  it('does NOT trigger a restart catch-up when NOT in Yeaft view', () => {
    const store = makeStore();
    store.currentView = 'chat';
    handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v1' })));
    handleAgentList(store, absentFrame());
    handleAgentList(store, presentFrame(agentRecord({ online: true, version: 'v2' })));
    // Not in yeaft view → no yeaft bootstrap. (Chat reconnect uses sync_messages.)
    expect(loadHistoryCount(store)).toBe(0);
    expect(store._yeaftReconnectCatchUpPending).toBeFalsy();
  });
});
