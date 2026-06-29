import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageData = new Map();

globalThis.localStorage = {
  getItem: vi.fn((key) => localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: vi.fn((key, value) => { localStorageData.set(key, String(value)); }),
  removeItem: vi.fn((key) => { localStorageData.delete(key); }),
};

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = {
      ...(typeof options.state === 'function' ? options.state() : {}),
    };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() {
          return getter(instance);
        },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    return instance;
  };
}

globalThis.Pinia = {
  defineStore: createStoreFactory,
};

const chatStore = {
  currentView: 'chat',
  yeaftActiveSessionFilter: null,
  pinnedSessions: [],
  setActiveSessionFilter: vi.fn(function setActiveSessionFilter(sessionId) {
    this.yeaftActiveSessionFilter = sessionId || null;
  }),
  applyServerPinSnapshot(_agentId, pinnedInSnapshot, isOwnedByAgent) {
    const existing = new Set(this.pinnedSessions);
    for (const id of pinnedInSnapshot) {
      if (!existing.has(id)) this.pinnedSessions.unshift(id);
    }
    this.pinnedSessions = this.pinnedSessions.filter(id => !isOwnedByAgent(id) || pinnedInSnapshot.has(id));
    localStorage.setItem('pinned-sessions', JSON.stringify(this.pinnedSessions));
  },
};

globalThis.window = {
  Pinia: {
    useChatStore: () => chatStore,
  },
};

const { useSessionsStore } = await import('../../../web/stores/sessions.js');
const { default: YeaftSidebar } = await import('../../../web/components/YeaftSidebar.js');

function ids(rows) {
  return rows.map(row => row.id);
}

beforeEach(() => {
  localStorageData.clear();
  chatStore.currentView = 'chat';
  chatStore.yeaftActiveSessionFilter = null;
  chatStore.pinnedSessions = [];
  chatStore.setActiveSessionFilter.mockClear();
  const store = useSessionsStore();
  store.sessions = {};
  store.sessionOrder = [];
  store.activeSessionId = null;
  store.lastSnapshotAt = 0;
  store.lastCrudResult = null;
  store.pending = {};
});

