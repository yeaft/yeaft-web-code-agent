// WebSocket connection, heartbeat, reconnect helpers

import { useAuthStore } from '../auth.js';
import { encrypt, decrypt, isEncrypted } from '../../utils/encryption.js';
import { clearSessionLoading } from './session.js';

// Pending ensureConnected resolvers — settled by onopen/timeout
let _connectResolvers = [];

function isAuthenticationClose(event) {
  return event?.code === 1008
    && String(event.reason || '').toLowerCase().includes('authentication');
}

function _settleConnectResolvers(success) {
  const resolvers = _connectResolvers;
  _connectResolvers = [];
  for (const { resolve, reject, timer } of resolvers) {
    clearTimeout(timer);
    if (success) resolve();
    else reject(new Error('WebSocket reconnect failed'));
  }
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

export function sendWsMessage(store, msg) {
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

/**
 * Ensure WebSocket is connected before sending.
 * - If already open: resolves immediately.
 * - If disconnected/reconnecting: triggers reconnect and waits for onopen (timeout 10s).
 */
export function ensureConnected(store, timeoutMs = 10000) {
  if (store.ws && store.ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  console.log('[WS] ensureConnected: not connected, triggering reconnect...');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _connectResolvers = _connectResolvers.filter(r => r.resolve !== resolve);
      reject(new Error('WebSocket reconnect timeout'));
    }, timeoutMs);

    _connectResolvers.push({ resolve, reject, timer });

    // Only trigger reconnect if not already connecting
    if (!store.ws || store.ws.readyState !== WebSocket.CONNECTING) {
      store.reconnectAttempts = 0;
      store.connect();
    }
  });
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

export function connect(store) {
  const authStore = useAuthStore();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (store.reconnectTimer) {
    clearTimeout(store.reconnectTimer);
    store.reconnectTimer = null;
  }

  const authToken = authStore.getActiveToken?.() || authStore.token || null;
  const authGeneration = authStore.authGeneration;

  if (store.ws && store.ws.readyState === WebSocket.CONNECTING
      && store._wsAuthToken === authToken && store._wsAuthGeneration === authGeneration) {
    console.log('[WS] Already connecting, skip');
    return;
  }

  // Agent and Session inventories belong to the socket that delivered them.
  // Invalidate both before replacing the socket so the UI cannot render a
  // stale empty/content state while the new authenticated snapshot is pending.
  clearTimeout(store._legacyYeaftSessionHydrateTimer);
  store._legacyYeaftSessionHydrateTimer = null;
  store._hasHandledAgentList = false;
  store._hasHandledYeaftSessionHydrate = false;
  store.yeaftSessionInventoryCompleteSupported = null;
  store.workbenchRouteProtocolSupported = null;
  store.yeaftSessionHydrateRequestId = null;
  store.yeaftSessionHydrateSlices = [];
  store.yeaftSessionHydrateError = null;
  store._yeaftSessionInventorySocketQuarantined = false;
  store.pendingAgentSelection = null;
  store.agentSwitching = false;

  if (store.ws) {
    store.ws.onopen = null;
    store.ws.onmessage = null;
    store.ws.onclose = null;
    store.ws.close();
    store.ws = null;
  }

  store.connectionState = store.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
  // Encryption and history request capabilities are connection-scoped. Start
  // every socket conservatively and cancel requests owned by the old socket;
  // reconnect catch-up will issue fresh requests after agent_list arrives.
  store.serverEncryptionRequired = true;
  store.chatHistoryRequestIdSupported = null;
  store.chatHistoryConnectionGeneration = Number(store.chatHistoryConnectionGeneration || 0) + 1;
  for (const [requestId, request] of Object.entries(store.projectMutationRequests || {})) {
    request?.resolve?.({
      ok: false,
      requestId,
      error: { code: 'connection_changed' },
    });
  }
  store.projectMutationRequests = {};
  store.sessionProjects = [];
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
  // Catalog support is a capability of the current Server connection. Reset
  // before every handshake so reconnecting to an older Server immediately
  // restores the legacy sidebar instead of showing a stale prior snapshot.
  store.sessionCatalogLoaded = false;
  store.sessionCatalog = [];
  store.hiddenSessionCatalog = [];
  store.activeCatalogKey = null;
  console.log(`[WS] Connecting... (attempt ${store.reconnectAttempts + 1})`);

  store._wsAuthToken = authToken;
  store._wsAuthGeneration = authGeneration;
  let wsUrl = `${protocol}//${location.host}?type=web`;
  if (authToken) {
    wsUrl += `&token=${encodeURIComponent(authToken)}`;
  }

  const socket = new WebSocket(wsUrl);
  store.ws = socket;

  socket.onopen = () => {
    if (socket !== store.ws) return;
    console.log('[WS] Connected');
    store.connectionState = 'connected';
    store.reconnectAttempts = 0;
    store.startHeartbeat();
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
        workbenchRouteProtocol: 1,
      }));
    } catch (e) {
      console.warn('[WS] Failed to send client_hello:', e);
    }
    _settleConnectResolvers(true);
  };

  socket.onmessage = (event) => {
    if (socket !== store.ws) return;
    const msg = store.parseWsMessage(event.data);
    if (msg) {
      if (msg.type === 'file_content') console.log('[WS.onmessage] Received file_content, path:', msg.filePath, 'contentLen:', msg.content?.length);
      store.handleMessage({ ...msg, _wsAuthToken: authToken, _wsAuthGeneration: authGeneration });
    } else {
      console.warn('[WS.onmessage] parseWsMessage returned null, raw data length:', event.data?.length);
    }
  };

  socket.onclose = (event) => {
    if (socket !== store.ws) {
      if (isAuthenticationClose(event)) authStore.handleAuthFailure?.(undefined, authToken, authGeneration);
      return;
    }
    console.log('[WS] Disconnected:', event.code, event.reason);
    store.authenticated = false;
    clearTimeout(store._legacyYeaftSessionHydrateTimer);
    store._legacyYeaftSessionHydrateTimer = null;
    store._hasHandledAgentList = false;
    store._hasHandledYeaftSessionHydrate = false;
    store.yeaftSessionInventoryCompleteSupported = null;
    store.workbenchRouteProtocolSupported = null;
    store.yeaftSessionHydrateRequestId = null;
    store.yeaftSessionHydrateSlices = [];
    store.yeaftSessionHydrateError = null;
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
      _settleConnectResolvers(false);
      return;
    }

    // Mark that the NEXT online agent_list (after reconnect) should run the
    // bounded Yeaft history and visible Work Center catch-up. The socket
    // genuinely dropped here, so the browser may have missed messages/events
    // while offline. handleAgentList consumes and clears this one-shot flag;
    // routine agent_list broadcasts leave it false and skip those requests.
    store._yeaftReconnectCatchUpPending = true;

    if (wasUpdating) {
      // Server is updating — fast reconnect with short interval
      store.reconnectAttempts = 0;
      store.reconnectTimer = setTimeout(() => {
        store.connect();
      }, 2000);
      return;
    }

    store.scheduleReconnect();
  };

  store.ws.onerror = (error) => {
    console.error('[WS] Error:', error);
  };
}

