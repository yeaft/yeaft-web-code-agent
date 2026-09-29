import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalPersonMemory } from '../agent/yeaft/person/local-memory.js';

class Authority {
  constructor() { this.journal = []; this.records = new Map(); this.calls = []; }
  put(owner, id, text, revision = 1, kind = 'messages') {
    const record = { id, revision, ...(kind === 'messages' ? { text } : { statement: text }) };
    this.records.set(`${owner}:${kind}:${id}`, record);
    this.journal.push({ seq: this.journal.length + 1, owner, kind, id, revision, record });
  }
  async searchChanges(owner, { after, limit }) {
    this.calls.push(after);
    const all = this.journal.filter(x => x.owner === owner && x.seq > after);
    const items = all.slice(0, limit);
    return { items, lastSeq: items.at(-1)?.seq ?? after, hasMore: all.length > limit };
  }
  async resolveMemories(owner, kind, refs) {
    return refs.map(ref => this.records.get(`${owner}:${kind}:${ref.id}`)).filter(r => r && refs.some(ref => ref.id === r.id && ref.revision === r.revision));
  }
  async recall(owner, { kind = 'messages', query = '', limit = 5, cursor = null }) {
    const items = [...this.records].filter(([key, r]) => key.startsWith(`${owner}:${kind}:`) && (r.text ?? r.statement).toLowerCase().includes(query.toLowerCase()))
      .map(([, r]) => r).sort((a, b) => a.id.localeCompare(b.id)).filter(r => !cursor || r.id > cursor);
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1].id : null };
  }
}

const resources = [];
async function setup(options = {}, repository = new Authority(), dir) {
  dir ??= await mkdtemp(path.join(tmpdir(), 'person-recall-'));
  const memory = new LocalPersonMemory({ repository, yeaftDir: dir, namespace: 'person', embeddingModule: new URL('./fixtures/person-local-embedding.js', import.meta.url).href, ...options });
  resources.push({ memory, dir });
  return { memory, repository, dir };
}
afterEach(async () => {
  for (const { memory } of resources) await memory.close();
  for (const dir of new Set(resources.map(r => r.dir))) await rm(dir, { recursive: true, force: true });
  resources.length = 0;
});

const probe = new DatabaseSync(':memory:');
let hasFts = false;
try { probe.exec('CREATE VIRTUAL TABLE f USING fts5(t)'); hasFts = true; } catch {} finally { probe.close(); }

it.skipIf(hasFts)('explicitly degrades without FTS5 on older supported Node builds, without starting embedding', async () => {
  const { memory, repository } = await setup();
  repository.put('alice', 'memory', 'remember this literal text');
  for (let i = 0; i < 2; i++) {
    const result = await memory.recall('alice', { query: 'literal text' });
    expect(result.items[0].id).toBe('memory');
    expect(result.retrieval).toMatchObject({ mode: 'literal', semantic: false, degraded: true, reasons: ['FTS_UNAVAILABLE'] });
  }
});

