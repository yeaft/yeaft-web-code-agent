import { NATIVE_TOOL_IDS } from '../../../../agent/yeaft/person/native-tools.js';
import { describe, expect, it } from 'vitest';
import { PersonCapabilities, foundationCapabilities, CAPABILITY_LIMITS } from '../../../../agent/yeaft/person/capabilities.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';
import { bytes } from '../../../../agent/yeaft/person/contracts.js';

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
  it('keeps every catalog entry reachable with bounded contracts and full pagination', async () => {
    const cap = new PersonCapabilities({}, 'owner');
    const all = await cap.execute({ id: 'catalog.search', args: { limit: 5 } });
    expect(all.items).toHaveLength(5);
    expect(bytes(all.contracts)).toBeLessThanOrEqual(CAPABILITY_LIMITS.searchContractBytes);
    const ids = new Set([...all.contracts.map(m => m.id), ...all.omittedContracts.map(m => m.id)]);
    expect(ids.size).toBe(5);
    const paged = []; let cursor = null;
    do {
      const result = await cap.execute({ id: 'catalog.search', args: { cursor, limit: 1 } });
      paged.push(...result.items.map(m => m.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(paged).toEqual([...NATIVE_TOOL_IDS, 'Capability.create', 'Execution.read', 'Output.publish', 'PresentResponse', 'Recall', 'Skill.associate', 'Skill.reconsider', 'Think'].sort((a, b) => a.localeCompare(b, 'en')));
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
    expect(JSON.parse(context.messages[0].content).capabilities.active.map(m => m.id)).toEqual(['Think', 'Recall', 'Capability.create']);
    cap.activate(context.activeCapabilities);
    await expect(cap.execute({ id: 'Skill.associate', args: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