describe('Yeaft session pin persistence flow', () => {
  it('hydrates persisted server pin metadata from isPinned and keeps pinned rows above active non-pinned rows', () => {
    const store = useSessionsStore();

    store.applySnapshot([
      { id: 's-active', name: 'Active', updatedAt: 30 },
      { id: 's-pinned', name: 'Pinned', updatedAt: 10, isPinned: true },
      { id: 's-other', name: 'Other', updatedAt: 20 },
    ], 'agent-1');

    expect(store.sessions['s-pinned']).toMatchObject({ pinned: true });
    expect(chatStore.pinnedSessions).toEqual(['s-pinned']);
    expect(ids(store.sessionList)).toEqual(['s-pinned', 's-active', 's-other']);

    store.setActive('s-other');

    expect(store.activeSessionId).toBe('s-other');
    expect(ids(store.sessionList)).toEqual(['s-pinned', 's-active', 's-other']);
  });

  it('activates and loads the first visible session when Yeaft opens before the session snapshot arrives', () => {
    const store = useSessionsStore();
    chatStore.currentView = 'yeaft';

    store.applySnapshot([
      { id: 's-old', name: 'Older', updatedAt: 10 },
      { id: 's-new', name: 'Newer', updatedAt: 50 },
    ], 'agent-1');

    expect(store.activeSessionId).toBe('s-new');
    expect(chatStore.setActiveSessionFilter).toHaveBeenCalledTimes(1);
    expect(chatStore.setActiveSessionFilter).toHaveBeenCalledWith('s-new', { force: true });
    expect(chatStore.yeaftActiveSessionFilter).toBe('s-new');
  });

  it('uses the same activation path when the default session is pinned above newer rows', () => {
    const store = useSessionsStore();
    chatStore.currentView = 'yeaft';

    store.applySnapshot([
      { id: 's-new', name: 'Newer', updatedAt: 50 },
      { id: 's-pinned', name: 'Pinned', updatedAt: 10, pinned: true },
    ], 'agent-1');

    expect(ids(store.sessionList)).toEqual(['s-pinned', 's-new']);
    expect(store.activeSessionId).toBe('s-pinned');
    expect(chatStore.setActiveSessionFilter).toHaveBeenCalledWith('s-pinned', { force: true });
  });

  it('keeps pre-entry snapshot hydration cheap and lets enterYeaft bootstrap the selected session', () => {
    const store = useSessionsStore();

    store.applySnapshot([
      { id: 's-first', name: 'First', updatedAt: 20 },
    ], 'agent-1');

    expect(store.activeSessionId).toBe('s-first');
    expect(chatStore.yeaftActiveSessionFilter).toBe('s-first');
    expect(chatStore.setActiveSessionFilter).not.toHaveBeenCalled();
  });

  it('keeps server-persisted pins after a later session list refresh', () => {
    const store = useSessionsStore();

    store.applySnapshot([
      { id: 's-pinned', updatedAt: 10, isPinned: true },
      { id: 's-active', updatedAt: 20 },
    ], 'agent-1');
    store.setActive('s-active');

    store.applySnapshot([
      { id: 's-active', updatedAt: 40 },
      { id: 's-pinned', updatedAt: 10, pinned: true },
      { id: 's-new', updatedAt: 50 },
    ], 'agent-1');

    expect(store.sessions['s-pinned']).toMatchObject({ pinned: true });
    expect(chatStore.pinnedSessions).toEqual(['s-pinned']);
    expect(ids(store.sessionList)).toEqual(['s-pinned', 's-new', 's-active']);
  });

  it('updates row metadata for pin and unpin acknowledgements so pinned block membership recovers', () => {
    const store = useSessionsStore();
    store.applySnapshot([
      { id: 's-a', updatedAt: 10, isPinned: true },
      { id: 's-b', updatedAt: 20 },
      { id: 's-c', updatedAt: 30 },
    ], 'agent-1');

    store.applyPinState('s-b', true);

    expect(store.sessions['s-b']).toMatchObject({ pinned: true });
    expect(ids(store.sessionList)).toEqual(['s-b', 's-a', 's-c']);

    store.applyPinState('s-b', false);

    expect(store.sessions['s-b']).toMatchObject({ pinned: false });
    expect(ids(store.sessionList)).toEqual(['s-a', 's-c', 's-b']);
  });

  it('keeps a pinned session pinned when selecting a non-pinned session after an upsert without pin fields', () => {
    const store = useSessionsStore();
    store.applySnapshot([
      { id: 'yeaft-ui', name: 'Yeaft-UI', updatedAt: 30, isPinned: true },
      { id: 'yeaft', name: 'Yeaft', updatedAt: 20 },
      { id: 'other', name: 'Other', updatedAt: 10 },
    ], 'agent-1');

    expect(ids(store.sessionList)).toEqual(['yeaft-ui', 'yeaft', 'other']);
    expect(store.sessions['yeaft-ui']).toMatchObject({ pinned: true });

    // This mirrors the real UI path: selecting a row can be followed by a
    // lightweight session upsert/list refresh that does not carry pin fields.
    // Absence is not an authoritative unpin; only pinned:false/isPinned:false is.
    store.applySnapshotUpsert({ id: 'yeaft-ui', name: 'Yeaft-UI', updatedAt: 40 }, 'agent-1');
    store.setActive('yeaft');

    expect(store.sessions['yeaft-ui']).toMatchObject({ pinned: true });
    expect(store.activeSessionId).toBe('yeaft');
    expect(ids(store.sessionList)).toEqual(['yeaft-ui', 'yeaft', 'other']);
  });

  it('does not treat a session list snapshot with missing pin fields as an unpin', () => {
    const store = useSessionsStore();
    store.applySnapshot([
      { id: 'yeaft-ui', name: 'Yeaft-UI', updatedAt: 30, isPinned: true },
      { id: 'yeaft', name: 'Yeaft', updatedAt: 20 },
    ], 'agent-1');

    store.applySnapshot([
      { id: 'yeaft', name: 'Yeaft', updatedAt: 40 },
      { id: 'yeaft-ui', name: 'Yeaft-UI', updatedAt: 30 },
    ], 'agent-1');
    store.setActive('yeaft');

    expect(store.sessions['yeaft-ui']).toMatchObject({ pinned: true });
    expect(chatStore.pinnedSessions).toEqual(['yeaft-ui']);
    expect(ids(store.sessionList)).toEqual(['yeaft-ui', 'yeaft']);
  });

  it('keeps pinned marker and order through the real YeaftSidebar sessionList path after selecting another session', () => {
    const store = useSessionsStore();
    store.applySnapshot([
      { id: 'yeaft-ui', name: 'Yeaft-UI', updatedAt: 30, isPinned: true },
      { id: 'yeaft', name: 'Yeaft', updatedAt: 20 },
      { id: 'other', name: 'Other', updatedAt: 10 },
    ], 'agent-1');

    // Simulate a later server/client refresh that omits pin fields for the
    // pinned row, then the user clicks a different non-pinned session.
    store.applySnapshotUpsert({ id: 'yeaft-ui', name: 'Yeaft-UI' }, 'agent-1');
    store.setActive('yeaft');
    chatStore.yeaftActiveSessionFilter = 'yeaft';

    const ctx = {
      sessionsStore: store,
      chatStore,
      activeSessionId: 'yeaft',
    };
    const rows = YeaftSidebar.computed.sessionList.call(ctx);

    expect(ids(rows)).toEqual(['yeaft-ui', 'yeaft', 'other']);
    expect(rows[0]).toMatchObject({ id: 'yeaft-ui', pinned: true, active: false });
    expect(rows[1]).toMatchObject({ id: 'yeaft', pinned: false, active: true });
    expect(YeaftSidebar.methods.isSessionPinned.call(ctx, rows[0])).toBe(true);
  });

});

