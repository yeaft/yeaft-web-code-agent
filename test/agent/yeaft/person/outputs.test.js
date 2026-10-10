import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { DatabaseSync } from 'node:sqlite';
import { config, finalProposal } from './fixtures.js';
import { outputFilePublicationSupport, snapshotOutput } from '../../../../agent/yeaft/person/outputs.js';

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
  it('discovers a Person-only delivery capability with an explicitly prepared contract', async () => {
    const cap = new PersonCapabilities(r, 'alice', { episode, workDir });
    expect(cap.catalog().nativeTools).not.toContain('Output.publish');
    await expect(cap.execute({ id: 'Output.publish', args: { url: 'https://example.com/' } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const found = await cap.execute({ id: 'catalog.search', args: { query: 'deliver' } });
    expect(found.items.map(item => item.id)).toContain('Output.publish');
  });

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

  it('adds the output table to a schema-1 database without rewriting existing identity or episodes', async () => {
    const person = await r.getPerson('alice'); await r.close();
    const db = new DatabaseSync(r.dbPath);
    try { db.exec('DROP TABLE outputs;'); expect(db.prepare('PRAGMA user_version').get().user_version).toBe(1); }
    finally { db.close(); }
    r = repo();
    expect((await r.getPerson('alice')).personId).toBe(person.personId);
    expect((await r.snapshot('alice')).latestEpisode.id).toBe(episode.id);
    expect((await r.outputs('alice')).items).toEqual([]);
    expect(await publish({ url: 'https://example.com/migrated' })).toMatchObject({ episodeId: episode.id });
  });

  it.each(['win32', 'darwin'])('explicitly reports unsupported file publication on %s while preserving link delivery and reads', async platform => {
    await writeFile(join(workDir, 'notes.md'), '# Stored before platform change');
    const file = await publish({ file_path: 'notes.md' });
    const unsupportedFile = await prepare({ file_path: 'notes.md' });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const service = createPersonService({ config, embedding: { enabled: false } });
    try {
      Object.defineProperty(process, 'platform', { ...original, value: platform });
      expect(outputFilePublicationSupport()).toMatchObject({ supported: false, reason: expect.stringContaining('Linux') });
      expect(await service.request({ ownerId: 'alice', op: 'status' })).toMatchObject({ outputsSupported: true, outputsFileSupported: false, outputsFileReason: expect.stringContaining('Linux') });
      expect(() => snapshotOutput(workDir, 'notes.md')).toThrow(expect.objectContaining({ code: 'OUTPUT_PLATFORM' }));
      await expect(unsupportedFile()).rejects.toMatchObject({ code: 'OUTPUT_PLATFORM' });
      expect(await publish({ url: 'https://example.com/portable' })).toMatchObject({ kind: 'link' });
      expect(Buffer.from((await r.outputRead('alice', { outputId: file.id })).data, 'base64').toString()).toBe('# Stored before platform change');
    } finally { Object.defineProperty(process, 'platform', original); await service.close(); }
  });

  it('bounds default titles by UTF-8 bytes without rejecting legal long filenames; explicit overlong titles still fail', async () => {
    const name = `${'文'.repeat(82)}.md`; // 249 bytes: legal filesystem name, above the 240-byte public limit.
    await writeFile(join(workDir, name), '# Long filename');
    const item = await publish({ file_path: name });
    expect(Buffer.byteLength(item.title)).toBeLessThanOrEqual(240);
    expect(item.title).toMatch(/…\.md$/); expect(item.title).not.toContain('\ufffd');
    expect(Buffer.from((await r.outputRead('alice', { outputId: item.id })).data, 'base64').toString()).toBe('# Long filename');
    await expect(publish({ file_path: name, title: '文'.repeat(81) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('does not accept a fabricated publication trace through the generic append API', async () => {
    await expect(r.append(episode, 'output_published', { output: { id: randomUUID() } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await r.outputs('alice')).items).toEqual([]);
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

  it.each([{}, { file_path: 'x', url: 'https://example.com/' }, { url: 'file:///etc/passwd' }, { url: 'javascript:alert(1)' }, { url: 'https://u:p@example.com/' }, { url: 'http://user@example.com/' }, { url: 'data:text/html,x' }, { url: 12 }, { url: ' https://example.com/' }, { url: 'https://example.com/', path: '/etc/passwd' }])('validates exactly one source and credential-free HTTP(S): %j', async args => {
    await expect(publish(args)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
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

  it('uses byte signatures and strict UTF-8, not untrusted image/PDF/JSON filenames', async () => {
    for (const [name, data, mime] of [
      ['fake.png', '<script>unsafe</script>', 'application/octet-stream'], ['fake.pdf', 'not a pdf', 'application/octet-stream'],
      ['actual.png', Buffer.from('89504e470d0a1a0a00000000', 'hex'), 'image/png'], ['actual.pdf', '%PDF-1.7\n', 'application/pdf'],
      ['view.html', '<h1>report</h1>', 'text/html'], ['code.js', 'const a = 1;', 'text/plain'],
      ['data.json', '{"ok":true}', 'application/json'], ['bad.json', '<html>no</html>', 'text/plain'],
      ['bad.md', Buffer.from([0xff, 0x00]), 'application/octet-stream'], ['drawing.svg', '<svg onload="evil()"/>', 'application/octet-stream'],
    ]) {
      await writeFile(join(workDir, name), data); expect(await publish({ file_path: name })).toMatchObject({ mimeType: mime });
    }
  });

  it('enforces durable per-Person count/byte quotas and keeps the default recent page bounded', async () => {
    for (let i = 0; i < 21; i++) await publish({ url: `https://example.com/${i}` });
    const snapshot = await r.snapshot('alice'); expect(snapshot.outputs.items).toHaveLength(20); expect(snapshot.outputs.nextCursor).toEqual(expect.any(String));
    // Seed valid authority rows at the hard bound without 200 provider/worker cycles.
    const db = new DatabaseSync(r.dbPath), scope = r.scope('alice');
    try {
      const item = snapshot.outputs.items[0];
      const insert = db.prepare('INSERT INTO outputs(namespace,ownerId,personId,id,episodeId,callId,size,record,data) VALUES (?,?,?,?,?,?,?, ?,?)');
      for (let i = 21; i < 200; i++) {
        const id = randomUUID(); insert.run(scope.namespace, scope.ownerId, scope.personId, id, episode.id, `seed-${i}`, 0, JSON.stringify({ ...item, id }), null);
      }
      await expect(publish({ url: 'https://example.com/overflow' })).rejects.toMatchObject({ code: 'OUTPUT_QUOTA' });
      db.prepare('DELETE FROM outputs WHERE namespace = ? AND ownerId = ?').run(scope.namespace, scope.ownerId);
      const bytes = Buffer.alloc(10 * 1024 * 1024); const id = randomUUID();
      for (let i = 0; i < 10; i++) insert.run(scope.namespace, scope.ownerId, scope.personId, `${id.slice(0, -2)}${String(i).padStart(2, '0')}`, episode.id, `bytes-${i}`, bytes.length,
        JSON.stringify({ ...item, kind: 'file', mimeType: 'application/octet-stream', size: bytes.length }), bytes);
      await writeFile(join(workDir, 'one.txt'), 'x');
      await expect(publish({ file_path: 'one.txt' })).rejects.toMatchObject({ code: 'OUTPUT_QUOTA' });
      const bob = await admit(r, 'bob'); expect(await publish({ url: 'https://example.com/other-owner' }, bob)).toMatchObject({ kind: 'link' });
    } finally { db.close(); }
  });

  it('rejects symlink races without reading outside bytes', async () => {
    // Pinned per-component fds prevent an ancestor symlink from being followed.
    await mkdir(join(workDir, 'safe')); await writeFile(join(workDir, 'safe', 'artifact.txt'), 'allowed');
    await writeFile(join(root, 'artifact.txt'), 'secret');
    const pending = await prepare({ file_path: 'safe/artifact.txt' });
    await rm(join(workDir, 'safe'), { recursive: true }); await symlink(root, join(workDir, 'safe'));
    await expect(pending()).rejects.toMatchObject({ code: 'OUTPUT_PATH' });
    expect((await r.outputs('alice')).items).toEqual([]);
  });

  it('delivers through the real provider/runtime contract and retains publication on cancellation', async () => {
    await r.cancel('alice'); await writeFile(join(workDir, 'child-result.md'), '# Child artifact');
    let calls = 0, published, ready; const waiting = new Promise(resolve => { ready = resolve; });
    const adapter = { async *stream(params) {
      const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
      expect(input.capabilities.delivery.id).toBe('Output.publish');
      p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
      if (++calls === 1) {
        expect(input.capabilities.active.some(c => c.id === 'Output.publish')).toBe(false);
        p.next = { model: 'test/first', effort: null, reason: 'Prepare delivery.', capability: { id: 'catalog.view', args: { id: 'Output.publish' } } };
      } else if (calls === 2) {
        const contract = input.capabilities.active.find(c => c.id === 'Output.publish');
        expect(contract.access).toBe('publish-owner-output');
        expect(contract.instructions).toContain('no symlinks/directories');
        expect(contract.instructions).toContain('Successful publications survive later cancellation/failure');
        p.next = { model: 'test/first', effort: null, reason: 'Deliver verified child file.', capability: { id: 'Output.publish', args: { file_path: 'child-result.md', title: 'Child result' } } };
      }
      else {
        published = input.capabilityResult; ready();
        await new Promise(resolve => { if (params.signal.aborted) resolve(); else params.signal.addEventListener('abort', resolve, { once: true }); });
        return;
      }
      yield { type: 'text_delta', text: JSON.stringify(p) }; yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const service = createPersonService({ yeaftDir: join(root, 'data'), workDir, config, adapter, embedding: { enabled: false } });
    try {
      const command = await service.request({ ownerId: 'alice', op: 'send', payload: { text: 'Deliver child result', clientMessageId: randomUUID() } });
      await waiting;
      expect(published).toMatchObject({ title: 'Child result', episodeId: command.episodeId, mimeType: 'text/markdown' });
      await service.request({ ownerId: 'alice', op: 'cancel', payload: { episodeId: command.episodeId } });
      expect((await service.request({ ownerId: 'alice', op: 'snapshot' })).outputs.items).toEqual([published]);
      expect(Buffer.from((await service.request({ ownerId: 'alice', op: 'output_read', payload: { outputId: published.id } })).data, 'base64').toString()).toBe('# Child artifact');
    } finally { await service.close(); }
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
