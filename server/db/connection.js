import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 数据库文件位置
const DATA_DIR = process.env.TEST_DB_DIR || join(__dirname, '../../data');
const DB_PATH = process.env.TEST_DB_PATH || join(DATA_DIR, 'webchat.db');

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 创建数据库连接
const db = new DatabaseSync(DB_PATH);

// 启用 WAL 模式提高性能
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 初始化表结构（不包含索引，索引在迁移后创建）
db.exec(`
  -- 用户表
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  -- 会话表
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

  -- 消息表
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

  -- 邀请码表
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

  -- 用户统计表
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    message_count INTEGER DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    request_count INTEGER DEFAULT 0,
    bytes_sent INTEGER DEFAULT 0,
    bytes_received INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );

  -- 每日统计表（按天聚合用户用量）
  CREATE TABLE IF NOT EXISTS daily_stats (
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    session_count INTEGER DEFAULT 0,
    request_count INTEGER DEFAULT 0,
    bytes_sent INTEGER DEFAULT 0,
    bytes_received INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );

  -- 基本索引（不依赖迁移列）
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
`);

// 数据库迁移 - 添加缺失的列
const migrations = [
  `ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)`,
  `ALTER TABLE users ADD COLUMN totp_secret TEXT`,
  `ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  `ALTER TABLE users ADD COLUMN email TEXT`,
  `ALTER TABLE users ADD COLUMN agent_secret TEXT`,
  `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`,
  `ALTER TABLE messages ADD COLUMN metadata TEXT`,
  `ALTER TABLE sessions ADD COLUMN is_pinned INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN aad_oid TEXT`
];

for (const migration of migrations) {
  try {
    db.exec(migration);
  } catch (e) {
    // 列已存在，忽略错误
  }
}

// User identities table (multi-provider SSO + account binding)
// One user can have multiple identities (microsoft / github / google / wechat / alipay).
// UNIQUE(provider, subject) enforces "this provider account is bound to one user only".
const identityTable = `
  CREATE TABLE IF NOT EXISTS user_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    UNIQUE(provider, subject)
  );

  CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);
  CREATE INDEX IF NOT EXISTS idx_identities_provider ON user_identities(provider);
`;
try { db.exec(identityTable); } catch (e) { /* tables already exist */ }

// One-time backfill: copy existing users.aad_oid into user_identities so
// legacy AAD users automatically participate in the new identity model.
try {
  const aadUsers = db.prepare("SELECT id, email FROM users WHERE aad_oid IS NOT NULL AND aad_oid != ''").all();
  if (aadUsers.length > 0) {
    const checkStmt = db.prepare(
      "SELECT id FROM user_identities WHERE provider = 'microsoft' AND user_id = ?"
    );
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO user_identities (id, user_id, provider, subject, email, display_name, created_at)
       VALUES (?, ?, 'microsoft', ?, ?, NULL, ?)`
    );
    const getOidStmt = db.prepare("SELECT aad_oid FROM users WHERE id = ?");
    for (const u of aadUsers) {
      if (checkStmt.get(u.id)) continue;
      const oidRow = getOidStmt.get(u.id);
      const oid = oidRow?.aad_oid;
      if (!oid) continue;
      const idVal = `idn_${randomUUID()}`;
      try { insertStmt.run(idVal, u.id, oid, u.email || null, Date.now()); } catch (e) { /* unique conflict */ }
    }
  }
} catch (e) { /* table missing or migration error — non-fatal */ }

// Custom expert roles tables (帮帮团自定义角色)
const customExpertTables = `
  CREATE TABLE IF NOT EXISTS custom_expert_roles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    role_id TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT,
    title TEXT NOT NULL,
    title_en TEXT,
    group_id TEXT NOT NULL DEFAULT 'custom',
    icon TEXT,
    message_prefix TEXT,
    message_prefix_en TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS custom_expert_actions (
    id TEXT PRIMARY KEY,
    role_row_id TEXT NOT NULL REFERENCES custom_expert_roles(id) ON DELETE CASCADE,
    action_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT,
    message_template TEXT,
    message_template_en TEXT,
    default_message TEXT,
    default_message_en TEXT,
    UNIQUE(role_row_id, action_id)
  );

  CREATE INDEX IF NOT EXISTS idx_custom_expert_roles_user ON custom_expert_roles(user_id);
  CREATE INDEX IF NOT EXISTS idx_custom_expert_actions_role ON custom_expert_actions(role_row_id);
`;
try { db.exec(customExpertTables); } catch (e) { /* tables already exist */ }

