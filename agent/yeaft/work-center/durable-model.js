import { createHash, randomUUID } from 'node:crypto';

export const WORK_CENTER_SCHEMA_VERSION = 40;

const MIGRATIONS = [
  ['23-conversation-stream', migrateConversationStream],
  ['24-action-stream', migrateActionStream],
  ['25-engine-turns', migrateEngineTurns],
  ['26-operation-identity', migrateOperations],
  ['27-coordinator-mailbox', migrateCoordinatorMailbox],
  ['28-run-identity', migrateRunIdentity],
  ['29-runtime-indexes', migrateRuntimeIndexes],
  ['30-backfill-projections', backfillLegacyProjections],
  ['31-reliability-guards', migrateReliabilityGuards],
  ['32-engine-turn-status-contract', migrateEngineTurnStatusContract],
  ['33-coordinator-provider-turns', migrateCoordinatorProviderTurns],
  ['34-engine-turn-status-repair', repairEngineTurnStatusContract],
  ['35-coordinator-provider-claims', migrateCoordinatorProviderClaims],
  ['36-dynamic-coordination', migrateDynamicCoordination],
  ['37-run-acceptance-checks', migrateRunAcceptanceChecks],
  ['38-action-closure-and-outputs', migrateActionClosureAndOutputs],
  ['39-action-creation-source', migrateActionCreationSource],
];

const MIGRATION_ALIASES = new Map([
  ['23-conversation-stream-v1', '23-conversation-stream'],
  ['24-action-stream-v1', '24-action-stream'],
  ['25-engine-turns-v1', '25-engine-turns'],
  ['26-operation-identity-v1', '26-operation-identity'],
  ['27-coordinator-mailbox-v1', '27-coordinator-mailbox'],
  ['28-run-identity-v1', '28-run-identity'],
]);

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function migrationChecksum(name) {
  return hash(`work-center-migration:${name}:v1`);
}

function runMigration(db, now, name, migration) {
  const checksum = migrationChecksum(name);
  const aliases = [...MIGRATION_ALIASES.entries()]
    .filter(([, canonical]) => canonical === name)
    .map(([alias]) => alias);
  const prior = db.prepare(`SELECT name, checksum, applied_at FROM schema_migrations
    WHERE name = ? OR name IN (${aliases.map(() => '?').join(',') || "''"})
    ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END LIMIT 1`).get(name, ...aliases, name);
  if (prior?.name === name) {
    if (prior.checksum !== checksum) throw new Error(`Work Center migration checksum changed: ${name}`);
    return;
  }
  if (prior) {
    if (prior.checksum !== migrationChecksum(prior.name)) {
      throw new Error(`Work Center migration alias checksum changed: ${prior.name}`);
    }
    db.prepare(`INSERT INTO schema_migrations(name, checksum, applied_at)
      VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING`).run(name, checksum, prior.applied_at || now);
    return;
  }
  const apply = () => {
    migration(db, now);
    db.prepare(`INSERT INTO schema_migrations(name, checksum, applied_at)
      VALUES (?, ?, ?)`).run(name, checksum, now);
  };
  if (db.isTransaction) return apply();
  db.exec('BEGIN IMMEDIATE');
  try {
    apply();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function migrateDurableWorkCenterModel(db, now = Date.now(), sourceSchemaVersion = 22) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  db.exec('DROP TABLE IF EXISTS migration_context');
  db.exec('CREATE TEMP TABLE migration_context(source_schema_version INTEGER NOT NULL)');
  db.prepare('INSERT INTO migration_context(source_schema_version) VALUES (?)').run(sourceSchemaVersion);
  for (const [name, migration] of MIGRATIONS) runMigration(db, now, name, migration);
}

function migrateConversationStream(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_entries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('message', 'control')),
      role TEXT,
      status TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      turn_id TEXT,
      source_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_entries_work_item
      ON conversation_entries(work_item_id, sequence);
  `);
}

function migrateActionStream(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_entries (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('message', 'control')),
      role TEXT,
      status TEXT NOT NULL CHECK(status IN
        ('pending', 'scheduled', 'bound', 'consumed', 'blocked', 'rejected', 'cancelled')),
      text TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      source_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL DEFAULT '{}',
      engine_turn_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      consumed_at INTEGER,
      UNIQUE(action_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_action_entries_delivery
      ON action_entries(action_id, run_id, status, sequence);
  `);
}

