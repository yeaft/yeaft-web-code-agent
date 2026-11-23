// WebSocket connection, heartbeat, reconnect helpers

import { useAuthStore } from '../auth.js';
import { encrypt, decrypt, isEncrypted } from '../../utils/encryption.js';
import { clearSessionLoading } from './session.js';
import { interruptYeaftHistoryLoads } from './yeaft-history-load.js';
import { bindScheduledTaskNotificationOwner } from './scheduled-tasks.js';
import {
  sidebarCatalogAuthIsCurrent,
  sidebarSessionCatalogRows,
} from './sidebar-session-catalog.js';

function clearSidebarSessionCatalog(store) {
  store.sessionCatalog = [];
  store.hiddenSessionCatalog = [];
  store.sessionProjects = [];
  store.activeCatalogKey = null;
  store.sidebarLegacySessionCatalog = [];
  store.sessionCatalogLoaded = false;
  store.sessionCatalogProtocolSupported = null;
  store.scheduledTaskProtocolSupported = false;
  store.scheduledTaskReceiptProtocolSupported = false;
}

const CONNECT_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_REPLY_TIMEOUT_MS = 10_000;
const TIMER_STALL_GRACE_MS = 5_000;

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function isVisible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function clearReconnectTimer(store) {
  clearTimeout(store.reconnectTimer);
  store.reconnectTimer = null;
}

function notifyBrowserTransportReset() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function'
      || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent('browser-runtime-transport-reset'));
}

function isAuthenticationClose(event) {
  return event?.code === 1008
    && String(event.reason || '').toLowerCase().includes('authentication');
}

// Message types that operate on server-backed conversations (sessionDb).
// Yeaft uses a purely client-side virtual conversationId ('yeaft-<ts>') that has
// no server-side state, so sending these in Yeaft view triggers
// verifyConversationOwnership → 'Permission denied' replies.
// Guard: silently skip these when currentView === 'yeaft'.
const YEAFT_INCOMPATIBLE_TYPES = new Set([
  'sync_messages',
  'refresh_conversation',
  'select_conversation',
  'cancel_execution',
  'update_conversation_settings',
  'ask_user_answer',
]);

// User messages cannot safely be queued on a socket under verification.
const USER_MESSAGE_TYPES = new Set(['chat', 'yeaft_session_send', 'btw_question']);

export function sendWsMessage(store, msg) {
  if (USER_MESSAGE_TYPES.has(msg.type) && (!isOnline() || store.wsVerifying || !store.authenticated)) return false;
  if (!store.ws || store.ws.readyState !== WebSocket.OPEN) {
    console.warn('[WS] Cannot send, connection not open:', msg.type);
    return false;
  }

  // A: Short-circuit server-sync messages while in Yeaft view. These
  // operate on server-registered conversations; Yeaft's virtual id has
  // no DB row and would produce 'Permission denied' noise.
  if (store.currentView === 'yeaft' && YEAFT_INCOMPATIBLE_TYPES.has(msg.type)) {
    const convId = msg.conversationId;
    if (!convId || (typeof convId === 'string' && convId.startsWith('yeaft-')) || convId === store.yeaftConversationId) {
      return false;
    }
  }

  try {
    // feat-ws-plaintext-negotiation: plaintext path is the default for
    // new servers that announced acceptPlaintext in auth_result. Falls
    // back to encrypted for old servers — store.serverEncryptionRequired
    // stays `true` until the server tells us otherwise. The receive path
    // (parseWsMessage) is unconditional and continues to decrypt
    // ciphertext from an old server.
    if (store.serverEncryptionRequired && store.sessionKey) {
      const encrypted = encrypt(msg, store.sessionKey);
      store.ws.send(JSON.stringify(encrypted));
    } else {
      store.ws.send(JSON.stringify(msg));
    }
    return true;
  } catch (e) {
    console.error('[WS] Failed to send message:', msg.type, e);
    return false;
  }
}

export function parseWsMessage(store, data) {
  try {
    const parsed = JSON.parse(data);

    if (store.sessionKey && isEncrypted(parsed)) {
      return decrypt(parsed, store.sessionKey);
    }

    return parsed;
  } catch (e) {
    console.error('Failed to parse message:', e);
    return null;
  }
}

