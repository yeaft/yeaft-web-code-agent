import { randomUUID } from 'crypto';
import { CONFIG } from '../config.js';
import { userDb, yeaftSessionDb } from '../database.js';
import { agents, webClients } from '../context.js';
import { sendToAgent, sendToWebClient } from '../ws-utils.js';

const DELETE = 'yeaft_session_delete_turn';
// Unprefixed by design: older Servers only relay unknown yeaft_/unify_ types.
const AUTHORIZED_DELETE = 'session_turn_delete_authorized';
const RESULT = 'yeaft_session_delete_turn_result';
const DELETED = 'yeaft_session_turn_deleted';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PENDING = 1024;
const MAX_PENDING_PER_CLIENT = 16;
const pending = new Map();

function validAgentId(id) {
  // Legacy Agent instance names can contain spaces/Unicode; the registered
  // map key is opaque, not a path. Never normalize it into a different key.
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    && id === id.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(id);
}

function validSessionId(id) {
  // Match the native Session IDs accepted by the Agent's filesystem boundary.
  return typeof id === 'string' && id.length <= 128
    && /^session_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !/\s/.test(id);
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 160
    && !/[^A-Za-z0-9_.:-]/.test(id);
}

function ownsSession(agentId, agent, sessionId, userId) {
  // Admin access to an ownerless Agent and SKIP_AUTH are not proof of Session
  // ownership. Local run still works with its durable dev-user Agent owner.
  return !!userId && agent?.ownerId === userId
    && !!yeaftSessionDb.getForAgent(userId, agentId, sessionId);
}

function forget(requestId) {
  const request = pending.get(requestId);
  if (!request) return null;
  pending.delete(requestId);
  clearTimeout(request.timer);
  return request;
}

export function clearSessionTurnDeletesForClient(clientId) {
  for (const [requestId, request] of pending) {
    if (request.clientId === clientId) forget(requestId);
  }
}

async function deliver(client, payload) {
  try { await sendToWebClient(client, payload); }
  catch (error) { console.warn(`[Server] Failed to deliver ${payload.type}:`, error.message); }
}

export async function handleClientSessionTurnDelete(clientId, client, msg) {
  const type = msg.type.startsWith('unify_') ? `yeaft_${msg.type.slice(6)}` : msg.type;
  // Agent-only frames must also be reserved before the generic yeaft/unify
  // relay. Only the canonical operation is sent to the Agent.
  if (type === AUTHORIZED_DELETE || type === RESULT || type === DELETED) return true;
  if (type !== DELETE) return false;
  if (!client.authenticated || !client.userId) return true;

  const { agentId, sessionId, requestId, messageId } = msg;
  const reply = {
    type: RESULT,
    agentId: validAgentId(agentId) ? agentId : null,
    sessionId: validSessionId(sessionId) ? sessionId : null,
    requestId: validId(requestId) ? requestId : null,
  };
  const reject = (errorCode, error) => deliver(client, { ...reply, ok: false, errorCode, error });
  const agent = agents.get(agentId);
  if (!reply.agentId || !reply.sessionId || !reply.requestId || !validId(messageId)) {
    await reject('invalid_request', 'An explicit Agent, native Session, request and message ID are required.');
  } else if (!agent || agent.ws?.readyState !== 1) {
    await reject('agent_unavailable', 'The selected Agent is offline.');
  } else if (!ownsSession(agentId, agent, sessionId, client.userId)) {
    await reject('agent_access_denied', 'Only the Session owner can delete a turn.');
  } else if (!agent.capabilities?.includes('session_delete_turn')) {
    await reject('session_delete_turn_unsupported', 'The selected Agent does not support deleting Session turns.');
  } else {
    let clientPending = 0;
    for (const request of pending.values()) {
      if (request.clientId !== clientId) continue;
      if (request.reply.agentId === agentId && request.reply.sessionId === sessionId && request.reply.requestId === requestId) {
        return true; // An identical correlation is already awaiting its result.
      }
      clientPending++;
    }
    if (pending.size >= MAX_PENDING || clientPending >= MAX_PENDING_PER_CLIENT) {
      await reject('too_many_requests', 'Too many turn deletions are awaiting a result.');
      return true;
    }
    // Use a Server correlation, not an Agent-echoed browser client ID or a
    // collision-prone Web request ID shared by multiple tabs.
    const relayRequestId = randomUUID();
    const timer = setTimeout(() => {
      if (!forget(relayRequestId)) return;
      if (webClients.get(clientId) !== client || !client.authenticated) return;
      void reject('request_timeout', 'No deletion result received. Refresh the Session before retrying.');
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    pending.set(relayRequestId, { clientId, userId: client.userId, reply, timer });
    try {
      // The Agent must execute only this internal type, never the browser
      // DELETE type (which older Servers can forward without this check).
      if (await sendToAgent(agent, { type: AUTHORIZED_DELETE, agentId, sessionId, requestId: relayRequestId, messageId })) return true;
    } catch { /* Settle a failed dispatch with its original Web correlation. */ }
    if (forget(relayRequestId)) {
      await reject('agent_unavailable', 'Agent delivery could not be confirmed. Refresh the Session before retrying.');
    }
  }
  return true;
}

export async function handleAgentSessionTurnDelete(agentId, agent, msg) {
  if (msg.type !== RESULT && msg.type !== DELETED) return false;
  if (!validSessionId(msg.sessionId) || agents.get(agentId) !== agent) return true;
  const ownerId = agent.ownerId;
  if (!ownsSession(agentId, agent, msg.sessionId, ownerId)
      || (!CONFIG.skipAuth && !userDb.isActive(ownerId))) return true;

  // Agent IDs come from the authenticated socket, never from the payload.
  const deletedIds = Array.isArray(msg.deletedMessageIds) && msg.deletedMessageIds.every(validId)
    ? { deletedMessageIds: msg.deletedMessageIds } : {};
  // The Agent supplies the same safe, opaque event identity in both frames.
  // It need not expose the canonical user turn ID from the transcript.
  const turnIdentity = validId(msg.turnId) ? { turnId: msg.turnId } : null;
  if (msg.type === RESULT) {
    const request = pending.get(msg.requestId);
    if (!request || request.reply.agentId !== agentId || request.reply.sessionId !== msg.sessionId
        || request.userId !== ownerId || typeof msg.ok !== 'boolean') return true;
    forget(msg.requestId);
    const requester = webClients.get(request.clientId);
    if (requester?.authenticated && requester.userId === ownerId) {
      await deliver(requester, {
        ...request.reply,
        ok: msg.ok,
        ...(msg.ok ? { ...turnIdentity, ...deletedIds } : {
          ...(validId(msg.errorCode) ? { errorCode: msg.errorCode } : {}),
          ...(typeof msg.error === 'string' ? { error: msg.error.slice(0, 512) } : {}),
        }),
      });
    }
  } else if (turnIdentity) {
    // This is a separate, bufferable Agent event, not an ACK. An Agent may
    // flush it after reconnect even if the original browser has gone away.
    // Offline browsers recover from the Agent's authoritative history, just
    // as for other live Session events.
    const update = { type: DELETED, agentId, sessionId: msg.sessionId, ...turnIdentity, ...deletedIds };
    await Promise.all([...webClients.values()]
      .filter(client => client.authenticated && client.userId === ownerId)
      .map(client => deliver(client, update)));
  }
  return true;
}
