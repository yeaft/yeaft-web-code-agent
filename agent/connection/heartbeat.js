import WebSocket from 'ws';
import ctx from '../context.js';
import { shouldReconnectForHeartbeat } from './heartbeat-policy.js';

const AGENT_HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_STALL_LOG_MS = 5000;

export function startAgentHeartbeat() {
  stopAgentHeartbeat();
  ctx.lastPongAt = Date.now();
  ctx.lastHeartbeatTickAt = Date.now();

  // 监听 pong 帧
  if (ctx.ws) {
    ctx.ws.on('pong', () => {
      ctx.lastPongAt = Date.now();
    });
  }

  ctx.agentHeartbeatTimer = setInterval(() => {
    if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) return;

    // 检查上次 pong 是否超时
    const now = Date.now();
    const timerDriftMs = Math.max(0, now - (ctx.lastHeartbeatTickAt || now) - AGENT_HEARTBEAT_INTERVAL_MS);
    ctx.lastHeartbeatTickAt = now;
    const sincePong = now - ctx.lastPongAt;
    if (timerDriftMs > HEARTBEAT_STALL_LOG_MS) {
      ctx.lastHeartbeatStallAt = now;
      ctx.lastHeartbeatStallMs = timerDriftMs;
      console.warn(`[Heartbeat] Agent event loop delayed heartbeat by ${Math.round(timerDriftMs)}ms; deferring reconnect`);
    }
    if (shouldReconnectForHeartbeat(ctx.lastPongAt, now, undefined, { timerDriftMs })) {
      console.warn(`[Heartbeat] No pong for ${Math.round(sincePong / 1000)}s, reconnecting...`);
      ctx.ws.terminate();
      return;
    }

    try {
      ctx.ws.ping();
    } catch (e) {
      console.warn('[Heartbeat] Failed to send ping:', e.message);
    }
  }, AGENT_HEARTBEAT_INTERVAL_MS);
}

export function stopAgentHeartbeat() {
  if (ctx.agentHeartbeatTimer) {
    clearInterval(ctx.agentHeartbeatTimer);
    ctx.agentHeartbeatTimer = null;
  }
}

export function scheduleReconnect(connectFn) {
  clearTimeout(ctx.reconnectTimer);
  ctx.reconnectTimer = setTimeout(() => {
    console.log('Attempting to reconnect...');
    connectFn();
  }, ctx.CONFIG.reconnectInterval);
}
