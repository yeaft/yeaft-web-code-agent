import { randomUUID } from 'node:crypto';
import { admissionReceipt, bytes, digest, fail, identifier, LIMITS, PersonError, safeError } from './contracts.js';
import { CREATED_CAPABILITY_LIMITS, createdCapabilityRecord, validateCreatedCapability } from './created-capability-contract.js';
import { attachmentMetadata, attachmentRequestHash, validateFiles } from './attachments.js';
import { capabilityExperienceView, recordCapabilityExperience } from './capability-experience.js';
import { conceptView, inspectionPage, inspectRequest, messageView, personName, searchRequest, settingsView, stateView } from './inspection.js';
import { inspectCapabilities } from './capabilities.js';

const COLLECTIONS = ['persons', 'attachments', 'messages', 'episodes', 'states', 'concepts', 'concept_revisions', 'state_commits', 'traces', 'created_capabilities', 'created_capability_revisions'];
const txOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 5000, timeoutMS: 10000 };
const publicDoc = doc => {
  if (!doc) return null;
  const { _id, ownerId, namespace, personId, ...rest } = doc;
  return rest;
};
// Legacy traces are BSON documents. New traces keep arbitrary JSON (including
// NUL keys) in a string; only fixed metadata/query projections remain in BSON.
const publicTrace = doc => doc?.recordEncoding === 'json-v1' && typeof doc.record === 'string'
  ? publicDoc({ ...JSON.parse(doc.record), createdAt: doc.createdAt }) : publicDoc(doc);
const iso = date => date instanceof Date ? date.toISOString() : date;
const scopeFor = (ownerId, namespace) => ({ ownerId, namespace, personId: `person-${digest([namespace, ownerId]).slice(0, 32)}` });
const fresh = () => ({ $expr: { $gt: ['$leaseUntil', '$$NOW'] } });
const expired = () => ({ $expr: { $lte: ['$leaseUntil', '$$NOW'] } });
const unavailableOutput = () => ({ text: '', retainedBytes: 0, observedBytes: null, complete: false, accepted: false, availability: 'unavailable', reason: 'worker-unavailable' });
// This terminal-only path accepts a bounded public-output shape, never arbitrary trace/state data.
const publicOutput = (output, failed) => {
  if (!output) return unavailableOutput();
  if (typeof output.text !== 'string' || bytes(output.text) > LIMITS.outputBytes) fail('OUTPUT_LIMIT');
  const retainedBytes = bytes(output.text);
  const observedBytes = output.observedBytes ?? output.bytes ?? retainedBytes;
  if (!Number.isSafeInteger(observedBytes) || observedBytes < retainedBytes) fail('INVALID_REQUEST');
  const usage = output.usage ? {} : null;
  if (usage) for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (Number.isFinite(output.usage[key]) && output.usage[key] >= 0) usage[key] = output.usage[key];
  }
  const stopReason = typeof output.stopReason === 'string' && bytes(output.stopReason) <= 128 ? output.stopReason : null;
  return failed ? { text: output.text, retainedBytes, observedBytes, complete: false, accepted: false, availability: 'captured', usage, stopReason }
    : { text: output.text, bytes: retainedBytes, complete: true, usage, stopReason };
};

