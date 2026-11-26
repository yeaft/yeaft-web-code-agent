import { randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { agents, webClients } from '../context.js';
import { userDb, yeaftProjectDb, yeaftSessionDb } from '../database.js';
import { resolveAgentAccessError, sendToAgent, sendToWebClient } from '../ws-utils.js';

const RETRY = 'yeaft_session_retry';
// Unprefixed, so an older Server's generic yeaft_* relay cannot mint this frame.
const AUTHORIZED_RETRY = 'session_turn_retry_authorized';
export const SESSION_RETRY_RESULT = 'yeaft_session_retry_result';
const MAX_PENDING = 1024;
const MAX_PENDING_PER_CLIENT = 16;
const RESULT_TIMEOUT_MS = 60_000;
const pending = new Map();

function isIdentifier(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function ownsSession(userId, agentId, agent, sessionId) {
  // Neither global admin access nor skipAuth establishes Session ownership.
  return !!userId && agent?.ownerId === userId && yeaftSessionDb.getForAgent(userId, agentId, sessionId)?.isArchived === false;
}

function requestKey(clientId, agentId, requestId) {
  return JSON.stringify([clientId, agentId, requestId]);
}

function forget(key, entry) {
  if (pending.get(key) !== entry) return false;
  pending.delete(key);
  clearTimeout(entry.timer);
  return true;
}

export function clearSessionTurnRetriesForClient(clientId) {
  for (const [key, entry] of pending) {
    if (entry.clientId === clientId) forget(key, entry);
  }
}

/** Validate and authorize before forwarding; browser metadata cannot establish authority. */
export async function handleClientSessionTurnRetry(clientId, client, msg) {
  // Reserve aliases too so they cannot fall through to the generic relay.
  if ([AUTHORIZED_RETRY, SESSION_RETRY_RESULT, 'unify_session_retry_result', 'unify_session_retry'].includes(msg.type)) return true;
  if (msg.type !== RETRY) return false;
  if (!client.authenticated || !client.userId) return true;

  const { agentId, sessionId, turnId, mode, requestId, retryToken } = msg;
  const reply = {
    type: SESSION_RETRY_RESULT,
    agentId: isIdentifier(agentId, 256) ? agentId : null,
    sessionId: isIdentifier(sessionId, 128) && /^session_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) ? sessionId : null,
    turnId: isIdentifier(turnId, 256) ? turnId : null,
    requestId: isIdentifier(requestId, 160) ? requestId : null,
  };
  const reject = error => sendToWebClient(client, { ...reply, ok: false, error });
  if (!isIdentifier(agentId, 256) || !reply.sessionId || !reply.turnId || !reply.requestId
      || !isIdentifier(retryToken, 512) || (mode !== 'plain' && mode !== 'compact')) {
    await reject('An explicit Agent, native Session, turn, request ID, retry token and valid mode are required.');
    return true;
  }

  const agent = agents.get(agentId);
  const accessError = resolveAgentAccessError(agentId, client.userId, client.role);
  if (accessError === 'Agent access denied' || (agent && !ownsSession(client.userId, agentId, agent, sessionId))) {
    await reject('Only the Agent and Session owner can retry a turn.');
  } else if (accessError) {
    await reject('The selected Agent is offline.');
  } else if (!Array.isArray(agent.capabilities) || !agent.capabilities.includes('session_turn_retry')) {
    await reject('The selected Agent does not support Session turn retry.');
  } else {
    const key = requestKey(clientId, agentId, requestId);
    if (pending.has(key)) return true; // Already dispatched on this socket.
    let clientPending = 0;
    for (const entry of pending.values()) if (entry.clientId === clientId) clientPending++;
    if (pending.size >= MAX_PENDING || clientPending >= MAX_PENDING_PER_CLIENT) {
      await reject('Too many Session turn retries are awaiting a result.');
      return true;
    }

    const entry = { agent, client, clientId, userId: client.userId, reply, dispatchId: randomUUID() };
    entry.timer = setTimeout(() => {
      if (!forget(key, entry) || webClients.get(clientId) !== client || !client.authenticated
          || client.userId !== entry.userId) return;
      void reject('No retry result received. Refresh the Session before retrying again.')
        .catch(error => console.warn('[Server] Could not deliver Session retry timeout:', error.message));
    }, RESULT_TIMEOUT_MS);
    entry.timer.unref();
    pending.set(key, entry);
    try {
      const projectContext = yeaftProjectDb.contextForSession(client.userId, agentId, sessionId) || { sessionIds: [] };
      if (await sendToAgent(agent, { type: AUTHORIZED_RETRY, agentId, sessionId, turnId, mode, requestId, retryToken,
        _requestClientId: clientId, _dispatchId: entry.dispatchId, _projectContext: projectContext })) return true;
    } catch { /* Settle failed dispatch with the original correlation. */ }
    if (forget(key, entry)) await reject('The selected Agent is offline or delivery could not be confirmed.');
  }
  return true;
}

/** Settle only a matched request from the original authenticated Agent connection. */
export async function routeSessionTurnRetryResult(agentId, agent, msg) {
  const { sessionId, turnId, requestId, ok, error, _requestClientId: clientId } = msg;
  if (agents.get(agentId) !== agent || typeof ok !== 'boolean'
      || !isIdentifier(clientId, 256) || !isIdentifier(requestId, 160)) return;
  const key = requestKey(clientId, agentId, requestId);
  const entry = pending.get(key);
  if (!entry || entry.agent !== agent || entry.dispatchId !== msg._dispatchId || entry.reply.sessionId !== sessionId || entry.reply.turnId !== turnId) return;
  forget(key, entry);
  const { client, userId, reply } = entry;
  if (webClients.get(clientId) !== client || !client.authenticated || client.userId !== userId
      || (!CONFIG.skipAuth && !userDb.isActive(userId)) || !ownsSession(userId, agentId, agent, sessionId)) return;

  await sendToWebClient(client, {
    ...reply, ok,
    ...(!ok && typeof error === 'string' ? { error: error.slice(0, 512) } : {}),
  });
}
