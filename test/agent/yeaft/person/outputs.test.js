import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from './fixture-adapter.js';

import { bytes } from '../../../../agent/yeaft/person/contracts.js';

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

});
