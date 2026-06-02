// Helpers for the Chat ↔ Yeaft view transition.
//
// The split-out logic exists for one reason: the snapshot of
// `activeConversations` taken on entering Yeaft must NOT be overwritten
// by repeat calls to enterYeaft while the user is already in Yeaft view.
// If it is, leaveYeaft will "restore" the yeaft-only conversationId back
// into the Chat view's active list — which manifests as Yeaft messages
// bleeding into Chat after leaving and re-entering.
//
// Keeping this in a pure helper lets us unit-test the behaviour without
// standing up Pinia, the WebSocket harness, or the rest of the store.

/**
 * Apply the entering-Yeaft side of the chat ↔ yeaft transition. Mutates
 * `store.activeConversations` and `store._savedActiveConversations` in
 * place, idempotently — calling this multiple times while already in
 * Yeaft is safe and preserves the original Chat snapshot.
 *
 * @param {{
 *   currentView: string,
 *   activeConversations: string[],
 *   _savedActiveConversations: string[] | null,
 *   yeaftConversationId: string,
 * }} store — minimal store-shaped object
 * @returns {boolean} true if this call took a fresh snapshot
 *   (i.e. it was a real Chat → Yeaft transition); false if it was a
 *   redundant call already inside Yeaft view.
 */
export function applyEnterYeaftTransition(store) {
  const enteringFresh = store.currentView !== 'yeaft';
  if (enteringFresh) {
    store._savedActiveConversations = [...store.activeConversations];
  }
  store.activeConversations = [store.yeaftConversationId];
  return enteringFresh;
}

/**
 * Apply the leaving-Yeaft side of the transition. Restores the saved
 * snapshot if one exists; no-op if leaveYeaft is called without a prior
 * enterYeaft (e.g. on cold boot).
 *
 * @param {{
 *   activeConversations: string[],
 *   _savedActiveConversations: string[] | null,
 * }} store
 */
export function applyLeaveYeaftTransition(store) {
  if (store._savedActiveConversations) {
    store.activeConversations = store._savedActiveConversations;
    store._savedActiveConversations = null;
  }
}
