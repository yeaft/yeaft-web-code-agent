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
  create(id, agentId, agentName, workDir, claudeSessionId = null, title = null, userId = null) {
    const now = Date.now();
    stmts.insertSession.run(id, userId, agentId, agentName, claudeSessionId, workDir, title, now, now);
    trackSession(userId);
    return { id, userId, agentId, agentName, workDir, claudeSessionId, title, customTitle: false, createdAt: now, updatedAt: now };
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

  setPinned(id, pinned) {
    stmts.updateSessionPinned.run(pinned ? 1 : 0, Date.now(), id);
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
