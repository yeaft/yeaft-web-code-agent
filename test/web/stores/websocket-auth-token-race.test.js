import { afterEach, describe, expect, it, vi } from 'vitest';

const originalLocation = globalThis.location;
const originalWebSocket = globalThis.WebSocket;
const originalPinia = globalThis.Pinia;
const originalLocalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;

function installMemoryLocalStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
    clear: () => values.clear(),
  };
}

async function loadWebsocketHelpers(authStore) {
  vi.resetModules();
  const stores = new Map();
  globalThis.Pinia = {
    defineStore: (id, options = {}) => () => {
      if (stores.has(id)) return stores.get(id);
      const store = { ...(typeof options.state === 'function' ? options.state() : {}) };
      for (const [name, action] of Object.entries(options.actions || {})) {
        store[name] = action.bind(store);
      }
      for (const [name, getter] of Object.entries(options.getters || {})) {
        Object.defineProperty(store, name, { get: () => getter.call(store, store) });
      }
      stores.set(id, store);
      return store;
    },
  };
  vi.doMock('../../../web/stores/auth.js', () => ({
    useAuthStore: () => authStore,
  }));
  return {
    ...await import('../../../web/stores/helpers/websocket.js'),
    ...await import('../../../web/stores/chat.js'),
    ...await import('../../../web/stores/helpers/messageHandler.js'),
  };
}

function createStore() {
  return {
    ws: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    connectionState: 'disconnected',
    authenticated: false,
    _hasHandledAgentList: true,
    _hasHandledYeaftSessionHydrate: true,
    yeaftSessionInventoryCompleteSupported: true,
    yeaftSessionHydrateRequestId: 'old-inventory',
    _yeaftSessionInventorySocketQuarantined: true,
    serverEncryptionRequired: false,
    chatHistoryRequestIdSupported: true,
    chatHistoryConnectionGeneration: 4,
    chatHistoryRequests: {},
    currentView: 'chat',
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    parseWsMessage: vi.fn(data => JSON.parse(data)),
    handleMessage: vi.fn(),
    connect: vi.fn(),
    scheduleReconnect: vi.fn(),
  };
}

function installFakeWebSocket() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  return sockets;
}

