import { createHash } from 'node:crypto';
import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { safeId, fail, PRIVATE_AI_EVENT_TYPES } from './constants.js';
import { readMediaChunk } from './media.js';

const MAX_NAMESPACES = 4;
const MAX_CANCELLED_CLIENTS = 1024;
const CANCELLED_CLIENT_TTL_MS = 5 * 60_000;
const validTargetClientId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const PUBLIC_ERRORS = new Set(['INVALID_REQUEST', 'INVALID_STATE', 'LIMIT_EXCEEDED', 'INVALID_PATH', 'INVALID_RANGE',
  'BUSY', 'NOT_FOUND', 'CONFLICT', 'REVIEW_REQUIRED', 'LOCKED', 'UNSUPPORTED', 'STALE']);
function safeError(error) {
  if (PUBLIC_ERRORS.has(error?.code)) return { errorCode: error.code.toLowerCase(), error: error.message };
  return { errorCode: 'outcome_unknown', error: 'Creation operation could not be confirmed; refresh and check Agent storage or model configuration' };
}

// The Server authorizes Agent access. No request can choose a filesystem root
// or a different Agent. Requests and media pulls never use Session routing.
export function createCreationBridge({ context = ctx, send = sendToServer,
  createService = async options => (await import('./service.js')).createCreationService(options) } = {}) {
  const scopes = new Map();
  const cancelledClientsBySocket = new WeakMap();
  const clientKey = (ownerId, targetClientId) => `${ownerId}\0${targetClientId}`;
  function recordClientCancellation(socket, ownerId, targetClientId) {
    if (!socket) return;
    let cancelled = cancelledClientsBySocket.get(socket);
    if (!cancelled) cancelledClientsBySocket.set(socket, cancelled = new Map());
    const now = Date.now();
    for (const [key, expiresAt] of cancelled) {
      if (expiresAt > now) break;
      cancelled.delete(key);
    }
    const key = clientKey(ownerId, targetClientId);
    cancelled.delete(key);
    if (cancelled.size >= MAX_CANCELLED_CLIENTS) cancelled.delete(cancelled.keys().next().value);
    cancelled.set(key, now + CANCELLED_CLIENT_TTL_MS);
  }
  const isClientCancelled = (socket, ownerId, targetClientId) => targetClientId !== undefined
    && cancelledClientsBySocket.get(socket)?.get(clientKey(ownerId, targetClientId)) > Date.now();
  let cacheIdentity;
  let closed = false;
  let pending = Promise.resolve();
  function serialize(fn) {
    const operation = pending.then(fn);
    pending = operation.catch(() => {});
    return operation;
  }
  const validOwner = ownerId => typeof ownerId === 'string' && ownerId.length > 0 && ownerId.length <= 128 && !ownerId.includes('\0');
  function readIdentity(ownerId) {
    const serverUrl = context.CONFIG?.serverUrl;
    const agentId = context.agentId || context.AGENT_ID;
    const yeaftDir = context.CONFIG?.yeaftDir;
    return { yeaftDir, serverUrl, agentId, ownerId };
  }
  const sameAgent = (a, b) => a.yeaftDir === b.yeaftDir && a.serverUrl === b.serverUrl && a.agentId === b.agentId;
  async function retireAll() {
    const retired = [...scopes.values()];
    scopes.clear(); // Fence events before shutdown settles outstanding turns.
    cacheIdentity = undefined;
    await Promise.allSettled(retired.map(retireScope));
  }
  const isCurrent = (current, socket) => !closed && socket === context.ws && sameAgent(current, readIdentity(current.ownerId));
  function assertCurrent(current, socket) {
    if (!isCurrent(current, socket)) fail('INVALID_STATE', 'Agent storage identity changed');
    if (![current.yeaftDir, current.serverUrl, current.agentId].every(value => typeof value === 'string' && value && !value.includes('\0'))) {
      fail('INVALID_STATE', 'Agent storage identity is unavailable');
    }
  }
  function storageOptions({ yeaftDir, serverUrl, agentId, ownerId }) {
    const namespaceKey = createHash('sha256').update(`${serverUrl}\0${agentId}\0${ownerId}`).digest('hex').slice(0, 24);
    return { yeaftDir, namespaceKey, namespaceBinding: { serverUrl, agentId, ownerId } };
  }
  function detachSocketListener(scope) {
    if (!scope.onSocketClose) return;
    scope.socket.off('close', scope.onSocketClose);
    scope.onSocketClose = undefined;
  }
  async function retireScope(scope) {
    detachSocketListener(scope);
    await scope.runtime.close();
  }
  function touchScope(ownerId, scope, nextSocket) {
    if (scope.socket !== nextSocket) {
      const previousSocket = scope.socket;
      detachSocketListener(scope);
      scope.socket = nextSocket;
      scope.socketClosed = false;
      if (previousSocket) scope.runtime.aiAssistant?.cancelSocketJobs?.(previousSocket);
      if (typeof nextSocket?.once === 'function' && typeof nextSocket?.off === 'function') {
        scope.onSocketClose = () => {
          scope.onSocketClose = undefined;
          scope.socketClosed = true;
          scope.runtime.aiAssistant?.cancelSocketJobs?.(nextSocket);
        };
        nextSocket.once('close', scope.onSocketClose);
      }
    }
    scopes.delete(ownerId);
    scopes.set(ownerId, scope);
    return scope;
  }
  const isScopeSocketActive = (ownerId, scope, current, socket) => scopes.get(ownerId) === scope
    && scope.socket === socket && !scope.socketClosed && (socket?.readyState ?? 1) === 1 && isCurrent(current, socket);
  async function pruneIdle(maxSize, protectedOwner) {
    while (scopes.size > maxSize) {
      const oldestIdle = [...scopes].find(([ownerId, scope]) => ownerId !== protectedOwner && !scope.runtime.hasActiveWork());
      if (!oldestIdle) break; // Active namespaces may temporarily exceed the limit.
      const [ownerId, scope] = oldestIdle;
      scopes.delete(ownerId);
      await retireScope(scope);
    }
  }
  async function serviceForOwner(current, socket) {
    const { agentId, ownerId } = current;
    if (cacheIdentity && !sameAgent(cacheIdentity, readIdentity(ownerId))) await retireAll();
    assertCurrent(current, socket);
    const cached = scopes.get(ownerId);
    await pruneIdle(cached ? MAX_NAMESPACES : MAX_NAMESPACES - 1, ownerId);
    assertCurrent(current, socket);
    if (cached) return touchScope(ownerId, cached, socket);
    const scope = {};
    scope.runtime = await createService({ ...storageOptions(current),
      emitEvent: event => {
        const eventSocket = scope.socket;
        const isCurrentEvent = () => isScopeSocketActive(ownerId, scope, current, eventSocket);
        if (isCurrentEvent()) {
          const { _targetClientId: targetClientId, ...body } = event;
          const privateEvent = PRIVATE_AI_EVENT_TYPES.has(body.type);
          if (privateEvent && !validTargetClientId(targetClientId)) return;
          return send({ type: 'creation_event', ownerId, ...(privateEvent ? { targetClientId } : {}), event: body }, { isCurrent: isCurrentEvent });
        }
      },
      mediaUrlFor: (creationId, mediaKind, mediaId) =>
        `/api/yeaft/creations/${encodeURIComponent(agentId)}/${safeId(creationId)}/media/${mediaKind}/${safeId(mediaId)}`,
    });
    cacheIdentity = current;
    scopes.set(ownerId, scope);
    if (!isCurrent(current, socket)) {
      if (!sameAgent(current, readIdentity(ownerId))) await retireAll();
      else {
        scopes.delete(ownerId);
        await retireScope(scope);
      }
      fail('INVALID_STATE', 'Agent storage identity changed');
    }
    return touchScope(ownerId, scope, socket);
  }
  function correlation(msg) {
    return typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 128 ? msg.requestId : null;
  }
  const bridge = {
    cancelSocketJobs(socket) {
      for (const { runtime } of scopes.values()) runtime.aiAssistant?.cancelSocketJobs?.(socket);
    },
    async resolveWorkspaceBinding(ownerId, creationId) {
      if (!validOwner(ownerId)) return null;
      try {
        safeId(creationId);
        const current = readIdentity(ownerId);
        const socket = context.ws;
        return await serialize(async () => {
          assertCurrent(current, socket);
          if (context.creationBridge !== bridge) return null;
          const cached = cacheIdentity && sameAgent(cacheIdentity, current) && scopes.get(ownerId);
          if (cached) return cached.runtime.store.resolveWorkspaceBinding(creationId);
          // File operations after restart must not create namespaces or recover runs.
          const { createCreationStore } = await import('./store.js');
          assertCurrent(current, socket);
          if (context.creationBridge !== bridge) return null;
          const store = createCreationStore({ ...storageOptions(current), readOnly: true });
          try { return store.resolveWorkspaceBinding(creationId); }
          finally { store.close(); }
        });
      } catch { return null; }
    },
    async resolveWorkspaceRoot(ownerId, creationId) {
      return (await bridge.resolveWorkspaceBinding(ownerId, creationId))?.rootDir ?? null;
    },
    async request(msg) {
      if (msg?.type !== 'creation_request') return false;
      const response = { type: 'creation_response', requestId: correlation(msg), op: typeof msg.op === 'string' ? msg.op : '' };
      const originSocket = context.ws;
      try {
        if (!response.requestId || !validOwner(msg.ownerId)) {
          fail('INVALID_REQUEST', 'Creations request requires authenticated ownership');
        }
        const { ownerId, targetClientId } = msg;
        if ((targetClientId !== undefined || response.op === 'cancel_client_ai_jobs') && !validTargetClientId(targetClientId)) {
          fail('INVALID_REQUEST', 'Invalid target client identifier');
        }
        const { op } = response;
        const current = readIdentity(ownerId);
        let earlyCancelled = 0;
        if (op === 'cancel_client_ai_jobs') {
          recordClientCancellation(originSocket, ownerId, targetClientId);
          // Synchronously abort matching jobs in any already-cached runtime so
          // an active review cannot commit while the serialized queue is busy.
          const cached = !closed && cacheIdentity && sameAgent(cacheIdentity, current) && scopes.get(ownerId);
          if (cached) earlyCancelled = cached.runtime.aiAssistant?.cancelClientJobs?.(targetClientId)?.cancelledCount || 0;
        }
        const checkClient = () => {
          if ((op === 'inline_edit' || op === 'review_document') && isClientCancelled(originSocket, ownerId, targetClientId)) {
            fail('STALE', 'Client connection was cancelled');
          }
        };
        checkClient();
        response.data = await serialize(async () => {
          if (op === 'cancel_client_ai_jobs') {
            assertCurrent(current, originSocket);
            const scope = cacheIdentity && sameAgent(cacheIdentity, current) && scopes.get(ownerId);
            const queued = scope ? scope.runtime.request({ op, payload: msg.payload ?? {}, meta: { targetClientId, originSocket } })
              : { cancelledCount: 0 };
            return { cancelledCount: earlyCancelled + (queued?.cancelledCount || 0) };
          }
          checkClient();
          const scope = await serviceForOwner(current, originSocket);
          if (closed) fail('INVALID_STATE', 'Creations is closed');
          checkClient(); // Cancellation may arrive while the namespace is opening.
          return scope.runtime.request({ op, payload: msg.payload ?? {},
            meta: { targetClientId, originSocket, isOriginActive: () => isScopeSocketActive(ownerId, scope, current, originSocket) } });
        });
        response.ok = true;
      } catch (error) { Object.assign(response, { ok: false, ...safeError(error) }); }
      if (context.ws === originSocket) await send(response);
      return true;
    },
    async mediaRead(msg) {
      if (msg?.type !== 'creation_media_read') return false;
      const requestId = correlation(msg);
      const socket = context.ws;
      let response;
      try {
        if (!requestId || !validOwner(msg.ownerId)) fail('INVALID_REQUEST', 'Creations media request requires authenticated ownership');
        const current = readIdentity(msg.ownerId);
        response = await serialize(async () => {
          assertCurrent(current, socket);
          const { ownerId } = current;
          const cached = cacheIdentity && sameAgent(cacheIdentity, current) && scopes.get(ownerId);
          if (cached) return touchScope(ownerId, cached, socket).runtime.handleMediaRead(msg);
          // Media pulls must not recover runs, create namespaces, or evict cached runtimes.
          const { createCreationStore } = await import('./store.js');
          assertCurrent(current, socket);
          const store = createCreationStore({ ...storageOptions(current), readOnly: true });
          try { return readMediaChunk(store, msg); }
          finally { store.close(); }
        });
      } catch (error) { response = { type: 'creation_media_chunk', requestId, ok: false, ...safeError(error) }; }
      if (context.ws === socket) await send(response);
      return true;
    },
    async close() {
      closed = true;
      if (context.creationBridge === bridge) delete context.creationBridge;
      await serialize(retireAll);
    },
  };
  context.creationBridge = bridge;
  return bridge;
}

/** Resolve an Agent-recorded workspace binding for the Server-authenticated owner only. */
export async function resolveCreationWorkspaceBinding(ownerId, creationId, { context = ctx } = {}) {
  return (await context?.creationBridge?.resolveWorkspaceBinding(ownerId, creationId)) ?? null;
}

export async function resolveCreationWorkspaceRoot(ownerId, creationId, options) {
  return (await resolveCreationWorkspaceBinding(ownerId, creationId, options))?.rootDir ?? null;
}

const bridge = createCreationBridge();
export const handleCreationRequest = msg => bridge.request(msg);
export const handleCreationMediaRead = msg => bridge.mediaRead(msg);
export const cancelCreationsForSocket = socket => ctx.creationBridge?.cancelSocketJobs?.(socket);
export const shutdownCreations = () => bridge.close();
