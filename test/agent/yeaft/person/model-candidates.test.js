import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { config, finalProposal } from './fixtures.js';

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
    expect(status.models).toHaveLength(12);
    expect(JSON.stringify(status)).not.toContain('must-not-leak');
    expect(JSON.stringify(status)).not.toContain('private');
    expect(await call(s, 'settings', { modelCandidates: ['test/model11'] })).toMatchObject({ settings: { modelCandidates: ['test/model11'] } });
    expect((await call(s, 'status')).modelCandidates).toEqual(['test/model11']);
    expect((await call(s, 'status')).models).toHaveLength(12);
    expect((await call(s, 'status', {}, 'bob')).modelCandidates).toEqual([]);
    for (const refs of [null, {}, ['model11'], ['test/missing'], ['test/model1', 'test/model1'], [42]]) {
      await expect(call(s, 'settings', { modelCandidates: refs })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
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

  it('freezes the subset at admission, blocks busy settings across services, and rejects model escape in a proposal', async () => {
    const dir = await directory(), native = manyModels(), seen = [];
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const s = create(dir, { config: native, adapter: { async *stream(params) {
      const context = JSON.parse(params.messages[0].content); seen.push({ context, model: params.model }); started();
      await held;
      const p = finalProposal(context.state.version); p.concepts = []; p.state.focusConceptIds = [];
      p.next = { model: 'test/model0', effort: null, reason: 'Escape owner candidate list', capability: null };
      yield { type: 'text_delta', text: JSON.stringify(p) }; yield { type: 'stop', stopReason: 'end_turn' };
    } } });
    const other = create(dir, { config: native, adapter: {} });
    await call(s, 'open'); await call(s, 'settings', { modelCandidates: ['test/model11'] });
    await call(s, 'send', { text: 'hello', clientMessageId: 'one' }); await ready;
    try {
      await expect(call(other, 'settings', { modelCandidates: [] })).rejects.toMatchObject({ code: 'BUSY' });
      native.availableModels[11].ref = 'test/changed-after-start';
      expect(seen[0].model).toBe('test/model11');
      expect(seen[0].context.models.map(m => m.id)).toEqual(['test/model11']);
      const db = new DatabaseSync(join(dir, 'person/person.db'), { readOnly: true });
      try { expect(JSON.parse(db.prepare('SELECT record FROM episodes').get().record).modelCandidates).toEqual(['test/model11']); }
      finally { db.close(); }
    } finally { release(); }
    expect((await idle(s)).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'MODEL_SELECTION' });
    expect(seen).toHaveLength(1);
  });

  it('fails closed when a saved candidate disappears, and honors explicit image opt-out', async () => {
    await expect(createPersonProvider({ config, adapter: {}, modelCandidates: ['test/removed'] })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    const p = await createPersonProvider({ config: { providers: [{ name: 'test', supportsImages: false, models: ['gpt-5.5'] }],
      availableModels: [{ id: 'gpt-5.5', ref: 'test/gpt-5.5', contextWindow: 100000, maxOutput: 4096 }] }, adapter: {} });
    expect(p.catalog[0].supportsImages).toBe(false);
  });
});
