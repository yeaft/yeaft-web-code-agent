import WebSocket from 'ws';
import ctx from '../context.js';
import { sendToServer, parseMessage } from './buffer.js';
import { startAgentHeartbeat, stopAgentHeartbeat, scheduleReconnect } from './heartbeat.js';
import { handleMessage } from './message-router.js';
import { cleanupTerminalsForDisconnect } from '../terminal.js';

export function resetConnectionTransport() {
  ctx.sessionKey = null;
  ctx.serverEncryptionRequired = true;
  ctx.serverCapabilities = new Set();
  ctx.pendingAuthTempId = null;
}

export function connect(WebSocketImpl = WebSocket) {
  // Transport negotiation is connection-scoped. Always start conservatively;
  // only the registered frame from this socket may enable plaintext outbound.
  resetConnectionTransport();

  // Don't include secret in URL - it will be sent via WebSocket message after connection.
  // instanceId is the stable local service identity; agentName is display-only.
  // Old configs without instanceId still use agentName for backward-compatible identity.
  const instanceId = ctx.CONFIG.instanceId || ctx.CONFIG.agentName;
  const params = new URLSearchParams({
    type: 'agent',
    id: instanceId,
    name: ctx.CONFIG.agentName,
    instanceId,
    workDir: ctx.CONFIG.workDir,
    platform: process.platform,
    capabilities: ctx.agentCapabilities.join(',')
  });

  const url = `${ctx.CONFIG.serverUrl}?${params.toString()}`;
  console.log(`Connecting to server: ${ctx.CONFIG.serverUrl}`);
  if (ctx.CONFIG.disallowedTools.length > 0) {
    console.log(`Disallowed tools: ${ctx.CONFIG.disallowedTools.join(', ')}`);
  }

  const previousSocket = ctx.ws;
  const socket = new WebSocketImpl(url, {
    // Match server's permessage-deflate config (bounded memory,
    // skip compression for small frames). The `ws` library handles
    // streaming compression so we no longer need the synchronous
    // gzip-before-encrypt on the hot path.
    perMessageDeflate: {
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      threshold: 1024
    }
  });
  if (previousSocket && previousSocket !== socket) {
    const closedTerminals = cleanupTerminalsForDisconnect();
    if (closedTerminals > 0) {
      console.log(`[PTY] Closed ${closedTerminals} terminal(s) before Agent transport replacement`);
    }
    void ctx.browserRuntime?.handleTransportDisconnect?.();
  }
  ctx.ws = socket;

  socket.on('open', () => {
    if (socket !== ctx.ws) return;
    console.log('Connected to server, waiting for auth challenge...');
    clearTimeout(ctx.reconnectTimer);
    // 启动 agent 端心跳: 每 25 秒发一次 ping 帧
    startAgentHeartbeat();
  });

  socket.on('message', async (data) => {
    if (socket !== ctx.ws) return;
    // 收到任何消息都说明连接活着
    ctx.lastPongAt = Date.now();

    // Check for auth_required message (unencrypted)
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_required' && msg.tempId) {
        console.log('Received auth challenge, sending credentials...');
        ctx.pendingAuthTempId = msg.tempId;
        // Send the ordinary Agent credential via WebSocket (not URL).
        socket.send(JSON.stringify({
          type: 'auth',
          tempId: msg.tempId,
          secret: ctx.CONFIG.agentSecret,
          capabilities: ctx.agentCapabilities,
          version: ctx.agentVersion,
          platform: process.platform
        }));
        return;
      }
    } catch (e) {
      // Not JSON or parse error - continue to normal handling
    }

    const msg = await parseMessage(data);
    // Decryption can yield after a reconnect replaces this socket. Fence again
    // before a stale command can mutate Agent-local config or runtime state.
    if (socket !== ctx.ws) return;
    if (msg) {
      handleMessage(msg).catch(err => {
        console.error('[WS] handleMessage error:', err.message || err);
      });
    }
  });

  socket.on('close', (code, reason) => {
    if (socket !== ctx.ws) return;
    console.log(`Disconnected from server: ${code} ${reason}`);
    ctx.sessionKey = null;
    ctx.pendingAuthTempId = null;
    stopAgentHeartbeat();
    const closedTerminals = cleanupTerminalsForDisconnect();
    if (closedTerminals > 0) {
      console.log(`[PTY] Closed ${closedTerminals} terminal(s) after Agent transport disconnect`);
    }
    void ctx.browserRuntime?.handleTransportDisconnect?.();

    if (code === 1008) {
      console.error('Authentication failed. Check AGENT_SECRET configuration.');
      return;
    }

    scheduleReconnect(connect);
  });

  socket.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

// 注册 sendToServer 到 ctx 供其他模块使用
ctx.sendToServer = sendToServer;

// Re-export submodule functions for backward compatibility
export { sendToServer, flushMessageBuffer, parseMessage, BUFFERABLE_TYPES } from './buffer.js';
export { startAgentHeartbeat, stopAgentHeartbeat, scheduleReconnect } from './heartbeat.js';
export { handleMessage } from './message-router.js';
export { handleRestartAgent, handleUpgradeAgent } from './upgrade.js';
