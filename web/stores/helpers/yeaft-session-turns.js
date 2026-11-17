import { isRetiredYeaftConversation } from './yeaft-conversation-generation.js';
import { yeaftSessionIdentityKey } from './yeaft-session-identity.js';

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
export const LIVE_SESSION_TURN_STATES = new Set(['routing', 'queued', 'running', 'cancelling', 'waiting', 'thinking', 'streaming', 'tool', 'retrying']);
const STATES = new Set(['routing', 'queued', 'running', 'cancelling', 'waiting', 'thinking', 'streaming', 'tool', 'retrying', 'interrupted', 'completed', 'stopped', 'aborted', 'error', 'errored']);

/** User-turn identity is independent of each VP's Engine.query() turnId. */
export function normalizeSessionTurn(row) {
  const userTurnId = id(row?.userTurnId);
  if (!userTurnId || !STATES.has(row.state)) return null;
  return {
    userTurnId,
    userMessageId: id(row.userMessageId) || userTurnId,
    startedAt: Number.isFinite(row.startedAt) ? row.startedAt : 0,
    state: row.state,
    executions: (Array.isArray(row.executions) ? row.executions : []).flatMap(execution => {
      if (!id(execution?.vpId)) return [];
      return [{ vpId: execution.vpId, threadId: id(execution.threadId), turnId: id(execution.turnId),
        state: STATES.has(execution.state) ? execution.state : row.state }];
    }),
  };
}

function acceptsEnvelope(store, msg) {
  return !!msg.agentId && !!msg.conversationId
    && !isRetiredYeaftConversation(store, msg.agentId, msg.conversationId)
    && (!store.yeaftConversationIdsByAgent?.[msg.agentId]
      || store.yeaftConversationIdsByAgent[msg.agentId] === msg.conversationId);
}

export function applySessionTurns(store, msg) {
  const event = msg.event;
  const sessionId = id(event?.sessionId || msg.sessionId);
  if (!sessionId || !acceptsEnvelope(store, msg) || !Array.isArray(event.turns)) return false;
  const key = yeaftSessionIdentityKey(msg.agentId, sessionId);
  const turns = event.turns.map(normalizeSessionTurn).filter(Boolean);
  store.yeaftSessionTurnsBySession = { ...store.yeaftSessionTurnsBySession, [key]: {
    agentId: msg.agentId, sessionId, conversationId: msg.conversationId,
    connectionGeneration: Number(store.chatHistoryConnectionGeneration || 0), turns,
  } };
  return true;
}

/** Route notifications may arrive before the optimistic echo/history row. */
export function applyUserMessageRoute(store, msg) {
  const event = msg.event;
  const sessionId = id(event?.sessionId || msg.sessionId);
  const messageId = id(event?.messageId);
  const userTurnId = id(event?.userTurnId);
  if (!sessionId || !messageId || !userTurnId || !acceptsEnvelope(store, msg)) return false;
  const key = yeaftSessionIdentityKey(msg.agentId, sessionId);
  const turnRelation = event.relation === 'supplement' ? 'supplement' : 'new';
  const routes = { ...(store.yeaftUserMessageRoutes?.[key] || {}), [messageId]: { userTurnId, turnRelation } };
  // Already-stamped rows own their metadata; this is only an arrival-order cache.
  const entries = Object.entries(routes).slice(-256);
  store.yeaftUserMessageRoutes = { ...store.yeaftUserMessageRoutes, [key]: Object.fromEntries(entries) };
  const rows = store.messagesMap?.[msg.conversationId] || [];
  let changed = false;
  for (const row of rows) {
    if ((row.sessionId ?? row.groupId) !== sessionId || row.type !== 'user') continue;
    if (![row.id, row.messageId, row.clientMessageId].includes(messageId)) continue;
    row.userTurnId = userTurnId;
    row.turnRelation = turnRelation;
    changed = true;
  }
  if (changed) store.messagesMap = { ...store.messagesMap, [msg.conversationId]: rows.slice() };
  return true;
}

export function userMessageRoute(store, agentId, sessionId, messageId) {
  const key = yeaftSessionIdentityKey(agentId, sessionId);
  return store.yeaftUserMessageRoutes?.[key]?.[messageId] || null;
}

export function clearSessionTurns(store, agentId = null, sessionId = null) {
  for (const field of ['yeaftSessionTurnsBySession', 'yeaftUserMessageRoutes']) {
    store[field] = Object.fromEntries(Object.entries(store[field] || {}).filter(([key]) => {
      if (sessionId) return key !== yeaftSessionIdentityKey(agentId, sessionId);
      if (agentId) return !key.startsWith(`${agentId}\u001f`);
      return false;
    }));
  }
}
