import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from './transaction.js';
import { LLMAdapter } from '../llm/adapter.js';
import { normalizeTokenUsage } from '../llm/usage-accounting.js';

// Work Center-local admission limits, not Engine or Session limits. Tokens are
// estimated before dispatch; this is not a guarantee about provider billing.
export const DEFAULT_EXECUTION_LIMITS = Object.freeze({
  maxRequests: 200,
  maxTokens: 2_000_000,
  maxRunRequests: 40,
  maxActionAttempts: 3,
  maxCoordinatorFailures: 3,
});
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
const UNKNOWN_REQUEST_TOKENS = 16_384;
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const emptyUsage = () => ({ llmRequestCount: 0, ...normalizeTokenUsage(), reservedTokens: 0,
  chargedTokens: 0, unknownRequests: 0, inFlightRequests: 0 });

export function estimateRequestTokens(request = {}) {
  // UTF-8 bytes / 3 is deliberately conservative for typical code/text, but is
  // still an estimate (images, tokenizer and reasoning behavior vary by model).
  const input = Math.ceil(Buffer.byteLength(JSON.stringify({ system: request.system,
    messages: request.messages, tools: request.tools }), 'utf8') / 3);
  return input + Math.max(1, count(request.maxTokens) || UNKNOWN_REQUEST_TOKENS);
}

export class WorkCenterResourceStopError extends Error {
  constructor(reason) {
    super(`Work Center execution stopped: ${reason?.code || 'needs_attention'}. Explicit user resume or budget extension required.`);
    this.name = 'WorkCenterResourceStopError';
    this.retryable = false;
    this.workItemFailureKind = 'resource_limit';
    this.workItemFailureCode = reason?.code || 'execution_stopped';
  }
}

