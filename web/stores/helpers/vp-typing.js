// Helper for the per-conversation, per-VP typing-indicator counter.
//
// `unifyVpTyping` lives on the chat store as a nested map:
//
//   { [conversationId]: { [vpId]: refCount } }
//
// The nesting is what isolates Unify typing state from the Chat view —
// when the user is in a Chat tab, `currentConversation` is a chat conv id,
// the lookup yields an empty inner object, and no Unify typing rows or
// dots leak across the mode boundary. (Bug A in PR #698 follow-up.)
//
// `vp_typing_start` increments the counter; `vp_typing_end` decrements
// and prunes empty branches so the structure doesn't accumulate dead
// keys. Both return a NEW root object so Vue/Pinia reactivity picks up
// the change (the underlying state field is a plain object, not a
// reactive ref).
//
// Pure functions; safe to unit-test without any Pinia / Vue scaffolding.

/**
 * Increment the (conversationId, vpId) counter. Returns a new root object.
 *
 * @param {Record<string, Record<string, number>>} root  current state
 * @param {string} conversationId
 * @param {string} vpId
 * @returns {Record<string, Record<string, number>>}
 */
export function incVpTyping(root, conversationId, vpId) {
  const next = { ...(root || {}) };
  const inner = { ...(next[conversationId] || {}) };
  inner[vpId] = (inner[vpId] || 0) + 1;
  next[conversationId] = inner;
  return next;
}

/**
 * Decrement the counter; remove the vpId entry when it hits zero, and
 * remove the conversationId branch when it has no remaining vpIds.
 *
 * @param {Record<string, Record<string, number>>} root
 * @param {string} conversationId
 * @param {string} vpId
 * @returns {Record<string, Record<string, number>>}
 */
export function decVpTyping(root, conversationId, vpId) {
  const next = { ...(root || {}) };
  const inner = { ...(next[conversationId] || {}) };
  const c = (inner[vpId] || 0) - 1;
  if (c <= 0) delete inner[vpId];
  else inner[vpId] = c;
  if (Object.keys(inner).length === 0) delete next[conversationId];
  else next[conversationId] = inner;
  return next;
}

/**
 * Read the typing count for a (conversationId, vpId) — convenience for
 * UI components that want to check "is this VP currently typing in MY
 * conversation".
 *
 * @param {Record<string, Record<string, number>>} root
 * @param {string|null|undefined} conversationId
 * @param {string|null|undefined} vpId
 * @returns {number}
 */
export function getVpTyping(root, conversationId, vpId) {
  if (!conversationId || !vpId) return 0;
  const inner = (root || {})[conversationId];
  if (!inner) return 0;
  return inner[vpId] || 0;
}

/**
 * Return the list of vpIds currently typing in a given conversation.
 * Empty array when conversation is unknown — exactly the property that
 * keeps Chat-view lookups quiet while Unify is mid-stream.
 *
 * @param {Record<string, Record<string, number>>} root
 * @param {string|null|undefined} conversationId
 * @returns {string[]}
 */
export function vpsTypingIn(root, conversationId) {
  if (!conversationId) return [];
  const inner = (root || {})[conversationId];
  if (!inner) return [];
  return Object.keys(inner).filter((vpId) => (inner[vpId] || 0) > 0);
}
