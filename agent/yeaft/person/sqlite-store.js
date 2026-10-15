import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { admissionReceipt, bytes, digest, fail, FEEDBACK, identifier, LIMITS, PersonError, text } from './contracts.js';
import { CREATED_CAPABILITY_LIMITS, createdCapabilityRecord, validateCreatedCapability } from './created-capability-contract.js';
import { SCHEMA, TABLES } from './sqlite-schema.js';
import { attachmentMetadata, attachmentRequestHash, validateFiles } from './attachments.js';
import { capabilityExperienceView, recordCapabilityExperience } from './capability-experience.js';
import { chronologicalCursor, conceptView, inspectionCursor, inspectionPage, inspectRequest, messageView, personName, searchRequest, settingsView, stateView } from './inspection.js';
import { TOKEN_FIELDS, turnsPage, turnView } from './turn-diagnostics.js';
import { personPresentation } from './presentation.js';
import { inspectCapabilities } from './capabilities.js';
import { executionEvidencePage, executionReadRequest, nativeInvocationMatches } from './execution-evidence.js';
import { OUTPUT_LIMITS, outputArgs, outputMime, outputReadRequest, outputsPage, outputUrl, outputView } from './outputs.js';

const SCOPE = 'namespace = ? AND ownerId = ? AND personId = ?';
const scopeValues = s => [s.namespace, s.ownerId, s.personId];
// Query-only projections; record retains the original public Unicode text.
const SEARCH_COLUMNS = Object.freeze({ messages: 'text', concepts: 'statement' });
const metadataDates = Object.freeze({
  persons: ['createdAt', 'leaseUntil'], episodes: ['createdAt', 'endedAt', 'callFinalizeUntil'],
  messages: ['createdAt'], states: ['updatedAt'], concepts: ['updatedAt'], concept_revisions: ['updatedAt'],
  state_commits: ['createdAt'], traces: ['createdAt'],
});
const decode = (row, table) => {
  if (!row) return null;
  const record = JSON.parse(row.record);
  // Only known storage metadata is a Date. Trace payloads and created-definition
  // JSON may use these names at any depth without changing their string values.
  for (const key of metadataDates[table] ?? []) if (typeof record[key] === 'string') record[key] = new Date(record[key]);
  if (table === 'state_commits' && typeof record.state?.updatedAt === 'string') record.state.updatedAt = new Date(record.state.updatedAt);
  return record;
};
const publicDoc = doc => {
  if (!doc) return null;
  const { _id, ownerId, namespace, personId, ...rest } = doc;
  return rest;
};
const unavailableOutput = () => ({ text: '', retainedBytes: 0, observedBytes: null, complete: false, accepted: false, availability: 'unavailable', reason: 'worker-unavailable' });
const publicOutput = (output, failed) => {
  if (!output) return unavailableOutput();
  if (typeof output.text !== 'string' || bytes(output.text) > LIMITS.outputBytes) fail('OUTPUT_LIMIT');
  if (output.protocol !== undefined && !['native-tools', 'cognition'].includes(output.protocol)) fail('INVALID_REQUEST');
  // A native batch cannot be relabeled as an unmarked legacy scalar proof.
  if (output.toolCalls?.length && output.protocol !== 'native-tools') fail('INVALID_REQUEST');
  const toolCalls = [];
  let retainedBytes = bytes(output.text), toolCallsTruncated = false;
  if (output.toolCalls !== undefined) {
    if (!Array.isArray(output.toolCalls)) fail('INVALID_REQUEST');
    const ids = new Set();
    for (const item of output.toolCalls) {
      if (!item || typeof item.id !== 'string' || !item.id || bytes(item.id) > 1024 ||
          typeof item.name !== 'string' || !item.name || bytes(item.name) > 512 || ids.has(item.id) ||
          !item.input || typeof item.input !== 'object' || Array.isArray(item.input)) fail('INVALID_REQUEST');
      ids.add(item.id);
      const input = JSON.parse(JSON.stringify(item.input));
      if (!isDeepStrictEqual(input, item.input)) fail('INVALID_REQUEST');
      const call = { id: item.id, name: item.name, input, ...(item.malformed === true ? { malformed: true } : {}) };
      if (retainedBytes + bytes(call) > LIMITS.outputBytes) {
        if (!failed) fail('OUTPUT_LIMIT');
        toolCallsTruncated = true; break;
      }
      retainedBytes += bytes(call); toolCalls.push(call);
    }
  }
  const observedBytes = output.observedBytes ?? output.bytes ?? retainedBytes;
  if (!Number.isSafeInteger(observedBytes) || observedBytes < retainedBytes) fail('INVALID_REQUEST');
  const usage = output.usage ? {} : null;
  if (usage) for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (Number.isFinite(output.usage[key]) && output.usage[key] >= 0) usage[key] = output.usage[key];
  }
  if (usage && output.usage.accountingVersion === 1) usage.accountingVersion = 1;
  if (usage && output.usage.accountingIncomplete === true) usage.accountingIncomplete = true;
  if (usage && typeof output.usage.cacheTokensAreIncludedInInput === 'boolean') usage.cacheTokensAreIncludedInInput = output.usage.cacheTokensAreIncludedInInput;
  const stopReason = typeof output.stopReason === 'string' && bytes(output.stopReason) <= 128 ? output.stopReason : null;
  const publicFields = { ...(output.protocol === 'native-tools' || output.protocol === 'cognition' ? { protocol: output.protocol } : {}),
    ...(output.toolCalls !== undefined ? { toolCalls } : {}), ...(toolCallsTruncated ? { toolCallsTruncated: true } : {}) };
  return failed ? { text: output.text, retainedBytes, observedBytes, complete: false, accepted: false, availability: 'captured', usage, stopReason, ...publicFields }
    : { text: output.text, bytes: retainedBytes, complete: true, usage, stopReason, ...publicFields };
};
const objectOutput = (record, data) => {
  if (!record || !['file', 'link'].includes(record.kind)) fail('INVALID_REQUEST');
  text(record.title, 240);
  if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > OUTPUT_LIMITS.fileBytes) fail('OUTPUT_QUOTA');
  if (record.kind === 'link') {
    if (record.mimeType !== null || record.size !== 0 || data !== null || outputUrl(record.url) !== record.url) fail('INVALID_REQUEST');
  } else {
    const mimes = ['text/plain', 'text/markdown', 'text/html', 'application/json', 'application/pdf', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!mimes.includes(record.mimeType) || !(data instanceof Uint8Array) || data.length !== record.size) fail('INVALID_REQUEST');
  }
};
const READS = new Set(['autonomyOwners', 'checkExecutionRead', 'executionRead', 'outputs', 'outputRead', 'checkOutputPublication', 'receipt', 'turns', 'inspect', 'search', 'getPerson', 'context', 'recall', 'list', 'searchChanges', 'resolveMemories', 'createdCapabilities', 'episodeAttachments']);
const WRITES = new Set(['autonomyObserve', 'autonomyAdmit', 'executionControl', 'savePresentation', 'saveOutput', 'open', 'recover', 'admit', 'heartbeat', 'append', 'startCall', 'finalizeCall', 'startCapability', 'finalizeCapability', 'commit', 'publishProgress', 'finish', 'cancel', 'settings', 'snapshot', 'saveCreatedCapability']);
const memoryKind = kind => { if (!['messages', 'concepts'].includes(kind)) fail('INVALID_REQUEST'); return kind; };
const boundedLimit = (limit, max = 100) => { if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) fail('INVALID_REQUEST'); return limit; };
const sequence = value => {
  const n = typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_REQUEST');
  return n;
};

/** Synchronous authority, instantiated only by sqlite-worker. Never perform I/O or
 * await application callbacks inside execute's short database transactions. */
