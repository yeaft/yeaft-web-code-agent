import { describe, expect, it } from 'vitest';

// chat.js depends on Pinia/localStorage globals in the browser build.
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
const { handleCrewSessionsList } = await import('../../../web/stores/helpers/crew.js');
const { handleAgentList } = await import('../../../web/stores/helpers/handlers/agentHandler.js');

const AGENT_ID = 'user_1:agent-a';

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
  store.currentAgent = AGENT_ID;
  store.crewModeEnabled = true;
  store.agents = [{ id: AGENT_ID, name: 'Agent A', online: true, conversations: [] }];
  return store;
}

function agentListMsg(conversations = []) {
  return { type: 'agent_list', agents: [{ id: AGENT_ID, name: 'Agent A', online: true, conversations }] };
}

describe('Crew on-demand session list', () => {
  it('does not mark inactive indexed Crew sessions as processing even if their old status was running', () => {
    const store = makeStore();

    handleCrewSessionsList(store, {
      type: 'crew_sessions_list',
      sessions: [{
        sessionId: 'crew_old_running',
        projectDir: '/repo',
        status: 'running',
        active: false,
        createdAt: 1000,
        name: 'Old Crew'
      }]
    });

    const conv = store.conversations.find(c => c.id === 'crew_old_running');
    expect(conv).toMatchObject({
      type: 'crew',
      crewListLoaded: true,
      processing: false,
      agentId: AGENT_ID,
      agentName: 'Agent A'
    });
  });

  it('keeps on-demand Crew rows across routine agent_list snapshots but prunes them on the next Crew list snapshot', () => {
    const store = makeStore();

    handleCrewSessionsList(store, {
      type: 'crew_sessions_list',
      sessions: [
        { sessionId: 'crew_keep', projectDir: '/repo/a', status: 'stopped', active: false, createdAt: 1 },
        { sessionId: 'crew_prune', projectDir: '/repo/b', status: 'stopped', active: false, createdAt: 2 }
      ]
    });
    expect(store.conversations.map(c => c.id).sort()).toEqual(['crew_keep', 'crew_prune']);

    handleAgentList(store, agentListMsg([]));
    expect(store.conversations.map(c => c.id).sort()).toEqual(['crew_keep', 'crew_prune']);

    handleCrewSessionsList(store, {
      type: 'crew_sessions_list',
      sessions: [
        { sessionId: 'crew_keep', projectDir: '/repo/a', status: 'stopped', active: false, createdAt: 1 }
      ]
    });
    expect(store.conversations.map(c => c.id)).toEqual(['crew_keep']);
  });

  it('skips the list request and ignores snapshots while crew mode is disabled', () => {
    const store = makeStore();
    store.crewModeEnabled = false;

    // listCrewSessions must not emit a request when crew mode is off.
    store.listCrewSessions();
    expect(store.sent).toEqual([]);

    // A late snapshot arriving after crew was turned off must be ignored.
    handleCrewSessionsList(store, {
      type: 'crew_sessions_list',
      sessions: [{ sessionId: 'crew_x', projectDir: '/repo', status: 'stopped', active: false, createdAt: 1 }]
    });
    expect(store.conversations.find(c => c.id === 'crew_x')).toBeUndefined();
  });
});
