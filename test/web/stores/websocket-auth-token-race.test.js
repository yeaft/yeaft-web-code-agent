import { afterEach, describe, expect, it, vi } from 'vitest';

const originalLocation = globalThis.location;
const originalWebSocket = globalThis.WebSocket;
const originalPinia = globalThis.Pinia;
const originalLocalStorage = globalThis.localStorage;

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

  it('settles only old-generation Session copy requests when replacing a socket', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();
    const resolveOldCopy = vi.fn();
    const resolveNewCopy = vi.fn();
    store.sessionForkPendingKey = 'yeaft:agent-a:source';
    store.sessionForkState = 'copying';
    store._sessionCrudPending = new Map([
      ['old-copy', {
        op: 'copy', connectionGeneration: 4, resolve: resolveOldCopy,
      }],
      ['new-copy', {
        op: 'copy', connectionGeneration: 5, resolve: resolveNewCopy,
      }],
    ]);
    store.ws = { onopen: vi.fn(), onmessage: vi.fn(), onclose: vi.fn(), close: vi.fn() };

    connect(store);

    expect(resolveOldCopy).toHaveBeenCalledWith({
      ok: false,
      requestId: 'old-copy',
      error: { code: 'connection_changed', message: 'WebSocket connection changed' },
    });
    expect(resolveNewCopy).not.toHaveBeenCalled();
    expect(store._sessionCrudPending.has('old-copy')).toBe(false);
    expect(store._sessionCrudPending.has('new-copy')).toBe(true);
    expect(store.sessionForkPendingKey).toBeNull();
    expect(store.sessionForkState).toBe('idle');
    expect(sockets).toHaveLength(1);
  });

  it('settles only the active socket generation when a real disconnect occurs', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();
    const resolveActiveCopy = vi.fn();
    const resolveFutureRequest = vi.fn();

    connect(store);
    store._sessionCrudPending = new Map([
      ['active-copy', {
        op: 'copy', connectionGeneration: 5, resolve: resolveActiveCopy,
      }],
      ['future-request', {
        op: 'rename', connectionGeneration: 6, resolve: resolveFutureRequest,
      }],
    ]);
    store.sessionForkPendingKey = 'yeaft:agent-a:source';
    store.sessionForkState = 'copying';
    sockets[0].onclose({ code: 1006, reason: 'network lost' });

    expect(resolveActiveCopy).toHaveBeenCalledWith({
      ok: false,
      requestId: 'active-copy',
      error: { code: 'agent_offline', message: 'WebSocket disconnected' },
    });
    expect(resolveFutureRequest).not.toHaveBeenCalled();
    expect(store._sessionCrudPending.has('active-copy')).toBe(false);
    expect(store._sessionCrudPending.has('future-request')).toBe(true);
    expect(store.sessionForkPendingKey).toBeNull();
    expect(store.sessionForkState).toBe('idle');
  });

  it('restores encrypted outbound mode before reconnecting to a legacy Server', async () => {
    const authStore = createRaceAuthStore();
    const sockets = installFakeWebSocket();
    globalThis.location = { protocol: 'https:', host: 'example.test' };
    const { connect } = await loadWebsocketHelpers(authStore);
    const store = createStore();
    store.sessionKey = new Uint8Array(32).fill(7);
    store.serverEncryptionRequired = false;

    connect(store);
    sockets[0].readyState = globalThis.WebSocket.OPEN;
    store.ws = sockets[0];
    expect(store.serverEncryptionRequired).toBe(true);
    expect(sockets[0].sent).toEqual([]);
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

  it('passes the socket-local token to auth_result failures from the active socket', async () => {
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
    sockets[0].onmessage({ data: JSON.stringify({ type: 'auth_result', success: false, error: 'bad token' }) });

    expect(store.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'auth_result',
      success: false,
      _wsAuthToken: 'old-token',
    }));
    expect(authStore.handleAuthFailure).toHaveBeenCalledWith(undefined, 'old-token', 1);
    expect(authStore.token).toBe(null);
  });
});
