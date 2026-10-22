import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

import { digest, LIMITS } from '../../../../agent/yeaft/person/contracts.js';

import { finalProposal } from './fixtures.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const selection = { model: 'test/first', effort: null };
const input = (id = 'one', more = {}) => ({ kind: 'send', text: 'garden [a].* 中文', clientMessageId: id, workerId: 'worker-a', budget: { calls: 1, timeoutMs: 5000 }, ...more });
const call = (r, episode, id = 'call') => r.startCall(episode, { callId: id, requested: selection, effective: selection, request: { secret: 'raw-not-searchable' }, manifest: { sourceRefs: [] } });

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

  it('persists deterministic identity, state, history and complete searchable revisions across reopen', async () => {
    const r = repo();
    const opened = await r.open('alice');
    expect(opened.person.id).toBe(`person-${digest(['default', 'alice']).slice(0, 32)}`);
    expect((await r.open('alice', 'ignored')).person).toEqual(opened.person);
    const { episode } = await r.admit('alice', input());
    await call(r, episode);
    expect(await r.finalizeCall(episode, { callId: 'call', output: { text: 'raw-not-searchable' } })).toBe(true);
    const result = await r.commit(episode, finalProposal(), selection, 'call');
    expect(result.state.version).toBe(1);
    const snapshot = await r.snapshot('alice');
    expect(snapshot.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(snapshot.latestEpisode).toMatchObject({ status: 'completed' });
    const changes = await r.searchChanges('alice');
    expect(changes.items.map(c => c.kind)).toEqual(['messages', 'concepts', 'messages']);
    expect(changes.items[0].record).toEqual(snapshot.messages[0]);
    expect(changes.items[1].record).toEqual(snapshot.concepts[0]);
    expect(changes.items[2].record).toEqual(snapshot.messages[1]);
    expect(JSON.stringify(changes)).not.toContain('raw-not-searchable');
    for (const change of changes.items) {
      expect(change.record).not.toHaveProperty('ownerId'); expect(change.record).not.toHaveProperty('namespace');
      expect(await r.resolveMemories('alice', change.kind, [change])).toEqual([change.record]);
    }
    expect(inspect(r, db => db.prepare('PRAGMA journal_mode').get().journal_mode)).toBe('wal');
    expect(inspect(r, db => db.prepare('PRAGMA foreign_key_check').all())).toEqual([]);
    expect(inspect(r, db => db.prepare('SELECT count(*) AS n FROM concept_revisions').get().n)).toBe(1);
    await r.close();
    const reopened = repo();
    expect(await reopened.snapshot('alice')).toEqual(snapshot);
    expect(await reopened.searchChanges('alice')).toEqual(changes);
    const next = await reopened.admit('alice', input('two'));
    expect(next.episode.epoch).toBeGreaterThan(episode.epoch);
    expect((await reopened.searchChanges('alice', { after: changes.lastSeq })).items[0].seq).toBeGreaterThan(changes.lastSeq);
    expect(await reopened.admit('alice', input())).toMatchObject({ duplicate: true, episodeId: episode.id, status: 'completed' });
  });

  it('serializes independent workers for opens, admission, idempotency and busy exclusion', async () => {
    const a = repo(), b = repo();
    const opened = await Promise.all([a.open('alice'), b.open('alice')]);
    expect(opened[0]).toEqual(opened[1]);
    const results = await Promise.all([a.admit('alice', input()), b.admit('alice', input('one', { workerId: 'worker-b' }))]);
    expect(results[0].episodeId).toBe(results[1].episodeId);
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect((await a.list('alice', 'messages')).items).toHaveLength(1);
    expect((await a.searchChanges('alice')).items).toHaveLength(1);
    const appended = await b.admit('alice', input('different'));
    expect(appended).toMatchObject({ appended: true, episodeId: results[0].episodeId, deliveryState: 'queued' });
    await expect(b.admit('alice', input('busy-think', { kind: 'think' }))).rejects.toMatchObject({ code: 'BUSY' });
    await expect(b.admit('alice', input('one', { text: 'different' }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(b.settings('alice', { autonomyEnabled: false })).resolves.toMatchObject({ settings: { autonomyEnabled: false } });
    await expect(a.heartbeat(results.find(r => !r.duplicate).episode)).resolves.toBeUndefined();
    await b.cancel('alice');
    const races = await Promise.all([a.admit('alice', input('a')), b.admit('alice', input('b'))]);
    expect(races[0].episodeId).toBe(races[1].episodeId);
    expect(races.filter(result => result.appended)).toHaveLength(1);
    expect((await a.list('alice', 'messages')).items.filter(message => ['a', 'b'].includes(message.clientMessageId))).toHaveLength(2);
  });

  it('fences admissions in independent OS processes', async () => {
    const children = [0, 1].map(() => fork(new URL('./sqlite-process-admission.js', import.meta.url), [], {
      env: { ...process.env, PERSON_SQLITE_TEST_DIR: yeaftDir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }));
    try {
      const exits = children.map(child => once(child, 'exit'));
      const ready = await Promise.all(children.map(child => once(child, 'message')));
      for (const [result] of ready) expect(result).toEqual({ ready: true });
      const results = children.map(child => once(child, 'message'));
      children.forEach(child => child.send({ start: true }));
      const admitted = (await Promise.all(results)).map(([result]) => result);
      expect(admitted.every(r => !r.error)).toBe(true);
      expect(admitted[0].episodeId).toBe(admitted[1].episodeId);
      expect(admitted.filter(r => !r.duplicate)).toHaveLength(1);
      await Promise.all(exits);
      const r = repo('processes');
      expect((await r.list('alice', 'messages')).items).toHaveLength(1);
      expect((await r.searchChanges('alice')).items).toHaveLength(1);
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
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

  it('retains only the original cancelled call consumed prefix once while fencing all late state writes', async () => {
    const a = repo(), b = repo(); await a.open('alice');
    const { episode } = await a.admit('alice', input()); await call(a, episode);
    await b.cancel('alice');
    const next = await b.admit('alice', input('two'));
    const terminal = { callId: 'call', output: { text: '已读取', observedBytes: 9, secret: 'must-not-copy' }, effective: { model: 'spoof', effort: 'low', secret: 'must-not-copy' } };
    expect(await a.finalizeCall({ ...episode, workerId: 'imposter' }, terminal)).toBe(false);
    await expect(a.finalizeCall(episode, { ...terminal, output: { text: 'x'.repeat(LIMITS.outputBytes + 1) } })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(await Promise.all([a.finalizeCall(episode, terminal), b.finalizeCall(episode, terminal)])).toEqual([false, false]);
    await expect(a.commit(episode, finalProposal(), selection, 'call')).rejects.toMatchObject({ code: 'STALE' });
    const traces = (await b.list('alice', 'traces', { limit: 50 })).items.filter(t => t.kind === 'call_failed');
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ code: 'CANCELLED', effective: { model: selection.model }, output: { text: '已读取', complete: false, accepted: false, availability: 'captured' } });
    expect(JSON.stringify(traces)).not.toContain('must-not-copy');
    expect((await b.snapshot('alice')).episodeId).toBe(next.episodeId);
    expect((await b.searchChanges('alice')).items).toHaveLength(2);
  });

  it('recovers expired active/cancelled workers without model calls and closes unavailable output once', async () => {
    const r = repo('expiry'); await r.open('alice');
    const one = await r.admit('alice', input()); await call(r, one.episode, 'one');
    // Persist an expired clock boundary rather than racing setup against a tiny lease.
    inspect(r, db => db.prepare("UPDATE persons SET record = json_set(record, '$.leaseUntil', ?) WHERE namespace = ? AND ownerId = ?").run(new Date(0).toISOString(), 'expiry', 'alice'));
    await r.close();
    const reopened = repo('expiry');
    expect(await reopened.recover('alice')).toBe(true);
    expect(await reopened.recover('alice')).toBe(false);
    expect(await reopened.finalizeCall(one.episode, { callId: 'one', output: { text: 'late' } })).toBe(false);
    const two = await reopened.admit('alice', input('two')); await call(reopened, two.episode, 'two'); await reopened.cancel('alice');
    inspect(reopened, db => db.prepare("UPDATE episodes SET callFinalizeUntil = 0, record = json_set(record, '$.callFinalizeUntil', ?) WHERE id = ?").run(new Date(0).toISOString(), two.episode.id));
    await reopened.snapshot('alice');
    expect(await reopened.finalizeCall(two.episode, { callId: 'two', output: { text: 'late' } })).toBe(false);
    const terminals = (await reopened.list('alice', 'traces', { limit: 50 })).items.filter(t => t.kind === 'call_failed');
    expect(terminals).toHaveLength(2);
    expect(terminals.every(t => t.output.availability === 'unavailable' && t.output.observedBytes === null)).toBe(true);
    expect((await reopened.snapshot('alice')).state.version).toBe(0);
    expect((await reopened.searchChanges('alice')).items.every(i => i.record.role === 'user')).toBe(true);
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

  it('fails pending requests safely on worker death and refuses implicit restart; close drains accepted work', async () => {
    const r = repo('crash', { busyTimeoutMs: 1000 }); await r.open('alice');
    const lock = new DatabaseSync(r.dbPath); lock.exec('BEGIN IMMEDIATE');
    try {
      const pending = expect(r.admit('alice', input())).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await sleep(20); await r.worker.terminate(); await pending;
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    await expect(r.snapshot('alice')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await r.close(); await r.close();
    const fresh = repo('crash');
    expect((await fresh.snapshot('alice')).messages).toEqual([]);
    const admitted = fresh.admit('alice', input()); const closed = fresh.close();
    expect((await admitted).duplicate).toBe(false); await closed;
    await expect(fresh.open('bob')).rejects.toMatchObject({ code: 'CLOSED' });
    expect((await repo('crash').list('alice', 'messages')).items).toHaveLength(1);
  });

});
