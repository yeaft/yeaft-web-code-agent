// WebSocket connection, heartbeat, reconnect helpers

import { useAuthStore } from '../auth.js';
import { encrypt, decrypt, isEncrypted } from '../../utils/encryption.js';
import { clearSessionLoading } from './session.js';

// Pending ensureConnected resolvers — settled by onopen/timeout
let _connectResolvers = [];

function _settleConnectResolvers(success) {
  const resolvers = _connectResolvers;
  _connectResolvers = [];
  for (const { resolve, reject, timer } of resolvers) {
    clearTimeout(timer);
    if (success) resolve();
    else reject(new Error('WebSocket reconnect failed'));
  }
}

export function sendWsMessage(store, msg) {
  if (!store.ws || store.ws.readyState !== WebSocket.OPEN) {
    console.warn('[WS] Cannot send, connection not open:', msg.type);
    return false;
  }

  try {
    if (store.sessionKey) {
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

  if (store.ws && store.ws.readyState === WebSocket.CONNECTING) {
    console.log('[WS] Already connecting, skip');
    return;
  }

  if (store.ws) {
    store.ws.onclose = null;
    store.ws.close();
    store.ws = null;
  }

  store.connectionState = store.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
  console.log(`[WS] Connecting... (attempt ${store.reconnectAttempts + 1})`);

  let wsUrl = `${protocol}//${location.host}?type=web`;
  if (authStore.token) {
    wsUrl += `&token=${encodeURIComponent(authStore.token)}`;
  }

  store.ws = new WebSocket(wsUrl);

  store.ws.onopen = () => {
    console.log('[WS] Connected');
    store.connectionState = 'connected';
    store.reconnectAttempts = 0;
    store.startHeartbeat();
    _settleConnectResolvers(true);
  };

  store.ws.onmessage = (event) => {
    const msg = store.parseWsMessage(event.data);
    if (msg) {
      if (msg.type === 'file_content') console.log('[WS.onmessage] Received file_content, path:', msg.filePath, 'contentLen:', msg.content?.length);
      store.handleMessage(msg);
    } else {
      console.warn('[WS.onmessage] parseWsMessage returned null, raw data length:', event.data?.length);
    }
  };

  store.ws.onclose = (event) => {
    console.log('[WS] Disconnected:', event.code, event.reason);
    store.authenticated = false;
    const wasUpdating = store.connectionState === 'updating';
    store.connectionState = wasUpdating ? 'updating' : 'disconnected';
    store.stopHeartbeat();
    clearSessionLoading(store);

    if (event.code === 1008) {
      console.log('[WS] Auth failure, clearing token and resetting auth state');
      localStorage.removeItem('authToken');
      authStore.reset();
      store.reconnectAttempts = 0;
      _settleConnectResolvers(false);
      return;
    }

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