/** MongoDB is the sole authority. No Session, local transcript or memory-file fallback. */
export class MongoPersonRepository {
  constructor({ uri, dbName = 'yeaft_person', namespace, MongoClient, leaseMs = 15000 }) {
    this.uri = uri; this.dbName = dbName; this.namespace = namespace; this.MongoClient = MongoClient; this.leaseMs = leaseMs;
  }
  async init() {
    if (!this.initializing) this.initializing = this.connect().catch(async error => {
      await this.client?.close().catch(() => {}); this.initializing = null;
      throw safeError(error);
    });
    return this.initializing;
  }
  async connect() {
    const Client = this.MongoClient || (await import('mongodb')).MongoClient;
    this.client = new Client(this.uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000, maxPoolSize: 8, retryWrites: true });
    await this.client.connect(); this.db = this.client.db(this.dbName);
    const hello = await this.db.command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') fail('STORAGE_UNAVAILABLE');
    if (!hello.logicalSessionTimeoutMinutes) fail('STORAGE_UNAVAILABLE');
    this.collections = {};
    for (const name of COLLECTIONS) {
      const fullName = `person_${name}`;
      try {
        await this.db.createCollection(fullName, { validator: { $jsonSchema: {
          bsonType: 'object', required: ['schemaVersion', 'ownerId', 'namespace', 'personId'],
          properties: { schemaVersion: { enum: [1] }, ownerId: { bsonType: 'string' }, namespace: { bsonType: 'string' }, personId: { bsonType: 'string' } },
        } }, validationLevel: 'strict' });
      } catch (error) { if (error.code !== 48) throw error; }
      this.collections[name] = this.db.collection(fullName);
    }
    const scope = { namespace: 1, ownerId: 1, personId: 1 };
    const unique = (name, fields) => this.collections[name].createIndex({ ...scope, ...fields }, { unique: true });
    await Promise.all([
      unique('persons', {}), unique('states', {}), unique('episodes', { clientMessageId: 1 }), unique('episodes', { id: 1 }),
      unique('attachments', { id: 1 }), unique('messages', { seq: 1 }), unique('traces', { seq: 1 }), unique('concepts', { id: 1 }),
      this.collections.episodes.createIndex({ ...scope, inputWatermark: -1 }),
      unique('created_capabilities', { id: 1 }), unique('created_capability_revisions', { id: 1, version: 1 }),
      this.collections.traces.createIndex({ ...scope, episodeId: 1, kind: 1, callId: 1 }),
      unique('concept_revisions', { id: 1, revision: 1 }), unique('state_commits', { version: 1 }),
      this.collections.concepts.createIndex({ ...scope, updatedAt: -1, id: 1 }),
    ]);
  }
  scope(ownerId) { return scopeFor(ownerId, this.namespace); }
  doc(scope, values) { return { ...values, schemaVersion: 1, ...scope }; }
  async transaction(fn, retry = true) {
    await this.init();
    const session = this.client.startSession();
    try {
      if (retry) return await session.withTransaction(() => fn(session), txOptions);
      // Publication never replays logical writes after an unknown commit outcome.
      session.startTransaction(txOptions);
      const result = await fn(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      if (!retry && session.inTransaction()) await session.abortTransaction().catch(() => {});
      throw safeError(error);
    }
    finally { await session.endSession(); }
  }
  personView(p) {
    return { id: p.personId, name: p.name, soul: p.soul, soulRevision: p.soulRevision, createdAt: iso(p.createdAt), settings: settingsView(p.settings) };
  }
  async open(ownerId, name = 'Digital Person') {
    const scope = this.scope(ownerId);
    try {
      return await this.transaction(async session => {
        let p = await this.collections.persons.findOne(scope, { session });
        if (!p) {
          p = this.doc(scope, {
            name, soul: 'A continuous, curious and honest digital person. Preserve uncertainty, reconsider your judgments, distinguish imagination from experience, and respect permissions. You may disagree without acting without authority.',
            soulRevision: 1, createdAt: new Date(), settings: { autonomyEnabled: false },
            epoch: 0, writeSerial: 0, inputWatermark: 0, controlVersion: 0, stateVersion: 0,
            traceSeq: 0, messageSeq: 0, activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0),
          });
          await this.collections.persons.insertOne(p, { session });
          await this.collections.states.insertOne(this.doc(scope, { version: 0, summary: '', appraisal: '', focusConceptIds: [], conceptRefs: [], lastSelection: null, updatedAt: p.createdAt }), { session });
        }
        return { person: this.personView(p) };
      });
    } catch (error) {
      // Two explicit opens may race on the deterministic unique identity.
      const p = await this.collections?.persons.findOne(scope).catch(() => null);
      if (p) return { person: this.personView(p) };
      throw error;
    }
  }
  async getPerson(ownerId) {
    await this.init();
    const p = await this.collections.persons.findOne(this.scope(ownerId));
    if (!p) fail('NOT_OPEN');
    return p;
  }
  async trace(session, p, episodeId, kind, data = {}) {
    const scope = this.scope(p.ownerId);
    const updated = await this.collections.persons.findOneAndUpdate(scope, { $inc: { traceSeq: 1, writeSerial: 1 } }, { session, returnDocument: 'after' });
    const record = this.doc(scope, { ...data, id: randomUUID(), episodeId, kind, seq: updated.traceSeq, createdAt: new Date() });
    const stored = this.doc(scope, { id: record.id, episodeId, kind, seq: record.seq, createdAt: record.createdAt,
      recordEncoding: 'json-v1', record: JSON.stringify(record),
      ...(typeof record.callId === 'string' ? { callId: record.callId } : {}),
      ...(['call_output', 'call_failed'].includes(kind) ? { output: { complete: record.output?.complete === true } } : {}),
    });
    await this.collections.traces.insertOne(stored, { session });
    return publicTrace(stored);
  }
  async recover(ownerId) {
    return this.transaction(async session => {
      const scope = this.scope(ownerId);
      const p = await this.collections.persons.findOneAndUpdate({ ...scope, activeEpisodeId: { $ne: null }, ...expired() }, {
        $inc: { epoch: 1, writeSerial: 1 }, $set: { activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0) },
      }, { session, returnDocument: 'before' });
      if (p) {
        const episode = await this.collections.episodes.findOneAndUpdate({ ...scope, id: p.activeEpisodeId, status: 'running' },
          { $set: { status: 'interrupted', terminalCode: 'INTERRUPTED', endedAt: new Date() } }, { session, returnDocument: 'before' });
        await this.abandonCall(session, p, episode, 'INTERRUPTED');
        await this.trace(session, p, p.activeEpisodeId, 'interrupted', { code: 'INTERRUPTED', reason: 'lease-expired', baseStateVersion: p.stateVersion });
      }
      // Cancellation leaves a bounded drain window for the original worker's consumed prefix.
      // If that worker crashed, the next access closes the call with explicit unavailable output.
      const abandoned = await this.collections.episodes.find({ ...scope, status: 'cancelled', 'openCall.callId': { $exists: true },
        $expr: { $lte: ['$callFinalizeUntil', '$$NOW'] } }, { session }).toArray();
      for (const episode of abandoned) await this.abandonCall(session, { ownerId }, episode, 'CANCELLED');
      return Boolean(p);
    });
  }
  async receipt(ownerId, clientMessageId, requestHash) {
    identifier(clientMessageId);
    await this.init();
    const episode = await this.collections.episodes.findOne({ ...this.scope(ownerId), clientMessageId }, { readConcern: { level: 'majority' }, readPreference: 'primary' });
    return admissionReceipt(episode, clientMessageId, requestHash);
  }
  async admit(ownerId, { kind, text, clientMessageId, workerId, budget, files = [] }) {
    const validated = validateFiles(files, text, kind), attachments = validated.map(attachmentMetadata);
    await this.recover(ownerId);
    const scope = this.scope(ownerId), requestHash = attachmentRequestHash(kind, text, validated);
    return this.transaction(async session => {
      const existing = await this.collections.episodes.findOne({ ...scope, clientMessageId }, { session });
      if (existing) {
        if (existing.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        return { episodeId: existing.id, duplicate: true, status: existing.status };
      }
      let p = await this.collections.persons.findOne(scope, { session });
      if (!p) fail('NOT_OPEN');
      if (p.activeEpisodeId) fail('BUSY');
      // Every admission is explicit. A manual Dream request authorizes this episode
      // only; it neither requires nor enables unsolicited background cognition.
      const id = randomUUID();
      const hasMessage = kind === 'send' || (kind === 'think' && attachments.length > 0);
      p = await this.collections.persons.findOneAndUpdate({ ...scope, activeEpisodeId: null, epoch: p.epoch }, [{ $set: {
        activeEpisodeId: id, leaseOwner: workerId, leaseUntil: { $add: ['$$NOW', this.leaseMs] },
        epoch: { $add: ['$epoch', 1] }, writeSerial: { $add: ['$writeSerial', 1] },
        inputWatermark: { $add: ['$inputWatermark', 1] }, messageSeq: { $add: ['$messageSeq', hasMessage ? 1 : 0] },
      } }], { session, returnDocument: 'after' });
      if (!p) fail('BUSY');
      let messageId = null;
      for (const file of validated) await this.collections.attachments.updateOne({ ...scope, id: file.id }, { $setOnInsert: this.doc(scope, file) }, { session, upsert: true });
      if (hasMessage) {
        messageId = randomUUID();
        await this.collections.messages.insertOne(this.doc(scope, { id: messageId, revision: 1, seq: p.messageSeq, episodeId: id, role: 'user', text, attachments, createdAt: new Date(), clientMessageId }), { session });
      }
      const episode = this.doc(scope, { id, clientMessageId, requestHash, kind, text, messageId, attachments, modelCandidates: [...(p.settings.modelCandidates ?? [])], status: 'running', workerId, epoch: p.epoch,
        baseStateVersion: p.stateVersion, inputWatermark: p.inputWatermark, controlVersion: p.controlVersion, budget, createdAt: new Date() });
      await this.collections.episodes.insertOne(episode, { session });
      await this.trace(session, p, id, 'accepted', { trigger: { kind, text, messageId, attachments }, baseStateVersion: p.stateVersion, budget });
      return { episodeId: id, duplicate: false, status: 'running', episode };
    });
  }
  fence(episode, withLease = true) {
    const scope = this.scope(episode.ownerId);
    if (episode.namespace !== scope.namespace || episode.personId !== scope.personId) fail('STALE');
    return { ...scope, activeEpisodeId: episode.id, epoch: episode.epoch, leaseOwner: episode.workerId,
      stateVersion: episode.baseStateVersion, controlVersion: episode.controlVersion, inputWatermark: episode.inputWatermark, ...(withLease ? fresh() : {}) };
  }
  async heartbeat(episode) {
    await this.init();
    const p = await this.collections.persons.findOneAndUpdate(this.fence(episode), [{ $set: {
      leaseUntil: { $add: ['$$NOW', this.leaseMs] }, writeSerial: { $add: ['$writeSerial', 1] },
    } }], { returnDocument: 'after', writeConcern: { w: 'majority' } });
    if (!p) fail('STALE');
  }
  async append(episode, kind, data) {
    // Call proof/publication events are emitted only by their transactional methods.
    if (['call_started', 'call_output', 'call_failed', 'capability_created'].includes(kind)) fail('INVALID_REQUEST');
    return this.transaction(async session => {
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode), { $inc: { writeSerial: 1 } }, { session, returnDocument: 'after' });
      if (!p) fail('STALE');
      const scope = this.scope(episode.ownerId);
      const record = await this.collections.episodes.findOne({ ...scope, id: episode.id, status: 'running' }, { session });
      if (!record) fail('STALE');
      const experience = recordCapabilityExperience(p.capabilityExperience, record, kind, data, new Date().toISOString());
      if (experience) await this.collections.persons.updateOne(scope, { $set: { capabilityExperience: experience } }, { session });
      return this.trace(session, p, episode.id, kind, data);
    });
  }
  async startCall(episode, data) {
    return this.transaction(async session => {
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode), { $inc: { writeSerial: 1 } }, { session, returnDocument: 'after' });
      if (!p) fail('STALE');
      const updated = await this.collections.episodes.updateOne({ ...this.scope(episode.ownerId), id: episode.id, status: 'running', openCall: { $exists: false } },
        { $set: { openCall: { callId: data.callId, requested: data.requested, effective: data.effective, ...(data.manifest ? { manifest: data.manifest } : {}) } } }, { session });
      if (!updated.modifiedCount) fail('STALE');
      return this.trace(session, p, episode.id, 'call_started', data);
    });
  }
  /** Close exactly the original worker's started call, even after cancel; never regain state ownership. */
  async finalizeCall(episode, { callId, effective, output, code = null }) {
    return this.transaction(async session => {
      const scope = this.scope(episode.ownerId);
      const record = await this.collections.episodes.findOne({ ...scope, id: episode.id, workerId: episode.workerId,
        epoch: episode.epoch, 'openCall.callId': callId }, { session });
      if (!record) return false;
      const live = record.status === 'running' && await this.collections.persons.findOne(this.fence(episode), { session });
      const draining = record.status === 'cancelled' && await this.collections.episodes.findOne({ ...scope, id: episode.id,
        $expr: { $gt: ['$callFinalizeUntil', '$$NOW'] } }, { session });
      if (!live && !draining) return false;
      const failed = Boolean(code || !live || !output);
      const terminalCode = !live ? 'CANCELLED' : code || 'INTERRUPTED';
      const safeEffective = { model: record.openCall.requested.model, effort: typeof effective?.effort === 'string' && effective.effort.length <= 128 ? effective.effort : null,
        effortObserved: effective?.effortObserved === true };
      if (typeof effective?.wireMode === 'string' && effective.wireMode.length <= 128) safeEffective.wireMode = effective.wireMode;
      // The episode update serializes finalizers, cancellation/recovery and duplicate workers.
      await this.collections.episodes.updateOne({ ...scope, id: episode.id, 'openCall.callId': callId }, { $unset: { openCall: '', callFinalizeUntil: '' } }, { session });
      await this.trace(session, { ownerId: episode.ownerId }, episode.id, failed ? 'call_failed' : 'call_output', {
        callId, requested: record.openCall.requested, effective: safeEffective, output: publicOutput(output, failed),
        ...(!failed && record.openCall.manifest ? { manifest: record.openCall.manifest } : {}),
        ...(failed ? { code: new PersonError(terminalCode).code } : {}),
      });
      return Boolean(live);
    });
  }
  async abandonCall(session, p, episode, code) {
    if (!episode?.openCall) return;
    await this.collections.episodes.updateOne({ ...this.scope(p.ownerId), id: episode.id, 'openCall.callId': episode.openCall.callId },
      { $unset: { openCall: '', callFinalizeUntil: '' } }, { session });
    await this.trace(session, p, episode.id, 'call_failed', { ...episode.openCall, code, output: unavailableOutput() });
  }
  async createdCapabilities(episode) {
    return this.transaction(async session => {
      // Fence and current records share one snapshot, like SQLite's read transaction.
      const p = await this.collections.persons.findOne(this.fence(episode), { session });
      if (!p) fail('STALE');
      return (await this.collections.created_capabilities.find(this.scope(episode.ownerId), { session }).sort({ id: 1 }).limit(32).toArray())
        .map(doc => publicDoc(JSON.parse(doc.record)));
    }, false);
  }
  async saveCreatedCapability(episode, input) {
    const { definition, evidence, callId } = validateCreatedCapability(input);
    return this.transaction(async session => {
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode), { $inc: { writeSerial: 1 } }, { session, returnDocument: 'after' });
      if (!p) fail('STALE');
      const scope = this.scope(episode.ownerId);
      const active = await this.collections.episodes.findOne({ ...scope, id: episode.id, status: 'running', epoch: episode.epoch, workerId: episode.workerId }, { session });
      if (!active) fail('STALE');
      const proof = await this.collections.traces.findOne({ ...scope, episodeId: episode.id, kind: 'call_output', callId, 'output.complete': true }, { session });
      if (!proof || active.openCall?.callId === callId) fail('INVALID_REQUEST');
      const current = await this.collections.created_capabilities.findOne({ ...scope, id: definition.id }, { session });
      if ((current?.version ?? 0) !== definition.expectedVersion) fail('STALE');
      if (definition.expectedVersion >= CREATED_CAPABILITY_LIMITS.versions || (!current &&
          await this.collections.created_capabilities.countDocuments(scope, { session }) >= CREATED_CAPABILITY_LIMITS.ids)) fail('CONTEXT_LIMIT');
      const record = this.doc(scope, createdCapabilityRecord(definition, evidence, { episode, callId, now: new Date() }));
      // As in SQLite, JSON is authoritative: arbitrary test keys (including NUL
      // and __proto__) must survive without BSON field restrictions/coercion.
      const stored = this.doc(scope, { id: record.id, version: record.version, record: JSON.stringify(record) });
      await this.collections.created_capability_revisions.insertOne({ ...stored, _id: randomUUID() }, { session });
      if (!current) await this.collections.created_capabilities.insertOne({ ...stored }, { session });
      else {
        const update = await this.collections.created_capabilities.replaceOne({ ...scope, id: definition.id, version: definition.expectedVersion }, stored, { session });
        if (update.matchedCount !== 1) fail('STALE');
      }
      await this.trace(session, p, episode.id, 'capability_created', { callId, capabilityId: record.id,
        capabilityManifest: { id: record.id, version: record.version, revision: record.revision }, evidence: record.evidence });
      return publicDoc(record);
    }, false);
  }
  async episodeAttachments(episode) {
    return this.transaction(async session => {
      if (!await this.collections.persons.findOne(this.fence(episode), { session })) fail('STALE');
      const scope = this.scope(episode.ownerId);
      const stored = await this.collections.episodes.findOne({ ...scope, id: episode.id }, { session });
      const files = [];
      for (const ref of stored.attachments ?? []) {
        const file = await this.collections.attachments.findOne({ ...scope, id: ref.id }, { session });
        if (!file || file.sha256 !== ref.sha256) fail('STORAGE_UNAVAILABLE');
        files.push(publicDoc(file));
      }
      return files;
    });
  }
  async context(episode) {
    await this.init();
    const scope = this.scope(episode.ownerId);
    const p = await this.collections.persons.findOne(this.fence(episode));
    if (!p) fail('STALE');
    const [state, messages, focused, recent] = await Promise.all([
      this.collections.states.findOne(scope), this.collections.messages.find(scope).sort({ seq: -1 }).limit(12).toArray(),
      this.collections.states.findOne(scope).then(s => this.collections.concepts.find({ ...scope, id: { $in: s.focusConceptIds } }).limit(12).toArray()),
      this.collections.concepts.find(scope).sort({ updatedAt: -1, id: 1 }).limit(12).toArray(),
    ]);
    const concepts = [...new Map([...focused, ...recent].map(c => [c.id, conceptView(c)])).values()];
    return { person: this.personView(p), capabilityExperience: capabilityExperienceView(p.capabilityExperience),
      state: stateView(state), messages: messages.reverse().map(messageView), concepts };
  }
  async recall(ownerId, { kind = 'messages', query = '', cursor = null, limit = 5 }) {
    const scope = this.scope(ownerId);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (kind === 'messages') return this.list(ownerId, 'messages', { cursor, limit }, query ? { text: { $regex: escaped, $options: 'i' } } : {});
    await this.init();
    const filter = { ...scope, ...(query ? { statement: { $regex: escaped, $options: 'i' } } : {}), ...(cursor ? { id: { $gt: cursor } } : {}) };
    const docs = await this.collections.concepts.find(filter).sort({ id: 1 }).limit(limit + 1).maxTimeMS(2000).toArray();
    return { items: docs.slice(0, limit).map(conceptView), nextCursor: docs.length > limit ? docs[limit - 1].id : null };
  }
  async commit(episode, proposal, selection, callId, reportedSources = new Map()) {
    return this.transaction(async session => {
      const scope = this.scope(episode.ownerId);
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode), { $inc: { stateVersion: 1, writeSerial: 1, messageSeq: proposal.reply ? 1 : 0 },
        $set: { activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0) } }, { session, returnDocument: 'after' });
      if (!p) fail('STALE');
      const revisions = [];
      for (const patch of proposal.concepts) {
        const { expectedRevision, ...fields } = patch;
        const reportedSourceRefs = reportedSources.get(patch.id) ?? [];
        if (patch.epistemicState === 'reported' && !reportedSourceRefs.length) fail('INVALID_PROPOSAL');
        const record = this.doc(scope, { ...fields, reportedSourceRefs, revision: expectedRevision + 1, episodeId: episode.id, callId, stateVersion: p.stateVersion, updatedAt: new Date() });
        if (expectedRevision === 0) {
          if (await this.collections.concepts.findOne({ ...scope, id: patch.id }, { session })) fail('STALE');
          await this.collections.concepts.insertOne(record, { session });
        } else {
          const update = await this.collections.concepts.replaceOne({ ...scope, id: patch.id, revision: expectedRevision }, record, { session });
          if (update.matchedCount !== 1) fail('STALE');
        }
        await this.collections.concept_revisions.insertOne({ ...record, _id: randomUUID() }, { session });
        revisions.push({ id: patch.id, revision: record.revision });
      }
      const focus = await this.collections.concepts.find({ ...scope, id: { $in: proposal.state.focusConceptIds } }, { session }).toArray();
      if (focus.length !== proposal.state.focusConceptIds.length) fail('STALE');
      const state = this.doc(scope, { ...proposal.state, version: p.stateVersion, conceptRefs: focus.map(c => ({ id: c.id, revision: c.revision })),
        decision: proposal.decision, lastSelection: { model: selection.model, effort: selection.effort }, updatedAt: new Date(), episodeId: episode.id });
      const updated = await this.collections.states.replaceOne({ ...scope, version: episode.baseStateVersion }, state, { session });
      if (updated.matchedCount !== 1) fail('STALE');
      await this.collections.state_commits.insertOne(this.doc(scope, { id: randomUUID(), version: p.stateVersion, parentVersion: episode.baseStateVersion,
        episodeId: episode.id, callId, conceptRevisions: revisions, state: stateView(state), createdAt: new Date() }), { session });
      if (proposal.reply) await this.collections.messages.insertOne(this.doc(scope, { id: randomUUID(), revision: 1, seq: p.messageSeq, episodeId: episode.id,
        role: 'assistant', text: proposal.reply, createdAt: new Date() }), { session });
      await this.collections.episodes.updateOne({ ...scope, id: episode.id, status: 'running' }, { $set: { status: 'completed', endedAt: new Date(), stateVersion: p.stateVersion } }, { session });
      await this.trace(session, p, episode.id, 'committed', { callId, parentVersion: episode.baseStateVersion, stateVersion: p.stateVersion, conceptRevisions: revisions, decision: proposal.decision });
      return { state: stateView(state) };
    });
  }
  async finish(episode, status, code) {
    return this.transaction(async session => {
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode, false), { $inc: { writeSerial: 1, epoch: 1 },
        $set: { activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0) } }, { session, returnDocument: 'before' });
      if (!p) return false; // A cancel, takeover or earlier terminal transaction already won.
      const ended = await this.collections.episodes.findOneAndUpdate({ ...this.scope(episode.ownerId), id: episode.id, status: 'running' }, { $set: { status, terminalCode: code, endedAt: new Date() } }, { session, returnDocument: 'before' });
      await this.abandonCall(session, p, ended, code);
      await this.trace(session, p, episode.id, status, { code, baseStateVersion: episode.baseStateVersion });
      return true;
    });
  }
  async cancel(ownerId, episodeId = null) {
    return this.transaction(async session => {
      const scope = this.scope(ownerId);
      const current = await this.collections.persons.findOne(scope, { session });
      if (!current) fail('NOT_OPEN');
      if (!current.activeEpisodeId || (episodeId && current.activeEpisodeId !== episodeId)) return { cancelled: false, episodeId };
      const p = await this.collections.persons.findOneAndUpdate({ ...scope, activeEpisodeId: current.activeEpisodeId, epoch: current.epoch }, {
        $inc: { epoch: 1, controlVersion: 1, writeSerial: 1 }, $set: { activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0) },
      }, { session, returnDocument: 'before' });
      if (!p) fail('STALE');
      await this.collections.episodes.updateOne({ ...scope, id: p.activeEpisodeId, status: 'running' }, { $set: { status: 'cancelled', terminalCode: 'CANCELLED', endedAt: new Date(), callFinalizeUntil: p.leaseUntil } }, { session });
      await this.trace(session, p, p.activeEpisodeId, 'cancelled', { code: 'CANCELLED' });
      return { cancelled: true, episodeId: p.activeEpisodeId };
    });
  }
  async settings(ownerId, settings) {
    return this.transaction(async session => {
      const scope = this.scope(ownerId);
      const p = await this.collections.persons.findOne(scope, { session });
      if (!p) fail('NOT_OPEN');
      if (p.activeEpisodeId) fail('BUSY'); // No implicit background API or deferred control effects.
      const { name, ...patch } = settings;
      if (Object.hasOwn(settings, 'name')) p.name = personName(name);
      // A partial update must preserve durable fields omitted from the public view.
      const next = { ...p.settings, ...patch };
      await this.collections.persons.updateOne(scope, { $set: { settings: next, name: p.name }, $inc: { controlVersion: 1, writeSerial: 1 } }, { session });
      if (Object.keys(settings).length) await this.trace(session, p, null, 'settings', { settings: settingsView(next), ...(name !== undefined ? { name: p.name } : {}) });
      return { settings: settingsView(next), person: this.personView({ ...p, settings: next }) };
    });
  }
  async inspect(ownerId, options, nativeToolIds) {
    const { section, cursor, limit } = inspectRequest(options);
    await this.getPerson(ownerId);
    const scope = this.scope(ownerId);
    if (section === 'skills') {
      const docs = await this.collections.created_capabilities.find(scope).sort({ id: 1 }).limit(32).maxTimeMS(2000).toArray();
      return inspectCapabilities(docs.map(doc => JSON.parse(doc.record)), { cursor, limit }, nativeToolIds);
    }
    const records = await this.collections.concepts.find({ ...scope, ...(cursor !== null ? { id: { $gt: cursor } } : {}) })
      .collation({ locale: 'simple' }).sort({ id: 1 }).limit(limit + 1).maxTimeMS(2000).toArray();
    return inspectionPage(records, limit, 'id', conceptView);
  }
  async search(ownerId, options) {
    const { query, cursor, limit } = searchRequest(options);
    await this.getPerson(ownerId);
    const records = await this.collections.messages.find({ ...this.scope(ownerId),
      text: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }, ...(cursor !== null ? { seq: { $lt: cursor } } : {}) })
      .sort({ seq: -1 }).limit(limit + 1).maxTimeMS(2000).toArray();
    return inspectionPage(records, limit, 'seq', messageView);
  }
  async list(ownerId, collection, { cursor = null, limit = 20 }, filter = {}) {
    if (!['messages', 'traces'].includes(collection)) fail('INVALID_REQUEST');
    await this.getPerson(ownerId);
    const docs = await this.collections[collection].find({ ...this.scope(ownerId), ...filter, ...(cursor ? { seq: { $lt: cursor } } : {}) }).sort({ seq: -1 }).limit(limit + 1).maxTimeMS(2000).toArray();
    return { items: docs.slice(0, limit).map(collection === 'traces' ? publicTrace : messageView), nextCursor: docs.length > limit ? String(docs[limit - 1].seq) : null };
  }
  async snapshot(ownerId) {
    await this.recover(ownerId);
    return this.transaction(async session => {
      const scope = this.scope(ownerId);
      const p = await this.collections.persons.findOne(scope, { session });
      if (!p) fail('NOT_OPEN');
      const state = await this.collections.states.findOne(scope, { session });
      const messages = await this.collections.messages.find(scope, { session }).sort({ seq: -1 }).limit(21).toArray();
      const concepts = await this.collections.concepts.find({ ...scope, id: { $in: state.focusConceptIds } }, { session }).limit(12).toArray();
      const episode = await this.collections.episodes.findOne(scope, { session, sort: { inputWatermark: -1 },
        projection: { _id: 0, id: 1, status: 1, terminalCode: 1, endedAt: 1 } });
      return { latestEpisode: episode, person: this.personView(p), state: stateView(state), concepts: concepts.map(conceptView), messages: messages.slice(0, 20).reverse().map(messageView),
        nextMessagesCursor: messages.length > 20 ? String(messages[19].seq) : null, busy: Boolean(p.activeEpisodeId), episodeId: p.activeEpisodeId };
    });
  }
  async close() { await this.client?.close(); }
}
