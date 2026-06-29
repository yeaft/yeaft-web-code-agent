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
  -- feat-chat-load-perf: composite covering index for the role='user' filter
  -- used by getRecentUserMessageIds / getLastUserMessage / getUserMessageIdsBeforeId.
  -- Pre-fix: SQLite seeks by (session_id) then post-filters every row by role,
  -- which is hundreds of ms on sessions with thousands of messages. Post-fix:
  -- direct index seek + reverse scan limited to N user rows. Built in the
  -- base block (not postMigrationIndexes) because session_id / role / id all
  -- live in the base CREATE TABLE — there's no migration-column dependency.
  -- IF NOT EXISTS makes this a one-shot cost on first startup post-deploy; on
  -- a messages table with hundreds of thousands of rows the build can take
  -- several seconds, so we time it just below. WAL mode (line 22) lets
  -- concurrent reads continue during the build; writers will block briefly.
  CREATE INDEX IF NOT EXISTS idx_messages_session_role_id ON messages(session_id, role, id DESC);
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
  `ALTER TABLE users ADD COLUMN aad_oid TEXT`,
  // fix-chat-title-sticky: persist the "user manually renamed this session"
  // bit so it survives agent reconnect / server restart / DB rehydration.
  // Before this column existed, the bit lived only on the in-memory
  // `convInfo.customTitle` flag, and every rebuild path
  // (agent-conversation handlers, agent-sync, get_agents) wiped it —
  // letting the per-message auto-title write at
  // `client-conversation.js:351` clobber the user's renamed title.
  `ALTER TABLE sessions ADD COLUMN is_custom_title INTEGER DEFAULT 0`,
  // feat-chat-load-perf: one-shot rebuild sentinel for the `bulkAddHistory`
  // timestamp-range heuristic in server/db/message-db.js. The heuristic
  // (when count > 5 and (max_ts - min_ts) < 1000ms) was designed to repair
  // sessions whose timestamps got bunched by an old anchor-detection bug,
  // by deleting all rows for the session and re-inserting from the agent's
  // historyMessages payload. Without a sentinel, every subsequent resume
  // re-triggers the rebuild (because the rebuild itself produces tightly
  // spaced `ts = lastTs + 1` values that re-pass the < 1000ms test), so the
  // user pays a full delete+rebuild on EVERY session open. The sentinel
  // (Unix-ms stamp at the time of the one and only repair) lets the
  // heuristic fire exactly once per session for the lifetime of the row.
  `ALTER TABLE sessions ADD COLUMN ts_rebuilt_at INTEGER DEFAULT 0`,
  // fix-copilot-provider-persist: persist the conversation's PROVIDER
  // (claude-code / copilot / ...) so it survives an agent process restart.
  // Before this column the provider lived ONLY in the agent's in-memory
  // ctx.conversations Map (state.providerName). On restart that Map is empty,
  // so the agent reported no provider, the server rebuilt convs from DB
  // without one → the UI lost the "copilot" marker AND sends mis-routed to
  // Claude (handleUserInput resolved providerName to the default). The send
  // forward now reads this column so the agent can self-heal its ACP child.
  `ALTER TABLE sessions ADD COLUMN provider TEXT`
];

// Yeaft sessions table — server-side persistence so the unified sidebar
// can list yeaft sessions across all the user's agents (online or not)
// and survive reload, mirroring how chat conversations work via the
// `sessions` table. Schema is deliberately separate because the
// lifecycle and metadata diverge (roster, defaultVpId, per-session
// config overrides — none of which are chat concerns).
const yeaftSessionsTable = `
  CREATE TABLE IF NOT EXISTS yeaft_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
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
    is_pinned INTEGER DEFAULT 0,
    sort_order INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_user ON yeaft_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_agent ON yeaft_sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_updated ON yeaft_sessions(updated_at DESC);
`;
db.exec(yeaftSessionsTable);

