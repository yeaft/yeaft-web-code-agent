/**
 * yeaft-session-db.js — server-side persistence for yeaft sessions.
 *
 * Mirrors session-db.js but for the yeaft engine's per-user multi-VP
 * sessions. The agent owns the canonical session state on disk (under
 * `~/.yeaft/sessions/<id>/`); this table is a shadow registry the
 * server uses to:
 *
 *   1. Show the user's yeaft sessions in the sidebar BEFORE any agent
 *      comes online (so a reload doesn't blank the list).
 *   2. List sessions across ALL of the user's agents in one place
 *      (cross-agent unified sidebar) — same way chat conversations
 *      pull from the `sessions` table regardless of which agent is
 *      currently selected.
 *
 * Rows are upserted whenever the agent emits a `group_list_updated`
 * snapshot (full state) or a `group_roster_changed` delta. They are
 * deleted when the agent emits a `session_crud_result` with op=delete
 * or op=archive.
 */

import { stmts } from './connection.js';

function safeJsonParse(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); }
  catch (_) { return fallback; }
}

function safeJsonStringify(v) {
  if (v == null) return null;
  try { return JSON.stringify(v); }
  catch (_) { return null; }
}

function mapRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    userId: row.user_id || null,
    agentId: row.agent_id,
    name: row.name || row.id,
    roster: safeJsonParse(row.roster_json, []),
    defaultVpId: row.default_vp_id || null,
    workDir: row.work_dir || '',
    config: safeJsonParse(row.config_json, {}),
    announcement: row.announcement || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at,
    isArchived: row.is_archived === 1,
  };
}

export const yeaftSessionDb = {
  /**
   * Upsert one session from a snapshot row. Returns nothing.
   *
   * @param {string} userId
   * @param {string} agentId
   * @param {object} session  Shape from `web-bridge.snapshotSessions()`:
   *   { id, name, roster[], defaultVpId, workDir, config, announcement, createdAt }
   */
  upsertFromSnapshot(userId, agentId, session) {
    if (!session || !session.id || !agentId) return;
    const now = Date.now();
    stmts.upsertYeaftSession.run(
      session.id,
      userId || null,
      agentId,
      session.name || session.id,
      safeJsonStringify(Array.isArray(session.roster) ? session.roster : []),
      session.defaultVpId || null,
      session.workDir || '',
      safeJsonStringify(session.config && typeof session.config === 'object' ? session.config : {}),
      typeof session.announcement === 'string' ? session.announcement : '',
      session.createdAt || now,
      now,
      0,
    );
  },

  /**
   * Bulk reconciliation from a full snapshot. Sessions not present in
   * the incoming array (but currently in the DB for this user+agent)
   * are deleted — the agent has authoritatively said "these are my
   * sessions right now". Behaviour matches the web `applySnapshot`
   * per-agent replacement so server + client stay in sync.
   *
   * @param {string} userId
   * @param {string} agentId
   * @param {object[]} sessions
   */
  reconcileFromSnapshot(userId, agentId, sessions) {
    const arr = Array.isArray(sessions) ? sessions : [];
    const incomingIds = new Set();
    for (const s of arr) {
      if (s && s.id) {
        incomingIds.add(s.id);
        this.upsertFromSnapshot(userId, agentId, s);
      }
    }
    // Drop rows for this (user, agent) not in the snapshot.
    const existing = stmts.getYeaftSessionsByAgent.all(agentId);
    for (const row of existing) {
      // Only touch rows belonging to this user — guards against
      // accidentally wiping another user's rows if agent ownership is
      // ever shared (currently it isn't, but be defensive).
      if (userId && row.user_id && row.user_id !== userId) continue;
      if (!incomingIds.has(row.id)) {
        stmts.deleteYeaftSession.run(row.id);
      }
    }
  },

  /** All non-archived rows for this user (across all agents). */
  getByUser(userId) {
    if (!userId) return [];
    return stmts.getYeaftSessionsByUser.all(userId).map(mapRow);
  },

  getByAgent(agentId) {
    return stmts.getYeaftSessionsByAgent.all(agentId).map(mapRow);
  },

  get(id) {
    return mapRow(stmts.getYeaftSession.get(id));
  },

  delete(id) {
    stmts.deleteYeaftSession.run(id);
  },

  setArchived(id, archived) {
    stmts.setYeaftSessionArchived.run(archived ? 1 : 0, Date.now(), id);
  },
};
