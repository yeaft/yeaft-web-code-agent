/**
 * Map a raw TodoWrite item to its display shape.
 *
 * 2026-05-18: previously this helper had a third pseudo-status `stale`
 * for "turn ended but todo still pending/in_progress", which rendered
 * a `!` mark and the literal "not updated before turn ended" next to
 * the row. That visual treatment was noisy and bled the agent's
 * internal bookkeeping (TodoWrite is the agent's own scratchpad) into
 * the user-facing UI — the typical reaction was "why is my chat
 * showing me exclamation marks". We are back to the simple semantics
 * that matched user expectation:
 *
 *   pending     → empty checkbox, content text
 *   in_progress → spinner,         activeForm (or content) text
 *   completed   → ✓,               content text
 *
 * The `turn` argument is kept in the signature so the call site in
 * AssistantTurn does not have to change, and so a future "turn ended"
 * concern can be added back without another API churn — but right now
 * the helper does not branch on it.
 */
export function getTodoDisplayState(_turn, todo) {
  const status = todo?.status || 'pending';
  return {
    ...todo,
    rawStatus: status,
    displayStatus: status,
    displayText: status === 'in_progress'
      ? (todo?.activeForm || todo?.content || '')
      : (todo?.content || ''),
  };
}