function migrateEngineTurns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_turns (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN
        ('prepared', 'dispatching', 'responded', 'unknown', 'cancelled', 'legacy_imported')),
      owner_boot_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL,
      input_entry_ids TEXT NOT NULL DEFAULT '[]',
      message_entry_ids TEXT NOT NULL DEFAULT '[]',
      control_entry_ids TEXT NOT NULL DEFAULT '[]',
      claimed_through_sequence INTEGER NOT NULL DEFAULT 0,
      consumed_through_sequence INTEGER NOT NULL DEFAULT 0,
      request_body TEXT NOT NULL DEFAULT '{}',
      request_hash TEXT NOT NULL DEFAULT '',
      request_key TEXT NOT NULL UNIQUE,
      dispatch_attempt INTEGER NOT NULL DEFAULT 0,
      dispatch_capability TEXT NOT NULL DEFAULT 'unknown',
      response TEXT,
      response_hash TEXT,
      provider_request_id TEXT,
      claimed_at INTEGER,
      dispatched_at INTEGER,
      responded_at INTEGER,
      consumed_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(run_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_engine_turns_recovery
      ON engine_turns(status, updated_at);
  `);
}

function migrateOperations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      action_id TEXT REFERENCES actions(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      engine_turn_id TEXT REFERENCES engine_turns(id) ON DELETE CASCADE,
      operation_type TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT NOT NULL UNIQUE,
      replay_policy TEXT NOT NULL CHECK(replay_policy IN ('safe', 'probe_first', 'never_automatic')),
      concurrency_policy TEXT NOT NULL DEFAULT 'blocking'
        CHECK(concurrency_policy IN ('blocking', 'detached_read_only')),
      effect_status TEXT NOT NULL CHECK(effect_status IN
        ('pending', 'applied', 'not_applied', 'failed_no_effect', 'unknown')),
      effect_observation TEXT,
      effect_reconciliation TEXT NOT NULL DEFAULT '{"status":"pending"}',
      execution_status TEXT NOT NULL CHECK(execution_status IN
        ('not_started', 'running', 'cancel_requested', 'quiescent', 'fenced', 'hazardous_orphan')),
      execution_epoch INTEGER NOT NULL DEFAULT 0,
      effect_cutoff TEXT,
      grant_manifest TEXT NOT NULL DEFAULT '{"status":"closed","safetyStatus":"current","inventoryComplete":true,"pendingGrantAttemptIds":[],"requiredAuthorityIds":[],"authorityClosures":[]}',
      resource_release TEXT NOT NULL DEFAULT '{"status":"released","requiredLeaseIds":[],"leases":[]}',
      supplemental_inventory TEXT NOT NULL DEFAULT '{"status":"clear","generation":0,"discoveries":[]}',
      authority_fence TEXT,
      owner_boot_id TEXT,
      owner_lease_epoch INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      claimed_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operations_recovery
      ON operations(execution_status, replay_policy, effect_status, updated_at);
  `);
}

function migrateCoordinatorMailbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordinator_mailbox_entries (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'acked', 'cancelled')),
      source_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL DEFAULT '{}',
      claim_owner TEXT,
      claim_epoch INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      lease_expires_at INTEGER,
      acked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(work_item_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_coordinator_mailbox_claim
      ON coordinator_mailbox_entries(status, lease_expires_at, sequence);
  `);
}

function migrateRunIdentity(db) {
  if (!hasColumn(db, 'runs', 'ordinal')) db.exec('ALTER TABLE runs ADD COLUMN ordinal INTEGER');
  if (!hasColumn(db, 'runs', 'terminal_status')) db.exec('ALTER TABLE runs ADD COLUMN terminal_status TEXT');
  if (!hasColumn(db, 'runs', 'terminal_at')) db.exec('ALTER TABLE runs ADD COLUMN terminal_at INTEGER');
  const update = db.prepare(`UPDATE runs SET ordinal = ?,
    terminal_status = CASE WHEN status != 'running' THEN status ELSE terminal_status END,
    terminal_at = CASE WHEN status != 'running' THEN COALESCE(ended_at, started_at) ELSE terminal_at END
    WHERE id = ?`);
  const ordinals = new Map();
  for (const row of db.prepare('SELECT id, action_id FROM runs ORDER BY action_id, started_at, id').all()) {
    const ordinal = (ordinals.get(row.action_id) || 0) + 1;
    ordinals.set(row.action_id, ordinal);
    update.run(ordinal, row.id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_action_ordinal ON runs(action_id, ordinal)');
}

function migrateRuntimeIndexes(db) {
  for (const [column, definition] of [
    ['message_entry_ids', "TEXT NOT NULL DEFAULT '[]'"],
    ['control_entry_ids', "TEXT NOT NULL DEFAULT '[]'"],
    ['claimed_through_sequence', 'INTEGER NOT NULL DEFAULT 0'],
    ['consumed_through_sequence', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!hasColumn(db, 'engine_turns', column)) {
      db.exec(`ALTER TABLE engine_turns ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_action_entries_engine_turn ON action_entries(engine_turn_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_mailbox_work_item_status
      ON coordinator_mailbox_entries(work_item_id, status, sequence);
  `);
}

const ENGINE_TURN_STATUS_CHECK = /status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'prepared'\s*,\s*'dispatching'\s*,\s*'responded'\s*,\s*'unknown'\s*,\s*'cancelled'\s*,\s*'legacy_imported'\s*\)\s*\)/i;

function hasEngineTurnStatusContract(db) {
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'engine_turns'`).get()?.sql || '';
  return ENGINE_TURN_STATUS_CHECK.test(sql);
}

function rebuildEngineTurnStatusContract(db, now) {
  db.exec('PRAGMA defer_foreign_keys = ON');
  db.exec(`
    CREATE TABLE engine_turns_new (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN
        ('prepared', 'dispatching', 'responded', 'unknown', 'cancelled', 'legacy_imported')),
      owner_boot_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL,
      input_entry_ids TEXT NOT NULL DEFAULT '[]',
      message_entry_ids TEXT NOT NULL DEFAULT '[]',
      control_entry_ids TEXT NOT NULL DEFAULT '[]',
      claimed_through_sequence INTEGER NOT NULL DEFAULT 0,
      consumed_through_sequence INTEGER NOT NULL DEFAULT 0,
      request_body TEXT NOT NULL DEFAULT '{}',
      request_hash TEXT NOT NULL DEFAULT '',
      request_key TEXT NOT NULL UNIQUE,
      dispatch_attempt INTEGER NOT NULL DEFAULT 0,
      dispatch_capability TEXT NOT NULL DEFAULT 'unknown',
      response TEXT,
      response_hash TEXT,
      provider_request_id TEXT,
      claimed_at INTEGER,
      dispatched_at INTEGER,
      responded_at INTEGER,
      consumed_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(run_id, ordinal)
    );
    INSERT INTO engine_turns_new
      (id, work_item_id, action_id, run_id, ordinal, status, owner_boot_id, lease_epoch,
       input_entry_ids, message_entry_ids, control_entry_ids, claimed_through_sequence,
       consumed_through_sequence, request_body, request_hash, request_key, dispatch_attempt,
       dispatch_capability, response, response_hash, provider_request_id, claimed_at,
       dispatched_at, responded_at, consumed_at, error, created_at, updated_at)
    SELECT id, work_item_id, action_id, run_id, ordinal,
      CASE status
        WHEN 'prepared' THEN 'prepared'
        WHEN 'consumed' THEN 'responded'
        WHEN 'responded' THEN 'responded'
        WHEN 'legacy_imported' THEN 'legacy_imported'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'unknown'
      END,
      owner_boot_id, lease_epoch, input_entry_ids,
      COALESCE(message_entry_ids, input_entry_ids, '[]'), COALESCE(control_entry_ids, '[]'),
      COALESCE(claimed_through_sequence, 0), COALESCE(consumed_through_sequence, 0),
      COALESCE(request_body, '{}'), COALESCE(request_hash, ''), request_key,
      COALESCE(dispatch_attempt, 0), COALESCE(dispatch_capability, 'unknown'), response,
      response_hash, provider_request_id, claimed_at, dispatched_at, responded_at, consumed_at,
      CASE WHEN status IN ('claimed', 'dispatching', 'blocked')
        THEN COALESCE(error, 'Legacy provider dispatch outcome is unknown after schema upgrade')
        ELSE error END,
      created_at, COALESCE(updated_at, ${Number(now) || 0})
    FROM engine_turns;
    CREATE TEMP TABLE engine_turn_action_entry_refs AS
      SELECT id, engine_turn_id FROM action_entries WHERE engine_turn_id IS NOT NULL;
    CREATE TEMP TABLE engine_turn_operation_refs AS
      SELECT id, engine_turn_id FROM operations WHERE engine_turn_id IS NOT NULL;
    UPDATE action_entries SET engine_turn_id = NULL WHERE engine_turn_id IS NOT NULL;
    UPDATE operations SET engine_turn_id = NULL WHERE engine_turn_id IS NOT NULL;
    DROP TABLE engine_turns;
    ALTER TABLE engine_turns_new RENAME TO engine_turns;
    UPDATE action_entries SET engine_turn_id = (
      SELECT ref.engine_turn_id FROM engine_turn_action_entry_refs ref WHERE ref.id = action_entries.id
    ) WHERE id IN (SELECT id FROM engine_turn_action_entry_refs);
    UPDATE operations SET engine_turn_id = (
      SELECT ref.engine_turn_id FROM engine_turn_operation_refs ref WHERE ref.id = operations.id
    ) WHERE id IN (SELECT id FROM engine_turn_operation_refs);
    DROP TABLE engine_turn_action_entry_refs;
    DROP TABLE engine_turn_operation_refs;
    CREATE INDEX idx_engine_turns_recovery ON engine_turns(status, updated_at);
    CREATE TRIGGER trg_engine_turn_request_immutable
    BEFORE UPDATE ON engine_turns
    WHEN NEW.run_id IS NOT OLD.run_id OR NEW.ordinal IS NOT OLD.ordinal OR
      NEW.request_body IS NOT OLD.request_body OR NEW.request_hash IS NOT OLD.request_hash OR
      NEW.input_entry_ids IS NOT OLD.input_entry_ids OR
      NEW.message_entry_ids IS NOT OLD.message_entry_ids OR NEW.control_entry_ids IS NOT OLD.control_entry_ids
    BEGIN
      SELECT RAISE(ABORT, 'prepared EngineTurn request is immutable');
    END;
  `);
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) throw new Error('EngineTurn status migration violated foreign keys');
}

