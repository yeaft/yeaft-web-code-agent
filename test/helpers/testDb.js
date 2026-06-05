/**
 * Test database helper — creates isolated SQLite databases for each test suite.
 *
 * Usage:
 *   import { setupTestDb, cleanupTestDb, getDb } from '../helpers/testDb.js';
 *
 *   beforeAll(() => setupTestDb());
 *   afterAll(() => cleanupTestDb());
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'crypto';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', '.tmp');

let currentDbPath = null;
let currentDb = null;

// Schema from server/database.js
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    agent_name TEXT,
    claude_session_id TEXT,
    work_dir TEXT,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT,
    tool_name TEXT,
    tool_input TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_by TEXT,
    used_at INTEGER,
    expires_at INTEGER NOT NULL,
    role TEXT DEFAULT 'user',
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (used_by) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`;

const MIGRATIONS = [
  'ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)',
  'ALTER TABLE users ADD COLUMN totp_secret TEXT',
  'ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN password_hash TEXT',
  'ALTER TABLE users ADD COLUMN email TEXT',
  'ALTER TABLE users ADD COLUMN agent_secret TEXT',
  'ALTER TABLE users ADD COLUMN role TEXT DEFAULT \'user\''
];

const MIGRATIONS_NEW = [
  'ALTER TABLE users ADD COLUMN aad_oid TEXT',
  // fix-chat-title-sticky: mirror production migration so tests can
  // exercise the sticky-title persistence path.
  'ALTER TABLE sessions ADD COLUMN is_custom_title INTEGER DEFAULT 0',
  // fix-session-dup: sessions can be pinned (kept active across the
  // 2-day auto-deactivation sweep).
  'ALTER TABLE sessions ADD COLUMN is_pinned INTEGER DEFAULT 0',
  // fix-usermsg-dup: messages now carry an opaque JSON metadata blob
  // that holds the `clientMessageId` round-trip key (and experts /
  // askRequestId for other features).
  'ALTER TABLE messages ADD COLUMN metadata TEXT'
];

const POST_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_users_agent_secret ON users(agent_secret)'
];

export function createTestDb() {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
  const dbPath = join(TMP_DIR, `test_${randomBytes(8).toString('hex')}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) {
    try { db.exec(m); } catch (e) { /* column already exists */ }
  }
  for (const m of MIGRATIONS_NEW) {
    try { db.exec(m); } catch (e) { /* column already exists */ }
  }
  for (const idx of POST_INDEXES) {
    try { db.exec(idx); } catch (e) { /* index already exists */ }
  }
  currentDbPath = dbPath;
  currentDb = db;
  return { db, dbPath };
}

export function cleanupTestDb() {
  if (currentDb) {
    try { currentDb.close(); } catch (e) { /* already closed */ }
    currentDb = null;
  }
  if (currentDbPath) {
    try { unlinkSync(currentDbPath); } catch (e) { /* already gone */ }
    // Also clean WAL/SHM files
    try { unlinkSync(currentDbPath + '-wal'); } catch (e) {}
    try { unlinkSync(currentDbPath + '-shm'); } catch (e) {}
    currentDbPath = null;
  }
}

export function getTestDbPath() {
  return currentDbPath;
}

/**
 * Create prepared statements matching server/database.js pattern.
 * Returns { userDb, sessionDb, messageDb, invitationDb } with same API.
 */
