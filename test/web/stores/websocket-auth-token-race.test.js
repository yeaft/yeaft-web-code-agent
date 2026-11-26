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
    static CLOSING = 2;
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
    open(1, true, { yeaftSessionDeleteTurn: true, webHeartbeatProbeProtocol: 1 });
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
    deliver({ type: 'pong' });
    expect(store.wsVerifying).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(sockets[0].close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sockets[0].close).toHaveBeenCalledExactlyOnceWith(4000, 'Heartbeat reply timeout');
    expect(store.ws).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1].readyState = WebSocket.OPEN;
    sockets[1].onopen();
    deliver({ type: 'auth_result', success: true, webHeartbeatProbeProtocol: 1, yeaftSessionInventoryComplete: true, yeaftSessionDeleteTurn: true, sessionCatalogProtocol: 1 });
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
    reply({ sessionId: 'B', requestId: 'stale-B-request' }, [], { error: 'history_delivery_failed' });
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
    store.setActiveSessionFilter('A');
    setVisibility('hidden');
    sockets[1].readyState = WebSocket.CLOSING;
    const lateClose = sockets[1].onclose;
    setVisibility('visible');
    expect(sockets).toHaveLength(3);
    expect(store._yeaftReconnectCatchUpPending).toBe(true);
    lateClose({ code: 1006 });
    expect(store.ws).toBe(sockets[2]);
    sockets[2].readyState = WebSocket.OPEN;
    sockets[2].onopen();
    deliver({ type: 'auth_result', success: true });
    deliver({ type: 'agent_list', agents: [agent] });
    expect(requests()).toContainEqual(expect.objectContaining({ sessionId: 'A', afterSeq: 1 }));
    setVisibility('hidden');
    setVisibility('visible');
    expect(sockets[2].close).toHaveBeenCalledExactlyOnceWith(4001, 'Reconnect to verify legacy WebSocket');
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

  it('buffers transient disconnect, offline, and wake verification notices behind the grace window', async () => {
    const { store, sockets, open, deliver, helpers, auth } = await lifecycleFixture();
    const page = new EventTarget();
    page.visibilityState = 'visible';
    vi.stubGlobal('document', page);
    const win = Object.assign(new EventTarget(), { Pinia: globalThis.window.Pinia });
    vi.stubGlobal('window', win);
    let online = true;
    vi.stubGlobal('navigator', { get onLine() { return online; } });
    helpers.setupVisibilityHandler(store);

    const graceMs = helpers.CONNECTION_NOTICE_GRACE_MS;
    expect(graceMs).toBe(2000);

    // 1. Sub-grace auto-reconnect (e.g. mobile Wi-Fi <-> 5G switch in ~1.2s) never shows the notice.
    open(1, true, { webHeartbeatProbeProtocol: 1 });
    expect(store.connectionNoticeVisible).toBe(false);
    sockets[0].onclose({ code: 1006, reason: '' });
    expect(store.connectionState).toBe('reconnecting');
    expect(store.connectionNoticeVisible).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    expect(store.connectionNoticeVisible).toBe(false);
    vi.advanceTimersByTime(500);
    expect(store.connectionNoticeVisible).toBe(false);
    sockets[1].readyState = WebSocket.OPEN;
    sockets[1].onopen();
    deliver({ type: 'auth_result', success: true, webHeartbeatProbeProtocol: 1 });
    expect(store.connectionState).toBe('connected');
    expect(store.authenticated).toBe(true);
    expect(store.connectionNoticeVisible).toBe(false);
    vi.advanceTimersByTime(graceMs);
    expect(store.connectionNoticeVisible).toBe(false);

    // 2. Brief offline -> online blip (< graceMs) stays silent; prolonged disconnect reveals at exact graceMs without resetting across phases.
    online = false;
    win.dispatchEvent(new Event('offline'));
    expect(store.networkOffline).toBe(true);
    expect(store.connectionNoticeVisible).toBe(false);
    vi.advanceTimersByTime(600);
    online = true;
    win.dispatchEvent(new Event('online'));
    expect(store.wsVerifying).toBe(true);
    expect(store.connectionNoticeVisible).toBe(false);
    const onlineProbe = sockets[1].sent.map(JSON.parse).findLast(m => m.type === 'ping');
    deliver({ type: 'pong', probeId: onlineProbe.probeId });
    expect(store.wsVerifying).toBe(false);
    expect(store.connectionNoticeVisible).toBe(false);
    vi.advanceTimersByTime(graceMs);
    expect(store.connectionNoticeVisible).toBe(false);

    // Prolonged drop: clock starts at onclose and is NOT reset when connect() runs at ~1000ms.
    sockets[1].onclose({ code: 1006, reason: '' });
    vi.advanceTimersByTime(graceMs - 1);
    expect(sockets).toHaveLength(3);
    expect(store.connectionNoticeVisible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(store.connectionNoticeVisible).toBe(true);
    // Auth completion clears the visible notice immediately.
    sockets[2].readyState = WebSocket.OPEN;
    sockets[2].onopen();
    deliver({ type: 'auth_result', success: true, webHeartbeatProbeProtocol: 1 });
    expect(store.connectionNoticeVisible).toBe(false);

    // 3. Explicit send attempt during grace window reveals notice immediately; no-op when healthy.
    store.revealConnectionNotice();
    expect(store.connectionNoticeVisible).toBe(false);
    sockets[2].onclose({ code: 1006, reason: '' });
    expect(store.connectionNoticeVisible).toBe(false);
    store.revealConnectionNotice();
    expect(store.connectionNoticeVisible).toBe(true);

    // 4. Returning from background while online gives a fresh grace window; returning while still offline keeps visible notice.
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    online = false;
    store.networkOffline = true;
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(store.connectionNoticeVisible).toBe(true);

    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    online = true;
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(store.connectionNoticeVisible).toBe(false);
    expect(sockets).toHaveLength(4);
    sockets[3].readyState = WebSocket.OPEN;
    sockets[3].onopen();
    deliver({ type: 'auth_result', success: true, webHeartbeatProbeProtocol: 1 });
    expect(store.connectionNoticeVisible).toBe(false);

    // 5. Server updating and exhausted reconnects reveal immediately.
    deliver({ type: 'server_updating' });
    expect(store.connectionState).toBe('updating');
    expect(store.connectionNoticeVisible).toBe(true);
    open(1, true, { webHeartbeatProbeProtocol: 1 });
    expect(store.connectionNoticeVisible).toBe(false);
    store.reconnectAttempts = store.maxReconnectAttempts;
    sockets.at(-1).onclose({ code: 1006, reason: '' });
    expect(store.connectionState).toBe('disconnected');
    expect(store.connectionNoticeVisible).toBe(true);

    // 6. Auth loss (1008) and logout clear pending notice state and timers.
    open(1, true, { webHeartbeatProbeProtocol: 1 });
    auth.handleAuthFailure = vi.fn(() => { auth.isAuthenticated = false; });
    sockets.at(-1).onclose({ code: 1008, reason: 'Authentication required' });
    expect(store.connectionNoticeVisible).toBe(false);
    vi.advanceTimersByTime(graceMs * 2);
    expect(store.connectionNoticeVisible).toBe(false);

    auth.isAuthenticated = true;
    auth.logout = vi.fn(() => { auth.isAuthenticated = false; });
    open(1, true, { webHeartbeatProbeProtocol: 1 });
    sockets.at(-1).onclose({ code: 1006, reason: '' });
    expect(store.connectionNoticeVisible).toBe(false);
    store.logout();
    vi.advanceTimersByTime(graceMs * 2);
    expect(store.connectionNoticeVisible).toBe(false);
  });
});
