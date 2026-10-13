import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe('local Person recall (real SQLite, deterministic injected vectors)', () => {

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

  it('waits for a transient initialization lock and does not expose a partial projection', async () => {
    const { dir } = await setup();
    const directory = path.join(dir, 'person');
    await mkdir(directory, { recursive: true });
    const locker = new DatabaseSync(path.join(directory, 'recall.db'));
    locker.exec('CREATE TABLE lock_fixture(value); BEGIN IMMEDIATE;');
    const worker = new Worker(new URL('../agent/yeaft/person/local-memory-worker.js', import.meta.url), {
      workerData: { yeaftDir: dir, namespace: 'locked-start' },
    });
    let locked = true;
    try {
      const online = once(worker, 'online');
      const response = once(worker, 'message');
      worker.postMessage({ id: 1, op: 'checkpoint', owner: 'owner' });
      await online;
      await new Promise(resolve => setTimeout(resolve, 500));
      locker.exec('ROLLBACK'); locked = false;
      expect((await response)[0]).toEqual({ id: 1, value: 0 });
      // The initialization completed before dispatch: every table and trigger exists.
      expect(locker.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('spaces','checkpoints','chunks','chunk_fts','chunks_insert','chunks_delete')").get().n).toBe(6);
    } finally {
      if (locked) locker.exec('ROLLBACK');
      await worker.terminate();
      locker.close();
    }
  });

  it('bounds initialization contention and can initialize again after the lock is released', async () => {
    const { dir } = await setup();
    await mkdir(path.join(dir, 'person'), { recursive: true });
    const locker = new DatabaseSync(path.join(dir, 'person', 'recall.db'));
    locker.exec('CREATE TABLE lock_fixture(value); BEGIN IMMEDIATE;');
    const worker = new Worker(new URL('../agent/yeaft/person/local-memory-worker.js', import.meta.url), {
      workerData: { yeaftDir: dir, namespace: 'locked-retry' },
    });
    let locked = true;
    try {
      const response = once(worker, 'message');
      worker.postMessage({ id: 1, op: 'checkpoint', owner: 'owner' });
      expect((await response)[0]).toEqual({ id: 1, error: { code: 'ERR_SQLITE_ERROR' } });
      locker.exec('ROLLBACK'); locked = false;
      const retried = once(worker, 'message');
      worker.postMessage({ id: 2, op: 'checkpoint', owner: 'owner' });
      expect((await retried)[0]).toEqual({ id: 2, value: 0 });
    } finally {
      if (locked) locker.exec('ROLLBACK');
      await worker.terminate();
      locker.close();
    }
  });

  it('initializes concurrent cold projections without degrading Recall', async () => {
    const { dir } = await setup();
    const controllers = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const repository = new Authority(); repository.put('owner', 'car', 'car repairs');
      return (await setup({ namespace: `cold-${index}` }, repository, dir)).memory;
    }));
    const recalls = await Promise.all(controllers.map(memory => memory.recall('owner', { query: 'car' })));
    for (const recall of recalls) {
      expect(recall.retrieval, JSON.stringify(recall.retrieval)).toMatchObject({ semantic: true, degraded: false });
      expect(recall.items[0].id).toBe('car');
    }
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
});
