import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

const manifest = (id = 'Recall', version = 1, revision = 'a'.repeat(64)) => ({ id, version, revision });
const result = (callId = 'call-1', m = manifest()) => ({ callId, capability: { id: m.id, args: { query: 'private query' } },
  capabilityManifest: m, result: { instructions: 'not authority', access: 'read-only', items: ['private result'] } });
const input = (id = randomUUID(), kind = 'send') => ({ kind, text: kind === 'send' ? 'hello' : '', clientMessageId: id, workerId: 'worker', budget: { calls: 4, timeoutMs: 5000 } });

describe('Person capability experience: SQLite persistence', () => {
  let yeaftDir, repositories;
  const repo = (namespace = 'default') => {
    const r = new SqlitePersonRepository({ yeaftDir, namespace, leaseMs: 60000 });
    repositories.push(r); return r;
  };
  const sql = (r, fn) => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };

  beforeEach(async () => {
    repositories = [];
    yeaftDir = await mkdtemp(join(tmpdir(), 'person-capability-experience-'));
  });
  afterEach(async () => {
    await Promise.all(repositories.map(r => r.close()));
    if (yeaftDir) await rm(yeaftDir, { recursive: true, force: true });
  });

  it('isolates namespace/owner/person and rejects forged episode identities', async () => {
    const r = repo(), other = repo('other');
    await Promise.all([r.open('alice'), r.open('bob'), other.open('alice')]);
    const { episode } = await r.admit('alice', input());
    const bob = await r.admit('bob', input()), stranger = await other.admit('alice', input());
    await r.append(episode, 'capability_result', result());
    expect((await r.context(bob.episode)).capabilityExperience).toEqual([]);
    expect((await other.context(stranger.episode)).capabilityExperience).toEqual([]);
    for (const forged of [{ ...episode, namespace: 'other' }, { ...episode, personId: 'person-other' }, { ...episode, ownerId: 'bob' }]) {
      await expect(r.append(forged, 'capability_result', result('forged'))).rejects.toMatchObject({ code: 'STALE' });
    }
    await expect(other.append(episode, 'capability_result', result('forged'))).rejects.toMatchObject({ code: 'STALE' });
    expect((await r.context(episode)).capabilityExperience[0].observations).toHaveLength(1);
  });

  it('rolls experience back if the trace insert fails after the person mutation', async () => {
    const r = repo(); await r.open('alice');
    const { episode } = await r.admit('alice', input());
    const before = await r.getPerson('alice'), traces = await r.list('alice', 'traces', { limit: 50 });
    sql(r, db => db.exec("CREATE TRIGGER reject_probe BEFORE INSERT ON traces WHEN json_extract(NEW.record, '$.rollbackProbe') = 1 BEGIN SELECT RAISE(ABORT, 'probe'); END;"));
    await expect(r.append(episode, 'capability_result', { ...result(), rollbackProbe: 1 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await r.getPerson('alice')).toEqual(before);
    expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
  });
});