/** SQLite owns admission and settlement. Callers may already hold BEGIN IMMEDIATE. */
export class WorkCenterResourceControl {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_item_execution_controls (
        work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
        limits_json TEXT NOT NULL, stop_reason TEXT, coordinator_failures INTEGER NOT NULL DEFAULT 0,
        retry_after INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, action_attempts_extension INTEGER NOT NULL DEFAULT 0,
        data_revision INTEGER NOT NULL DEFAULT 1, projection_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS work_item_action_attempt_limits (
        action_id TEXT PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
        original_max_attempts INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS work_item_action_attempt_limit_insert
      AFTER INSERT ON actions BEGIN
        INSERT OR IGNORE INTO work_item_action_attempt_limits (action_id, original_max_attempts)
          VALUES (NEW.id, MAX(0, NEW.max_attempts));
      END;
      CREATE TABLE IF NOT EXISTS work_item_resource_requests (
        id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, run_id TEXT, request_count INTEGER NOT NULL DEFAULT 1,
        estimated_tokens INTEGER NOT NULL, charged_tokens INTEGER NOT NULL,
        usage_json TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resource_requests_work_item ON work_item_resource_requests(work_item_id, run_id);
      CREATE TRIGGER IF NOT EXISTS work_item_execution_stop_status
      AFTER UPDATE OF status ON work_items
      WHEN NEW.status NOT IN ('needs_attention', 'cancelled') AND EXISTS (
        SELECT 1 FROM work_item_execution_controls c WHERE c.work_item_id = NEW.id AND c.stop_reason IS NOT NULL
      ) BEGIN UPDATE work_items SET status = 'needs_attention' WHERE id = NEW.id; END;
    `);
    // Additive migration from the initial ledger schema; never change the goal
    // contract revision to represent resource administration.
    this.atomic(() => {
      const columns = this.db.prepare('PRAGMA table_info(work_item_execution_controls)').all().map(row => row.name);
      if (!columns.includes('revision')) this.db.exec('ALTER TABLE work_item_execution_controls ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      if (!columns.includes('action_attempts_extension')) this.db.exec('ALTER TABLE work_item_execution_controls ADD COLUMN action_attempts_extension INTEGER NOT NULL DEFAULT 0');
      if (!columns.includes('data_revision')) this.db.exec('ALTER TABLE work_item_execution_controls ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 1');
      if (!columns.includes('projection_hash')) this.db.exec('ALTER TABLE work_item_execution_controls ADD COLUMN projection_hash TEXT');
      this.db.exec(`INSERT OR IGNORE INTO work_item_action_attempt_limits (action_id, original_max_attempts)
        SELECT id, MAX(0, max_attempts) FROM actions`);
      // Snapshot pre-ledger data once. Reopening never imports a Run twice.
      for (const item of this.db.prepare(`SELECT id FROM work_items WHERE id NOT IN
        (SELECT work_item_id FROM work_item_execution_controls)`).all()) this.ensure(item.id);
    });
  }

  atomic(fn) {
    return withTransaction(this.db, fn);
  }

  ensure(id) {
    const existing = this.db.prepare('SELECT * FROM work_item_execution_controls WHERE work_item_id = ?').get(id);
    if (existing) return existing;
    this.db.prepare('INSERT INTO work_item_execution_controls (work_item_id, limits_json) VALUES (?, ?)')
      .run(id, JSON.stringify(DEFAULT_EXECUTION_LIMITS));
    for (const run of this.db.prepare('SELECT * FROM runs WHERE work_item_id = ?').all(id)) {
      const turns = this.db.prepare(`SELECT COUNT(*) AS n,
        MAX(status IN ('dispatching', 'unknown')) AS unknown FROM engine_turns
        WHERE run_id = ? AND status != 'prepared'`).get(run.id);
      // Aggregate Run usage may only cover earlier responses. A later ambiguous
      // dispatch must retain its estimate even when the Run is already terminal.
      const unknown = ['running', 'dispatch_unknown'].includes(run.status) || !!turns.unknown;
      const requests = Math.max(count(run.llm_request_count), count(turns.n), unknown ? 1 : 0);
      if (!requests && !run.total_tokens) continue;
      const usage = normalizeTokenUsage({ inputTokens: run.input_tokens, outputTokens: run.output_tokens,
        cacheReadTokens: run.cache_read_tokens, cacheWriteTokens: run.cache_write_tokens, totalTokens: run.total_tokens });
      const estimate = unknown ? Math.max(usage.totalTokens, requests * UNKNOWN_REQUEST_TOKENS)
        : usage.totalTokens || requests * UNKNOWN_REQUEST_TOKENS;
      this.insert({ id: `legacy-run:${run.id}`, workItemId: id, kind: 'action', runId: run.id,
        requests, estimate, usage, status: usage.totalTokens && !unknown ? 'reported' : 'unknown' });
    }
    for (const turn of this.db.prepare(`SELECT * FROM coordinator_provider_turns WHERE work_item_id = ?
      AND status != 'prepared'`).all(id)) {
      const response = parse(turn.response, {});
      const usage = response?.usage ? normalizeTokenUsage(response.usage) : null;
      this.insert({ id: turn.id, workItemId: id, kind: 'coordinator',
        estimate: estimateRequestTokens(parse(turn.request_body, {})), usage,
        status: usage ? 'reported' : 'unknown' });
    }
    return this.db.prepare('SELECT * FROM work_item_execution_controls WHERE work_item_id = ?').get(id);
  }

  insert({ id, workItemId, kind, runId = null, requests = 1, estimate, usage = null, status = 'reserved' }) {
    this.db.prepare(`INSERT INTO work_item_resource_requests
      (id, work_item_id, kind, run_id, request_count, estimated_tokens, charged_tokens, usage_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workItemId, kind, runId, requests, estimate,
      status === 'reported' ? usage.totalTokens : Math.max(estimate, usage?.totalTokens || 0),
      usage ? JSON.stringify(usage) : null, status, this.store.now());
    this.advanceDataRevision(workItemId);
  }

  advanceDataRevision(id) {
    // Independent of the user-command CAS and goal revision. Null invalidates
    // the projection fingerprint: this mutation already advanced its version.
    this.db.prepare(`UPDATE work_item_execution_controls SET data_revision = data_revision + 1,
      projection_hash = NULL WHERE work_item_id = ?`).run(id);
  }

  snapshot(id) {
    return this.atomic(() => this.projectSnapshot(id));
  }

  projectSnapshot(id) {
    const control = this.ensure(id);
    const now = this.store.now();
    const breakdown = { coordinator: emptyUsage(), actions: emptyUsage() };
    for (const row of this.db.prepare('SELECT * FROM work_item_resource_requests WHERE work_item_id = ?').all(id)) {
      const target = row.kind === 'coordinator' ? breakdown.coordinator : breakdown.actions;
      const usage = parse(row.usage_json, {}) || {};
      target.llmRequestCount += row.request_count;
      for (const key of TOKEN_KEYS) target[key] += count(usage[key]);
      target.chargedTokens += row.charged_tokens;
      if (row.status !== 'reported') target.reservedTokens += row.charged_tokens;
      if (row.status === 'unknown') target.unknownRequests += row.request_count;
      if (row.status === 'reserved') {
        const live = row.run_id
          ? this.db.prepare("SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND expires_at > ?").get(row.run_id, now)
          : this.db.prepare("SELECT 1 FROM coordinator_provider_turns WHERE id = ? AND status = 'dispatching'").get(row.id.split(':retry:')[0]);
        if (live) target.inFlightRequests += row.request_count;
        else target.unknownRequests += row.request_count;
      }
    }
    const usage = emptyUsage();
    for (const part of Object.values(breakdown)) for (const key of Object.keys(usage)) usage[key] += part[key];
    const limits = parse(control.limits_json, DEFAULT_EXECUTION_LIMITS);
    const actionAttempts = this.db.prepare(`SELECT a.id, l.original_max_attempts,
      (SELECT COUNT(*) FROM runs r WHERE r.action_id = a.id) AS attempts
      FROM actions a JOIN work_item_action_attempt_limits l ON l.action_id = a.id
      WHERE a.work_item_id = ? ORDER BY a.sequence, a.id`).all(id).map(row => ({
      actionId: row.id, attempts: row.attempts, originalMaxAttempts: row.original_max_attempts,
      effectiveMaxAttempts: Math.min(row.original_max_attempts + control.action_attempts_extension, limits.maxActionAttempts),
    }));
    const snapshot = { revision: control.revision, limits, usage,
      actionAttemptsExtension: control.action_attempts_extension, actionAttempts,
      stopReason: parse(control.stop_reason, null), breakdown,
      coordinatorFailures: control.coordinator_failures, retryAfter: control.retry_after,
      tokenAccounting: 'estimated_admission_reported_usage_unknown_retained' };
    // Attempts and in-flight/unknown classification are derived from other
    // ledgers (and lease expiry). Version each observed change durably under the
    // same write transaction, including changes without a reserve or settle.
    const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const dataRevision = control.data_revision + (control.projection_hash != null && control.projection_hash !== hash ? 1 : 0);
    if (control.projection_hash !== hash) {
      this.db.prepare('UPDATE work_item_execution_controls SET data_revision = ?, projection_hash = ? WHERE work_item_id = ?')
        .run(dataRevision, hash, id);
    }
    return { ...snapshot, dataRevision };
  }

  stopped(id) {
    return !!this.db.prepare('SELECT stop_reason FROM work_item_execution_controls WHERE work_item_id = ?').get(id)?.stop_reason;
  }

  stop(id, code, details = {}) {
    return this.atomic(() => {
      this.ensure(id);
      const reason = { code, at: this.store.now(), ...details };
      const changed = this.db.prepare(`UPDATE work_item_execution_controls SET stop_reason = ?, revision = revision + 1
        WHERE work_item_id = ? AND stop_reason IS NULL`).run(JSON.stringify(reason), id);
      if (changed.changes) {
        this.advanceDataRevision(id);
        this.db.prepare(`UPDATE work_items SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'needs_attention' END,
          updated_at = ? WHERE id = ?`).run(this.store.now(), id);
        this.store.appendEvent(id, 'work_item.execution_stopped', reason);
      }
      return this.snapshot(id).stopReason;
    });
  }

  reserve({ id = randomUUID(), workItemId, kind, runId = null, request = {} }) {
    // Return denial rather than throwing inside the transaction: the stop must
    // commit even though the caller must throw before touching the provider.
    return this.atomic(() => {
      const snapshot = this.snapshot(workItemId);
      const previous = this.db.prepare('SELECT * FROM work_item_resource_requests WHERE id = ?').get(id);
      if (previous) return { allowed: false, reason: { code: 'request_already_reserved' } };
      if (snapshot.stopReason) return { allowed: false, reason: snapshot.stopReason };
      const item = this.db.prepare('SELECT status FROM work_items WHERE id = ?').get(workItemId);
      if (['done', 'cancelled'].includes(item?.status)) return { allowed: false, reason: { code: 'work_item_inactive' } };
      const estimate = estimateRequestTokens(request);
      const runRequests = runId ? this.db.prepare(`SELECT COALESCE(SUM(request_count), 0) AS n
        FROM work_item_resource_requests WHERE run_id = ?`).get(runId).n : 0;
      const code = runId && runRequests >= snapshot.limits.maxRunRequests ? 'run_requests_exhausted'
        : snapshot.usage.llmRequestCount >= snapshot.limits.maxRequests ? 'work_item_requests_exhausted'
          : snapshot.usage.chargedTokens + estimate > snapshot.limits.maxTokens ? 'work_item_tokens_exhausted' : null;
      if (code) return { allowed: false, reason: this.stop(workItemId, code, { runId, estimatedNextTokens: estimate }) };
      this.insert({ id, workItemId, kind, runId, estimate });
      return { allowed: true, id };
    });
  }

  settle(id, rawUsage, complete = true) {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM work_item_resource_requests WHERE id = ?').get(id);
      if (!row || row.status === 'reported' || (row.status === 'unknown' && !rawUsage)) return false;
      const usage = rawUsage ? normalizeTokenUsage(rawUsage) : null;
      const reported = complete && usage && usage.totalTokens > 0;
      const charged = reported ? usage.totalTokens : Math.max(row.estimated_tokens, usage?.totalTokens || 0);
      this.db.prepare(`UPDATE work_item_resource_requests SET usage_json = ?, charged_tokens = ?, status = ? WHERE id = ?`)
        .run(usage ? JSON.stringify(usage) : row.usage_json, charged, reported ? 'reported' : 'unknown', id);
      this.advanceDataRevision(row.work_item_id);
      const snapshot = this.snapshot(row.work_item_id);
      if (snapshot.usage.chargedTokens > snapshot.limits.maxTokens) this.stop(row.work_item_id, 'work_item_tokens_exhausted');
      return true;
    });
  }