function settleSessionCrudForConnection(store, connectionGeneration, code, message) {
  for (const [requestId, pending] of store._sessionCrudPending?.entries?.() || []) {
    if (Number(pending?.connectionGeneration || 0) !== Number(connectionGeneration || 0)) continue;
    pending.resolve?.({ ok: false, requestId, receiptInterrupted: true, error: { code, message } });
    store._sessionCrudPending.delete(requestId);
  }
}

export function connect(store) {
  const authStore = useAuthStore();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  clearReconnectTimer(store);
  store.networkOffline = !isOnline();
  if (store.networkOffline) {
    store.connectionState = 'disconnected';
    return;
  }

  const authToken = authStore.getActiveToken?.() || authStore.token || null;
  const authGeneration = authStore.authGeneration;
  const authOwnerId = authStore.userId || null;
  bindScheduledTaskNotificationOwner(store, authOwnerId || (authStore.skipAuth ? 'local' : null));

  if (store.ws && store.ws.readyState === WebSocket.CONNECTING
      && Date.now() - store._wsConnectStartedAt < CONNECT_TIMEOUT_MS
      && store._wsAuthToken === authToken && store._wsAuthGeneration === authGeneration
      && store.sidebarCatalogOwnerId === authOwnerId) {
    console.log('[WS] Already connecting, skip');
    return;
  }

  // Retention belongs to the authentication identity, not its renewable token.
  const retainCatalog = sidebarCatalogAuthIsCurrent(store, authStore);
  if (retainCatalog && store.sessionCatalogProtocolSupported === false) {
    store.sidebarLegacySessionCatalog = sidebarSessionCatalogRows(
      store,
      typeof window !== 'undefined'
        ? (window.Pinia?.useSessionsStore?.() || window.__useSessionsStore?.())?.sessionList || []
        : [],
    ).map(row => ({ ...row }));
  } else if (!retainCatalog || store.sessionCatalogProtocolSupported === true) {
    store.sidebarLegacySessionCatalog = [];
  }
  if (!store._sidebarCatalogAuthUnsubscribe && authStore.$subscribe) {
    store._sidebarCatalogAuthUnsubscribe = authStore.$subscribe(() => {
      if (!sidebarCatalogAuthIsCurrent(store, authStore)) {
        clearSidebarSessionCatalog(store);
        bindScheduledTaskNotificationOwner(store, authStore.userId || (authStore.skipAuth ? 'local' : null));
        store.sessionCatalogMutationRequests = {};
      }
    }, { detached: true, flush: 'sync' });
  }

  // Agent and Session inventories belong to the socket that delivered them.
  // Invalidate both before replacing the socket so the UI cannot render a
  // stale empty/content state while the new authenticated snapshot is pending.
  clearTimeout(store._legacyYeaftSessionHydrateTimer);
  store._legacyYeaftSessionHydrateTimer = null;
  store._hasHandledAgentList = false;
  store._hasHandledYeaftSessionHydrate = false;
  store.yeaftSessionInventoryCompleteSupported = null;
  store.yeaftSessionDeleteTurnSupported = false;
  store.workbenchRouteProtocolSupported = null;
  store.workCenterWorkbenchProtocolSupported = null;
  store.browserRuntimeProtocolSupported = null;
  store.browserRuntimeSetupProtocolSupported = null;
  store.browserRuntimeServerEnabled = false;
  notifyBrowserTransportReset();
  store.yeaftSessionHydrateRequestId = null;
  store.yeaftSessionHydrateSlices = [];
  store.yeaftSessionHydrateConfigDeltas = null;
  store.yeaftSessionHydrateError = null;
  store._yeaftSessionInventorySocketQuarantined = false;
  store.pendingAgentSelection = null;
  store.agentSwitching = false;

  store.stopHeartbeat();
  clearTimeout(store._wsConnectTimer);
  store._wsConnectTimer = null;
  if (store.ws) {
    store.interruptYeaftTurnDeletions?.();
    settleSessionCrudForConnection(
      store,
      store.chatHistoryConnectionGeneration,
      'connection_changed',
      'WebSocket connection changed',
    );
    store.ws.onopen = null;
    store.ws.onmessage = null;
    store.ws.onclose = null;
    store.ws.close();
    store.ws = null;
  }

  store.authenticated = false;
  store.connectionState = store.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
  // Encryption and history request capabilities are connection-scoped. Start
  // every socket conservatively and cancel requests owned by the old socket;
  // reconnect catch-up will issue fresh requests after agent_list arrives.
  store.serverEncryptionRequired = true;
  store.chatHistoryRequestIdSupported = null;
  const connectionGeneration = Number(store.chatHistoryConnectionGeneration || 0) + 1;
  store.chatHistoryConnectionGeneration = connectionGeneration;
  interruptYeaftHistoryLoads(store);
  for (const [requestId, request] of Object.entries(store.projectMutationRequests || {})) {
    request?.resolve?.({
      ok: false,
      requestId,
      error: { code: 'connection_changed' },
    });
  }
  store.projectMutationRequests = {};
  if (!retainCatalog) store.sessionProjects = [];
  for (const [catalogKey, request] of Object.entries(store.chatHistoryRequests || {})) {
    if (!request?.loading) continue;
    store.chatHistoryRequests[catalogKey] = {
      ...request,
      loading: false,
      cancelled: true,
      error: 'connection_changed',
    };
  }
  const pendingCatalogMutations = Object.values(store.sessionCatalogMutationRequests || {});
  if (pendingCatalogMutations.length > 0) {
    store.sessionCatalog = pendingCatalogMutations[0].previousCatalog;
    if (Array.isArray(pendingCatalogMutations[0].previousHiddenCatalog)) {
      store.hiddenSessionCatalog = pendingCatalogMutations[0].previousHiddenCatalog;
    }
    store.sessionCatalogMutationRequests = {};
  }
  // Roll back optimistic writes before retaining the read-only prior snapshot.
  store.sessionCatalogLoaded = false;
  store.sessionCatalogProtocolSupported = null;
  store.scheduledTaskProtocolSupported = false;
  store.scheduledTaskReceiptProtocolSupported = false;
  if (!retainCatalog) {
    clearSidebarSessionCatalog(store);
  }
  store.sidebarCatalogOwnerId = authOwnerId;
  store.sidebarCatalogAuthGeneration = authGeneration;
  console.log(`[WS] Connecting... (attempt ${store.reconnectAttempts + 1})`);

  store._wsAuthToken = authToken;
  store._wsAuthGeneration = authGeneration;
  let wsUrl = `${protocol}//${location.host}?type=web`;
  if (authToken) {
    wsUrl += `&token=${encodeURIComponent(authToken)}`;
  }

  const socket = new WebSocket(wsUrl);
  store.ws = socket;
  store._wsConnectStartedAt = Date.now();
  store._wsConnectTimer = setTimeout(() => {
    if (socket === store.ws && socket.readyState === WebSocket.CONNECTING) {
      expireSocket(store, socket, 4002, 'WebSocket upgrade timeout');
    }
  }, CONNECT_TIMEOUT_MS);

  socket.onopen = () => {
    if (socket !== store.ws) return;
    clearTimeout(store._wsConnectTimer);
    store._wsConnectTimer = null;
    console.log('[WS] Connected');
    store.connectionState = 'connected';
    store._wsConnectTimer = setTimeout(() => {
      expireSocket(store, socket, 4002, 'WebSocket authentication response timeout');
    }, CONNECT_TIMEOUT_MS);
    // feat-ws-plaintext-negotiation: capability handshake. Tell the
    // server we're a new client that can accept plaintext outbound.
    // New server flips per-client `encryptOutbound = false` so future
    // frames to us are plain JSON (visible in DevTools, no per-frame
    // CPU cost). Old server doesn't recognise the `client_hello` type
    // and ignores it harmlessly. Sent in plaintext before the session
    // key arrives — the receive path stays unconditional (decrypt iff
    // the frame looks encrypted), so the handshake ordering is benign.
    try {
      socket.send(JSON.stringify({
        type: 'client_hello',
        plaintextOk: true,
        sessionCatalogProtocol: 1,
        workbenchRouteProtocol: 1,
        workCenterWorkbenchProtocol: 1,
        browserRuntimeProtocol: 1,
        browserRuntimeSetupProtocol: 1,
      }));
    } catch (e) {
      console.warn('[WS] Failed to send client_hello:', e);
    }
  };

  socket.onmessage = (event) => {
    if (socket !== store.ws) return;
    const msg = store.parseWsMessage(event.data);
    if (msg && (authGeneration !== authStore.authGeneration
        || authOwnerId !== (authStore.userId || null))
        && !(msg.type === 'auth_result' && msg.success === false)) {
      clearSidebarSessionCatalog(store);
      return;
    }
    if (msg) {
      if (msg.type === 'pong') {
        // Pre-upgrade servers don't echo the probe id. A new server's pong
        // from before suspension must not confirm the post-resume probe.
        if (msg.probeId == null || msg.probeId === store._wsProbeId) clearHeartbeatProbe(store);
        return;
      }
      if (msg.type === 'auth_result' && msg.success === true) {
        clearTimeout(store._wsConnectTimer);
        store._wsConnectTimer = null;
        store.reconnectAttempts = 0;
        store.startHeartbeat();
      }
      if (msg.type === 'file_content') console.log('[WS.onmessage] Received file_content, path:', msg.filePath, 'contentLen:', msg.content?.length);
      store.handleMessage({ ...msg, _wsAuthToken: authToken, _wsAuthGeneration: authGeneration, _wsAuthOwnerId: authOwnerId });
    } else {
      console.warn('[WS.onmessage] parseWsMessage returned null, raw data length:', event.data?.length);
    }
  };

  socket.onclose = (event) => {
    if (socket !== store.ws) {
      if (isAuthenticationClose(event)) authStore.handleAuthFailure?.(undefined, authToken, authGeneration);
      return;
    }
    clearTimeout(store._wsConnectTimer);
    store._wsConnectTimer = null;
    store.ws = null;
    console.log('[WS] Disconnected:', event.code, event.reason);
    store.interruptYeaftTurnDeletions?.();
    store.authenticated = false;
    store.yeaftSessionDeleteTurnSupported = false;
    if (store.sessionCatalogProtocolSupported === false) {
      store.sidebarLegacySessionCatalog = sidebarSessionCatalogRows(
        store,
        typeof window !== 'undefined'
          ? (window.Pinia?.useSessionsStore?.() || window.__useSessionsStore?.())?.sessionList || []
          : [],
      ).map(row => ({ ...row }));
    }
    store.sessionCatalogLoaded = false;
    if (!sidebarCatalogAuthIsCurrent(store, authStore)) clearSidebarSessionCatalog(store);
    clearTimeout(store._legacyYeaftSessionHydrateTimer);
    store._legacyYeaftSessionHydrateTimer = null;
    store._hasHandledAgentList = false;
    store._hasHandledYeaftSessionHydrate = false;
    store.yeaftSessionInventoryCompleteSupported = null;
    store.workbenchRouteProtocolSupported = null;
    store.workCenterWorkbenchProtocolSupported = null;
    store.browserRuntimeProtocolSupported = null;
    store.browserRuntimeSetupProtocolSupported = null;
    store.browserRuntimeServerEnabled = false;
    notifyBrowserTransportReset();
    store.yeaftSessionHydrateRequestId = null;
    store.yeaftSessionHydrateSlices = [];
    store.yeaftSessionHydrateConfigDeltas = null;
    store.yeaftSessionHydrateError = null;
    for (const pending of Object.values(store._workCenterFeaturePending || {})) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebSocket disconnected'));
    }
    store._workCenterFeaturePending = {};
    settleSessionCrudForConnection(
      store,
      connectionGeneration,
      'agent_offline',
      'WebSocket disconnected',
    );
    store.pendingAgentSelection = null;
    store.agentSwitching = false;
    const wasUpdating = store.connectionState === 'updating';
    store.connectionState = wasUpdating ? 'updating' : 'disconnected';
    store.stopHeartbeat();
    clearSessionLoading(store);

    if (isAuthenticationClose(event)) {
      console.log('[WS] Auth failure, clearing token and resetting auth state');
      authStore.handleAuthFailure?.(undefined, authToken, authGeneration);
      store.reconnectAttempts = 0;
      return;
    }

    // Mark that the NEXT online agent_list (after reconnect) should run the
    // bounded Yeaft history and visible Work Center catch-up. The socket
    // genuinely dropped here, so the browser may have missed messages/events
    // while offline. handleAgentList consumes and clears this one-shot flag;
    // routine agent_list broadcasts leave it false and skip those requests.
    store._yeaftReconnectCatchUpPending = true;

    store.scheduleReconnect(wasUpdating ? 2000 : undefined);
  };

  store.ws.onerror = (error) => {
    console.error('[WS] Error:', error);
  };
}

