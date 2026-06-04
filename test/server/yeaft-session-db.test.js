/**
 * yeaft-session-db.test.js — exercises the yeaft_sessions table CRUD
 * and the snapshot reconciliation path that the server uses when an
 * agent emits `group_list_updated`.
 *
 * Self-contained: spins up an isolated SQLite DB with just the
 * yeaft_sessions schema (no need to import the full production DB).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', '.tmp');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS yeaft_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    agent_id TEXT NOT NULL,
    name TEXT,
    roster_json TEXT,
    default_vp_id TEXT,
    work_dir TEXT,
    config_json TEXT,
    announcement TEXT,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    is_archived INTEGER DEFAULT 0
  );
`;

let db;
let dbPath;

/**
 * Build a yeaft-session-db API on the given DB. Mirrors
 * server/db/yeaft-session-db.js so we can exercise the same logic
 * without dragging in the production module's hard-coded singleton.
 */
function build(db) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO yeaft_sessions
        (id, user_id, agent_id, name, roster_json, default_vp_id, work_dir,
         config_json, announcement, created_at, updated_at, is_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, user_id),
        agent_id = excluded.agent_id,
        name = excluded.name,
        roster_json = excluded.roster_json,
        default_vp_id = excluded.default_vp_id,
        work_dir = excluded.work_dir,
        config_json = excluded.config_json,
        announcement = excluded.announcement,
        created_at = COALESCE(yeaft_sessions.created_at, excluded.created_at),
        updated_at = excluded.updated_at,
        is_archived = excluded.is_archived
    `),
    get: db.prepare('SELECT * FROM yeaft_sessions WHERE id = ?'),
    byUser: db.prepare(`
      SELECT * FROM yeaft_sessions
      WHERE (user_id = ? OR user_id IS NULL) AND is_archived = 0
      ORDER BY updated_at DESC
    `),
    byAgent: db.prepare(`
      SELECT * FROM yeaft_sessions
      WHERE agent_id = ? AND is_archived = 0
      ORDER BY updated_at DESC
    `),
    del: db.prepare('DELETE FROM yeaft_sessions WHERE id = ?'),
    archive: db.prepare('UPDATE yeaft_sessions SET is_archived = ?, updated_at = ? WHERE id = ?'),
  };

  function upsert(userId, agentId, s) {
    const now = Date.now();
    stmts.upsert.run(
      s.id, userId, agentId, s.name || s.id,
      JSON.stringify(Array.isArray(s.roster) ? s.roster : []),
      s.defaultVpId || null, s.workDir || '',
      JSON.stringify(s.config || {}),
      s.announcement || '', s.createdAt || now, now, 0,
    );
  }

  return {
    upsert,
    get(id) { return stmts.get.get(id); },
    byUser(uid) { return stmts.byUser.all(uid); },
    byAgent(aid) { return stmts.byAgent.all(aid); },
    reconcile(userId, agentId, rows) {
      const ids = new Set();
      for (const s of rows) {
        if (!s?.id) continue;
        ids.add(s.id);
        upsert(userId, agentId, s);
      }
      for (const row of stmts.byAgent.all(agentId)) {
        if (userId && row.user_id && row.user_id !== userId) continue;
        if (!ids.has(row.id)) stmts.del.run(row.id);
      }
    },
    delete(id) { stmts.del.run(id); },
    setArchived(id, b) { stmts.archive.run(b ? 1 : 0, Date.now(), id); },
  };
}

beforeEach(() => {
  if (db) { try { db.close(); } catch (_) {} }
  if (dbPath) { try { unlinkSync(dbPath); } catch (_) {} }
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  dbPath = join(TMP_DIR, `yeaft_${randomBytes(6).toString('hex')}.db`);
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SCHEMA);
});

afterAll(() => {
  if (db) { try { db.close(); } catch (_) {} }
  if (dbPath) { try { unlinkSync(dbPath); } catch (_) {} }
});

describe('yeaftSessionDb', () => {
  it('upserts a session and reads it back', () => {
    const api = build(db);
    api.upsert('user_a', 'agent_1', {
      id: 'sess_1', name: 'My session', roster: ['vp_a', 'vp_b'],
      defaultVpId: 'vp_a', workDir: '/tmp', config: { x: 1 }, announcement: 'hi',
      createdAt: 1000,
    });
    const row = api.get('sess_1');
    expect(row.name).toBe('My session');
    expect(JSON.parse(row.roster_json)).toEqual(['vp_a', 'vp_b']);
    expect(row.default_vp_id).toBe('vp_a');
    expect(row.user_id).toBe('user_a');
    expect(row.agent_id).toBe('agent_1');
  });

  it('upsert updates an existing row without losing createdAt', () => {
    const api = build(db);
    api.upsert('user_a', 'agent_1', { id: 's', name: 'first', createdAt: 100 });
    const created = api.get('s').created_at;
    api.upsert('user_a', 'agent_1', { id: 's', name: 'second', createdAt: 999 });
    const row = api.get('s');
    expect(row.name).toBe('second');
    expect(row.created_at).toBe(created); // COALESCE preserves original
  });

  it('byUser returns rows across multiple agents', () => {
    const api = build(db);
    api.upsert('user_a', 'agent_1', { id: 'a1', name: 'A1' });
    api.upsert('user_a', 'agent_2', { id: 'a2', name: 'A2' });
    api.upsert('user_b', 'agent_1', { id: 'b1', name: 'B1' });
    const rows = api.byUser('user_a');
    const ids = rows.map(r => r.id).sort();
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('reconcile drops rows for this (user, agent) not in the snapshot', () => {
    const api = build(db);
    api.upsert('user_a', 'agent_1', { id: 's1', name: 'one' });
    api.upsert('user_a', 'agent_1', { id: 's2', name: 'two' });
    api.upsert('user_a', 'agent_2', { id: 's3', name: 'three' });
    // Snapshot from agent_1 contains only s1 — s2 should be removed,
    // s3 (other agent) untouched.
    api.reconcile('user_a', 'agent_1', [{ id: 's1', name: 'one-updated' }]);
    const rows = api.byUser('user_a').map(r => r.id).sort();
    expect(rows).toEqual(['s1', 's3']);
    expect(api.get('s1').name).toBe('one-updated');
  });

  it('reconcile does not delete other users\' rows on the same agent', () => {
    const api = build(db);
    api.upsert('user_a', 'agent_1', { id: 'a' });
    api.upsert('user_b', 'agent_1', { id: 'b' });
    api.reconcile('user_a', 'agent_1', []);
    expect(api.get('a')).toBeUndefined();
    expect(api.get('b')).toBeTruthy();
  });

  it('setArchived hides the row from byUser', () => {
    const api = build(db);
    api.upsert('user_a', 'agent_1', { id: 's' });
    api.setArchived('s', true);
    expect(api.byUser('user_a')).toEqual([]);
    api.setArchived('s', false);
    expect(api.byUser('user_a').length).toBe(1);
  });

  it('delete removes the row outright', () => {
    const api = build(db);
    api.upsert('user_a', 'agent_1', { id: 's' });
    api.delete('s');
    expect(api.get('s')).toBeUndefined();
  });
});