  coordinatorRequestIds(turnId) {
    return this.db.prepare(`SELECT id FROM work_item_resource_requests WHERE id = ? OR id LIKE ? ORDER BY rowid DESC`)
      .all(turnId, `${turnId}:retry:%`).map(row => row.id);
  }

  settleCoordinator(turnId, usage, complete = true) {
    const [latest, ...earlier] = this.coordinatorRequestIds(turnId);
    for (const id of earlier) this.settle(id, null, false);
    return latest ? this.settle(latest, usage, complete) : false;
  }

  canAttempt(action) {
    const entry = this.snapshot(action.workItemId).actionAttempts.find(row => row.actionId === action.id);
    if (entry && entry.attempts < entry.effectiveMaxAttempts) return true;
    this.stop(action.workItemId, 'action_attempts_exhausted', entry || { actionId: action.id });
    return false;
  }

  coordinatorFailed(id, turnId) {
    return this.atomic(() => {
      const snapshot = this.snapshot(id);
      const failures = snapshot.coordinatorFailures + 1;
      this.db.prepare(`UPDATE work_item_execution_controls SET coordinator_failures = ?, retry_after = ? WHERE work_item_id = ?`)
        .run(failures, this.store.now() + Math.min(1_000 * (2 ** Math.min(failures - 1, 8)), 300_000), id);
      this.advanceDataRevision(id);
      if (failures >= snapshot.limits.maxCoordinatorFailures) {
        this.stop(id, 'coordinator_failures_exhausted', { turnId, failures });
      }
    });
  }