export function scheduleReconnect(store) {
  if (store.reconnectAttempts >= store.maxReconnectAttempts) {
    console.log('[WS] Max reconnect attempts reached, giving up');
    store.connectionState = 'disconnected';
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, store.reconnectAttempts), 30000);
  store.reconnectAttempts++;
  store.connectionState = 'reconnecting';

  console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt ${store.reconnectAttempts}/${store.maxReconnectAttempts})`);

  store.reconnectTimer = setTimeout(() => {
    store.connect();
  }, delay);
}

export function manualReconnect(store) {
  console.log('[WS] Manual reconnect triggered');
  store.reconnectAttempts = 0;
  store.connect();
}

export function startHeartbeat(store) {
  store.stopHeartbeat();
  store._lastPongAt = Date.now();
  store.heartbeatTimer = setInterval(() => {
    if (store.ws && store.ws.readyState === WebSocket.OPEN) {
      const sincePong = Date.now() - store._lastPongAt;
      if (sincePong > 45000) {
        console.warn(`[Heartbeat] No pong received for ${Math.round(sincePong / 1000)}s, reconnecting...`);
        store.ws.close(4000, 'Heartbeat timeout');
        return;
      }
      try {
        store.sendWsMessage({ type: 'ping' });
      } catch (e) {
        console.warn('[Heartbeat] Failed to send ping:', e);
      }
    }
  }, 25000);
}

export function stopHeartbeat(store) {
  if (store.heartbeatTimer) {
    clearInterval(store.heartbeatTimer);
    store.heartbeatTimer = null;
  }
}

/**
 * 监听页面可见性变化（移动端切换 APP 场景）
 * 切回前台时主动检查 WebSocket 连接，快速恢复状态
 */
export function setupVisibilityHandler(store) {
  if (store._visibilityHandlerInstalled) return;
  store._visibilityHandlerInstalled = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      console.log('[Visibility] Page became visible, checking connection...');

      if (!store.ws || store.ws.readyState !== WebSocket.OPEN) {
        // WebSocket 已断开，立即重连
        console.log('[Visibility] WebSocket not open, reconnecting immediately');
        store.reconnectAttempts = 0;
        store.connect();
      } else {
        // WebSocket 看起来还连着，发一个 ping 验证
        // 移动端浏览器切后台后 WebSocket 可能静默失效
        try {
          store.sendWsMessage({ type: 'ping' });
          // 如果 3 秒内没收到 pong，说明连接已死，重连
          const pongBefore = store._lastPongAt;
          setTimeout(() => {
            if (store._lastPongAt === pongBefore) {
              console.warn('[Visibility] No pong after resume, reconnecting...');
              if (store.ws) store.ws.close(4001, 'Visibility resume timeout');
            }
          }, 3000);
        } catch (e) {
          console.warn('[Visibility] Ping failed, reconnecting...', e);
          store.reconnectAttempts = 0;
          store.connect();
        }
      }
    }
  });
}