describe.skipIf(!hasFts)('local Person recall (real SQLite, deterministic injected vectors)', () => {
  it('is lazy, preserves browse, and performs hybrid semantic retrieval without lexical overlap', async () => {
    const { memory, repository, dir } = await setup();
    repository.put('alice', 'travel', 'My automobile needs servicing');
    repository.put('alice', 'food', 'fresh oranges');
    expect(memory.status().workerStarted).toBe(false);
    expect((await memory.recall('alice', { query: '' })).items).toHaveLength(2);
    expect(memory.status().workerStarted).toBe(false);
    await expect(access(path.join(dir, 'person'))).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await memory.recall('alice', { query: 'car repairs' });
    expect(result.items[0].id).toBe('travel');
    expect(result.retrieval).toMatchObject({ mode: 'hybrid', semantic: true, degraded: false });
    const db = new DatabaseSync(path.join(dir, 'person/recall.db'));
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(db.prepare('SELECT length(vector) AS n FROM chunks WHERE vector IS NOT NULL LIMIT 1').get().n).toBe(384 * 4);
    db.close();
  });

  it('chunks the entire record and safely tokenizes Chinese/English FTS queries', async () => {
    const { memory, repository } = await setup({ embedding: { enabled: false } });
    repository.put('alice', 'long', `${'前面的内容 filler '.repeat(300)} 最后讨论数据库恢复和 WAL checkpoint`);
    const zh = await memory.recall('alice', { query: '数据库恢复' });
    expect(zh.items.map(r => r.id)).toEqual(['long']);
    const en = await memory.recall('alice', { query: '"checkpoint" OR * NEAR(' });
    expect(en.items.map(r => r.id)).toEqual(['long']);
    expect(en.retrieval.semantic).toBe(false);
  });

  it('isolates owners, kinds, and namespaces sharing the same database', async () => {
    const { memory, repository, dir } = await setup();
    repository.put('alice', 'same', 'car repairs');
    repository.put('bob', 'secret', 'car repairs');
    repository.put('alice', 'concept', 'car repairs', 1, 'concepts');
    expect((await memory.recall('alice', { query: 'car' })).items.map(r => r.id)).toEqual(['same']);
    expect((await memory.recall('bob', { query: 'car' })).items.map(r => r.id)).toEqual(['secret']);
    expect((await memory.recall('alice', { kind: 'concepts', query: 'car' })).items.map(r => r.id)).toEqual(['concept']);
    const other = await setup({ namespace: 'other' }, new Authority(), dir);
    expect((await other.memory.recall('alice', { query: 'car' })).items).toEqual([]);
    await expect(memory.recall('', { query: 'car' })).rejects.toThrow(/owner/i);
  });

  it('checks authority revisions at delivery, including stable snapshot pagination', async () => {
    const { memory, repository } = await setup({ embedding: { enabled: false } });
    for (const id of ['a', 'b', 'c']) repository.put('alice', id, 'checkpoint');
    const first = await memory.recall('alice', { query: 'checkpoint', limit: 1 });
    expect(first.nextCursor).toMatch(/^[a-zA-Z0-9:]{1,128}$/);
    repository.put('alice', 'b', 'no longer related', 2);
    repository.put('alice', 'd', 'checkpoint');
    const second = await memory.recall('alice', { query: 'checkpoint', cursor: first.nextCursor, limit: 5 });
    expect(second.items.map(r => r.id)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
    await expect(memory.recall('bob', { query: 'checkpoint', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect((await memory.recall('alice', { query: 'checkpoint', limit: 10 })).items.map(r => r.id)).toEqual(['a', 'c', 'd']);
  });

  it('falls back to FTS on model failure and retries instead of poisoning the loader', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'person-model-failure-'));
    const marker = path.join(dir, 'fail');
    await writeFile(marker, 'fail');
    const { memory, repository } = await setup({ embedding: { failFile: marker, retryDelayMs: 0 } }, undefined, dir);
    repository.put('alice', 'a', 'car repairs');
    const failed = await memory.recall('alice', { query: 'car' });
    expect(failed.items[0].id).toBe('a');
    expect(failed.retrieval).toMatchObject({ mode: 'keyword', semantic: false, degraded: true });
    expect(failed.retrieval.reasons).toContain('embedding_unavailable');
    await rm(marker);
    expect((await memory.recall('alice', { query: 'car' })).retrieval.semantic).toBe(true);
  });

  it('persists atomic journal checkpoints across restart and rebuilds a deleted index', async () => {
    const { memory, repository, dir } = await setup({ embedding: { enabled: false }, journalBatchSize: 1 });
    repository.put('alice', 'a', 'checkpoint', 1);
    repository.put('alice', 'a', 'checkpoint newer', 2);
    await memory.recall('alice', { query: 'checkpoint' });
    await memory.close();
    repository.calls.length = 0;
    const reopened = await setup({ embedding: { enabled: false } }, repository, dir);
    expect((await reopened.memory.recall('alice', { query: 'newer' })).items[0].revision).toBe(2);
    expect(repository.calls[0]).toBe(2);
    await reopened.memory.close();
    await rm(path.join(dir, 'person/recall.db'));
    repository.calls.length = 0;
    const rebuilt = await setup({ embedding: { enabled: false } }, repository, dir);
    expect((await rebuilt.memory.recall('alice', { query: 'newer' })).items[0].revision).toBe(2);
    expect(repository.calls[0]).toBe(0);
  });

  it('reports exact scan and embedding coverage caps rather than claiming unlimited semantic recall', async () => {
    const { memory, repository } = await setup({ maxVectorChunks: 2, maxEmbedChunksPerRecall: 1 });
    for (const id of ['a', 'b', 'c']) repository.put('alice', id, 'car repairs');
    const result = await memory.recall('alice', { query: 'car' });
    expect(result.retrieval.coverage).toMatchObject({ totalChunks: 3, vectorEligibleChunks: 2, vectorScannedChunks: 1, maxVectorChunks: 2 });
    expect(result.retrieval.reasons).toContain('semantic_coverage_limited');
    expect(result.retrieval.degraded).toBe(true);
  });

  it('bounds queue wait, terminates slow model work, and leaves the Agent event loop responsive', async () => {
    const { memory, repository } = await setup({ maxQueue: 1, timeoutMs: 100, embedding: { delayMs: 1000 } });
    repository.put('alice', 'a', 'car');
    const pending = memory.recall('alice', { query: 'car' });
    await expect(memory.recall('alice', { query: 'car' })).rejects.toMatchObject({ code: 'RECALL_BUSY' });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const result = await pending;
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
    expect(result.retrieval).toMatchObject({ mode: 'literal', reasons: ['RECALL_TIMEOUT'] });
    await memory.close();
    await expect(memory.recall('alice', { query: 'car' })).rejects.toMatchObject({ code: 'MEMORY_CLOSED' });
  });

  it('cancels active and queued episode recalls without fallback or later inference', async () => {
    const { memory, repository } = await setup({ embedding: { delayMs: 10000 }, shutdownTimeoutMs: 1000 });
    repository.put('alice', 'a', 'car');
    let fallbacks = 0;
    memory.literalRecall = async () => { fallbacks++; return { items: [], nextCursor: null }; };
    const activeController = new AbortController(), queuedController = new AbortController();
    const active = memory.recall('alice', { query: 'car' }, { signal: activeController.signal });
    const worker = memory.worker;
    const exited = new Promise(resolve => worker.once('exit', resolve));
    const queued = memory.recall('alice', { query: 'car' }, { signal: queuedController.signal });
    const settled = Promise.allSettled([active, queued]);
    queuedController.abort();
    expect(memory.queue).toHaveLength(0);
    activeController.abort();
    expect((await settled).map(result => result.reason.code)).toEqual(['RECALL_CANCELLED', 'RECALL_CANCELLED']);
    await exited;
    expect(fallbacks).toBe(0);
    expect(memory.status()).toMatchObject({ workerStarted: false, queued: 0 });
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await expect(memory.recall('alice', { query: 'car' }, { signal: alreadyAborted.signal })).rejects.toMatchObject({ code: 'RECALL_CANCELLED' });
    expect(memory.worker).toBeNull();
    memory.options.embedding.delayMs = 0;
    expect((await memory.recall('alice', { query: 'car' })).items[0].id).toBe('a');
  });

  it('rejects active and queued work on bounded shutdown without orphaning a worker', async () => {
    const { memory, repository } = await setup({ embedding: { delayMs: 10000 }, shutdownTimeoutMs: 50 });
    repository.put('alice', 'a', 'car');
    const active = memory.recall('alice', { query: 'car' });
    const queued = memory.recall('alice', { query: 'car' });
    const settled = Promise.allSettled([active, queued]);
    const worker = memory.worker;
    const exited = new Promise(resolve => worker.once('exit', resolve));
    await memory.close();
    expect((await settled).map(result => result.reason.code)).toEqual(['MEMORY_CLOSED', 'MEMORY_CLOSED']);
    await exited;
    expect(memory.status()).toMatchObject({ workerStarted: false, queued: 0, closed: true });
  });

  it('rolls back a malformed batch and its checkpoint together, then replays after repair', async () => {
    const { memory, repository, dir } = await setup({ embedding: { enabled: false } });
    repository.put('alice', 'a', 'checkpoint');
    repository.put('alice', 'b', 'checkpoint');
    repository.journal[1].record = { id: 'b' };
    expect((await memory.recall('alice', { query: 'checkpoint' })).retrieval.mode).toBe('literal');
    const db = new DatabaseSync(path.join(dir, 'person/recall.db'));
    expect(db.prepare('SELECT count(*) AS n FROM chunks').get().n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM checkpoints').get().n).toBe(0);
    db.close();
    repository.journal[1].record = repository.records.get('alice:messages:b');
    expect((await memory.recall('alice', { query: 'checkpoint' })).items).toHaveLength(2);
  });

  it('reports bounded catchup and resumes on the next explicit recall without skipping records', async () => {
    const { memory, repository } = await setup({ embedding: { enabled: false }, journalBatchSize: 1, maxJournalPages: 1 });
    for (const id of ['a', 'b', 'c']) repository.put('alice', id, 'checkpoint');
    const partial = await memory.recall('alice', { query: 'checkpoint' });
    expect(partial.retrieval.reasons).toContain('journal_catchup_limited');
    expect(partial.items).toHaveLength(1);
    await memory.recall('alice', { query: 'checkpoint' });
    const complete = await memory.recall('alice', { query: 'checkpoint' });
    expect(complete.retrieval.journal).toEqual({ checkpoint: 3, caughtUp: true });
    expect(complete.items).toHaveLength(3);
  });

  it('rebuilds on fingerprint changes and never mixes spaces across live workers', async () => {
    const { memory, repository, dir } = await setup();
    repository.put('alice', 'a', 'car');
    await memory.recall('alice', { query: 'car' });
    repository.calls.length = 0;
    const changed = await setup({ embedding: { fingerprint: 'changed' } }, repository, dir);
    const result = await changed.memory.recall('alice', { query: 'car' });
    expect(repository.calls[0]).toBe(0);
    expect(result.retrieval.fingerprint).toContain('changed');
    repository.calls.length = 0;
    const original = await memory.recall('alice', { query: 'car' });
    expect(repository.calls[0]).toBe(0);
    expect(original.retrieval.fingerprint).not.toContain('changed');
  });

  it('rejects expired and query-mismatched cursors and omits stale first-page records', async () => {
    const { memory, repository } = await setup({ embedding: { enabled: false }, snapshotTtlMs: 30 });
    for (const id of ['a', 'b']) repository.put('alice', id, 'checkpoint');
    const page = await memory.recall('alice', { query: 'checkpoint', limit: 1 });
    await expect(memory.recall('alice', { query: 'different', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await new Promise(resolve => setTimeout(resolve, 35));
    await expect(memory.recall('alice', { query: 'checkpoint', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    const originalResolve = repository.resolveMemories.bind(repository);
    repository.resolveMemories = async (...args) => {
      repository.put('alice', 'a', 'changed after ranking', 2);
      return originalResolve(...args);
    };
    expect((await memory.recall('alice', { query: 'checkpoint' })).items.map(r => r.id)).toEqual(['b']);
  });

  it('deduplicates long records before candidate limits in both retrieval channels', async () => {
    const { memory, repository } = await setup({ candidateLimit: 2, embedding: { enabled: false } });
    repository.put('alice', 'a', 'checkpoint '.repeat(1000));
    repository.put('alice', 'b', 'checkpoint');
    const keyword = await memory.recall('alice', { query: 'checkpoint' });
    expect(keyword.items.map(r => r.id).sort()).toEqual(['a', 'b']);
    const hybrid = await setup({ candidateLimit: 2 }, repository);
    const semantic = await hybrid.memory.recall('alice', { query: 'different vocabulary' });
    expect(semantic.items.map(r => r.id).sort()).toEqual(['a', 'b']);
  });

  it('removes journal tombstones and excludes deleted snapshot records', async () => {
    const { memory, repository } = await setup({ embedding: { enabled: false } });
    for (const id of ['a', 'b']) repository.put('alice', id, 'checkpoint');
    const page = await memory.recall('alice', { query: 'checkpoint', limit: 1 });
    repository.records.delete('alice:messages:b');
    repository.journal.push({ owner: 'alice', seq: 3, kind: 'messages', id: 'b', revision: 2, record: null });
    expect((await memory.recall('alice', { query: 'checkpoint', cursor: page.nextCursor })).items).toEqual([]);
    const next = await memory.recall('alice', { query: 'checkpoint' });
    expect(next.items.map(r => r.id)).toEqual(['a']);
    expect(next.retrieval.coverage.totalChunks).toBe(1);
  });

  it('recovers from a killed worker by replaying only durable journal progress', async () => {
    const { memory, repository } = await setup({ embedding: { enabled: false } });
    repository.put('alice', 'a', 'checkpoint');
    await memory.recall('alice', { query: 'checkpoint' });
    const worker = memory.worker;
    await new Promise(resolve => { worker.once('exit', resolve); worker.kill('SIGKILL'); });
    repository.put('alice', 'b', 'checkpoint');
    repository.calls.length = 0;
    const recovered = await memory.recall('alice', { query: 'checkpoint' });
    expect(repository.calls[0]).toBe(1);
    expect(recovered.items).toHaveLength(2);
    expect(recovered.retrieval.mode).toBe('keyword');
  });

  it('keeps fallback reads within the same bounded queue slot', async () => {
    const { memory, repository, dir } = await setup({ maxQueue: 1 });
    await writeFile(path.join(dir, 'person'), 'not a directory');
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    memory.literalRecall = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const first = memory.recall('alice', { query: 'literal' });
    await entered;
    await expect(memory.recall('alice', { query: 'literal' })).rejects.toMatchObject({ code: 'RECALL_BUSY' });
    release({ items: [], nextCursor: null });
    expect((await first).retrieval.mode).toBe('literal');
  });

  it('releases the queue if the episode is cancelled during a fallback read', async () => {
    const { memory, dir } = await setup({ maxQueue: 1 });
    await writeFile(path.join(dir, 'person'), 'not a directory');
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    memory.literalRecall = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const controller = new AbortController();
    const recall = memory.recall('alice', { query: 'literal' }, { signal: controller.signal });
    const rejected = expect(recall).rejects.toMatchObject({ code: 'RECALL_CANCELLED' });
    await started;
    controller.abort();
    await rejected;
    release({ items: [], nextCursor: 'late-cursor' });
    await vi.waitFor(() => expect(memory.active).toBeNull());
    expect(memory.snapshots.size).toBe(0);
    memory.literalRecall = async () => ({ items: [], nextCursor: null });
    expect((await memory.recall('alice', { query: 'literal' })).retrieval.mode).toBe('literal');
  });

  it('uses literal authoritative fallback with pagination if the derived index fails', async () => {
    const { memory, repository, dir } = await setup();
    await writeFile(path.join(dir, 'person'), 'not a directory');
    repository.put('alice', 'a', 'literal');
    repository.put('alice', 'b', 'literal');
    const first = await memory.recall('alice', { query: 'literal', limit: 1 });
    expect(first.retrieval).toMatchObject({ mode: 'literal', semantic: false, degraded: true });
    expect(first.items[0].id).toBe('a');
    expect((await memory.recall('alice', { query: 'literal', cursor: first.nextCursor, limit: 1 })).items[0].id).toBe('b');
  });
});
