export const YEAFT_RUNNING_VP_STATES = new Set(['typing', 'thinking', 'retrying', 'streaming', 'tool']);

/** Broker aggregates name the latest updated thread, not necessarily a live one. */
export function statusOwnsRunningTurn(status, turn) {
  if (!status || status.vpId !== turn.vpId
      || (status.sessionId || status.groupId || null) !== turn.sessionId) return false;
  const threads = Array.isArray(status.threads) ? status.threads : [status];
  return threads.some(thread => thread && (thread.threadId || 'main') === (turn.threadId || 'main')
    && thread.turnId === turn.turnId && YEAFT_RUNNING_VP_STATES.has(thread.state));
}

/**
 * A status-only reconciliation proves a turn is no longer live, not that it
 * succeeded. Keep completed evidence intact and stop unfinished rows without
 * inventing a successful result when the terminal frame was missed.
 */
export function stopOrphanedTurnMessages(store, turn, conversationId = null) {
  const convId = conversationId || turn.conversationId || store.yeaftConversationIdsByAgent?.[turn.agentId];
  const rows = store.messagesMap?.[convId];
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || row.turnId !== turn.turnId
        || (row.sessionId ?? row.groupId ?? null) !== turn.sessionId
        || (row.agentId && row.agentId !== turn.agentId)
        || ((row.speakerVpId || row.vpId) && (row.speakerVpId || row.vpId) !== turn.vpId)) continue;
    row.isStreaming = false;
    if (row.type === 'assistant' && (!row.status || row.status === 'pending')) {
      row.status = 'aborted';
      row.turnEndReason = 'aborted';
      row.turnEndAt = Date.now();
      row.turnEndDetail = { code: 'runtime_reconciled' };
    }
  }
}
