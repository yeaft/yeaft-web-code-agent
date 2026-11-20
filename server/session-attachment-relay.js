import { randomUUID } from 'node:crypto';
import { agents } from './context.js';
import { CONFIG } from './config.js';
import { userDb, yeaftSessionDb } from './database.js';
import { resolveAgentAccessError, sendToAgent } from './ws-utils.js';

// v1 Session attachment protocol; independent of Workbench paths or selection.
const CAPABILITY = 'session_attachment_refs';
const SESSION_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/;
const ATTACHMENT_ID = /^m[0-9]{1,16}\.(?:[0-9]|1[0-5])$/;
const CHUNK_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 10 * CHUNK_BYTES;
const MAX_DOWNLOAD_BYTES = 50 * CHUNK_BYTES;
const MAX_TRANSFERS = 32;
const MAX_USER_TRANSFERS = 16;
const pendingChunks = new Map();
const activeTransfersByUser = new Map();
let activeTransfers = 0;

const failure = (status, message) => Object.assign(new Error(message), { status });

export function sessionAttachmentUrl(agentId, sessionId, attachmentId) {
  if (!agentId || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)
      || typeof attachmentId !== 'string' || !ATTACHMENT_ID.test(attachmentId)) return null;
  return `/api/yeaft/session-attachments/${encodeURIComponent(agentId)}/${encodeURIComponent(sessionId)}/${attachmentId}`;
}

function authorize(user, agentId, sessionId) {
  const account = userDb.getByUsername(user.username);
  if (!CONFIG.skipAuth && (!account || account.deletion_state !== 'active')) throw failure(403, 'Attachment access denied');
  const accessError = resolveAgentAccessError(agentId, account?.id, user.role);
  if (accessError) throw failure(accessError === 'Agent access denied' ? 403 : 503, accessError);
  const agent = agents.get(agentId);
  // In production the owner-scoped catalog is authoritative. The live catalog
  // is a fallback only for local no-auth Agents that don't have a durable owner.
  const session = account && yeaftSessionDb.getForAgent(account.id, agentId, sessionId);
  if (!session && !(CONFIG.skipAuth && !agent.ownerId && agent.yeaftSessions?.has(sessionId))) throw failure(404, 'Session not found');
  if (!agent.capabilities?.includes(CAPABILITY)) throw failure(404, 'Session attachment unavailable');
  return { agent, userKey: account?.id || user.username };
}

export function handleSessionAttachmentChunk(agentId, agent, msg) {
  if (msg.type !== 'yeaft_session_attachment_chunk') return false;
  const pending = pendingChunks.get(msg.requestId);
  if (pending?.agentId === agentId && pending.agent === agent) {
    if (pending.sessionId !== msg.sessionId || pending.attachmentId !== msg.attachmentId || pending.offset !== msg.offset) {
      pending.fail(failure(502, 'Invalid attachment response'));
    } else {
      pending.receive(msg);
    }
  }
  return true;
}

export function closeSessionAttachmentReads(agentId, agent) {
  for (const pending of pendingChunks.values()) {
    if (pending.agentId === agentId && pending.agent === agent) pending.fail(failure(503, 'Agent disconnected'));
  }
}

function requestChunk(agentId, agent, source, signal) {
  if (signal.aborted) throw failure(499, 'Attachment request cancelled');
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (!pendingChunks.delete(requestId)) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, failure(499, 'Attachment request cancelled'));
    const fail = err => finish(reject, err);
    const timer = setTimeout(() => fail(failure(504, 'Attachment read timed out')), 10_000);
    pendingChunks.set(requestId, { ...source, agentId, agent, fail, receive: msg => finish(resolve, msg) });
    signal.addEventListener('abort', abort, { once: true });
    sendToAgent(agent, { type: 'session_attachment_read_authorized', requestId, ...source })
      .then(sent => { if (!sent) fail(failure(503, 'Agent disconnected')); })
      .catch(() => fail(failure(503, 'Attachment read unavailable')));
  });
}

function decodeChunk(msg, offset, previous, download) {
  if (msg.error === 'not_found') throw failure(404, 'Attachment not found');
  if (msg.error === 'changed') throw failure(409, 'Attachment changed during download');
  if (msg.error === 'too_large') throw failure(413, 'Attachment exceeds the size limit');
  if (msg.error) throw failure(502, 'Attachment read failed');
  const { size, version, filename, content } = msg;
  const limit = download ? MAX_DOWNLOAD_BYTES : MAX_PREVIEW_BYTES;
  if (!Number.isSafeInteger(size) || size < offset || size > limit
      || typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)
      || typeof filename !== 'string' || filename.length > 255
      || (previous && (previous.size !== size || previous.version !== version || previous.filename !== filename))
      || typeof content !== 'string' || content.length !== 4 * Math.ceil(Math.min(size - offset, CHUNK_BYTES) / 3)) {
    throw failure(502, 'Invalid attachment response');
  }
  const buffer = Buffer.from(content, 'base64');
  if (buffer.length !== Math.min(size - offset, CHUNK_BYTES) || buffer.toString('base64') !== content) {
    throw failure(502, 'Invalid attachment data');
  }
  return { size, version, filename, buffer };
}

/** Acquire one bounded stream, rechecking ownership and connection at each read. */
export async function* readSessionAttachment(user, { agentId, sessionId, attachmentId, download = false }, signal) {
  if (!sessionAttachmentUrl(agentId, sessionId, attachmentId)) throw failure(404, 'Attachment not found');
  const { agent, userKey } = authorize(user, agentId, sessionId);
  const checkAccess = () => {
    if (authorize(user, agentId, sessionId).agent !== agent) throw failure(503, 'Agent reconnected; retry the attachment');
  };
  if (activeTransfers >= MAX_TRANSFERS || (activeTransfersByUser.get(userKey) || 0) >= MAX_USER_TRANSFERS) {
    throw failure(503, 'Too many active attachment reads; retry shortly');
  }
  activeTransfers += 1;
  activeTransfersByUser.set(userKey, (activeTransfersByUser.get(userKey) || 0) + 1);
  try {
    let previous;
    for (let offset = 0; !previous || offset < previous.size; offset += CHUNK_BYTES) {
      checkAccess();
      const msg = await requestChunk(agentId, agent, {
        sessionId, attachmentId, offset, download,
        ...(previous ? { version: previous.version } : {}),
      }, signal);
      checkAccess();
      const chunk = decodeChunk(msg, offset, previous, download);
      previous = { size: chunk.size, version: chunk.version, filename: chunk.filename };
      yield chunk;
    }
  } finally {
    activeTransfers -= 1;
    const remaining = activeTransfersByUser.get(userKey) - 1;
    if (remaining === 0) activeTransfersByUser.delete(userKey);
    else activeTransfersByUser.set(userKey, remaining);
  }
}
