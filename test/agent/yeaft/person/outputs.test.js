import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from './fixture-adapter.js';

import { normalizePresentation } from '../../../../agent/yeaft/response-presentation.js';

import { bytes } from '../../../../agent/yeaft/person/contracts.js';
import { projectPersonConversation } from '../../../../web/utils/person-conversation.js';

let root, workDir, repositories, r, episode;
const repo = (namespace = 'default') => {
  const repository = new SqlitePersonRepository({ yeaftDir: join(root, 'data'), namespace, leaseMs: 60000 });
  repositories.push(repository); return repository;
};
const admit = async (repository = r, owner = 'alice') => {
  await repository.open(owner);
  return (await repository.admit(owner, { kind: 'send', text: 'deliver', clientMessageId: randomUUID(), workerId: 'worker', budget: { calls: 16 } })).episode;
};
const prepare = async (args, current = episode, repository = r, directory = workDir) => {
  const cap = new PersonCapabilities(repository, current.ownerId, { episode: current, workDir: directory });
  await cap.execute({ id: 'catalog.view', args: { id: 'Output.publish' } });
  const callId = randomUUID(), invocation = { id: 'Output.publish', args };
  await repository.startCall(current, { callId, requested: { model: 'test/model', effort: null } });
  await repository.finalizeCall(current, { callId, output: { text: '{}' } });
  await repository.startCapability(current, { callId, capability: invocation });
  return async () => {
    try { return await cap.execute(invocation, { callId }); }
    finally { await repository.finalizeCapability(current, { callId, capability: invocation }); }
  };
};
const publish = async (args, ...rest) => (await prepare(args, ...rest))();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'person-outputs-')); workDir = join(root, 'workspace');
  await mkdir(workDir); repositories = []; r = repo(); episode = await admit();
});
afterEach(async () => { await Promise.all(repositories.map(repository => repository.close())); await rm(root, { recursive: true, force: true }); });

