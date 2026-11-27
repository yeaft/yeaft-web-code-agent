import { createHash } from 'node:crypto';
import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { safeId, fail } from './constants.js';

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
  async function serviceForOwner(current, socket) {
    const { yeaftDir, serverUrl, agentId, ownerId } = current;
    const stillCurrent = () => !closed && socket === context.ws && sameAgent(current, readIdentity(ownerId));
    if (cacheIdentity && !sameAgent(cacheIdentity, readIdentity(ownerId))) await retireAll();
    if (!stillCurrent()) fail('INVALID_STATE', 'Agent storage identity changed');
    if (![yeaftDir, serverUrl, agentId].every(value => typeof value === 'string' && value && !value.includes('\0'))) {
      fail('INVALID_STATE', 'Agent storage identity is unavailable');
    }
    // All cached owners share the same Agent identity. Refresh a hit's LRU position.
    const cached = scopes.get(ownerId);
    if (cached) {
      cached.socket = socket;
      scopes.delete(ownerId);
      scopes.set(ownerId, cached);
      return cached.runtime;
    }
    if (scopes.size >= MAX_NAMESPACES) {
      const [oldestOwner, oldest] = scopes.entries().next().value;
      scopes.delete(oldestOwner);
      await oldest.runtime.close();
      if (!stillCurrent()) {
        if (!sameAgent(current, readIdentity(ownerId))) await retireAll();
        fail('INVALID_STATE', 'Agent storage identity changed');
      }
    }
    const binding = { serverUrl, agentId, ownerId };
    const namespaceKey = createHash('sha256').update(`${serverUrl}\0${agentId}\0${ownerId}`).digest('hex').slice(0, 24);
    const scope = { socket };
    scope.runtime = await createService({ yeaftDir, namespaceKey, namespaceBinding: binding,
      emitEvent: event => {
        const eventSocket = scope.socket;
        const isCurrent = () => !closed && scopes.get(ownerId) === scope && context.ws === eventSocket
          && sameAgent(current, readIdentity(ownerId));
        if (isCurrent()) return send({ type: 'creation_event', ownerId, event }, { isCurrent });
      },
      mediaUrlFor: (creationId, mediaKind, mediaId) =>
        `/api/yeaft/creations/${encodeURIComponent(agentId)}/${safeId(creationId)}/media/${mediaKind}/${safeId(mediaId)}`,
    });
    cacheIdentity = current;
    scopes.set(ownerId, scope);
    if (!stillCurrent()) {
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
  return {
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
          return runtime.request({ op: response.op, payload: msg.payload ?? {} });
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
          const runtime = await serviceForOwner(current, socket);
          if (closed) fail('INVALID_STATE', 'Creations is closed');
          return runtime.handleMediaRead(msg);
        });
      } catch (error) { response = { type: 'creation_media_chunk', requestId, ok: false, ...safeError(error) }; }
      if (context.ws === socket) await send(response);
      return true;
    },
    async close() {
      closed = true;
      await serialize(retireAll);
    },
  };
}

const bridge = createCreationBridge();
export const handleCreationRequest = msg => bridge.request(msg);
export const handleCreationMediaRead = msg => bridge.mediaRead(msg);
export const shutdownCreations = () => bridge.close();
