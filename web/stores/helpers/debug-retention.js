/**
 * debug-retention.js — Pure helper for the Unify debug panel's count-based
 * retention bound.
 *
 * The Unify debug feature ships verbatim LLM raw request/response bodies to
 * the client (no per-payload truncation — see anthropic.js / openai-responses.js
 * onRawExchange and `redactRawRequest` in adapter.js). To keep memory bounded
 * we cap the *number* of loops retained per tab via MAX_UNIFY_DEBUG_LOOPS.
 *
 * When the cap is exceeded:
 *   1. Drop the oldest loop entries past the cap.
 *   2. Garbage-collect any turn record whose loops are all gone, so
 *      `turnsById` and `turnOrder` shrink in lockstep.
 *   3. ALWAYS preserve still-open turns (closedAt == null), even if no loop
 *      has been pushed for them yet — under multi-VP parallel ingest a
 *      `turn_open` for VP-A can land while VP-B is flooding loops; we must
 *      not orphan VP-A's first loop by evicting its empty turn record.
 *
 * Pure function: takes the current debug-state slices, returns the next
 * slices. No side effects, no Vue/Pinia coupling — unit-testable in isolation.
 */

/**
 * @param {{
 *   loops: Array<{ turnId?: string|null }>,
 *   turnsById: Record<string, { closedAt?: number|null }>,
 *   turnOrder: string[],
 *   maxLoops: number,
 * }} state
 * @returns {{
 *   loops: Array<{ turnId?: string|null }>,
 *   turnsById: Record<string, { closedAt?: number|null }>,
 *   turnOrder: string[],
 * }}
 */
export function trimDebugRetention({ loops, turnsById, turnOrder, maxLoops }) {
  if (!Array.isArray(loops) || loops.length <= maxLoops) {
    return { loops, turnsById, turnOrder };
  }
  const overflow = loops.length - maxLoops;
  const nextLoops = loops.slice(overflow);

  const liveTurnIds = new Set();
  for (const lp of nextLoops) {
    if (lp && lp.turnId) liveTurnIds.add(lp.turnId);
  }
  // Protect still-open turns whose first loop hasn't landed yet. Their
  // turn_open event arrived but no loop has come back through the bridge
  // — evicting them here would make the loop, when it arrives, reference
  // a turnId that's no longer in turnOrder/turnsById, and the panel would
  // silently drop the entire turn.
  for (const tid of turnOrder) {
    const turn = turnsById[tid];
    if (turn && turn.closedAt == null) liveTurnIds.add(tid);
  }

  const nextTurnsById = {};
  for (const tid of Object.keys(turnsById)) {
    if (liveTurnIds.has(tid)) {
      nextTurnsById[tid] = turnsById[tid];
    }
  }
  const nextTurnOrder = turnOrder.filter(tid => liveTurnIds.has(tid));

  return {
    loops: nextLoops,
    turnsById: nextTurnsById,
    turnOrder: nextTurnOrder,
  };
}
