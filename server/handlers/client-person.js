import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { agents } from '../context.js';
import { forwardToAgent, resolveAgentAccessError, sendToWebClient } from '../ws-utils.js';

const FIELDS = Object.freeze({
  status: [], open: [], snapshot: [],
  send: ['text', 'clientMessageId'], think: ['text', 'clientMessageId'],
  dream: ['clientMessageId'], cancel: ['episodeId'],
  messages: ['cursor', 'limit'], traces: ['cursor', 'limit'],
  settings: ['autonomyEnabled'],
});

/** Request-only relay: identity is supplied by the authenticated Server, never the browser.
 * Person data stays on the Agent. No Person response is broadcast to other clients.
 */
export function createPersonRelay({
  agentMap = agents, send = sendToWebClient, forward = forwardToAgent,
  accessError = resolveAgentAccessError, skipAuth = () => CONFIG.skipAuth,
  timeoutMs = 30_000,
} = {}) {
  const pending = new Map();
  function forget(id) {
    const row = pending.get(id);
    if (row) clearTimeout(row.timer);
    pending.delete(id);
    return row;
  }
  async function reply(client, envelope, value) {
    await send(client, { type: 'person_response', ...envelope, ...value });
  }
  return {
    async request(client, msg) {
      if (msg?.type !== 'person_request') return false;
      const agentId = typeof msg.agentId === 'string' ? msg.agentId : '';
      const requestId = typeof msg.requestId === 'string' && msg.requestId.length <= 128 ? msg.requestId : null;
      const op = typeof msg.op === 'string' ? msg.op : '';
      const envelope = { agentId, requestId, op };
      const error = !client.authenticated ? 'Authentication required'
        : accessError(agentId, client.userId, client.role);
      if (error) {
        await reply(client, envelope, { ok: false, error });
        return true;
      }
      const ownerId = client.userId || (skipAuth() ? 'local-development' : null);
      if (!ownerId || !requestId || !Object.hasOwn(FIELDS, op)) {
        await reply(client, envelope, { ok: false, error: 'Invalid digital person request' });
        return true;
      }
      const agent = agentMap.get(agentId);
      if (!agent?.capabilities?.includes('digital_person')) {
        await reply(client, envelope, { ok: false, error: 'This Agent does not support digital persons; upgrade it first' });
        return true;
      }
      if (pending.size >= 1024 || [...pending.values()].filter(row => row.client === client).length >= 32) {
        await reply(client, envelope, { ok: false, error: 'Too many pending digital person requests' });
        return true;
      }
      const source = msg.payload;
      if (source != null && (typeof source !== 'object' || Array.isArray(source))) {
        await reply(client, envelope, { ok: false, error: 'Invalid digital person payload' });
        return true;
      }
      const payload = Object.fromEntries(FIELDS[op].filter(key => Object.hasOwn(source || {}, key)).map(key => [key, source[key]]));
      if (JSON.stringify(payload).length > 40_000) {
        await reply(client, envelope, { ok: false, error: 'Digital person input is too large' });
        return true;
      }
      const relayId = randomUUID();
      const row = { client, agent, ownerId, agentId, envelope };
      row.timer = setTimeout(() => {
        if (!forget(relayId)) return;
        void reply(client, envelope, { ok: false, errorCode: 'timeout', error: 'Digital person request timed out; refresh before retrying' }).catch(() => {});
      }, timeoutMs);
      row.timer.unref?.();
      pending.set(relayId, row);
      try {
        const sent = await forward(agentId, {
          type: 'person_request', requestId: relayId, op, payload,
          // Only server-authenticated identity crosses the relay boundary.
          ownerId,
        });
        if (sent === false && forget(relayId)) await reply(client, envelope, { ok: false, errorCode: 'offline', error: 'Agent is offline; refresh before retrying' });
      } catch {
        // A thrown transport error does not prove the request was never delivered.
        if (forget(relayId)) await reply(client, envelope, { ok: false, errorCode: 'outcome_unknown', error: 'Agent delivery could not be confirmed; refresh before retrying' });
      }
      return true;
    },
    async response(agentId, msg) {
      if (msg?.type !== 'person_response') return false;
      const row = pending.get(msg.requestId);
      if (!row || row.agentId !== agentId || row.agent !== agentMap.get(agentId)) return true;
      forget(msg.requestId);
      if (!row.client.authenticated || (row.client.userId || (skipAuth() ? 'local-development' : null)) !== row.ownerId
        || accessError(agentId, row.client.userId, row.client.role)) return true;
      // Whitelist the response. Echoed owner/agent/op/correlation fields are not trusted.
      await reply(row.client, row.envelope, msg.ok === true
        ? { ok: true, data: msg.data }
        : { ok: false,
          errorCode: ['outcome_unknown', 'invalid_request', 'busy', 'unsupported', 'not_configured', 'not_open', 'stale', 'idempotency_conflict'].includes(msg.errorCode) ? msg.errorCode : 'requestFailed',
          error: typeof msg.error === 'string' ? msg.error.slice(0, 500) : 'Digital person request failed' });
      return true;
    },
    clearClient(client) {
      for (const [id, row] of pending) if (row.client === client) forget(id);
    },
    close() { for (const id of pending.keys()) forget(id); },
  };
}

const relay = createPersonRelay();
export const handleClientPerson = (client, msg) => relay.request(client, msg);
export const handleAgentPerson = (agentId, msg) => relay.response(agentId, msg);
export const clearPersonRequestsForClient = client => relay.clearClient(client);