function createRaceAuthStore() {
  return {
    token: 'old-token',
    authGeneration: 1,
    getActiveToken: vi.fn(function getActiveToken() { return this.token; }),
    handleAuthFailure: vi.fn(function handleAuthFailure(_, failedToken, failedGeneration = this.authGeneration) {
      if (failedToken !== this.token || failedGeneration !== this.authGeneration) return false;
      this.token = null;
      this.authGeneration += 1;
      return false;
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  globalThis.location = originalLocation;
  globalThis.WebSocket = originalWebSocket;
  globalThis.Pinia = originalPinia;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  vi.useRealTimers();
  if (originalLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalLocalStorage;
});

describe('websocket auth token races', () => {
  it('ignores 1008 close events from an older token after a newer login wins', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    installMemoryLocalStorage();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect, useChatStore } = await loadWebsocketHelpers(authStore);
    const store = createStore();
    const resolveProjectMutation = vi.fn();
    store.projectMutationRequests = {
      staleProjectMutation: { resolve: resolveProjectMutation },
    };
    store.sessionProjects = [{
      id: 'server-p',
      members: [{ agentId: 'agent-a', sessionId: 'server-session' }],
    }];
    store.sessionCatalogLoaded = true;
    store.sessionCatalog = [{ catalogKey: 'chat:stale' }];
    store.activeCatalogKey = 'chat:stale';
    store.sessionCatalogMutationRequests = {
      oldMutation: { previousCatalog: [{ catalogKey: 'chat:before-reconnect' }] },
    };
    store.chatHistoryRequests['chat:stale'] = {
      requestId: 'old-request',
      loading: true,
      connectionGeneration: 4,
    };

    connect(store);
    expect(store._hasHandledAgentList).toBe(false);
    expect(store._hasHandledYeaftSessionHydrate).toBe(false);
    expect(store.yeaftSessionInventoryCompleteSupported).toBeNull();
    expect(store.yeaftSessionHydrateRequestId).toBeNull();
    expect(store._yeaftSessionInventorySocketQuarantined).toBe(false);
    expect(store.serverEncryptionRequired).toBe(true);
    expect(store.chatHistoryRequestIdSupported).toBe(null);
    expect(store.chatHistoryConnectionGeneration).toBe(5);
    expect(resolveProjectMutation).toHaveBeenCalledWith({
      ok: false,
      requestId: 'staleProjectMutation',
      error: { code: 'connection_changed' },
    });
    expect(store.projectMutationRequests).toEqual({});
    expect(store.sessionProjects).toEqual([]);
    const chatStore = useChatStore();
    chatStore.sessionCatalog = [];
    chatStore.sessionProjects = store.sessionProjects;
    chatStore.applyLegacyProjectSnapshot([{
      id: 'local-p',
      name: 'Local project',
      sessionIds: ['local-session'],
    }], 'agent-a');
    expect(chatStore.sessionProjects.map(project => project.id)).toEqual(['agent-a\u001flocal-p']);
    expect(chatStore.sessionProjects.flatMap(project => project.members)).toEqual([
      { agentId: 'agent-a', sessionId: 'local-session' },
    ]);
    expect(store.chatHistoryRequests['chat:stale']).toMatchObject({
      loading: false,
      cancelled: true,
      error: 'connection_changed',
    });
    expect(store.sessionCatalogMutationRequests).toEqual({});
    expect(store.sessionCatalogLoaded).toBe(false);
    expect(store.sessionCatalog).toEqual([]);
    expect(store.activeCatalogKey).toBe(null);
    authStore.token = 'new-token';
    authStore.authGeneration = 2;
    sockets[0].onclose({ code: 1008, reason: 'Authentication required' });

    expect(sockets[0].url).toContain('token=old-token');
    expect(authStore.handleAuthFailure).toHaveBeenCalledWith(undefined, 'old-token', 1);
    expect(authStore.token).toBe('new-token');
    expect(store._hasHandledAgentList).toBe(false);
    expect(store._hasHandledYeaftSessionHydrate).toBe(false);
    expect(store.yeaftSessionInventoryCompleteSupported).toBeNull();
    expect(store.yeaftSessionHydrateRequestId).toBeNull();
  });

  it('ignores auth_result failures from an older socket after a newer login wins', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();
    store.handleMessage = vi.fn(msg => {
      if (msg.type === 'auth_result' && msg.success === false) {
        authStore.handleAuthFailure(undefined, msg._wsAuthToken, msg._wsAuthGeneration);
      }
    });

    connect(store);
    const staleOnMessage = sockets[0].onmessage;
    authStore.token = 'new-token';
    connect(store);
    staleOnMessage({ data: JSON.stringify({ type: 'auth_result', success: false, error: 'bad token' }) });

    expect(sockets[0].url).toContain('token=old-token');
    expect(sockets[1].url).toContain('token=new-token');
    expect(sockets[0].onmessage).toBe(null);
    expect(store.handleMessage).not.toHaveBeenCalled();
    expect(authStore.handleAuthFailure).not.toHaveBeenCalled();
    expect(authStore.token).toBe('new-token');
  });
});

async function lifecycleFixture() {
  vi.useFakeTimers();
  installMemoryLocalStorage();
  const sockets = installFakeWebSocket();
  globalThis.location = { protocol: 'https:', host: 'example.test' };
  const sessions = { sessionList: [], applySnapshot: vi.fn(), beginInventoryCommit: vi.fn() };
  globalThis.window = { Pinia: { useSessionsStore: () => sessions }, dispatchEvent: vi.fn() };
  const auth = { ...createRaceAuthStore(), userId: 'owner-a' };
  auth.$subscribe = vi.fn(callback => { auth.notify = callback; return vi.fn(); });
  const helpers = await loadWebsocketHelpers(auth);
  const store = helpers.useChatStore();
  store.startHeartbeat = vi.fn();
  store.stopHeartbeat = vi.fn();
  store.scheduleReconnect = vi.fn();
  store.parseWsMessage = data => JSON.parse(data);
  store.requestYeaftSessionInventory = vi.fn();
  store.checkPendingRecovery = vi.fn();
  const deliver = (msg, socket = sockets.at(-1)) => socket.onmessage({ data: JSON.stringify(msg) });
  const open = (capability = 1, inventoryComplete = true) => {
    helpers.connect(store);
    sockets.at(-1).readyState = globalThis.WebSocket.OPEN;
    sockets.at(-1).onopen();
    deliver({ type: 'auth_result', success: true,
      ...(capability === null ? {} : { sessionCatalogProtocol: capability }),
      yeaftSessionInventoryComplete: inventoryComplete,
    });
  };
  return { auth, store, sockets, sessions, deliver, open, helpers };
}

