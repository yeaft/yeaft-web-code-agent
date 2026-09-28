import { describe, expect, it } from 'vitest';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { LIMITS, validateProposal } from '../../../../agent/yeaft/person/contracts.js';
import { abortable, collectOutput, createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';

import { config, finalProposal } from './fixtures.js';
const validation = { stateVersion: 0, sourceRefs: new Set(['message:m:1']), concepts: new Map(), catalog: [{ id: 'test/first', efforts: ['low'] }] };

describe('digital Person strict contracts', () => {
  it('is inert and safe without configured MongoDB', async () => {
    const service = createPersonService();
    expect(await service.request({ ownerId: 'owner', op: 'status' })).toMatchObject({ configured: false, storageReady: false });
    await expect(service.request({ ownerId: 'owner', op: 'open' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await service.close();
    await expect(service.request({ ownerId: 'owner', op: 'status' })).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('accepts only typed, sourced and versioned cognitive proposals', () => {
    expect(validateProposal(finalProposal(), validation).activity.kind).toBe('think');
    for (const mutate of [
      p => { p.workItemId = 'forbidden'; }, p => { p.baseStateVersion = 1; },
      p => { p.concepts[0].epistemicState = 'fact'; }, p => { p.concepts[0].sourceRefs = ['someone-elses-message']; },
      p => { p.concepts[0].associations = [{ targetId: 'unread', relation: 'related' }]; },
      p => { p.concepts[0].expectedRevision = 2; }, p => { p.concepts[0].kind = 'scenario'; },
      p => { p.concepts[0].epistemicState = 'reported'; }, p => { p.state.focusConceptIds.push('missing'); },
      p => { p.reply = 'x'.repeat(8193); }, p => { p.activity.hiddenReasoning = 'no'; },
    ]) {
      const proposal = finalProposal(); mutate(proposal);
      expect(() => validateProposal(proposal, validation)).toThrow();
    }
    const proposal = finalProposal();
    proposal.next = { model: 'external/unconfigured', effort: null, reason: 'switch', capability: null };
    expect(() => validateProposal(proposal, validation)).toThrow(/catalog/);
    proposal.next.model = 'test/first'; proposal.next.effort = 'ultra';
    expect(() => validateProposal(proposal, validation)).toThrow(/catalog/);
  });
  it('Dream imagination cannot become a new reported fact', () => {
    const p = finalProposal(); p.concepts[0].sourceRefs = ['message:m:1']; p.concepts[0].epistemicState = 'reported';
    expect(() => validateProposal(p, { ...validation, dream: true })).toThrow();
    p.concepts[0].kind = 'scenario'; p.concepts[0].epistemicState = 'imagined';
    expect(validateProposal(p, { ...validation, dream: true })).toBe(p);
  });
  it('progressively discovers, inspects and applies only safe built-in methods', async () => {
    const capabilities = new PersonCapabilities({}, 'owner');
    await expect(capabilities.execute({ id: 'Recall', args: { kind: 'messages' } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const ids = []; let cursor = null;
    do {
      const result = await capabilities.execute({ id: 'catalog.search', args: { cursor, limit: 1 } });
      ids.push(...result.items.map(i => i.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['Recall', 'Skill.associate', 'Skill.reconsider', 'Think']);
    expect(await capabilities.execute({ id: 'catalog.view', args: { id: 'Skill.associate' } })).toMatchObject({ access: 'read-only', version: 1 });
    expect(await capabilities.execute({ id: 'Skill.associate', args: {} })).toMatchObject({ access: 'method-only' });
    await expect(capabilities.execute({ id: 'Bash', args: { command: 'touch /tmp/not-allowed' } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  it('uses a bounded configured model catalog and does not lie about disabled effort', async () => {
    const provider = await createPersonProvider({ config, adapter: {}, effortEnabled: false });
    expect(provider.catalog.map(m => m.efforts)).toEqual([[], []]);
    const limited = await createPersonProvider({ config, adapter: {}, allowedModels: ['test/second'], effortEnabled: true });
    expect(limited.catalog).toHaveLength(1); expect(limited.catalog[0].efforts).toContain('high');
  });
  it('bounds short-term copies without mutating complete historical records', async () => {
    const provider = await createPersonProvider({ config, adapter: {} });
    const snapshot = { person: { id: 'person', name: 'Person', soul: 'Honesty.', soulRevision: 1 }, state: { version: 0 }, concepts: [],
      messages: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, revision: 1, role: 'user', text: '文'.repeat(2500) })) };
    const context = assembleContext({ snapshot, episode: { id: 'e', kind: 'think', text: '' }, provider, selection: provider.defaultSelection, remainingCalls: 1 });
    expect(context.manifest.omitted.length).toBeGreaterThan(0);
    expect(context.manifest.contextBytes).toBeLessThanOrEqual(LIMITS.contextBytes);
    expect(snapshot.messages.every(m => m.text.length === 2500)).toBe(true);
  });
  it('never archives hidden thinking and labels rejected oversize prefixes incomplete', async () => {
    const controller = new AbortController();
    const adapter = { async *stream() {
      yield { type: 'thinking_delta', text: 'hidden secret' };
      yield { type: 'text_delta', text: '{}' };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    expect(await collectOutput(adapter, { signal: controller.signal }, () => {})).toMatchObject({ text: '{}', bytes: 2 });
    const oversized = { async *stream() { yield { type: 'text_delta', text: 'prefix' }; yield { type: 'text_delta', text: 'x'.repeat(LIMITS.outputBytes) }; } };
    const error = await collectOutput(oversized, { signal: controller.signal }, () => {}).catch(e => e);
    expect(error).toMatchObject({ code: 'OUTPUT_LIMIT', partialOutput: { retainedBytes: LIMITS.outputBytes, complete: false, accepted: false } });
    expect(error.partialOutput.text.startsWith('prefix')).toBe(true);
  });
  it('preserves prior call provenance without pretending omitted content was rendered again', async () => {
    const provider = await createPersonProvider({ config, adapter: {} });
    const snapshot = { person: { id: 'person', name: 'Person', soul: 'Honesty.', soulRevision: 1 }, state: { version: 0 }, concepts: [], messages: [] };
    const context = assembleContext({ snapshot, episode: { id: 'episode', kind: 'think', text: '' }, provider,
      selection: provider.defaultSelection, remainingCalls: 1, dependencyRefs: ['message:older:1'] });
    expect(context.sourceRefs.has('message:older:1')).toBe(true);
    expect(context.manifest.renderedSourceRefs).not.toContain('message:older:1');
    expect(context.manifest.inputDependencyRefs).toContain('message:older:1');
    const p = finalProposal(); p.concepts[0].sourceRefs = ['message:older:1'];
    expect(validateProposal(p, { ...validation, sourceRefs: context.sourceRefs })).toBe(p);
  });

  it('observes a rejecting operation even when cancellation preceded the wait', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(abortable(Promise.reject(new Error('late failure')), controller.signal)).rejects.toBe(controller.signal.reason);
    await new Promise(resolve => setImmediate(resolve));
  });

  it('retains only complete UTF-8 code points in an oversized rejected prefix', async () => {
    const adapter = { async *stream() { yield { type: 'text_delta', text: '文'.repeat(LIMITS.outputBytes) }; } };
    const error = await collectOutput(adapter, { signal: new AbortController().signal }, () => {}).catch(e => e);
    expect(error.partialOutput.text).not.toContain('\uFFFD');
    expect(error.partialOutput.retainedBytes).toBe(LIMITS.outputBytes - 1);
    expect(error.partialOutput).toMatchObject({ complete: false, accepted: false });
  });

});
