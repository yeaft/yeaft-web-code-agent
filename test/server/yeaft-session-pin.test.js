/**
 * yeaft-session-pin.test.js — server-side persistence of yeaft session
 * pin state (fix-yeaft-session-list-and-menu, Fix 3).
 *
 * Three concerns:
 *   1. The `is_pinned` column persists across upserts (snapshots never
 *      clobber the pin bit — snapshot is the agent's view of session
 *      contents; pin is server-side UI metadata).
 *   2. `setPinned(id, true/false)` flips the bit and the read path
 *      surfaces `isPinned`.
 *   3. The pin/unpin WebSocket handler in client-conversation.js routes
 *      yeaft session ids to yeaftSessionDb (not chat's sessionDb), with
 *      a user_id ownership check, and falls back to chat sessionDb for
 *      ids that aren't in yeaft_sessions.
 *
 * Self-contained: spins up an in-memory SQLite with both yeaft + chat
 * session schemas so the routing branch can be exercised end-to-end.
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
    is_archived INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    user_id TEXT,
    is_active INTEGER DEFAULT 1,
    is_pinned INTEGER DEFAULT 0
  );
`;

let db;
let dbPath;

function buildYeaftApi(db) {
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
    setPinned: db.prepare('UPDATE yeaft_sessions SET is_pinned = ?, updated_at = ? WHERE id = ?'),
  };
  function mapRow(r) {
    if (!r) return r;
    return {
      id: r.id,
      userId: r.user_id || null,
      agentId: r.agent_id,
      isArchived: r.is_archived === 1,
      isPinned: r.is_pinned === 1,
    };
  }
  return {
    upsert(userId, agentId, s) {
      const now = Date.now();
      stmts.upsert.run(
        s.id, userId, agentId, s.name || s.id,
        '[]', null, '', '{}', '', s.createdAt || now, now, 0,
      );
    },
    get(id) { return mapRow(stmts.get.get(id)); },
    setPinned(id, pinned) {
      stmts.setPinned.run(pinned ? 1 : 0, Date.now(), id);
    },
  };
}

function buildChatApi(db) {
  const stmts = {
    insert: db.prepare('INSERT INTO sessions (id, title, user_id) VALUES (?, ?, ?)'),
    get: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    setPinned: db.prepare('UPDATE sessions SET is_pinned = ? WHERE id = ?'),
  };
  return {
    insert(id, userId) { stmts.insert.run(id, 'chat', userId); },
    get(id) { return stmts.get.get(id); },
    setPinned(id, pinned) { stmts.setPinned.run(pinned ? 1 : 0, id); },
  };
}

/**
 * Mirror the WebSocket pin/unpin handler from
 * server/handlers/client-conversation.js — yeaft-first routing with
 * user_id ownership check, fall back to chat sessionDb.
 *
 * Returns the table that was touched, or 'denied' / 'noop' so tests
 * can assert routing decisions independent of side effects.
 */
function pinHandler({ yeaftApi, chatApi, verifyChatOwnership }, client, msg) {
  const pinConvId = msg.conversationId;
  if (!pinConvId) return 'noop';
  const isPinned = msg.type === 'pin_session';
  const yeaftRow = yeaftApi.get(pinConvId);
  if (yeaftRow) {
    if (yeaftRow.userId && yeaftRow.userId !== client.userId) return 'denied';
    yeaftApi.setPinned(pinConvId, isPinned);
    return 'yeaft';
  }
  if (!verifyChatOwnership(pinConvId, client.userId)) return 'denied';
  chatApi.setPinned(pinConvId, isPinned);
  return 'chat';
}

beforeEach(() => {
  if (db) { try { db.close(); } catch (_) {} }
  if (dbPath) { try { unlinkSync(dbPath); } catch (_) {} }
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  dbPath = join(TMP_DIR, `yeaftpin_${randomBytes(6).toString('hex')}.db`);
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SCHEMA);
});

afterAll(() => {
  if (db) { try { db.close(); } catch (_) {} }
  if (dbPath) { try { unlinkSync(dbPath); } catch (_) {} }
});

