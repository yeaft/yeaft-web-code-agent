/**
 * session-pin-router.js — pure routing decision for pin_session /
 * unpin_session WebSocket messages.
 *
 * Yeaft and Chat sessions live in two different SQLite tables
 * (`yeaft_sessions` vs `sessions`) with two different ownership
 * conventions:
 *   - yeaft: rows carry their own `user_id` column (yeaft sessions are
 *     not chat conversations, they don't show up in the `sessions` table)
 *   - chat:  `verifyConversationOwnership` reads `sessions.user_id`
 *
 * This module exposes a single pure decision function that returns a
 * discriminated outcome. The production handler in
 * `client-conversation.js` translates the outcome into the actual DB
 * write + WS reply; tests use the same function to assert routing
 * behavior without having to import the whole handler graph.
 *
 * Outcome shapes:
 *   { kind: 'noop' }                                       — message had no conversationId
 *   { kind: 'yeaft', id, isPinned }                        — yeaft DB path
 *   { kind: 'chat',  id, isPinned }                        — chat DB fallback path
 *   { kind: 'denied', id, reason: 'yeaft-foreign' | 'chat-foreign' }  — ownership rejection
 */

/**
 * @typedef {Object} PinRouteDeps
 * @property {(id: string) => ({ userId?: string|null }|null)} getYeaftRow  Reads a yeaft session row (or returns null if not yeaft-owned).
 * @property {(id: string, userId: string) => boolean} verifyChatOwnership  Returns true if `userId` owns the chat conversation `id`.
 * @property {boolean} [skipAuth]  Skip both ownership checks (dev / single-user).
 */

/**
 * Decide where (and whether) a pin_session / unpin_session message
 * should be applied. Pure — never touches the DB.
 *
 * @param {PinRouteDeps} deps
 * @param {{ userId: string|null }} client
 * @param {{ type: 'pin_session'|'unpin_session', conversationId?: string }} msg
 * @returns {
 *   {kind:'noop'} |
 *   {kind:'yeaft', id:string, isPinned:boolean} |
 *   {kind:'chat',  id:string, isPinned:boolean} |
 *   {kind:'denied', id:string, reason:string}
 * }
 */
export function routeSessionPin(deps, client, msg) {
  const id = msg && msg.conversationId;
  if (!id) return { kind: 'noop' };
  const isPinned = msg.type === 'pin_session';
  const yeaftRow = deps.getYeaftRow(id);
  if (yeaftRow) {
    if (!deps.skipAuth && yeaftRow.userId && yeaftRow.userId !== client.userId) {
      return { kind: 'denied', id, reason: 'yeaft-foreign' };
    }
    return { kind: 'yeaft', id, isPinned };
  }
  if (!deps.skipAuth && !deps.verifyChatOwnership(id, client.userId)) {
    return { kind: 'denied', id, reason: 'chat-foreign' };
  }
  return { kind: 'chat', id, isPinned };
}