function migrateEngineTurnStatusContract(db, now) {
  if (hasEngineTurnStatusContract(db)) return;
  rebuildEngineTurnStatusContract(db, now);
}

function repairEngineTurnStatusContract(db, now) {
  if (!hasEngineTurnStatusContract(db)) rebuildEngineTurnStatusContract(db, now);
  if (!hasEngineTurnStatusContract(db)) {
    throw new Error('EngineTurn status repair did not install the required status contract');
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(engine_turns)').all();
  const referencedTables = foreignKeys.map(row => row.table).sort();
  if (foreignKeys.length !== 3
      || JSON.stringify(referencedTables) !== JSON.stringify(['actions', 'runs', 'work_items'])) {
    throw new Error('EngineTurn status repair did not preserve required foreign keys');
  }
  const indexes = db.prepare('PRAGMA index_list(engine_turns)').all();
  const hasIndex = columns => indexes.some(index => {
    const actual = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all()
      .map(row => row.name);
    return actual.length === columns.length && actual.every((value, offset) => value === columns[offset]);
  });
  if (!hasIndex(['status', 'updated_at'])
      || !hasIndex(['request_key'])
      || !hasIndex(['run_id', 'ordinal'])) {
    throw new Error('EngineTurn status repair did not preserve required indexes');
  }
  const immutableTrigger = db.prepare(`SELECT 1 AS present FROM sqlite_master
    WHERE type = 'trigger' AND name = 'trg_engine_turn_request_immutable'`).get();
  if (!immutableTrigger) throw new Error('EngineTurn status repair did not preserve request immutability');
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) throw new Error('EngineTurn status repair violated foreign keys');
}

