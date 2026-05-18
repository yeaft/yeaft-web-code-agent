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
 *
 * Do NOT inline this back into the template just because the body
 * looks short: the helper owns three things the template should not
 * — (1) the `status || 'pending'` fallback when the agent omits it,
 * (2) the `activeForm || content` fallback for in_progress, and
 * (3) the spread-then-overlay that produces a fresh display object
 * so the raw reactive todo from claudeOutput.js stays immutable.
 *
 * The underlying TodoWrite lifecycle concerns from PR #780 (todos
 * disappearing mid-turn / todos lingering after turn-end) are still
 * open and intentionally not addressed here — the revert is UI-only.
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
