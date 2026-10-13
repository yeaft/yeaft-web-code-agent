import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersonService } from './fixture-adapter.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { config } from './fixtures.js';

const services = [], directories = [];
const call = (s, op, payload = {}, ownerId = 'alice') => s.request({ ownerId, op, payload });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-candidates-')); directories.push(dir); return dir; }
function create(dir, more = {}) {
  const s = createPersonService({ yeaftDir: dir, config, embedding: { enabled: false }, ...more }); services.push(s); return s;
}
const manyModels = () => ({ ...config, providers: [{ name: 'test', models: Array.from({ length: 12 }, (_, i) => `model${i}`) }], primaryModel: 'test/model0',
  availableModels: Array.from({ length: 12 }, (_, i) => ({ ...config.availableModels[0], id: `model${i}`, ref: `test/model${i}`, apiKey: 'must-not-leak', baseUrl: 'https://private' })) });
async function idle(s) {
  for (let i = 0; i < 200; i++) {
    const snap = await call(s, 'snapshot'); if (!snap.busy) return snap;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Person did not finish');
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(s => s.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('owner-scoped model candidates', () => {
  it('exposes the full safe catalog, validates exact qualified refs, persists per owner, and resets without changing Agent config', async () => {
    const dir = await directory(), native = manyModels(), before = JSON.stringify(native);
    const s = create(dir, { config: native, adapter: {} });
    expect((await call(s, 'status')).modelCandidates).toEqual([]);
    await call(s, 'open'); await call(s, 'open', {}, 'bob');
    const status = await call(s, 'status');
    expect(status.renameSupported).toBe(true);
    expect(status.models).toHaveLength(12);
    expect(status.availableModels).toEqual(status.models);
    expect(status.availableModelsTruncated).toBe(false);
    const provider = await createPersonProvider({ config: native, adapter: {} });
    expect(provider.catalog).toHaveLength(8);
    expect(provider.availableModels).toHaveLength(12);
    expect((await createPersonProvider({ config: native, adapter: {}, modelCandidates: ['test/model11'] })).catalog.map(m => m.id)).toEqual(['test/model11']);
    expect(JSON.stringify(status)).not.toContain('must-not-leak');
    expect(JSON.stringify(status)).not.toContain('private');
    expect(await call(s, 'settings', { modelCandidates: ['test/model11'] })).toMatchObject({ settings: { modelCandidates: ['test/model11'] } });
    expect((await call(s, 'status')).modelCandidates).toEqual(['test/model11']);
    expect((await call(s, 'status')).models).toHaveLength(12);
    expect((await call(s, 'status', {}, 'bob')).modelCandidates).toEqual([]);
    for (const refs of [null, {}, ['model11'], ['test/missing'], ['test/model1', 'test/model1'], [42], native.availableModels.slice(0, 9).map(m => m.ref)]) {
      await expect(call(s, 'settings', { modelCandidates: refs })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
      await expect(createPersonProvider({ config: native, adapter: {}, modelCandidates: refs })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    }
    await s.close();
    const restarted = create(dir, { config: native, adapter: {} });
    expect((await call(restarted, 'snapshot')).person.settings.modelCandidates).toEqual(['test/model11']);
    expect(await call(restarted, 'settings', { modelCandidates: [] })).toMatchObject({ settings: { modelCandidates: [] } });
    expect(JSON.stringify(native)).toBe(before);
    const limited = create(await directory(), { config: native, adapter: {}, allowedModels: ['test/model11'] });
    await call(limited, 'open');
    expect((await call(limited, 'status')).models.map(m => m.id)).toEqual(['test/model11']);
    await expect(call(limited, 'settings', { modelCandidates: ['test/model0'] })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
  });

  it('persists explicit defaults on SQLite restart and permits name-only edits of stale model settings', async () => {
    const dir = await directory(), native = manyModels(), stream = vi.fn(), s = create(dir, { config: native, adapter: { stream } });
    await call(s, 'open'); await call(s, 'open', {}, 'bob');
    await call(s, 'settings', { modelCandidates: ['test/model11'], defaultModel: 'test/model11' });
    await s.close();
    const restarted = create(dir, { config: native, adapter: { stream } });
    expect((await call(restarted, 'snapshot')).person.settings).toMatchObject({ defaultModel: 'test/model11', modelCandidates: ['test/model11'] });
    expect(await call(restarted, 'status', {}, 'bob')).toMatchObject({ defaultModel: null });
    native.availableModels.pop();
    expect(await call(restarted, 'status')).toMatchObject({ modelReady: false, defaultModelSupported: true, defaultModel: 'test/model11' });
    expect((await call(restarted, 'status')).availableModels).toHaveLength(11);
    expect((await call(restarted, 'settings', { name: 'Saved name' })).settings).toMatchObject({ defaultModel: 'test/model11', modelCandidates: ['test/model11'] });
    await expect(call(restarted, 'settings', { defaultModel: null })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    await expect(call(restarted, 'settings', { modelCandidates: [] })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    await call(restarted, 'send', { text: 'stale', clientMessageId: 'stale-default' });
    expect((await idle(restarted)).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'MODEL_SELECTION' });
    expect(stream).not.toHaveBeenCalled();
    await call(restarted, 'settings', { modelCandidates: [], defaultModel: null });
    expect((await call(restarted, 'status')).modelReady).toBe(true);
  });

});
