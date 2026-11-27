import { randomUUID } from 'node:crypto';
import { agents } from './context.js';
import { CONFIG } from './config.js';
import { userDb } from './database.js';
import { resolveAgentAccessError, sendToAgent } from './ws-utils.js';

export const CREATION_MEDIA_CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFERS = 32;
const MAX_USER_TRANSFERS = 16;
const AGENT_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,255}$/;
const MEDIA_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const MIME_TYPE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;
const pending = new Map();
const transfersByUser = new Map();
let transfers = 0;
const failure = (status, message) => Object.assign(new Error(message), { status });

function authorize(user, agentId) {
  if (typeof user?.username !== 'string' || !user.username) throw failure(403, 'Creation media access denied');
  const account = userDb.getByUsername(user.username);
  if (!CONFIG.skipAuth && account?.deletion_state !== 'active') throw failure(403, 'Creation media access denied');
  // The HTTP session supplies a username; the Agent ACL is keyed by durable user ID.
  const error = resolveAgentAccessError(agentId, account?.id, user.role);
  if (error) throw failure(error === 'Agent access denied' ? 403 : 503, error);
  const agent = agents.get(agentId);
  if (!agent?.capabilities?.includes('creations')) throw failure(404, 'Creation media unavailable');
  return { agent, userKey: account?.id ?? user.username };
}

export function handleCreationMediaChunk(agentId, agent, msg) {
  if (msg?.type !== 'creation_media_chunk') return false;
  const row = pending.get(msg.requestId);
  if (row?.agentId === agentId && row.agent === agent) row.receive(msg);
  return true;
}

export function closeCreationMediaReads(agentId, agent) {
  for (const row of pending.values()) {
    if (row.agentId === agentId && row.agent === agent) row.fail(failure(503, 'Agent disconnected'));
  }
}

function requestChunk(agentId, agent, params, start, end, signal) {
  if (signal?.aborted) throw failure(499, 'Creation media request cancelled');
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    function finish(callback, value) {
      if (!pending.delete(requestId)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    }
    const fail = error => finish(reject, error);
    const abort = () => fail(failure(499, 'Creation media request cancelled'));
    const timer = setTimeout(() => fail(failure(504, 'Creation media read timed out')), 15_000);
    timer.unref?.();
    pending.set(requestId, { agentId, agent, fail, receive: msg => finish(resolve, msg) });
    signal?.addEventListener('abort', abort, { once: true });
    const unavailable = () => fail(failure(503, 'Agent read unavailable'));
    try {
      Promise.resolve(sendToAgent(agent, { type: 'creation_media_read', requestId, ...params, start, end }))
        .then(sent => { if (sent === false) unavailable(); }, unavailable);
    } catch {
      unavailable();
    }
  });
}

function decodeChunk(msg, params, start, end) {
  // Some Agents echo the media identity; if present it must match the pull.
  for (const [key, value] of Object.entries(params)) {
    if (Object.hasOwn(msg, key) && msg[key] !== value) throw failure(502, 'Invalid Creation media response');
  }
  const error = msg.errorCode ?? msg.error;
  if (typeof error === 'string' && ['not_found', 'enoent'].includes(error.toLowerCase())) throw failure(404, 'Creation media not found');
  if (msg.ok === false || msg.error || msg.errorCode) throw failure(502, 'Creation media read failed');
  const { mimeType, filename, totalSize, data } = msg;
  const expectedEnd = Math.min(end, totalSize - 1);
  const length = expectedEnd - start + 1;
  if (!Number.isSafeInteger(totalSize) || totalSize < start || (totalSize === start && start !== 0)
      || msg.start !== start || msg.end !== expectedEnd || length < 0 || length > CREATION_MEDIA_CHUNK_BYTES
      || typeof mimeType !== 'string' || !MIME_TYPE.test(mimeType)
      || typeof filename !== 'string' || filename.length > 255
      || typeof data !== 'string' || data.length !== 4 * Math.ceil(length / 3)) {
    throw failure(502, 'Invalid Creation media response');
  }
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length !== length || buffer.toString('base64') !== data) throw failure(502, 'Invalid Creation media data');
  return { mimeType: mimeType.toLowerCase(), filename, totalSize, start, end: expectedEnd, buffer };
}

/** Reserve a slot for a transfer (including pauses for HTTP backpressure). Call close in finally. */
export function openCreationMedia(user, { agentId, creationId, mediaKind, mediaId }, signal) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)
      || typeof creationId !== 'string' || !MEDIA_ID.test(creationId)
      || typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId) || !['source', 'asset'].includes(mediaKind)) {
    throw failure(404, 'Creation media not found');
  }
  if (signal?.aborted) throw failure(499, 'Creation media request cancelled');
  const { agent, userKey } = authorize(user, agentId);
  const count = transfersByUser.get(userKey) || 0;
  if (transfers >= MAX_TRANSFERS || count >= MAX_USER_TRANSFERS) throw failure(503, 'Too many active Creation media reads');
  transfers++;
  transfersByUser.set(userKey, count + 1);
  const controller = new AbortController();
  let closed = false;
  let reading = false;
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    controller.abort();
    transfers--;
    const remaining = transfersByUser.get(userKey) - 1;
    if (remaining) transfersByUser.set(userKey, remaining);
    else transfersByUser.delete(userKey);
  }
  signal?.addEventListener('abort', close, { once: true });
  const params = { creationId, mediaKind, mediaId, ownerId: userKey };
  function checkAccess() {
    const current = authorize(user, agentId);
    if (current.agent !== agent || current.userKey !== userKey) throw failure(503, 'Agent or account changed; retry the media read');
  }
  return {
    close,
    async read(start, end) {
      if (closed) throw failure(499, 'Creation media request cancelled');
      if (reading) throw failure(503, 'Creation media read already in progress');
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0
          || end < start || end - start >= CREATION_MEDIA_CHUNK_BYTES) throw failure(416, 'Invalid Creation media byte range');
      checkAccess();
      reading = true;
      try {
        const msg = await requestChunk(agentId, agent, params, start, end, controller.signal);
        if (closed) throw failure(499, 'Creation media request cancelled');
        checkAccess();
        return decodeChunk(msg, params, start, end);
      } finally {
        reading = false;
      }
    },
  };
}

export async function readCreationMediaChunk(user, source, signal) {
  const transfer = openCreationMedia(user, source, signal);
  try {
    return await transfer.read(source.start, source.end);
  } finally {
    transfer.close();
  }
}
