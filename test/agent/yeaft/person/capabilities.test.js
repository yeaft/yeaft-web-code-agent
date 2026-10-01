import { describe, expect, it, vi } from 'vitest';
import { PersonCapabilities, foundationCapabilities, CAPABILITY_LIMITS } from '../../../../agent/yeaft/person/capabilities.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';
import { bytes } from '../../../../agent/yeaft/person/contracts.js';
import * as contracts from '../../../../agent/yeaft/person/contracts.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { config } from './fixtures.js';

const now = Date.parse('2026-10-01T12:00:00Z');
async function experience(id = 'Skill.associate', observations) {
  const cap = new PersonCapabilities({}, 'owner');
  const { version, revision } = await cap.execute({ id: 'catalog.view', args: { id } });
  return { id, version, revision, observations: observations ?? [{ episodeId: 'prior', callId: 'c', triggerKind: 'dream', outcome: 'succeeded', code: null, usedAt: new Date(now - 1000).toISOString() }] };
}
const options = history => ({ experience: history, triggerKind: 'dream', now });

describe('Person three-layer capabilities without a selector', () => {
  it('prepares complete foundation contracts without calling or searching anything', async () => {
    const recall = vi.fn(async () => ({ items: [], nextCursor: null }));
    const cap = new PersonCapabilities({ recall }, 'alice');
    expect(recall).not.toHaveBeenCalled();
    const active = cap.context();
    expect(active.map(m => m.id)).toEqual(['Think', 'Recall']);
    expect(active.every(m => m.instructions && m.args && m.revision && m.useWhen && m.avoidWhen)).toBe(true);
    expect(active.every(m => m.availability.layer === 'foundation')).toBe(true);
    cap.activate(active);
    await cap.execute({ id: 'Recall', args: { kind: 'messages', query: 'prior words' } });
    expect(recall).toHaveBeenCalledWith('alice', expect.objectContaining({ kind: 'messages', query: 'prior words' }), { signal: undefined });
  });

  it('discovers Chinese or English needs and prepares contracts without a view call', async () => {
    for (const query of ['联想', 'association', 'method association']) {
      const cap = new PersonCapabilities({}, 'owner');
      const result = await cap.execute({ id: 'catalog.search', args: { query } });
      expect(result.items.map(m => m.id)).toContain('Skill.associate');
      expect(result.contracts.map(m => m.id)).toContain('Skill.associate');
      expect(bytes(result.contracts)).toBeLessThanOrEqual(CAPABILITY_LIMITS.searchContractBytes);
      cap.activate(cap.context());
      expect(await cap.execute({ id: 'Skill.associate', args: {} })).toMatchObject({ access: 'method-only' });
    }
    const cap = new PersonCapabilities({}, 'owner');
    expect((await cap.execute({ id: 'catalog.search', args: { query: '能力不存在' } })).items).toEqual([]);
    await expect(cap.execute({ id: 'Skill.reconsider', args: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('keeps every catalog entry reachable with bounded contracts and full pagination', async () => {
    const cap = new PersonCapabilities({}, 'owner');
    const all = await cap.execute({ id: 'catalog.search', args: { limit: 5 } });
    expect(all.items).toHaveLength(4);
    expect(bytes(all.contracts)).toBeLessThanOrEqual(CAPABILITY_LIMITS.searchContractBytes);
    const ids = new Set([...all.contracts.map(m => m.id), ...all.omittedContracts.map(m => m.id)]);
    expect(ids.size).toBe(4);
    const paged = []; let cursor = null;
    do {
      const result = await cap.execute({ id: 'catalog.search', args: { cursor, limit: 1 } });
      paged.push(...result.items.map(m => m.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(paged).toEqual(['Recall', 'Skill.associate', 'Skill.reconsider', 'Think']);
  });

  it('leaves an over-budget search contract unprepared until explicitly viewed', async () => {
    const cap = new PersonCapabilities({}, 'owner');
    const actualBytes = contracts.bytes;
    // Simulate a growing catalog contract, without adding a production-only test knob.
    const size = vi.spyOn(contracts, 'bytes').mockImplementation(value =>
      Array.isArray(value) && value.some(entry => entry?.id === 'Skill.associate')
        ? CAPABILITY_LIMITS.searchContractBytes + 1 : actualBytes(value));
    try {
      const result = await cap.execute({ id: 'catalog.search', args: { query: '联想' } });
      expect(result.items.map(m => m.id)).toEqual(['Skill.associate']);
      expect(result.contracts).toEqual([]);
      expect(result.omittedContracts).toEqual([{ id: 'Skill.associate', reason: 'contract-budget', inspect: 'catalog.view' }]);
      expect(cap.context().map(m => m.id)).toEqual(['Think', 'Recall']);
      await expect(cap.execute({ id: 'Skill.associate', args: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      expect(await cap.execute({ id: 'catalog.view', args: { id: 'Skill.associate' } })).toMatchObject({ id: 'Skill.associate', instructions: expect.any(String) });
      cap.activate(cap.context());
      expect(await cap.execute({ id: 'Skill.associate', args: {} })).toMatchObject({ access: 'method-only' });
    } finally { size.mockRestore(); }
  });

  it('restores bounded familiar contracts from current manifests, never cached instructions', async () => {
    const prior = await experience(); prior.instructions = 'malicious cached contract';
    const cap = new PersonCapabilities({}, 'owner', options([prior]));
    const familiar = cap.context().find(m => m.id === prior.id);
    expect(familiar.instructions).not.toContain('malicious');
    expect(familiar.availability).toMatchObject({ layer: 'familiar', reason: 'used-in-same-trigger-kind', experience: { observedSuccesses: 1, usefulness: 'not-evaluated' } });
    expect(cap.context().filter(m => m.availability.layer === 'familiar').length).toBeLessThanOrEqual(CAPABILITY_LIMITS.familiar);
    await expect(cap.execute({ id: prior.id, args: { command: 'forbidden' } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('demotes failed, expired, changed, future or unknown experience without removing discoverability', async () => {
    const prior = await experience();
    const bad = [
      { ...prior, revision: 'old' }, { ...prior, version: 0 }, { ...prior, id: 'Bash' },
      { ...prior, observations: [{ ...prior.observations[0], outcome: 'failed' }] },
      { ...prior, observations: [{ ...prior.observations[0], usedAt: new Date(now - CAPABILITY_LIMITS.familiarMaxAgeMs - 1).toISOString() }] },
      { ...prior, observations: [{ ...prior.observations[0], usedAt: new Date(now + 1000).toISOString() }] },
    ];
    for (const record of bad) {
      const cap = new PersonCapabilities({}, 'owner', options([record]));
      expect(cap.context().map(m => m.id)).toEqual(['Think', 'Recall']);
      await cap.execute({ id: 'catalog.view', args: { id: prior.id } });
      expect(await cap.execute({ id: prior.id, args: {} })).toMatchObject({ access: 'method-only' });
    }
  });

  it('never treats discovery, another Person instance or modified projection as permission', async () => {
    const a = new PersonCapabilities({}, 'alice'), b = new PersonCapabilities({}, 'bob');
    await a.execute({ id: 'catalog.view', args: { id: 'Skill.associate' } });
    await expect(b.execute({ id: 'Skill.associate', args: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const projection = a.context(); projection.find(c => c.id === 'Skill.associate').revision = 'forged';
    a.activate(projection);
    await expect(a.execute({ id: 'Skill.associate', args: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(a.context().find(c => c.id === 'Skill.associate').revision).not.toBe('forged');
    const controller = new AbortController(); controller.abort();
    await expect(a.execute({ id: 'catalog.view', args: { id: 'Skill.associate' } }, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
  });

  it('renders complete contracts and traces layers; context-omitted contracts cannot execute', async () => {
    const provider = await createPersonProvider({ config, adapter: {} });
    const cap = new PersonCapabilities({}, 'owner', options([await experience()]));
    const input = { snapshot: { person: { id: 'p', name: 'P', soul: 'Honesty.', soulRevision: 1 }, state: { version: 0 }, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'dream', text: '' }, provider, selection: provider.defaultSelection, remainingCalls: 2 };
    const base = assembleContext({ ...input, activeCapabilities: foundationCapabilities() });
    const model = provider.catalog.find(m => m.id === provider.defaultSelection.model);
    model.contextWindow = base.manifest.contextBytes + model.maxOutput + 1024 + 10;
    const context = assembleContext({ ...input, activeCapabilities: cap.context() });
    expect(context.manifest.omittedCapabilities).toEqual([{ id: 'Skill.associate', reason: 'context-budget', inspect: 'catalog.view' }]);
    expect(context.manifest.activeCapabilities.every(m => m.layer === 'foundation')).toBe(true);
    expect(JSON.parse(context.messages[0].content).capabilities.active.map(m => m.id)).toEqual(['Think', 'Recall']);
    cap.activate(context.activeCapabilities);
    await expect(cap.execute({ id: 'Skill.associate', args: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
