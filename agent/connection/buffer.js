import WebSocket from 'ws';
import ctx from '../context.js';
import { encrypt, decrypt, isEncrypted } from '../encryption.js';

// 需要在断连期间缓冲的消息类型（CLI / Session 输出相关的关键消息）
export const BUFFERABLE_TYPES = new Set([
  'claude_output', 'yeaft_output', 'yeaft_session_output', 'session_output',
  'yeaft_history_chunk',
  'turn_completed', 'conversation_closed',
  'session_id_update', 'compact_status', 'slash_commands_update',
  'background_task_started', 'background_task_output',
  'subagent_started', 'subagent_message', 'subagent_completed',
  'crew_output', 'crew_status', 'crew_turn_completed',
  'crew_session_created', 'crew_session_restored', 'crew_human_needed',
  'crew_role_added', 'crew_role_removed',
  'crew_role_compact', 'crew_context_usage'
]);

function bufferMessage(msg, reason) {
  if (!BUFFERABLE_TYPES.has(msg.type)) {
    console.warn(`[WS] Cannot send message, WebSocket not open: ${msg.type}`);
    return;
  }
  if (ctx.messageBuffer.length < ctx.messageBufferMaxSize) {
    ctx.messageBuffer.push(msg);
    console.log(`[WS] ${reason}, buffered: ${msg.type} (queue: ${ctx.messageBuffer.length})`);
    return;
  }
  // Buffer full: drop oldest non-status messages to make room
  const dropIdx = ctx.messageBuffer.findIndex(m => m.type !== 'crew_status' && m.type !== 'turn_completed');
  if (dropIdx >= 0) {
    ctx.messageBuffer.splice(dropIdx, 1);
    ctx.messageBuffer.push(msg);
    console.warn(`[WS] Buffer full, dropped oldest to make room for: ${msg.type}`);
  } else {
    console.warn(`[WS] Buffer full (${ctx.messageBufferMaxSize}), dropping: ${msg.type}`);
  }
}

async function sendNow(msg) {
  if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) {
    bufferMessage(msg, 'Disconnected');
    return;
  }

  // feat-ws-plaintext-negotiation: encrypt only when the server has
  // NOT advertised plaintext acceptance. Defaults to encrypted for
  // back-compat with old servers; flipped to plaintext when the
  // `registered` frame includes `acceptPlaintext: true`.
  if (ctx.serverEncryptionRequired && ctx.sessionKey) {
    const encrypted = await encrypt(msg, ctx.sessionKey);
    ctx.ws.send(JSON.stringify(encrypted));
  } else {
    ctx.ws.send(JSON.stringify(msg));
  }
}

function scheduleOutboundDrain() {
  if (ctx.outboundSendQueueActive) return;
  ctx.outboundSendQueueActive = true;
  setImmediate(async () => {
    try {
      while (ctx.outboundSendQueue.length > 0) {
        const msg = ctx.outboundSendQueue.shift();
        try {
          await sendNow(msg);
        } catch (e) {
          console.error(`[WS] Error sending message ${msg?.type}:`, e.message);
          if (msg) bufferMessage(msg, 'Send failed');
        }
        // Yield between frames so ping/pong, inbound control messages and UI
        // events cannot be starved by a reconnect flush or a burst of tool output.
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally {
      ctx.outboundSendQueueActive = false;
      if (ctx.outboundSendQueue.length > 0) scheduleOutboundDrain();
    }
  });
}

// Send message to server (with encryption if available)
// 断连时对关键消息类型进行缓冲，重连后自动 flush
export async function sendToServer(msg) {
  if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) {
    bufferMessage(msg, 'Disconnected');
    return;
  }
  ctx.outboundSendQueue.push(msg);
  scheduleOutboundDrain();
}

// Flush 断连期间缓冲的消息
export async function flushMessageBuffer() {
  if (ctx.messageBuffer.length === 0) return;

  const buffered = ctx.messageBuffer.splice(0);
  console.log(`[WS] Flushing ${buffered.length} buffered messages...`);

  for (const msg of buffered) {
    await sendToServer(msg);
  }

  console.log(`[WS] Flush queued`);
}

// Parse incoming message (decrypt if encrypted)
export async function parseMessage(data) {
  try {
    const parsed = JSON.parse(data.toString());

    if (ctx.sessionKey && isEncrypted(parsed)) {
      return await decrypt(parsed, ctx.sessionKey);
    }

    return parsed;
  } catch (e) {
    console.error('Failed to parse message:', e);
    return null;
  }
}
