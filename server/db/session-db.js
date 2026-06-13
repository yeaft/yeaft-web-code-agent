import { stmts } from './connection.js';
import { trackSession } from '../context.js';

/**
 * Map a raw row from the `sessions` table into the camelCase shape the
 * rest of the server uses. Every consumer that calls one of the read
 * helpers below must go through this so the sticky `customTitle` bit
 * is consistently surfaced.
 *
 * fix-chat-title-sticky: before this helper existed, callers read
 * `row.title` directly and the `is_custom_title` column was invisible,
 * which is why every rebuild path (agent-conversation,
 * agent-sync, get_agents) ended up wiping the sticky bit.
 */
function mapRow(row) {
  if (!row) return row;
  return {
    ...row,
    customTitle: row.is_custom_title === 1
  };
}

export const sessionDb = {
  create(id, agentId, agentName, workDir, claudeSessionId = null, title = null, userId = null, provider = null) {
    const now = Date.now();
    stmts.insertSession.run(id, userId, agentId, agentName, claudeSessionId, workDir, title, provider, now, now);
    trackSession(userId);
    return { id, userId, agentId, agentName, workDir, claudeSessionId, title, provider, customTitle: false, createdAt: now, updatedAt: now };
  },

  /**
   * Partial update. Pass `isCustomTitle: 1` (along with `title`) when the
   * change came from the user-rename UI; pass `isCustomTitle: 0` to
   * explicitly clear the bit. Omit it (or pass `undefined`) on auto-title
   * writes — the `COALESCE` keeps the existing column value, which is the
   * whole point of the sticky behaviour.
   */
  update(id, updates = {}) {
    const now = Date.now();
    stmts.updateSession.run(
      updates.claudeSessionId ?? null,
      updates.title ?? null,
      updates.isCustomTitle ?? null,
      now,
      id
    );
  },

  setActive(id, active) {
    stmts.updateSessionActive.run(active ? 1 : 0, Date.now(), id);
  },

  /**
   * fix-session-dup: re-point a session at a different owning agent.
   * The caller MUST have already removed the conv from the old
   * agent's in-memory `agent.conversations` Map; this updates the
   * persisted owner so a future `get_agents` restore re-seats the
   * conv only on the new agent.
   *
   * `agentName` is denormalized in the row (legacy schema), so we
   * write both columns together to keep them in sync — otherwise
   * the next `agent_list` broadcast would surface a stale name.
   */
  setAgent(id, agentId, agentName) {
    stmts.updateSessionAgent.run(agentId, agentName ?? null, Date.now(), id);
  },

  setPinned(id, pinned) {
    stmts.updateSessionPinned.run(pinned ? 1 : 0, Date.now(), id);
  },

  /**
   * fix-copilot-provider-persist: persist the conversation's code-agent
   * provider (e.g. 'copilot') so it survives an agent process restart.
   * Only meaningful for non-default providers; a null/'claude-code' value
   * is the implicit default and need not be stored, but we still accept it
   * so callers can clear the column if a provider ever changes.
   */
  setProvider(id, provider) {
    stmts.updateSessionProvider.run(provider ?? null, Date.now(), id);
  },

  get(id) {
    return mapRow(stmts.getSession.get(id));
  },

  getByAgent(agentId, limit = 50) {
    return stmts.getSessionsByAgent.all(agentId, limit).map(mapRow);
  },

  getByUser(userId, limit = 50) {
    return stmts.getSessionsByUser.all(userId, limit).map(mapRow);
  },

  getByUserAndAgent(userId, agentId, limit = 50) {
    return stmts.getSessionsByUserAndAgent.all(userId, agentId, limit).map(mapRow);
  },

  getAll(limit = 100) {
    return stmts.getAllSessions.all(limit).map(mapRow);
  },

  getActive() {
    return stmts.getActiveSessions.all().map(mapRow);
  },

  getActiveByUser(userId) {
    return stmts.getActiveSessionsByUser.all(userId).map(mapRow);
  },

  delete(id) {
    stmts.deleteSession.run(id);
  },

  exists(id) {
    return !!stmts.getSession.get(id);
  }
};
