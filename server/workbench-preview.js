import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { CONFIG } from './config.js';
import { userDb } from './db/user-db.js';
import { agents, previewFiles } from './context.js';
import { forwardToAgent, resolveAgentAccessError } from './ws-utils.js';
import { agentSupportsWorkbenchRequestCorrelation, currentWorkbenchWorkspaceGeneration, resolveWorkbenchRequest } from './workbench-route.js';
import { registerWorkbenchRequest, deleteWorkbenchRequest } from './workbench-correlation.js';
import { cachePreviewFile, MAX_PREVIEW_FILE_BYTES, prunePreviewFiles } from './preview-files.js';

const inflight = new Map();
const MAX_REFILLS = 16;
const MAX_VIDEO_READS = 32;
let activeVideoReads = 0;
export const WORKBENCH_VIDEO_CHUNK_BYTES = 1024 * 1024;
const key = () => createHash('sha256').update(`workbench-preview:${CONFIG.jwtSecret}`).digest();
const failure = (status, message) => Object.assign(new Error(message), { status });

/** Mint a non-expiring, encrypted capability for one authorized Agent/Session/file.
 * Only bytes are cached; the URL retains its source across eviction and Server restart.
 * Paths and user identifiers are encrypted, not exposed in a readable URL payload.
 */
export function createWorkbenchPreview(fileId, pending, filePath) {
  if (!pending?.route || !filePath) return null;
  const source = {
    fileId, filePath, agentId: pending.agentId, userId: pending.userId,
    route: pending.route, workspaceGeneration: pending.workspaceGeneration,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(source)), cipher.final()]);
  return `wb1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}

export function createWorkbenchVideo(fileId, pending, metadata) {
  if (!pending?.route || !metadata?.filePath || !Number.isSafeInteger(metadata.size)
      || metadata.size < 0 || !Number.isFinite(metadata.mtimeMs) || !metadata.mimeType?.startsWith('video/')) return null;
  const source = {
    fileId, filePath: metadata.filePath, size: metadata.size, mtimeMs: metadata.mtimeMs,
    mimeType: metadata.mimeType, filename: metadata.filePath.split(/[\\/]/).pop(),
    agentId: pending.agentId, userId: pending.userId,
    route: pending.route, workspaceGeneration: pending.workspaceGeneration,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(source)), cipher.final()]);
  return `wbv1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
}

