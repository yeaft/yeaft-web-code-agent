import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindPersonStorage, selectPersonStorage } from '../../../../agent/yeaft/person/storage.js';

const directories = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-binding-')); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('Person authority selection', () => {
  it('uses local SQLite only when no Mongo authority is configured', () => {
    expect(selectPersonStorage({ yeaftDir: '/instance' })).toEqual({ storage: 'sqlite', configured: true });
    expect(selectPersonStorage({ uri: 'mongodb://localhost' })).toEqual({ storage: 'mongodb', configured: true });
    expect(selectPersonStorage({ storage: 'mongodb', yeaftDir: '/instance' })).toEqual({ storage: 'mongodb', configured: false });
    expect(selectPersonStorage({})).toEqual({ storage: 'sqlite', configured: false });
    expect(() => selectPersonStorage({ storage: 'sqlite', uri: 'mongodb://localhost', yeaftDir: '/instance' })).toThrow(/migration/);
    expect(() => selectPersonStorage({ storage: 'unknown' })).toThrow();
  });
  it('persists selection and fails closed rather than forking memory after config changes', async () => {
    const dir = await directory();
    await bindPersonStorage(dir, 'agent-a', 'mongodb');
    await bindPersonStorage(dir, 'agent-a', 'mongodb');
    await expect(bindPersonStorage(dir, 'agent-a', 'sqlite')).rejects.toMatchObject({ code: 'STORAGE_MISMATCH' });
    await bindPersonStorage(dir, 'agent-b', 'sqlite');
    await expect(bindPersonStorage(dir, 'agent-b', 'mongodb')).rejects.toMatchObject({ code: 'STORAGE_MISMATCH' });
  });
});
