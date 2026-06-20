/**
 * Pure selectors over the chat store's "which conversation is the active
 * view sourcing from?" question.
 *
 * Lives in its own helper so:
 *   1. The Yeaft-vs-Chat routing rule has ONE canonical implementation
 *      (chat.js's `messages`, `vpsTypingInCurrentConv`,
 *      `isVpTypingInCurrentConv` all flow through it instead of each
 *      open-coding the ternary).
 *   2. We can unit-test the rule against a plain state shape without
 *      booting Pinia / Vue.
 *
 * Bug fixed: chat-mode WebSocket handlers (conversation_resumed,
 * conversation_selected, agent_list restore, crew session restore)
 * unconditionally write `state.activeConversations` regardless of
 * `currentView`. When the user is sitting on the Yeaft page, that
 * background clobber used to be observable through every getter that
 * read `state.activeConversations[0]` — chat messages bled into the
 * Yeaft view and VP typing badges silently disappeared.
 *
 * The fix: in Yeaft view, source from `state.yeaftConversationId`
 * instead. Crew and Chat keep the existing behaviour.
 */

/**
 * Returns the conversation id the active VIEW should be reading from,
 * or null if the view has no active conversation yet.
 */
export function selectActiveConversationId(state) {
  if (state.currentView === 'yeaft') {
    // Cross-agent Yeaft sessions do not share an agent-side conversationId:
    // every local agent process owns its own virtual conversation. In Yeaft
    // view, prefer the conversation owned by the active session's agent; if
    // the session row is not known yet, fall back to the agent this client is
    // bound to (`currentAgent`). This prevents A -> B -> A switches from
    // rendering A rows out of B's message cache just because B was the last
    // agent to replay session_ready.
    const sessionId = state.yeaftActiveSessionFilter || null;
    const sessionAgentId = sessionId && state.yeaftSessionAgentById
      ? state.yeaftSessionAgentById[sessionId]
      : null;
    const agentId = sessionAgentId || state.currentAgent || null;
    const agentConversationId = agentId && state.yeaftConversationIdsByAgent
      ? state.yeaftConversationIdsByAgent[agentId]
      : null;
    return agentConversationId || state.yeaftConversationId || null;
  }
  // Chat and Crew share `activeConversations[0]`. Crew runs alongside
  // chat in the same conversation list, so the same selector serves
  // both.
  return state.activeConversations[0] || null;
}
