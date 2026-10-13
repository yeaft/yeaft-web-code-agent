import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
