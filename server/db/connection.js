import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 数据库文件位置
const DATA_DIR = process.env.SERVER_DATA_DIR || process.env.TEST_DB_DIR || join(__dirname, '../../data');
const DB_PATH = process.env.SERVER_DATA_DIR
  ? join(DATA_DIR, 'webchat.db')
  : (process.env.TEST_DB_PATH || join(DATA_DIR, 'webchat.db'));

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
    last_login_at INTEGER,
    deletion_state TEXT NOT NULL DEFAULT 'active',
    deletion_requested_at INTEGER,
    deletion_id TEXT UNIQUE
  );

  -- Finalized deletion survives removal of the users row. This prevents a
  -- configured credential from becoming authoritative again on restart.
  CREATE TABLE IF NOT EXISTS user_deletion_tombstones (
    username TEXT PRIMARY KEY,
    deletion_id TEXT,
    deleted_at INTEGER NOT NULL
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
    metadata_updated_at INTEGER,
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
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    last_turn_completed_at INTEGER,
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
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );

  -- Agent token metric watermarks. Agent snapshots are cumulative within one
  -- process epoch; this table makes reconnects and server restarts idempotent.
  CREATE TABLE IF NOT EXISTS agent_metric_watermarks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_instance_id TEXT NOT NULL,
    metric_epoch TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_instance_id, metric_epoch)
  );

  -- Durable last-known Agent inventory for admin operations. online is not
  -- stored here: it is derived from the current owner-scoped WebSocket map.
  -- Keeping the inventory separate from sessions preserves historical Agents
  -- after their socket disconnects and across Server restarts.
  CREATE TABLE IF NOT EXISTS agent_inventory (
    id TEXT PRIMARY KEY,
    instance_id TEXT,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    work_dir TEXT,
    version TEXT,
    platform TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    capability_metadata_provided INTEGER NOT NULL DEFAULT 0,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    metrics_updated_at INTEGER,
    last_seen_at INTEGER NOT NULL,
    last_connected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
  CREATE INDEX IF NOT EXISTS idx_agent_inventory_owner_seen ON agent_inventory(owner_id, last_seen_at DESC);

  -- Managed Sandbox control-plane state. Runtime resources are deliberately
  -- not created on this mixed-use Server Host; qualified Controllers report
  -- Host capacity separately.
  CREATE TABLE IF NOT EXISTS sandbox_hosts (
    id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    qualified INTEGER NOT NULL DEFAULT 0,
    controller_healthy INTEGER NOT NULL DEFAULT 0,
    helper_healthy INTEGER NOT NULL DEFAULT 0,
    runtime_healthy INTEGER NOT NULL DEFAULT 0,
    quota_healthy INTEGER NOT NULL DEFAULT 0,
    network_healthy INTEGER NOT NULL DEFAULT 0,
    image_digest TEXT NOT NULL,
    cpu_millis_total INTEGER NOT NULL,
    memory_mib_total INTEGER NOT NULL,
    memory_mib_available INTEGER NOT NULL,
    disk_gib_total INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_host_attestations (
    nonce TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES sandbox_hosts(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Controller boot identity is only a change detector. The Server owns this
  -- durable monotonic fence and its exact activation identity.
  CREATE TABLE IF NOT EXISTS sandbox_host_epochs (
    host_id TEXT PRIMARY KEY REFERENCES sandbox_hosts(id) ON DELETE CASCADE,
    source_epoch TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch >= 1),
    activation_digest TEXT,
    activated_at INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sandbox_host_attestations_host
    ON sandbox_host_attestations(host_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS sandbox_host_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error_code TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sandbox_host_audit_created
    ON sandbox_host_audit_events(host_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS sandbox_entitlements (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_entitlement_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_username TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sandbox_entitlement_audit_user_created
    ON sandbox_entitlement_audit_events(user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS sandboxes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    host_id TEXT NOT NULL REFERENCES sandbox_hosts(id) ON DELETE RESTRICT,
    host_epoch INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    size_id TEXT NOT NULL,
    cpu_millis INTEGER NOT NULL,
    memory_mib INTEGER NOT NULL,
    disk_gib INTEGER NOT NULL,
    desired_state TEXT NOT NULL,
    observed_state TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    instance_id TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    reservation_held INTEGER NOT NULL DEFAULT 1,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sandboxes_active_user
    ON sandboxes(user_id) WHERE reservation_held = 1;
  CREATE INDEX IF NOT EXISTS idx_sandboxes_host_reservation
    ON sandboxes(host_id, reservation_held);

  CREATE TABLE IF NOT EXISTS sandbox_operations (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    generation INTEGER NOT NULL,
    host_epoch INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, idempotency_key)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_operations_active
    ON sandbox_operations(sandbox_id)
    WHERE status IN ('pending', 'running');

  CREATE TABLE IF NOT EXISTS sandbox_credentials (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    instance_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    image_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    expires_at INTEGER,
    consumed_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id TEXT,
    event_type TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    generation INTEGER NOT NULL,
    host_epoch INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    error_code TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sandbox_audit_sandbox_created
    ON sandbox_audit_events(sandbox_id, created_at, id);
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
  `ALTER TABLE sessions ADD COLUMN metadata_updated_at INTEGER`,
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
  `ALTER TABLE sessions ADD COLUMN provider TEXT`,
  `ALTER TABLE user_stats ADD COLUMN input_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE user_stats ADD COLUMN output_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE user_stats ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE user_stats ADD COLUMN cache_write_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE user_stats ADD COLUMN total_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE user_stats ADD COLUMN last_turn_completed_at INTEGER`,
  `ALTER TABLE daily_stats ADD COLUMN input_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE daily_stats ADD COLUMN output_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE daily_stats ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE daily_stats ADD COLUMN cache_write_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE daily_stats ADD COLUMN total_tokens INTEGER DEFAULT 0`,
  `ALTER TABLE sandbox_hosts ADD COLUMN memory_mib_available INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER`,
  `ALTER TABLE users ADD COLUMN deletion_id TEXT`
];

// Yeaft sessions table — server-side persistence so the unified sidebar
// can list yeaft sessions across all the user's agents (online or not)
// and survive reload, mirroring how chat conversations work via the
// `sessions` table. Schema is deliberately separate because the
// lifecycle and metadata diverge (roster, defaultVpId, per-session
// config overrides — none of which are chat concerns).
const yeaftSessionsTable = `
  CREATE TABLE IF NOT EXISTS yeaft_sessions (
    id TEXT NOT NULL,
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
    metadata_updated_at INTEGER,
    is_archived INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    sort_order INTEGER,
    PRIMARY KEY (user_id, agent_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_user ON yeaft_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_agent ON yeaft_sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_id ON yeaft_sessions(id);
  CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_updated ON yeaft_sessions(updated_at DESC);
`;
db.exec(yeaftSessionsTable);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_ui_metadata (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    catalog_key TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    sort_rank INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, catalog_key)
  );
  CREATE INDEX IF NOT EXISTS idx_session_ui_metadata_user_sort
    ON session_ui_metadata(user_id, pinned DESC, sort_rank ASC);

  -- Projects are user-owned organization metadata. Membership keeps the full
  -- Agent + Session identity because Session ids are only unique per Agent.
  CREATE TABLE IF NOT EXISTS yeaft_projects (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE IF NOT EXISTS yeaft_project_sessions (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_id, session_id),
    FOREIGN KEY (user_id, project_id) REFERENCES yeaft_projects(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_yeaft_projects_user_sort
    ON yeaft_projects(user_id, sort_order ASC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_yeaft_project_sessions_project
    ON yeaft_project_sessions(user_id, project_id, agent_id);
  CREATE TABLE IF NOT EXISTS yeaft_project_imports (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, agent_id)
  );
`);

try {
  const tableInfo = db.prepare(`PRAGMA table_info(yeaft_sessions)`).all();
  const idColumn = tableInfo.find(col => col && col.name === 'id');
  if (idColumn && Number(idColumn.pk) === 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS yeaft_sessions_composite (
        id TEXT NOT NULL,
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
        sort_order INTEGER,
        PRIMARY KEY (user_id, agent_id, id)
      );
      INSERT OR REPLACE INTO yeaft_sessions_composite
        (id, user_id, agent_id, name, roster_json, default_vp_id, work_dir,
         config_json, announcement, created_at, updated_at, is_archived, is_pinned, sort_order)
      SELECT id, user_id, agent_id, name, roster_json, default_vp_id, work_dir,
        config_json, announcement, created_at, updated_at, is_archived, is_pinned, sort_order
      FROM yeaft_sessions;
      DROP TABLE yeaft_sessions;
      ALTER TABLE yeaft_sessions_composite RENAME TO yeaft_sessions;
      CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_user ON yeaft_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_agent ON yeaft_sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_id ON yeaft_sessions(id);
      CREATE INDEX IF NOT EXISTS idx_yeaft_sessions_updated ON yeaft_sessions(updated_at DESC);
    `);
  }
} catch (e) {
  console.warn('[DB] yeaft_sessions composite-key migration failed:', e?.message || e);
}

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
  `ALTER TABLE yeaft_sessions ADD COLUMN metadata_updated_at INTEGER`,
];
for (const migration of yeaftMigrations) {
  try { db.exec(migration); } catch (_) { /* column exists */ }
}

const yeaftProjectMigrations = [
  `ALTER TABLE yeaft_projects ADD COLUMN instruction TEXT NOT NULL DEFAULT ''`,
];

const sessionUiMetadataMigrations = [
  `ALTER TABLE session_ui_metadata ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0`,
];
for (const migration of yeaftProjectMigrations) {
  try { db.exec(migration); } catch (_) { /* column exists */ }
}

for (const migration of sessionUiMetadataMigrations) {
  try { db.exec(migration); } catch (_) { /* column exists */ }
}

for (const migration of migrations) {
  try {
    db.exec(migration);
  } catch (e) {
    // 列已存在，忽略错误
  }
}

// One-time fail-closed migration from the PR's opaque TEXT Host epochs. SQLite
// does not change existing column affinity for CREATE TABLE IF NOT EXISTS, so
// normalize every live fence explicitly and seed the Server-owned allocator.
const unmigratedSandboxHosts = db.prepare(`
  SELECT h.id, h.epoch FROM sandbox_hosts h
  LEFT JOIN sandbox_host_epochs e ON e.host_id = h.id
  WHERE e.host_id IS NULL
`).all();
for (const host of unmigratedSandboxHosts) {
  const values = [host.epoch];
  for (const row of db.prepare('SELECT host_epoch AS epoch FROM sandboxes WHERE host_id = ?').all(host.id)) {
    values.push(row.epoch);
  }
  for (const row of db.prepare(`
    SELECT o.host_epoch AS epoch FROM sandbox_operations o
    JOIN sandboxes s ON s.id = o.sandbox_id WHERE s.host_id = ?
  `).all(host.id)) values.push(row.epoch);
  const observed = values.map(value => {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric >= 1) return numeric;
    const match = String(value || '').match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }).filter(value => Number.isSafeInteger(value) && value >= 1);
  const epoch = Math.max(0, ...observed) + 1;
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE sandbox_hosts SET epoch = ? WHERE id = ?').run(epoch, host.id);
    db.prepare('UPDATE sandboxes SET host_epoch = ? WHERE host_id = ?').run(epoch, host.id);
    db.prepare(`
      UPDATE sandbox_operations SET host_epoch = ?
      WHERE sandbox_id IN (SELECT id FROM sandboxes WHERE host_id = ?)
    `).run(epoch, host.id);
    db.prepare(`
      UPDATE sandbox_audit_events SET host_epoch = ?
      WHERE sandbox_id IN (SELECT id FROM sandboxes WHERE host_id = ?)
    `).run(epoch, host.id);
    db.prepare('UPDATE sandbox_host_attestations SET epoch = ? WHERE host_id = ?').run(epoch, host.id);
    db.prepare('UPDATE sandbox_host_audit_events SET epoch = ? WHERE host_id = ?').run(epoch, host.id);
    db.prepare(`
      INSERT INTO sandbox_host_epochs
        (host_id, source_epoch, epoch, activation_digest, activated_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?)
    `).run(host.id, `migrated:${String(host.epoch)}`, epoch, now);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

// SQLite keeps the affinity from the original CREATE TABLE. Rebuild legacy
// sandbox tables so epoch values are stored and compared as integers, rather
// than merely writing numeric-looking values into TEXT-affinity columns.
const sandboxEpochTableRebuilds = [
  {
    table: 'sandbox_hosts', column: 'epoch',
    create: `CREATE TABLE sandbox_hosts (
      id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, qualified INTEGER NOT NULL DEFAULT 0,
      controller_healthy INTEGER NOT NULL DEFAULT 0, helper_healthy INTEGER NOT NULL DEFAULT 0,
      runtime_healthy INTEGER NOT NULL DEFAULT 0, quota_healthy INTEGER NOT NULL DEFAULT 0,
      network_healthy INTEGER NOT NULL DEFAULT 0, image_digest TEXT NOT NULL,
      cpu_millis_total INTEGER NOT NULL, memory_mib_total INTEGER NOT NULL,
      memory_mib_available INTEGER NOT NULL, disk_gib_total INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
    columns: 'id, epoch, qualified, controller_healthy, helper_healthy, runtime_healthy, quota_healthy, network_healthy, image_digest, cpu_millis_total, memory_mib_total, memory_mib_available, disk_gib_total, updated_at',
    select: 'id, CAST(epoch AS INTEGER), qualified, controller_healthy, helper_healthy, runtime_healthy, quota_healthy, network_healthy, image_digest, cpu_millis_total, memory_mib_total, memory_mib_available, disk_gib_total, updated_at',
    indexes: ['CREATE INDEX IF NOT EXISTS idx_sandboxes_host_reservation ON sandboxes(host_id, reservation_held)']
  },
  {
    table: 'sandbox_host_attestations', column: 'epoch',
    create: `CREATE TABLE sandbox_host_attestations (
      nonce TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES sandbox_hosts(id) ON DELETE CASCADE,
      epoch INTEGER NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`,
    columns: 'nonce, host_id, epoch, observed_at, created_at',
    select: 'nonce, host_id, CAST(epoch AS INTEGER), observed_at, created_at',
    indexes: ['CREATE INDEX IF NOT EXISTS idx_sandbox_host_attestations_host ON sandbox_host_attestations(host_id, created_at DESC)']
  },
  {
    table: 'sandbox_host_audit_events', column: 'epoch',
    create: `CREATE TABLE sandbox_host_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      event_type TEXT NOT NULL, outcome TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL
    )`,
    columns: 'id, host_id, epoch, event_type, outcome, error_code, created_at',
    select: 'id, host_id, CAST(epoch AS INTEGER), event_type, outcome, error_code, created_at',
    indexes: ['CREATE INDEX IF NOT EXISTS idx_sandbox_host_audit_created ON sandbox_host_audit_events(host_id, created_at DESC, id DESC)']
  },
  {
    table: 'sandboxes', column: 'host_epoch',
    create: `CREATE TABLE sandboxes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      host_id TEXT NOT NULL REFERENCES sandbox_hosts(id) ON DELETE RESTRICT, host_epoch INTEGER NOT NULL,
      agent_name TEXT NOT NULL, size_id TEXT NOT NULL, cpu_millis INTEGER NOT NULL,
      memory_mib INTEGER NOT NULL, disk_gib INTEGER NOT NULL, desired_state TEXT NOT NULL,
      observed_state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, instance_id TEXT NOT NULL,
      image_digest TEXT NOT NULL, reservation_held INTEGER NOT NULL DEFAULT 1, last_error_code TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER
    )`,
    columns: 'id, user_id, host_id, host_epoch, agent_name, size_id, cpu_millis, memory_mib, disk_gib, desired_state, observed_state, generation, instance_id, image_digest, reservation_held, last_error_code, created_at, updated_at, removed_at',
    select: 'id, user_id, host_id, CAST(host_epoch AS INTEGER), agent_name, size_id, cpu_millis, memory_mib, disk_gib, desired_state, observed_state, generation, instance_id, image_digest, reservation_held, last_error_code, created_at, updated_at, removed_at',
    indexes: [
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_sandboxes_active_user ON sandboxes(user_id) WHERE reservation_held = 1',
      'CREATE INDEX IF NOT EXISTS idx_sandboxes_host_reservation ON sandboxes(host_id, reservation_held)'
    ]
  },
  {
    table: 'sandbox_operations', column: 'host_epoch',
    create: `CREATE TABLE sandbox_operations (
      id TEXT PRIMARY KEY, sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
      generation INTEGER NOT NULL, host_epoch INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
      error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, idempotency_key)
    )`,
    columns: 'id, sandbox_id, user_id, idempotency_key, request_digest, kind, status, stage, generation, host_epoch, deadline_at, error_code, created_at, updated_at',
    select: 'id, sandbox_id, user_id, idempotency_key, request_digest, kind, status, stage, generation, CAST(host_epoch AS INTEGER), deadline_at, error_code, created_at, updated_at',
    indexes: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_operations_active ON sandbox_operations(sandbox_id) WHERE status IN ('pending', 'running')"]
  },
  {
    table: 'sandbox_audit_events', column: 'host_epoch',
    create: `CREATE TABLE sandbox_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT,
      event_type TEXT NOT NULL, actor_kind TEXT NOT NULL, generation INTEGER NOT NULL,
      host_epoch INTEGER NOT NULL, outcome TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL
    )`,
    columns: 'id, sandbox_id, user_id, operation_id, event_type, actor_kind, generation, host_epoch, outcome, error_code, created_at',
    select: 'id, sandbox_id, user_id, operation_id, event_type, actor_kind, generation, CAST(host_epoch AS INTEGER), outcome, error_code, created_at',
    indexes: ['CREATE INDEX IF NOT EXISTS idx_sandbox_audit_sandbox_created ON sandbox_audit_events(sandbox_id, created_at, id)']
  }
];

for (const rebuild of sandboxEpochTableRebuilds) {
  const affinity = db.prepare(`PRAGMA table_info(${rebuild.table})`).all()
    .find(column => column.name === rebuild.column)?.type?.toUpperCase();
  if (affinity === 'INTEGER') continue;
  const legacyTable = `${rebuild.table}_legacy_epoch`;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE ${rebuild.table} RENAME TO ${legacyTable}`);
    db.exec(rebuild.create);
    db.exec(`INSERT INTO ${rebuild.table} (${rebuild.columns}) SELECT ${rebuild.select} FROM ${legacyTable}`);
    db.exec(`DROP TABLE ${legacyTable}`);
    for (const index of rebuild.indexes) db.exec(index);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('PRAGMA foreign_keys = ON');
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
  `CREATE INDEX IF NOT EXISTS idx_users_aad_oid ON users(aad_oid)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_deletion_id ON users(deletion_id)`
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

  getUserDeletionTombstone: db.prepare(`
    SELECT * FROM user_deletion_tombstones WHERE username = ?
  `),

  insertUserDeletionTombstone: db.prepare(`
    INSERT OR IGNORE INTO user_deletion_tombstones (username, deletion_id, deleted_at)
    VALUES (?, ?, ?)
  `),

  getUserByAgentSecret: db.prepare(`
    SELECT * FROM users WHERE agent_secret = ? AND deletion_state = 'active'
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

  touchSessionMetadata: db.prepare(`
    UPDATE sessions SET metadata_updated_at = ? WHERE id = ?
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

  updateSessionPinnedForRoute: db.prepare(`
    UPDATE sessions SET is_pinned = ?, updated_at = ?
    WHERE id = ? AND agent_id = ? AND (user_id = ? OR user_id IS NULL)
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

  hasSessionOwnedByUserAndAgent: db.prepare(`
    SELECT 1 FROM sessions WHERE user_id = ? AND agent_id = ? LIMIT 1
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

  upsertSessionUiMetadata: db.prepare(`
    INSERT INTO session_ui_metadata (user_id, catalog_key, pinned, is_hidden, sort_rank, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, catalog_key) DO UPDATE SET
      pinned = excluded.pinned,
      is_hidden = excluded.is_hidden,
      sort_rank = excluded.sort_rank,
      updated_at = excluded.updated_at
  `),

  getSessionUiMetadata: db.prepare(`
    SELECT * FROM session_ui_metadata WHERE user_id = ? AND catalog_key = ?
  `),

  getSessionUiMetadataByUser: db.prepare(`
    SELECT * FROM session_ui_metadata WHERE user_id = ?
    ORDER BY pinned DESC, sort_rank ASC, updated_at DESC
  `),

  deleteSessionUiMetadata: db.prepare(`
    DELETE FROM session_ui_metadata WHERE user_id = ? AND catalog_key = ?
  `),

  // Project organization metadata. Projects are server-owned and may contain
  // Sessions from multiple Agents; sharing still filters by agent_id.
  insertYeaftProject: db.prepare(`
    INSERT INTO yeaft_projects (id, user_id, name, instruction, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getYeaftProjectsByUser: db.prepare(`
    SELECT * FROM yeaft_projects WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC
  `),
  getYeaftProjectForUser: db.prepare(`
    SELECT * FROM yeaft_projects WHERE user_id = ? AND id = ?
  `),
  updateYeaftProjectName: db.prepare(`
    UPDATE yeaft_projects SET name = ?, updated_at = ? WHERE user_id = ? AND id = ?
  `),
  updateYeaftProjectInstruction: db.prepare(`
    UPDATE yeaft_projects SET instruction = ?, updated_at = ? WHERE user_id = ? AND id = ?
  `),
  updateYeaftProjectSortOrder: db.prepare(`
    UPDATE yeaft_projects SET sort_order = ?, updated_at = ? WHERE user_id = ? AND id = ?
  `),
  deleteYeaftProject: db.prepare(`
    DELETE FROM yeaft_projects WHERE user_id = ? AND id = ?
  `),
  getYeaftProjectMembersByUser: db.prepare(`
    SELECT * FROM yeaft_project_sessions
    WHERE user_id = ?
    ORDER BY created_at ASC, agent_id ASC, session_id ASC
  `),
  getYeaftProjectForSession: db.prepare(`
    SELECT p.* FROM yeaft_projects p
    JOIN yeaft_project_sessions m
      ON m.user_id = p.user_id AND m.project_id = p.id
    WHERE m.user_id = ? AND m.agent_id = ? AND m.session_id = ?
  `),
  getYeaftProjectMembersForAgent: db.prepare(`
    SELECT agent_id, session_id FROM yeaft_project_sessions
    WHERE user_id = ? AND project_id = ? AND agent_id = ?
    ORDER BY created_at ASC, session_id ASC
  `),
  deleteYeaftProjectSessionMembership: db.prepare(`
    DELETE FROM yeaft_project_sessions
    WHERE user_id = ? AND agent_id = ? AND session_id = ?
  `),
  insertYeaftProjectSessionMembership: db.prepare(`
    INSERT INTO yeaft_project_sessions
      (user_id, project_id, agent_id, session_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  deleteYeaftProjectMembershipsForSession: db.prepare(`
    DELETE FROM yeaft_project_sessions
    WHERE user_id = ? AND agent_id = ? AND session_id = ?
  `),
  getYeaftProjectImport: db.prepare(`
    SELECT imported_at FROM yeaft_project_imports WHERE user_id = ? AND agent_id = ?
  `),
  insertYeaftProjectImport: db.prepare(`
    INSERT OR IGNORE INTO yeaft_project_imports (user_id, agent_id, imported_at)
    VALUES (?, ?, ?)
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
    INSERT INTO user_stats (
      user_id, message_count, session_count, request_count, bytes_sent, bytes_received,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      message_count = message_count + excluded.message_count,
      session_count = session_count + excluded.session_count,
      request_count = request_count + excluded.request_count,
      bytes_sent = bytes_sent + excluded.bytes_sent,
      bytes_received = bytes_received + excluded.bytes_received,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = total_tokens + excluded.total_tokens,
      updated_at = excluded.updated_at
  `),

  // DailyStats 操作
  upsertDailyStats: db.prepare(`
    INSERT INTO daily_stats (
      user_id, date, message_count, session_count, request_count, bytes_sent, bytes_received,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      message_count = message_count + excluded.message_count,
      session_count = session_count + excluded.session_count,
      request_count = request_count + excluded.request_count,
      bytes_sent = bytes_sent + excluded.bytes_sent,
      bytes_received = bytes_received + excluded.bytes_received,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = total_tokens + excluded.total_tokens
  `),

  getDailyStatsAll: db.prepare(`
    SELECT ds.user_id, u.username, u.display_name, u.role,
      MAX(us.last_turn_completed_at) as last_turn_completed_at,
      SUM(ds.message_count) as message_count, SUM(ds.session_count) as session_count,
      SUM(ds.request_count) as request_count, SUM(ds.bytes_sent) as bytes_sent,
      SUM(ds.bytes_received) as bytes_received,
      SUM(ds.input_tokens) as input_tokens, SUM(ds.output_tokens) as output_tokens,
      SUM(ds.cache_read_tokens) as cache_read_tokens,
      SUM(ds.cache_write_tokens) as cache_write_tokens,
      SUM(ds.total_tokens) as total_tokens
    FROM daily_stats ds
    JOIN users u ON ds.user_id = u.id
    LEFT JOIN user_stats us ON us.user_id = ds.user_id
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
    SELECT us.*, u.username, u.display_name, u.role
    FROM user_stats us
    JOIN users u ON us.user_id = u.id
    ORDER BY us.message_count DESC
  `),

  getUserStatsById: db.prepare(`
    SELECT * FROM user_stats WHERE user_id = ?
  `),

  updateLastTurnCompletedAt: db.prepare(`
    INSERT INTO user_stats (user_id, last_turn_completed_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_turn_completed_at = MAX(COALESCE(last_turn_completed_at, 0), excluded.last_turn_completed_at),
      updated_at = MAX(updated_at, excluded.updated_at)
  `),

  getAgentMetricWatermark: db.prepare(`
    SELECT * FROM agent_metric_watermarks
    WHERE user_id = ? AND agent_instance_id = ? AND metric_epoch = ?
  `),

  upsertAgentMetricWatermark: db.prepare(`
    INSERT INTO agent_metric_watermarks (
      user_id, agent_instance_id, metric_epoch, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, agent_instance_id, metric_epoch) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      total_tokens = excluded.total_tokens,
      updated_at = excluded.updated_at
  `),

  // Durable Admin Agent inventory. `online` is derived from context.agents.
  upsertAgentInventory: db.prepare(`
    INSERT INTO agent_inventory (
      id, instance_id, owner_id, name, work_dir, version, platform,
      capabilities_json, capability_metadata_provided, metrics_json,
      metrics_updated_at, last_seen_at, last_connected_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '{}'), ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      instance_id = excluded.instance_id,
      owner_id = excluded.owner_id,
      name = excluded.name,
      work_dir = excluded.work_dir,
      version = excluded.version,
      platform = excluded.platform,
      capabilities_json = excluded.capabilities_json,
      capability_metadata_provided = excluded.capability_metadata_provided,
      metrics_json = CASE WHEN excluded.metrics_updated_at IS NULL THEN agent_inventory.metrics_json ELSE excluded.metrics_json END,
      metrics_updated_at = COALESCE(excluded.metrics_updated_at, agent_inventory.metrics_updated_at),
      last_seen_at = excluded.last_seen_at,
      last_connected_at = excluded.last_connected_at,
      updated_at = excluded.updated_at
  `),

  touchAgentInventory: db.prepare(`
    UPDATE agent_inventory SET last_seen_at = ?, updated_at = ? WHERE id = ?
  `),

  updateAgentInventoryMetrics: db.prepare(`
    UPDATE agent_inventory
    SET metrics_json = ?, metrics_updated_at = ?, updated_at = ?
    WHERE id = ?
  `),

  getAllAgentInventory: db.prepare(`
    SELECT * FROM agent_inventory ORDER BY last_seen_at DESC, name ASC, id ASC
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
  // Remove rows from the retired managed-Sandbox control plane before the user.
  // Child operations, credentials, and audit rows cascade from sandboxes.
  deleteLegacySandboxesForUser: db.prepare(`
    DELETE FROM sandboxes WHERE user_id = ?
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
    ON CONFLICT(user_id, agent_id, id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, user_id),
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

  touchYeaftSessionMetadata: db.prepare(`
    UPDATE yeaft_sessions SET metadata_updated_at = ?
    WHERE id = ? AND user_id IS ? AND agent_id = ?
  `),

  getYeaftSession: db.prepare(`
    SELECT * FROM yeaft_sessions WHERE id = ? ORDER BY updated_at DESC LIMIT 1
  `),

  getYeaftSessionsById: db.prepare(`
    SELECT * FROM yeaft_sessions WHERE id = ? ORDER BY updated_at DESC
  `),

  getYeaftSessionForAgent: db.prepare(`
    SELECT * FROM yeaft_sessions WHERE id = ? AND user_id = ? AND agent_id = ?
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

  deleteYeaftSessionForAgent: db.prepare(`
    DELETE FROM yeaft_sessions WHERE id = ? AND user_id = ? AND agent_id = ?
  `),

  deleteYeaftSessionsByUser: db.prepare(`
    DELETE FROM yeaft_sessions WHERE user_id = ?
  `),

  setYeaftSessionArchived: db.prepare(`
    UPDATE yeaft_sessions SET is_archived = ?, updated_at = ? WHERE id = ?
  `),

  setYeaftSessionArchivedForAgent: db.prepare(`
    UPDATE yeaft_sessions SET is_archived = ?, updated_at = ? WHERE id = ? AND user_id = ? AND agent_id = ?
  `),

  setYeaftSessionPinned: db.prepare(`
    UPDATE yeaft_sessions SET is_pinned = ?, updated_at = ? WHERE id = ?
  `),

  setYeaftSessionPinnedForAgent: db.prepare(`
    UPDATE yeaft_sessions SET is_pinned = ?, updated_at = ? WHERE id = ? AND user_id = ? AND agent_id = ?
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
  `),

  getDashboardTokenTotals: db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM user_stats
  `)
};

// 关闭数据库连接（用于优雅退出）
let dbClosed = false;
export function closeDb() {
  if (dbClosed) return;
  db.close();
  dbClosed = true;
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
