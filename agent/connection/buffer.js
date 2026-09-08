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
  const maxBytes = Math.max(1, Number(ctx.messageBufferMaxBytes) || 8 * 1024 * 1024);
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

const FILE_CHUNK_SEND_TIMEOUT_MS = 10_000;

function sendFileChunk(socket, data) {
  // Production uses Node ws; retain compatibility with synchronous, one-argument
  // transport stubs without treating a real ws.send() return as a flushed write.
  if (!(socket instanceof WebSocket) && socket.send.length < 2) {
    socket.send(data);
    return 'sent';
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(connectionCheck);
      socket.removeListener?.('close', onClose);
      socket.removeListener?.('error', onError);
      if (error) reject(error);
      else resolve('sent');
    };
    const onClose = () => finish(new Error('WebSocket closed during file chunk send'));
    const onError = error => finish(error);
    const connectionChanged = () => socket !== ctx.ws || socket.readyState !== WebSocket.OPEN;
    const timeout = setTimeout(() => finish(new Error('File chunk send timed out')), FILE_CHUNK_SEND_TIMEOUT_MS);
    // Replacing ctx.ws need not emit close on the old socket.
    const connectionCheck = setInterval(() => {
      if (connectionChanged()) onClose();
    }, 100);
    socket.once?.('close', onClose);
    socket.once?.('error', onError);
    try {
      socket.send(data, error => {
        if (error) finish(error);
        else if (connectionChanged()) onClose();
        else finish();
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function sendNow(msg, queuedSocket) {
  const socket = ctx.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return bufferMessage(msg, 'Disconnected');
  // File transfers are request/connection scoped, unlike replayable chat output.
  if (msg.type === 'file_content_chunk' && queuedSocket !== socket) return 'dropped';
  const payload = ctx.serverEncryptionRequired && ctx.sessionKey
    ? await encrypt(msg, ctx.sessionKey) : msg;
  if (socket !== ctx.ws || socket.readyState !== WebSocket.OPEN) {
    return bufferMessage(msg, 'Connection changed');
  }
  const data = JSON.stringify(payload);
  if (msg.type === 'file_content_chunk') return sendFileChunk(socket, data);
  socket.send(data);
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
          const outcome = await sendNow(msg, item?.socket);
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
  const maxBytes = Math.max(1, Number(ctx.outboundSendQueueMaxBytes) || 8 * 1024 * 1024);
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
    ctx.outboundSendQueue.push({ msg, bytes, resolve, reject, socket: msg.type === 'file_content_chunk' ? ctx.ws : null });
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