// 创建依赖迁移列的索引（在迁移后）
const postMigrationIndexes = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_agent_secret ON users(agent_secret)`,
  `CREATE INDEX IF NOT EXISTS idx_users_aad_oid ON users(aad_oid)`
];
for (const idx of postMigrationIndexes) {
  try { db.exec(idx); } catch (e) { /* 索引已存在 */ }
}

// 生成用户级 Agent 密钥
export function generateAgentSecret() {
  return randomBytes(32).toString('hex');
}

// 生成用户 ID
export function generateUserId() {
  return `user_${randomUUID()}`;
}

// 准备常用语句
export const stmts = {
  // User 操作
  insertUser: db.prepare(`
    INSERT INTO users (id, username, display_name, created_at)
    VALUES (?, ?, ?, ?)
  `),

  insertUserFull: db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, email, agent_secret, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateUserLogin: db.prepare(`
    UPDATE users SET last_login_at = ? WHERE id = ?
  `),

  updateUserPassword: db.prepare(`
    UPDATE users SET password_hash = ? WHERE id = ?
  `),

  updateUserEmail: db.prepare(`
    UPDATE users SET email = ? WHERE id = ?
  `),

  updateUserAgentSecret: db.prepare(`
    UPDATE users SET agent_secret = ? WHERE id = ?
  `),

  updateUserRole: db.prepare(`
    UPDATE users SET role = ? WHERE id = ?
  `),

  updateUserMigrate: db.prepare(`
    UPDATE users SET password_hash = ?, email = ?, role = ?, agent_secret = COALESCE(agent_secret, ?) WHERE id = ?
  `),

  getUserById: db.prepare(`
    SELECT * FROM users WHERE id = ?
  `),

  getUserByUsername: db.prepare(`
    SELECT * FROM users WHERE username = ?
  `),

  getUserByAgentSecret: db.prepare(`
    SELECT * FROM users WHERE agent_secret = ?
  `),

  getAllUsers: db.prepare(`
    SELECT * FROM users ORDER BY created_at DESC
  `),

  updateUserTotp: db.prepare(`
    UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE username = ?
  `),

  getUserTotp: db.prepare(`
    SELECT totp_secret, totp_enabled FROM users WHERE username = ?
  `),

  getUserByAadOid: db.prepare(`
    SELECT * FROM users WHERE aad_oid = ?
  `),

  updateUserAadOid: db.prepare(`
    UPDATE users SET aad_oid = ? WHERE id = ?
  `),

  // Invitation 操作
  insertInvitation: db.prepare(`
    INSERT INTO invitations (id, created_by, created_at, expires_at, role)
    VALUES (?, ?, ?, ?, ?)
  `),

  getInvitation: db.prepare(`
    SELECT * FROM invitations WHERE id = ?
  `),

  useInvitation: db.prepare(`
    UPDATE invitations SET used_by = ?, used_at = ? WHERE id = ?
  `),

  getInvitationsByUser: db.prepare(`
    SELECT i.*, u.username AS used_by_username
    FROM invitations i
    LEFT JOIN users u ON i.used_by = u.id
    WHERE i.created_by = ?
    ORDER BY i.created_at DESC
  `),

  deleteInvitation: db.prepare(`
    DELETE FROM invitations WHERE id = ? AND created_by = ? AND used_by IS NULL
  `),

  cleanupExpiredInvitations: db.prepare(`
    DELETE FROM invitations WHERE expires_at < ? AND used_by IS NULL
  `),

  // Session 操作
  insertSession: db.prepare(`
    INSERT INTO sessions (id, user_id, agent_id, agent_name, claude_session_id, work_dir, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateSession: db.prepare(`
    UPDATE sessions SET
      claude_session_id = COALESCE(?, claude_session_id),
      title = COALESCE(?, title),
      updated_at = ?
    WHERE id = ?
  `),

  updateSessionActive: db.prepare(`
    UPDATE sessions SET is_active = ?, updated_at = ? WHERE id = ?
  `),

  updateSessionPinned: db.prepare(`
    UPDATE sessions SET is_pinned = ?, updated_at = ? WHERE id = ?
  `),

  getSession: db.prepare(`
    SELECT * FROM sessions WHERE id = ?
  `),

  getSessionsByAgent: db.prepare(`
    SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?
  `),

  getSessionsByUser: db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
  `),

  getSessionsByUserAndAgent: db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC LIMIT ?
  `),

  getAllSessions: db.prepare(`
    SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?
  `),

  getActiveSessions: db.prepare(`
    SELECT * FROM sessions WHERE is_active = 1 ORDER BY updated_at DESC
  `),

  getActiveSessionsByUser: db.prepare(`
    SELECT * FROM sessions WHERE (user_id = ? OR user_id IS NULL) AND is_active = 1 ORDER BY updated_at DESC
  `),

  deleteSession: db.prepare(`
    DELETE FROM sessions WHERE id = ?
  `),

  // Message 操作
  insertMessage: db.prepare(`
    INSERT INTO messages (session_id, role, content, message_type, tool_name, tool_input, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getRecentUserMessageIds: db.prepare(`
    SELECT id FROM messages WHERE session_id = ? AND role = 'user'
    ORDER BY id DESC LIMIT ?
  `),

  getMessagesFromId: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND id >= ?
    ORDER BY id ASC
  `),

  getUserMessageIdsBeforeId: db.prepare(`
    SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND id < ?
    ORDER BY id DESC LIMIT ?
  `),

  getMessagesBetweenIds: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND id >= ? AND id < ?
    ORDER BY id ASC
  `),

  getMessagesBySession: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC
  `),

  getRecentMessages: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
  `),

  getMessagesAfterId: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC
  `),

  getMessagesBeforeId: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND id < ?
    ORDER BY id DESC LIMIT ?
  `),

  getMessageCount: db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE session_id = ?
  `),

  getTimestampRange: db.prepare(`
    SELECT MIN(created_at) as min_ts, MAX(created_at) as max_ts, COUNT(*) as count
    FROM messages WHERE session_id = ?
  `),

  getLastUserMessage: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND role = 'user'
    ORDER BY id DESC LIMIT 1
  `),

  deleteMessagesBySession: db.prepare(`
    DELETE FROM messages WHERE session_id = ?
  `),

  updateMessageMetadata: db.prepare(`
    UPDATE messages SET metadata = ? WHERE id = ?
  `),

  // UserStats 操作
  upsertUserStats: db.prepare(`
    INSERT INTO user_stats (user_id, message_count, session_count, request_count, bytes_sent, bytes_received, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      message_count = message_count + excluded.message_count,
      session_count = session_count + excluded.session_count,
      request_count = request_count + excluded.request_count,
      bytes_sent = bytes_sent + excluded.bytes_sent,
      bytes_received = bytes_received + excluded.bytes_received,
      updated_at = excluded.updated_at
  `),

  // DailyStats 操作
  upsertDailyStats: db.prepare(`
    INSERT INTO daily_stats (user_id, date, message_count, session_count, request_count, bytes_sent, bytes_received)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      message_count = message_count + excluded.message_count,
      session_count = session_count + excluded.session_count,
      request_count = request_count + excluded.request_count,
      bytes_sent = bytes_sent + excluded.bytes_sent,
      bytes_received = bytes_received + excluded.bytes_received
  `),

  getDailyStatsAll: db.prepare(`
    SELECT ds.user_id, u.username, u.display_name, u.role, u.last_login_at,
      SUM(ds.message_count) as message_count, SUM(ds.session_count) as session_count,
      SUM(ds.request_count) as request_count, SUM(ds.bytes_sent) as bytes_sent,
      SUM(ds.bytes_received) as bytes_received
    FROM daily_stats ds
    JOIN users u ON ds.user_id = u.id
    WHERE ds.date >= ?
    GROUP BY ds.user_id
    ORDER BY message_count DESC
  `),

  getTodayActiveUsers: db.prepare(`
    SELECT COUNT(DISTINCT user_id) as count FROM daily_stats WHERE date = ?
  `),

  getTodayMessages: db.prepare(`
    SELECT COALESCE(SUM(message_count), 0) as count FROM daily_stats WHERE date = ?
  `),

  getUserStats: db.prepare(`
    SELECT us.*, u.username, u.display_name, u.role, u.last_login_at
    FROM user_stats us
    JOIN users u ON us.user_id = u.id
    ORDER BY us.message_count DESC
  `),

  getUserStatsById: db.prepare(`
    SELECT * FROM user_stats WHERE user_id = ?
  `),

  // Identity 操作 (multi-provider SSO)
  insertIdentity: db.prepare(`
    INSERT INTO user_identities (id, user_id, provider, subject, email, display_name, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getIdentityBySubject: db.prepare(`
    SELECT * FROM user_identities WHERE provider = ? AND subject = ?
  `),

  getIdentitiesByUser: db.prepare(`
    SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at ASC
  `),

  getIdentityForUser: db.prepare(`
    SELECT * FROM user_identities WHERE user_id = ? AND provider = ?
  `),

  countIdentitiesByUser: db.prepare(`
    SELECT COUNT(*) as count FROM user_identities WHERE user_id = ?
  `),

  updateIdentityLogin: db.prepare(`
    UPDATE user_identities SET last_login_at = ? WHERE id = ?
  `),

  deleteIdentityForUser: db.prepare(`
    DELETE FROM user_identities WHERE user_id = ? AND provider = ?
  `),

  // Dashboard 聚合
  getDashboardTotals: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM sessions) as total_sessions,
      (SELECT COUNT(*) FROM messages) as total_messages
  `)
};

// 关闭数据库连接（用于优雅退出）
export function closeDb() {
  db.close();
}

/**
 * Run a function inside a SQLite transaction.
 * node:sqlite (DatabaseSync) does not provide better-sqlite3's `db.transaction(fn)`
 * helper, so we wrap BEGIN/COMMIT/ROLLBACK manually.
 *
 * Returns a function with the same signature as `fn` (call it with the same args)
 * to mirror the better-sqlite3 API.
 *
 * @template T
 * @template {any[]} A
 * @param {(...args: A) => T} fn
 * @returns {(...args: A) => T}
 */
export function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
      throw err;
    }
  };
}

// 进程退出时关闭数据库（兜底）
process.on('exit', closeDb);

export default db;
