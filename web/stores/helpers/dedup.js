// Shared dedup helpers for user messages.
//
// fix-usermsg-dup / Review I2 (Fowler): the rule "prefer clientMessageId
// equality; fall back to content-equality only when neither side has an
// id" was previously implemented in 4 places (assistantOutput live-echo
// dedup, conversationHandler sync-replay orphan merge, plus the test
// mirror). Extracting the contract makes the dedup gates impossible to
// drift apart silently — a regression in one gate breaks every gate.

/**
 * Identity check for two user-message rows. Returns true if they
 * represent the same logical send.
 *
 * @param {{type: string, clientMessageId?: string|null, content?: string}} a
 * @param {{type: string, clientMessageId?: string|null, content?: string}} b
 * @returns {boolean}
 */
export function sameUserMessage(a, b) {
  if (!a || !b) return false;
  if (a.type !== 'user' || b.type !== 'user') return false;
  // Strong path: both sides have a stamped id → match by id only.
  if (a.clientMessageId && b.clientMessageId) {
    return a.clientMessageId === b.clientMessageId;
  }
  // Mixed path: one side has an id, the other doesn't. Refuse to
  // match — the side without the id is either a legacy row we
  // can't disambiguate or a different send. Matching here would
  // be a false positive that swallows a legitimate repeat.
  if (a.clientMessageId || b.clientMessageId) return false;
  // Legacy fallback: neither side has an id (pre-clientMessageId
  // chain rows). Content-equality is the only signal we have.
  return a.content === b.content;
}
