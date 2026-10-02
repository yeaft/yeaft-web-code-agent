import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { bytes, digest, fail, identifier, LIMITS, PersonError, text } from './contracts.js';
import { CREATED_CAPABILITY_LIMITS, createdCapabilityRecord, validateCreatedCapability } from './created-capability-contract.js';
import { SCHEMA, TABLES } from './sqlite-schema.js';
import { capabilityExperienceView, recordCapabilityExperience } from './capability-experience.js';

const SCOPE = 'namespace = ? AND ownerId = ? AND personId = ?';
const scopeValues = s => [s.namespace, s.ownerId, s.personId];
// Query-only projections; record retains the original public Unicode text.
const SEARCH_COLUMNS = Object.freeze({ messages: 'text', concepts: 'statement' });
const dates = new Set(['createdAt', 'updatedAt', 'endedAt', 'leaseUntil', 'callFinalizeUntil']);
const decode = row => row ? JSON.parse(row.record, (key, value) => dates.has(key) && typeof value === 'string' ? new Date(value) : value) : null;
const publicDoc = doc => {
  if (!doc) return null;
  const { _id, ownerId, namespace, personId, ...rest } = doc;
  return rest;
};
const unavailableOutput = () => ({ text: '', retainedBytes: 0, observedBytes: null, complete: false, accepted: false, availability: 'unavailable', reason: 'worker-unavailable' });
const publicOutput = (output, failed) => {
  if (!output) return unavailableOutput();
  if (typeof output.text !== 'string' || bytes(output.text) > LIMITS.outputBytes) fail('OUTPUT_LIMIT');
  const retainedBytes = bytes(output.text), observedBytes = output.observedBytes ?? output.bytes ?? retainedBytes;
  if (!Number.isSafeInteger(observedBytes) || observedBytes < retainedBytes) fail('INVALID_REQUEST');
  const usage = output.usage ? {} : null;
  if (usage) for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (Number.isFinite(output.usage[key]) && output.usage[key] >= 0) usage[key] = output.usage[key];
  }
  const stopReason = typeof output.stopReason === 'string' && bytes(output.stopReason) <= 128 ? output.stopReason : null;
  return failed ? { text: output.text, retainedBytes, observedBytes, complete: false, accepted: false, availability: 'captured', usage, stopReason }
    : { text: output.text, bytes: retainedBytes, complete: true, usage, stopReason };
};
const READS = new Set(['getPerson', 'context', 'recall', 'list', 'searchChanges', 'resolveMemories', 'createdCapabilities']);
const WRITES = new Set(['open', 'recover', 'admit', 'heartbeat', 'append', 'startCall', 'finalizeCall', 'commit', 'finish', 'cancel', 'settings', 'snapshot', 'saveCreatedCapability']);
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
    const created = ['created_capabilities', 'created_capability_revisions'].includes(table);
    // Test JSON may itself have date-named keys; never revive those into Dates.
    return this.sql(`SELECT record FROM ${table} WHERE ${SCOPE}${clause}`).all(...scopeValues(scope), ...params)
      .map(row => created ? JSON.parse(row.record) : decode(row));
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
    return { id: p.personId, name: p.name, soul: p.soul, soulRevision: p.soulRevision, createdAt: p.createdAt.toISOString(), settings: p.settings };
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
        soulRevision: 1, createdAt: this.now, settings: { autonomyEnabled: false },
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
      this.put('persons', p);
      const episode = this.one('episodes', scope, ' AND id = ?', [id]);
      if (episode?.status === 'running') {
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
  admit(ownerId, { kind, text: input, clientMessageId, workerId, budget }) {
    if (!['send', 'think', 'dream'].includes(kind)) fail('INVALID_REQUEST');
    text(input, LIMITS.inputBytes, kind !== 'send'); identifier(clientMessageId); text(workerId, 256);
    this.recover(ownerId);
    const scope = this.scope(ownerId), requestHash = digest([kind, input]);
    const existing = this.one('episodes', scope, ' AND clientMessageId = ?', [clientMessageId]);
    if (existing) {
      if (existing.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
      return { episodeId: existing.id, duplicate: true, status: existing.status };
    }
    const p = this.getPerson(ownerId);
    if (p.activeEpisodeId) fail('BUSY');
    const id = randomUUID();
    p.activeEpisodeId = id; p.leaseOwner = workerId; p.leaseUntil = new Date(this.now.getTime() + this.leaseMs);
    p.epoch++; p.writeSerial++; p.inputWatermark++; if (kind === 'send') p.messageSeq++;
    this.put('persons', p);
    let messageId = null;
    if (kind === 'send') {
      messageId = randomUUID();
      const message = this.doc(scope, { id: messageId, revision: 1, seq: p.messageSeq, episodeId: id, role: 'user', text: input, createdAt: this.now, clientMessageId });
      this.put('messages', message, true); this.journal(scope, 'messages', message);
    }
    const episode = this.doc(scope, { id, clientMessageId, requestHash, kind, text: input, messageId, status: 'running', workerId, epoch: p.epoch,
      baseStateVersion: p.stateVersion, inputWatermark: p.inputWatermark, controlVersion: p.controlVersion, budget, createdAt: this.now });
    this.put('episodes', episode, true);
    this.trace(ownerId, id, 'accepted', { trigger: { kind, text: input, messageId }, baseStateVersion: p.stateVersion, budget });
    return { episodeId: id, duplicate: false, status: 'running', episode };
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
  heartbeat(episode) {
    const p = this.own(episode); p.leaseUntil = new Date(this.now.getTime() + this.leaseMs); p.writeSerial++; this.put('persons', p);
  }
  append(episode, kind, data) {
    // Call proof/publication events are emitted only by their transactional methods.
    if (['call_started', 'call_output', 'call_failed', 'capability_created'].includes(kind)) fail('INVALID_REQUEST');
    const p = this.own(episode);
    const record = this.one('episodes', this.episodeScope(episode), ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running') fail('STALE');
    const experience = recordCapabilityExperience(p.capabilityExperience, record, kind, data, this.now.toISOString());
    if (experience) p.capabilityExperience = experience;
    p.writeSerial++; this.put('persons', p);
    return this.trace(episode.ownerId, episode.id, kind, data);
  }
  startCall(episode, data) {
    const p = this.own(episode), scope = this.episodeScope(episode);
    const record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running' || record.openCall) fail('STALE');
    p.writeSerial++; this.put('persons', p);
    record.openCall = { callId: data.callId, requested: data.requested, effective: data.effective, ...(data.manifest ? { manifest: data.manifest } : {}) };
    this.put('episodes', record);
    return this.trace(episode.ownerId, episode.id, 'call_started', data);
  }
  finalizeCall(episode, { callId, effective, output, code = null }) {
    const scope = this.episodeScope(episode), record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.workerId !== episode.workerId || record.epoch !== episode.epoch || record.openCall?.callId !== callId) return false;
    const live = record.status === 'running' && Boolean(this.fenced(episode));
    const draining = record.status === 'cancelled' && record.callFinalizeUntil > this.now;
    if (!live && !draining) return false;
    const failed = Boolean(code || !live || !output), terminalCode = !live ? 'CANCELLED' : code || 'INTERRUPTED';
    const call = record.openCall;
    const safeEffective = { model: call.requested.model, effort: typeof effective?.effort === 'string' && effective.effort.length <= 128 ? effective.effort : null,
      effortObserved: effective?.effortObserved === true };
    if (typeof effective?.wireMode === 'string' && effective.wireMode.length <= 128) safeEffective.wireMode = effective.wireMode;
    delete record.openCall; delete record.callFinalizeUntil; this.put('episodes', record);
    this.trace(episode.ownerId, episode.id, failed ? 'call_failed' : 'call_output', {
      callId, requested: call.requested, effective: safeEffective, output: publicOutput(output, failed),
      ...(!failed && call.manifest ? { manifest: call.manifest } : {}), ...(failed ? { code: new PersonError(terminalCode).code } : {}),
    });
    return live;
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
    const proof = this.one('traces', scope, " AND json_extract(record, '$.episodeId') = ? AND json_extract(record, '$.kind') = 'call_output' AND json_extract(record, '$.callId') = ? AND json_extract(record, '$.output.complete') = 1", [episode.id, callId]);
    if (!proof || active.openCall?.callId === callId) fail('INVALID_REQUEST');
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
    const focused = this.focused(scope, state.focusConceptIds).slice(0, 12);
    const recent = this.rows('concepts', scope, ' ORDER BY updatedAt DESC, id ASC LIMIT 12');
    return { person: this.personView(p), capabilityExperience: capabilityExperienceView(p.capabilityExperience),
      state: publicDoc(state), messages: this.rows('messages', scope, ' ORDER BY seq DESC LIMIT 12').reverse().map(publicDoc),
      concepts: [...new Map([...focused, ...recent].map(c => [c.id, publicDoc(c)])).values()] };
  }
  commit(episode, proposal, selection, callId, reportedSources = new Map()) {
    const p = this.own(episode), scope = this.episodeScope(episode);
    if (proposal.baseStateVersion !== episode.baseStateVersion) fail('STALE');
    p.stateVersion++; p.writeSerial++; if (proposal.reply) p.messageSeq++;
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
    const state = this.doc(scope, { ...proposal.state, version: p.stateVersion, conceptRefs: focus.map(c => ({ id: c.id, revision: c.revision })),
      decision: proposal.decision, lastSelection: { model: selection.model, effort: selection.effort }, updatedAt: this.now, episodeId: episode.id });
    if (this.one('states', scope)?.version !== episode.baseStateVersion) fail('STALE');
    this.put('states', state);
    this.put('state_commits', this.doc(scope, { id: randomUUID(), version: p.stateVersion, parentVersion: episode.baseStateVersion,
      episodeId: episode.id, callId, conceptRevisions: revisions, state: publicDoc(state), createdAt: this.now }), true);
    if (proposal.reply) {
      const message = this.doc(scope, { id: randomUUID(), revision: 1, seq: p.messageSeq, episodeId: episode.id, role: 'assistant', text: proposal.reply, createdAt: this.now });
      this.put('messages', message, true); this.journal(scope, 'messages', message);
    }
    const record = this.one('episodes', scope, ' AND id = ?', [episode.id]);
    if (!record || record.status !== 'running') fail('STALE');
    Object.assign(record, { status: 'completed', endedAt: this.now, stateVersion: p.stateVersion }); this.put('episodes', record);
    this.trace(episode.ownerId, episode.id, 'committed', { callId, parentVersion: episode.baseStateVersion, stateVersion: p.stateVersion, conceptRevisions: revisions, decision: proposal.decision });
    return { state: publicDoc(state) };
  }
  finish(episode, status, code) {
    const p = this.fenced(episode, false);
    if (!p) return false;
    p.writeSerial++; p.epoch++; p.activeEpisodeId = null; p.leaseOwner = null; p.leaseUntil = new Date(0); this.put('persons', p);
    const record = this.one('episodes', this.episodeScope(episode), ' AND id = ?', [episode.id]);
    if (record?.status === 'running') {
      Object.assign(record, { status, terminalCode: code, endedAt: this.now }); this.put('episodes', record); this.abandonCall(episode.ownerId, record, code);
    }
    this.trace(episode.ownerId, episode.id, status, { code, baseStateVersion: episode.baseStateVersion });
    return true;
  }
  cancel(ownerId, episodeId = null) {
    const scope = this.scope(ownerId), p = this.getPerson(ownerId);
    if (!p.activeEpisodeId || (episodeId && p.activeEpisodeId !== episodeId)) return { cancelled: false, episodeId };
    const id = p.activeEpisodeId, until = p.leaseUntil;
    p.epoch++; p.controlVersion++; p.writeSerial++; p.activeEpisodeId = null; p.leaseOwner = null; p.leaseUntil = new Date(0); this.put('persons', p);
    const record = this.one('episodes', scope, ' AND id = ?', [id]);
    if (record?.status === 'running') {
      Object.assign(record, { status: 'cancelled', terminalCode: 'CANCELLED', endedAt: this.now, callFinalizeUntil: until }); this.put('episodes', record);
    }
    this.trace(ownerId, id, 'cancelled', { code: 'CANCELLED' });
    return { cancelled: true, episodeId: id };
  }
  settings(ownerId, settings) {
    const p = this.getPerson(ownerId);
    if (p.activeEpisodeId) fail('BUSY');
    p.settings = { ...p.settings, ...settings }; p.controlVersion++; p.writeSerial++; this.put('persons', p);
    if (Object.keys(settings).length) this.trace(ownerId, null, 'settings', { settings: p.settings });
    return { settings: p.settings };
  }
  list(ownerId, collection, { cursor = null, limit = 20 } = {}, filter = {}) {
    if (!['messages', 'traces'].includes(collection)) fail('INVALID_REQUEST');
    this.getPerson(ownerId); boundedLimit(limit);
    if (Object.keys(filter).some(k => k !== 'text') || (filter.text && (typeof filter.text.$regex !== 'string' || filter.text.$options !== 'i'))) fail('INVALID_REQUEST');
    // Compatibility for Mongo's literal recall filter only; arbitrary selectors are forbidden.
    const query = filter.text?.$regex?.replace(/\\([.*+?^${}()|[\]\\])/g, '$1') ?? '';
    if (query && collection !== 'messages') fail('INVALID_REQUEST');
    let clause = '', params = [];
    if (cursor != null) { clause += ' AND seq < ?'; params.push(sequence(cursor)); }
    if (query) { clause += ' AND instr(text, ?) > 0'; params.push(query.toLowerCase()); }
    const docs = this.rows(collection, this.scope(ownerId), `${clause} ORDER BY seq DESC LIMIT ?`, [...params, limit + 1]);
    return { items: docs.slice(0, limit).map(publicDoc), nextCursor: docs.length > limit ? String(docs[limit - 1].seq) : null };
  }
  recall(ownerId, { kind = 'messages', query = '', cursor = null, limit = 5 } = {}) {
    memoryKind(kind); text(query, LIMITS.inputBytes, true); boundedLimit(limit);
    if (kind === 'messages') return this.list(ownerId, kind, { cursor, limit }, query ? { text: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {});
    this.getPerson(ownerId);
    if (cursor != null) text(cursor, 128);
    const docs = this.rows('concepts', this.scope(ownerId), ' AND (? IS NULL OR id > ?) AND instr(statement, ?) > 0 ORDER BY id ASC LIMIT ?', [cursor, cursor, query.toLowerCase(), limit + 1]);
    return { items: docs.slice(0, limit).map(publicDoc), nextCursor: docs.length > limit ? docs[limit - 1].id : null };
  }
  snapshot(ownerId) {
    this.recover(ownerId);
    const scope = this.scope(ownerId), p = this.getPerson(ownerId), state = this.one('states', scope);
    const messages = this.rows('messages', scope, ' ORDER BY seq DESC LIMIT 21');
    const episode = this.one('episodes', scope, ' ORDER BY inputWatermark DESC');
    const latestEpisode = episode ? { id: episode.id, status: episode.status,
      ...(episode.terminalCode ? { terminalCode: episode.terminalCode } : {}), ...(episode.endedAt ? { endedAt: episode.endedAt } : {}) } : null;
    return { latestEpisode, person: this.personView(p), state: publicDoc(state), concepts: this.focused(scope, state.focusConceptIds).slice(0, 12).map(publicDoc),
      messages: messages.slice(0, 20).reverse().map(publicDoc), nextMessagesCursor: messages.length > 20 ? String(messages[19].seq) : null,
      busy: Boolean(p.activeEpisodeId), episodeId: p.activeEpisodeId };
  }
  searchChanges(ownerId, { after = 0, limit = 100 } = {}) {
    this.getPerson(ownerId); after = sequence(after); boundedLimit(limit, 1000);
    const rows = this.sql(`SELECT seq, kind, id, revision, record FROM memory_changes WHERE ${SCOPE} AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(...scopeValues(this.scope(ownerId)), after, limit + 1);
    const items = rows.slice(0, limit).map(row => ({ ...row, record: decode(row) }));
    return { items, lastSeq: items.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }
  resolveMemories(ownerId, kind, refs) {
    memoryKind(kind); this.getPerson(ownerId);
    if (!Array.isArray(refs) || refs.length > 1000) fail('INVALID_REQUEST');
    const scope = this.scope(ownerId), records = [], seen = new Set();
    for (const ref of refs) {
      if (!ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision) || ref.revision < 1) fail('INVALID_REQUEST');
      const record = this.one(kind, scope, ' AND id = ? AND revision = ?', [ref.id, ref.revision]);
      if (record && !seen.has(record.id)) { seen.add(record.id); records.push(publicDoc(record)); }
    }
    return records;
  }
  close() { this.db.close(); }
}
