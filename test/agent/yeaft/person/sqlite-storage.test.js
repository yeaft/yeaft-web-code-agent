import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../../../agent/yeaft/person/contracts.js';
import { ensurePersonStorage } from '../../../../agent/yeaft/person/sqlite-storage.js';

const directories = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-binding-')); directories.push(dir); return dir; }
const marker = (dir, namespace) => join(dir, 'person', `storage-${digest(namespace)}.json`);
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Person SQLite storage binding', () => {
  it('atomically binds concurrent openers, remains idempotent and removes temporary files', async () => {
    const dir = await directory();
    await Promise.all(Array.from({ length: 24 }, () => ensurePersonStorage(dir, 'agent-a')));
    const initial = await readFile(marker(dir, 'agent-a'), 'utf8');
    expect(JSON.parse(initial)).toEqual({ version: 1, storage: 'sqlite' });
    await ensurePersonStorage(dir, 'agent-a');
    expect(await readFile(marker(dir, 'agent-a'), 'utf8')).toBe(initial);
    expect(await readdir(join(dir, 'person'))).toEqual([`storage-${digest('agent-a')}.json`]);
  });

  it('isolates namespace bindings and never replaces an unsupported authority', async () => {
    const dir = await directory();
    await ensurePersonStorage(dir, 'agent-a');
    const unsupported = JSON.stringify({ version: 1, storage: 'unsupported' });
    await writeFile(marker(dir, 'agent-a'), unsupported);
    await ensurePersonStorage(dir, 'agent-b');
    await expect(ensurePersonStorage(dir, 'agent-a')).rejects.toMatchObject({ code: 'STORAGE_MISMATCH' });
    expect(await readFile(marker(dir, 'agent-a'), 'utf8')).toBe(unsupported);
    expect(JSON.parse(await readFile(marker(dir, 'agent-b'), 'utf8'))).toEqual({ version: 1, storage: 'sqlite' });
    expect((await readdir(join(dir, 'person'))).sort()).toEqual(['agent-a', 'agent-b'].map(namespace => `storage-${digest(namespace)}.json`).sort());
  });

  it.each([
    '', '{', 'null', '[]', '{}',
    JSON.stringify({ version: 2, storage: 'sqlite' }),
    JSON.stringify({ version: '1', storage: 'sqlite' }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, storage: 'unsupported' }),
  ])('fails closed for a corrupt or non-SQLite marker (%s) without changing it', async content => {
    const dir = await directory();
    await ensurePersonStorage(dir, 'agent-a');
    await writeFile(marker(dir, 'agent-a'), content);
    await expect(ensurePersonStorage(dir, 'agent-a')).rejects.toMatchObject({ code: 'STORAGE_MISMATCH' });
    expect(await readFile(marker(dir, 'agent-a'), 'utf8')).toBe(content);
    expect(await readdir(join(dir, 'person'))).toEqual([`storage-${digest('agent-a')}.json`]);
  });
});
