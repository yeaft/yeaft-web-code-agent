import { isRetiredYeaftConversation } from './yeaft-conversation-generation.js';

const counters = ['revision', 'modelRequests', 'toolExecutions', 'reusedCalls', 'repeatedCalls', 'failedCalls', 'stagnantBatches'];

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
  if (!msg.agentId || !msg.conversationId
      || store.yeaftConversationIdsByAgent?.[msg.agentId] !== msg.conversationId
      || isRetiredYeaftConversation(store, msg.agentId, msg.conversationId)) return;
  const next = { ...store.activeVpTurns };
  for (const [key, row] of Object.entries(next)) {
    if (row.agentId !== msg.agentId || (msg.event.sessionId && row.sessionId !== msg.event.sessionId)) continue;
    const status = (msg.event.statuses || []).find(status => status.turnId === row.turnId
      && status.vpId === row.vpId && (status.sessionId || status.groupId) === row.sessionId
      && !['idle', 'offline', 'completed', 'failed', 'aborted', 'error'].includes(status.state));
    const { queryProgress: _progress, ...rest } = row;
    next[key] = { ...rest, connectionGeneration: status ? Number(store.chatHistoryConnectionGeneration || 0) : -1,
      conversationId: msg.conversationId };
  }
  store.activeVpTurns = next;
}

export function visibleQueryProgress(store, { agentId, sessionId, turnId, vpId }) {
  if (store.connectionState !== 'connected' || !agentId || !sessionId) return null;
  const row = Object.values(store.activeVpTurns || {}).find(row => row.agentId === agentId
    && row.sessionId === sessionId && row.turnId === turnId && row.vpId === vpId
    && row.connectionGeneration === Number(store.chatHistoryConnectionGeneration || 0)
    && row.conversationId === store.yeaftConversationIdsByAgent?.[agentId]);
  return row?.queryProgress || null;
}
