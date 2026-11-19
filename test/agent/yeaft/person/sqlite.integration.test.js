import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

import { finalProposal } from './fixtures.js';

const selection = { model: 'test/first', effort: null };
const input = (id = 'one', more = {}) => ({ kind: 'send', text: 'garden [a].* 中文', clientMessageId: id, workerId: 'worker-a', budget: { calls: 1, timeoutMs: 5000 }, ...more });

describe('Person real SQLite authority in managed workers', () => {
  let yeaftDir, repositories, runtimes;
  const repo = (namespace = 'default', more = {}) => {
    const r = new SqlitePersonRepository({ yeaftDir, namespace, leaseMs: 10000, ...more }); repositories.push(r); return r;
  };
  const inspect = (r, fn) => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };
  beforeEach(async () => { yeaftDir = await mkdtemp(join(tmpdir(), 'person-sqlite-')); repositories = []; runtimes = []; });
  afterEach(async () => {
    await Promise.all(runtimes.map(r => r.close()));
    await Promise.all(repositories.map(r => r.close()));
    await rm(yeaftDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('isolates opaque authenticated owners and namespaces in every read, journal and revision resolver', async () => {
    const a = repo(), other = repo('other');
    await Promise.all([a.open('alice'), a.open('bob'), other.open('alice')]);
    const { episode } = await a.admit('alice', input());
    await a.commit(episode, finalProposal(), selection, 'call');
    const snapshot = await a.snapshot('alice');
    for (const [r, owner] of [[a, 'bob'], [other, 'alice']]) {
      expect((await r.snapshot(owner)).messages).toEqual([]);
      expect((await r.recall(owner, { kind: 'concepts' })).items).toEqual([]);
      expect((await r.list(owner, 'traces')).items).toEqual([]);
      expect(await r.searchChanges(owner)).toEqual({ items: [], lastSeq: 0, hasMore: false });
      expect(await r.resolveMemories(owner, 'messages', snapshot.messages)).toEqual([]);
      expect(await r.resolveMemories(owner, 'concepts', snapshot.concepts)).toEqual([]);
    }
    await expect(other.context(episode)).rejects.toMatchObject({ code: 'STALE' });
    const malicious = "' OR 1=1 --";
    await a.open(malicious);
    expect((await a.searchChanges(malicious)).items).toEqual([]);
    await expect(a.list('bob', 'messages; DROP TABLE persons', {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(a.list('bob', 'messages', {}, { ownerId: 'alice' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(a.resolveMemories('alice', 'traces', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rolls back state, concepts and their journal if the final assistant journal insert fails', async () => {
    const r = repo(); await r.open('alice');
    const { episode } = await r.admit('alice', input());
    const before = await r.searchChanges('alice');
    inspect(r, db => db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON memory_changes WHEN NEW.kind = 'messages' AND json_extract(NEW.record, '$.role') = 'assistant' BEGIN SELECT RAISE(ABORT, 'secret'); END"));
    await expect(r.commit(episode, finalProposal(), selection, 'failed')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await r.searchChanges('alice')).toEqual(before);
    expect((await r.snapshot('alice')).state.version).toBe(0);
    expect((await r.snapshot('alice')).busy).toBe(true);
    expect((await r.recall('alice', { kind: 'concepts' })).items).toEqual([]);
    expect(inspect(r, db => db.prepare('SELECT count(*) AS n FROM concept_revisions').get().n)).toBe(0);
    inspect(r, db => db.exec('DROP TRIGGER fail_assistant'));
    await r.commit(episode, finalProposal(), selection, 'success');
    expect((await r.searchChanges('alice')).items.map(c => c.seq)).toEqual([1, 2, 3]);
  });

});
