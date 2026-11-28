import { createHash } from 'node:crypto';
import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { safeId, fail, PRIVATE_AI_EVENT_TYPES } from './constants.js';
import { readMediaChunk } from './media.js';

const MAX_NAMESPACES = 4;
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
    await Promise.allSettled(retired.map(async scope => scope.runtime.close()));
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
  function touchScope(ownerId, scope, socket) {
    scope.socket = socket;
    scopes.delete(ownerId);
    scopes.set(ownerId, scope);
    return scope.runtime;
  }
  async function pruneIdle(maxSize, protectedOwner) {
    while (scopes.size > maxSize) {
      const oldestIdle = [...scopes].find(([ownerId, scope]) => ownerId !== protectedOwner && !scope.runtime.hasActiveWork());
      if (!oldestIdle) break; // Active namespaces may temporarily exceed the limit.
      const [ownerId, scope] = oldestIdle;
      scopes.delete(ownerId);
      await scope.runtime.close();
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
    const scope = { socket };
    scope.runtime = await createService({ ...storageOptions(current),
      emitEvent: event => {
        const eventSocket = scope.socket;
        const isCurrentEvent = () => scopes.get(ownerId) === scope && isCurrent(current, eventSocket);
        if (isCurrentEvent()) {
          const { _targetClientId: targetClientId, ...body } = event;
          const privateEvent = PRIVATE_AI_EVENT_TYPES.has(body.type);
          if (privateEvent && (typeof targetClientId !== 'string' || !targetClientId.length)) return;
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
        await scope.runtime.close();
      }
      fail('INVALID_STATE', 'Agent storage identity changed');
    }
    return scope.runtime;
  }
  function correlation(msg) {
    return typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 128 ? msg.requestId : null;
  }
  const bridge = {
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
      const socket = context.ws;
      try {
        if (!response.requestId || !validOwner(msg.ownerId)) {
          fail('INVALID_REQUEST', 'Creations request requires authenticated ownership');
        }
        const current = readIdentity(msg.ownerId);
        response.data = await serialize(async () => {
          const runtime = await serviceForOwner(current, socket);
          if (closed) fail('INVALID_STATE', 'Creations is closed');
          return runtime.request({ op: response.op, payload: msg.payload ?? {},
            meta: { targetClientId: typeof msg.targetClientId === 'string' ? msg.targetClientId : undefined } });
        });
        response.ok = true;
      } catch (error) { Object.assign(response, { ok: false, ...safeError(error) }); }
      if (context.ws === socket) await send(response);
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
          if (cached) return touchScope(ownerId, cached, socket).handleMediaRead(msg);
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
export const shutdownCreations = () => bridge.close();