function decodeSource(fileId, token, prefix = 'wb1.') {
  try {
    if (typeof token !== 'string' || !token.startsWith(prefix) || token.length > 24000) throw new Error();
    const bytes = Buffer.from(token.slice(prefix.length), 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const source = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    if (source.fileId !== fileId || source.route?.agentId !== source.agentId) throw new Error();
    return source;
  } catch {
    throw failure(403, 'Forbidden');
  }
}

function authorize(source) {
  const user = userDb.get(source.userId);
  if (!CONFIG.skipAuth && (!user || user.deletion_state !== 'active' || !['pro', 'admin'].includes(user.role))) {
    throw failure(403, 'Preview access denied');
  }
  const client = { userId: source.userId, role: user?.role, workbenchRouteProtocol: 1 };
  const accessError = resolveAgentAccessError(source.agentId, client.userId, client.role);
  if (accessError) throw failure(accessError === 'Agent access denied' ? 403 : 503, accessError);
  const generation = currentWorkbenchWorkspaceGeneration({ ...client, route: source.route });
  if (generation === null || (generation && generation !== source.workspaceGeneration)) {
    throw failure(410, 'Preview Session or workspace is no longer available');
  }
  const resolved = resolveWorkbenchRequest(client, {
    workbenchRoute: source.route,
    workbenchWorkspaceGeneration: source.workspaceGeneration,
  }, source.agentId);
  if (!resolved || resolved.legacy) throw failure(410, 'Preview Session is no longer available');
  return { client, resolved };
}

async function refill(source, token, { client, resolved }) {
  let requestId;
  const clientId = `preview:${randomUUID()}`;
  const publicRequestId = randomUUID();
  try {
    const file = await new Promise((resolve, reject) => {
      requestId = registerWorkbenchRequest({
        agentId: source.agentId, clientId, publicRequestId, userId: source.userId,
        allowLegacyCorrelation: !agentSupportsWorkbenchRequestCorrelation(agents.get(source.agentId)),
        route: source.route, routeKey: resolved.routeKey, conversationId: resolved.conversationId,
        workspaceGeneration: source.workspaceGeneration, role: client.role,
        requestType: 'read_file', expectedResponseTypes: ['file_content'],
        onTimeout: (_pending, reason) => reject(failure(reason === 'timeout' ? 504 : 503, 'Preview read timed out or disconnected')),
        onResponse: msg => {
          if (msg.error) return reject(failure(msg.errorCode === 'ENOENT' ? 404 : 502, msg.error));
          if (!msg.binary || msg.filePath !== source.filePath) return reject(failure(502, 'Invalid preview response'));
          const buffer = msg.buffer || Buffer.from(msg.content || '', 'base64');
          if (buffer.length > MAX_PREVIEW_FILE_BYTES) return reject(failure(413, 'File exceeds the 20 MB transfer limit'));
          resolve({ buffer, mimeType: msg.mimeType, filename: source.filePath.split(/[\\/]/).pop(), token });
        },
      });
      if (!requestId) return reject(failure(503, 'Preview read unavailable'));
      Promise.resolve(forwardToAgent(source.agentId, {
        type: 'read_file', filePath: source.filePath, workDir: resolved.workDir,
        conversationId: resolved.conversationId, workbenchRoute: source.route,
        workbenchRouteKey: resolved.routeKey, workbenchWorkspaceGeneration: source.workspaceGeneration,
        _workbenchRequestId: requestId, _requestUserId: source.userId,
        _requestClientId: clientId, requestId: publicRequestId,
      })).then(sent => {
        if (sent === false) reject(failure(503, 'Agent is offline'));
      }, () => reject(failure(503, 'Agent read failed')));
    });
    authorize(source); // Ownership/workspace may have changed while the Agent was reading.
    cachePreviewFile(source.fileId, file); // Cache pressure must not invalidate a stable URL.
    return file;
  } finally {
    if (requestId) deleteWorkbenchRequest({ agentId: source.agentId, requestId });
  }
}

async function requestVideoChunk(source, start, end, signal) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
      || end >= source.size || (end - start + 1) > WORKBENCH_VIDEO_CHUNK_BYTES) {
    throw failure(416, 'Invalid video byte range');
  }
  if (signal?.aborted) throw failure(499, 'Video request cancelled');
  if (activeVideoReads >= MAX_VIDEO_READS) throw failure(503, 'Video stream capacity exceeded; retry shortly');
  activeVideoReads += 1;
  const clientId = `video:${randomUUID()}`;
  const publicRequestId = randomUUID();
  let requestId;
  let onAbort;
  try {
    const { client, resolved } = authorize(source);
    const result = await new Promise((resolve, reject) => {
      onAbort = () => reject(failure(499, 'Video request cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      requestId = registerWorkbenchRequest({
        agentId: source.agentId, clientId, publicRequestId, userId: source.userId,
        allowLegacyCorrelation: false, route: source.route, routeKey: resolved.routeKey,
        conversationId: resolved.conversationId, workspaceGeneration: source.workspaceGeneration,
        role: client.role, requestType: 'video_chunk', expectedResponseTypes: ['video_chunk'],
        onTimeout: (_pending, reason) => reject(failure(reason === 'timeout' ? 504 : 503, 'Video read timed out or disconnected')),
        onResponse: msg => {
          if (msg.error) return reject(failure(msg.errorCode === 'ENOENT' ? 404 : msg.errorCode === 'VIDEO_FILE_CHANGED' ? 409 : 502, msg.error));
          const buffer = Buffer.from(msg.content || '', 'base64');
          if (msg.filePath !== source.filePath || msg.start !== start || msg.end !== end
              || msg.size !== source.size || msg.mtimeMs !== source.mtimeMs
              || msg.mimeType !== source.mimeType || buffer.length !== end - start + 1) {
            return reject(failure(502, 'Invalid video stream response'));
          }
          resolve(buffer);
        },
      });
      if (!requestId) return reject(failure(503, 'Video stream unavailable'));
      Promise.resolve(forwardToAgent(source.agentId, {
        type: 'video_chunk', filePath: source.filePath, workDir: resolved.workDir,
        conversationId: resolved.conversationId, workbenchRoute: source.route,
        workbenchRouteKey: resolved.routeKey, workbenchWorkspaceGeneration: source.workspaceGeneration,
        _workbenchRequestId: requestId, _requestUserId: source.userId,
        _requestClientId: clientId, requestId: publicRequestId,
        start, end, expectedSize: source.size, expectedMtimeMs: source.mtimeMs,
      })).then(sent => {
        if (sent === false) reject(failure(503, 'Agent is offline'));
      }, () => reject(failure(503, 'Video read failed')));
    });
    authorize(source);
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (requestId) deleteWorkbenchRequest({ agentId: source.agentId, requestId });
    activeVideoReads -= 1;
  }
}

export function openWorkbenchVideo(fileId, token) {
  const source = decodeSource(fileId, token, 'wbv1.');
  if (!Number.isSafeInteger(source.size) || source.size < 0 || !Number.isFinite(source.mtimeMs)
      || !source.mimeType?.startsWith('video/')) throw failure(403, 'Forbidden');
  const agent = agents.get(source.agentId);
  if (!agent?.capabilities?.includes?.('workbench_video_stream')
      || !agentSupportsWorkbenchRequestCorrelation(agent)) {
    throw failure(410, 'Video streaming is no longer available');
  }
  authorize(source);
  return {
    size: source.size,
    mimeType: source.mimeType,
    filename: source.filename || source.filePath.split(/[\\/]/).pop() || 'video',
    read: (start, end, signal) => requestVideoChunk(source, start, end, signal),
  };
}

/** Resolve an HTTP capability independently of the browser's active Session or socket. */
export async function readWorkbenchPreview(fileId, token) {
  const source = decodeSource(fileId, token);
  const access = authorize(source);
  prunePreviewFiles();
  const cached = previewFiles.get(fileId);
  if (cached?.token === token) return cached;
  if (inflight.has(fileId)) return inflight.get(fileId);
  if (inflight.size >= MAX_REFILLS) throw failure(503, 'Preview read capacity exceeded; retry shortly');
  const promise = refill(source, token, access).finally(() => inflight.delete(fileId));
  inflight.set(fileId, promise);
  return promise;
}