it('applies connected-agent list results as session snapshots with persisted pin metadata', () => {
  const store = useSessionsStore();

  store.applyCrudResult({
    ok: true,
    op: 'list',
    sessions: [
      { id: 'session-a', name: 'A', updatedAt: 10, pinned: true },
      { id: 'session-b', name: 'B', updatedAt: 20 },
    ],
  }, 'agent-a');
  store.applyCrudResult({
    ok: true,
    op: 'list',
    sessions: [
      { id: 'session-c', name: 'C', updatedAt: 30, isPinned: true },
    ],
  }, 'agent-b');

  expect(store.sessions['session-a']).toMatchObject({ agentId: 'agent-a', pinned: true });
  expect(store.sessions['session-c']).toMatchObject({ agentId: 'agent-b', pinned: true });
  expect(ids(store.sessionList).slice(0, 2).sort()).toEqual(['session-a', 'session-c']);
  expect(ids(store.sessionList)[2]).toBe('session-b');
});

it('sends Yeaft pin metadata so the server can persist before DB hydration', () => {
  const calls = [];
  const component = {
    groupMenu: { open: true, groupId: 'session-a' },
    store: { currentAgent: 'agent-current' },
    chatStore: {
      togglePin(...args) { calls.push(args); },
    },
  };

  YeaftSidebar.methods.onTogglePin.call(component, {
    id: 'session-a',
    agentId: 'agent-a',
    name: 'Pinned Session',
    workDir: '/repo',
  });

  expect(component.groupMenu).toEqual({ open: false, groupId: null });
  expect(calls).toEqual([[ 'session-a', {
    sessionKind: 'yeaft',
    agentId: 'agent-a',
    sessionName: 'Pinned Session',
    workDir: '/repo',
  } ]]);
});

const { useChatStore } = await import('../../../web/stores/chat.js');
const { handleAgentList } = await import('../../../web/stores/helpers/handlers/agentHandler.js');

it('loads opened Yeaft sessions from every connected agent on entry', () => {
  const store = useChatStore();
  const requests = [];
  store.agents = [
    { id: 'agent-a', online: true },
    { id: 'agent-b', online: true },
    { id: 'agent-offline', online: false },
    { id: 'agent-a', online: true },
  ];
  store.sessionCrudRequest = (op, data, opts) => {
    requests.push({ op, data, opts });
    return Promise.resolve({ ok: true });
  };

  const loaded = store.loadOpenedYeaftSessionsForConnectedAgents();

  expect(loaded).toEqual(['agent-a', 'agent-b']);
  expect(requests).toEqual([
    { op: 'list', data: {}, opts: { agentId: 'agent-a' } },
    { op: 'list', data: {}, opts: { agentId: 'agent-b' } },
  ]);
});

it('loads opened Yeaft sessions when agents become ready after entering Yeaft', () => {
  const store = useChatStore();
  const requests = [];
  store.currentView = 'yeaft';
  store.agents = [];
  store.currentAgent = null;
  store._yeaftOpenedSessionsLoadedAgents = {};
  store.sessionCrudRequest = (op, data, opts) => {
    requests.push({ op, data, opts });
    return Promise.resolve({ ok: true });
  };
  store.sendWsMessage = () => {};

  const loadedBeforeAgents = store.loadOpenedYeaftSessionsForConnectedAgents();
  expect(loadedBeforeAgents).toEqual([]);

  handleAgentList(store, { agents: [{ id: 'agent-late', online: true, conversations: [] }] });
  handleAgentList(store, { agents: [{ id: 'agent-late', online: true, conversations: [] }] });

  expect(store.currentAgent).toBe('agent-late');
  expect(requests).toEqual([
    { op: 'list', data: {}, opts: { agentId: 'agent-late' } },
  ]);
});