describe('yeaftSessionDb.setPinned + persistence semantics', () => {
  it('setPinned(id, true) flips is_pinned to 1 and get() reports isPinned: true', () => {
    const api = buildYeaftApi(db);
    api.upsert('user_a', 'agent_1', { id: 's1', name: 'S1' });
    expect(api.get('s1').isPinned).toBe(false);
    api.setPinned('s1', true);
    expect(api.get('s1').isPinned).toBe(true);
    api.setPinned('s1', false);
    expect(api.get('s1').isPinned).toBe(false);
  });

  it('upsertFromSnapshot does NOT overwrite is_pinned (snapshot has no notion of pin)', () => {
    const api = buildYeaftApi(db);
    api.upsert('user_a', 'agent_1', { id: 's1', name: 'S1' });
    api.setPinned('s1', true);
    // Agent re-pushes the same session — snapshot upsert MUST not clear is_pinned.
    api.upsert('user_a', 'agent_1', { id: 's1', name: 'S1 renamed' });
    const row = api.get('s1');
    expect(row.isPinned).toBe(true);
  });
});

describe('pin_session handler routing (yeaft-first, chat fallback)', () => {
  it('routes yeaft session id to yeaftSessionDb', () => {
    const yeaftApi = buildYeaftApi(db);
    const chatApi = buildChatApi(db);
    yeaftApi.upsert('user_a', 'agent_1', { id: 'yeaft_1', name: 'Y1' });
    const result = pinHandler(
      { yeaftApi, chatApi, verifyChatOwnership: () => true },
      { userId: 'user_a' },
      { type: 'pin_session', conversationId: 'yeaft_1' },
    );
    expect(result).toBe('yeaft');
    expect(yeaftApi.get('yeaft_1').isPinned).toBe(true);
  });

  it('falls back to chat sessionDb when id is not in yeaft_sessions', () => {
    const yeaftApi = buildYeaftApi(db);
    const chatApi = buildChatApi(db);
    chatApi.insert('chat_1', 'user_a');
    const result = pinHandler(
      { yeaftApi, chatApi, verifyChatOwnership: () => true },
      { userId: 'user_a' },
      { type: 'pin_session', conversationId: 'chat_1' },
    );
    expect(result).toBe('chat');
    expect(chatApi.get('chat_1').is_pinned).toBe(1);
    expect(yeaftApi.get('chat_1')).toBeFalsy();
  });

  it('denies a yeaft pin attempt by a non-owner user_id', () => {
    const yeaftApi = buildYeaftApi(db);
    const chatApi = buildChatApi(db);
    yeaftApi.upsert('user_owner', 'agent_1', { id: 'yeaft_1', name: 'Y1' });
    const result = pinHandler(
      { yeaftApi, chatApi, verifyChatOwnership: () => true },
      { userId: 'user_other' },
      { type: 'pin_session', conversationId: 'yeaft_1' },
    );
    expect(result).toBe('denied');
    expect(yeaftApi.get('yeaft_1').isPinned).toBe(false);
  });

  it('denies a chat pin attempt that fails verifyConversationOwnership', () => {
    const yeaftApi = buildYeaftApi(db);
    const chatApi = buildChatApi(db);
    chatApi.insert('chat_1', 'user_owner');
    const result = pinHandler(
      { yeaftApi, chatApi, verifyChatOwnership: () => false },
      { userId: 'user_other' },
      { type: 'pin_session', conversationId: 'chat_1' },
    );
    expect(result).toBe('denied');
    expect(chatApi.get('chat_1').is_pinned).toBe(0);
  });

  it('unpin_session: yeaft path sets is_pinned to 0', () => {
    const yeaftApi = buildYeaftApi(db);
    const chatApi = buildChatApi(db);
    yeaftApi.upsert('user_a', 'agent_1', { id: 'yeaft_1', name: 'Y1' });
    yeaftApi.setPinned('yeaft_1', true);
    expect(yeaftApi.get('yeaft_1').isPinned).toBe(true);
    const result = pinHandler(
      { yeaftApi, chatApi, verifyChatOwnership: () => true },
      { userId: 'user_a' },
      { type: 'unpin_session', conversationId: 'yeaft_1' },
    );
    expect(result).toBe('yeaft');
    expect(yeaftApi.get('yeaft_1').isPinned).toBe(false);
  });
});
