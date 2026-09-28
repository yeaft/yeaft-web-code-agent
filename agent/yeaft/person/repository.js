import { randomUUID } from 'node:crypto';
import { digest, fail, safeError } from './contracts.js';

const COLLECTIONS = ['persons', 'messages', 'episodes', 'states', 'concepts', 'concept_revisions', 'state_commits', 'traces'];
const txOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 5000, timeoutMS: 10000 };
const publicDoc = doc => {
  if (!doc) return null;
  const { _id, ownerId, namespace, personId, ...rest } = doc;
  return rest;
};
const iso = date => date instanceof Date ? date.toISOString() : date;
const scopeFor = (ownerId, namespace) => ({ ownerId, namespace, personId: `person-${digest([namespace, ownerId]).slice(0, 32)}` });
const fresh = () => ({ $expr: { $gt: ['$leaseUntil', '$$NOW'] } });
const expired = () => ({ $expr: { $lte: ['$leaseUntil', '$$NOW'] } });

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
      unique('messages', { seq: 1 }), unique('traces', { seq: 1 }), unique('concepts', { id: 1 }),
      unique('concept_revisions', { id: 1, revision: 1 }), unique('state_commits', { version: 1 }),
      this.collections.concepts.createIndex({ ...scope, updatedAt: -1, id: 1 }),
    ]);
  }
  scope(ownerId) { return scopeFor(ownerId, this.namespace); }
  doc(scope, values) { return { schemaVersion: 1, ...scope, ...values }; }
  async transaction(fn) {
    await this.init();
    const session = this.client.startSession();
    try { return await session.withTransaction(() => fn(session), txOptions); }
    catch (error) { throw safeError(error); }
    finally { await session.endSession(); }
  }
  personView(p) {
    return { id: p.personId, name: p.name, soul: p.soul, soulRevision: p.soulRevision, createdAt: iso(p.createdAt), settings: p.settings };
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
    const record = this.doc(scope, { id: randomUUID(), episodeId, kind, seq: updated.traceSeq, createdAt: new Date(), ...data });
    await this.collections.traces.insertOne(record, { session });
    return publicDoc(record);
  }
  async recover(ownerId) {
    return this.transaction(async session => {
      const p = await this.collections.persons.findOneAndUpdate({ ...this.scope(ownerId), activeEpisodeId: { $ne: null }, ...expired() }, {
        $inc: { epoch: 1, writeSerial: 1 }, $set: { activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0) },
      }, { session, returnDocument: 'before' });
      if (!p) return false;
      await this.collections.episodes.updateOne({ ...this.scope(ownerId), id: p.activeEpisodeId, status: 'running' }, { $set: { status: 'interrupted', terminalCode: 'INTERRUPTED', endedAt: new Date() } }, { session });
      await this.trace(session, p, p.activeEpisodeId, 'interrupted', { code: 'INTERRUPTED', reason: 'lease-expired', baseStateVersion: p.stateVersion });
      return true;
    });
  }
  async admit(ownerId, { kind, text, clientMessageId, workerId, budget }) {
    await this.recover(ownerId);
    const scope = this.scope(ownerId), requestHash = digest([kind, text]);
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
      p = await this.collections.persons.findOneAndUpdate({ ...scope, activeEpisodeId: null, epoch: p.epoch }, [{ $set: {
        activeEpisodeId: id, leaseOwner: workerId, leaseUntil: { $add: ['$$NOW', this.leaseMs] },
        epoch: { $add: ['$epoch', 1] }, writeSerial: { $add: ['$writeSerial', 1] },
        inputWatermark: { $add: ['$inputWatermark', 1] }, messageSeq: { $add: ['$messageSeq', kind === 'send' ? 1 : 0] },
      } }], { session, returnDocument: 'after' });
      if (!p) fail('BUSY');
      let messageId = null;
      if (kind === 'send') {
        messageId = randomUUID();
        await this.collections.messages.insertOne(this.doc(scope, { id: messageId, revision: 1, seq: p.messageSeq, episodeId: id, role: 'user', text, createdAt: new Date(), clientMessageId }), { session });
      }
      const episode = this.doc(scope, { id, clientMessageId, requestHash, kind, text, messageId, status: 'running', workerId, epoch: p.epoch,
        baseStateVersion: p.stateVersion, inputWatermark: p.inputWatermark, controlVersion: p.controlVersion, budget, createdAt: new Date() });
      await this.collections.episodes.insertOne(episode, { session });
      await this.trace(session, p, id, 'accepted', { trigger: { kind, text, messageId }, baseStateVersion: p.stateVersion, budget });
      return { episodeId: id, duplicate: false, status: 'running', episode };
    });
  }
  fence(episode, withLease = true) {
    return { ...this.scope(episode.ownerId), activeEpisodeId: episode.id, epoch: episode.epoch, leaseOwner: episode.workerId,
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
    return this.transaction(async session => {
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode), { $inc: { writeSerial: 1 } }, { session, returnDocument: 'after' });
      if (!p) fail('STALE');
      return this.trace(session, p, episode.id, kind, data);
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
    const concepts = [...new Map([...focused, ...recent].map(c => [c.id, publicDoc(c)])).values()];
    return { person: this.personView(p), state: publicDoc(state), messages: messages.reverse().map(publicDoc), concepts };
  }
  async recall(ownerId, { kind = 'messages', query = '', cursor = null, limit = 5 }) {
    const scope = this.scope(ownerId);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (kind === 'messages') return this.list(ownerId, 'messages', { cursor, limit }, query ? { text: { $regex: escaped, $options: 'i' } } : {});
    await this.init();
    const filter = { ...scope, ...(query ? { statement: { $regex: escaped, $options: 'i' } } : {}), ...(cursor ? { id: { $gt: cursor } } : {}) };
    const docs = await this.collections.concepts.find(filter).sort({ id: 1 }).limit(limit + 1).maxTimeMS(2000).toArray();
    return { items: docs.slice(0, limit).map(publicDoc), nextCursor: docs.length > limit ? docs[limit - 1].id : null };
  }
  async commit(episode, proposal, selection, callId) {
    return this.transaction(async session => {
      const scope = this.scope(episode.ownerId);
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode), { $inc: { stateVersion: 1, writeSerial: 1, messageSeq: proposal.reply ? 1 : 0 },
        $set: { activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0) } }, { session, returnDocument: 'after' });
      if (!p) fail('STALE');
      const revisions = [];
      for (const patch of proposal.concepts) {
        const { expectedRevision, ...fields } = patch;
        const record = this.doc(scope, { ...fields, revision: expectedRevision + 1, episodeId: episode.id, callId, stateVersion: p.stateVersion, updatedAt: new Date() });
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
        episodeId: episode.id, callId, conceptRevisions: revisions, state: publicDoc(state), createdAt: new Date() }), { session });
      if (proposal.reply) await this.collections.messages.insertOne(this.doc(scope, { id: randomUUID(), revision: 1, seq: p.messageSeq, episodeId: episode.id,
        role: 'assistant', text: proposal.reply, createdAt: new Date() }), { session });
      await this.collections.episodes.updateOne({ ...scope, id: episode.id, status: 'running' }, { $set: { status: 'completed', endedAt: new Date(), stateVersion: p.stateVersion } }, { session });
      await this.trace(session, p, episode.id, 'committed', { callId, parentVersion: episode.baseStateVersion, stateVersion: p.stateVersion, conceptRevisions: revisions, decision: proposal.decision });
      return { state: publicDoc(state) };
    });
  }
  async finish(episode, status, code) {
    return this.transaction(async session => {
      const p = await this.collections.persons.findOneAndUpdate(this.fence(episode, false), { $inc: { writeSerial: 1, epoch: 1 },
        $set: { activeEpisodeId: null, leaseOwner: null, leaseUntil: new Date(0) } }, { session, returnDocument: 'before' });
      if (!p) return false; // A cancel, takeover or earlier terminal transaction already won.
      await this.collections.episodes.updateOne({ ...this.scope(episode.ownerId), id: episode.id, status: 'running' }, { $set: { status, terminalCode: code, endedAt: new Date() } }, { session });
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
      await this.collections.episodes.updateOne({ ...scope, id: p.activeEpisodeId, status: 'running' }, { $set: { status: 'cancelled', terminalCode: 'CANCELLED', endedAt: new Date() } }, { session });
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
      const next = { ...p.settings, ...settings };
      await this.collections.persons.updateOne(scope, { $set: { settings: next }, $inc: { controlVersion: 1, writeSerial: 1 } }, { session });
      if (Object.keys(settings).length) await this.trace(session, p, null, 'settings', { settings: next });
      return { settings: next };
    });
  }
  async list(ownerId, collection, { cursor = null, limit = 20 }, filter = {}) {
    await this.getPerson(ownerId);
    const docs = await this.collections[collection].find({ ...this.scope(ownerId), ...filter, ...(cursor ? { seq: { $lt: cursor } } : {}) }).sort({ seq: -1 }).limit(limit + 1).maxTimeMS(2000).toArray();
    return { items: docs.slice(0, limit).map(publicDoc), nextCursor: docs.length > limit ? String(docs[limit - 1].seq) : null };
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
      return { person: this.personView(p), state: publicDoc(state), concepts: concepts.map(publicDoc), messages: messages.slice(0, 20).reverse().map(publicDoc),
        nextMessagesCursor: messages.length > 20 ? String(messages[19].seq) : null, busy: Boolean(p.activeEpisodeId), episodeId: p.activeEpisodeId };
    });
  }
  async close() { await this.client?.close(); }
}
