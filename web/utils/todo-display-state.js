const UNFINISHED_TODO_STATUSES = new Set(['pending', 'in_progress']);

export function getTodoDisplayState(turn, todo) {
  const status = todo?.status || 'pending';
  const turnEnded = !turn?.isStreaming;
  const isStale = turnEnded && UNFINISHED_TODO_STATUSES.has(status);

  if (isStale) {
    return {
      ...todo,
      rawStatus: status,
      displayStatus: 'stale',
      displayText: todo?.content || '',
      staleLabel: 'not updated before turn ended'
    };
  }

  return {
    ...todo,
    rawStatus: status,
    displayStatus: status,
    displayText: status === 'in_progress' ? (todo?.activeForm || todo?.content || '') : (todo?.content || ''),
    staleLabel: ''
  };
}
