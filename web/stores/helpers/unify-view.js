// Helpers for the Chat ↔ Unify view transition.
//
// The split-out logic exists for one reason: the snapshot of
// `activeConversations` taken on entering Unify must NOT be overwritten
// by repeat calls to enterUnify while the user is already in Unify view.
// If it is, leaveUnify will "restore" the unify-only conversationId back
// into the Chat view's active list — which manifests as Unify messages
// bleeding into Chat after leaving and re-entering.
//
// Keeping this in a pure helper lets us unit-test the behaviour without
// standing up Pinia, the WebSocket harness, or the rest of the store.

/**
 * Apply the entering-Unify side of the chat ↔ unify transition. Mutates
 * `store.activeConversations` and `store._savedActiveConversations` in
 * place, idempotently — calling this multiple times while already in
 * Unify is safe and preserves the original Chat snapshot.
 *
 * @param {{
 *   currentView: string,
 *   activeConversations: string[],
 *   _savedActiveConversations: string[] | null,
 *   unifyConversationId: string,
 * }} store — minimal store-shaped object
 * @returns {boolean} true if this call took a fresh snapshot
 *   (i.e. it was a real Chat → Unify transition); false if it was a
 *   redundant call already inside Unify view.
 */
export function applyEnterUnifyTransition(store) {
  const enteringFresh = store.currentView !== 'unify';
  if (enteringFresh) {
    store._savedActiveConversations = [...store.activeConversations];
  }
  store.activeConversations = [store.unifyConversationId];
  return enteringFresh;
}

/**
 * Apply the leaving-Unify side of the transition. Restores the saved
 * snapshot if one exists; no-op if leaveUnify is called without a prior
 * enterUnify (e.g. on cold boot).
 *
 * @param {{
 *   activeConversations: string[],
 *   _savedActiveConversations: string[] | null,
 * }} store
 */
export function applyLeaveUnifyTransition(store) {
  if (store._savedActiveConversations) {
    store.activeConversations = store._savedActiveConversations;
    store._savedActiveConversations = null;
  }
}
