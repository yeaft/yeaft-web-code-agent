import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { MongoPersonRepository } from '../../../../agent/yeaft/person/repository.js';
import { digest } from '../../../../agent/yeaft/person/contracts.js';
import { validateCreatedDefinition } from '../../../../agent/yeaft/person/created-capability-contract.js';

const definition = (more = {}) => ({ id: 'Script.echo', expectedVersion: 0, description: 'Return the input.', useWhen: 'Need an unchanged JSON value.',
  avoidWhen: '', inputDescription: 'Any JSON value.', outputDescription: 'The same JSON value.', code: 'function run(input) { return input; }',
  tests: [{ input: { createdAt: '2026-10-01T00:00:00.000Z', nested: [1, true, null] }, expected: { createdAt: '2026-10-01T00:00:00.000Z', nested: [1, true, null] } }], ...more });
const evidence = () => ({ engine: 'quickjs', testsPassed: 1, testedAt: new Date().toISOString() });
const input = () => ({ kind: 'send', text: 'hello', clientMessageId: randomUUID(), workerId: 'worker', budget: { calls: 4, timeoutMs: 5000 } });
const finalized = async (r, episode, callId = randomUUID(), code = null) => {
  await r.startCall(episode, { callId, requested: { model: 'test/model', effort: null } });
  await r.finalizeCall(episode, { callId, output: { text: '{}' }, ...(code ? { code } : {}) });
  return callId;
};
const save = (r, episode, callId, more = {}) => r.saveCreatedCapability(episode, { definition: definition(more), evidence: evidence(), callId });