describe('Person durable output delivery', () => {
  it('snapshots bytes immutably, associates the episode and survives deletion, cancellation and reopen', async () => {
    await writeFile(join(workDir, 'notes.md'), '# Delivered\n中文');
    const item = await publish({ file_path: 'notes.md', title: 'Notes' });
    expect(item).toEqual({ id: expect.any(String), title: 'Notes', kind: 'file', mimeType: 'text/markdown', size: 18, episodeId: episode.id, createdAt: expect.any(String) });
    expect(JSON.stringify(item)).not.toContain(workDir);
    await writeFile(join(workDir, 'notes.md'), 'changed'); await rm(join(workDir, 'notes.md'));
    await r.cancel('alice'); await r.close(); r = repo();
    expect((await r.outputs('alice')).items).toEqual([item]);
    const read = await r.outputRead('alice', { outputId: item.id });
    expect(Buffer.from(read.data, 'base64').toString()).toBe('# Delivered\n中文');
    expect(read).toMatchObject({ outputId: item.id, offset: 0, nextOffset: 18, eof: true, totalBytes: 18, mimeType: 'text/markdown' });
    expect((await r.snapshot('alice')).outputs).toEqual({ items: [item], nextCursor: null });
  });

  it('isolates owner, namespace and forged Person identity before reading or publication', async () => {
    const item = await publish({ url: 'https://example.com/' });
    const foreign = repo('other'); await foreign.open('alice'); await r.open('bob');
    expect((await r.outputs('bob')).items).toEqual([]); expect((await foreign.outputs('alice')).items).toEqual([]);
    await expect(r.outputRead('bob', { outputId: item.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(foreign.outputRead('alice', { outputId: item.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(prepare({ url: 'https://example.com/' }, { ...episode, personId: 'foreign' })).rejects.toMatchObject({ code: 'STALE' });
  });

  it('fences publication after cancellation but retains previously confirmed partial effects', async () => {
    const first = await publish({ url: 'https://example.com/partial' });
    const late = await prepare({ url: 'https://example.com/late' });
    await r.cancel('alice');
    await expect(late()).rejects.toMatchObject({ code: 'STALE' });
    expect((await r.outputs('alice')).items).toEqual([first]);
  });

  it('rejects outside traversal, symlink files/directories, directories and oversized files without leaking paths', async () => {
    await writeFile(join(root, 'secret'), 'private'); await mkdir(join(workDir, 'dir'));
    await symlink(join(root, 'secret'), join(workDir, 'link')); await symlink(root, join(workDir, 'linked-dir'));
    await writeFile(join(workDir, 'local.txt'), 'allowed'); await symlink(join(workDir, 'local.txt'), join(workDir, 'local-link'));
    for (const file_path of ['../secret', join(root, 'secret'), 'link', 'linked-dir/secret', 'local-link', 'dir', 'missing']) {
      await expect(publish({ file_path })).rejects.toMatchObject({ code: 'OUTPUT_PATH' });
    }
    await writeFile(join(workDir, 'huge'), ''); await truncate(join(workDir, 'huge'), 10 * 1024 * 1024 + 1);
    await expect(publish({ file_path: 'huge' })).rejects.toMatchObject({ code: 'OUTPUT_QUOTA' });
    expect((await r.outputs('alice')).items).toEqual([]);
  });

  it('stores links without fetching and reads only files with bounded raw byte offsets', async () => {
    const link = await publish({ url: 'http://127.0.0.1:1/unreachable?q=x', title: 'External link' });
    expect(link).toMatchObject({ kind: 'link', url: 'http://127.0.0.1:1/unreachable?q=x', size: 0, mimeType: null });
    await expect(r.outputRead('alice', { outputId: link.id })).rejects.toMatchObject({ code: 'OUTPUT_NOT_FILE' });
    const bytes = Buffer.alloc(65539, 0xab); await writeFile(join(workDir, 'raw.bin'), bytes);
    const file = await publish({ file_path: 'raw.bin' });
    const head = await r.outputRead('alice', { outputId: file.id, maxBytes: 65536 });
    expect(Buffer.from(head.data, 'base64')).toEqual(bytes.subarray(0, 65536)); expect(head.eof).toBe(false);
    const tail = await r.outputRead('alice', { outputId: file.id, offset: head.nextOffset });
    expect(Buffer.from(tail.data, 'base64')).toEqual(bytes.subarray(65536)); expect(tail.eof).toBe(true);
    expect(await r.outputRead('alice', { outputId: file.id, offset: bytes.length })).toMatchObject({ data: '', eof: true });
    for (const patch of [{ offset: -1 }, { offset: 1.5 }, { offset: bytes.length + 1 }, { offset: null }, { maxBytes: 65537 }, { maxBytes: 0 }, { maxBytes: null }, { outputId: '../raw.bin' }, { path: '/etc/passwd' }]) {
      await expect(r.outputRead('alice', { outputId: file.id, ...patch })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('exposes status, recent snapshot and validated read-only pages without a provider', async () => {
    const first = await publish({ url: 'https://example.com/1' }); const second = await publish({ url: 'https://example.com/2' });
    const service = createPersonService({ yeaftDir: join(root, 'data'), workDir, embedding: { enabled: false } });
    try {
      const request = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
      expect(await request('status')).toMatchObject({ outputsSupported: true });
      expect((await request('snapshot')).outputs.items).toEqual([second, first]);
      const page = await request('outputs', { limit: 1 }); expect(page.items).toEqual([second]); expect(page.nextCursor).toEqual(expect.any(String));
      expect(await request('outputs', { cursor: page.nextCursor, limit: 1 })).toEqual({ items: [first], nextCursor: null });
      for (const payload of [{ limit: 51 }, { limit: null }, { cursor: '../file' }, { cursor: 1 }, { file_path: '/etc/passwd' }]) await expect(request('outputs', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(request('output_read', { outputId: first.id })).rejects.toMatchObject({ code: 'OUTPUT_NOT_FILE' });
      await expect(request('Output.publish', { file_path: '/etc/passwd' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    } finally { await service.close(); }
  });

});

describe('Person presentation publication', () => {
  const args = { summary: 'Verified comparison: Alpha 2, Beta 3.', blocks: [
    { type: 'chart', style: 'bar', labels: ['Alpha', 'Beta'], series: [{ label: 'Count', values: [2, 3] }] },
    { type: 'table', columns: ['Name', 'Count'], rows: [['Alpha', '2'], ['Beta', '3']] },
  ] };
  let root, repositories, r, episode;
  const repo = (namespace = 'default') => {
    const repository = new SqlitePersonRepository({ yeaftDir: root, namespace, leaseMs: 60000 });
    repositories.push(repository); return repository;
  };
  async function prepare(input = args, current = episode, repository = r) {
    const cap = new PersonCapabilities(repository, current.ownerId, { episode: current });
    await cap.execute({ id: 'catalog.view', args: { id: 'PresentResponse' } });
    const callId = randomUUID(), capability = { id: 'PresentResponse', args: input };
    await repository.startCall(current, { callId, requested: { model: 'test/first', effort: null } });
    await repository.finalizeCall(current, { callId, output: { text: '{}' } });
    await repository.startCapability(current, { callId, capability });
    return { callId, capability, publish: options => cap.execute(capability, { callId, ...options }),
      finish: result => repository.finalizeCapability(current, { callId, capability, result }) };
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'person-presentation-')); repositories = []; r = repo();
    await r.open('alice');
    episode = (await r.admit('alice', { kind: 'send', text: 'Compare the verified counts', clientMessageId: randomUUID(), workerId: 'worker', budget: { calls: 16 } })).episode;
  });
  afterEach(async () => { await Promise.all(repositories.map(repository => repository.close())); await rm(root, { recursive: true, force: true }); });

  describe('Person structured response contract and fenced publication', () => {
    it('publishes canonical JSON and searchable summary live, without a cognitive commit or terminal success', async () => {
      const started = await prepare(); const result = await started.publish();
      expect(result).toMatchObject({ ok: true, published: true, phase: 'final', summary: args.summary });
      const snapshot = await r.snapshot('alice'), message = snapshot.messages.at(-1);
      expect(message).toMatchObject({ role: 'assistant', callId: started.callId, episodeId: episode.id,
        replyKind: 'presentation', text: args.summary, presentation: normalizePresentation(args) });
      expect(message).not.toHaveProperty('publicationHash'); expect(message).not.toHaveProperty('ownerId');
      expect(snapshot).toMatchObject({ busy: true, state: { version: 0 }, latestEpisode: { status: 'running' } });
      expect((await r.list('alice', 'messages')).items[0]).toEqual(message);
      expect((await r.recall('alice', { kind: 'messages', query: 'verified comparison' })).items).toEqual([message]);
      expect((await r.search('alice', { query: 'verified comparison' })).items).toEqual([message]);
      const changes = await r.searchChanges('alice');
      expect(changes.items.at(-1).record).toEqual(message);
      expect(await r.resolveMemories('alice', 'messages', [{ id: message.id, revision: 1 }])).toEqual([message]);
      expect((await r.context(episode)).messages.at(-1)).toEqual(message);
      const blocks = projectPersonConversation([...snapshot.messages, { id: 'plain', role: 'assistant', episodeId: episode.id, text: 'A distinct later reply.' }]);
      expect(blocks.at(-1).parts.map(m => m.id)).toEqual([message.id, 'plain']);
      await started.finish(result);
    });

    it('deduplicates retries and repeated deliveries but rejects changed invocation hashes', async () => {
      const started = await prepare(), first = await started.publish();
      expect(await started.publish()).toEqual(first);
      await started.finish(first);
      expect(await started.publish()).toEqual(first); // Lost receipt after finalize, same live episode.
      const repeated = await prepare(), second = await repeated.publish();
      expect(second.messageId).toBe(first.messageId);
      await repeated.finish(second);
      expect(await repeated.publish()).toEqual(second); // A duplicate invocation also has its own receipt.
      await expect(r.savePresentation(episode, { callId: repeated.callId, args: { ...args, summary: 'Different' } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect((await r.snapshot('alice')).messages.filter(m => m.role === 'assistant')).toHaveLength(1);
      await r.cancel('alice');
      await expect(started.publish()).rejects.toMatchObject({ code: 'STALE' });
    });

  });
});