  /** Only an authenticated user command may call this; no model/tool path. */
  extend(id, revision, additions = {}) {
    return this.atomic(() => {
      if (!this.store.getWorkItem(id)) throw new Error(`WorkItem not found: ${id}`);
      this.assertRevision(id, revision);
      if (!additions || typeof additions !== 'object' || Array.isArray(additions)
          || Object.keys(additions).length === 0) throw new Error('Invalid execution budget additions');
      const snapshot = this.snapshot(id);
      const limits = { ...snapshot.limits };
      for (const [key, value] of Object.entries(additions)) {
        if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value <= 0
            || !Number.isSafeInteger(limits[key] + value)) throw new Error(`Invalid execution budget addition: ${key}`);
        limits[key] += value;
      }
      this.db.prepare(`UPDATE work_item_execution_controls SET limits_json = ?, revision = revision + 1,
        action_attempts_extension = action_attempts_extension + ? WHERE work_item_id = ? AND revision = ?`)
        .run(JSON.stringify(limits), additions.maxActionAttempts || 0, id, revision);
      this.advanceDataRevision(id);
      this.db.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(this.store.now(), id);
      this.store.appendEvent(id, 'work_item.execution_budget_extended', { additions, limits });
      return this.store.getWorkItemDetail(id);
    });
  }

  assertRevision(id, revision) {
    if (!Number.isSafeInteger(revision) || this.ensure(id).revision !== revision) {
      throw new Error('Execution control changed; refresh before changing execution budget or resuming');
    }
  }

  resume(id, revision) {
    if (revision !== undefined || this.stopped(id)) this.assertRevision(id, revision);
    const snapshot = this.snapshot(id);
    if (snapshot.usage.llmRequestCount >= snapshot.limits.maxRequests
        || snapshot.usage.chargedTokens >= snapshot.limits.maxTokens
        || snapshot.coordinatorFailures >= snapshot.limits.maxCoordinatorFailures) {
      throw new Error('Extend the exhausted WorkItem execution budget before resuming');
    }
    if (snapshot.stopReason?.code === 'action_attempts_exhausted') {
      const action = this.store.getAction(snapshot.stopReason.actionId);
      if (action && !this.canAttempt(action)) throw new Error('Extend maxActionAttempts before resuming');
    }
    this.db.prepare(`UPDATE work_item_execution_controls SET stop_reason = NULL, retry_after = 0,
      revision = revision + 1, data_revision = data_revision + 1, projection_hash = NULL WHERE work_item_id = ?`).run(id);
  }
}

