import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { digest } from '../../../../agent/yeaft/person/contracts.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { finalProposal, config } from './fixtures.js';

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

  it('waits within the startup budget for WAL lock upgrades without retrying logical writes', async () => {
    const r = repo('startup', { busyTimeoutMs: 1500 });
    await (await import('node:fs/promises')).mkdir(join(yeaftDir, 'person'));
    const lock = new DatabaseSync(r.dbPath);
    lock.exec('CREATE TABLE seed (id INTEGER); BEGIN; SELECT * FROM seed;');
    let settled = false;
    const opening = r.open('alice').finally(() => { settled = true; });
    // Attach failure handling before the wait, including on the regressed version.
    const checked = expect(opening).resolves.toMatchObject({ person: { name: 'Digital Person' } });
    try { await sleep(250); expect(settled).toBe(false); }
    finally { lock.exec('ROLLBACK'); lock.close(); }
    await checked;
    expect(inspect(r, db => db.prepare('PRAGMA journal_mode').get().journal_mode)).toBe('wal');
  });

  it('bounds a startup WAL lock wait and permits a later explicit fresh repository', async () => {
    const r = repo('startup-timeout', { busyTimeoutMs: 150 });
    await (await import('node:fs/promises')).mkdir(join(yeaftDir, 'person'));
    const lock = new DatabaseSync(r.dbPath);
    lock.exec('CREATE TABLE seed (id INTEGER); BEGIN; SELECT * FROM seed;');
    const started = Date.now();
    try {
      await expect(r.open('alice')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    await expect(r.open('alice')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const fresh = repo('startup-timeout');
    await fresh.open('alice');
    expect((await fresh.snapshot('alice')).state.version).toBe(0);
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
    await expect(b.admit('alice', input('different'))).rejects.toMatchObject({ code: 'BUSY' });
    await expect(b.admit('alice', input('one', { text: 'different' }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(b.settings('alice', { autonomyEnabled: false })).rejects.toMatchObject({ code: 'BUSY' });
    await b.cancel('alice');
    const races = await Promise.allSettled([a.admit('alice', input('a')), b.admit('alice', input('b'))]);
    expect(races.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(races.find(r => r.status === 'rejected').reason.code).toBe('BUSY');
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

  it('rolls back earlier concept writes, revisions, counters and journal when a later revision/focus is stale', async () => {
    const r = repo(); await r.open('alice');
    const { episode } = await r.admit('alice', input());
    const before = await r.searchChanges('alice');
    const wrong = finalProposal();
    wrong.concepts.push({ ...wrong.concepts[0], id: 'missing', expectedRevision: 100 });
    await expect(r.commit(episode, wrong, selection, 'bad')).rejects.toMatchObject({ code: 'STALE' });
    expect((await r.snapshot('alice')).state.version).toBe(0);
    expect((await r.snapshot('alice')).busy).toBe(true);
    expect((await r.recall('alice', { kind: 'concepts' })).items).toEqual([]);
    expect(await r.searchChanges('alice')).toEqual(before);
    for (const table of ['concepts', 'concept_revisions', 'state_commits']) {
      expect(inspect(r, db => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)).toBe(0);
    }
    const badFocus = finalProposal(); badFocus.state.focusConceptIds.push('missing');
    await expect(r.commit(episode, badFocus, selection, 'bad-focus')).rejects.toMatchObject({ code: 'STALE' });
    expect(await r.searchChanges('alice')).toEqual(before);
    await r.commit(episode, finalProposal(), selection, 'good');
    await expect(r.commit(episode, finalProposal(), selection, 'duplicate')).rejects.toMatchObject({ code: 'STALE' });
    const original = (await r.snapshot('alice')).concepts[0];
    const next = await r.admit('alice', input('two', { kind: 'think', text: '' }));
    const revision = finalProposal(1); revision.concepts[0].expectedRevision = 1; revision.concepts[0].statement = 'Revised fully.';
    await r.commit(next.episode, revision, selection, 'revision');
    expect(await r.resolveMemories('alice', 'concepts', [original])).toEqual([]);
    expect(await r.resolveMemories('alice', 'concepts', [{ id: original.id, revision: 2 }])).toMatchObject([{ revision: 2, statement: 'Revised fully.' }]);
    expect((await r.searchChanges('alice')).items.filter(c => c.kind === 'concepts').map(c => c.revision)).toEqual([1, 2]);
  });

  it.each(['epoch', 'controlVersion', 'inputWatermark', 'baseStateVersion', 'workerId', 'id'])('rejects every %s fence mismatch without journal side effects', async field => {
    const r = repo(); await r.open('alice');
    const { episode } = await r.admit('alice', input());
    const before = await r.searchChanges('alice');
    const stale = { ...episode, [field]: typeof episode[field] === 'number' ? episode[field] + 1 : 'other' };
    await expect(r.heartbeat(stale)).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.context(stale)).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.append(stale, 'activity', {})).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.commit(stale, finalProposal(), selection, 'call')).rejects.toMatchObject({ code: 'STALE' });
    expect(await r.finish(stale, 'failed', 'STALE')).toBe(false);
    expect(await r.searchChanges('alice')).toEqual(before);
  });

  it('retains only the original cancelled call consumed prefix once while fencing all late state writes', async () => {
    const a = repo(), b = repo(); await a.open('alice');
    const { episode } = await a.admit('alice', input()); await call(a, episode);
    await b.cancel('alice');
    const next = await b.admit('alice', input('two'));
    const terminal = { callId: 'call', output: { text: '已读取', observedBytes: 9, secret: 'must-not-copy' }, effective: { model: 'spoof', effort: 'low', secret: 'must-not-copy' } };
    expect(await a.finalizeCall({ ...episode, workerId: 'imposter' }, terminal)).toBe(false);
    await expect(a.finalizeCall(episode, { ...terminal, output: { text: 'x'.repeat(65537) } })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
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

  it('paginates literal Unicode recall and durable scope-filtered changes without gaps', async () => {
    const r = repo(); await r.open('alice'); await r.open('bob');
    for (let i = 0; i < 5; i++) {
      await r.admit('alice', input(`a-${i}`)); await r.cancel('alice');
      await r.admit('bob', input(`b-${i}`)); await r.cancel('bob');
    }
    const capability = new PersonCapabilities(r, 'alice');
    await capability.execute({ id: 'catalog.view', args: { id: 'Recall' } });
    const ids = []; let cursor = null;
    do {
      const result = await capability.execute({ id: 'Recall', args: { kind: 'messages', query: '[a].* 中文', limit: 2, cursor } });
      ids.push(...result.items.map(m => m.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(5);
    expect((await r.recall('alice', { query: '.*NOPE' })).items).toEqual([]);
    const changes = []; let after = 0, more;
    do {
      const page = await r.searchChanges('alice', { after, limit: 2 });
      changes.push(...page.items); after = page.lastSeq; more = page.hasMore;
    } while (more);
    expect(changes.map(c => c.seq)).toEqual([1, 3, 5, 7, 9]);
    expect(new Set(changes.map(c => c.id))).toEqual(new Set(ids));
    expect(await r.searchChanges('alice', { after })).toEqual({ items: [], lastSeq: 9, hasMore: false });
    await expect(r.searchChanges('alice', { after: -1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(r.searchChanges('alice', { limit: 1001 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('filters Unicode literal projections before scoped keyset paging and preserves original records on reopen/update', async () => {
    const r = repo(), other = repo('other');
    await Promise.all([r.open('alice'), r.open('bob'), other.open('alice')]);
    const original = "ÉCOLE ЖУК İ 𐐀 中文 [a].* %_\\ ' OR 1=1 --";
    const query = "école жук i\u0307 𐐨 中文 [a].* %_\\ ' or 1=1 --";
    const seed = async (repository, owner, n, value, version) => {
      const { episode } = await repository.admit(owner, input(`unicode-${n}`, { text: value }));
      const proposal = finalProposal(version);
      proposal.reply = ''; proposal.concepts[0].id = `concept-${6 - n}`; proposal.concepts[0].statement = value;
      proposal.state.focusConceptIds = [proposal.concepts[0].id];
      await repository.commit(episode, proposal, selection, 'unicode');
    };
    // Nonmatches between hits must not consume LIMIT or lose matching page tails.
    for (let i = 0; i < 7; i++) await seed(r, 'alice', i, i % 2 ? 'not a match' : original, i);
    await seed(r, 'bob', 0, original, 0); await seed(other, 'alice', 0, original, 0);
    await r.close();
    const reopened = repo();
    for (const kind of ['messages', 'concepts']) {
      const items = []; let cursor = null;
      do {
        const page = await reopened.recall('alice', { kind, query, cursor, limit: 2 });
        expect(page.items).toHaveLength(2);
        items.push(...page.items); cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(items.map(item => item.id)).size).toBe(4);
      expect(items.map(item => kind === 'messages' ? item.seq : item.id)).toEqual(kind === 'messages' ? [7, 5, 3, 1] : ['concept-0', 'concept-2', 'concept-4', 'concept-6']);
      for (const item of items) {
        expect(item[kind === 'messages' ? 'text' : 'statement']).toBe(original);
        expect(item).not.toHaveProperty('ownerId'); expect(item).not.toHaveProperty('namespace');
      }
      for (const literal of ['éCOLE', 'Жук', '[a].*', '%_\\', "' OR 1=1 --"]) {
        expect((await reopened.recall('alice', { kind, query: literal, limit: 10 })).items).toHaveLength(4);
      }
      expect((await reopened.recall('alice', { kind, query: '[a].*NOPE' })).items).toEqual([]);
      expect((await reopened.recall('alice', { kind, limit: 10 })).items).toHaveLength(7);
    }
    expect(inspect(reopened, db => db.prepare('SELECT text, record FROM messages WHERE ownerId = ? AND seq = 1').get('alice'))).toMatchObject({ text: query });
    const { episode } = await reopened.admit('alice', input('revision', { kind: 'think', text: '' }));
    const revision = finalProposal(7);
    Object.assign(revision.concepts[0], { id: 'concept-0', expectedRevision: 1, statement: 'ÉTÉ révisé' });
    revision.state.focusConceptIds = ['concept-0']; revision.reply = 'RÉPONSE';
    await reopened.commit(episode, revision, selection, 'revision');
    expect((await reopened.recall('alice', { kind: 'concepts', query, limit: 10 })).items).toHaveLength(3);
    expect((await reopened.recall('alice', { kind: 'concepts', query: 'été RÉVISÉ' })).items).toMatchObject([{ id: 'concept-0', revision: 2, statement: 'ÉTÉ révisé' }]);
    expect((await reopened.recall('alice', { query: 'réponse' })).items).toMatchObject([{ role: 'assistant', text: 'RÉPONSE' }]);
  });

  it('rolls back admission if the same-transaction journal fails', async () => {
    const r = repo(); await r.open('alice');
    inspect(r, db => db.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON memory_changes BEGIN SELECT RAISE(ABORT, 'secret-path-and-input'); END"));
    await expect(r.admit('alice', input())).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', message: 'Digital person storage is unavailable.' });
    expect((await r.list('alice', 'messages')).items).toEqual([]);
    expect((await r.snapshot('alice')).busy).toBe(false);
    expect((await r.getPerson('alice')).inputWatermark).toBe(0);
    expect((await r.searchChanges('alice')).items).toEqual([]);
    inspect(r, db => db.exec('DROP TRIGGER fail_journal'));
    expect((await r.admit('alice', input())).duplicate).toBe(false);
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

  it('bounds writer contention in the worker, keeps the event loop free, and retries only explicitly', async () => {
    const r = repo('busy', { busyTimeoutMs: 150 }); await r.open('alice');
    const lock = new DatabaseSync(r.dbPath); lock.exec('BEGIN IMMEDIATE');
    try {
      let ticks = 0; const timer = setInterval(() => ticks++, 5);
      const started = Date.now();
      try { await expect(r.admit('alice', input())).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
      finally { clearInterval(timer); }
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(Date.now() - started).toBeLessThan(2000); expect(ticks).toBeGreaterThan(3);
      expect((await r.searchChanges('alice')).items).toEqual([]);
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    expect((await r.admit('alice', input())).duplicate).toBe(false);
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

  it('times out a queued worker without retrying an ambiguous write and bounds pending work', async () => {
    const r = repo('timeout', { busyTimeoutMs: 100, maxPending: 4 }); await r.open('alice');
    r.requestTimeoutMs = 250; // Exercise a queued request timeout, not worker startup scheduling.
    const lock = new DatabaseSync(r.dbPath); lock.exec('BEGIN IMMEDIATE');
    try {
      const pending = [0, 1, 2, 3].map(i => r.admit('alice', input(`queued-${i}`)).catch(error => error));
      await expect(r.admit('alice', input('overflow'))).rejects.toMatchObject({ code: 'BUSY' });
      const results = await Promise.all(pending);
      expect(results.every(r => r.code === 'STORAGE_UNAVAILABLE')).toBe(true);
      expect(r.failed).toBe(true);
      await expect(r.snapshot('alice')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    await r.close();
    expect((await repo('timeout').snapshot('alice')).messages).toEqual([]);
  });

  it('sanitizes startup errors and enforces bounded configuration/requests', async () => {
    await writeFile(join(yeaftDir, 'person'), 'not-a-directory');
    const r = repo();
    await expect(r.open('alice')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', message: 'Digital person storage is unavailable.' });
    expect(() => repo('bad;sql')).toThrow();
    expect(() => repo('valid', { busyTimeoutMs: 5001 })).toThrow();
    const unopened = new SqlitePersonRepository({ yeaftDir }); repositories.push(unopened);
    await unopened.close(); await expect(unopened.init()).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it.each(['local', 'remote'])('the runtime drains %s cancellation, ignoring a late provider completion', async mode => {
    const a = repo('runtime-cancel', { leaseMs: 1200 }), b = repo('runtime-cancel');
    let release, consumed;
    const waiting = new Promise(resolve => { release = resolve; });
    const providerConsumed = new Promise(resolve => { consumed = resolve; });
    const adapter = { async *stream() {
      yield { type: 'text_delta', text: '{"partial":"已读取"' };
      consumed(); await waiting;
      yield { type: 'text_delta', text: JSON.stringify(finalProposal()) };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const runtime = new PersonRuntime({ repository: a, getProvider: () => createPersonProvider({ config, adapter }), budget: { calls: 1, timeoutMs: 5000 } }); runtimes.push(runtime);
    await a.open('alice');
    const admitted = await a.admit('alice', input('cancel', { workerId: runtime.workerId })); runtime.start(admitted.episode);
    const done = runtime.running.get(admitted.episodeId).promise;
    await providerConsumed;
    await (mode === 'local' ? a : b).cancel('alice');
    if (mode === 'local') runtime.cancel(admitted.episodeId);
    try { await done; } finally { release(); }
    await sleep(10);
    const snapshot = await b.snapshot('alice');
    expect(snapshot.state.version).toBe(0); expect(snapshot.messages).toHaveLength(1);
    const terminals = (await b.list('alice', 'traces', { limit: 50 })).items.filter(t => ['call_output', 'call_failed'].includes(t.kind));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ kind: 'call_failed', code: 'CANCELLED', output: { text: '{"partial":"已读取"', complete: false, accepted: false, availability: 'captured' } });
    expect((await b.searchChanges('alice')).items).toHaveLength(1);
  });

  it('shares real SQLite authority between two services', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    let providerCalls = 0;
    const adapter = { async *stream() {
      providerCalls++; await waiting;
      yield { type: 'text_delta', text: JSON.stringify(finalProposal()) };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    let a, b;
    try {
      const options = { namespace: 'services', yeaftDir, config, adapter };
      a = createPersonService(options); b = createPersonService(options);
      expect(await a.request({ ownerId: 'alice', op: 'status' })).toMatchObject({ storageReady: true, modelReady: true });
      await Promise.all([a, b].map(s => s.request({ ownerId: 'alice', op: 'open' })));
      await b.request({ ownerId: 'alice', op: 'snapshot' }); expect(providerCalls).toBe(0);
      const request = { ownerId: 'alice', op: 'send', payload: { text: 'service ÉCOLE input', clientMessageId: 'same' } };
      const results = await Promise.all([a.request(request), b.request(request)]);
      expect(results[0].episodeId).toBe(results[1].episodeId);
      expect(results.filter(r => !r.duplicate)).toHaveLength(1);
      await vi.waitFor(() => expect(providerCalls).toBe(1));
      await expect(b.request({ ...request, payload: { ...request.payload, clientMessageId: 'other' } })).rejects.toMatchObject({ code: 'BUSY' });
      release();
      await vi.waitFor(async () => expect((await b.request({ ownerId: 'alice', op: 'snapshot' })).state.version).toBe(1), { timeout: 5000 });
      const authority = repo('services');
      expect((await authority.searchChanges('alice')).items).toHaveLength(3);
      const recall = new PersonCapabilities(authority, 'alice');
      await recall.execute({ id: 'catalog.view', args: { id: 'Recall' } });
      expect((await recall.execute({ id: 'Recall', args: { kind: 'messages', query: 'école' } })).items).toMatchObject([{ text: 'service ÉCOLE input' }]);
      expect(await a.request(request)).toMatchObject({ duplicate: true, status: 'completed' });
    } finally {
      release(); await Promise.all([a?.close(), b?.close()]);
    }
  });

  it('runs the existing runtime/provider/capabilities contract across independent repositories', async () => {
    const a = repo('runtime'), b = repo('runtime');
    let providerCalls = 0;
    const adapter = { async *stream(params) {
      providerCalls++;
      const context = JSON.parse(params.messages[0].content);
      const proposal = finalProposal(context.state.version);
      yield { type: 'text_delta', text: JSON.stringify(proposal) };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const getProvider = () => createPersonProvider({ config, adapter });
    const runtime = new PersonRuntime({ repository: a, getProvider, budget: { calls: 1, timeoutMs: 5000 } }); runtimes.push(runtime);
    await a.open('alice'); await b.snapshot('alice'); expect(providerCalls).toBe(0);
    const admissions = await Promise.all([a.admit('alice', input('runtime', { workerId: runtime.workerId })), b.admit('alice', input('runtime', { workerId: 'other' }))]);
    const accepted = admissions.find(r => !r.duplicate); runtime.start(accepted.episode);
    await runtime.running.get(accepted.episode.id).promise;
    const snapshot = await b.snapshot('alice');
    expect(snapshot.state.version).toBe(1); expect(providerCalls).toBe(1);
    expect(snapshot.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect((await b.searchChanges('alice')).items).toHaveLength(3);
  });
});