// Yeaft session schema additions (separate from `migrations` above so the
// table existence in the CREATE block above is guaranteed before we try
// to ALTER it). Same try/swallow pattern: ignores "column exists" on
// fresh DBs that already got the column from CREATE TABLE.
const yeaftMigrations = [
  // fix-yeaft-session-list-and-menu: per-session pin state. Lives on the
  // server so it survives reload / cross-device / agent restart; mirrored
  // into chatStore.pinnedSessions on the web so sort logic stays unified
  // between chat and yeaft.
  `ALTER TABLE yeaft_sessions ADD COLUMN is_pinned INTEGER DEFAULT 0`,
  `ALTER TABLE yeaft_sessions ADD COLUMN sort_order INTEGER`,
];
for (const migration of yeaftMigrations) {
  try { db.exec(migration); } catch (_) { /* column exists */ }
}

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
// Time the post-migration index pass so the operational signal lands in the
// deploy log on first startup after composite-index addition — a multi-second
// index build over the messages table should not look like "the server hung".
// (The composite idx_messages_session_role_id itself was moved into the base
// CREATE INDEX block above; its first-time cost shows up in the engine init.)
console.time('[db] postMigrationIndexes');
for (const idx of postMigrationIndexes) {
  try { db.exec(idx); } catch (e) { /* 索引已存在 */ }
}
console.timeEnd('[db] postMigrationIndexes');

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

  updateUserDisplayName: db.prepare(`
    UPDATE users SET display_name = ? WHERE id = ?
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
    INSERT INTO sessions (id, user_id, agent_id, agent_name, claude_session_id, work_dir, title, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateSession: db.prepare(`
    UPDATE sessions SET
      claude_session_id = COALESCE(?, claude_session_id),
      title = COALESCE(?, title),
      is_custom_title = COALESCE(?, is_custom_title),
      updated_at = ?
    WHERE id = ?
  `),

  updateSessionActive: db.prepare(`
    UPDATE sessions SET is_active = ?, updated_at = ? WHERE id = ?
  `),

  // fix-session-dup: transfer a session row to a new owning agent.
  // Needed when the user resumes a conversation against a different
  // agent than the one that originally created it — without this,
  // DB.agent_id keeps pointing at the old agent and on the next
  // `get_agents` restore (client-conversation.js:`get_agents`) the
  // conv gets reseated into the OLD agent's in-memory Map alongside
  // the new owner, which is the server-side root of Bug 2 (one conv
  // rendered as two sidebar rows with different agent badges).
  updateSessionAgent: db.prepare(`
    UPDATE sessions SET agent_id = ?, agent_name = ?, updated_at = ? WHERE id = ?
  `),

  updateSessionPinned: db.prepare(`
    UPDATE sessions SET is_pinned = ?, updated_at = ? WHERE id = ?
  `),

  // fix-copilot-provider-persist: persist the conversation's code-agent
  // provider so it survives an agent process restart. Mirrors the pinned/
  // agent update shape. Only written when a non-default provider is known
  // (the create/resume handlers pass msg.provider through).
  updateSessionProvider: db.prepare(`
    UPDATE sessions SET provider = ?, updated_at = ? WHERE id = ?
  `),

  // feat-chat-load-perf: one-shot sentinel for the bulkAddHistory timestamp-
  // rebuild repair path. ts_rebuilt_at = 0 means "never repaired"; non-zero
  // means "repair already ran at this Unix-ms". The repair is destructive
  // (DELETE + re-INSERT all rows for the session) so it must run at most once
  // per session over its lifetime. Statements live in the Session block
  // because they SELECT/UPDATE the `sessions` table — the bulkAddHistory
  // call site in server/db/message-db.js is the only consumer today.
  getSessionTsRebuiltAt: db.prepare(`
    SELECT ts_rebuilt_at FROM sessions WHERE id = ?
  `),

  markSessionTsRebuilt: db.prepare(`
    UPDATE sessions SET ts_rebuilt_at = ? WHERE id = ?
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

  // feat-chat-load-perf: one-shot sentinel for the bulkAddHistory timestamp-
  // rebuild repair path. ts_rebuilt_at = 0 means "never repaired"; non-zero
  // means "repair already ran at this Unix-ms". The repair is destructive
  // (DELETE + re-INSERT all rows for the session) so it must run at most once
  // per session over its lifetime.
  getSessionTsRebuiltAt: db.prepare(`
    SELECT ts_rebuilt_at FROM sessions WHERE id = ?
  `),

  markSessionTsRebuilt: db.prepare(`
    UPDATE sessions SET ts_rebuilt_at = ? WHERE id = ?
  `),

  getLastUserMessage: db.prepare(`
    SELECT * FROM messages WHERE session_id = ? AND role = 'user'
    ORDER BY id DESC LIMIT 1
  `),

  deleteMessagesBySession: db.prepare(`
    DELETE FROM messages WHERE session_id = ?
  `),

  deleteMessagesAfterId: db.prepare(`
    DELETE FROM messages WHERE session_id = ? AND id > ?
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

  // Hard-delete cascade for account deletion.
  // user_identities and messages cascade automatically; the rest are explicit.
  deleteUserSessionsByUser: db.prepare(`
    DELETE FROM sessions WHERE user_id = ?
  `),
  deleteYeaftSessionsByUserCascade: db.prepare(`
    DELETE FROM yeaft_sessions WHERE user_id = ?
  `),
  deleteIdentitiesForUser: db.prepare(`
    DELETE FROM user_identities WHERE user_id = ?
  `),
  deleteUserStats: db.prepare(`
    DELETE FROM user_stats WHERE user_id = ?
  `),
  deleteDailyStatsForUser: db.prepare(`
    DELETE FROM daily_stats WHERE user_id = ?
  `),
  deleteCustomExpertRolesForUser: db.prepare(`
    DELETE FROM custom_expert_roles WHERE user_id = ?
  `),
  // Invitations: keep history but null-out the FK so it doesn't block deletion.
  // (created_by is NOT NULL, so for invitations the user created we just delete them.)
  deleteInvitationsCreatedBy: db.prepare(`
    DELETE FROM invitations WHERE created_by = ?
  `),
  clearInvitationUsedBy: db.prepare(`
    UPDATE invitations SET used_by = NULL WHERE used_by = ?
  `),
  deleteUserById: db.prepare(`
    DELETE FROM users WHERE id = ?
  `),

  // Yeaft session 操作
  upsertYeaftSession: db.prepare(`
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

  getYeaftSession: db.prepare(`
    SELECT * FROM yeaft_sessions WHERE id = ?
  `),

  getYeaftSessionsByUser: db.prepare(`
    SELECT * FROM yeaft_sessions
    WHERE user_id = ? AND is_archived = 0
    ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, updated_at DESC
  `),

  getYeaftSessionsByAgent: db.prepare(`
    SELECT * FROM yeaft_sessions
    WHERE agent_id = ? AND is_archived = 0
    ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, updated_at DESC
  `),

  deleteYeaftSession: db.prepare(`
    DELETE FROM yeaft_sessions WHERE id = ?
  `),

  deleteYeaftSessionsByUser: db.prepare(`
    DELETE FROM yeaft_sessions WHERE user_id = ?
  `),

  setYeaftSessionArchived: db.prepare(`
    UPDATE yeaft_sessions SET is_archived = ?, updated_at = ? WHERE id = ?
  `),

  setYeaftSessionPinned: db.prepare(`
    UPDATE yeaft_sessions SET is_pinned = ?, updated_at = ? WHERE id = ?
  `),

  setYeaftSessionSortOrder: db.prepare(`
    UPDATE yeaft_sessions
    SET sort_order = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND agent_id = ?
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