/** Fail-closed, Work Center-only adapter. Every native callback runs immediately
 * before fetch; plain legacy adapters reserve at invocation/iteration instead.
 * Reservations survive crash/abort/missing usage and never become free retries.
 */
export class WorkCenterResourceAdapter extends LLMAdapter {
  constructor(adapter, store, workItemId, runId) {
    super(adapter?.config || {});
    this.adapter = adapter;
    this.store = store;
    this.workItemId = workItemId;
    this.runId = runId;
  }

  captureRequest() {
    const captured = this.adapter.captureRequest?.();
    const capture = captured?.captureStream || this.adapter.captureStream?.bind(this.adapter)
      || this.adapter.stream.bind(this.adapter);
    const native = this.adapter instanceof LLMAdapter;
    return { captureStream: params => this.accountStream(capture, params, native) };
  }
  captureStream(params) { return this.captureRequest().captureStream(params); }
  stream(params) { return this.captureStream(params); }

  request(params) {
    let reservation = null;
    let usage = null;
    let suppressFirstCallback = false;
    const settle = (reportedUsage, complete) => {
      if (reservation?.allowed) this.store.settleWorkItemRequest(reservation.id, reportedUsage ?? usage, complete);
    };
    const start = () => {
      settle(usage, false);
      reservation = null;
      usage = null;
      // Admission precedes Engine dispatch marking: a denied request must not
      // become a dispatch-unknown Run. If the subsequent lease fence fails the
      // reservation remains conservatively charged (no free ambiguous retry).
      if (this.store.isExecutionStopped(this.workItemId)) {
        throw new WorkCenterResourceStopError(this.store.getExecutionControl(this.workItemId).stopReason);
      }
      reservation = this.store.reserveWorkItemRequest({ workItemId: this.workItemId,
        kind: 'action', runId: this.runId, request: params });
      if (!reservation.allowed) throw new WorkCenterResourceStopError(reservation.reason);
      params.onRequestStart?.();
    };
    return { params: { ...params, onRequestStart: () => {
      if (suppressFirstCallback) {
        suppressFirstCallback = false;
        if (this.store.isExecutionStopped(this.workItemId)) {
          throw new WorkCenterResourceStopError(this.store.getExecutionControl(this.workItemId).stopReason);
        }
        // Early legacy admission is not the last dispatch boundary. Recheck the
        // original EngineTurn/Run lease without reserving or counting it again.
        params.onRequestStart?.();
        return;
      }
      start();
    } }, start: () => { start(); suppressFirstCallback = true; },
      addUsage: event => {
        usage ||= normalizeTokenUsage();
        const next = normalizeTokenUsage(event);
        for (const key of TOKEN_KEYS) usage[key] += next[key];
      }, settle };
  }

