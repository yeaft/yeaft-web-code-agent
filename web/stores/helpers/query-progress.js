import { clearLiveSessionTools } from './session-tool-details.js';
import { isRetiredYeaftConversation } from './yeaft-conversation-generation.js';
import { statusOwnsRunningTurn } from './yeaft-runtime-state.js';
import { yeaftTurnIdentityKey } from './yeaft-session-identity.js';

const counters = ['revision', 'modelRequests', 'toolExecutions', 'reusedCalls', 'repeatedCalls', 'failedCalls', 'stagnantBatches'];
const isAgentOnline = (store, agentId) => store.agents?.some(agent => agent.id === agentId && agent.online);

/** Agent↔Server disconnects do not change the browser's connection generation. */
export function invalidateOfflineQueryProgress(store) {
  const next = { ...store.activeVpTurns };
  for (const [key, row] of Object.entries(next)) {
    if (isAgentOnline(store, row.agentId)) continue;
    next[key] = { ...row, connectionGeneration: -1 };
  }
  store.activeVpTurns = next;
  store.yeaftQueryProgressByTurn = Object.fromEntries(Object.entries(store.yeaftQueryProgressByTurn || {})
    .filter(([, row]) => isAgentOnline(store, row.agentId)));
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
  const extra = {};
  for (const key of ['inputTokens', 'outputTokens']) {
    if (Number.isSafeInteger(event[key]) && event[key] >= 0) extra[key] = event[key];
  }
  // Bounded, metadata-only diagnostics. Never retain arguments, output or errors.
  if (Array.isArray(event.toolStats) && event.toolStats.length <= 128) {
    const names = new Set();
    const valid = event.toolStats.every(row => row && typeof row.name === 'string'
      && /^[^\u0000-\u001f\u007f]{1,128}$/.test(row.name) && row.name.trim() === row.name
      && !names.has(row.name) && names.add(row.name)
      && ['executions', 'failedCalls', 'blockedCalls'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
      && row.blockedCalls <= row.failedCalls);
    if (valid) {
      extra.toolStats = event.toolStats.map(({ name, executions, failedCalls, blockedCalls }) => ({ name, executions, failedCalls, blockedCalls }));
      if (typeof event.toolStatsTruncated === 'boolean') extra.toolStatsTruncated = event.toolStatsTruncated;
    }
  }
  return { type: 'query_progress', turnId, threadId, sessionId, vpId, revision, modelRequests,
    toolExecutions, reusedCalls, repeatedCalls, failedCalls, stage, reason, lastEvidenceAt, stagnantBatches, ...extra };
}

const keyFor = (agentId, conversationId, turnId) => JSON.stringify([agentId, conversationId, turnId]);
const generationOf = store => Number(store.chatHistoryConnectionGeneration || 0);
const belongsTo = (row, agentId, conversationId, generation) => row?.agentId === agentId
  && row.conversationId === conversationId && row.connectionGeneration === generation;
const sameExecution = (row, turn) => row.sessionId === turn.sessionId && row.vpId === turn.vpId
  && row.turnId === turn.turnId && (row.threadId || 'main') === (turn.threadId || 'main');

function hasLiveOwner(store, agentId, conversationId, turn) {
  const generation = generationOf(store);
  const owner = store.activeVpTurns?.[yeaftTurnIdentityKey(agentId, turn.turnId)]
    || store.activeVpTurns?.[turn.turnId];
  // If a known start was invalidated on disconnect, only a broker snapshot
  // can re-authorize it, not a buffered incremental frame.
  if (owner?.agentId === agentId && owner.conversationId === conversationId) {
    return belongsTo(owner, agentId, conversationId, generation) && sameExecution(owner, turn);
  }
  // A tab opened mid-turn can use authoritative thread inventory without
  // manufacturing a turn-start, a streaming message, or a Stop target.
  return Object.values(store.vpStatuses || {}).some(status =>
    belongsTo(status, agentId, conversationId, generation) && Array.isArray(status.threads)
    && statusOwnsRunningTurn(status, turn));
}

/** Observations cannot open/revive a turn or a conversation. */
export function applyQueryProgress(store, msg) {
  const progress = normalizeQueryProgress(msg?.event);
  const { agentId, conversationId } = msg || {};
  if (!progress || !agentId || !conversationId || store.connectionState !== 'connected'
      || !isAgentOnline(store, agentId) || isRetiredYeaftConversation(store, agentId, conversationId)
      || store.yeaftConversationIdsByAgent?.[agentId] !== conversationId
      || ['sessionId', 'vpId', 'turnId', 'threadId'].some(key => msg[key] != null && msg[key] !== progress[key])
      || !hasLiveOwner(store, agentId, conversationId, progress)) return;
  const key = keyFor(agentId, conversationId, progress.turnId);
  if (store._yeaftEndedQueryExecutions?.[key]) return;
  const connectionGeneration = generationOf(store);
  const existing = store.yeaftQueryProgressByTurn?.[key];
  if (existing && (!sameExecution(existing.progress, progress)
      || (existing.connectionGeneration === connectionGeneration && existing.progress.revision >= progress.revision))) return;
  store.yeaftQueryProgressByTurn = { ...store.yeaftQueryProgressByTurn, [key]: {
    agentId, conversationId, connectionGeneration, progress,
  } };
}

/** Retire only display metadata. Neither these counters nor their terminal
 * fence participate in Session processing or Stop authorization. */
export function retireQueryProgress(store, agentId, conversationId, turnIds) {
  if (!agentId || !conversationId || store.yeaftConversationIdsByAgent?.[agentId] !== conversationId || !turnIds.length) return;
  clearLiveSessionTools(store, { agentId, conversationId, turnIds: new Set(turnIds) });
  const ended = { ...store._yeaftEndedQueryExecutions };
  const pending = { ...store.yeaftQueryProgressByTurn };
  for (const turnId of turnIds) {
    if (typeof turnId !== 'string' || !turnId || turnId.length > 256) continue;
    const key = keyFor(agentId, conversationId, turnId);
    delete pending[key];
    delete ended[key];
    ended[key] = true;
  }
  store.yeaftQueryProgressByTurn = pending;
  store._yeaftEndedQueryExecutions = Object.fromEntries(Object.entries(ended).slice(-512));
}

/** Re-authorize known starts, and recover counts only for exact live threads.
 * Do not change runtime ownership for a tab that missed vp_turn_start. */
export function reconcileQueryProgressSnapshot(store, msg, statuses) {
  const { agentId, conversationId, event } = msg;
  if (!agentId || !conversationId || store.connectionState !== 'connected'
      || !isAgentOnline(store, agentId) || store.yeaftConversationIdsByAgent?.[agentId] !== conversationId
      || isRetiredYeaftConversation(store, agentId, conversationId)) return;
  const generation = generationOf(store);
  const scoped = row => event.sessionId == null || row.sessionId === event.sessionId;
  const owns = turn => statuses.some(status => statusOwnsRunningTurn(status, turn));
  const next = { ...store.activeVpTurns };
  for (const [key, row] of Object.entries(next)) {
    if (row.agentId !== agentId || !scoped(row)) continue;
    next[key] = { ...row, connectionGeneration: owns(row) ? generation : -1, conversationId };
  }
  store.activeVpTurns = next;
  for (const progress of Array.isArray(event.queryProgress) ? event.queryProgress : []) {
    if (progress && scoped(progress) && owns(progress)) applyQueryProgress(store, { agentId, conversationId, event: progress });
  }
}

/** Display-only fence for an exact terminal execution, even if an old status snapshot arrives later. */
export const isQueryExecutionSettled = (store, agentId, conversationId, turnId) =>
  !!store._yeaftEndedQueryExecutions?.[keyFor(agentId, conversationId, turnId)];

/** Fence explicit settlements, not absences: an older empty snapshot or an
 * older broker without an exact terminal ID cannot prove a turn ended. */
export function retireSettledQueryProgress(store, agentId, conversationId, statuses) {
  const turnIds = new Set();
  for (const status of statuses) {
    if (!(status?.sessionId || status?.groupId) || !status?.vpId) continue;
    for (const thread of Array.isArray(status.threads) ? status.threads : [status]) {
      if (!thread) continue;
      const state = thread.state || thread.status;
      if (state !== 'idle' && state !== 'error') continue;
      const turnId = thread.settledTurnId || (state === 'error' ? thread.turnId : null);
      if (turnId) turnIds.add(turnId);
    }
  }
  retireQueryProgress(store, agentId, conversationId, [...turnIds]);
}

/** Drop observations absent from authoritative runtime reconciliation. */
export function pruneQueryProgress(store, agentId, conversationId, { sessionId, vpId } = {}) {
  store.yeaftQueryProgressByTurn = Object.fromEntries(Object.entries(store.yeaftQueryProgressByTurn || {}).filter(([, row]) =>
    row.agentId !== agentId || (sessionId != null && row.progress.sessionId !== sessionId)
    || (vpId != null && row.progress.vpId !== vpId)
    || (row.conversationId === conversationId && hasLiveOwner(store, agentId, conversationId, row.progress))));
}

export function visibleQueryProgress(store, agentId, conversationId, execution) {
  const entry = store.yeaftQueryProgressByTurn?.[keyFor(agentId, conversationId, execution.turnId)];
  return belongsTo(entry, agentId, conversationId, generationOf(store)) && sameExecution(entry.progress, execution)
    ? entry.progress : null;
}
