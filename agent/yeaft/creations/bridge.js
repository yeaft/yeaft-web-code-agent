import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { safeId, fail } from './constants.js';

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
  let servicePromise;
  let closed = false;
  function service() {
    if (closed) fail('INVALID_STATE', 'Creations is closed');
    const yeaftDir = context.CONFIG?.yeaftDir;
    if (!yeaftDir) fail('INVALID_STATE', 'Agent data directory is unavailable');
    servicePromise ??= Promise.resolve().then(() => createService({ yeaftDir,
      emitEvent: event => send({ type: 'creation_event', event }),
      mediaUrlFor: (creationId, mediaKind, mediaId) => {
        const agentId = context.agentId || context.AGENT_ID;
        if (!agentId) return undefined;
        return `/api/yeaft/creations/${encodeURIComponent(agentId)}/${safeId(creationId)}/media/${mediaKind}/${safeId(mediaId)}`;
      },
    })).catch(error => { servicePromise = undefined; throw error; });
    return servicePromise;
  }
  function correlation(msg) {
    return typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 128 ? msg.requestId : null;
  }
  return {
    async request(msg) {
      if (msg?.type !== 'creation_request') return false;
      const response = { type: 'creation_response', requestId: correlation(msg), op: typeof msg.op === 'string' ? msg.op : '' };
      try {
        if (!response.requestId || typeof msg.ownerId !== 'string' || !msg.ownerId || msg.ownerId.length > 128) {
          fail('INVALID_REQUEST', 'Creations request requires authenticated ownership');
        }
        const runtime = await service();
        if (closed) fail('INVALID_STATE', 'Creations is closed');
        response.data = await runtime.request({ op: response.op, payload: msg.payload ?? {} });
        response.ok = true;
      } catch (error) { Object.assign(response, { ok: false, ...safeError(error) }); }
      await send(response);
      return true;
    },
    async mediaRead(msg) {
      if (msg?.type !== 'creation_media_read') return false;
      const requestId = correlation(msg);
      let response;
      try {
        if (!requestId) fail('INVALID_REQUEST', 'Invalid Creations media request');
        const runtime = await service();
        if (closed) fail('INVALID_STATE', 'Creations is closed');
        response = await runtime.handleMediaRead(msg);
      } catch (error) { response = { type: 'creation_media_chunk', requestId, ok: false, ...safeError(error) }; }
      await send(response);
      return true;
    },
    async close() {
      closed = true;
      if (servicePromise) {
        try { await (await servicePromise).close(); } catch { /* shutdown is best effort */ }
      }
    },
  };
}

const bridge = createCreationBridge();
export const handleCreationRequest = msg => bridge.request(msg);
export const handleCreationMediaRead = msg => bridge.mediaRead(msg);
export const shutdownCreations = () => bridge.close();