  async *accountStream(capture, params, native) {
    const request = this.request(params);
    let complete = false;
    try {
      if (!native) request.start();
      for await (const event of capture(request.params)) {
        if (event?.type === 'usage') request.addUsage(event);
        yield event;
      }
      complete = true;
    } finally { request.settle(null, complete); }
  }
  async call(params) {
    const request = this.request(params);
    let usage = null;
    let complete = false;
    try {
      // Side calls also count, including any future Engine helper calls.
      if (!(this.adapter instanceof LLMAdapter)) request.start();
      const result = await this.adapter.call(request.params);
      usage = result?.usage;
      complete = true;
      return result;
    } finally { request.settle(usage, complete); }
  }
  getProviderForModel(model) { return this.adapter.getProviderForModel?.(model) || null; }
  listAvailableModels() { return this.adapter.listAvailableModels?.() || []; }
}

/** Native adapters own the last pre-fetch callback; plain legacy adapters are
 * conservatively admitted before invocation even if they omit the callback. */
export async function callCoordinatorWithResourceControl(adapter, store, turn, claim, params) {
  const native = adapter instanceof LLMAdapter;
  let suppressFirstCallback = !native;
  const start = (revalidate = false) => {
    const active = revalidate ? store.isActiveCoordinatorProviderTurn(turn.id, claim)
      : store.dispatchCoordinatorProviderTurn(turn.id, claim);
    if (!active) {
      const error = new Error('Coordinator provider turn lost its dispatch fence or execution budget');
      error.retryable = false;
      throw error;
    }
  };
  try {
    if (!native) start();
    const response = await adapter.call({ ...params, onRequestStart: () => {
      if (suppressFirstCallback) {
        suppressFirstCallback = false;
        // A resumed WorkItem may be active while this pre-stop claim is stale.
        // Revalidate it without treating the first callback as a paid retry.
        start(true);
        return;
      }
      start();
    } });
    // Even a late response after cancellation is real consumption. Response CAS
    // still fences its decision, while idempotent settlement keeps its usage.
    store.settleCoordinatorRequest(turn.id, response?.usage);
    return response;
  } catch (error) {
    store.settleCoordinatorRequest(turn.id, null, false);
    throw error;
  }
}