// Real MongoDB is opt-in, isolated replica set only; never reuse the online DB.
for (const backend of ['sqlite', 'mongo']) {
  const suite = backend === 'mongo' && !process.env.PERSON_TEST_MONGO_URI ? describe.skip : describe;
  suite(`Person created capability: ${backend} authority`, () => {
    let yeaftDir, repositories, inspector, MongoClient, dbName;
    const repo = (namespace = 'default') => {
      const r = backend === 'sqlite' ? new SqlitePersonRepository({ yeaftDir, namespace, leaseMs: 60000 })
        : new MongoPersonRepository({ uri: process.env.PERSON_TEST_MONGO_URI, dbName, namespace, MongoClient, leaseMs: 60000 });
      repositories.push(r); return r;
    };
    const sql = (r, fn) => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };
    const records = async (r, table, ownerId = 'alice') => backend === 'mongo'
      ? (await inspector.db(dbName).collection(`person_${table}`).find(r.scope(ownerId)).sort({ id: 1, version: 1 }).toArray()).map(doc => JSON.parse(doc.record))
      : sql(r, db => db.prepare(`SELECT record FROM ${table} WHERE namespace = ? AND ownerId = ? ORDER BY id, version`).all(r.namespace, ownerId).map(row => JSON.parse(row.record)));
    const expire = async r => {
      if (backend === 'mongo') await inspector.db(dbName).collection('person_persons').updateOne(r.scope('alice'), { $set: { leaseUntil: new Date(0) } });
      else sql(r, db => db.prepare("UPDATE persons SET record = json_set(record, '$.leaseUntil', ?) WHERE namespace = ? AND ownerId = ?").run(new Date(0).toISOString(), r.namespace, 'alice'));
    };
    const publicRecord = record => { const { ownerId, personId, namespace, ...rest } = record; return rest; };
    beforeEach(async () => {
      repositories = [];
      if (backend === 'sqlite') yeaftDir = await mkdtemp(join(tmpdir(), 'person-created-capability-'));
      else {
        const module = process.env.PERSON_TEST_MONGO_DRIVER ? pathToFileURL(process.env.PERSON_TEST_MONGO_DRIVER).href : 'mongodb';
        ({ MongoClient } = await import(/* @vite-ignore */ module));
        dbName = `person_created_test_${randomUUID().replaceAll('-', '')}`;
        inspector = new MongoClient(process.env.PERSON_TEST_MONGO_URI); await inspector.connect();
      }
    });
    afterEach(async () => {
      await Promise.all(repositories.map(r => r.close()));
      if (inspector) { await inspector.db(dbName).dropDatabase(); await inspector.close(); }
      if (yeaftDir) await rm(yeaftDir, { recursive: true, force: true });
    });

    it('publishes fenced current definitions with immutable versions, provenance and trace across reopen', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      expect(await r.createdCapabilities(episode)).toEqual([]);
      const callId = await finalized(r, episode);
      const first = await save(r, episode, callId);
      const { expectedVersion, ...stored } = validateCreatedDefinition(definition());
      expect(first).toEqual({ ...stored, schemaVersion: 1, version: 1, revision: digest({ version: 1, definition: stored }),
        evidence: { engine: 'quickjs', testsPassed: 1, testedAt: expect.any(String) }, createdEpisodeId: episode.id, createdCallId: callId,
        createdAt: expect.any(String), updatedAt: expect.any(String) });
      const secondCall = await finalized(r, episode);
      const second = await save(r, episode, secondCall, { expectedVersion: 1, description: 'Identity revised.' });
      expect(second.version).toBe(2); expect(second.revision).not.toBe(first.revision);
      expect(second.createdCallId).toBe(secondCall);
      expect(await r.createdCapabilities(episode)).toEqual([second]);
      expect((await records(r, 'created_capability_revisions')).map(publicRecord)).toEqual([first, second]);
      expect(await records(r, 'created_capabilities')).toEqual([{ ...second, ...r.scope('alice') }]);
      const traces = (await r.list('alice', 'traces', { limit: 50 })).items.filter(t => t.kind === 'capability_created').reverse();
      expect(traces.map(t => [t.callId, t.capabilityManifest, t.evidence])).toEqual([first, second].map(c => [c.createdCallId, { id: c.id, version: c.version, revision: c.revision }, c.evidence]));
      expect((await r.context(episode)).state.version).toBe(0);
      expect(JSON.stringify(await r.snapshot('alice'))).not.toContain('Script.echo');
      if (backend === 'sqlite') {
        expect(await readdir(yeaftDir)).toEqual(['person']);
        expect((await readdir(join(yeaftDir, 'person'))).every(name => /^person\.db(?:-wal|-shm)?$/.test(name))).toBe(true);
        expect((await r.searchChanges('alice')).items.map(item => item.kind)).toEqual(['messages']);
      }
      await r.close();
      const reopened = repo();
      expect(await reopened.createdCapabilities(episode)).toEqual([second]);
      await reopened.cancel('alice');
      const next = await reopened.admit('alice', input());
      expect(await reopened.createdCapabilities(next.episode)).toEqual([second]);
      const third = await save(reopened, next.episode, await finalized(reopened, next.episode), { expectedVersion: 2 });
      expect(third).toMatchObject({ version: 3, createdEpisodeId: next.episode.id });
      expect((await records(reopened, 'created_capability_revisions')).map(publicRecord)).toEqual([first, second, third]);
    });

    it('round trips arbitrary finite JSON test values without BSON or date-key coercion', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
      const value = JSON.parse('{"__proto__":{"safe":true},"constructor":7,"\\u0000":1,"$operator":2,"dot.key":3,"createdAt":"not a date","n":1e+100}');
      const saved = await save(r, episode, callId, { tests: [{ input: value, expected: value }] });
      expect(saved.tests).toEqual([{ input: value, expected: value }]);
      await r.close();
      const reopened = repo();
      expect(await reopened.createdCapabilities(episode)).toEqual([saved]);
      expect((await records(reopened, 'created_capability_revisions')).map(publicRecord)).toEqual([saved]);
    });

    it('isolates identical IDs by authenticated owner and namespace and rejects forged fences', async () => {
      const r = repo(), other = repo('other');
      await Promise.all([r.open('alice'), r.open('bob'), other.open('alice')]);
      const { episode } = await r.admit('alice', input()), bob = await r.admit('bob', input()), stranger = await other.admit('alice', input());
      const callId = await finalized(r, episode);
      const original = await save(r, episode, callId);
      expect(await r.createdCapabilities(bob.episode)).toEqual([]);
      expect(await other.createdCapabilities(stranger.episode)).toEqual([]);
      await expect(save(r, bob.episode, callId)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await save(r, bob.episode, await finalized(r, bob.episode), { description: 'Bob only.' });
      await save(other, stranger.episode, await finalized(other, stranger.episode), { description: 'Other namespace.' });
      for (const forged of [{ ...episode, namespace: 'other' }, { ...episode, personId: bob.episode.personId }, { ...episode, ownerId: 'bob' }, { ...episode, workerId: 'different' }]) {
        await expect(r.createdCapabilities(forged)).rejects.toMatchObject({ code: 'STALE' });
        await expect(save(r, forged, callId, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'STALE' });
      }
      await expect(other.createdCapabilities(episode)).rejects.toMatchObject({ code: 'STALE' });
      expect(await r.createdCapabilities(episode)).toEqual([original]);
    });

    it('requires real finalized successful same-episode call proof; generic append cannot forge it', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      await expect(save(r, episode, 'invented')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await r.startCall(episode, { callId: 'open', requested: { model: 'test/model' } });
      await expect(save(r, episode, 'open')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await r.finalizeCall(episode, { callId: 'open', code: 'PROVIDER_FAILED', output: { text: 'partial' } });
      await expect(save(r, episode, 'open')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      for (const kind of ['call_started', 'call_output', 'call_failed', 'capability_created']) {
        await expect(r.append(episode, kind, { callId: 'forged', output: { complete: true } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      }
      await r.append(episode, 'activity', { kind: 'call_output', callId: 'forged', output: { complete: true }, episodeId: 'forged' });
      await expect(save(r, episode, 'forged')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      const oldCall = await finalized(r, episode);
      await r.cancel('alice');
      const next = await r.admit('alice', input());
      await expect(save(r, next.episode, oldCall)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(await records(r, 'created_capabilities')).toEqual([]);
      expect(await records(r, 'created_capability_revisions')).toEqual([]);
    });

    it('validates definition and executor evidence again at the repository boundary with no writes', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
      const before = await r.getPerson('alice'), traces = await r.list('alice', 'traces', { limit: 50 });
      const valid = { definition: definition(), evidence: evidence(), callId };
      const invalid = [
        { ...valid, definition: definition({ evidence: evidence() }) }, { ...valid, definition: definition({ id: 'Recall' }) },
        { ...valid, definition: definition({ expectedVersion: -1 }) }, { ...valid, definition: definition({ code: 'x'.repeat(8193) }) },
        { ...valid, definition: definition({ tests: [{ input: Infinity, expected: null }] }) },
        ...[{ engine: 'node' }, { testsPassed: 0 }, { testsPassed: 2 }, { testsPassed: 1.5 }, { testedAt: '2026-02-31T00:00:00.000Z' }, { testedAt: 'yesterday' }, { invented: true }].map(fields => ({ ...valid, evidence: { ...valid.evidence, ...fields } })),
        { ...valid, callId: '' }, { ...valid, callId: 'x'.repeat(129) }, { ...valid, ownerId: 'bob' },
      ];
      for (const value of invalid) await expect(r.saveCreatedCapability(episode, value)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      // Bypass the SQLite facade as a worker-boundary regression, not just validation in its caller.
      if (backend === 'sqlite') await expect(r.request('saveCreatedCapability', [episode, invalid[1]])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(await r.getPerson('alice')).toEqual(before);
      expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
      expect(await records(r, 'created_capability_revisions')).toEqual([]);
    });

    it('rejects stale CAS and duplicate publication without history or trace changes', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
      await expect(save(r, episode, callId, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'STALE' });
      await save(r, episode, callId);
      const before = await r.getPerson('alice'), history = await records(r, 'created_capability_revisions'), traces = await r.list('alice', 'traces', { limit: 50 });
      for (const expectedVersion of [0, 2, 31]) await expect(save(r, episode, callId, { expectedVersion })).rejects.toMatchObject({ code: 'STALE' });
      expect(await r.getPerson('alice')).toEqual(before);
      expect(await records(r, 'created_capability_revisions')).toEqual(history);
      expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
    });

    it('serializes competing worker publications so at most one expected version is published', async () => {
      const r = repo(), contender = repo(); await r.open('alice'); await contender.init();
      const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
      const outcomes = await Promise.allSettled([save(r, episode, callId), save(contender, episode, callId, { description: 'Competing.' })]);
      expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
      expect(['STALE', 'STORAGE_UNAVAILABLE']).toContain(outcomes.find(o => o.status === 'rejected').reason.code);
      expect(await records(r, 'created_capability_revisions')).toHaveLength(1);
      expect((await r.list('alice', 'traces', { limit: 50 })).items.filter(t => t.kind === 'capability_created')).toHaveLength(1);
    });

    it('caps distinct IDs and immutable versions independently at 32 per scoped Person', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
      for (let i = 0; i < 32; i++) await save(r, episode, callId, { id: `Script.c${i}` });
      await expect(save(r, episode, callId, { id: 'Script.overflow' })).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
      for (let version = 1; version < 32; version++) await save(r, episode, callId, { id: 'Script.c0', expectedVersion: version });
      await expect(save(r, episode, callId, { id: 'Script.c0', expectedVersion: 32 })).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
      const current = await r.createdCapabilities(episode);
      expect(current).toHaveLength(32); expect(current[0].version).toBe(32);
      const history = await records(r, 'created_capability_revisions');
      expect(history).toHaveLength(63);
      expect(history.filter(c => c.id === 'Script.c0').map(c => c.version)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
      await r.open('bob'); const bob = await r.admit('bob', input());
      expect((await save(r, bob.episode, await finalized(r, bob.episode))).version).toBe(1);
    });

    it('rolls current, revision and trace back together if the trace insert fails', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
      const original = await save(r, episode, callId), before = await r.getPerson('alice'), traces = await r.list('alice', 'traces', { limit: 50 });
      if (backend === 'sqlite') sql(r, db => db.exec("CREATE TRIGGER reject_created BEFORE INSERT ON traces WHEN json_extract(NEW.record, '$.kind') = 'capability_created' BEGIN SELECT RAISE(ABORT, 'probe'); END;"));
      else await inspector.db(dbName).command({ collMod: 'person_traces', validator: { kind: { $ne: 'capability_created' } } });
      await expect(save(r, episode, callId, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect((await records(r, 'created_capabilities')).map(publicRecord)).toEqual([original]);
      expect((await records(r, 'created_capability_revisions')).map(publicRecord)).toEqual([original]);
      expect(await r.getPerson('alice')).toEqual(before);
      expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
    });

    it.each(['cancel', 'expired', 'restart'])('fences late reads/publication after %s without changing history', async mode => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
      await save(r, episode, callId);
      let active = r;
      if (mode === 'cancel') await r.cancel('alice');
      else await expire(r);
      if (mode === 'restart') {
        await r.close(); active = repo();
        await active.recover('alice');
        await active.admit('alice', input());
      }
      const before = await active.getPerson('alice'), history = await records(active, 'created_capability_revisions'), traces = await active.list('alice', 'traces', { limit: 50 });
      await expect(active.createdCapabilities(episode)).rejects.toMatchObject({ code: 'STALE' });
      await expect(save(active, episode, callId, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'STALE' });
      expect(await active.getPerson('alice')).toEqual(before);
      expect(await records(active, 'created_capability_revisions')).toEqual(history);
      expect(await active.list('alice', 'traces', { limit: 50 })).toEqual(traces);
    });
  });
}

describe('Created capability definition contract', () => {
  it('returns the same shape as a detached canonical JSON copy without adding storage fields', () => {
    const original = definition({ tests: [{ input: JSON.parse('{"z":0,"a":{"__proto__":2}}'), expected: [false] }] });
    const copy = validateCreatedDefinition(original);
    expect(copy).toEqual(original); expect(copy).not.toBe(original);
    expect(copy.tests[0].input).not.toBe(original.tests[0].input);
    expect(Object.keys(copy.tests[0].input)).toEqual(['a', 'z']);
    expect(Object.getPrototypeOf(copy.tests[0].input.a)).toBe(Object.prototype);
    expect(copy.tests[0].input.a.__proto__).toBe(2);
    copy.tests[0].input.z = 9; expect(original.tests[0].input.z).toBe(0);
  });
  it('enforces ASCII identifiers, safe CAS numbers, UTF-8 metadata/code budgets and exact fields', () => {
    const invalid = [
      ...['echo', 'Script.A', 'Script.a_b', 'Script.你好', 'Script.a/b', `Script.${'a'.repeat(49)}`].map(id => ({ id })),
      ...[-1, 0.1, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(expectedVersion => ({ expectedVersion })),
      ...['description', 'useWhen', 'inputDescription', 'outputDescription', 'code'].map(field => ({ [field]: ' ' })),
      { avoidWhen: null }, { description: 'é'.repeat(201) }, { code: 'é'.repeat(4097) }, { version: 1 }, { ownerId: 'alice' },
      { tests: [] }, { tests: Array(9).fill({ input: null, expected: null }) }, { tests: [{ input: 1 }] }, { tests: [{ input: null, expected: null, passed: true }] },
    ];
    for (const more of invalid) expect(() => validateCreatedDefinition(definition(more))).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(validateCreatedDefinition(definition({ id: `Script.${'a'.repeat(48)}`, description: 'é'.repeat(200), code: 'x'.repeat(8192) }))).toBeTruthy();
  });
  it('rejects lossy/nonfinite/non-JSON values, sparse arrays, cycles, depth and total-byte overflow', () => {
    const circular = {}; circular.self = circular;
    const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get() { throw new Error('must not execute'); } });
    const values = [undefined, NaN, Infinity, -Infinity, 1n, () => {}, new Date(), new Map(), new Set(), Buffer.from('x'), circular, getter, [undefined], Array(2), { a: undefined }, { a: Symbol('x') }, { [Symbol('x')]: 1 }, 'x'.repeat(4095)];
    for (const value of values) for (const key of ['input', 'expected']) {
      expect(() => validateCreatedDefinition(definition({ tests: [{ input: null, expected: null, [key]: value }] }))).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    }
    let nested = null; for (let i = 0; i < 32; i++) nested = [nested];
    expect(validateCreatedDefinition(definition({ tests: [{ input: nested, expected: 'x'.repeat(4094) }] }))).toBeTruthy();
    expect(() => validateCreatedDefinition(definition({ tests: [{ input: [nested], expected: null }] }))).toThrow();
    expect(() => validateCreatedDefinition(definition({ tests: Array(8).fill({ input: 'x'.repeat(2000), expected: 'x'.repeat(2000) }) }))).toThrow();
  });
});

describe('Mongo created-capability unknown commit outcome', () => {
  it('never invokes withTransaction or replays publication when commit acknowledgement is unknown', async () => {
    const error = Object.assign(new Error('unknown outcome'), { errorLabels: ['UnknownTransactionCommitResult'] });
    const session = { startTransaction: vi.fn(), commitTransaction: vi.fn().mockRejectedValue(error), abortTransaction: vi.fn(),
      inTransaction: () => false, endSession: vi.fn(), withTransaction: vi.fn() };
    const r = new MongoPersonRepository({ namespace: 'test' });
    r.init = vi.fn(); r.client = { startSession: () => session };
    const p = r.scope('alice'), episode = { ...p, id: 'ep', epoch: 1, workerId: 'worker' };
    r.collections = {
      persons: { findOneAndUpdate: vi.fn().mockResolvedValue({ ...p, traceSeq: 1 }) },
      episodes: { findOne: vi.fn().mockResolvedValue({ status: 'running' }) },
      traces: { findOne: vi.fn().mockResolvedValue({ output: { complete: true } }), insertOne: vi.fn() },
      created_capabilities: { findOne: vi.fn().mockResolvedValue(null), countDocuments: vi.fn().mockResolvedValue(0), insertOne: vi.fn() },
      created_capability_revisions: { insertOne: vi.fn() },
    };
    await expect(save(r, episode, 'call')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(session.withTransaction).not.toHaveBeenCalled();
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(r.collections.created_capabilities.insertOne).toHaveBeenCalledTimes(1);
    expect(r.collections.created_capability_revisions.insertOne).toHaveBeenCalledTimes(1);
    expect(r.collections.traces.insertOne).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
});
