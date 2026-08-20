import WebSocket from 'ws';
import ctx from '../context.js';
import { encrypt, decrypt, isEncrypted } from '../encryption.js';

export const BUFFERABLE_TYPES = new Set([
  'claude_output', 'yeaft_output', 'yeaft_session_output', 'session_output',
  'yeaft_history_chunk',
  'turn_completed', 'conversation_closed',
  'session_id_update', 'compact_status', 'slash_commands_update',
  'background_task_started', 'background_task_output',
  'subagent_started', 'subagent_message', 'subagent_completed',
  'work_center_event'
]);

function messageBytes(msg) {
  try { return Buffer.byteLength(JSON.stringify(msg), 'utf8'); }
  catch { return 0; }
}

const TERMINAL_TYPES = new Set(['turn_completed', 'conversation_closed']);

// Binary Workbench files are base64-encoded in a single `file_content` frame.
// Keep the transport allowance explicit and bounded: 32 MiB source data becomes
// about 42.7 MiB of base64 plus JSON framing. Other traffic keeps the normal
// queue budget so a large preview cannot make unbounded buffering possible.
export const MAX_WORKBENCH_BINARY_MESSAGE_BYTES = 48 * 1024 * 1024;

function messageBudget(msg, defaultMaxBytes) {
  if (msg?.type === 'file_content' && msg.binary) {
    return Math.max(defaultMaxBytes, MAX_WORKBENCH_BINARY_MESSAGE_BYTES);
  }
  return defaultMaxBytes;
}

function removeBufferedAt(index) {
  const [removed] = ctx.messageBuffer.splice(index, 1);
  ctx.messageBufferBytes = Math.max(0, Number(ctx.messageBufferBytes || 0) - messageBytes(removed));
}

function removeOutboundAt(index, outcome = 'dropped') {
  const [removed] = ctx.outboundSendQueue.splice(index, 1);
  ctx.outboundSendQueueBytes = Math.max(0, Number(ctx.outboundSendQueueBytes || 0) - Number(removed?.bytes || 0));
  removed?.resolve?.(outcome);
}

function bufferMessage(msg, reason) {
  if (!BUFFERABLE_TYPES.has(msg.type)) {
    console.warn(`[WS] Cannot send message, WebSocket not open: ${msg.type}`);
    return 'dropped';
  }
  const bytes = messageBytes(msg);
  const maxBytes = messageBudget(
    msg,
    Math.max(1, Number(ctx.messageBufferMaxBytes) || 8 * 1024 * 1024),
  );
  if (bytes > maxBytes) {
    console.warn(`[WS] Message exceeds disconnected buffer byte budget, dropping: ${msg.type}`);
    return 'dropped';
  }
  while (ctx.messageBuffer.length > 0 && (
    ctx.messageBuffer.length >= ctx.messageBufferMaxSize
    || Number(ctx.messageBufferBytes || 0) + bytes > maxBytes
  )) {
    const nonTerminal = ctx.messageBuffer.findIndex(m => !TERMINAL_TYPES.has(m.type));
    if (nonTerminal < 0) break;
    removeBufferedAt(nonTerminal);
  }
  if (ctx.messageBuffer.length >= ctx.messageBufferMaxSize
      || Number(ctx.messageBufferBytes || 0) + bytes > maxBytes) return 'dropped';
  ctx.messageBuffer.push(msg);
  ctx.messageBufferBytes = Number(ctx.messageBufferBytes || 0) + bytes;
  console.log(`[WS] ${reason}, buffered: ${msg.type} (queue: ${ctx.messageBuffer.length})`);
  return 'buffered';
}

async function sendNow(msg) {
  if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) return bufferMessage(msg, 'Disconnected');
  if (ctx.serverEncryptionRequired && ctx.sessionKey) {
    const encrypted = await encrypt(msg, ctx.sessionKey);
    ctx.ws.send(JSON.stringify(encrypted));
  } else {
    ctx.ws.send(JSON.stringify(msg));
  }
  return 'sent';
}

function scheduleOutboundDrain() {
  if (ctx.outboundSendQueueActive) return;
  ctx.outboundSendQueueActive = true;
  setImmediate(async () => {
    try {
      while (ctx.outboundSendQueue.length > 0) {
        const item = ctx.outboundSendQueue.shift();
        ctx.outboundSendQueueBytes = Math.max(0, Number(ctx.outboundSendQueueBytes || 0) - Number(item?.bytes || 0));
        const msg = item?.msg ?? item;
        try {
          const outcome = await sendNow(msg);
          item?.resolve?.(outcome);
        } catch (e) {
          console.error(`[WS] Error sending message ${msg?.type}:`, e.message);
          const outcome = msg ? bufferMessage(msg, 'Send failed') : 'dropped';
          item?.resolve?.(outcome);
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally {
      ctx.outboundSendQueueActive = false;
      if (ctx.outboundSendQueue.length > 0) scheduleOutboundDrain();
    }
  });
}

export async function sendToServer(msg) {
  if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) return bufferMessage(msg, 'Disconnected');
  const bytes = messageBytes(msg);
  const maxBytes = messageBudget(
    msg,
    Math.max(1, Number(ctx.outboundSendQueueMaxBytes) || 8 * 1024 * 1024),
  );
  if (bytes > maxBytes) {
    console.warn(`[WS] Outbound message exceeds byte budget, dropping: ${msg.type}`);
    return 'dropped';
  }
  while (TERMINAL_TYPES.has(msg.type)
      && Number(ctx.outboundSendQueueBytes || 0) + bytes > maxBytes) {
    const nonTerminal = ctx.outboundSendQueue.findIndex(item => !TERMINAL_TYPES.has(item?.msg?.type));
    if (nonTerminal < 0) break;
    removeOutboundAt(nonTerminal);
  }
  if (Number(ctx.outboundSendQueueBytes || 0) + bytes > maxBytes) {
    console.warn(`[WS] Outbound queue byte budget exceeded, dropping: ${msg.type}`);
    return 'dropped';
  }
  const promise = new Promise((resolve, reject) => {
    ctx.outboundSendQueue.push({ msg, bytes, resolve, reject });
    ctx.outboundSendQueueBytes = Number(ctx.outboundSendQueueBytes || 0) + bytes;
  });
  scheduleOutboundDrain();
  return promise;
}

export async function flushMessageBuffer() {
  if (ctx.messageBuffer.length === 0) return;
  const buffered = ctx.messageBuffer.splice(0);
  ctx.messageBufferBytes = 0;
  console.log(`[WS] Flushing ${buffered.length} buffered messages...`);
  for (const msg of buffered) await sendToServer(msg);
  console.log('[WS] Flush queued');
}

export async function parseMessage(data) {
  try {
    const parsed = JSON.parse(data.toString());
    if (ctx.sessionKey && isEncrypted(parsed)) return await decrypt(parsed, ctx.sessionKey);
    return parsed;
  } catch (e) {
    console.error('Failed to parse message:', e);
    return null;
  }
}
