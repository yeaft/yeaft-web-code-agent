/**
 * Map a raw TodoWrite item to its display shape.
 *
 * TodoWrite rows are snapshots from the agent's scratchpad. While a turn is
 * streaming, `in_progress` means exactly that: show activeForm and a spinner.
 * Once the owning assistant turn is terminal, a lingering `in_progress` row is
 * stale bookkeeping, not live work. Render it as a neutral stopped row so the
 * UI never claims the VP is still executing after the turn ended.
 */
export function getTodoDisplayState(turn, todo) {
  const status = todo?.status || 'pending';
  const isTurnTerminal = !!turn && turn.isStreaming !== true;
  const isStaleInProgress = status === 'in_progress' && isTurnTerminal;
  const displayStatus = isStaleInProgress ? 'stopped' : status;

  return {
    ...todo,
    rawStatus: status,
    displayStatus,
    displayText: displayStatus === 'in_progress'
      ? (todo?.activeForm || todo?.content || '')
      : (todo?.content || ''),
  };
}
