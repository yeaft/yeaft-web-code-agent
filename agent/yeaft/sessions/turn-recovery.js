import { isVisibleConversationRow } from '../conversation/internal-control.js';

// Native coordinator roots carry both provenance and an explicit 'new' routing
// decision. Older user rows and supplements do not imply an execution was owed.
function isNativeRoot(row) {
  const local = !row.origin || (row.origin.sessionId === row.sessionId && row.origin.messageId === row.id);
  return row.role === 'user' && local && row.userAuthored === true && row.relation === 'new'
    && isVisibleConversationRow(row);
}

/**
 * Merge a chronological durable Session window into the reconnect projection.
 * This is display-only: do not enqueue, persist, or synthesize an execution.
 * An existing runtime root (even before its first execution registers) owns its
 * state. Unkeyed replies are not evidence for the nearest user's turn.
 */
export function hydratePersistedSessionTurns(turns, rows) {
  const roots = new Map(rows.filter(row => row.userTurnId && isNativeRoot(row))
    .map(row => [row.id, row.userTurnId]));
  const runtimeRoots = new Set([...turns].filter(([, turn]) => !turn.recoveredFromHistory).map(([id]) => id));
  const knownExecutions = new Set([...turns.values()].flatMap(turn => [...turn.executions.keys()]));
  const nativeRoots = new Set();
  const evidence = new Set();
  for (const row of rows) {
    const userTurnId = row.userTurnId || roots.get(row.causalRootId);
    if (!userTurnId) continue;
    if (isNativeRoot(row)) nativeRoots.add(userTurnId);
    const rowTime = Date.parse(row.time || row.ts);
    let turn = turns.get(userTurnId);
    if (!turn) {
      turn = { userTurnId, userMessageId: userTurnId, startedAt: rowTime || Date.now(), state: 'completed',
        executions: new Map(), recoveredFromHistory: true };
      turns.set(userTurnId, turn);
    }
    if (row.turnId || (row.role === 'assistant' && isVisibleConversationRow(row))) evidence.add(userTurnId);
    if (rowTime > 0) turn.lastActivityAt = Math.max(turn.lastActivityAt || 0, rowTime);
    if (row.turnId && !knownExecutions.has(row.turnId)) {
      const state = row.incomplete ? 'interrupted' : 'completed';
      turn.executions.set(row.turnId, { vpId: row.speakerVpId || null, threadId: row.threadId || 'main',
        turnId: row.turnId, state });
      if (!runtimeRoots.has(userTurnId)) turn.state = state;
    }
  }
  for (const userTurnId of nativeRoots) {
    const turn = turns.get(userTurnId);
    if (runtimeRoots.has(userTurnId) || turn.executions.size) continue;
    turn.state = evidence.has(userTurnId) ? 'completed' : 'interrupted';
  }
}
