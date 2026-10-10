import { NATIVE_TOOL_IDS } from '../../../../agent/yeaft/person/native-tools.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { digest } from '../../../../agent/yeaft/person/contracts.js';
import { LocalPersonMemory } from '../../../../agent/yeaft/person/local-memory.js';
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

  it('reports bounded effective candidates and separates saved, Agent and effective defaults', async () => {
    const native = manyModels(), stream = vi.fn(), s = create(await directory(), { config: native, adapter: { stream } });
    const defaults = { defaultModelSupported: true, defaultModel: null, agentDefaultModel: 'test/model0',
      effectiveModelCandidates: native.availableModels.slice(0, 8).map(m => m.ref), effectiveDefaultModel: 'test/model0' };
    expect(await call(s, 'status')).toMatchObject(defaults);
    await call(s, 'open');
    await call(s, 'settings', { modelCandidates: ['test/model9', 'test/model11'], defaultModel: 'test/model11' });
    expect(await call(s, 'status')).toMatchObject({ ...defaults, defaultModel: 'test/model11',
      effectiveModelCandidates: ['test/model9', 'test/model11'], effectiveDefaultModel: 'test/model11' });
    expect((await call(s, 'status')).availableModels).toHaveLength(12);
    await call(s, 'settings', { defaultModel: null });
    expect(await call(s, 'status')).toMatchObject({ defaultModel: null, effectiveDefaultModel: 'test/model9' });
    native.primaryModel = 'model11';
    expect(await call(s, 'status')).toMatchObject({ agentDefaultModel: 'test/model11', effectiveDefaultModel: 'test/model11' });
    native.primaryModel = 'missing';
    expect(await call(s, 'status')).toMatchObject({ agentDefaultModel: null, effectiveDefaultModel: 'test/model9' });
    expect(stream).not.toHaveBeenCalled();
    const limited = create(await directory(), { config: { ...native, primaryModel: 'test/model0' }, adapter: {}, allowedModels: ['test/model11'] });
    expect(await call(limited, 'status')).toMatchObject({ agentDefaultModel: 'test/model0',
      effectiveModelCandidates: ['test/model11'], effectiveDefaultModel: 'test/model11' });
  });

  it('validates explicit defaults against the merged subset, implicit first eight and safe allowlist without broadening', async () => {
    const native = manyModels(), s = create(await directory(), { config: native, adapter: {} });
    await call(s, 'open');
    for (const defaultModel of [undefined, 7, {}, '', 'model1', 'test/missing', 'test/model8']) {
      await expect(call(s, 'settings', { defaultModel })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    }
    await expect(createPersonProvider({ config: native, adapter: {}, defaultModel: 'test/model8' })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    await call(s, 'settings', { defaultModel: 'test/model7' });
    await expect(call(s, 'settings', { modelCandidates: ['test/model11'] })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    expect((await call(s, 'snapshot')).person.settings).toMatchObject({ defaultModel: 'test/model7' });
    await call(s, 'settings', { modelCandidates: ['test/model11'], defaultModel: 'test/model11' });
    await expect(call(s, 'settings', { modelCandidates: [] })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    await call(s, 'settings', { modelCandidates: [], defaultModel: null });
    expect((await call(s, 'status')).effectiveModelCandidates).toHaveLength(8);
    const provider = await createPersonProvider({ config: native, adapter: {}, modelCandidates: ['test/model9', 'test/model11'], defaultModel: 'test/model11' });
    expect(provider.catalog.map(m => m.id)).toEqual(['test/model9', 'test/model11']);
    expect(provider.defaultSelection).toEqual({ model: 'test/model11', effort: null });
    await expect(createPersonProvider({ config: native, adapter: {}, allowedModels: ['test/model0'], defaultModel: 'test/model1' }))
      .rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    const unsafe = structuredClone(native); unsafe.availableModels[1].contextWindow = 100;
    await expect(createPersonProvider({ config: unsafe, adapter: {}, defaultModel: 'test/model1' })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
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

  it('bootstraps with explicit defaults instead of last selection, while automatic retains last selection and fallback', async () => {
    const dir = await directory(), seen = [], s = create(dir, { adapter: { async *stream(params) {
      seen.push(params.model);
      const p = finalProposal(JSON.parse(params.messages[0].content).state.version); p.concepts = []; p.state.focusConceptIds = [];
      yield { type: 'text_delta', text: JSON.stringify(p) }; yield { type: 'stop', stopReason: 'end_turn' };
    } } });
    await call(s, 'open');
    const r = new SqlitePersonRepository({ yeaftDir: dir });
    try {
      const { episode } = await r.admit('alice', { kind: 'think', text: '', clientMessageId: 'seed', workerId: 'seed', budget: { calls: 1, timeoutMs: 5000 } });
      const callId = randomUUID(); await r.startCall(episode, { callId, requested: { model: 'test/second', effort: null } });
      await r.finalizeCall(episode, { callId, output: { text: '{}' } });
      const p = finalProposal(); p.concepts = []; p.state.focusConceptIds = [];
      await r.commit(episode, p, { model: 'test/second', effort: null }, callId); await r.finish(episode, 'completed');
    } finally { await r.close(); }
    await call(s, 'think', { clientMessageId: 'automatic' }); expect((await idle(s)).latestEpisode.status).toBe('completed');
    await call(s, 'settings', { defaultModel: 'test/first' });
    await call(s, 'think', { clientMessageId: 'explicit' }); expect((await idle(s)).latestEpisode.status).toBe('completed');
    await call(s, 'settings', { defaultModel: null });
    await call(s, 'think', { clientMessageId: 'automatic-again' }); await idle(s);
    await call(s, 'settings', { modelCandidates: ['test/second'] });
    await call(s, 'think', { clientMessageId: 'invalid-last-choice' }); await idle(s);
    expect(seen).toEqual(['test/second', 'test/first', 'test/first', 'test/second']);
  });

  it('advertises default-model support on unconfigured, unavailable and storage failure status paths', async () => {
    const unconfigured = create(undefined);
    const unavailable = create(await directory(), { config: { providers: [], availableModels: [] } });
    const dir = await directory();
    await mkdir(join(dir, 'person'), { recursive: true });
    await writeFile(join(dir, 'person', `storage-${digest('default')}.json`), JSON.stringify({ version: 1, storage: 'unsupported' }));
    const mismatch = create(dir);
    for (const s of [unconfigured, unavailable, mismatch]) expect(await call(s, 'status')).toMatchObject({
      defaultModelSupported: true, defaultModel: null, effectiveModelCandidates: [], effectiveDefaultModel: null, modelReady: false,
    });
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
    await call(s, 'open'); await call(s, 'settings', { modelCandidates: ['test/model9', 'test/model11'], defaultModel: 'test/model11' });
    await call(s, 'send', { text: 'hello', clientMessageId: 'one' }); await ready;
    try {
      await expect(call(other, 'settings', { modelCandidates: [], defaultModel: null })).rejects.toMatchObject({ code: 'BUSY' });
      native.availableModels[11].ref = 'test/changed-after-start';
      expect(seen[0].model).toBe('test/model11');
      expect(seen[0].context.models.map(m => m.id)).toEqual(['test/model9', 'test/model11']);
      const db = new DatabaseSync(join(dir, 'person/person.db'), { readOnly: true });
      try { expect(JSON.parse(db.prepare('SELECT record FROM episodes').get().record)).toMatchObject({
        modelCandidates: ['test/model9', 'test/model11'], defaultModel: 'test/model11',
      }); } finally { db.close(); }
    } finally { release(); }
    expect((await idle(s)).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'MODEL_SELECTION' });
    expect(seen).toHaveLength(1);
  });

  it('reports stale owner selections as not ready while preserving the recovery catalog, and bounds the selectable catalog explicitly', async () => {
    const native = manyModels(), s = create(await directory(), { config: native, adapter: {} });
    await call(s, 'open');
    await call(s, 'settings', { modelCandidates: ['test/model11'] });
    native.availableModels.pop();
    const stale = await call(s, 'status');
    expect(stale).toMatchObject({ modelReady: false, modelCandidates: ['test/model11'] });
    expect(stale.availableModels).toHaveLength(11);
    expect(stale.models).toEqual(stale.availableModels);
    await call(s, 'settings', { modelCandidates: [] });
    expect((await call(s, 'status')).modelReady).toBe(true);
    native.availableModels = Array.from({ length: 101 }, (_, i) => ({ ...native.availableModels[0], id: `model${i}`, ref: `test/model${i}` }));
    const bounded = await call(s, 'status');
    expect(bounded.availableModels).toHaveLength(100);
    expect(bounded.availableModelsTruncated).toBe(true);
    await call(s, 'settings', { modelCandidates: ['test/model99'] });
    await expect(call(s, 'settings', { modelCandidates: ['test/model100'] })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
  });

  it('fails closed when a saved candidate disappears, and honors explicit image opt-out', async () => {
    await expect(createPersonProvider({ config, adapter: {}, modelCandidates: ['test/removed'] })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
    const p = await createPersonProvider({ config: { providers: [{ name: 'test', supportsImages: false, models: ['gpt-5.5'] }],
      availableModels: [{ id: 'gpt-5.5', ref: 'test/gpt-5.5', contextWindow: 100000, maxOutput: 4096 }] }, adapter: {} });
    expect(p.catalog[0].supportsImages).toBe(false);
  });
});
describe('Person inspection, search and name: SQLite', () => {
  let dir, resources, options, stream;
  const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
  const service = (namespace = 'default', extra = {}) => {
    const s = createPersonService({ ...options, namespace, config, adapter: { stream }, ...extra }); resources.push(s); return s;
  };
  const repo = (namespace = 'default') => {
    const r = new SqlitePersonRepository({ yeaftDir: dir, namespace, leaseMs: 60000 });
    resources.push(r); return r;
  };
  const admission = (r, ownerId = 'alice', text = 'hello') => r.admit(ownerId, { kind: 'send', text,
    clientMessageId: randomUUID(), workerId: 'test-worker', budget: { calls: 1, timeoutMs: 5000 } });
  const patchRecord = async (r, table, fields, id = null) => {
    const db = new DatabaseSync(r.dbPath);
    try {
      const row = db.prepare(`SELECT rowid AS rowKey, record FROM ${table} WHERE namespace = ? AND ownerId = ?${id ? ' AND id = ?' : ''} LIMIT 1`)
        .get(r.namespace, 'alice', ...(id ? [id] : []));
      db.prepare(`UPDATE ${table} SET record = ? WHERE rowid = ?`).run(JSON.stringify({ ...JSON.parse(row.record), ...fields }), row.rowKey);
    } finally { db.close(); }
  };
  const raw = async r => {
    const db = new DatabaseSync(r.dbPath, { readOnly: true });
    try { return JSON.parse(db.prepare('SELECT record FROM persons WHERE namespace = ? AND ownerId = ?').get(r.namespace, 'alice').record); }
    finally { db.close(); }
  };
  beforeEach(async () => {
    resources = []; stream = vi.fn(() => { throw new Error('must not call a model'); });
    dir = await mkdtemp(join(tmpdir(), 'person-inspection-'));
    options = { yeaftDir: dir };
  });
  afterEach(async () => {
    await Promise.all(resources.map(r => r.close())); vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('snapshots default and candidates at admission and preserves them independently of later settings', async () => {
    const s = service(), r = repo(); await call(s, 'open');
    await call(s, 'settings', { modelCandidates: ['test/first', 'test/second'], defaultModel: 'test/second' });
    const prior = await r.getPerson('alice'), { episode } = await admission(r);
    expect(episode).toMatchObject({ defaultModel: 'test/second', modelCandidates: ['test/first', 'test/second'], controlVersion: prior.controlVersion });
    await expect(call(s, 'settings', { defaultModel: null })).rejects.toMatchObject({ code: 'BUSY' });
    await r.finish(episode, 'completed');
    await call(s, 'settings', { modelCandidates: [], defaultModel: null });
    expect(episode.defaultModel).toBe('test/second'); expect(episode.modelCandidates).toEqual(['test/first', 'test/second']);
    const automatic = await admission(r);
    expect(automatic.episode).toMatchObject({ defaultModel: null, modelCandidates: [] });
    await r.finish(automatic.episode, 'completed');
    // Pre-feature rows are read as automatic; no durable data migration.
    await patchRecord(r, 'persons', { settings: { autonomyEnabled: false } });
    const legacy = await admission(r);
    expect(legacy.episode).toMatchObject({ defaultModel: null, modelCandidates: [] });
    await r.finish(legacy.episode, 'completed');
    await expect(r.settings('alice', { modelCandidates: ['test/first'] }, prior.controlVersion)).rejects.toMatchObject({ code: 'STALE' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('renames the Person atomically, persists and isolates it, without model configuration', async () => {
    const s = service(), r = repo();
    await call(s, 'open'); await call(s, 'open', {}, 'bob');
    await call(s, 'settings', { modelCandidates: ['test/first'] });
    const noModel = service('default', { config: { availableModels: [], providers: [] } });
    const result = await call(noModel, 'settings', { name: '  新名字  ' });
    expect(result.person).toMatchObject({ name: '新名字', settings: { modelCandidates: ['test/first'] } });
    expect(result.settings).not.toHaveProperty('name');
    expect((await raw(r)).name).toBe('新名字');
    expect((await call(s, 'snapshot', {}, 'bob')).person.name).toBe('Digital Person');
    const before = await raw(r);
    for (const payload of [{ name: ' ' }, { name: null }, { name: 7 }, { name: '界'.repeat(54) }, { name: 'a\0b' },
      { name: 'no', modelCandidates: ['test/missing'] }, { name: 'no', autonomyEnabled: true }]) {
      await expect(call(s, 'settings', payload)).rejects.toBeTruthy();
      expect(await raw(r)).toEqual(before);
    }
    await admission(r);
    await expect(call(s, 'settings', { name: 'busy', modelCandidates: [] })).rejects.toMatchObject({ code: 'BUSY' });
    expect((await raw(r)).name).toBe('新名字');
    await r.cancel('alice');
    expect((await call(s, 'settings', { name: 'a'.repeat(160), modelCandidates: [] })).person.name).toHaveLength(160);
    await s.close();
    expect((await call(service(), 'snapshot')).person.name).toHaveLength(160);
    expect(stream).not.toHaveBeenCalled();
  });

  it('applies name-only repository and service patches without replacing durable settings or cognition', async () => {
    const s = service(), r = repo(), other = repo('other');
    await call(s, 'open'); await r.open('bob'); await other.open('alice');
    await call(s, 'settings', { modelCandidates: ['test/first'], autonomyEnabled: false });
    // Unknown durable settings must survive updates, but never appear in public
    // responses/traces. Public projection is not a persistence merge base.
    const savedSettings = { autonomyEnabled: false, modelCandidates: ['test/first'], internal: { token: 'private-setting' } };
    await patchRecord(r, 'persons', { settings: savedSettings });
    const { episode } = await admission(r);
    await r.finish(episode, 'completed');
    const before = await raw(r), snapshot = await call(s, 'snapshot');
    const direct = await r.settings('alice', { name: '  Repository name  ' });
    expect(direct.person.name).toBe('Repository name');
    expect(direct.settings).toEqual({ autonomyEnabled: false, modelCandidates: ['test/first'] });
    expect((await raw(r)).settings).toEqual(savedSettings);
    const noModel = service('default', { config: { availableModels: [], providers: [] } });
    const renamed = await call(noModel, 'settings', { name: '  服务名字  ' });
    expect(renamed.person).toEqual({ ...snapshot.person, name: '服务名字' });
    expect((await raw(r)).settings).toEqual(savedSettings);
    expect(JSON.stringify([direct, renamed, await call(s, 'traces')])).not.toContain('private-setting');
    const after = await raw(r);
    for (const key of ['personId', 'soul', 'soulRevision', 'createdAt', 'stateVersion', 'messageSeq', 'epoch', 'capabilityExperience']) {
      expect(after[key]).toEqual(before[key]);
    }
    expect((await call(s, 'snapshot')).state).toEqual(snapshot.state);
    expect((await call(s, 'messages')).items).toEqual(snapshot.messages);
    expect((await r.getPerson('bob')).name).toBe('Digital Person');
    expect((await other.getPerson('alice')).name).toBe('Digital Person');
    await expect(call(s, 'settings', { name: 'intruder' }, 'unopened')).rejects.toMatchObject({ code: 'NOT_OPEN' });
    await expect(call(s, 'settings', { name: 'intruder', ownerId: 'bob' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await raw(r)).toEqual(after);
    // Explicit updates touch only supplied settings, including an intentional reset.
    await call(noModel, 'settings', { modelCandidates: [] });
    expect((await raw(r)).settings).toEqual({ ...savedSettings, modelCandidates: [] });
    expect((await raw(r)).name).toBe('服务名字');
    await s.close(); await noModel.close(); await r.close();
    expect((await call(service(), 'snapshot')).person).toEqual({ ...renamed.person,
      settings: { autonomyEnabled: false, modelCandidates: [] } });
    expect(stream).not.toHaveBeenCalled();
  });

  it('searches all literal history with sequence cursors and no recall, recovery or execution', async () => {
    const s = service(), r = repo(); await call(s, 'open');
    const other = repo('other'); await other.open('alice'); await r.open('bob');
    for (let i = 0; i < 27; i++) {
      const { episode } = await admission(r, 'alice', i < 4 ? `ÄBC .* [x] %_\\ needle ${i}` : `unrelated ${i}`);
      await r.finish(episode, 'completed');
    }
    await admission(r, 'bob', 'ÄBC .* [x] %_\\ needle foreign');
    await admission(other, 'alice', 'ÄBC .* [x] %_\\ needle foreign');
    const recall = vi.spyOn(LocalPersonMemory.prototype, 'recall').mockRejectedValue(new Error('no embeddings'));
    const before = await raw(r);
    const first = await call(s, 'search', { query: 'äbc .* [x] %_\\ NEEDLE', limit: 2 });
    expect(first.items.map(m => m.seq)).toEqual([4, 3]); expect(first.nextCursor).toBe('3');
    await admission(r, 'alice', 'ÄBC .* [x] %_\\ needle new');
    const second = await call(s, 'search', { query: 'äbc .* [x] %_\\ NEEDLE', limit: 2, cursor: first.nextCursor });
    expect(second.items.map(m => m.seq)).toEqual([2, 1]); expect(second.nextCursor).toBeNull();
    expect((await call(s, 'search', { query: "' OR 1=1 --" })).items).toEqual([]);
    await patchRecord(r, 'persons', { leaseUntil: new Date(0) });
    const active = await raw(r);
    await call(s, 'search', { query: 'needle' });
    await call(s, 'inspect', { section: 'memory' });
    await call(s, 'inspect', { section: 'skills' });
    expect(await raw(r)).toEqual(active); expect(active.stateVersion).toBe(before.stateVersion);
    expect(recall).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    expect(await readdir(join(dir, 'person'))).not.toContain('recall.db');
    expect(JSON.stringify(first)).not.toMatch(/ownerId|namespace|personId|workerId|leaseUntil/);
  });

  it('inspects all committed concepts and actual builtin/created contracts, with newest-first keyset pages', async () => {
    const s = service(), r = repo(); await call(s, 'open'); await r.open('bob');
    const { episode } = await admission(r);
    const callId = randomUUID();
    await r.startCall(episode, { callId, requested: { model: 'test/first', effort: null } });
    await r.finalizeCall(episode, { callId, output: { text: '{}' } });
    const definition = { id: 'Script.echo', expectedVersion: 0, description: 'Echo JSON', useWhen: 'Test a value', avoidWhen: '',
      inputDescription: 'JSON', outputDescription: 'JSON', code: 'return input;', tests: [{ input: 1, expected: 1 }] };
    await r.saveCreatedCapability(episode, { definition, callId, evidence: { engine: 'quickjs', testsPassed: 1, testedAt: new Date().toISOString() } });
    const concepts = ['z-last', 'A-first', 'm-middle'].map(id => ({ id, expectedRevision: 0, kind: 'claim', statement: id,
      epistemicState: 'hypothesis', sourceRefs: [], associations: [] }));
    await r.commit(episode, { baseStateVersion: 0, concepts, state: { summary: 'saved', appraisal: '', focusConceptIds: ['z-last'] },
      decision: { summary: 'test', uncertainties: [], selfCheck: 'test' }, reply: null }, { model: 'test/first', effort: null }, callId);
    const before = await raw(r);
    const first = await call(s, 'inspect', { section: 'memory', limit: 2 });
    expect(first.items.map(c => c.id)).toEqual(['A-first', 'm-middle']); expect(first.nextCursor).toMatch(/^m1:c:/);
    expect(first.items[0]).toMatchObject({ kind: 'claim', statement: 'A-first', epistemicState: 'hypothesis', revision: 1, sourceRefs: [], associations: [] });
    expect((await call(s, 'inspect', { section: 'memory', cursor: first.nextCursor })).items.map(c => c.id)).toEqual(['z-last']);
    const skills = []; let cursor = null;
    do {
      const result = await call(s, 'inspect', { section: 'skills', cursor, limit: 2 });
      skills.push(...result.items); cursor = result.nextCursor;
    } while (cursor);
    expect(skills.map(c => c.id)).toEqual(['Script.echo', ...[...NATIVE_TOOL_IDS, 'Capability.create', 'Output.publish', 'Recall', 'Skill.associate', 'Skill.reconsider', 'Think'].sort()]);
    const script = skills.find(c => c.id === 'Script.echo');
    expect(script).toMatchObject({ domain: 'script', description: 'Echo JSON', version: 1, code: 'return input;', tests: definition.tests,
      source: { kind: 'person-created', episodeId: episode.id, callId } });
    expect(script.contract).toMatchObject({ access: 'pure-computation', args: { input: expect.any(String) } });
    expect(skills.find(c => c.id === 'Think')).toMatchObject({ source: { kind: 'builtin' }, contract: { instructions: expect.any(String) } });
    const bobSkills = []; cursor = null;
    do {
      const result = await call(s, 'inspect', { section: 'skills', cursor, limit: 50 }, 'bob');
      bobSkills.push(...result.items); cursor = result.nextCursor;
    } while (cursor);
    expect(bobSkills.map(c => c.id)).toEqual(skills.filter(c => c.id !== 'Script.echo').map(c => c.id));
    expect((await call(s, 'inspect', { section: 'memory' }, 'bob')).items).toEqual([]);
    expect(await raw(r)).toEqual(before); expect(stream).not.toHaveBeenCalled();
    // Native descriptions may mention "namespace" or attachments; reject
    // private record fields rather than ordinary contract prose.
    expect(JSON.stringify(skills)).not.toMatch(/"(?:ownerId|namespace|personId|leaseOwner|apiKey|attachments)"\s*:/);
  });

  it('projects legacy/raw records through explicit public fields without exposing host data', async () => {
    const s = service(), r = repo(); await call(s, 'open');
    const { episode } = await admission(r, 'alice', 'public message');
    const callId = randomUUID();
    await r.startCall(episode, { callId, requested: { model: 'test/first', effort: null } });
    await r.finalizeCall(episode, { callId, output: { text: '{}' } });
    const definition = { id: 'Script.echo', expectedVersion: 0, description: 'Echo', useWhen: 'Echo', avoidWhen: '',
      inputDescription: 'JSON', outputDescription: 'JSON', code: 'return input;', tests: [{ input: 1, expected: 1 }] };
    await r.saveCreatedCapability(episode, { definition, callId, evidence: { engine: 'quickjs', testsPassed: 1, testedAt: new Date().toISOString() } });
    await r.commit(episode, { baseStateVersion: 0, concepts: [{ id: 'safe', expectedRevision: 0, kind: 'claim', statement: 'public claim',
      epistemicState: 'hypothesis', sourceRefs: [], associations: [{ targetId: 'safe', relation: 'related' }] }],
    state: { summary: 'saved', appraisal: '', focusConceptIds: ['safe'] },
    decision: { summary: 'test', uncertainties: [], selfCheck: 'test' }, reply: null }, { model: 'test/first', effort: null }, callId);
    const secret = { _id: 'HOST-SECRET', apiKey: 'HOST-SECRET', files: [{ content: 'HOST-SECRET' }], workerId: 'HOST-SECRET' };
    await patchRecord(r, 'persons', { ...secret, settings: { autonomyEnabled: false, ...secret } });
    await patchRecord(r, 'states', { ...secret, lastSelection: { model: 'test/first', effort: null, ...secret } });
    await patchRecord(r, 'messages', { ...secret, attachments: [{ id: 'file', name: 'safe.txt', mimeType: 'text/plain', size: 12,
      sha256: 'a'.repeat(64), kind: 'text', path: '/HOST-SECRET', data: 'HOST-SECRET', ...secret }] });
    await patchRecord(r, 'concepts', { ...secret, associations: [{ targetId: 'safe', relation: 'related', ...secret }] });
    await patchRecord(r, 'created_capabilities', { ...secret,
      evidence: { engine: 'quickjs', testsPassed: 1, testedAt: new Date().toISOString(), ...secret },
      tests: [{ input: 1, expected: 1, ...secret }] });
    for (const [op, payload] of [['snapshot', {}], ['messages', {}], ['search', { query: 'public' }],
      ['inspect', { section: 'memory' }], ['inspect', { section: 'skills' }]]) {
      expect(JSON.stringify(await call(s, op, payload))).not.toContain('HOST-SECRET');
    }
    await patchRecord(r, 'memory_changes', secret);
    const changes = await r.searchChanges('alice');
    expect(JSON.stringify(changes)).not.toContain('HOST-SECRET');
    for (const kind of ['messages', 'concepts']) {
      const refs = changes.items.filter(c => c.kind === kind);
      expect(JSON.stringify(await r.resolveMemories('alice', kind, refs))).not.toContain('HOST-SECRET');
    }
    expect(stream).not.toHaveBeenCalled();
  });

  it('uses a byte-bounded page without dropping matching message records', async () => {
    const s = service(), r = repo(); await call(s, 'open');
    for (let i = 0; i < 40; i++) {
      const { episode } = await admission(r, 'alice', 'needle ' + 'x'.repeat(8100));
      await r.finish(episode, 'completed');
    }
    const first = await call(s, 'search', { query: 'needle', limit: 50 });
    expect(first.items.length).toBeGreaterThan(0); expect(first.items.length).toBeLessThan(40);
    expect(Buffer.byteLength(JSON.stringify(first.items))).toBeLessThan(257 * 1024);
    const second = await call(s, 'search', { query: 'needle', cursor: first.nextCursor, limit: 50 });
    expect([...first.items, ...second.items].map(m => m.seq)).toEqual(Array.from({ length: 40 }, (_, i) => 40 - i));
    expect(second.nextCursor).toBeNull(); expect(stream).not.toHaveBeenCalled();
  });

  it('rejects malformed bounds, sections, query/cursors and unopened owners', async () => {
    const s = service(); await call(s, 'open');
    for (const payload of [{}, { query: '' }, { query: ' ' }, { query: 1 }, { query: '界'.repeat(171) }, { query: 'a', limit: 51 },
      { query: 'a', limit: 0 }, { query: 'a', limit: 1.5 }, { query: 'a', cursor: '1 OR 1=1' }, { query: 'a', cursor: 1 }, { query: 'a', ownerId: 'bob' }]) {
      await expect(call(s, 'search', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    for (const payload of [{}, { section: 'session-memory' }, { section: 'memory', cursor: '$ne' }, { section: 'skills', limit: 51 }, { section: 'skills', cursor: 1 }]) {
      await expect(call(s, 'inspect', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(call(s, 'inspect', { section: 'skills' }, 'unknown')).rejects.toMatchObject({ code: 'NOT_OPEN' });
    await expect(call(s, 'search', { query: 'a' }, 'unknown')).rejects.toMatchObject({ code: 'NOT_OPEN' });
    expect(stream).not.toHaveBeenCalled();
  });
});
