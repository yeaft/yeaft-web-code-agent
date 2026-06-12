import WebSocket from 'ws';
import ctx from '../context.js';
import { sendToServer, parseMessage } from './buffer.js';
import { startAgentHeartbeat, stopAgentHeartbeat, scheduleReconnect } from './heartbeat.js';
import { handleMessage } from './message-router.js';

export function connect() {
  // Don't include secret in URL - it will be sent via WebSocket message after connection
  // 使用 agentName 作为唯一标识（不再使用随机 UUID）
  const params = new URLSearchParams({
    type: 'agent',
    id: ctx.CONFIG.agentName,  // 直接用名称作为 ID
    name: ctx.CONFIG.agentName,
    workDir: ctx.CONFIG.workDir,
    capabilities: ctx.agentCapabilities.join(',')
  });

  const url = `${ctx.CONFIG.serverUrl}?${params.toString()}`;
  console.log(`Connecting to server: ${ctx.CONFIG.serverUrl}`);
  if (ctx.CONFIG.disallowedTools.length > 0) {
    console.log(`Disallowed tools: ${ctx.CONFIG.disallowedTools.join(', ')}`);
  }

  ctx.ws = new WebSocket(url, {
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

  ctx.ws.on('open', () => {
    console.log('Connected to server, waiting for auth challenge...');
    clearTimeout(ctx.reconnectTimer);
    // 启动 agent 端心跳: 每 25 秒发一次 ping 帧
    startAgentHeartbeat();
  });

  ctx.ws.on('message', async (data) => {
    // 收到任何消息都说明连接活着
    ctx.lastPongAt = Date.now();

    // Check for auth_required message (unencrypted)
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_required' && msg.tempId) {
        console.log('Received auth challenge, sending credentials...');
        ctx.pendingAuthTempId = msg.tempId;
        // Send authentication via WebSocket (not URL)
        ctx.ws.send(JSON.stringify({
          type: 'auth',
          tempId: msg.tempId,
          secret: ctx.CONFIG.agentSecret,
          capabilities: ctx.agentCapabilities,
          version: ctx.agentVersion
        }));
        return;
      }
    } catch (e) {
      // Not JSON or parse error - continue to normal handling
    }

    const msg = await parseMessage(data);
    if (msg) {
      handleMessage(msg).catch(err => {
        console.error('[WS] handleMessage error:', err.message || err);
      });
    }
  });

  ctx.ws.on('close', (code, reason) => {
    console.log(`Disconnected from server: ${code} ${reason}`);
    ctx.sessionKey = null;
    ctx.pendingAuthTempId = null;
    stopAgentHeartbeat();

    if (code === 1008) {
      console.error('Authentication failed. Check AGENT_SECRET configuration.');
      return;
    }

    scheduleReconnect(connect);
  });

  ctx.ws.on('error', (err) => {
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
