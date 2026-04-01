import { stmts } from './connection.js';
import { trackSession } from '../context.js';

export const sessionDb = {
  create(id, agentId, agentName, workDir, claudeSessionId = null, title = null, userId = null) {
    const now = Date.now();
    stmts.insertSession.run(id, userId, agentId, agentName, claudeSessionId, workDir, title, now, now);
    trackSession(userId);
    return { id, userId, agentId, agentName, workDir, claudeSessionId, title, createdAt: now, updatedAt: now };
  },

  update(id, updates = {}) {
    const now = Date.now();
    stmts.updateSession.run(
      updates.claudeSessionId ?? null,
      updates.title ?? null,
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
    return stmts.getSession.get(id);
  },

  getByAgent(agentId, limit = 50) {
    return stmts.getSessionsByAgent.all(agentId, limit);
  },

  getByUser(userId, limit = 50) {
    return stmts.getSessionsByUser.all(userId, limit);
  },

  getByUserAndAgent(userId, agentId, limit = 50) {
    return stmts.getSessionsByUserAndAgent.all(userId, agentId, limit);
  },

  getAll(limit = 100) {
    return stmts.getAllSessions.all(limit);
  },

  getActive() {
    return stmts.getActiveSessions.all();
  },

  getActiveByUser(userId) {
    return stmts.getActiveSessionsByUser.all(userId);
  },

  delete(id) {
    stmts.deleteSession.run(id);
  },

  exists(id) {
    return !!stmts.getSession.get(id);
  }
};
