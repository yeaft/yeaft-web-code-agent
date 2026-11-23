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

function installFakeWebSocket() {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.close = vi.fn();
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
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
  vi.unstubAllGlobals();
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

async function lifecycleFixture() {
  vi.useFakeTimers();
  installMemoryLocalStorage();
  const sockets = installFakeWebSocket();
  globalThis.location = { protocol: 'https:', host: 'example.test' };
  const sessions = { sessionList: [], applySnapshot: vi.fn(), beginInventoryCommit: vi.fn() };
  globalThis.window = { Pinia: { useSessionsStore: () => sessions }, dispatchEvent: vi.fn() };
  const auth = { ...createRaceAuthStore(), userId: 'owner-a', isAuthenticated: true };
  auth.$subscribe = vi.fn(callback => { auth.notify = callback; return vi.fn(); });
  const helpers = await loadWebsocketHelpers(auth);
  const store = helpers.useChatStore();
  store.scheduleReconnect = vi.fn();
  store.parseWsMessage = data => JSON.parse(data);
  store.requestYeaftSessionInventory = vi.fn();
  store.checkPendingRecovery = vi.fn();
  const deliver = (msg, socket = sockets.at(-1)) => socket.onmessage({ data: JSON.stringify(msg) });
  const open = (capability = 1, inventoryComplete = true, authFields = {}) => {
    helpers.connect(store);
    sockets.at(-1).readyState = globalThis.WebSocket.OPEN;
    sockets.at(-1).onopen();
    deliver({ type: 'auth_result', success: true,
      ...(capability === null ? {} : { sessionCatalogProtocol: capability }),
      yeaftSessionInventoryComplete: inventoryComplete,
      ...authFields,
    });
  };
  return { auth, store, sockets, sessions, deliver, open, helpers };
}

describe('native Session history and delete turn on reconnect', () => {
  it('recovers after a suspended socket stops responding, then revalidates inactive cached Session history on selection', async () => {
    const { store, sockets, open, deliver, helpers } = await lifecycleFixture();
    const page = new EventTarget();
    page.visibilityState = 'visible';
    vi.stubGlobal('document', page);
    vi.stubGlobal('window', Object.assign(new EventTarget(), globalThis.window));
    helpers.setupVisibilityHandler(store);
    const { yeaftHistoryIdentityKey: key } = await import('../../../web/stores/helpers/yeaft-history-identity.js');
    const agent = { id: 'a', online: true, capabilities: ['session_delete_turn'] };
    store.currentView = 'yeaft';
    store.currentAgent = 'a';
    store.yeaftConversationIdsByAgent = { a: 'conv' };
    store.loadOpenedYeaftSessionsForConnectedAgents = vi.fn();
    store.yeaftActiveSessionFilter = 'A';
    open(1, true, { yeaftSessionDeleteTurn: true });
    deliver({ type: 'agent_list', agents: [agent] });
    const requests = () => sockets.at(-1).sent.map(JSON.parse).filter(m => m.type === 'yeaft_load_history');
    const reply = (request, messages, identity) => deliver({ type: 'yeaft_history_chunk',
      agentId: 'a', conversationId: 'conv', sessionId: request.sessionId, requestId: request.requestId,
      mode: 'recent', messages, hasMore: false, ...identity,
    });
    reply(requests().at(-1), [{ id: 'm0001', role: 'user', content: 'Keep A' }],
      { latestSeq: 1, streamId: 'stream-A', revision: 1 });
    store.setActiveSessionFilter('B');
    reply(requests().at(-1), [{ id: 'm0002', role: 'user', content: 'Deleted elsewhere' }],
      { latestSeq: 2, streamId: 'stream-B', revision: 4 });
    const oldRequest = store.beginYeaftHistoryLoad({ agentId: 'a', sessionId: 'B', mode: 'older' });
    store.setActiveSessionFilter('A');

    vi.advanceTimersByTime(25_000);
    const oldProbe = sockets[0].sent.map(JSON.parse).findLast(m => m.type === 'ping');
    const setVisibility = state => {
      page.visibilityState = state;
      page.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('hidden');
    vi.advanceTimersByTime(120_000);
    expect(sockets[0].close).not.toHaveBeenCalled();
    setVisibility('visible');
    const freshProbe = sockets[0].sent.map(JSON.parse).findLast(m => m.type === 'ping');
    expect(freshProbe.probeId).not.toBe(oldProbe.probeId);
    deliver({ type: 'pong', probeId: oldProbe.probeId });
    expect(store.wsVerifying).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(sockets[0].close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sockets[0].close).toHaveBeenCalledExactlyOnceWith(4000, 'Heartbeat reply timeout');
    expect(store.ws).toBeNull();
    open(1, true, { yeaftSessionDeleteTurn: true });
    deliver({ type: 'agent_list', agents: [agent] });
    expect(requests().map(m => m.sessionId)).toEqual(['A']);
    expect(requests()[0]).toMatchObject({ afterSeq: 1, streamId: 'stream-A', revision: 1 });
    deliver({ type: 'yeaft_history_chunk', agentId: 'a', conversationId: 'conv', sessionId: 'A',
      requestId: requests()[0].requestId, mode: 'delta', messages: [], latestSeq: 1, streamId: 'stream-A', revision: 1 });

    // No deletion broadcast was received. B must not use a metadata-only load.
    store.setActiveSessionFilter('B');
    const validation = requests().at(-1);
    expect(validation).toMatchObject({ sessionId: 'B', afterSeq: 2, streamId: 'stream-B', revision: 4,
      requestId: expect.any(String) });
    const cachedTurn = store.messagesMap.conv.find(row => row.sessionId === 'B');
    expect(store.yeaftTurnDeleteUnavailable(store.yeaftTurnDeleteTarget(cachedTurn))).toBe('refreshing');
    reply({ sessionId: 'B', requestId: oldRequest.requestId }, [], { error: 'history_delivery_failed' });
    expect(store.yeaftSessionHistoryState[key('a', 'B')].requestId).toBe(validation.requestId);
    reply(validation, [], { mode: 'delta', error: 'history_payload_too_large', latestSeq: 900 });
    expect(store.yeaftHistoryLoadError).toBe('history_payload_too_large');
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftSessionHistoryState[key('a', 'B')]).toMatchObject({ loaded: true, latestSeq: 2, syncingAfterSeq: null, requestId: null });
    expect(store.messagesMap.conv).toContainEqual(cachedTurn);
    store.reloadYeaftMessages();
    reply(requests().at(-1), [], { streamId: 'stream-B', revision: 5 });
    expect(store.yeaftHistoryLoadError).toBeNull();
    expect(store.messagesMap.conv.map(row => row.id)).toEqual(['m0001']);
    expect(store.yeaftSessionHistoryState[key('a', 'B')]).toMatchObject({ loaded: true, revision: 5 });
    store.setActiveSessionFilter('A');
    store.setActiveSessionFilter('B');
    expect(requests().at(-1)).toMatchObject({ sessionId: 'B', limit: 0 });
  });

  it('does not send delete turn without both capability advertisements on the current socket', async () => {
    const { store, sockets, open, deliver } = await lifecycleFixture();
    const agent = { id: 'a', online: true, capabilities: ['session_delete_turn'] };
    const row = { id: 'm0001', messageId: 'm0001', type: 'user', sessionId: 's' };
    store.currentAgent = 'a';
    store.agents = [agent];
    store.yeaftConversationIdsByAgent = { a: 'conv' };
    store.messagesMap = { conv: [row] };
    open();
    store.currentView = 'yeaft';
    store.yeaftActiveSessionFilter = 's';
    const deleteTurn = () => store.deleteYeaftSessionTurn(store.yeaftTurnDeleteTarget(row));
    const mutations = () => sockets.flatMap(socket => socket.sent.map(JSON.parse)).filter(m => m.type === 'yeaft_session_delete_turn');
    expect(await deleteTurn()).toMatchObject({ ok: false, errorCode: 'unsupported' });
    deliver({ type: 'auth_result', success: true, yeaftSessionDeleteTurn: true });
    store.agents = [{ ...agent, capabilities: [] }, { ...agent, id: 'another-agent' }];
    expect(await deleteTurn()).toMatchObject({ ok: false, errorCode: 'unsupported' });
    expect(mutations()).toEqual([]);
    store.agents = [agent];
    const pending = deleteTurn();
    expect(mutations()).toHaveLength(1);
    sockets[0].onclose({ code: 1006, reason: 'network lost' });
    expect(await pending).toMatchObject({ ok: false, errorCode: 'unconfirmed' });

    open(); // The replacement Server speaks the old protocol.
    store.messagesMap = { conv: [row] };
    expect(store.yeaftTurnDeleteUnavailable(store.yeaftTurnDeleteTarget(row))).toBe('unsupported');
    expect(mutations()).toHaveLength(1);
  });
});