it('force reloads opened Yeaft sessions when re-entering the Yeaft page', () => {
  const store = useChatStore();
  const requests = [];
  store.agents = [{ id: 'agent-a', online: true }];
  store._yeaftOpenedSessionsLoadedAgents = { 'agent-a': 123 };
  store.sessionCrudRequest = (op, data, opts) => {
    requests.push({ op, data, opts });
    return Promise.resolve({ ok: true });
  };

  const skipped = store.loadOpenedYeaftSessionsForConnectedAgents();
  const forced = store.loadOpenedYeaftSessionsForConnectedAgents(null, { force: true });

  expect(skipped).toEqual([]);
  expect(forced).toEqual(['agent-a']);
  expect(requests).toEqual([{ op: 'list', data: {}, opts: { agentId: 'agent-a' } }]);
});

it('persists Yeaft pin actions with agent-scoped metadata', () => {
  const store = useChatStore();
  const sent = [];
  store.pinnedSessions = [];
  store.sendWsMessage = (msg) => sent.push(msg);

  store.togglePin('session-a', {
    sessionKind: 'yeaft',
    agentId: 'agent-a',
    sessionName: 'Session A',
    workDir: '/repo',
  });

  expect(store.pinnedSessions).toContain('session-a');
  expect(sent).toEqual([{
    type: 'pin_session',
    conversationId: 'session-a',
    sessionKind: 'yeaft',
    agentId: 'agent-a',
    sessionName: 'Session A',
    workDir: '/repo',
  }]);
});

it('restores a running opened Yeaft session from the connected-agent list snapshot after reload', () => {
  const store = useSessionsStore();

  store.applySnapshot([
    { id: 'idle-session', name: 'Idle', updatedAt: 20, pinned: false },
    { id: 'running-session', name: 'Running', updatedAt: 10, running: true, runningVpCount: 1, latestActivityAt: 99, pinned: true },
  ], 'agent-1');

  expect(store.sessions['running-session']).toMatchObject({
    agentId: 'agent-1',
    running: true,
    active: true,
    runningVpCount: 1,
    pinned: true,
  });
  expect(store.activeSessionId).toBe('running-session');
  expect(chatStore.yeaftActiveSessionFilter).toBe('running-session');
  expect(ids(store.sessionList)[0]).toBe('running-session');
});

it('persists manual Yeaft session order locally and re-applies it across snapshots', () => {
  const store = useSessionsStore();

  store.applySnapshot([
    { id: 'session-a', name: 'A', updatedAt: 300 },
    { id: 'session-b', name: 'B', updatedAt: 200 },
    { id: 'session-c', name: 'C', updatedAt: 100 },
  ], 'agent-1');

  const ordered = store.reorderSessionsForAgent('agent-1', ['session-c', 'session-a', 'session-b']);

  expect(ordered).toEqual(['session-c', 'session-a', 'session-b']);
  expect(ids(store.sessionList)).toEqual(['session-c', 'session-a', 'session-b']);
  expect(JSON.parse(localStorageData.get('yeaft-session-order-by-agent'))).toEqual({
    'agent-1': ['session-c', 'session-a', 'session-b'],
  });

  store.applySnapshot([
    { id: 'session-a', name: 'A', updatedAt: 300 },
    { id: 'session-b', name: 'B', updatedAt: 200 },
    { id: 'session-c', name: 'C', updatedAt: 100 },
  ], 'agent-1');

  expect(ids(store.sessionList)).toEqual(['session-c', 'session-a', 'session-b']);
});

it('treats explicit pinned false from the server as authoritative on reload', () => {
  const store = useSessionsStore();
  chatStore.pinnedSessions = ['session-a'];

  store.applySnapshot([
    { id: 'session-a', name: 'A', pinned: true },
  ], 'agent-1');
  expect(store.sessions['session-a'].pinned).toBe(true);
  expect(chatStore.pinnedSessions).toContain('session-a');

  store.applySnapshot([
    { id: 'session-a', name: 'A', pinned: false },
  ], 'agent-1');

  expect(store.sessions['session-a'].pinned).toBe(false);
  expect(chatStore.pinnedSessions).not.toContain('session-a');
});

it('restores active Yeaft session filter from a reconnect VP status snapshot when no user filter exists', () => {
  const store = useChatStore();
  store.yeaftActiveSessionFilter = null;
  store.vpStatuses = {};
  const sessions = useSessionsStore();
  window.Pinia.useSessionsStore = useSessionsStore;
  sessions.applySnapshot([
    { id: 'active-session', name: 'Active' },
  ], 'agent-1');
  store.yeaftActiveSessionFilter = null;
  sessions.activeSessionId = null;

  const restored = store.restoreActiveYeaftSessionFromStatuses([
    { sessionId: 'active-session', vpId: 'vp-a', state: 'streaming', since: 123 },
  ]);

  expect(restored).toBe('active-session');
  expect(store.yeaftActiveSessionFilter).toBe('active-session');
  expect(sessions.activeSessionId).toBe('active-session');
});