export function createDbOperations(db) {
  const stmts = {
    insertUser: db.prepare('INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)'),
    insertUserFull: db.prepare('INSERT INTO users (id, username, display_name, password_hash, email, agent_secret, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    updateUserLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    updateUserPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    updateUserEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
    updateUserAgentSecret: db.prepare('UPDATE users SET agent_secret = ? WHERE id = ?'),
    updateUserRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    updateUserMigrate: db.prepare('UPDATE users SET password_hash = ?, email = ?, role = ?, agent_secret = COALESCE(agent_secret, ?) WHERE id = ?'),
    getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    getUserByAgentSecret: db.prepare('SELECT * FROM users WHERE agent_secret = ?'),
    getAllUsers: db.prepare('SELECT * FROM users ORDER BY created_at DESC'),
    updateUserTotp: db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE username = ?'),
    getUserTotp: db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE username = ?'),
    getUserByAadOid: db.prepare('SELECT * FROM users WHERE aad_oid = ?'),
    updateUserAadOid: db.prepare('UPDATE users SET aad_oid = ? WHERE id = ?'),
    insertInvitation: db.prepare('INSERT INTO invitations (id, created_by, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?)'),
    getInvitation: db.prepare('SELECT * FROM invitations WHERE id = ?'),
    useInvitation: db.prepare('UPDATE invitations SET used_by = ?, used_at = ? WHERE id = ?'),
    getInvitationsByUser: db.prepare('SELECT * FROM invitations WHERE created_by = ? ORDER BY created_at DESC'),
    deleteInvitation: db.prepare('DELETE FROM invitations WHERE id = ? AND created_by = ? AND used_by IS NULL'),
    cleanupExpiredInvitations: db.prepare('DELETE FROM invitations WHERE expires_at < ? AND used_by IS NULL'),
    insertSession: db.prepare('INSERT INTO sessions (id, user_id, agent_id, agent_name, claude_session_id, work_dir, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateSession: db.prepare('UPDATE sessions SET claude_session_id = COALESCE(?, claude_session_id), title = COALESCE(?, title), is_custom_title = COALESCE(?, is_custom_title), updated_at = ? WHERE id = ?'),
    updateSessionActive: db.prepare('UPDATE sessions SET is_active = ?, updated_at = ? WHERE id = ?'),
    // fix-session-dup: re-point a session's owning agent. Production
    // statement at server/db/connection.js#updateSessionAgent.
    updateSessionAgent: db.prepare('UPDATE sessions SET agent_id = ?, agent_name = ?, updated_at = ? WHERE id = ?'),
    updateSessionPinned: db.prepare('UPDATE sessions SET is_pinned = ?, updated_at = ? WHERE id = ?'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    getSessionsByAgent: db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?'),
    getSessionsByUser: db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?'),
    getSessionsByUserAndAgent: db.prepare('SELECT * FROM sessions WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC LIMIT ?'),
    getAllSessions: db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'),
    getActiveSessions: db.prepare('SELECT * FROM sessions WHERE is_active = 1 ORDER BY updated_at DESC'),
    getActiveSessionsByUser: db.prepare('SELECT * FROM sessions WHERE (user_id = ? OR user_id IS NULL) AND is_active = 1 ORDER BY updated_at DESC'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    insertMessage: db.prepare('INSERT INTO messages (session_id, role, content, message_type, tool_name, tool_input, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    getMessagesBySession: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC'),
    getRecentMessages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'),
    getMessagesAfterId: db.prepare('SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC'),
    getMessagesBeforeId: db.prepare('SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    getMessageCount: db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?'),
    deleteMessagesBySession: db.prepare('DELETE FROM messages WHERE session_id = ?'),
    updateMessageMetadata: db.prepare('UPDATE messages SET metadata = ? WHERE id = ?'),
    getRecentUserMessageIds: db.prepare('SELECT id FROM messages WHERE session_id = ? AND role = \'user\' ORDER BY id DESC LIMIT ?'),
    getMessagesFromId: db.prepare('SELECT * FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC'),
    getUserMessageIdsBeforeId: db.prepare('SELECT id FROM messages WHERE session_id = ? AND role = \'user\' AND id < ? ORDER BY id DESC LIMIT ?'),
    getMessagesBetweenIds: db.prepare('SELECT * FROM messages WHERE session_id = ? AND id >= ? AND id < ? ORDER BY id ASC'),
    getTimestampRange: db.prepare('SELECT MIN(created_at) as min_ts, MAX(created_at) as max_ts, COUNT(*) as count FROM messages WHERE session_id = ?'),
    getLastUserMessage: db.prepare('SELECT * FROM messages WHERE session_id = ? AND role = \'user\' ORDER BY id DESC LIMIT 1')
  };

  function generateUserId() {
    return `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function generateAgentSecret() {
    return randomBytes(32).toString('hex');
  }

  const userDb = {
    getOrCreate(username, displayName = null) {
      let user = stmts.getUserByUsername.get(username);
      if (!user) {
        const id = generateUserId();
        const now = Date.now();
        stmts.insertUser.run(id, username, displayName || username, now);
        user = { id, username, display_name: displayName || username, created_at: now };
      }
      return user;
    },
    createFull(username, passwordHash, email = null, role = 'user') {
      const id = generateUserId();
      const now = Date.now();
      const agentSecret = generateAgentSecret();
      stmts.insertUserFull.run(id, username, username, passwordHash, email, agentSecret, role, now);
      return { id, username, display_name: username, password_hash: passwordHash, email, agent_secret: agentSecret, role, created_at: now };
    },
    migrateUser(username, passwordHash, email, role = 'admin') {
      const existing = stmts.getUserByUsername.get(username);
      if (existing) {
        if (existing.password_hash) return existing;
        const newSecret = generateAgentSecret();
        stmts.updateUserMigrate.run(passwordHash, email, role, newSecret, existing.id);
        return { ...existing, password_hash: passwordHash, email, role, agent_secret: existing.agent_secret || newSecret };
      }
      return this.createFull(username, passwordHash, email, role);
    },
    get(id) { return stmts.getUserById.get(id); },
    getByUsername(username) { return stmts.getUserByUsername.get(username); },
    getUserByAgentSecret(secret) { return secret ? (stmts.getUserByAgentSecret.get(secret) || null) : null; },
    getAll() { return stmts.getAllUsers.all(); },
    updateLogin(id) { stmts.updateUserLogin.run(Date.now(), id); },
    updatePassword(userId, hash) { stmts.updateUserPassword.run(hash, userId); },
    updateEmail(userId, email) { stmts.updateUserEmail.run(email, userId); },
    getAgentSecret(userId) { const u = stmts.getUserById.get(userId); return u?.agent_secret || null; },
    resetAgentSecret(userId) { const s = generateAgentSecret(); stmts.updateUserAgentSecret.run(s, userId); return s; },
    updateRole(userId, role) { stmts.updateUserRole.run(role, userId); },
    getTotp(username) {
      const r = stmts.getUserTotp.get(username);
      return r ? { totpSecret: r.totp_secret, totpEnabled: !!r.totp_enabled } : null;
    },
    updateTotp(username, totpSecret, totpEnabled) {
      let user = stmts.getUserByUsername.get(username);
      if (!user) {
        const id = generateUserId();
        stmts.insertUser.run(id, username, username, Date.now());
      }
      stmts.updateUserTotp.run(totpSecret, totpEnabled ? 1 : 0, username);
      return true;
    },
    getByAadOid(aadOid) {
      if (!aadOid) return null;
      return stmts.getUserByAadOid.get(aadOid) || null;
    },
    updateAadOid(userId, aadOid) {
      stmts.updateUserAadOid.run(aadOid, userId);
    },
    createFromAad(username, email, aadOid, role = 'pro') {
      const id = generateUserId();
      const now = Date.now();
      const agentSecret = generateAgentSecret();
      stmts.insertUserFull.run(id, username, username, null, email, agentSecret, role, now);
      stmts.updateUserAadOid.run(aadOid, id);
      return { id, username, display_name: username, email, aad_oid: aadOid, agent_secret: agentSecret, role, created_at: now };
    }
  };

  // fix-chat-title-sticky: mirror server/db/session-db.js#mapRow so tests
  // see the same `customTitle` boolean the production code surfaces.
  function mapSessionRow(row) {
    if (!row) return row;
    return { ...row, customTitle: row.is_custom_title === 1 };
  }

  const sessionDb = {
    create(id, agentId, agentName, workDir, claudeSessionId = null, title = null, userId = null) {
      const now = Date.now();
      stmts.insertSession.run(id, userId, agentId, agentName, claudeSessionId, workDir, title, now, now);
      return { id, userId, agentId, agentName, workDir, claudeSessionId, title, customTitle: false, createdAt: now, updatedAt: now };
    },
    update(id, updates = {}) {
      stmts.updateSession.run(
        updates.claudeSessionId ?? null,
        updates.title ?? null,
        updates.isCustomTitle ?? null,
        Date.now(),
        id
      );
    },
    setActive(id, active) { stmts.updateSessionActive.run(active ? 1 : 0, Date.now(), id); },
    // fix-session-dup: mirror server/db/session-db.js#setAgent so the
    // test fixture can rehearse the cross-agent transfer.
    setAgent(id, agentId, agentName) {
      stmts.updateSessionAgent.run(agentId, agentName ?? null, Date.now(), id);
    },
    setPinned(id, pinned) {
      stmts.updateSessionPinned.run(pinned ? 1 : 0, Date.now(), id);
    },
    get(id) { return mapSessionRow(stmts.getSession.get(id)); },
    exists(id) { return !!stmts.getSession.get(id); },
    getByAgent(agentId, limit = 50) { return stmts.getSessionsByAgent.all(agentId, limit).map(mapSessionRow); },
    getByUser(userId, limit = 50) { return stmts.getSessionsByUser.all(userId, limit).map(mapSessionRow); },
    getByUserAndAgent(userId, agentId, limit = 50) { return stmts.getSessionsByUserAndAgent.all(userId, agentId, limit).map(mapSessionRow); },
    getAll(limit = 100) { return stmts.getAllSessions.all(limit).map(mapSessionRow); },
    getActive() { return stmts.getActiveSessions.all().map(mapSessionRow); },
    getActiveByUser(userId) { return stmts.getActiveSessionsByUser.all(userId).map(mapSessionRow); },
    delete(id) { stmts.deleteSession.run(id); }
  };

  const messageDb = {
    // fix-usermsg-dup: `metadata` is an opaque JSON-string blob that
    // currently carries `{clientMessageId, experts?, askRequestId?}`. The
    // call site in server/handlers/agent-output.js packs the object,
    // formatDbMessage on the web side parses it back out.
    add(sessionId, role, content, messageType = null, toolName = null, toolInput = null, metadata = null) {
      const now = Date.now();
      const result = stmts.insertMessage.run(sessionId, role, content, messageType, toolName, toolInput, now, metadata);
      // fix-chat-title-sticky: bump updated_at without touching title /
      // sticky bit — pass null for all three nullable fields.
      stmts.updateSession.run(null, null, null, now, sessionId);
      return result.lastInsertRowid;
    },
    updateMetadata(id, metadata) {
      stmts.updateMessageMetadata.run(metadata, id);
    },
    getBySession(sessionId) { return stmts.getMessagesBySession.all(sessionId); },
    getRecent(sessionId, limit = 50) { return stmts.getRecentMessages.all(sessionId, limit).reverse(); },
    getAfterId(sessionId, afterId) { return stmts.getMessagesAfterId.all(sessionId, afterId || 0); },
    getBeforeId(sessionId, beforeId, limit = 50) { return stmts.getMessagesBeforeId.all(sessionId, beforeId, limit).reverse(); },
    getCount(sessionId) { return stmts.getMessageCount.get(sessionId)?.count || 0; },
    deleteBySession(sessionId) { stmts.deleteMessagesBySession.run(sessionId); },

    getRecentTurns(sessionId, turnCount = 5) {
      const userIds = stmts.getRecentUserMessageIds.all(sessionId, turnCount);
      if (userIds.length === 0) return { messages: [], hasMore: false };
      const oldestUserId = userIds[userIds.length - 1].id;
      const messages = stmts.getMessagesFromId.all(sessionId, oldestUserId);
      const hasMore = stmts.getMessagesBeforeId.all(sessionId, oldestUserId, 1).length > 0;
      return { messages, hasMore };
    },

    getTurnsBeforeId(sessionId, beforeId, turnCount = 5) {
      const userIds = stmts.getUserMessageIdsBeforeId.all(sessionId, beforeId, turnCount);
      if (userIds.length === 0) return { messages: [], hasMore: false };
      const oldestUserId = userIds[userIds.length - 1].id;
      const messages = stmts.getMessagesBetweenIds.all(sessionId, oldestUserId, beforeId);
      const hasMore = stmts.getMessagesBeforeId.all(sessionId, oldestUserId, 1).length > 0;
      return { messages, hasMore };
    },

    getLastUserMessage(sessionId) {
      return stmts.getLastUserMessage.get(sessionId) || null;
    },

    bulkAddHistory(sessionId, historyMessages) {
      function extractUserText(msg) {
        const content = msg.message?.content;
        if (!content) return '';
        return typeof content === 'string'
          ? content
          : (Array.isArray(content) ? content.map(b => b.text || '').join('') : JSON.stringify(content));
      }

      let msgsToInsert = historyMessages;
      const lastUserMsg = this.getLastUserMessage(sessionId);
      let needsRebuild = false;

      if (lastUserMsg) {
        const tsRange = stmts.getTimestampRange.get(sessionId);
        if (tsRange && tsRange.count > 5 && (tsRange.max_ts - tsRange.min_ts) < 1000) {
          needsRebuild = true;
        } else {
          const anchor = lastUserMsg.content;
          let anchorIndex = -1;
          for (let i = historyMessages.length - 1; i >= 0; i--) {
            const msg = historyMessages[i];
            if (msg.type === 'user') {
              const text = extractUserText(msg);
              if (text === anchor) { anchorIndex = i; break; }
            }
          }
          if (anchorIndex === -1) {
            // anchor not found, append all
          } else {
            let nextTurnStart = -1;
            for (let i = anchorIndex + 1; i < historyMessages.length; i++) {
              if (historyMessages[i].type === 'user') { nextTurnStart = i; break; }
            }
            if (nextTurnStart === -1) return 0;
            msgsToInsert = historyMessages.slice(nextTurnStart);
          }
        }
      }

      const insertMany = (msgs) => {
        db.exec('BEGIN');
        try {
          if (needsRebuild) {
            stmts.deleteMessagesBySession.run(sessionId);
          }
          let count = 0;
          let lastTs = 0;
          for (const msg of msgs) {
            const rawTs = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
            const ts = rawTs > lastTs ? rawTs : lastTs + 1;
            lastTs = ts;

            if (msg.type === 'user') {
              const text = extractUserText(msg);
              if (text) {
                stmts.insertMessage.run(sessionId, 'user', text, 'user', null, null, ts, null);
                count++;
              }
            } else if (msg.type === 'assistant') {
              const content = msg.message?.content;
              if (!content || !Array.isArray(content)) continue;
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  stmts.insertMessage.run(sessionId, 'assistant', block.text, 'assistant', null, null, ts, null);
                  count++;
                } else if (block.type === 'tool_use') {
                  stmts.insertMessage.run(
                    sessionId, 'assistant', JSON.stringify(block.input || {}),
                    'tool_use', block.name, JSON.stringify(block.input || {}), ts, null
                  );
                  count++;
                }
              }
            }
          }
          db.exec('COMMIT');
          return count;
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      };
      return insertMany(msgsToInsert);
    }
  };

  const invitationDb = {
    create(createdBy, role = 'user', expiresInMs = 7 * 24 * 60 * 60 * 1000) {
      const code = randomBytes(6).toString('hex');
      const now = Date.now();
      const expiresAt = now + expiresInMs;
      stmts.insertInvitation.run(code, createdBy, now, expiresAt, role);
      return { code, createdBy, createdAt: now, expiresAt, role };
    },
    get(code) { return stmts.getInvitation.get(code) || null; },
    use(code, usedBy) { stmts.useInvitation.run(usedBy, Date.now(), code); },
    getByUser(userId) { return stmts.getInvitationsByUser.all(userId); },
    delete(code, userId) { return stmts.deleteInvitation.run(code, userId).changes > 0; },
    cleanup() { stmts.cleanupExpiredInvitations.run(Date.now()); }
  };

  return { userDb, sessionDb, messageDb, invitationDb };
}