function migrateCoordinatorProviderTurns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordinator_provider_turns (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      coordinator_turn_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared', 'dispatching', 'responded', 'unknown', 'cancelled')),
      request_body TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response TEXT,
      response_hash TEXT,
      error TEXT,
      prepared_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      responded_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(coordinator_turn_id, attempt_number)
    );
    CREATE INDEX IF NOT EXISTS idx_coordinator_provider_turns_recovery
      ON coordinator_provider_turns(status, updated_at);
    CREATE TRIGGER IF NOT EXISTS trg_coordinator_provider_request_immutable
    BEFORE UPDATE ON coordinator_provider_turns
    WHEN NEW.work_item_id IS NOT OLD.work_item_id OR
      NEW.coordinator_turn_id IS NOT OLD.coordinator_turn_id OR
      NEW.attempt_number IS NOT OLD.attempt_number OR
      NEW.request_body IS NOT OLD.request_body OR NEW.request_hash IS NOT OLD.request_hash
    BEGIN
      SELECT RAISE(ABORT, 'prepared Coordinator provider request is immutable');
    END;
  `);
}

function migrateCoordinatorProviderClaims(db) {
  for (const [column, definition] of [
    ['claim_owner', 'TEXT'],
    ['claim_epoch', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!hasColumn(db, 'coordinator_provider_turns', column)) {
      db.exec(`ALTER TABLE coordinator_provider_turns ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_coordinator_provider_turns_claim
      ON coordinator_provider_turns(coordinator_turn_id, claim_owner, claim_epoch, status);
  `);
}

function migrateDynamicCoordination(db) {
  if (!hasColumn(db, 'work_items', 'coordination_mode')) {
    db.exec("ALTER TABLE work_items ADD COLUMN coordination_mode TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!hasColumn(db, 'work_items', 'final_result')) {
    db.exec('ALTER TABLE work_items ADD COLUMN final_result TEXT');
  }
  if (!hasColumn(db, 'actions', 'source_action_ids')) {
    db.exec("ALTER TABLE actions ADD COLUMN source_action_ids TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_dynamic_status
      ON work_items(coordination_mode, status, updated_at);
    CREATE TRIGGER IF NOT EXISTS trg_work_item_final_result_immutable
    BEFORE UPDATE OF final_result ON work_items
    WHEN OLD.final_result IS NOT NULL AND NEW.final_result IS NOT OLD.final_result
    BEGIN
      SELECT RAISE(ABORT, 'WorkItem final result is immutable');
    END;
  `);
}

