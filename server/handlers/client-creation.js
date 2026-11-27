import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { agents, pendingFiles } from '../context.js';
import { isClientSessionValid } from '../auth/client-session.js';
import { MAX_CREATION_IN_FLIGHT_BYTES, MAX_CREATION_IN_FLIGHT_BYTES_PER_USER, validateCreationAttachments } from '../creation-attachment-policy.js';
import { userDb } from '../database.js';
import { resolveAgentAccessError, sendToAgent, sendToWebClient } from '../ws-utils.js';

const OPS = new Set([
  'list_creations', 'create_creation', 'get_creation', 'update_creation', 'delete_creation',
  'add_sources', 'get_source', 'delete_source', 'upsert_canon', 'get_canon', 'delete_canon',
  'create_node', 'get_node', 'update_node', 'reorder_nodes', 'delete_node', 'restore_revision',
  'list_proposals', 'get_proposal', 'resolve_proposal', 'get_thread', 'send_message', 'start_batch_run', 'control_run', 'export_creation',
]);
const UPLOAD_OPS = new Set(['create_creation', 'add_sources', 'send_message']);
const MAX_PENDING_PER_CLIENT = 32;
const MAX_PENDING = 1024;
const MAX_AGENT_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Keep browser correlations private and bind each request to the exact Agent connection. */
export function createCreationRelay({
  agentMap = agents, send = (client, message) => sendToWebClient(client, message),
  forward = (agent, message) => sendToAgent(agent, message),
  accessError = (...args) => resolveAgentAccessError(...args),
  isActive = id => userDb.isActive(id), skipAuth = () => CONFIG.skipAuth,
  timeoutMs = 45_000, uploads = pendingFiles, uploadTtlMs = CONFIG.fileCleanupInterval ?? 600_000, now = Date.now,
} = {}) {
  const pending = new Map();
  const counts = new Map();
  const bytesByUser = new Map();
  let inFlightBytes = 0;
  const active = client => isClientSessionValid(client, { skipAuth: skipAuth(), isActive });
  const reply = (client, agentId, requestId, op, value) => send(client, { type: 'creation_response', agentId, requestId, op, ...value });
  function forget(id) {
    const row = pending.get(id);
    if (!row) return false;
    clearTimeout(row.timer);
    pending.delete(id);
    if (row.client) {
      const remaining = (counts.get(row.client) || 1) - 1;
      if (remaining > 0) counts.set(row.client, remaining);
      else counts.delete(row.client);
    }
    if (row.uploadBytes) {
      inFlightBytes -= row.uploadBytes;
      const userBytes = bytesByUser.get(row.userKey) - row.uploadBytes;
      if (userBytes) bytesByUser.set(row.userKey, userBytes);
      else bytesByUser.delete(row.userKey);
    }
    return true;
  }

  return {
    async request(client, msg) {
      if (msg?.type !== 'creation_request') return false;
      const agentId = typeof msg.agentId === 'string' ? msg.agentId : '';
      const browserRequestId = typeof msg.requestId === 'string' && msg.requestId.length <= 128 ? msg.requestId : null;
      const op = typeof msg.op === 'string' ? msg.op : '';
      const reject = (errorCode, error) => reply(client, agentId, browserRequestId, op, { ok: false, error, errorCode });
      if (!active(client)) {
        if (client?.authenticated) await reject('forbidden', 'Authentication required');
        return true;
      }
      if (!agentId || !browserRequestId || !OPS.has(op)) {
        await reject('invalid_request', 'Invalid Creation request');
        return true;
      }
      const error = accessError(agentId, client.userId, client.role);
      const agent = agentMap.get(agentId);
      if (error || !agent) {
        await reject(error === 'Agent access denied' ? 'forbidden' : 'offline', error || 'Agent not found or offline');
        return true;
      }
      if (!agent.capabilities?.includes('creations')) {
        await reject('unsupported_capability', 'Agent does not support Creations');
        return true;
      }
      if (pending.size >= MAX_PENDING || (counts.get(client) || 0) >= MAX_PENDING_PER_CLIENT) {
        await reject('busy', 'Too many pending Creation requests');
        return true;
      }
      if (agent.ws?.bufferedAmount > MAX_AGENT_BUFFERED_BYTES) {
        await reject('busy', 'Agent send queue is full');
        return true;
      }
      if (msg.payload != null && (typeof msg.payload !== 'object' || Array.isArray(msg.payload))) {
        await reject('invalid_request', 'Invalid Creation payload');
        return true;
      }
      const source = msg.payload ?? {};
      const { files: _clientFiles, ...payload } = source;
      let entries = [];
      let fileIds = [];
      let uploadBytes = 0;
      if (UPLOAD_OPS.has(op)) {
        const result = validateCreationAttachments(client, source, { uploads, skipAuth: skipAuth(), uploadTtlMs, now });
        if (!result.ok) {
          await reject(result.errorCode, result.error);
          return true;
        }
        delete payload.attachments;
        ({ entries, fileIds, totalBytes: uploadBytes } = result);
      }

      const serverRequestId = randomUUID();
      // The Agent echoes this namespace key in events; use the same durable
      // identity as the browser ACL and the HTTP media relay.
      const ownerId = client.userId || client.username || 'local-development';
      const userKey = ownerId;
      const userBytes = bytesByUser.get(userKey) || 0;
      if (userBytes + uploadBytes > MAX_CREATION_IN_FLIGHT_BYTES_PER_USER
          || inFlightBytes + uploadBytes > MAX_CREATION_IN_FLIGHT_BYTES) {
        await reject('busy', 'Too many Creation attachment bytes in flight');
        return true;
      }
      if (uploadBytes) {
        bytesByUser.set(userKey, userBytes + uploadBytes);
        inFlightBytes += uploadBytes;
      }
      const timer = setTimeout(() => {
        const current = pending.get(serverRequestId);
        if (forget(serverRequestId) && current?.client && active(current.client) && (current.client.userId || ownerId) === userKey) {
          void Promise.resolve().then(() => reject('timeout', 'Creation request timed out; refresh before retrying')).catch(() => {});
        }
      }, timeoutMs);
      timer.unref?.();
      pending.set(serverRequestId, { client, agent, agentId, browserRequestId, op, timer, userKey, uploadBytes, fileIds });
      counts.set(client, (counts.get(client) || 0) + 1);
      let sent;
      try {
        if (entries.length) payload.files = entries.map(({ name, mimeType, buffer }) => ({
          name, mimeType, data: buffer.toString('base64'), size: buffer.length,
        }));
        sent = await forward(agent, { type: 'creation_request', requestId: serverRequestId, op, payload, ownerId });
      } catch {
        // A thrown transport error does not prove a mutation was never delivered.
        if (forget(serverRequestId) && active(client)) await reject('outcome_unknown', 'Agent delivery could not be confirmed; refresh before retrying');
        return true;
      }
      if (sent === false && forget(serverRequestId) && active(client)) await reject('offline', 'Agent is offline; refresh before retrying');
      return true;
    },
    async response(agentId, agent, msg) {
      if (msg?.type !== 'creation_response') return false;
      const row = pending.get(msg.requestId);
      if (!row || row.agentId !== agentId || row.agent !== agent || agentMap.get(agentId) !== agent) return true;
      forget(msg.requestId);
      // Ingestion succeeded even if the browser disconnected or is no longer authorized to see the reply.
      if (msg.ok === true) {
        for (const fileId of row.fileIds) uploads.delete(fileId);
      }
      if (!row.client || !active(row.client) || accessError(agentId, row.client.userId, row.client.role)) return true;
      await reply(row.client, row.agentId, row.browserRequestId, row.op, msg.ok === true
        ? { ok: true, data: msg.data }
        : { ok: false,
          error: typeof msg.error === 'string' ? msg.error.slice(0, 500) : 'Creation request failed',
          errorCode: typeof msg.errorCode === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(msg.errorCode) ? msg.errorCode : 'requestFailed',
        });
      return true;
    },
    clearAgent(agentId, agent) {
      for (const [id, row] of pending) {
        if (row.agentId !== agentId || row.agent !== agent || !forget(id) || !row.client || !active(row.client)) continue;
        void Promise.resolve().then(() => reply(row.client, agentId, row.browserRequestId, row.op, {
          ok: false, errorCode: 'outcome_unknown', error: 'Agent disconnected; refresh before retrying',
        })).catch(() => {});
      }
    },
    clearClient(client) {
      for (const [id, row] of pending) {
        if (row.client !== client) continue;
        if (row.fileIds?.length) {
          // Detach browser delivery and release in-flight relay budget, while retaining the
          // ingestion correlation until the Agent responds or times out so successful uploads
          // still release staged intake quota immediately.
          row.client = null;
          counts.delete(client);
          if (row.uploadBytes) {
            inFlightBytes -= row.uploadBytes;
            const userBytes = bytesByUser.get(row.userKey) - row.uploadBytes;
            if (userBytes) bytesByUser.set(row.userKey, userBytes);
            else bytesByUser.delete(row.userKey);
            row.uploadBytes = 0;
          }
        } else {
          forget(id);
        }
      }
    },
    close() { for (const id of pending.keys()) forget(id); },
  };
}

const relay = createCreationRelay();
export const handleClientCreation = (client, msg) => relay.request(client, msg);
export const deliverCreationResponse = (agentId, agent, msg) => relay.response(agentId, agent, msg);
export const clearCreationRequestsForClient = client => relay.clearClient(client);
export const clearCreationRequestsForAgent = (agentId, agent) => relay.clearAgent(agentId, agent);