const catalogRow = {
  catalogKey: 'yeaft:agent-a:session-a', runtimeProvider: 'yeaft', title: 'Session A',
  routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'session-a' },
};

describe('sidebar Session catalog lifecycle', () => {
  it('keeps cold paint loading until an authoritative modern snapshot, including empty', async () => {
    const { store, open, deliver, sessions } = await lifecycleFixture();
    store.conversations = [{ id: 'legacy-chat', agentId: 'agent-a' }];
    sessions.sessionList = [{ id: 'legacy-session', agentId: 'agent-a' }];
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    expect(store.sidebarSessionCatalog).toEqual([]);
    open();
    store._hasHandledAgentList = true;
    store._hasHandledYeaftSessionHydrate = true;
    store.applyLegacyProjectSnapshot([{ id: 'p', sessionIds: ['legacy-session'] }], 'agent-a');
    expect(store.sessionCatalogLoaded).toBe(false);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    expect(store.sidebarSessionCatalog).toEqual([]);
    deliver({ type: 'session_catalog_snapshot', catalog: [], projects: [], projectsAuthoritative: true });
    expect(store.sidebarSessionCatalog).toEqual([]);
    expect(store.sidebarSessionCatalogLoading).toBe(false);
  });

  it('retains same-auth catalog, projects, hidden rows and active key after rolling back a pending mutation', async () => {
    const { auth, store, sockets, open, deliver } = await lifecycleFixture();
    open();
    const projects = [{ id: 'project-a', members: [] }];
    const hidden = [{ ...catalogRow, catalogKey: 'yeaft:agent-a:hidden', hidden: true }];
    deliver({ type: 'session_catalog_snapshot', catalog: [catalogRow], hiddenCatalog: hidden,
      projects, projectsAuthoritative: true });
    store.activeCatalogKey = catalogRow.catalogKey;
    store.sessionCatalogMutationRequests.pending = {
      previousCatalog: [{ ...catalogRow }], previousHiddenCatalog: hidden,
    };
    store.sessionCatalog = [];
    store.hiddenSessionCatalog = [...hidden, { ...catalogRow, hidden: true }];
    const resolve = vi.fn();
    store.projectMutationRequests.pending = { resolve };
    const staleMessage = sockets[0].onmessage;
    auth.token = 'renewed-same-auth-token';
    open();
    expect(store.sessionCatalogMutationRequests).toEqual({});
    expect(resolve).toHaveBeenCalledWith({ ok: false, requestId: 'pending', error: { code: 'connection_changed' } });
    expect(store.sidebarSessionCatalog).toEqual([catalogRow]);
    expect(store.sessionProjects).toEqual(projects);
    expect(store.hiddenSessionCatalog).toEqual(hidden);
    expect(store.activeCatalogKey).toBe(catalogRow.catalogKey);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    staleMessage({ data: JSON.stringify({ type: 'session_catalog_snapshot', catalog: [] }) });
    expect(store.sidebarSessionCatalog).toEqual([catalogRow]);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    deliver({ type: 'session_catalog_snapshot', catalog: [], hiddenCatalog: [], projects: [], projectsAuthoritative: true });
    expect(store.sidebarSessionCatalog).toEqual([]);
    expect(store.sidebarSessionCatalogLoading).toBe(false);
  });

  it.each(['owner', 'generation'])('clears private retained data on %s changes even with a renewed token', async change => {
    const { auth, store, open, deliver } = await lifecycleFixture();
    open();
    deliver({ type: 'session_catalog_snapshot', catalog: [catalogRow], hiddenCatalog: [catalogRow],
      projects: [{ id: 'private-p' }], projectsAuthoritative: true });
    store.activeCatalogKey = catalogRow.catalogKey;
    auth.token = 'renewed-token';
    if (change === 'owner') auth.userId = 'owner-b';
    else auth.authGeneration += 1;
    expect(store.sidebarSessionCatalog).toEqual([]);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    auth.notify();
    expect(store.sessionCatalog).toEqual([]);
    expect(store.hiddenSessionCatalog).toEqual([]);
    expect(store.sessionProjects).toEqual([]);
    expect(store.activeCatalogKey).toBeNull();
    // The still-open previous identity cannot repopulate the catalog.
    deliver({ type: 'session_catalog_snapshot', catalog: [catalogRow] });
    expect(store.sessionCatalog).toEqual([]);
    open();
    expect(store.sidebarSessionCatalog).toEqual([]);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
  });

  it('adapts old-Server inventories into unified Agent-scoped rows at their accepted boundary', async () => {
    const { store, sessions, open, deliver } = await lifecycleFixture();
    open(null);
    store.conversations = [{ id: 'chat-a', agentId: 'agent-a', provider: 'copilot', title: 'Chat A' }];
    sessions.sessionList = [{ id: 'same', agentId: 'agent-a', name: 'A' }, { id: 'same', agentId: 'agent-b', name: 'B' }];
    store._hasHandledAgentList = true;
    store.yeaftSessionHydrateRequestId = 'inventory';
    deliver({ type: 'yeaft_session_hydrate_complete', requestId: 'inventory', ok: true });
    expect(store.sessionCatalogProtocolSupported).toBe(false);
    expect(store.sidebarSessionCatalogLoading).toBe(false);
    expect(store.sidebarSessionCatalog.map(row => row.catalogKey)).toEqual(['chat:chat-a', 'yeaft:agent-a:same', 'yeaft:agent-b:same']);
    expect(store.sidebarSessionCatalog[0]).toMatchObject({ runtimeProvider: 'copilot', title: 'Chat A',
      routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'chat-a' } });
    open(null);
    expect(store.sidebarSessionCatalog).toHaveLength(3);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    // A second reconnect while the replacement inventory is still pending
    // must not drop the retained legacy projection either.
    open(null);
    expect(store.sidebarSessionCatalog).toHaveLength(3);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    // Upgrading to a catalog-capable Server also retains the accepted prior
    // rows until its authority arrives, without considering them ready.
    open();
    expect(store.sidebarSessionCatalog).toHaveLength(3);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    deliver({ type: 'session_catalog_snapshot', catalog: [] });
    expect(store.sidebarSessionCatalog).toEqual([]);
    expect(store.sidebarSessionCatalogLoading).toBe(false);
  });

  it('does not expose false empty for a failed or unknown inventory', async () => {
    const { store, open, deliver } = await lifecycleFixture();
    open(null);
    store._hasHandledAgentList = true;
    store.yeaftSessionHydrateRequestId = 'inventory';
    deliver({ type: 'yeaft_session_hydrate_complete', requestId: 'inventory', ok: false, error: 'failed' });
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    store.yeaftSessionHydrateRequestId = 'inventory-2';
    deliver({ type: 'yeaft_session_hydrate_complete', requestId: 'inventory-2', ok: true });
    expect(store.sessionCatalogProtocolSupported).toBe(false);
    // A later successful inventory resolves the failed request, including empty.
    expect(store.sidebarSessionCatalog).toEqual([]);
    expect(store.sidebarSessionCatalogLoading).toBe(false);
  });

  it('treats failed or malformed catalog frames as supported but not authoritative', async () => {
    const { store, open, deliver } = await lifecycleFixture();
    open(null);
    store._hasHandledAgentList = true;
    store.conversations = [{ id: 'legacy-chat', agentId: 'agent-a' }];
    deliver({ type: 'session_catalog_snapshot', ok: false, catalog: [] });
    deliver({ type: 'session_catalog_snapshot' });
    store.yeaftSessionHydrateRequestId = 'inventory';
    deliver({ type: 'yeaft_session_hydrate_complete', requestId: 'inventory', ok: true });
    expect(store.sessionCatalogProtocolSupported).toBe(true);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    expect(store.sidebarSessionCatalog).toEqual([]);
  });

  it('keeps accepted rows read-only immediately on network close', async () => {
    const { store, sockets, open, deliver } = await lifecycleFixture();
    open();
    deliver({ type: 'session_catalog_snapshot', catalog: [catalogRow] });
    expect(store.sidebarSessionCatalogLoading).toBe(false);
    sockets[0].onclose({ code: 1006, reason: 'network lost' });
    expect(store.sidebarSessionCatalog).toEqual([catalogRow]);
    expect(store.sidebarSessionCatalogLoading).toBe(true);
  });

  it('accepts a genuinely old Server successful empty inventory without capability metadata', async () => {
    const { store, open, deliver } = await lifecycleFixture();
    open(null, false);
    store._hasHandledAgentList = true;
    store.yeaftSessionHydrateRequestId = 'legacy-empty';
    deliver({ type: 'yeaft_session_hydrate', agentId: 'agent-a', sessions: [] });
    expect(store.sidebarSessionCatalogLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.sessionCatalogProtocolSupported).toBe(false);
    expect(store.sidebarSessionCatalog).toEqual([]);
    expect(store.sidebarSessionCatalogLoading).toBe(false);
  });
});
