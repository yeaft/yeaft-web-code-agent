/**
 * compact/partition.js — Hot-window budget partitioning utilities.
 *
 * (Renamed from `agent/yeaft/memory/consolidate.js` on 2026-06-09.) The
 * legacy "consolidate" name and the `memory/` location both pointed at
 * a single concept — Layer-A memory consolidation — that has since been
 * cleanly split:
 *
 *   - Memory consolidation / system-prompt maintenance is owned by
 *     Dream V2 (per-group diff -> triage -> merge by target scope ->
 *     apply via segment-store + summary-store). NONE of that lives here.
 *
 *   - Conversation history compaction (the thing this file ACTUALLY
 *     serves) is owned by `compact/orchestrator.js`. The two functions
 *     below — `shouldConsolidate` (kept as the export name only because
 *     callers already use it; the role is "should we trigger a compact
 *     pass") and `partitionMessages` (hot/cold split by token budget)
 *     are pure helpers for that orchestrator.
 *
 * Why the move matters: keeping these under `memory/` invited the next
 * person to think "this is part of the memory subsystem" and reach for
 * it during a Dream-v2 patch — the exact category error
 * `DESIGN-COMPACT-VS-DREAM.md` (sibling doc) warns against. Putting
 * them next to `compact/orchestrator.js` makes the ownership obvious
 * from the file tree.
 */

// ─── Constants ──────────────────────────────────────────────────

/** Default MESSAGE_TOKEN_BUDGET for hot message compaction. */
export const DEFAULT_MESSAGE_TOKEN_BUDGET = 32768;

/** After compact, keep this fraction of the budget. */
export const COMPACT_KEEP_RATIO = 0.4;

/** Minimum messages to keep hot (newest). */
const MIN_KEEP_MESSAGES = 3;

/**
 * Check if a compact pass should be triggered.
 *
 * Name kept as `shouldConsolidate` for back-compat with the engine
 * caller; semantically this is the "is the hot window over budget?"
 * predicate that gates `compact/orchestrator.js`.
 *
 * @param {import('../conversation/persist.js').ConversationStore} conversationStore
 * @param {number} [budget] — MESSAGE_TOKEN_BUDGET
 * @returns {boolean}
 */
export function shouldConsolidate(conversationStore, budget = DEFAULT_MESSAGE_TOKEN_BUDGET) {
  const hotTokens = conversationStore.hotTokens();
  return hotTokens > budget;
}

/**
 * Determine which messages to archive (move to cold).
 * Strategy: from oldest, accumulate tokens until remaining ≤ budget * 40%.
 * Always keep at least MIN_KEEP_MESSAGES.
 *
 * @param {object[]} messages — all hot messages, sorted chronologically
 * @param {number} budget — MESSAGE_TOKEN_BUDGET
 * @returns {{ toArchive: object[], toKeep: object[] }}
 */
export function partitionMessages(messages, budget = DEFAULT_MESSAGE_TOKEN_BUDGET) {
  if (messages.length <= MIN_KEEP_MESSAGES) {
    return { toArchive: [], toKeep: messages };
  }

  const keepBudget = Math.floor(budget * COMPACT_KEEP_RATIO);

  // Work backwards from newest: accumulate tokens until we hit keepBudget
  let keepTokens = 0;
  let keepStart = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = messages[i].tokens_est || 0;
    if (keepTokens + msgTokens > keepBudget && (messages.length - i) >= MIN_KEEP_MESSAGES) {
      keepStart = i + 1;
      break;
    }
    keepTokens += msgTokens;
    if (i === 0) keepStart = 0;
  }

  // Ensure at least MIN_KEEP_MESSAGES are kept
  keepStart = Math.min(keepStart, messages.length - MIN_KEEP_MESSAGES);
  keepStart = Math.max(keepStart, 0);

  return {
    toArchive: messages.slice(0, keepStart),
    toKeep: messages.slice(keepStart),
  };
}
