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
  store.activeSessionKey = null;
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

    expect(store.sessionById('s-pinned', 'agent-1')).toMatchObject({ pinned: true });
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

    expect(store.sessionById('s-pinned', 'agent-1')).toMatchObject({ pinned: true });
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

    expect(store.sessionById('s-b', 'agent-1')).toMatchObject({ pinned: true });
    expect(ids(store.sessionList)).toEqual(['s-b', 's-a', 's-c']);

    store.applyPinState('s-b', false);

    expect(store.sessionById('s-b', 'agent-1')).toMatchObject({ pinned: false });
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
    expect(store.sessionById('yeaft-ui', 'agent-1')).toMatchObject({ pinned: true });

    // This mirrors the real UI path: selecting a row can be followed by a
    // lightweight session upsert/list refresh that does not carry pin fields.
    // Absence is not an authoritative unpin; only pinned:false/isPinned:false is.
    store.applySnapshotUpsert({ id: 'yeaft-ui', name: 'Yeaft-UI', updatedAt: 40 }, 'agent-1');
    store.setActive('yeaft');

    expect(store.sessionById('yeaft-ui', 'agent-1')).toMatchObject({ pinned: true });
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

    expect(store.sessionById('yeaft-ui', 'agent-1')).toMatchObject({ pinned: true });
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

  expect(store.sessionById('session-a', 'agent-a')).toMatchObject({ agentId: 'agent-a', pinned: true });
  expect(store.sessionById('session-c', 'agent-b')).toMatchObject({ agentId: 'agent-b', pinned: true });
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

  expect(store.sessionById('running-session', 'agent-1')).toMatchObject({
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

it('keeps foreign agent slots stable when manually reordering one agent', () => {
  const store = useSessionsStore();
  store.sessions = {
    'agent-a\u001fa1': { id: 'a1', agentId: 'agent-a' },
    'agent-b\u001fb1': { id: 'b1', agentId: 'agent-b' },
    'agent-a\u001fa2': { id: 'a2', agentId: 'agent-a' },
    'agent-c\u001fc1': { id: 'c1', agentId: 'agent-c' },
    'agent-a\u001fa3': { id: 'a3', agentId: 'agent-a' },
  };
  store.sessionOrder = ['agent-a\u001fa1', 'agent-b\u001fb1', 'agent-a\u001fa2', 'agent-c\u001fc1', 'agent-a\u001fa3'];

  const ordered = store.reorderSessionsForAgent('agent-a', ['a3', 'a1', 'a2']);

  expect(ordered).toEqual(['a3', 'a1', 'a2']);
  expect(store.sessionOrder.map(key => store.sessions[key]?.id)).toEqual(['a3', 'b1', 'a1', 'c1', 'a2']);
  expect(store.sessionOrder.map(key => store.sessions[key]?.id)).not.toEqual(['a3', 'a1', 'a2', 'b1', 'c1']);
  expect(JSON.parse(localStorageData.get('yeaft-session-order-by-agent'))).toEqual({
    'agent-a': ['a3', 'a1', 'a2'],
  });
});

it('re-applies persisted manual order without moving foreign agent slots on snapshot refresh', () => {
  const store = useSessionsStore();
  localStorageData.set('yeaft-session-order-by-agent', JSON.stringify({
    'agent-a': ['a3', 'a1', 'a2'],
  }));
  store.sessions = {
    'agent-a\u001fa1': { id: 'a1', agentId: 'agent-a' },
    'agent-b\u001fb1': { id: 'b1', agentId: 'agent-b' },
    'agent-a\u001fa2': { id: 'a2', agentId: 'agent-a' },
    'agent-c\u001fc1': { id: 'c1', agentId: 'agent-c' },
    'agent-a\u001fa3': { id: 'a3', agentId: 'agent-a' },
  };
  store.sessionOrder = ['agent-a\u001fa1', 'agent-b\u001fb1', 'agent-a\u001fa2', 'agent-c\u001fc1', 'agent-a\u001fa3'];

  store.applySnapshot([
    { id: 'a1', name: 'A1' },
    { id: 'a2', name: 'A2' },
    { id: 'a3', name: 'A3' },
  ], 'agent-a');

  expect(store.sessionOrder.map(key => store.sessions[key]?.id)).toEqual(['a3', 'b1', 'a1', 'c1', 'a2']);
});

it('persists manual Yeaft session order globally across agents and re-applies it across snapshots', () => {
  const store = useSessionsStore();
  store.applySnapshot([
    { id: 'a1', name: 'A1', updatedAt: 300 },
    { id: 'a2', name: 'A2', updatedAt: 100 },
  ], 'agent-a');
  store.applySnapshot([
    { id: 'b1', name: 'B1', updatedAt: 200 },
  ], 'agent-b');

  const ordered = store.reorderSessionsGlobally([
    'agent-b\u001fb1',
    'agent-a\u001fa2',
    'agent-a\u001fa1',
  ]);

  expect(ordered).toEqual([
    { agentId: 'agent-b', sessionId: 'b1' },
    { agentId: 'agent-a', sessionId: 'a2' },
    { agentId: 'agent-a', sessionId: 'a1' },
  ]);
  expect(ids(store.sessionList)).toEqual(['b1', 'a2', 'a1']);
  expect(JSON.parse(localStorageData.get('yeaft-session-order-global'))).toEqual([
    'agent-b\u001fb1',
    'agent-a\u001fa2',
    'agent-a\u001fa1',
  ]);

  store.applySnapshot([
    { id: 'a1', name: 'A1', updatedAt: 300 },
    { id: 'a2', name: 'A2', updatedAt: 100 },
  ], 'agent-a');
  store.applySnapshot([
    { id: 'b1', name: 'B1', updatedAt: 200 },
  ], 'agent-b');

  expect(ids(store.sessionList)).toEqual(['b1', 'a2', 'a1']);
});

it('keeps duplicate session ids from different agents as separate rows', () => {
  const store = useSessionsStore();

  store.applySnapshot([
    { id: 'session_default', name: 'Default A', updatedAt: 300 },
  ], 'agent-a');
  store.applySnapshot([
    { id: 'session_default', name: 'Default B', updatedAt: 200 },
  ], 'agent-b');

  expect(store.sessionOrder).toEqual(['agent-a\u001fsession_default', 'agent-b\u001fsession_default']);
  expect(store.sessionList.map(row => [row.id, row.name, row.agentId])).toEqual([
    ['session_default', 'Default A', 'agent-a'],
    ['session_default', 'Default B', 'agent-b'],
  ]);
  expect(store.sessionById('session_default', 'agent-a')?.name).toBe('Default A');
  expect(store.sessionById('session_default', 'agent-b')?.name).toBe('Default B');

  store.setActive('session_default', 'agent-b');
  expect(store.activeSessionId).toBe('session_default');
  expect(store.activeSession?.name).toBe('Default B');

  store.applyPinState('session_default', true, 'agent-b');
  expect(store.sessionById('session_default', 'agent-a')?.pinned).toBe(false);
  expect(store.sessionById('session_default', 'agent-b')?.pinned).toBe(true);
});

it('treats explicit pinned false from the server as authoritative on reload', () => {
  const store = useSessionsStore();
  chatStore.pinnedSessions = ['session-a'];

  store.applySnapshot([
    { id: 'session-a', name: 'A', pinned: true },
  ], 'agent-1');
  expect(store.sessionById('session-a', 'agent-1').pinned).toBe(true);
  expect(chatStore.pinnedSessions).toContain('session-a');

  store.applySnapshot([
    { id: 'session-a', name: 'A', pinned: false },
  ], 'agent-1');

  expect(store.sessionById('session-a', 'agent-1').pinned).toBe(false);
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