export function scheduleReconnect(store, fastDelay) {
  clearReconnectTimer(store);
  if (!useAuthStore().isAuthenticated || !isOnline() || !isVisible()
      || store.reconnectAttempts >= store.maxReconnectAttempts) {
    store.connectionState = 'disconnected';
    return;
  }

  const baseDelay = fastDelay ?? Math.min(1000 * 2 ** store.reconnectAttempts, 30000);
  const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.2));
  if (fastDelay == null) {
    store.reconnectAttempts++;
    store.connectionState = 'reconnecting';
    console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt ${store.reconnectAttempts}/${store.maxReconnectAttempts})`);
  }

  store.reconnectTimer = setTimeout(() => {
    store.reconnectTimer = null;
    if (useAuthStore().isAuthenticated && isOnline() && isVisible()) store.connect();
    else store.connectionState = 'disconnected';
  }, delay);
}

export function manualReconnect(store) {
  store.reconnectAttempts = 0;
  store.connect();
}

function expireSocket(store, socket, code, reason) {
  if (socket !== store.ws) return;
  // Don't wait for the close handshake on an already unresponsive connection.
  // Use the ordinary close path so history/receipts are invalidated exactly once.
  const onClose = socket.onclose;
  socket.onclose = null;
  socket.close(code, reason);
  onClose?.({ code, reason });
}

function clearHeartbeatProbe(store) {
  clearTimeout(store._wsProbeTimer);
  store._wsProbeTimer = null;
  store.wsVerifying = false;
}

function probeSocket(store, socket, verifying = false) {
  if (socket !== store.ws || socket?.readyState !== WebSocket.OPEN || !isVisible() || !isOnline()) return;
  if (verifying) store.wsVerifying = true;
  // Coalesce pageshow, visibilitychange, online and periodic ticks on one socket.
  if (store._wsProbeTimer != null) return;
  const probeId = (store._wsProbeId = (store._wsProbeId || 0) + 1);
  if (!store.sendWsMessage({ type: 'ping', probeId })) {
    expireSocket(store, socket, 4000, 'Heartbeat send failed');
    return;
  }
  const deadline = Date.now() + HEARTBEAT_REPLY_TIMEOUT_MS;
  store._wsProbeTimer = setTimeout(() => {
    if (socket !== store.ws) return;
    store._wsProbeTimer = null;
    if (!isVisible() || !isOnline()) return;
    // A suspended page (or blocked main thread) cannot run the timer or
    // dispatch an incoming pong. After a delayed tick, use a fresh deadline.
    if (Date.now() - deadline > TIMER_STALL_GRACE_MS) {
      probeSocket(store, socket, true);
      return;
    }
    expireSocket(store, socket, 4000, 'Heartbeat reply timeout');
  }, HEARTBEAT_REPLY_TIMEOUT_MS);
}

export function startHeartbeat(store) {
  const socket = store.ws;
  if (store.heartbeatTimer != null || !isVisible() || !isOnline()) return;
  let lastTick = Date.now();
  store.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    probeSocket(store, socket, now - lastTick > HEARTBEAT_INTERVAL_MS + TIMER_STALL_GRACE_MS);
    lastTick = now;
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(store) {
  clearInterval(store.heartbeatTimer);
  store.heartbeatTimer = null;
  clearHeartbeatProbe(store);
}

/** Recover after a mobile suspend, network change or back/forward-cache restore. */
export function setupVisibilityHandler(store) {
  if (store._visibilityHandlerInstalled) return;
  store._visibilityHandlerInstalled = true;
  store.networkOffline = !isOnline();

  const suspend = () => {
    store.stopHeartbeat();
    if (store.reconnectTimer != null) {
      clearReconnectTimer(store);
      store.connectionState = 'disconnected';
    }
  };
  const resume = () => {
    store.networkOffline = !isOnline();
    const auth = useAuthStore();
    if (store.networkOffline || !isVisible() || !auth.isAuthenticated) return;
    if (store._wsAuthGeneration !== auth.authGeneration || store.sidebarCatalogOwnerId !== (auth.userId || null)) {
      store.manualReconnect();
    } else if (store.ws?.readyState === WebSocket.OPEN) {
      if (store.authenticated) {
        store.startHeartbeat();
        probeSocket(store, store.ws, true);
      }
    } else if (store.ws?.readyState !== WebSocket.CONNECTING
        || Date.now() - store._wsConnectStartedAt >= CONNECT_TIMEOUT_MS) {
      store.manualReconnect();
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (isVisible()) {
      store.markVisibleScheduledTaskSessionRead?.();
      resume();
    } else suspend();
  });
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', event => { if (event.persisted) resume(); });
  window.addEventListener('offline', () => {
    store.networkOffline = true;
    suspend();
  });
  window.addEventListener('online', resume);
}
