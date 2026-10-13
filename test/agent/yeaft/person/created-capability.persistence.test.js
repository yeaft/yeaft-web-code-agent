import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

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

describe('Person created capability: SQLite authority', () => {
  let yeaftDir, repositories;
  const repo = (namespace = 'default') => {
    const r = new SqlitePersonRepository({ yeaftDir, namespace, leaseMs: 60000 });
    repositories.push(r); return r;
  };
  const sql = (r, fn) => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };
  const records = async (r, table, ownerId = 'alice') => sql(r, db => db.prepare(`SELECT record FROM ${table} WHERE namespace = ? AND ownerId = ? ORDER BY id, version`).all(r.namespace, ownerId).map(row => JSON.parse(row.record)));

  const publicRecord = record => { const { ownerId, personId, namespace, ...rest } = record; return rest; };
  beforeEach(async () => {
    repositories = [];
    yeaftDir = await mkdtemp(join(tmpdir(), 'person-created-capability-'));
  });
  afterEach(async () => {
    await Promise.all(repositories.map(r => r.close()));
    if (yeaftDir) await rm(yeaftDir, { recursive: true, force: true });
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

  it('serializes competing worker publications so at most one expected version is published', async () => {
    const r = repo(), contender = repo(); await r.open('alice'); await contender.init();
    const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
    const outcomes = await Promise.allSettled([save(r, episode, callId), save(contender, episode, callId, { description: 'Competing.' })]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(['STALE', 'STORAGE_UNAVAILABLE']).toContain(outcomes.find(o => o.status === 'rejected').reason.code);
    expect(await records(r, 'created_capability_revisions')).toHaveLength(1);
    expect((await r.list('alice', 'traces', { limit: 50 })).items.filter(t => t.kind === 'capability_created')).toHaveLength(1);
  });

  it('rolls current, revision and trace back together if the trace insert fails', async () => {
    const r = repo(); await r.open('alice');
    const { episode } = await r.admit('alice', input()), callId = await finalized(r, episode);
    const original = await save(r, episode, callId), before = await r.getPerson('alice'), traces = await r.list('alice', 'traces', { limit: 50 });
    sql(r, db => db.exec("CREATE TRIGGER reject_created BEFORE INSERT ON traces WHEN json_extract(NEW.record, '$.kind') = 'capability_created' BEGIN SELECT RAISE(ABORT, 'probe'); END;"));
    await expect(save(r, episode, callId, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect((await records(r, 'created_capabilities')).map(publicRecord)).toEqual([original]);
    expect((await records(r, 'created_capability_revisions')).map(publicRecord)).toEqual([original]);
    expect(await r.getPerson('alice')).toEqual(before);
    expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
  });
});