function migrateRunAcceptanceChecks(db) {
  if (!hasColumn(db, 'runs', 'acceptance_checks')) {
    db.exec("ALTER TABLE runs ADD COLUMN acceptance_checks TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(`
    DROP TRIGGER IF EXISTS trg_runs_terminal_identity_immutable;
    CREATE TRIGGER IF NOT EXISTS trg_runs_terminal_identity_immutable
    BEFORE UPDATE ON runs
    WHEN OLD.terminal_status IS NOT NULL AND (
      NEW.action_id IS NOT OLD.action_id OR NEW.work_item_id IS NOT OLD.work_item_id OR
      NEW.owner_boot_id IS NOT OLD.owner_boot_id OR NEW.lease_epoch IS NOT OLD.lease_epoch OR
      NEW.ordinal IS NOT OLD.ordinal OR NEW.started_at IS NOT OLD.started_at OR
      NEW.status IS NOT OLD.status OR NEW.ended_at IS NOT OLD.ended_at OR
      NEW.terminal_status IS NOT OLD.terminal_status OR NEW.terminal_at IS NOT OLD.terminal_at OR
      NEW.response IS NOT OLD.response OR NEW.summary IS NOT OLD.summary OR
      NEW.evidence IS NOT OLD.evidence OR NEW.acceptance_checks IS NOT OLD.acceptance_checks OR
      NEW.waiting_reason IS NOT OLD.waiting_reason OR NEW.error IS NOT OLD.error OR
      NEW.failure_kind IS NOT OLD.failure_kind OR NEW.failure_code IS NOT OLD.failure_code OR
      NEW.review_decision IS NOT OLD.review_decision OR NEW.contract_patch IS NOT OLD.contract_patch OR
      NEW.checkpoint IS NOT OLD.checkpoint)
    BEGIN
      SELECT RAISE(ABORT, 'terminal Run result is immutable');
    END;
  `);
}

function migrateActionClosureAndOutputs(db) {
  if (!hasColumn(db, 'work_items', 'delivery_target')) {
    db.exec('ALTER TABLE work_items ADD COLUMN delivery_target TEXT');
  }
  if (!hasColumn(db, 'actions', 'close_reason')) {
    db.exec('ALTER TABLE actions ADD COLUMN close_reason TEXT');
  }
  if (!hasColumn(db, 'actions', 'closed_at')) {
    db.exec('ALTER TABLE actions ADD COLUMN closed_at INTEGER');
  }
  if (!hasColumn(db, 'runs', 'outputs')) {
    db.exec("ALTER TABLE runs ADD COLUMN outputs TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(`
    DROP TRIGGER IF EXISTS trg_runs_terminal_identity_immutable;
    CREATE TRIGGER IF NOT EXISTS trg_runs_terminal_identity_immutable
    BEFORE UPDATE ON runs
    WHEN OLD.terminal_status IS NOT NULL AND (
      NEW.action_id IS NOT OLD.action_id OR NEW.work_item_id IS NOT OLD.work_item_id OR
      NEW.owner_boot_id IS NOT OLD.owner_boot_id OR NEW.lease_epoch IS NOT OLD.lease_epoch OR
      NEW.ordinal IS NOT OLD.ordinal OR NEW.started_at IS NOT OLD.started_at OR
      NEW.status IS NOT OLD.status OR NEW.ended_at IS NOT OLD.ended_at OR
      NEW.terminal_status IS NOT OLD.terminal_status OR NEW.terminal_at IS NOT OLD.terminal_at OR
      NEW.response IS NOT OLD.response OR NEW.summary IS NOT OLD.summary OR
      NEW.evidence IS NOT OLD.evidence OR NEW.outputs IS NOT OLD.outputs OR
      NEW.acceptance_checks IS NOT OLD.acceptance_checks OR
      NEW.waiting_reason IS NOT OLD.waiting_reason OR NEW.error IS NOT OLD.error OR
      NEW.failure_kind IS NOT OLD.failure_kind OR NEW.failure_code IS NOT OLD.failure_code OR
      NEW.review_decision IS NOT OLD.review_decision OR NEW.contract_patch IS NOT OLD.contract_patch OR
      NEW.checkpoint IS NOT OLD.checkpoint)
    BEGIN
      SELECT RAISE(ABORT, 'terminal Run result is immutable');
    END;
  `);
}

function migrateActionCreationSource(db) {
  if (!hasColumn(db, 'actions', 'creation_source')) {
    db.exec("ALTER TABLE actions ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'legacy'");
  }
}

function migrateReliabilityGuards(db) {
  for (const [column, definition] of [
    ['dispatch_capability', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['dispatched_at', 'INTEGER'],
    ['response_hash', 'TEXT'],
    ['error', 'TEXT'],
  ]) {
    if (!hasColumn(db, 'engine_turns', column)) {
      db.exec(`ALTER TABLE engine_turns ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    DROP TRIGGER IF EXISTS trg_runs_capture_terminal_identity;
    DROP TRIGGER IF EXISTS trg_runs_terminal_identity_immutable;
    CREATE TRIGGER IF NOT EXISTS trg_engine_turn_request_immutable
    BEFORE UPDATE ON engine_turns
    WHEN NEW.run_id IS NOT OLD.run_id OR NEW.ordinal IS NOT OLD.ordinal OR
      NEW.request_body IS NOT OLD.request_body OR NEW.request_hash IS NOT OLD.request_hash OR
      NEW.input_entry_ids IS NOT OLD.input_entry_ids OR
      NEW.message_entry_ids IS NOT OLD.message_entry_ids OR NEW.control_entry_ids IS NOT OLD.control_entry_ids
    BEGIN
      SELECT RAISE(ABORT, 'prepared EngineTurn request is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_identity_immutable
    BEFORE UPDATE ON runs
    WHEN NEW.action_id IS NOT OLD.action_id OR NEW.work_item_id IS NOT OLD.work_item_id OR
      NEW.owner_boot_id IS NOT OLD.owner_boot_id OR NEW.lease_epoch IS NOT OLD.lease_epoch OR
      NEW.ordinal IS NOT OLD.ordinal OR NEW.started_at IS NOT OLD.started_at
    BEGIN
      SELECT RAISE(ABORT, 'Run identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_capture_terminal_identity
    AFTER UPDATE OF status ON runs
    WHEN OLD.terminal_status IS NULL AND OLD.status = 'running' AND NEW.status != 'running'
    BEGIN
      UPDATE runs SET terminal_status = NEW.status,
        terminal_at = COALESCE(NEW.ended_at, NEW.started_at)
        WHERE id = NEW.id AND terminal_status IS NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_runs_terminal_identity_immutable
    BEFORE UPDATE ON runs
    WHEN OLD.terminal_status IS NOT NULL AND (
      NEW.action_id IS NOT OLD.action_id OR NEW.work_item_id IS NOT OLD.work_item_id OR
      NEW.owner_boot_id IS NOT OLD.owner_boot_id OR NEW.lease_epoch IS NOT OLD.lease_epoch OR
      NEW.ordinal IS NOT OLD.ordinal OR NEW.started_at IS NOT OLD.started_at OR
      NEW.status IS NOT OLD.status OR NEW.ended_at IS NOT OLD.ended_at OR
      NEW.terminal_status IS NOT OLD.terminal_status OR NEW.terminal_at IS NOT OLD.terminal_at OR
      NEW.response IS NOT OLD.response OR NEW.summary IS NOT OLD.summary OR
      NEW.evidence IS NOT OLD.evidence OR NEW.waiting_reason IS NOT OLD.waiting_reason OR
      NEW.error IS NOT OLD.error OR NEW.failure_kind IS NOT OLD.failure_kind OR
      NEW.failure_code IS NOT OLD.failure_code OR NEW.review_decision IS NOT OLD.review_decision OR
      NEW.contract_patch IS NOT OLD.contract_patch OR NEW.checkpoint IS NOT OLD.checkpoint)
    BEGIN
      SELECT RAISE(ABORT, 'terminal Run result is immutable');
    END;
  `);
}

function backfillLegacyProjections(db, now) {
  const sourceSchemaVersion = Number(
    db.prepare('SELECT source_schema_version FROM migration_context').get()?.source_schema_version,
  ) || 22;
  const sourcePrefix = String(sourceSchemaVersion);
  const ensureConversation = db.prepare(`INSERT INTO conversations
    (id, work_item_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)
    ON CONFLICT(work_item_id) DO NOTHING`);
  const insertConversationEntry = db.prepare(`INSERT INTO conversation_entries
    (id, conversation_id, work_item_id, sequence, kind, role, status, text, attachments,
     turn_id, source_key, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO NOTHING`);
  for (const row of db.prepare('SELECT id, messages, created_at, updated_at FROM work_items ORDER BY id').all()) {
    const conversationId = `work-item:${row.id}`;
    ensureConversation.run(conversationId, row.id, row.created_at || now, row.updated_at || now);
    const messages = parseJson(row.messages, []);
    if (!Array.isArray(messages)) continue;
    const identityOccurrences = new Map();
    messages.forEach((message, index) => {
      if (!message || typeof message !== 'object') return;
      const identity = String(message.id || message.turnId
        || `${message.role || 'legacy'}:${hash(stableJson(message))}`);
      const occurrence = (identityOccurrences.get(identity) || 0) + 1;
      identityOccurrences.set(identity, occurrence);
      const sourceKey = `${sourcePrefix}:work_items.messages:${row.id}:${identity}:${occurrence}`;
      insertConversationEntry.run(
        `legacy-conversation-${hash(sourceKey).slice(0, 32)}`,
        conversationId,
        row.id,
        index + 1,
        message.role || 'legacy_instruction',
        message.status || 'completed',
        typeof message.text === 'string' ? message.text : '',
        JSON.stringify(Array.isArray(message.attachments) ? message.attachments : []),
        message.turnId || null,
        sourceKey,
        stableJson(message),
        Number(message.createdAt) || row.created_at || now,
        Number(message.updatedAt) || Number(message.createdAt) || row.updated_at || now,
      );
    });
  }

  const ensureLegacyTurn = db.prepare(`INSERT INTO engine_turns
    (id, work_item_id, action_id, run_id, ordinal, status, owner_boot_id, lease_epoch,
     input_entry_ids, message_entry_ids, control_entry_ids, request_body, request_hash,
     request_key, responded_at, consumed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'legacy_imported', ?, ?, '[]', '[]', '[]', '{}', '', ?, ?, ?, ?, ?)
    ON CONFLICT(request_key) DO NOTHING`);
  const insertActionEntry = db.prepare(`INSERT INTO action_entries
    (id, work_item_id, action_id, run_id, sequence, kind, role, status, text, attachments,
     source_key, payload, engine_turn_id, created_at, updated_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, 'message', 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO NOTHING`);
  const nextSequence = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM action_entries WHERE action_id = ?');
  const nextTurnOrdinal = db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM engine_turns WHERE run_id = ?');
  for (const row of db.prepare(`SELECT p.*, e.created_at, r.owner_boot_id, r.lease_epoch FROM pending_action_inputs p
    JOIN events e ON e.id = p.event_id LEFT JOIN runs r ON r.id = p.run_id
    ORDER BY p.action_id, p.event_id`).all()) {
    const sourceKey = `${sourcePrefix}:pending_action_inputs:${row.event_id}`;
    const sequence = Number(nextSequence.get(row.action_id)?.value) || 1;
    const status = row.superseded_at != null ? 'cancelled' : row.consumed_at != null ? 'consumed' : 'pending';
    let legacyTurnId = null;
    if (status === 'consumed' && row.run_id && row.owner_boot_id) {
      const requestKey = `${sourcePrefix}:pending_action_inputs:${row.event_id}:legacy-turn`;
      legacyTurnId = `legacy-engine-turn-${hash(requestKey).slice(0, 32)}`;
      const existingTurn = db.prepare('SELECT id FROM engine_turns WHERE request_key = ?').get(requestKey);
      if (existingTurn) {
        legacyTurnId = existingTurn.id;
      } else {
        const ordinal = Number(nextTurnOrdinal.get(row.run_id)?.value) || 1;
        ensureLegacyTurn.run(
          legacyTurnId, row.work_item_id, row.action_id, row.run_id, ordinal,
          row.owner_boot_id, Number(row.lease_epoch) || 0, requestKey,
          row.consumed_at, row.consumed_at, row.created_at || now, row.consumed_at,
        );
      }
    }
    insertActionEntry.run(
      `legacy-action-entry-${hash(sourceKey).slice(0, 32)}`,
      row.work_item_id,
      row.action_id,
      row.run_id || null,
      sequence,
      status,
      row.text || '',
      row.attachments || '[]',
      sourceKey,
      stableJson({ eventId: row.event_id }),
      legacyTurnId,
      row.created_at || now,
      row.consumed_at || row.superseded_at || row.created_at || now,
      row.consumed_at || null,
    );
  }

  const eventRows = db.prepare(`SELECT e.*, a.status AS action_status, a.generation, a.spec_hash
    FROM events e JOIN actions a ON a.id = e.action_id
    LEFT JOIN pending_action_inputs p ON p.event_id = e.id
    WHERE e.type = 'action.input_added' AND p.event_id IS NULL
    ORDER BY e.action_id, e.id`).all();
  for (const row of eventRows) {
    const data = parseJson(row.data, {});
    const sourceKey = `${sourcePrefix}:events:${row.id}`;
    const status = row.action_status === 'ready' ? 'consumed' : 'rejected';
    const sequence = Number(nextSequence.get(row.action_id)?.value) || 1;
    insertActionEntry.run(
      `legacy-action-entry-${hash(sourceKey).slice(0, 32)}`,
      row.work_item_id,
      row.action_id,
      null,
      sequence,
      status,
      typeof data.text === 'string' ? data.text : '',
      JSON.stringify(Array.isArray(data.attachments) ? data.attachments : []),
      sourceKey,
      stableJson({
        eventId: row.id,
        inputId: data.inputId || null,
        sourceGeneration: row.action_generation || null,
        currentGeneration: row.generation,
        currentSpecHash: row.spec_hash || '',
        migrationDisposition: status,
      }),
      null,
      row.created_at || now,
      row.created_at || now,
      status === 'consumed' ? row.created_at || now : null,
    );
  }
}

export function durableId(prefix = 'durable') {
  return `${prefix}-${randomUUID()}`;
}