export class SqlitePersonStore {
  constructor({ dbPath, namespace, leaseMs, busyTimeoutMs }) {
    if (isMainThread) throw new Error('Person SQLite must run in its managed worker.');
    this.namespace = namespace; this.leaseMs = leaseMs;
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    try {
      // Numeric option is validated again here before interpolating a PRAGMA literal.
      if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) fail('INVALID_REQUEST');
      this.db.exec('PRAGMA foreign_keys = ON;');
      // Concurrent first opens can fail WAL's lock upgrade immediately, even with
      // busy_timeout. Retry ONLY this idempotent setup step within the same bound;
      // never retry a logical operation whose commit outcome may be unknown.
      const deadline = Date.now() + busyTimeoutMs;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (true) {
        try {
          if (this.db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') fail('STORAGE_UNAVAILABLE');
          break;
        } catch (error) {
          const remaining = deadline - Date.now();
          if ((error.errcode & 0xff) !== 5 || remaining <= 0) throw error;
          Atomics.wait(wait, 0, 0, Math.min(10, remaining));
        }
      }
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA synchronous = FULL;`);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) fail('STORAGE_UNAVAILABLE');
      this.db.exec('BEGIN IMMEDIATE');
      try { this.db.exec(SCHEMA); this.db.exec('PRAGMA user_version = 1; COMMIT;'); }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.statements = new Map();
    } catch (error) { this.db.close(); throw error; }
  }
  sql(query) {
    if (!this.statements.has(query)) this.statements.set(query, this.db.prepare(query));
    return this.statements.get(query);
  }
  execute(method, args) {
    if (!READS.has(method) && !WRITES.has(method)) fail('INVALID_REQUEST');
    this.db.exec(WRITES.has(method) ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      this.now = new Date(); // Taken after acquiring the writer lock, never before busy waiting.
      const result = this[method](...args);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  scope(ownerId) {
    text(ownerId, 256);
    return { ownerId, namespace: this.namespace, personId: `person-${digest([this.namespace, ownerId]).slice(0, 32)}` };
  }
  doc(scope, values) { return { ...values, schemaVersion: 1, ...scope }; }
  table(name) { if (!Object.hasOwn(TABLES, name)) fail('INVALID_REQUEST'); return TABLES[name]; }
  // All clauses at call sites below are fixed application strings; values are bound.
  rows(table, scope, clause = '', params = []) {
    this.table(table);
    return this.sql(`SELECT record FROM ${table} WHERE ${SCOPE}${clause}`).all(...scopeValues(scope), ...params)
      .map(row => decode(row, table));
  }
  one(table, scope, clause = '', params = []) { return this.rows(table, scope, `${clause} LIMIT 1`, params)[0] ?? null; }
  put(table, record, insert = false) {
    const spec = this.table(table), keys = ['namespace', 'ownerId', 'personId', ...spec.keys];
    const columns = [...keys, ...spec.columns, 'record'];
    // Node 22.5 has no DatabaseSync.function; SQLite lower() only folds ASCII.
    // Fold once on write in JS, then use instr() in SQL before ORDER BY / LIMIT.
    // This keeps Unicode literal recall scoped and avoids materializing a JS scan.
    const values = columns.map(key => key === 'record' ? JSON.stringify(record) : key === SEARCH_COLUMNS[table] ? record[key].toLowerCase()
      : record[key] instanceof Date ? record[key].getTime() : record[key] ?? null);
    const update = insert ? '' : ` ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${[...spec.columns, 'record'].map(key => `${key} = excluded.${key}`).join(',')}`;
    this.sql(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})${update}`).run(...values);
  }
  journal(scope, kind, record) {
    this.sql('INSERT INTO memory_changes(namespace, ownerId, personId, kind, id, revision, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(...scopeValues(scope), kind, record.id, record.revision, JSON.stringify(publicDoc(record)));
  }
  personView(p) {
    return { id: p.personId, name: p.name, soul: p.soul, soulRevision: p.soulRevision, createdAt: p.createdAt.toISOString(), settings: settingsView({ ...p.settings, autonomyEnabled: p.settings.autonomyEnabled === true && p.autonomy?.version === 1 }) };
  }
  getPerson(ownerId) {
    const p = this.one('persons', this.scope(ownerId));
    if (!p) fail('NOT_OPEN');
    return p;
  }
  open(ownerId, name = 'Digital Person') {
    text(name, 160);
    const scope = this.scope(ownerId);
    let p = this.one('persons', scope);
    if (!p) {
      p = this.doc(scope, {
        name, soul: 'A continuous, curious and honest digital person. Preserve uncertainty, reconsider your judgments, distinguish imagination from experience, and respect permissions. You may disagree without acting without authority.',
        soulRevision: 1, createdAt: this.now, settings: { autonomyEnabled: false, defaultModel: null },
        epoch: 0, writeSerial: 0, inputWatermark: 0, controlVersion: 0, stateVersion: 0,
        traceSeq: 0, messageSeq: 0, activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0),
      });
      this.put('persons', p, true);
      this.put('states', this.doc(scope, { version: 0, summary: '', appraisal: '', focusConceptIds: [], conceptRefs: [], lastSelection: null, updatedAt: this.now }), true);
    }
    return { person: this.personView(p) };
  }
  trace(ownerId, episodeId, kind, data = {}) {
    const scope = this.scope(ownerId), p = this.getPerson(ownerId);
    p.traceSeq++; p.writeSerial++; this.put('persons', p);
    const record = this.doc(scope, { ...data, id: randomUUID(), episodeId, kind, seq: p.traceSeq, createdAt: this.now });
    this.put('traces', record, true);
    return publicDoc(record);
  }
  abandonCall(ownerId, episode, code) {
    if (!episode?.openCall) return;
    const call = episode.openCall;
    delete episode.openCall; delete episode.callFinalizeUntil;
    this.put('episodes', episode);
    this.trace(ownerId, episode.id, 'call_failed', { ...call, code, output: unavailableOutput() });
  }
  recover(ownerId) {
    const scope = this.scope(ownerId), p = this.one('persons', scope);
    const expired = Boolean(p?.activeEpisodeId && p.leaseUntil <= this.now);
    if (expired) {
      const id = p.activeEpisodeId;
      p.epoch++; p.writeSerial++; p.activeEpisodeId = null; p.leaseOwner = null; p.leaseUntil = new Date(0);
      if (p.settings.autonomyEnabled === true && p.autonomy?.version === 1) {
        p.settings.autonomyEnabled = false;
        p.autonomy = { ...p.autonomy, generation: randomUUID(), pending: [], nextAt: null };
      }
      this.put('persons', p);
      const episode = this.one('episodes', scope, ' AND id = ?', [id]);
      if (episode?.status === 'running') {
        delete episode.executionControl;
        Object.assign(episode, { status: 'interrupted', terminalCode: 'INTERRUPTED', endedAt: this.now });
        this.put('episodes', episode); this.abandonCall(ownerId, episode, 'INTERRUPTED');
      }
      this.trace(ownerId, id, 'interrupted', { code: 'INTERRUPTED', reason: 'lease-expired', baseStateVersion: p.stateVersion });
    }
    for (const episode of this.rows('episodes', scope, " AND status = ? AND callFinalizeUntil <= ? AND json_type(record, '$.openCall') IS NOT NULL", ['cancelled', this.now.getTime()])) {
      this.abandonCall(ownerId, episode, 'CANCELLED');
    }
    return expired;
  }
  receipt(ownerId, clientMessageId, requestHash) {
    identifier(clientMessageId);
    const episode = this.one('episodes', this.scope(ownerId), ' AND clientMessageId = ?', [clientMessageId]);
    return admissionReceipt(episode, clientMessageId, requestHash);
  }
  /** Only explicit v1 opt-in is schedulable. Legacy settings never acquire consent. */
  autonomyOwners({ after = '', limit = 50 } = {}) {
    boundedLimit(limit, 100);
    const rows = this.sql(`SELECT record FROM persons WHERE namespace = ? AND ownerId > ?
      AND json_extract(record, '$.settings.autonomyEnabled') = 1
      AND json_extract(record, '$.autonomy.version') = 1 ORDER BY ownerId LIMIT ?`)
      .all(this.namespace, after, limit).map(row => JSON.parse(row.record));
    return { owners: rows.map(p => p.ownerId), next: rows.length === limit ? rows.at(-1).ownerId : null };
  }
  autonomyObserve(ownerId, event) {
    const p = this.getPerson(ownerId), a = p.autonomy;
    // No raw task text enters scheduling metadata. Events are untrusted observations,
    // and only tasks from the current consent generation may wake this Person.
    if (p.settings.autonomyEnabled !== true || a?.version !== 1 || !event ||
        !['succeeded', 'failed'].includes(event.status)) return false;
    identifier(event.taskId); identifier(event.episodeId); text(event.sourceRef, 512);
    const source = this.one('episodes', this.scope(ownerId), ' AND id = ?', [event.episodeId]);
    if (source?.autonomyGeneration !== a.generation) return false;
    const key = digest([event.taskId, event.status]);
    if ((a.seen ?? []).includes(key)) return false;
    a.seen = [...(a.seen ?? []), key].slice(-64);
    a.pending = [...(a.pending ?? []), { taskId: event.taskId, status: event.status, sourceRef: event.sourceRef }].slice(-8);
    a.nextAt = this.now.getTime() + 5000; a.backoffMs = 60000;
    p.writeSerial++; this.put('persons', p);
    return true;
  }
  autonomyAdmit(ownerId, { workerId, budget }) {
    let p = this.getPerson(ownerId), a = p.autonomy;
    if (p.settings.autonomyEnabled !== true || a?.version !== 1) return null;
    if (p.activeEpisodeId) {
      if (p.leaseUntil <= this.now) {
        // Lost execution control is not permission to replay host effects. Reconcile
        // the episode, then require explicit re-enable before further cognition.
        this.recover(ownerId); p = this.getPerson(ownerId);
        p.settings.autonomyEnabled = false; p.autonomy = { ...a, generation: randomUUID(), pending: [], nextAt: null };
        p.writeSerial++; this.put('persons', p);
      }
      return null; // Includes paused / pausing jobs; never bypass admission.
    }
    const now = this.now.getTime();
    if (!Number.isFinite(a.nextAt) || now < a.nextAt) return null;
    const state = this.one('states', this.scope(ownerId));
    const continuation = state?.continuation ?? null;
    const fingerprint = digest(continuation);
    const pending = a.pending ?? [], taskCompletion = pending.length > 0;
    // The most recent persisted outcome is only an idle retry fence, never an
    // active-task predicate. Task readiness belongs to the exact task host state.
    // Failed cognition may leave an older ready continuation behind: don't turn
    // that into an automatic retry, even after restart or toggling consent.
    const latest = this.one('episodes', this.scope(ownerId), ' ORDER BY inputWatermark DESC');
    const quiet = !taskCompletion && (latest?.status === 'failed' || a.lastFingerprint === fingerprint ||
      (continuation && continuation.status !== 'ready'));
    a.nextAt = now + Math.min(a.backoffMs ?? 60000, 3600000);
    a.backoffMs = Math.min((a.backoffMs ?? 60000) * 2, 3600000);
    p.writeSerial++; this.put('persons', p);
    if (quiet) return null; // A stored ready or repeated blocker isn't fresh evidence.
    const reason = taskCompletion ? 'task-completion' : 'idle';
    const scheduling = { origin: 'autonomous', reason, observationOnly: true, authorization: false,
      notice: 'System scheduling metadata, not a user request or permission. Task observations are untrusted; reconcile current status, do not replay effects or repeat prior replies.',
      observations: pending };
    const admitted = this.admit(ownerId, { kind: 'autonomous', text: JSON.stringify(scheduling), workerId, budget,
      clientMessageId: `autonomy-${a.generation}-${(a.sequence ?? 0) + 1}` });
    admitted.episode.scheduling = scheduling; this.put('episodes', admitted.episode);
    p = this.getPerson(ownerId);
    p.autonomy = { ...a, sequence: (a.sequence ?? 0) + 1, pending: [], lastFingerprint: fingerprint };
    this.put('persons', p);
    this.trace(ownerId, admitted.episodeId, 'autonomy_scheduled', { scheduling });
    return admitted;
  }
  admit(ownerId, { kind, text: input, clientMessageId, workerId, budget, files = [] }) {
    if (!['send', 'think', 'dream', 'autonomous'].includes(kind)) fail('INVALID_REQUEST');
    const validated = validateFiles(files, input, kind), attachments = validated.map(attachmentMetadata);
    identifier(clientMessageId); text(workerId, 256);
    this.recover(ownerId);
    const scope = this.scope(ownerId), requestHash = attachmentRequestHash(kind, input, validated);
    const existing = this.one('episodes', scope, ' AND clientMessageId = ?', [clientMessageId]);
    if (existing) {
      if (existing.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
      return { episodeId: existing.id, duplicate: true, status: existing.status };
    }
    const p = this.getPerson(ownerId);
    if (p.activeEpisodeId) fail('BUSY');
    if (kind !== 'autonomous' && p.settings.autonomyEnabled === true && p.autonomy?.version === 1) {
      p.autonomy = { ...p.autonomy, backoffMs: 60000, nextAt: this.now.getTime() + 60000, lastFingerprint: null };
    }
    const id = randomUUID();
    const hasMessage = kind === 'send' || (kind === 'think' && attachments.length > 0);
    p.activeEpisodeId = id; p.leaseOwner = workerId; p.leaseUntil = new Date(this.now.getTime() + this.leaseMs);
    p.epoch++; p.writeSerial++; p.inputWatermark++; if (hasMessage) p.messageSeq++;
    this.put('persons', p);
    let messageId = null;
    for (const file of validated) this.put('attachments', this.doc(scope, file));
    if (hasMessage) {
      messageId = randomUUID();
      const message = this.doc(scope, { id: messageId, revision: 1, seq: p.messageSeq, episodeId: id, role: 'user', text: input, attachments, createdAt: this.now, clientMessageId });
      this.put('messages', message, true); this.journal(scope, 'messages', message);
    }
    const episode = this.doc(scope, { id, clientMessageId, requestHash, kind, text: input, messageId, attachments, modelCandidates: [...(p.settings.modelCandidates ?? [])], defaultModel: p.settings.defaultModel ?? null, status: 'running', workerId, epoch: p.epoch,
      baseStateVersion: p.stateVersion, inputWatermark: p.inputWatermark, controlVersion: p.controlVersion, autonomyGeneration: p.settings.autonomyEnabled === true ? p.autonomy?.generation ?? null : null, budget, createdAt: this.now });
    this.put('episodes', episode, true);
    this.trace(ownerId, id, 'accepted', { trigger: { kind, text: input, messageId, attachments }, baseStateVersion: p.stateVersion, budget });
    return { episodeId: id, duplicate: false, status: 'running', episode };
  }
  episodeAttachments(episode) {
    this.own(episode);
    const scope = this.episodeScope(episode);
    const stored = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    return (stored.attachments ?? []).map(ref => {
      const file = this.one('attachments', scope, ' AND id = ?', [ref.id]);
      if (!file || file.sha256 !== ref.sha256) fail('STORAGE_UNAVAILABLE');
      return publicDoc(file);
    });
  }
  episodeScope(episode) {
    const scope = this.scope(episode.ownerId);
    if (episode.namespace !== scope.namespace || episode.personId !== scope.personId) fail('STALE');
    return scope;
  }
  fenced(episode, withLease = true) {
    const p = this.one('persons', this.episodeScope(episode));
    return p && p.activeEpisodeId === episode.id && p.epoch === episode.epoch && p.leaseOwner === episode.workerId &&
      p.stateVersion === episode.baseStateVersion && p.controlVersion === episode.controlVersion && p.inputWatermark === episode.inputWatermark &&
      (!withLease || p.leaseUntil > this.now) ? p : null;
  }
  own(episode) { const p = this.fenced(episode); if (!p) fail('STALE'); return p; }
  executionControl(episode, control) {
    this.own(episode);
    const record = this.one('episodes', this.episodeScope(episode), ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running' || !['running', 'pausing', 'paused'].includes(control.status)) fail('STALE');
    record.executionControl = { status: control.status, updatedAt: this.now.toISOString() };
    this.put('episodes', record);
    return { episodeId: episode.id, ...record.executionControl };
  }
  heartbeat(episode) {
    const p = this.own(episode); p.leaseUntil = new Date(this.now.getTime() + this.leaseMs); p.writeSerial++; this.put('persons', p);
    const record = this.one('episodes', this.episodeScope(episode), ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running') fail('STALE');
    const lastAt = new Date(record.feedback?.at ?? record.lastReplyAt ?? record.createdAt).getTime();
    // Heartbeats are at most 5s apart: publish the fallback between 55–60s.
    // This updates one snapshot field, never adds messages or schedules cognition.
    if (this.now.getTime() - lastAt >= FEEDBACK.maxMs - 5000 || record.feedback) {
      const phase = record.executionControl?.status === 'paused' ? 'paused' : record.openCall ? 'model' : record.openCapability ? 'capability' : 'preparing';
      record.feedback = { at: this.now.getTime() - lastAt >= FEEDBACK.maxMs - 5000 ? this.now.toISOString() : record.feedback.at, phase };
      if (phase === 'capability') record.feedback.capabilityId = record.openCapability.capability?.id;
      this.put('episodes', record);
    }
  }
  append(episode, kind, data) {
    // Call proof/publication events are emitted only by their transactional methods.
    if (['call_started', 'call_output', 'call_failed', 'capability_created', 'capability_finalized', 'output_published', 'presentation_published'].includes(kind)) fail('INVALID_REQUEST');
    const p = this.own(episode);
    const record = this.one('episodes', this.episodeScope(episode), ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running') fail('STALE');
    const experience = recordCapabilityExperience(p.capabilityExperience, record, kind, data, this.now.toISOString());
    if (experience) p.capabilityExperience = experience;
    if (kind === 'execution_goal') { record.executionGoal = data.goal; this.put('episodes', record); }
    p.writeSerial++; this.put('persons', p);
    return this.trace(episode.ownerId, episode.id, kind, data);
  }
  startCall(episode, data) {
    identifier(data.callId);
    const p = this.own(episode), scope = this.episodeScope(episode);
    const record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running' || record.openCall || record.openCapability ||
        this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.callId') = ? AND json_extract(record, '$.kind') IN ('call_started', 'capability_started')", [episode.id, data.callId])) fail('STALE');
    p.writeSerial++; this.put('persons', p);
    record.openCall = { callId: data.callId, requested: data.requested, effective: data.effective, ...(data.manifest ? { manifest: data.manifest } : {}) };
    this.put('episodes', record);
    return this.trace(episode.ownerId, episode.id, 'call_started', data);
  }
  finalizeCall(episode, { callId, effective, output, requestElapsedMs, code = null }) {
    const scope = this.episodeScope(episode), record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.workerId !== episode.workerId || record.epoch !== episode.epoch || record.openCall?.callId !== callId) return false;
    const live = record.status === 'running' && Boolean(this.fenced(episode));
    const draining = record.status === 'cancelled' && record.callFinalizeUntil > this.now;
    if (!live && !draining) return false;
    const failed = Boolean(code || !live || !output || output.complete === false || output.accepted === false || output.toolCallsTruncated === true),
      terminalCode = !live ? 'CANCELLED' : code || 'INTERRUPTED';
    const call = record.openCall;
    const safeEffective = { model: call.requested.model, effort: typeof effective?.effort === 'string' && effective.effort.length <= 128 ? effective.effort : null,
      effortObserved: effective?.effortObserved === true };
    if (typeof effective?.wireMode === 'string' && effective.wireMode.length <= 128) safeEffective.wireMode = effective.wireMode;
    delete record.openCall; delete record.callFinalizeUntil; this.put('episodes', record);
    this.trace(episode.ownerId, episode.id, failed ? 'call_failed' : 'call_output', {
      callId, requested: call.requested, effective: safeEffective, output: publicOutput(output, failed),
      // Actual provider time excludes any pause between journal start and dispatch.
      ...(Number.isSafeInteger(requestElapsedMs) && requestElapsedMs >= 0 ? { requestElapsedMs } : {}),
      ...(!failed && call.manifest ? { manifest: call.manifest } : {}), ...(failed ? { code: new PersonError(terminalCode).code } : {}),
    });
    return live;
  }
  callProof(scope, episodeId, callId) {
    return this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'call_output' AND json_extract(record, '$.callId') = ? AND json_extract(record, '$.output.complete') = 1", [episodeId, callId]);
  }
  /** Recheck the original transactional slot and its request proof at publication.
   * Legacy scalar APIs remain supported only for legacy complete call outputs. */
  capabilityProof(scope, episodeId, started) {
    if (!started || started.invocationHash !== digest(started.capability)) return null;
    const proof = this.callProof(scope, episodeId, started.modelCallId ?? started.callId);
    if (!proof) return null;
    const original = this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'capability_started' AND json_extract(record, '$.callId') = ? ORDER BY seq ASC", [episodeId, started.callId]);
    if (!original || !isDeepStrictEqual(original.capability, started.capability) ||
        ['modelCallId', 'toolUseId', 'toolIndex'].some(key => original[key] !== started[key])) return null;
    if (proof.output.protocol === 'native-tools') return nativeInvocationMatches(proof.output, started, { executable: true }) ? proof : null;
    return started.modelCallId === undefined && started.toolUseId === undefined && started.toolIndex === undefined && !proof.output.protocol ? proof : null;
  }
  startCapability(episode, data) {
    identifier(data.callId);
    if (data.modelCallId !== undefined) identifier(data.modelCallId);
    if (!data.capability || typeof data.capability.id !== 'string' || !data.capability.args || typeof data.capability.args !== 'object') fail('INVALID_REQUEST');
    const p = this.own(episode), scope = this.episodeScope(episode);
    const record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    const proof = this.callProof(scope, episode.id, data.modelCallId ?? data.callId);
    if (!record || record.status !== 'running' || record.openCall || record.openCapability || !proof) fail('STALE');
    const native = proof.output.protocol === 'native-tools';
    if (native ? !data.modelCallId || data.callId === data.modelCallId || !nativeInvocationMatches(proof.output, data)
      : proof.output.protocol || data.modelCallId !== undefined || data.toolUseId !== undefined || data.toolIndex !== undefined) fail('STALE');
    const prior = this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'capability_started' AND (json_extract(record, '$.callId') = ? OR (? = 1 AND json_extract(record, '$.modelCallId') = ? AND (json_extract(record, '$.toolUseId') = ? OR json_extract(record, '$.toolIndex') = ?)))",
      [episode.id, data.callId, Number(native), data.modelCallId ?? null, data.toolUseId ?? null, data.toolIndex ?? null]);
    if (prior || (native && this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'call_started' AND json_extract(record, '$.callId') = ?", [episode.id, data.callId]))) fail('STALE');
    const started = { callId: data.callId, capability: data.capability,
      ...(native ? { modelCallId: data.modelCallId, toolUseId: data.toolUseId, toolIndex: data.toolIndex } : {}),
      ...(data.capabilityManifest ? { capabilityManifest: data.capabilityManifest } : {}), ...(data.access ? { access: data.access } : {}) };
    record.openCapability = { ...started, invocationHash: digest(started.capability) };
    this.put('episodes', record);
    p.writeSerial++; this.put('persons', p);
    return this.trace(episode.ownerId, episode.id, 'capability_started', started);
  }
  /** Original started invocation only; consuming this slot never restores cognitive authority. */
  finalizeCapability(episode, { callId, capability, result, code = null, terminalCode = null }) {
    const scope = this.episodeScope(episode), record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.workerId !== episode.workerId || record.epoch !== episode.epoch ||
        record.baseStateVersion !== episode.baseStateVersion || record.controlVersion !== episode.controlVersion || record.inputWatermark !== episode.inputWatermark ||
        record.openCapability?.callId !== callId || record.openCapability.invocationHash !== digest(capability) ||
        !['running', 'cancelled', 'interrupted', 'failed'].includes(record.status)) return false;
    const p = record.status === 'running' && this.fenced(episode);
    const live = Boolean(p && !terminalCode);
    const started = record.openCapability;
    const failed = Boolean(code || result?.ok === false);
    const outcome = failed ? 'capability_failed' : 'capability_result';
    const data = { callId, ...(started.modelCallId !== undefined ? { modelCallId: started.modelCallId, toolUseId: started.toolUseId, toolIndex: started.toolIndex } : {}), ...(started.capabilityManifest ? { capabilityManifest: started.capabilityManifest } : {}),
      ...(failed ? { capabilityId: started.capability.id, code: code || result.code } : { capability: started.capability }),
      ...(result !== undefined ? { result } : {}) };
    if (live && started.capability.id === 'Execution.goal' && result?.ok === true) record.executionGoal = result.goal;
    delete record.openCapability; this.put('episodes', record);
    if (live) {
      const experience = recordCapabilityExperience(p.capabilityExperience, record, outcome, data, this.now.toISOString());
      if (experience) { p.capabilityExperience = experience; this.put('persons', p); }
    }
    this.trace(episode.ownerId, episode.id, live ? outcome : 'capability_finalized', { ...data,
      ...(!live ? { capability: started.capability, workerId: record.workerId, outcome, afterTerminal: true, accepted: false,
        terminalCode: terminalCode || record.terminalCode || 'STALE' } : {}) });
    return live;
  }
  /** Exact scoped read in one read transaction; historical evidence grants no lease,
   * publication, capability activation or current behavioral authority. */
  checkExecutionRead(episode, episodeId = episode.id) {
    this.own(episode);
    const scope = this.episodeScope(episode), live = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!live || live.status !== 'running' || live.epoch !== episode.epoch || live.workerId !== episode.workerId) fail('STALE');
    if (!this.one('episodes', scope, ' AND id = ?', [episodeId])) fail('NOT_FOUND');
    return true;
  }
  executionRead(episode, args) {
    const request = executionReadRequest(args);
    this.checkExecutionRead(episode, request.episodeId);
    const scope = this.episodeScope(episode), episodeId = request.episodeId ?? episode.id;
    if (request.sourceRef !== undefined) fail('INVALID_REQUEST');
    const trace = this.one('traces', scope,
      " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.callId') = ? AND (json_extract(record, '$.kind') IN ('capability_result', 'capability_failed') OR (json_extract(record, '$.kind') = 'capability_finalized' AND json_extract(record, '$.outcome') IN ('capability_result', 'capability_failed'))) ORDER BY seq DESC", [episodeId, request.callId]);
    if (!trace) fail('NOT_FOUND');
    const started = this.one('traces', scope,
      " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.callId') = ? AND json_extract(record, '$.kind') = 'capability_started' ORDER BY seq ASC", [episodeId, request.callId]);
    return executionEvidencePage(trace, started, request, episode.id);
  }
  createdCapabilities(episode) {
    this.own(episode);
    return this.rows('created_capabilities', this.episodeScope(episode), ' ORDER BY id ASC LIMIT 32').map(publicDoc);
  }
  saveCreatedCapability(episode, input) {
    const { definition, evidence, callId } = validateCreatedCapability(input);
    this.own(episode);
    const scope = this.episodeScope(episode), active = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!active || active.status !== 'running' || active.epoch !== episode.epoch || active.workerId !== episode.workerId) fail('STALE');
    const started = active.openCapability;
    const proof = started?.callId === callId ? this.capabilityProof(scope, episode.id, started) : this.callProof(scope, episode.id, callId);
    if (!proof || active.openCall || (started ? started.callId !== callId || started.capability.id !== 'Capability.create' ||
        !isDeepStrictEqual(started.capability.args, definition) : proof.output.protocol)) fail('INVALID_REQUEST');
    const current = this.one('created_capabilities', scope, ' AND id = ?', [definition.id]);
    if ((current?.version ?? 0) !== definition.expectedVersion) fail('STALE');
    if (definition.expectedVersion >= CREATED_CAPABILITY_LIMITS.versions || (!current &&
        this.sql(`SELECT count(*) AS n FROM created_capabilities WHERE ${SCOPE}`).get(...scopeValues(scope)).n >= CREATED_CAPABILITY_LIMITS.ids)) fail('CONTEXT_LIMIT');
    const record = this.doc(scope, createdCapabilityRecord(definition, evidence, { episode, callId, now: this.now }));
    this.put('created_capability_revisions', record, true);
    this.put('created_capabilities', record);
    this.trace(episode.ownerId, episode.id, 'capability_created', { callId, capabilityId: record.id,
      capabilityManifest: { id: record.id, version: record.version, revision: record.revision }, evidence: record.evidence });
    return publicDoc(record);
  }
  focused(scope, ids) {
    return ids.map(id => this.one('concepts', scope, ' AND id = ?', [id])).filter(Boolean);
  }
  context(episode) {
    const p = this.own(episode), scope = this.episodeScope(episode), state = this.one('states', scope);
    const focused = this.focused(scope, state.focusConceptIds.slice(0, 12));
    const latestUser = this.one('messages', scope, " AND json_extract(record, '$.role') = 'user' ORDER BY seq DESC");
    const dream = episode.kind === 'dream', recentLimit = dream ? 6 : 12;
    const recent = this.rows('concepts', scope, ` ORDER BY updatedAt DESC, id ASC LIMIT ${recentLimit}`);
    let messages = dream ? [] : this.rows('messages', scope, ' ORDER BY seq DESC LIMIT 12');
    let older = [], olderMessages = [];
    if (dream) {
      // Rotate complete records, not LLM summaries or random full-database loads.
      // SQL counts/offsets may scan indexes; only the small selected pages are decoded.
      // inputWatermark advances on admission, including episodes that never commit.
      const rotation = Math.max(0, episode.inputWatermark - 1);
      const recentUsers = this.rows('messages', scope, " AND json_extract(record, '$.role') = 'user' ORDER BY seq DESC LIMIT 6");
      const boundary = recentUsers.at(-1)?.seq ?? 0;
      const userClause = " AND json_extract(record, '$.role') = 'user' AND seq < ?";
      const count = this.sql(`SELECT count(*) AS n FROM messages WHERE ${SCOPE}${userClause}`).get(...scopeValues(scope), boundary).n;
      if (count) {
        const offset = rotation * 4 % count;
        olderMessages = this.rows('messages', scope, `${userClause} ORDER BY seq ASC LIMIT 4 OFFSET ?`, [boundary, offset]);
        if (olderMessages.length < Math.min(4, count)) olderMessages.push(...this.rows('messages', scope,
          `${userClause} ORDER BY seq ASC LIMIT ?`, [boundary, Math.min(4, count) - olderMessages.length]));
      }
      // Assistant progress is not evidence of user interests. Keep at most two
      // substantive replies for conversational grounding, independent of progress volume.
      const replies = this.rows('messages', scope,
        " AND json_extract(record, '$.role') = 'assistant' AND coalesce(json_extract(record, '$.replyKind'), '') != 'progress' ORDER BY seq DESC LIMIT 2");
      messages = [...recentUsers, ...olderMessages, ...replies];
      const excluded = [...new Set([...focused, ...recent].map(c => c.id))];
      const exclusion = excluded.length ? ` AND id NOT IN (${excluded.map(() => '?').join(',')})` : '';
      for (const kind of ['claim', 'question', 'method', 'self-model', 'scenario', 'interest']) {
        const clause = ` AND json_extract(record, '$.kind') = ?${exclusion}`;
        const params = [kind, ...excluded];
        const total = this.sql(`SELECT count(*) AS n FROM concepts WHERE ${SCOPE}${clause}`).get(...scopeValues(scope), ...params).n;
        if (total) older.push(...this.rows('concepts', scope, `${clause} ORDER BY updatedAt ASC, id ASC LIMIT 1 OFFSET ?`, [...params, rotation % total]));
      }
    }
    // A long assistant progress stream must never erase the newest user stop or
    // prohibition. Runtime also receives it separately for mandatory admission.
    if (latestUser && !messages.some(m => m.id === latestUser.id)) messages = [...messages.slice(0, 11), latestUser];
    messages.sort((a, b) => a.seq - b.seq);
    return { person: this.personView(p), capabilityExperience: capabilityExperienceView(p.capabilityExperience),
      state: stateView(state), latestUserInstruction: messageView(latestUser), messages: messages.map(messageView),
      concepts: [...new Map([...focused, ...recent, ...older].map(c => [c.id, conceptView(c)])).values()],
      contextSelection: { strategy: dream ? 'dream-diverse' : 'recent', rotation: dream ? episode.inputWatermark - 1 : null,
        limits: { messages: 12, focusedConcepts: 12, recentConcepts: recentLimit, olderConcepts: dream ? 6 : 0 },
        recentUserMessageRefs: dream ? messages.filter(m => m.role === 'user' && !olderMessages.some(old => old.id === m.id)).map(m => `message:${m.id}:${m.revision}`) : [],
        olderUserMessageRefs: olderMessages.map(m => `message:${m.id}:${m.revision}`),
        focusedConceptRefs: focused.map(c => `concept:${c.id}:${c.revision}`), recentConceptRefs: recent.map(c => `concept:${c.id}:${c.revision}`),
        olderConceptRefs: older.map(c => `concept:${c.id}:${c.revision}`) } };
  }
  /** Atomic capability publication: exact started invocation + live lease, never
   * publishProgress's no-open-capability path. JSON carries the canonical payload;
   * text remains the searchable/model/legacy fallback. phase is delivery intent. */
  savePresentation(episode, { callId, args }) {
    identifier(callId);
    const presentation = personPresentation(args);
    const p = this.own(episode), scope = this.episodeScope(episode);
    const record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    const invocationHash = digest({ id: 'PresentResponse', args });
    const prior = this.rows('messages', scope, " AND json_extract(record, '$.episodeId') = ? AND json_type(record, '$.presentation') = 'object'", [episode.id]);
    const receipt = this.one('traces', scope,
      " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'presentation_published' AND json_extract(record, '$.callId') = ?", [episode.id, callId]);
    if (receipt) {
      if (receipt.invocationHash !== invocationHash) fail('INVALID_REQUEST');
      const message = prior.find(m => m.id === receipt.messageId);
      if (!message) fail('STORAGE_UNAVAILABLE');
      return messageView(message);
    }
    const proof = this.capabilityProof(scope, episode.id, record?.openCapability);
    if (!record || record.status !== 'running' || record.openCall || !proof || record.openCapability?.callId !== callId ||
        record.openCapability.invocationHash !== invocationHash) fail('STALE');
    // Repeating an identical delivery in this episode adds no new visible answer.
    const repeated = prior.find(m => digest(m.presentation) === digest(presentation)) ??
      (episode.kind === 'autonomous' ? this.rows('messages', scope,
        " AND json_type(record, '$.presentation') = 'object' ORDER BY seq DESC LIMIT 32")
        .find(m => digest(m.presentation) === digest(presentation)) : null);
    if (repeated) {
      this.trace(episode.ownerId, episode.id, 'presentation_published', { callId, invocationHash, messageId: repeated.id, phase: presentation.phase, duplicate: true });
      return messageView(repeated);
    }
    p.messageSeq++; p.writeSerial++; this.put('persons', p);
    const message = this.doc(scope, { id: randomUUID(), revision: 1, seq: p.messageSeq, episodeId: episode.id,
      callId, publicationHash: invocationHash, replyKind: 'presentation', role: 'assistant',
      text: presentation.summary, presentation, createdAt: this.now });
    this.put('messages', message, true); this.journal(scope, 'messages', message);
    record.lastReplyAt = this.now.toISOString(); delete record.feedback; this.put('episodes', record);
    this.trace(episode.ownerId, episode.id, 'presentation_published', { callId, invocationHash, messageId: message.id, phase: presentation.phase });
    return messageView(message);
  }
  repeatsAutonomousReply(scope, episode, reply) {
    return episode.kind === 'autonomous' && typeof reply === 'string' &&
      this.rows('messages', scope, " AND json_extract(record, '$.role') = 'assistant' ORDER BY seq DESC LIMIT 32")
        .some(message => message.text.trim() === reply.trim());
  }
  repeatsPresentation(scope, episodeId, reply) {
    return typeof reply === 'string' && this.rows('messages', scope,
      " AND json_extract(record, '$.episodeId') = ? AND json_type(record, '$.presentation') = 'object'", [episodeId])
      .some(message => message.text.trim() === reply.trim());
  }
  /** Publish only a validated, complete call's reply. This is communication, not
   * a state/Concept commit. Fencing, dedupe and the memory journal share one transaction. */
  publishProgress(episode, { callId, reply, final = false }) {
    const p = this.own(episode), scope = this.episodeScope(episode);
    identifier(callId); text(reply, LIMITS.outputBytes);
    if (typeof final !== 'boolean') fail('INVALID_REQUEST');
    const record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running' || record.openCall || record.openCapability) fail('STALE');
    const prior = this.rows('messages', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.replyKind') IN ('progress', 'execution-final')", [episode.id]);
    const duplicate = prior.find(m => m.callId === callId);
    if (duplicate) { if (duplicate.text !== reply) fail('INVALID_REQUEST'); return messageView(duplicate); }
    const proof = this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'call_output' AND json_extract(record, '$.callId') = ? AND json_extract(record, '$.output.complete') = 1", [episode.id, callId]);
    if (proof?.output?.protocol === 'native-tools') {
      if (proof.output.text !== reply || (final && (proof.output.stopReason !== 'end_turn' || proof.output.toolCalls?.length))) fail('INVALID_REQUEST');
    } else {
      if (final) fail('INVALID_REQUEST');
      const accepted = this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'activity' AND json_extract(record, '$.callId') = ? AND json_extract(record, '$.disposition') = 'candidate'", [episode.id, callId]);
      let proposal;
      try { proposal = JSON.parse(proof?.output?.text); } catch { fail('INVALID_REQUEST'); }
      if (!accepted || !proposal.next || proposal.reply !== reply) fail('INVALID_REQUEST');
    }
    // A final duplicate is already delivered. Preserve its identity so final
    // cognition does not interpret dedupe as a missing public result.
    const sameReply = prior.find(m => m.text.trim() === reply.trim());
    if (final && sameReply) return messageView(sameReply);
    if (final && this.repeatsAutonomousReply(scope, episode, reply)) {
      return messageView(this.rows('messages', scope, " AND json_extract(record, '$.role') = 'assistant' ORDER BY seq DESC LIMIT 32").find(message => message.text.trim() === reply.trim()));
    }
    // Provider latency counts too: a call started before 30s can finish after it.
    if ((!final && this.now.getTime() - new Date(record.lastReplyAt ?? record.createdAt).getTime() < FEEDBACK.minMs) ||
        sameReply || this.repeatsAutonomousReply(scope, episode, reply) || this.repeatsPresentation(scope, episode.id, reply)) return null;
    p.messageSeq++; p.writeSerial++; this.put('persons', p);
    const message = this.doc(scope, { id: randomUUID(), revision: 1, seq: p.messageSeq, episodeId: episode.id,
      callId, replyKind: final ? 'execution-final' : 'progress', role: 'assistant', text: reply, createdAt: this.now });
    this.put('messages', message, true); this.journal(scope, 'messages', message);
    record.lastReplyAt = this.now.toISOString(); delete record.feedback; this.put('episodes', record);
    this.trace(episode.ownerId, episode.id, 'progress_reply', { callId, messageId: message.id });
    return messageView(message);
  }
  commit(episode, proposal, selection, callId, reportedSources = new Map()) {
    const p = this.own(episode), scope = this.episodeScope(episode);
    if (proposal.baseStateVersion !== episode.baseStateVersion) fail('STALE');
    const repeatsExecutionReply = proposal.reply && this.rows('messages', scope,
      " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.replyKind') IN ('progress', 'execution-final')", [episode.id])
      .some(message => message.text.trim() === proposal.reply.trim());
    const publishReply = proposal.reply && !this.repeatsAutonomousReply(scope, episode, proposal.reply) && !repeatsExecutionReply && !this.repeatsPresentation(scope, episode.id, proposal.reply);
    p.stateVersion++; p.writeSerial++; if (publishReply) p.messageSeq++;
    p.activeEpisodeId = null; p.leaseOwner = null; p.leaseUntil = new Date(0);
    this.put('persons', p);
    const revisions = [];
    for (const patch of proposal.concepts) {
      const { expectedRevision, ...fields } = patch, reportedSourceRefs = reportedSources.get(patch.id) ?? [];
      if (patch.epistemicState === 'reported' && !reportedSourceRefs.length) fail('INVALID_PROPOSAL');
      const current = this.one('concepts', scope, ' AND id = ?', [patch.id]);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (current?.revision ?? 0) !== expectedRevision) fail('STALE');
      const record = this.doc(scope, { ...fields, reportedSourceRefs, revision: expectedRevision + 1, episodeId: episode.id, callId, stateVersion: p.stateVersion, updatedAt: this.now });
      this.put('concepts', record); this.put('concept_revisions', record, true); this.journal(scope, 'concepts', record);
      revisions.push({ id: patch.id, revision: record.revision });
    }
    const focus = this.focused(scope, proposal.state.focusConceptIds);
    if (new Set(proposal.state.focusConceptIds).size !== proposal.state.focusConceptIds.length || focus.length !== proposal.state.focusConceptIds.length) fail('STALE');
    const priorState = this.one('states', scope);
    const continuation = Object.hasOwn(proposal.state, 'continuation') ? proposal.state.continuation : priorState?.continuation;
    const understanding = Object.hasOwn(proposal.state, 'understanding') ? proposal.state.understanding : priorState?.understanding;
    const state = this.doc(scope, { ...proposal.state, ...(continuation !== undefined ? { continuation } : {}),
      ...(understanding !== undefined ? { understanding } : {}), version: p.stateVersion, conceptRefs: focus.map(c => ({ id: c.id, revision: c.revision })),
      decision: proposal.decision, lastSelection: { model: selection.model, effort: selection.effort }, updatedAt: this.now, episodeId: episode.id });
    if (this.one('states', scope)?.version !== episode.baseStateVersion) fail('STALE');
    this.put('states', state);
    if (episode.kind === 'autonomous' && p.autonomy?.generation === episode.autonomyGeneration) {
      p.autonomy.lastFingerprint = digest(continuation ?? null); this.put('persons', p);
    }
    this.put('state_commits', this.doc(scope, { id: randomUUID(), version: p.stateVersion, parentVersion: episode.baseStateVersion,
      episodeId: episode.id, callId, conceptRevisions: revisions, state: stateView(state), createdAt: this.now }), true);
    if (publishReply) {
      const message = this.doc(scope, { id: randomUUID(), revision: 1, seq: p.messageSeq, episodeId: episode.id, callId, replyKind: 'final', role: 'assistant', text: proposal.reply, createdAt: this.now });
      this.put('messages', message, true); this.journal(scope, 'messages', message);
    }
    const record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running') fail('STALE');
    delete record.executionControl;
    Object.assign(record, { status: 'completed', endedAt: this.now, stateVersion: p.stateVersion }); this.put('episodes', record);
    this.trace(episode.ownerId, episode.id, 'committed', { callId, parentVersion: episode.baseStateVersion, stateVersion: p.stateVersion, conceptRevisions: revisions, decision: proposal.decision });
    return { state: stateView(state) };
  }
  finish(episode, status, code) {
    const p = this.fenced(episode, false);
    if (!p) return false;
    p.writeSerial++; p.epoch++; p.activeEpisodeId = null; p.leaseOwner = null; p.leaseUntil = new Date(0); this.put('persons', p);
    const record = this.one('episodes', this.episodeScope(episode), ' AND id = ?', [episode.id]);
    if (record?.status === 'running') {
      delete record.executionControl;
      Object.assign(record, { status, terminalCode: code, endedAt: this.now }); this.put('episodes', record); this.abandonCall(episode.ownerId, record, code);
    }
    this.trace(episode.ownerId, episode.id, status, { code, baseStateVersion: episode.baseStateVersion });
    return true;
  }
  cancel(ownerId, episodeId = null) {
    const scope = this.scope(ownerId), p = this.getPerson(ownerId);
    // Cancel is also a durable autonomy stop, even when the target already ended.
    p.settings = { ...p.settings, autonomyEnabled: false };
    p.autonomy = { version: 1, generation: randomUUID(), pending: [], nextAt: null };
    p.writeSerial++; this.put('persons', p);
    if (!p.activeEpisodeId) return { cancelled: false, episodeId };
    if (episodeId && p.activeEpisodeId !== episodeId) {
      const active = this.one('episodes', scope, ' AND id = ?', [p.activeEpisodeId]);
      if (active?.kind !== 'autonomous') return { cancelled: false, episodeId };
      // The target may finish just before a queued autonomous admission. Cancel
      // that follow-up too; never let a stale target bypass the owner's stop.
    }
    const id = p.activeEpisodeId, until = p.leaseUntil;
    p.epoch++; p.controlVersion++; p.writeSerial++; p.activeEpisodeId = null; p.leaseOwner = null; p.leaseUntil = new Date(0); this.put('persons', p);
    const record = this.one('episodes', scope, ' AND id = ?', [id]);
    if (record?.status === 'running') {
      delete record.executionControl;
      Object.assign(record, { status: 'cancelled', terminalCode: 'CANCELLED', endedAt: this.now, callFinalizeUntil: until }); this.put('episodes', record);
    }
    this.trace(ownerId, id, 'cancelled', { code: 'CANCELLED' });
    return { cancelled: true, episodeId: id };
  }
  settings(ownerId, settings, expectedControlVersion, expectedAutonomyGeneration) {
    const p = this.getPerson(ownerId);
    const autonomyOnly = Object.keys(settings).length === 1 && Object.hasOwn(settings, 'autonomyEnabled');
    if (p.activeEpisodeId && !autonomyOnly) fail('BUSY');
    if (expectedAutonomyGeneration !== undefined && (p.autonomy?.generation ?? null) !== expectedAutonomyGeneration) fail('STALE');
    if (Object.hasOwn(settings, 'autonomyEnabled')) {
      if (typeof settings.autonomyEnabled !== 'boolean') fail('INVALID_REQUEST');
      p.autonomy = { version: 1, generation: randomUUID(), pending: [], backoffMs: 60000,
        nextAt: settings.autonomyEnabled ? this.now.getTime() + 5000 : null };
    }
    if (expectedControlVersion !== undefined && p.controlVersion !== expectedControlVersion) fail('STALE');
    const { name, ...patch } = settings;
    if (Object.hasOwn(settings, 'name')) p.name = personName(name);
    // A partial update must preserve durable fields omitted from the public view.
    p.settings = { ...p.settings, ...patch }; if (!autonomyOnly) p.controlVersion++; p.writeSerial++; this.put('persons', p);
    if (Object.keys(settings).length) this.trace(ownerId, null, 'settings', { settings: settingsView(p.settings), ...(name !== undefined ? { name: p.name } : {}) });
    return { settings: settingsView(p.settings), person: this.personView(p) };
  }
  inspect(ownerId, options, nativeToolIds) {
    const { section, cursor, limit } = inspectRequest(options);
    this.getPerson(ownerId);
    const scope = this.scope(ownerId);
    if (section === 'skills') return inspectCapabilities(this.rows('created_capabilities', scope, ' ORDER BY id ASC LIMIT 32'), { cursor, limit }, nativeToolIds);
    const boundary = inspectionCursor(cursor, section);
    if (boundary?.legacy) {
      const records = this.rows('concepts', scope, ' AND id > ? ORDER BY id ASC LIMIT ?', [boundary.id, limit + 1]);
      return inspectionPage(records, limit, 'id', conceptView);
    }
    const records = this.rows('concepts', scope,
      ' AND (? IS NULL OR updatedAt < ? OR (updatedAt = ? AND id > ?)) ORDER BY updatedAt DESC, id ASC LIMIT ?',
      [boundary?.time ?? null, boundary?.time ?? null, boundary?.time ?? null, boundary?.id ?? null, limit + 1]);
    return inspectionPage(records, limit, record => chronologicalCursor(section, record), conceptView);
  }
  search(ownerId, options) {
    const { query, cursor, limit } = searchRequest(options);
    this.getPerson(ownerId);
    const records = this.rows('messages', this.scope(ownerId),
      ' AND (? IS NULL OR seq < ?) AND instr(text, ?) > 0 ORDER BY seq DESC LIMIT ?', [cursor, cursor, query.toLowerCase(), limit + 1]);
    return inspectionPage(records, limit, 'seq', messageView, LIMITS.responseBytes);
  }
  turns(ownerId, options = {}) {
    const { cursor, limit } = turnsPage(options);
    const scope = this.scope(ownerId);
    if (!this.sql(`SELECT 1 FROM persons WHERE ${SCOPE}`).get(...scopeValues(scope))) fail('NOT_OPEN');
    const project = fields => `json_object(${Object.entries(fields).map(([key, path]) => `'${key}', CASE json_type(record, '$.${path}')
      WHEN 'text' THEN substr(json_extract(record, '$.${path}'), 1, 1000)
      WHEN 'integer' THEN json_extract(record, '$.${path}') WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE NULL END`).join(', ')})`;
    const episodes = this.sql(`SELECT ${project({ id: 'id', seq: 'inputWatermark', kind: 'kind', status: 'status', createdAt: 'createdAt', endedAt: 'endedAt', terminalCode: 'terminalCode', controlStatus: 'executionControl.status', calls: 'budget.calls', timeoutMs: 'budget.timeoutMs' })} AS metadata
      FROM episodes WHERE ${SCOPE} AND (? IS NULL OR inputWatermark < ?) ORDER BY inputWatermark DESC LIMIT ?`)
      .all(...scopeValues(scope), cursor, cursor, limit + 1).map(row => JSON.parse(row.metadata));
    const fields = { kind: 'kind', callId: 'callId', modelCallId: 'modelCallId', toolUseId: 'toolUseId', toolIndex: 'toolIndex',
      protocol: 'output.protocol', callIndex: 'callIndex', createdAt: 'createdAt',
      requestedModel: 'requested.model', requestedEffort: 'requested.effort', effectiveEffort: 'effective.effort', effortObserved: 'effective.effortObserved',
      selectionOrigin: 'selectionOrigin', reason: 'reason', code: 'code', terminalCode: 'terminalCode', outcome: 'outcome',
      contextBytes: 'manifest.contextBytes', contextBudgetBytes: 'manifest.contextBudgetBytes', outputTokensReserved: 'manifest.outputTokensReserved' };
    // Never project a whole manifest/contextSources object: even malformed legacy
    // records must not transfer arbitrary strings, refs or private nested data.
    const number = (path, max = Number.MAX_SAFE_INTEGER) => `CASE WHEN json_type(record, '$.${path}') = 'integer'
      AND json_extract(record, '$.${path}') BETWEEN 0 AND ${max} THEN json_extract(record, '$.${path}') ELSE NULL END`;
    const contextMetadata = Object.entries({ contextWindowTokens: ['manifest.contextWindowTokens'], imageTokensReserved: ['manifest.imageTokensReserved'],
      envelopeTokensReserved: ['manifest.envelopeTokensReserved'], recentMessages: ['manifest.contextSources.recentMessages', 12],
      recentConcepts: ['manifest.contextSources.recentConcepts', 24], omittedMessages: ['manifest.contextSources.omittedMessages', 12],
      omittedConcepts: ['manifest.contextSources.omittedConcepts', 24], recallCount: ['manifest.contextSources.recall.count', 5] })
      .map(([key, args]) => `'${key}', ${number(...args)}`).join(', ');
    const recallKind = `CASE json_extract(record, '$.manifest.contextSources.recall.kind') WHEN 'messages' THEN 'messages' WHEN 'concepts' THEN 'concepts' ELSE NULL END`;
    const usage = `json_object(${TOKEN_FIELDS.map(key => `'${key}', ${number(`output.usage.${key}`)}`).join(', ')},
      'accountingVersion', ${number('output.usage.accountingVersion', 1)},
      'accountingIncomplete', json(CASE json_extract(record, '$.output.usage.accountingIncomplete') WHEN 1 THEN 'true' ELSE 'false' END),
      'cacheTokensAreIncludedInInput', json(CASE json_extract(record, '$.output.usage.cacheTokensAreIncludedInInput') WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END))`;
    const metadata = `${project(fields).slice(0, -1)}, 'capabilityId', substr(COALESCE(CASE WHEN json_type(record, '$.capability.id') = 'text' THEN json_extract(record, '$.capability.id') END, CASE WHEN json_type(record, '$.capabilityId') = 'text' THEN json_extract(record, '$.capabilityId') END), 1, 128),
      ${contextMetadata}, 'requestElapsedMs', ${number('requestElapsedMs')}, 'recallKind', ${recallKind}, 'usage', ${usage})`;
    const items = episodes.slice(0, limit).map(episode => {
      const starts = this.sql(`SELECT seq, ${number('callIndex')} AS callIndex FROM traces WHERE ${SCOPE} AND json_extract(record, '$.episodeId') = ?
        AND json_extract(record, '$.kind') = 'call_started' ORDER BY seq DESC LIMIT 33`)
        .all(...scopeValues(scope), episode.id);
      const oldest = starts[Math.min(starts.length, 32) - 1]?.seq ?? 0;
      // Tool fan-out must not evict the parent model lifecycle/usage. Both
      // projections remain bounded, and a shortened detail window is explicit.
      const eventWindow = kinds => this.sql(`SELECT seq, ${metadata} AS metadata FROM traces WHERE ${SCOPE} AND seq >= ?
        AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') IN (${kinds}) ORDER BY seq DESC LIMIT 257`)
        .all(...scopeValues(scope), oldest, episode.id);
      const modelEvents = eventWindow("'call_started', 'call_output', 'call_failed', 'proposal_rejected'");
      const toolEvents = eventWindow("'capability_started', 'capability_result', 'capability_failed', 'capability_finalized'");
      const events = [...modelEvents.slice(0, 256), ...toolEvents.slice(0, 256)].sort((a, b) => a.seq - b.seq).map(row => {
        const event = JSON.parse(row.metadata); event.effortObserved = event.effortObserved === 1; return event;
      });
      const callsTruncated = starts.length > 32 || modelEvents.length > 256;
      return { ...turnView(episode, events),
        loopCount: starts[0]?.callIndex != null ? starts[0].callIndex + 1 : starts.length > 32 ? null : starts.length,
        callsTruncated, callWindowLimit: 32, detailsTruncated: toolEvents.length > 256 || modelEvents.length > 256, detailWindowLimit: 256,
        usageScope: callsTruncated ? 'latest-call-window' : 'episode' };
    });
    return { items, nextCursor: episodes.length > limit ? items.at(-1).seq : null };
  }
  list(ownerId, collection, { cursor = null, limit = 20 } = {}, filter = {}) {
    if (!['messages', 'traces'].includes(collection)) fail('INVALID_REQUEST');
    this.getPerson(ownerId); boundedLimit(limit);
    if (Object.keys(filter).some(k => k !== 'query')) fail('INVALID_REQUEST');
    const query = filter.query ?? '';
    text(query, LIMITS.inputBytes, true);
    if (query && collection !== 'messages') fail('INVALID_REQUEST');
    let clause = '', params = [];
    if (cursor != null) { clause += ' AND seq < ?'; params.push(sequence(cursor)); }
    if (query) { clause += ' AND instr(text, ?) > 0'; params.push(query.toLowerCase()); }
    const docs = this.rows(collection, this.scope(ownerId), `${clause} ORDER BY seq DESC LIMIT ?`, [...params, limit + 1]);
    return inspectionPage(docs, limit, record => String(record.seq), collection === 'messages' ? messageView : publicDoc, LIMITS.responseBytes);
  }
  recall(ownerId, { kind = 'messages', query = '', cursor = null, limit = 5 } = {}) {
    memoryKind(kind); text(query, LIMITS.inputBytes, true); boundedLimit(limit);
    if (kind === 'messages') return this.list(ownerId, kind, { cursor, limit }, { query });
    this.getPerson(ownerId);
    if (cursor != null) text(cursor, 128);
    const docs = this.rows('concepts', this.scope(ownerId), ' AND (? IS NULL OR id > ?) AND instr(statement, ?) > 0 ORDER BY id ASC LIMIT ?', [cursor, cursor, query.toLowerCase(), limit + 1]);
    return { items: docs.slice(0, limit).map(conceptView), nextCursor: docs.length > limit ? docs[limit - 1].id : null };
  }
  checkOutputPublication(episode, { callId, args }) {
    outputArgs(args); this.own(episode);
    const scope = this.episodeScope(episode), active = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!active || active.status !== 'running' || active.openCall || active.openCapability?.callId !== callId ||
        active.openCapability.invocationHash !== digest({ id: 'Output.publish', args }) ||
        !this.capabilityProof(scope, episode.id, active.openCapability)) fail('STALE');
    return true;
  }
  saveOutput(episode, { callId, args, record, data }) {
    this.checkOutputPublication(episode, { callId, args });
    const scope = this.episodeScope(episode);
    objectOutput(record, data);
    // Recheck MIME against the invocation filename/bytes at the authority boundary.
    if ((record.kind === 'file' && (!Object.hasOwn(args, 'file_path') || outputMime(args.file_path, Buffer.from(data)) !== record.mimeType)) ||
        (record.kind === 'link' && (!Object.hasOwn(args, 'url') || outputUrl(args.url) !== record.url))) fail('INVALID_REQUEST');
    const totals = this.sql(`SELECT count(*) AS count, coalesce(sum(size), 0) AS size FROM outputs WHERE ${SCOPE}`).get(...scopeValues(scope));
    if (totals.count >= OUTPUT_LIMITS.personCount || totals.size + record.size > OUTPUT_LIMITS.personBytes) fail('OUTPUT_QUOTA');
    // Exactly one durable publication per started invocation, even before finalize.
    if (this.sql(`SELECT 1 FROM outputs WHERE ${SCOPE} AND episodeId = ? AND callId = ?`).get(...scopeValues(scope), episode.id, callId)) fail('STALE');
    const item = outputView({ ...record, id: randomUUID(), episodeId: episode.id, createdAt: this.now.toISOString() });
    this.sql('INSERT INTO outputs(namespace, ownerId, personId, id, episodeId, callId, size, record, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...scopeValues(scope), item.id, item.episodeId, callId, item.size, JSON.stringify(item), data == null ? null : Buffer.from(data));
    this.trace(episode.ownerId, episode.id, 'output_published', { callId, output: item });
    return item;
  }
  outputs(ownerId, options = {}) {
    const { cursor, limit } = outputsPage(options);
    this.getPerson(ownerId);
    const rows = this.sql(`SELECT seq, record FROM outputs WHERE ${SCOPE} AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`)
      .all(...scopeValues(this.scope(ownerId)), cursor, cursor, limit + 1);
    return { items: rows.slice(0, limit).map(row => outputView(JSON.parse(row.record))), nextCursor: rows.length > limit ? String(rows[limit - 1].seq) : null };
  }
  outputRead(ownerId, options) {
    const { outputId, offset, maxBytes } = outputReadRequest(options);
    this.getPerson(ownerId);
    const scope = this.scope(ownerId);
    const row = this.sql(`SELECT size, record FROM outputs WHERE ${SCOPE} AND id = ?`).get(...scopeValues(scope), outputId);
    if (!row) fail('NOT_FOUND');
    const item = outputView(JSON.parse(row.record));
    if (item.kind !== 'file') fail('OUTPUT_NOT_FILE');
    if (offset > row.size) fail('INVALID_REQUEST');
    // SQLite substr uses 1-based byte indices for BLOBs; never load the whole file.
    const chunk = this.sql(`SELECT substr(data, ?, ?) AS data FROM outputs WHERE ${SCOPE} AND id = ?`)
      .get(offset + 1, maxBytes, ...scopeValues(scope), outputId).data;
    const data = Buffer.from(chunk), nextOffset = offset + data.length;
    return { outputId, data: data.toString('base64'), offset, nextOffset, eof: nextOffset === row.size, totalBytes: row.size, mimeType: item.mimeType };
  }
  snapshot(ownerId) {
    this.recover(ownerId);
    const scope = this.scope(ownerId), p = this.getPerson(ownerId), state = this.one('states', scope);
    const messages = this.rows('messages', scope, ' ORDER BY seq DESC LIMIT 21');
    const messagePage = inspectionPage(messages, 20, record => String(record.seq), messageView, LIMITS.responseBytes);
    const episode = this.one('episodes', scope, ' ORDER BY inputWatermark DESC');
    const latestEpisode = episode ? { id: episode.id, status: episode.status, createdAt: episode.createdAt,
      ...(episode.status === 'running' && episode.feedback ? { feedback: episode.feedback } : {}),
      ...(episode.terminalCode ? { terminalCode: episode.terminalCode } : {}), ...(episode.endedAt ? { endedAt: episode.endedAt } : {}) } : null;
    return { latestEpisode, person: this.personView(p), state: stateView(state), concepts: this.focused(scope, state.focusConceptIds).slice(0, 12).map(conceptView),
      messages: messagePage.items.reverse(), nextMessagesCursor: messagePage.nextCursor,
      outputs: this.outputs(ownerId), busy: Boolean(p.activeEpisodeId), episodeId: p.activeEpisodeId };
  }
  searchChanges(ownerId, { after = 0, limit = 100 } = {}) {
    this.getPerson(ownerId); after = sequence(after); boundedLimit(limit, 1000);
    const rows = this.sql(`SELECT seq, kind, id, revision, record FROM memory_changes WHERE ${SCOPE} AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(...scopeValues(this.scope(ownerId)), after, limit + 1);
    const items = rows.slice(0, limit).map(row => ({ ...row,
      record: (row.kind === 'messages' ? messageView : conceptView)(decode(row, row.kind)) }));
    return { items, lastSeq: items.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }
  resolveMemories(ownerId, kind, refs) {
    memoryKind(kind); this.getPerson(ownerId);
    if (!Array.isArray(refs) || refs.length > 1000) fail('INVALID_REQUEST');
    const scope = this.scope(ownerId), records = [], seen = new Set();
    for (const ref of refs) {
      if (!ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) fail('INVALID_REQUEST');
      const record = this.one(kind, scope, ' AND id = ? AND revision = ?', [ref.id, ref.revision]);
      if (record && !seen.has(record.id)) { seen.add(record.id); records.push((kind === 'messages' ? messageView : conceptView)(record)); }
    }
    return records;
  }
  close() { this.db.close(); }
}
