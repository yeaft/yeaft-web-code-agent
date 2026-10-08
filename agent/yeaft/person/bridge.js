import { createHash } from 'node:crypto';
import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';

/** Lazy Person transport. Only deployment-local environment supplies database credentials.
 * Storage is lazy and instance-local by default; browser messages cannot choose a backend.
 */
export function createPersonBridge({
  context = ctx, send = sendToServer, env = process.env,
  createService = async options => (await import('./service.js')).createPersonService(options),
} = {}) {
  let servicePromise = null;
  let identity = null;
  let closed = false;
  async function close() {
    closed = true;
    if (servicePromise) {
      try { await (await servicePromise).close(); } catch { /* shutdown must not expose credentials */ }
    }
    servicePromise = null;
  }
  async function request(msg) {
    if (msg?.type !== 'person_request') return false;
    const response = {
      type: 'person_response',
      requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
      op: typeof msg.op === 'string' ? msg.op : '',
    };
    try {
      if (closed) throw new Error('closed');
      if (!response.requestId || typeof msg.ownerId !== 'string' || !msg.ownerId || msg.ownerId.length > 128) {
        await send({ ...response, ok: false, errorCode: 'invalid_request', error: 'Digital person request requires authenticated ownership' });
        return true;
      }
      const uri = env.YEAFT_PERSON_MONGODB_URI;
      const agentId = context.agentId || context.AGENT_ID;
      if (!agentId || !context.CONFIG?.yeaftDir) throw new Error('identity');
      // Server+Agent is a storage boundary; a re-registration must not reuse the old runtime.
      const namespace = createHash('sha256')
        .update(`${context.CONFIG.serverUrl || 'local'}\0${agentId}`).digest('hex');
      if (identity && identity !== namespace) {
        await (await servicePromise).close();
        servicePromise = null;
      }
      identity = namespace;
      if (!servicePromise) {
        servicePromise = Promise.resolve().then(() => createService({
          uri,
          storage: env.YEAFT_PERSON_STORAGE,
          embedding: { enabled: env.YEAFT_PERSON_EMBEDDING !== 'off', allowDownload: env.YEAFT_PERSON_EMBEDDING_DOWNLOAD !== '0' },
          dbName: env.YEAFT_PERSON_MONGODB_DB || 'yeaft_person',
          namespace,
          yeaftDir: context.CONFIG.yeaftDir,
          workDir: context.CONFIG.workDir,
        })).catch(error => { servicePromise = null; throw error; });
      }
      const service = await servicePromise;
      const data = await service.request({
        ownerId: msg.ownerId, op: response.op,
        payload: msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) ? msg.payload : {},
      });
      await send({ ...response, ok: true, data });
    } catch (error) {
      // Driver/provider messages can include credential-bearing URLs. Never relay them.
      const safeErrors = {
        BUSY: 'The digital person is busy; wait or cancel before trying again',
        INVALID_REQUEST: response.op === 'settings'
          ? 'Invalid digital person settings; use a non-empty name of at most 160 UTF-8 bytes and valid settings fields'
          : 'Invalid digital person request',
        INVALID_ATTACHMENT: 'Invalid digital person attachment',
        UNSUPPORTED_ATTACHMENT: 'Use PNG/JPEG/WebP/GIF images or UTF-8 text; PDF and binary files are not supported',
        ATTACHMENT_LIMIT: 'Maximum 4 attachments, 5 MiB each, 10 MiB total; text plus extracted content must fit 24 KiB',
        IMAGE_MODEL: 'No permitted selected model supports image input',
        MODEL_SELECTION: 'Choose models from this Agent configured catalog',
        NOT_OPEN: 'Open the digital person first',
        STALE: 'Digital person state changed; refresh and try again',
        IDEMPOTENCY_CONFLICT: 'This message identifier already belongs to a different request',
        STORAGE_MISMATCH: 'The configured storage differs from the existing Person authority; do not switch without a verified migration',
        UNSUPPORTED: 'This capability is not available in this digital person version',
      };
      const known = Object.hasOwn(safeErrors, error?.code);
      // A lost database commit acknowledgement or response-send failure is not a
      // definitive rejection. Preserve the command ID so an explicit retry deduplicates.
      await send({ ...response, ok: false, errorCode: known ? error.code.toLowerCase() : 'outcome_unknown',
        error: known ? safeErrors[error.code] : 'Digital person outcome is unknown; refresh and check Agent database/model configuration' });
    }
    return true;
  }
  return { request, close };
}

const bridge = createPersonBridge();
export const handlePersonRequest = msg => bridge.request(msg);
export const shutdownPerson = () => bridge.close();
