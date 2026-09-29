import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareModelCache } from '../agent/yeaft/person/local-memory-cache.js';
import { LocalPersonMemory } from '../agent/yeaft/person/local-memory.js';

const cacheModule = new URL('../agent/yeaft/person/local-memory-cache.js', import.meta.url).href;
const memoryModule = new URL('../agent/yeaft/person/local-memory.js', import.meta.url).href;
const model = 'test/model';
const revision = '1'.repeat(40);
const name = 'onnx/model_quantized.onnx';
const bytes = Buffer.from('a complete immutable model artifact');
const artifacts = { [name]: { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
const directories = [];
const memories = [];
const children = [];
async function setup() {
  const yeaftDir = await mkdtemp(path.join(tmpdir(), 'person-cache-'));
  directories.push(yeaftDir);
  const options = { yeaftDir, model, revision, artifacts };
  const dir = path.join(yeaftDir, 'person', 'models', model, revision);
  const file = path.join(dir, name);
  return { options, dir, file };
}
function repository() {
  const record = { id: 'car', revision: 1, text: 'car repairs' };
  return {
    async searchChanges(owner, { after }) { return { items: after ? [] : [{ seq: 1, kind: 'messages', ...record, record }], lastSeq: 1, hasMore: false }; },
    async resolveMemories(owner, kind, refs) { return refs.some(ref => ref.id === record.id) ? [record] : []; },
    async recall() { return { items: [record], nextCursor: null }; },
  };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  for (const memory of memories.splice(0)) await memory.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('atomic instance-local model cache', () => {
  it('validates legacy cache offline and isolates instance, model, and revision', async () => {
    const { options, dir, file } = await setup();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes); // Existing FileCache files need no migration/sidecar.
    const fetcher = vi.fn(() => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetcher);
    expect(await prepareModelCache({ ...options, allowDownload: false })).toBe(dir);
    for (const isolated of [
      { ...options, yeaftDir: path.join(options.yeaftDir, 'other-instance') },
      { ...options, model: 'other/model' },
      { ...options, revision: '2'.repeat(40) },
    ]) await expect(prepareModelCache({ ...isolated, allowDownload: false })).rejects.toThrow('model_cache_incomplete');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unpinned identities and paths outside the model snapshot', async () => {
    const { options } = await setup();
    for (const invalid of [
      { model: '../model' }, { revision: 'main' },
      { artifacts: { '../outside': artifacts[name] } },
      { artifacts: { '/absolute': artifacts[name] } },
    ]) await expect(prepareModelCache({ ...options, ...invalid })).rejects.toThrow(/invalid_model/);
  });

  it('treats truncated and same-size corrupted final files as misses and repairs on retry', async () => {
    const { options, file } = await setup();
    await mkdir(path.dirname(file), { recursive: true });
    const fetcher = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    for (const bad of [bytes.subarray(0, 5), Buffer.alloc(bytes.length, 0)]) {
      await writeFile(file, bad);
      await expect(prepareModelCache({ ...options, allowDownload: false })).rejects.toThrow('model_cache_incomplete');
      await prepareModelCache(options);
      expect(await readFile(file)).toEqual(bytes);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(`https://huggingface.co/${model}/resolve/${revision}/${name}`);
  });

  it.each(['short', 'wrong-hash', 'stream-error', 'http-error'])('does not publish %s downloads; a later attempt recovers', async failure => {
    const { options, file } = await setup();
    let response;
    if (failure === 'short') response = new Response(bytes.subarray(0, 5));
    if (failure === 'wrong-hash') response = new Response(Buffer.alloc(bytes.length));
    if (failure === 'stream-error') response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('disconnected')); } }));
    if (failure === 'http-error') response = new Response('unavailable', { status: 503 });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(prepareModelCache(options)).rejects.toThrow();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.dirname(file))).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    await prepareModelCache(options);
    expect(await readFile(file)).toEqual(bytes);
  });

  it('concurrent publishers cannot expose partial files or remove a successful repair', async () => {
    const { options, file } = await setup();
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let started;
    const writing = new Promise(resolve => { started = resolve; });
    let pulls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      async pull(controller) {
        if (pulls++ === 0) { controller.enqueue(bytes.subarray(0, 8)); return; }
        started();
        await barrier;
        controller.error(new Error('interrupted loser'));
      },
    }))));
    const loser = prepareModelCache(options);
    // Attach rejection before letting the losing writer fail.
    const failed = expect(loser).rejects.toThrow('interrupted loser');
    await writing;
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(prepareModelCache({ ...options, allowDownload: false })).rejects.toThrow('model_cache_incomplete');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    await Promise.all(Array.from({ length: 4 }, () => prepareModelCache(options)));
    release();
    await failed;
    expect(await readFile(file)).toEqual(bytes);
    expect(await readdir(path.dirname(file))).toEqual(['model_quantized.onnx']);
  });

  it('SIGKILL during a real write leaves no published model; restarted explicit Recall repairs and then works offline', async () => {
    const { options, file } = await setup();
    const fixture = path.join(options.yeaftDir, 'cache-embedding.mjs');
    await writeFile(fixture, `
      import { prepareModelCache } from ${JSON.stringify(cacheModule)};
      export function createEmbedding({ yeaftDir, hang, allowDownload = true }) {
        const bytes = Buffer.from(${JSON.stringify(bytes.toString())});
        globalThis.fetch = async () => {
          if (!allowDownload) throw new Error('network forbidden');
          let pulled = false;
          return new Response(new ReadableStream({ async pull(controller) {
            if (!pulled) { pulled = true; controller.enqueue(bytes.subarray(0, 8)); return; }
            if (hang) await new Promise(() => {});
            controller.enqueue(bytes.subarray(8)); controller.close();
          } }));
        };
        return { async embed(texts) {
          await prepareModelCache({ yeaftDir, model: ${JSON.stringify(model)}, revision: ${JSON.stringify(revision)}, artifacts: ${JSON.stringify(artifacts)}, allowDownload });
          return texts.map(() => [1, ...Array(383).fill(0)]);
        } };
      }
    `);
    const base = { repository: repository(), yeaftDir: options.yeaftDir, namespace: 'cache-test', embeddingModule: pathToFileURL(fixture).href, timeoutMs: 10000 };
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { LocalPersonMemory } from ${JSON.stringify(memoryModule)};
      const repository = (${repository.toString()})();
      const memory = new LocalPersonMemory({ ...${JSON.stringify({ ...base, repository: undefined })}, repository, embedding: { hang: true } });
      await memory.recall('owner', { query: 'car' });
    `], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error(stderr);
      const files = await readdir(path.dirname(file));
      const partial = files.find(name => name.endsWith('.partial'));
      expect(partial).toBeTruthy();
      expect((await stat(path.join(path.dirname(file), partial))).size).toBe(8);
    }, { timeout: 5000, interval: 20 });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    expect((await exited)[1]).toBe('SIGKILL');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    // Independent controllers/processes share only this instance's immutable cache.
    const restarted = new LocalPersonMemory(base);
    const peer = new LocalPersonMemory({ ...base, namespace: 'cache-peer' });
    memories.push(restarted, peer);
    const recalls = await Promise.all([restarted, peer].map(memory => memory.recall('owner', { query: 'car' })));
    for (const recall of recalls) {
      expect(recall.retrieval).toMatchObject({ semantic: true, degraded: false });
      expect(recall.items[0].id).toBe('car');
    }
    expect(await readFile(file)).toEqual(bytes);
    await Promise.all([restarted.close(), peer.close()]);
    const offline = new LocalPersonMemory({ ...base, embedding: { allowDownload: false } });
    memories.push(offline);
    expect((await offline.recall('owner', { query: 'car' })).retrieval).toMatchObject({ semantic: true, degraded: false });
  }, 15000);
});
