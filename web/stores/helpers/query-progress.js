import { isRetiredYeaftConversation } from './yeaft-conversation-generation.js';

const counters = ['revision', 'modelRequests', 'toolExecutions', 'reusedCalls', 'repeatedCalls', 'failedCalls', 'stagnantBatches'];
const runningStates = new Set(['typing', 'thinking', 'retrying', 'streaming', 'tool']);
const isAgentOnline = (store, agentId) => store.agents?.some(agent => agent.id === agentId && agent.online);

/** Agent↔Server disconnects do not change the browser's connection generation. */
export function invalidateOfflineQueryProgress(store) {
  const next = { ...store.activeVpTurns };
  for (const [key, row] of Object.entries(next)) {
    if (isAgentOnline(store, row.agentId)) continue;
    const { queryProgress: _progress, ...rest } = row;
    next[key] = { ...rest, connectionGeneration: -1 };
  }
  store.activeVpTurns = next;
}

function snapshotOwnsTurn(status, row) {
  if (status.vpId !== row.vpId || (status.sessionId || status.groupId) !== row.sessionId) return false;
  // Broker aggregate turnId/threadId name the latest updated thread, which
  // need not be the running one. An advertised thread list is authoritative.
  const threads = Array.isArray(status.threads) ? status.threads : [status];
  return threads.some(thread => thread && (thread.threadId || 'main') === row.threadId
    && thread.turnId === row.turnId && runningStates.has(thread.state));
}

/** Ephemeral metadata only. Never retain unknown fields from a wire event. */
export function normalizeQueryProgress(event) {
  if (!event || event.type !== 'query_progress'
      || !['turnId', 'threadId', 'sessionId', 'vpId'].every(key => typeof event[key] === 'string' && event[key].length > 0)
      || !counters.every(key => Number.isSafeInteger(event[key]) && event[key] >= 0)
      || event.revision < 1
      || !['running', 'warning', 'recovering', 'stopped'].includes(event.stage)
      || ![null, 'repeated_results', 'repeated_failure'].includes(event.reason)
      || !(event.lastEvidenceAt === null || (Number.isFinite(event.lastEvidenceAt) && event.lastEvidenceAt >= 0))) return null;
  const { turnId, threadId, sessionId, vpId, revision, modelRequests, toolExecutions, reusedCalls,
    repeatedCalls, failedCalls, stage, reason, lastEvidenceAt, stagnantBatches } = event;
  return { type: 'query_progress', turnId, threadId, sessionId, vpId, revision, modelRequests,
    toolExecutions, reusedCalls, repeatedCalls, failedCalls, stage, reason, lastEvidenceAt, stagnantBatches };
}

/** Progress can update a live owner, never open/revive a turn or a conversation. */
export function applyQueryProgress(store, msg) {
  const progress = normalizeQueryProgress(msg?.event);
  if (!progress || !msg.agentId || !msg.conversationId || store.connectionState !== 'connected'
      || !isAgentOnline(store, msg.agentId)
      || isRetiredYeaftConversation(store, msg.agentId, msg.conversationId)
      || store.yeaftConversationIdsByAgent?.[msg.agentId] !== msg.conversationId) return;
  const entry = Object.entries(store.activeVpTurns || {}).find(([, row]) => (
    row.agentId === msg.agentId && row.sessionId === progress.sessionId
    && row.turnId === progress.turnId && row.vpId === progress.vpId
    && row.threadId === progress.threadId && row.conversationId === msg.conversationId
    && row.connectionGeneration === Number(store.chatHistoryConnectionGeneration || 0)
  ));
  if (!entry || (entry[1].queryProgressRevision || 0) >= progress.revision) return;
  store.activeVpTurns = { ...store.activeVpTurns, [entry[0]]: {
    ...entry[1], queryProgress: progress, queryProgressRevision: progress.revision,
  } };
}

/** A fresh snapshot can re-authorize an existing turn after reconnect, not invent counters. */
export function reconcileQueryProgressSnapshot(store, msg) {
  if (!msg.agentId || !msg.conversationId || store.connectionState !== 'connected'
      || !isAgentOnline(store, msg.agentId)
      || store.yeaftConversationIdsByAgent?.[msg.agentId] !== msg.conversationId
      || isRetiredYeaftConversation(store, msg.agentId, msg.conversationId)) return;
  const generation = Number(store.chatHistoryConnectionGeneration || 0);
  const statuses = Array.isArray(msg.event.statuses) ? msg.event.statuses : [];
  const next = { ...store.activeVpTurns };
  for (const [key, row] of Object.entries(next)) {
    if (row.agentId !== msg.agentId || (msg.event.sessionId != null && row.sessionId !== msg.event.sessionId)) continue;
    const live = statuses.some(status => status && snapshotOwnsTurn(status, row));
    // Routine snapshots must not erase observations still owned by this live
    // turn. Reconnects can re-authorize ownership, but not restore old counters.
    if (live && row.connectionGeneration === generation && row.conversationId === msg.conversationId) continue;
    const { queryProgress: _progress, ...rest } = row;
    next[key] = { ...rest, connectionGeneration: live ? generation : -1,
      conversationId: msg.conversationId };
  }
  store.activeVpTurns = next;
}

export function visibleQueryProgress(store, { agentId, sessionId, turnId, vpId }) {
  if (store.connectionState !== 'connected' || !agentId || !sessionId || !isAgentOnline(store, agentId)) return null;
  const row = Object.values(store.activeVpTurns || {}).find(row => row.agentId === agentId
    && row.sessionId === sessionId && row.turnId === turnId && row.vpId === vpId
    && row.connectionGeneration === Number(store.chatHistoryConnectionGeneration || 0)
    && row.conversationId === store.yeaftConversationIdsByAgent?.[agentId]);
  return row?.queryProgress || null;
}
