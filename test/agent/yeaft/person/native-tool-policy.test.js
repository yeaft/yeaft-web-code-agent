import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonToolHost, NATIVE_TOOL_IDS } from '../../../../agent/yeaft/person/native-tools.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config } from './fixtures.js';

const dirs = [], services = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-policy-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe('Person native tools respect Agent plugin selection', () => {
  it('preserves historical availability without a configured category, filters explicit empty and single-tool lists', async () => {
    const workDir = await directory(), yeaftDir = await directory();
    const current = { ...config };
    const host = createPersonToolHost({ workDir, yeaftDir, config: current });
    expect(host.allowedToolIds()).toEqual(NATIVE_TOOL_IDS);
    current.plugins = { tools: [] };
    expect(host.allowedToolIds()).toEqual([]);
    expect(await host.execute('FileWrite', { file_path: 'never.txt', content: 'x' })).toMatchObject({ ok: false, code: 'TOOL_DISABLED', errorEffect: 'none' });
    expect(await readdir(workDir)).toEqual([]);
    current.plugins.tools = ['FileRead'];
    expect(host.allowedToolIds()).toEqual(['FileRead']);
    const cap = new PersonCapabilities({}, 'alice', { toolHost: host });
    expect(cap.catalog().nativeTools).toEqual(['FileRead']);
    await expect(cap.execute({ id: 'catalog.view', args: { id: 'Bash' } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect((await cap.execute({ id: 'catalog.search', args: { query: 'FileRead' } })).items.map(i => i.id)).toEqual(['FileRead']);
    current.plugins.tools = [];
    expect(await cap.execute({ id: 'FileRead', args: { file_path: 'not-read' } })).toMatchObject({ ok: false, code: 'TOOL_DISABLED' });
  });

  it('refreshes instance configuration before dispatch and filters read-only inspection', async () => {
    const workDir = await directory(), yeaftDir = await directory();
    const path = join(yeaftDir, 'config.json');
    await writeFile(path, JSON.stringify({ ...config, plugins: { tools: ['FileWrite'] } }));
    const host = createPersonToolHost({ workDir, yeaftDir });
    expect(host.allowedToolIds()).toEqual(['FileWrite']);
    const cap = new PersonCapabilities({}, 'alice', { toolHost: host });
    await cap.execute({ id: 'catalog.view', args: { id: 'FileWrite' } });
    await writeFile(path, JSON.stringify({ ...config, plugins: { tools: [] } }));
    expect(await cap.execute({ id: 'FileWrite', args: { file_path: 'never.txt', content: 'x' } })).toMatchObject({ ok: false, code: 'TOOL_DISABLED' });
    expect(await readdir(workDir)).toEqual([]);
    const service = createPersonService({ workDir, yeaftDir, embedding: { enabled: false } }); services.push(service);
    const request = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
    await request('open');
    const first = await request('inspect', { section: 'skills', limit: 50 });
    expect(first.items.filter(i => i.source.kind === 'native-tool')).toEqual([]);
    await writeFile(path, JSON.stringify({ ...config, plugins: { tools: ['FileRead'] } }));
    const second = await request('inspect', { section: 'skills', limit: 50 });
    expect(second.items.filter(i => i.source.kind === 'native-tool').map(i => i.id)).toEqual(['FileRead']);
  });
});
