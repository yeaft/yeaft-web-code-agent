import { NATIVE_TOOL_IDS } from '../../../../agent/yeaft/person/native-tools.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../../agent/yeaft/config.js';
import { AdapterRouter } from '../../../../agent/yeaft/llm/router.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { LIMITS, validateProposal } from '../../../../agent/yeaft/person/contracts.js';
import { validateFiles } from '../../../../agent/yeaft/person/attachments.js';
import { abortable, collectOutput, createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';

import { config, finalProposal } from './fixtures.js';
const validation = { stateVersion: 0, sourceRefs: new Set(['message:m:1']), concepts: new Map(), catalog: [{ id: 'test/first', efforts: ['low'] }] };

const tempDirs = [];
function configuredModels(value) {
  const dir = mkdtempSync(join(tmpdir(), 'yeaft-person-provider-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(value));
  return loadConfig({ dir });
}
function requestContext(provider, selection = provider.defaultSelection) {
  return assembleContext({ provider, selection, remainingCalls: 1,
    snapshot: { person: { id: 'p', name: 'Person', soul: 'Honesty.', soulRevision: 1 }, state: { version: 0 }, messages: [], concepts: [] },
    episode: { id: 'e', kind: 'think', text: '' } });
}
function stubProviderFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify(
    url.endsWith('/messages')
      ? { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: {} }
      : { output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }], status: 'completed', usage: {} }
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}
async function dispatch(provider, selection = provider.defaultSelection) {
  const context = requestContext(provider, selection);
  let decision;
  await collectOutput(provider.adapter, { model: selection.model, effort: selection.effort ?? undefined, effortSource: 'auto',
    system: context.system, messages: context.messages, maxTokens: context.maxTokens, signal: new AbortController().signal },
  value => { decision = value; });
  return { context, decision };
}

describe('digital Person strict contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  it.each([undefined, null, '', '   ', 42, {}])('is inert without a valid instance directory (%s)', async yeaftDir => {
    const service = createPersonService({ yeaftDir });
    expect(await service.request({ ownerId: 'owner', op: 'status' })).toMatchObject({ storage: 'sqlite', configured: false, storageReady: false });
    await expect(service.request({ ownerId: 'owner', op: 'open' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await service.close();
    await expect(service.request({ ownerId: 'owner', op: 'status' })).rejects.toMatchObject({ code: 'CLOSED' });
  });
  it('bounds optional feedback without duplicating long replies or exhausting a small model window', async () => {
    const provider = await createPersonProvider({ config: { ...config, availableModels: config.availableModels.map(m => ({ ...m, contextWindow: 32768 })) }, adapter: {} });
    const previous = finalProposal(); previous.reply = '中'.repeat(2730);
    const input = { provider, selection: provider.defaultSelection, remainingCalls: 1, previous,
      snapshot: { person: { id: 'p', soul: 'Honesty.' }, state: { version: 0 }, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'think', text: '' } };
    const feedback = { minIntervalMs: 30000, maxIntervalMs: 60000, elapsedSinceReplyMs: 0, due: false, lastReply: previous.reply };
    const context = assembleContext({ ...input, feedback });
    const body = JSON.parse(context.messages[0].content);
    expect(body.previousProposal.reply).toBe(previous.reply);
    expect(Buffer.byteLength(body.feedback.lastReply)).toBeLessThanOrEqual(512);
    expect(body.feedback.lastReplyTruncated).toBe(true);
    expect(body.feedback.lastReply).not.toContain('\ufffd');
    expect(context.manifest.contextBytes).toBeLessThanOrEqual(context.manifest.contextBudgetBytes);
    // Put mandatory content exactly at its limit: feedback is omitted, not a failure.
    const baseline = assembleContext(input);
    input.snapshot.person.soul += 'x'.repeat(baseline.manifest.contextBudgetBytes - baseline.manifest.contextBytes);
    const full = assembleContext({ ...input, feedback });
    expect(JSON.parse(full.messages[0].content).feedback).toBeUndefined();
  });

  it('rejects automatic thinking activation with a configured instance directory', async () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'person-admission-'));
    tempDirs.push(yeaftDir);
    const service = createPersonService({ yeaftDir, config });
    try {
      await expect(service.request({ ownerId: 'owner', op: 'settings', payload: { autonomyEnabled: true } }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED' });
      for (const op of ['idle', 'wake', 'schedule']) {
        await expect(service.request({ ownerId: 'owner', op })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      }
    } finally { await service.close(); }
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
  it('requires typed independent reports for every reported revision, including Dream', async () => {
    const provider = await createPersonProvider({ config, adapter: {} });
    const reportRef = 'message:user:1';
    const snapshot = { person: { id: 'p', name: 'Person', soul: 'Honesty.', soulRevision: 1 }, state: { version: 0 },
      messages: [{ id: 'user', revision: 1, role: 'user', text: 'I saw a blue bird.' }, { id: 'self', revision: 1, role: 'assistant', text: 'I imagined a red bird.' }],
      concepts: [
        { id: 'curiosity', revision: 1, epistemicState: 'imagined' },
        { id: 'guess', revision: 1, epistemicState: 'hypothesis', reportedSourceRefs: [reportRef] },
        { id: 'report', revision: 1, epistemicState: 'reported', reportedSourceRefs: [reportRef] },
        { id: 'legacy', revision: 1, epistemicState: 'reported', sourceRefs: [reportRef] },
      ] };
    for (const kind of ['send', 'think', 'dream']) {
      const context = assembleContext({ snapshot, episode: { id: 'e', kind, text: kind === 'dream' ? '' : 'I saw a blue bird.' },
        provider, selection: provider.defaultSelection, remainingCalls: 1 });
      const rules = { ...validation, sourceRefs: context.sourceRefs, concepts: context.concepts, sources: context.sources, dream: kind === 'dream' };
      const p = finalProposal(); p.concepts[0].expectedRevision = 1; p.concepts[0].epistemicState = 'reported';
      for (const ref of ['message:self:1', 'concept:curiosity:1', 'concept:guess:1', 'concept:legacy:1']) {
        p.concepts[0].sourceRefs = [ref]; expect(() => validateProposal(p, rules)).toThrow();
      }
      for (const ref of [reportRef, 'concept:report:1']) {
        p.concepts[0].sourceRefs = [ref]; expect(validateProposal(p, rules)).toBe(p);
      }
      p.concepts[0].sourceRefs = ['trigger:e'];
      if (kind === 'dream') expect(() => validateProposal(p, rules)).toThrow();
      else expect(validateProposal(p, rules)).toBe(p);
      p.concepts[0].id = 'new-report'; p.concepts[0].expectedRevision = 0;
      p.state.focusConceptIds = ['new-report']; p.concepts[0].sourceRefs = [reportRef];
      if (kind === 'dream') expect(() => validateProposal(p, rules)).toThrow();
      else expect(validateProposal(p, rules)).toBe(p);
    }
    const emptyThink = assembleContext({ snapshot, episode: { id: 'e', kind: 'think', text: ' ' }, provider,
      selection: provider.defaultSelection, remainingCalls: 1 });
    expect(emptyThink.sources.get('trigger:e').reportedSourceRefs).toEqual([]);
  });
  it('progressively discovers, inspects and applies only safe built-in methods', async () => {
    const capabilities = new PersonCapabilities({}, 'owner');
    await expect(capabilities.execute({ id: 'Skill.associate', args: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(capabilities.context().map(c => c.id)).toEqual(['Think', 'Recall', 'Capability.create']);
    const ids = []; let cursor = null;
    do {
      const result = await capabilities.execute({ id: 'catalog.search', args: { cursor, limit: 1 } });
      ids.push(...result.items.map(i => i.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(ids).toEqual([...NATIVE_TOOL_IDS, 'Capability.create', 'Recall', 'Skill.associate', 'Skill.reconsider', 'Think'].sort((a, b) => a.localeCompare(b, 'en')));
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
  it.each([
    ['test/second', 'test/second'], ['second', 'test/second'],
    ['global:retired/second', 'test/second'],
  ])('resolves configured default %s through normalized config', async (primaryModel, expected) => {
    const normalized = configuredModels({ providers: config.providers, primaryModel });
    const before = normalized.availableModels.map(m => m.ref);
    const provider = await createPersonProvider({ config: normalized, adapter: {} });
    expect(provider.defaultSelection).toEqual({ model: expected, effort: null });
    expect(provider.catalog[0].id).toBe(expected);
    expect(normalized.availableModels.map(m => m.ref)).toEqual(before);
  });
  it.each([
    ['anthropic', 'claude-sonnet-4-20250514', 8192, 4784],
    ['openai-responses', 'gpt-4o-mini', 8192, 2833],
    ['openai-responses', 'gpt-4.1-mini', 16384, Math.ceil(6144 * 1.62)],
  ])('binds Person image accounting to native %s %s wire', async (protocol, id, tokensPerImage, visualTokenBound) => {
    const normalized = configuredModels({ providers: [{ name: 'native', protocol, apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid', models: [
      { id, contextWindow: 128000 }, { id: 'vision-alias', supportsImages: true, contextWindow: 100000 },
      { id: 'gpt-4o', supportsImages: false }, 'o1-mini',
    ] }] });
    const provider = await createPersonProvider({ config: normalized });
    expect(provider.catalog.map(m => m.supportsImages)).toEqual([true, false, false, false]);
    const fetch = stubProviderFetch();
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=';
    const input = { provider, selection: provider.defaultSelection, remainingCalls: 1,
      snapshot: { person: { id: 'p', soul: 'Honesty.' }, state: {}, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'send', text: '' },
      attachments: validateFiles(Array.from({ length: 4 }, (_, i) => ({ name: `image-${i}.png`, mimeType: 'image/png', data }))) };
    const context = assembleContext(input);
    await collectOutput(provider.adapter, { model: `native/${id}`, system: context.system, maxTokens: context.maxTokens,
      messages: context.messages, signal: new AbortController().signal }, () => {});
    const wire = JSON.parse(fetch.mock.calls[0][1].body);
    const images = protocol === 'anthropic' ? wire.messages[0].content.filter(p => p.type === 'image')
      : wire.input[0].content.filter(p => p.type === 'input_image');
    expect(images).toHaveLength(4);
    for (const image of images) {
      if (protocol === 'anthropic') expect(image).toEqual({ type: 'image', source: { type: 'base64', data, media_type: 'image/png' } });
      else expect(image).toEqual({ type: 'input_image', image_url: `data:image/png;base64,${data}`, detail: 'low' });
    }
    // Explicit low detail bounds gpt-4o-mini to 2833 tokens/image regardless of
    // resolution/compression. Auto/high would invalidate this same reservation.
    expect(context.manifest.imageTokensReserved).toBe(4 * tokensPerImage);
    expect(context.manifest.contextWindowTokens).toBe(128000);
    expect(context.manifest.contextBudgetBytes).toBe(128000 - context.maxTokens - 1024 - 4 * tokensPerImage);
    expect(context.manifest.imageTokensReserved).toBeGreaterThanOrEqual(4 * visualTokenBound);
    expect(context.manifest.contextBytes + context.manifest.imageTokensReserved + context.maxTokens + 1024).toBeLessThanOrEqual(128000);
    expect(JSON.stringify(context.archiveMessages)).not.toContain(data);
    expect(context.manifest.imageBudget).toEqual({ tokensPerImage, ...(protocol === 'anthropic' ? {} : { detail: 'low' }) });
    const textBytes = Buffer.byteLength(context.system) + (protocol === 'anthropic' ? wire.messages[0].content : wire.input[0].content)
      .filter(part => part.type === 'text' || part.type === 'input_text').reduce((sum, part) => sum + Buffer.byteLength(part.text), 0);
    expect(context.manifest.contextBytes).toBe(textBytes);
    provider.catalog[0].contextWindow = 4 * tokensPerImage + context.maxTokens + 1024;
    expect(() => assembleContext(input)).toThrow(expect.objectContaining({ code: 'CONTEXT_LIMIT' }));
  });
  it('fails closed for unaccounted vision models and mismatched wire protocols', async () => {
    const normalized = configuredModels({ providers: [
      { name: 'wrong', protocol: 'anthropic', models: [{ id: 'gpt-4o-mini', supportsImages: true }] },
      { name: 'right', protocol: 'anthropic', models: [{ id: 'gpt-4o-mini', protocol: 'openai-responses' }] },
      { name: 'mixed', protocol: 'openai-responses', models: [
        { id: 'claude-sonnet-4', protocol: 'anthropic' }, { id: 'gpt-4o', supportsImages: false },
        { id: 'gpt-5-future', supportsImages: true }, { id: 'vision-alias', supportsImages: true }, 'gemini-2.5-pro',
      ] },
    ] });
    const provider = await createPersonProvider({ config: normalized, adapter: {} });
    expect(provider.catalog.map(m => [m.id, m.supportsImages])).toEqual([
      ['wrong/gpt-4o-mini', false], ['right/gpt-4o-mini', true], ['mixed/claude-sonnet-4', true],
      ['mixed/gpt-4o', false], ['mixed/gpt-5-future', false], ['mixed/vision-alias', false], ['mixed/gemini-2.5-pro', false],
    ]);
    for (const model of provider.catalog.filter(m => !m.supportsImages)) {
      expect(model.imageBudget).toBeNull();
      expect(() => assembleContext({ provider, selection: { model: model.id, effort: null }, remainingCalls: 1,
        snapshot: { person: { soul: '' }, state: {}, messages: [], concepts: [] }, episode: {},
        attachments: [{ kind: 'image' }] })).toThrow(expect.objectContaining({ code: 'IMAGE_MODEL' }));
    }
  });
  it.each(['gpt-4o-mini ', { id: 'gpt-4o-mini ', protocol: 'anthropic', supportsImages: false }])('matches Router exact IDs rather than whitespace-normalized duplicates: %j', async staleEntry => {
    const id = 'gpt-4o-mini';
    const provider = await createPersonProvider({ config: {
      providers: [{ name: 'native', protocol: 'openai-responses', models: [staleEntry, { id }] }],
      availableModels: [{ id, ref: `native/${id}`, contextWindow: 128000, maxOutput: 4096 }],
    }, adapter: {} });
    expect(provider.catalog[0].supportsImages).toBe(true);
    expect(provider.catalog[0].imageBudget).toEqual({ detail: 'low', tokensPerImage: 8192 });
  });
  it('uses normalized managed-provider protocols for image accounting', async () => {
    const id = 'gpt-4o-mini';
    const provider = await createPersonProvider({ config: {
      providers: [{ name: 'github-copilot', protocol: 'anthropic', models: [{ id, protocol: 'anthropic' }] }],
      availableModels: [{ id, ref: `github-copilot/${id}`, contextWindow: 128000, maxOutput: 4096 }],
    }, adapter: {} });
    expect(provider.catalog[0].imageBudget).toEqual({ detail: 'low', tokensPerImage: 8192 });
  });
  it('uses config.model when primaryModel is absent', async () => {
    const provider = await createPersonProvider({ config: { ...config, primaryModel: null, model: 'second' }, adapter: {} });
    expect(provider.defaultSelection).toEqual({ model: 'test/second', effort: null });
  });
  it.each([
    ['shared', 'one/shared'], ['two/shared', 'two/shared'],
  ])('preserves router ownership for duplicate IDs and provider rows: %s', async (primaryModel, expected) => {
    const normalized = configuredModels({ primaryModel, providers: [
      { name: 'one', models: ['first', 'shared', 'shared'] },
      { name: 'two', models: ['shared'] }, { name: 'one', models: ['shared', 'last'] },
    ] });
    const provider = await createPersonProvider({ config: normalized, adapter: {} });
    expect(provider.defaultSelection.model).toBe(expected);
    expect(provider.catalog.map(m => m.id).sort()).toEqual(['one/first', 'one/last', 'one/shared', 'two/shared']);
    const limited = await createPersonProvider({ config: normalized, adapter: {}, allowedModels: ['two/shared'] });
    expect(limited.catalog.map(m => m.id)).toEqual(['two/shared']);
  });
  it.each(['model9', 'test/model9'])('prioritizes %s while exposing the full configured catalog', async primaryModel => {
    const normalized = configuredModels({ primaryModel, providers: [{ name: 'test', models: Array.from({ length: 10 }, (_, i) => `model${i}`) }] });
    const provider = await createPersonProvider({ config: normalized, adapter: {} });
    expect(provider.catalog.map(m => m.id)).toEqual(['test/model9', ...Array.from({ length: 7 }, (_, i) => `test/model${i}`)]);
    expect(provider.availableModels.map(m => m.id)).toEqual(['test/model9', ...Array.from({ length: 9 }, (_, i) => `test/model${i}`)]);
    expect(provider.defaultSelection).toEqual({ model: 'test/model9', effort: null });
  });
  it.each([
    ['claude-sonnet-4-20250514', 4096], ['claude-sonnet-4-20250514', 2048], ['manual-alias', 4096],
  ])('rejects %s manual thinking that expands the %i output reserve before dispatch', async (id, maxOutput) => {
    vi.stubEnv('YEAFT_THINKING_V1', '1');
    const fetchMock = stubProviderFetch();
    const normalized = configuredModels({ primaryModel: `test/${id}`, providers: [{
      name: 'test', apiKey: 'test-only', baseUrl: 'https://person.invalid', protocol: 'anthropic',
      models: [{ id, contextWindow: 16384, maxOutput, ...(id === 'manual-alias' ? { supportsEffort: true } : {}) }],
    }] });
    const provider = await createPersonProvider({ config: normalized });
    expect(provider.adapter).toBeInstanceOf(AdapterRouter);
    expect(normalized.availableModels[0].effortOptions).toEqual(['low', 'medium', 'high']);
    expect(provider.catalog[0]).toMatchObject({ maxOutput, efforts: [] });
    for (const effort of normalized.availableModels[0].effortOptions) {
      expect(() => requestContext(provider, { model: provider.defaultSelection.model, effort })).toThrow(/catalog/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const { context, decision } = await dispatch(provider);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(maxOutput);
    expect(body.thinking).toBeUndefined();
    expect(context.manifest.outputTokensReserved).toBe(body.max_tokens);
    expect(context.manifest.contextBudgetBytes + body.max_tokens + 1024).toBe(16384);
    expect(decision).toEqual({ effective: null, wireMode: 'omitted', thinkingEnabled: false });
    // The exported preflight must not change ordinary native engine behavior.
    await provider.adapter.call({ model: provider.defaultSelection.model, system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: maxOutput, effort: 'high' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ max_tokens: 17408, thinking: { type: 'enabled', budget_tokens: 16384 } });
  });
  it.each([
    ['claude-opus-4-7', 'anthropic', undefined, ['low', 'medium', 'high', 'xhigh', 'max']],
    ['adaptive-alias', 'anthropic', 'anthropic-adaptive', ['low', 'high']],
    ['claude-sonnet-4-20250514', 'anthropic', 'anthropic-adaptive', ['low', 'high']],
    ['gpt-5.5', 'openai-responses', undefined, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ])('keeps %s effort, null defaults and disabled flags within the wire reserve', async (id, protocol, thinkingProtocol, efforts) => {
    const fetchMock = stubProviderFetch();
    const normalized = configuredModels({ providers: [{ name: 'test', apiKey: 'test-only', baseUrl: 'https://person.invalid', protocol,
      models: [{ id, contextWindow: 16384, maxOutput: 2048, ...(thinkingProtocol ? { thinkingProtocol, effortOptions: efforts } : {}) }],
    }] });
    for (const flag of ['1', '0']) {
      vi.stubEnv('YEAFT_THINKING_V1', flag);
      const provider = await createPersonProvider({ config: normalized });
      expect(provider.catalog[0].efforts).toEqual(flag === '1' ? efforts : []);
      expect(provider.defaultSelection.effort).toBeNull();
      if (flag === '0') expect(() => requestContext(provider, { ...provider.defaultSelection, effort: 'high' })).toThrow(/catalog/);
      for (const effort of [null, ...provider.catalog[0].efforts]) {
        const { context, decision } = await dispatch(provider, { model: provider.defaultSelection.model, effort });
        const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
        const maxTokens = protocol === 'anthropic' ? body.max_tokens : body.max_output_tokens;
        expect(maxTokens).toBe(2048);
        expect(context.maxTokens).toBe(maxTokens);
        expect(context.manifest.outputTokensReserved).toBe(maxTokens);
        expect(context.manifest.contextBytes).toBeLessThanOrEqual(context.manifest.contextBudgetBytes);
        expect(context.manifest.contextBudgetBytes + maxTokens + 1024).toBe(16384);
        if (effort && protocol === 'anthropic') {
          expect(body.thinking).toEqual({ type: 'adaptive' });
          expect(body.output_config).toEqual({ effort });
          expect(decision).toEqual({ effective: effort, wireMode: 'adaptive', thinkingEnabled: true });
        } else if (effort) {
          expect(body.reasoning).toEqual({ effort });
          expect(decision).toEqual({ effective: effort, wireMode: 'reasoning-effort', thinkingEnabled: true });
        } else {
          expect(body.thinking).toBeUndefined(); expect(body.reasoning).toBeUndefined(); expect(body.output_config).toBeUndefined();
          expect(decision).toMatchObject({ wireMode: 'omitted', thinkingEnabled: false });
          expect(decision.effective).toBe(id === 'claude-opus-4-7' ? 'high' : null);
        }
      }
    }
  });
  it('bounds short-term copies without mutating complete historical records', async () => {
    const provider = await createPersonProvider({ config: { ...config, availableModels: config.availableModels.map(m => ({ ...m, contextWindow: 65536 })) }, adapter: {} });
    const snapshot = { person: { id: 'person', name: 'Person', soul: 'Honesty.', soulRevision: 1 }, state: { version: 0 }, concepts: [],
      messages: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, revision: 1, role: 'user', text: '文'.repeat(2500) })) };
    const context = assembleContext({ snapshot, episode: { id: 'e', kind: 'think', text: '' }, provider, selection: provider.defaultSelection, remainingCalls: 1 });
    expect(context.manifest.omitted.length).toBeGreaterThan(0);
    expect(context.manifest.contextBytes).toBeLessThanOrEqual(context.manifest.contextBudgetBytes);
    expect(context.manifest.contextSources).toEqual({ recentMessages: JSON.parse(context.messages[0].content).messages.length, recentConcepts: 0,
      omittedMessages: context.manifest.omitted.length, omittedConcepts: 0, recall: { kind: null, count: 0 } });
    expect(snapshot.messages.every(m => m.text.length === 2500)).toBe(true);
  });
  it('uses each selected model window and dispatches a complete request larger than 64 KiB', async () => {
    const models = config.availableModels.map((m, i) => ({ ...m, contextWindow: i ? 1048576 : 32768 }));
    let request;
    const provider = await createPersonProvider({ config: { ...config, availableModels: models }, adapter: { async *stream(params) {
      request = params; yield { type: 'text_delta', text: '{}' }; yield { type: 'stop', stopReason: 'end_turn' };
    } } });
    const snapshot = { person: { id: 'p', soul: 'Honesty.' }, state: { version: 0 }, concepts: [],
      messages: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, revision: 1, role: 'user', text: '文'.repeat(2500) })) };
    for (const model of provider.catalog) {
      const context = assembleContext({ provider, snapshot, episode: { id: 'e', kind: 'think', text: '' }, remainingCalls: 1,
        selection: { model: model.id, effort: null } });
      expect(context.manifest.contextWindowTokens).toBe(model.contextWindow);
      expect(context.manifest.contextBudgetBytes).toBe(model.contextWindow - model.maxOutput - 1024);
      expect(context.manifest.envelopeTokensReserved).toBe(1024);
      expect(context.manifest.contextBytes).toBeLessThanOrEqual(context.manifest.contextBudgetBytes);
      if (model.contextWindow === 1048576) {
        expect(context.manifest.contextBytes).toBeGreaterThan(65536);
        expect(context.manifest.contextSources).toMatchObject({ recentMessages: 12, omittedMessages: 0 });
        await collectOutput(provider.adapter, { model: model.id, system: context.system, messages: context.messages,
          maxTokens: context.maxTokens, signal: new AbortController().signal }, () => {});
        expect(Buffer.byteLength(request.system) + Buffer.byteLength(request.messages[0].content)).toBe(context.manifest.contextBytes);
        expect(JSON.parse(request.messages[0].content).messages).toEqual(snapshot.messages);
      } else {
        expect(context.manifest.contextSources.omittedMessages).toBeGreaterThan(0);
        expect(context.manifest.contextSources.recentMessages + context.manifest.contextSources.omittedMessages).toBe(12);
        expect(() => assembleContext({ provider, snapshot: { ...snapshot, person: { soul: 'x'.repeat(32768) } },
          episode: { id: 'e', kind: 'think', text: '' }, remainingCalls: 1, selection: { model: model.id, effort: null } }))
          .toThrow(expect.objectContaining({ code: 'CONTEXT_LIMIT' }));
      }
    }
    expect(LIMITS).not.toHaveProperty('contextBytes');
  });

  it.each(['messages', 'concepts'])('counts actual %s Recall pages separately from deduplicated recent injection', async kind => {
    const provider = await createPersonProvider({ config, adapter: {} });
    const messages = [{ id: 'm', revision: 1, role: 'user', text: 'private report' }, { id: 'm2', revision: 1, role: 'assistant', text: 'private response' }];
    const concepts = [{ id: 'c', revision: 1, statement: 'private concept', epistemicState: 'uncertain' }];
    const snapshot = { person: { soul: 'Honesty.' }, state: {}, messages, concepts };
    const capabilities = new PersonCapabilities({ recall: async () => ({ items: kind === 'messages' ? messages.slice(0, 1) : concepts, nextCursor: null }) }, 'alice');
    const capabilityResult = await capabilities.execute({ id: 'Recall', args: { kind } });
    const input = { provider, selection: provider.defaultSelection, snapshot, episode: { id: 'e', kind: 'think', text: '' }, remainingCalls: 1 };
    const context = assembleContext({ ...input, capabilityResult });
    const rendered = JSON.parse(context.messages[0].content);
    expect(rendered.capabilityResult).toEqual(capabilityResult);
    expect(context.manifest.contextSources).toEqual({ recentMessages: kind === 'messages' ? 1 : 2, recentConcepts: kind === 'concepts' ? 0 : 1,
      omittedMessages: 0, omittedConcepts: 0, recall: { kind, count: 1 } });
    expect(JSON.stringify(context.manifest.contextSources)).not.toMatch(/private|message:|concept:|sourceRef|items/);
    expect(assembleContext({ ...input, capabilityResult: { ...capabilityResult, items: [] } }).manifest.contextSources.recall).toEqual({ kind, count: 0 });
    expect(assembleContext({ ...input, capabilityResult: { items: concepts } }).manifest.contextSources.recall).toEqual({ kind: null, count: 0 });
    const tiny = { ...provider, catalog: provider.catalog.map(m => ({ ...m, contextWindow: 16384 })) };
    const omitted = assembleContext({ ...input, provider: tiny, snapshot: { ...snapshot, messages: [], concepts: [{ ...concepts[0], statement: '文'.repeat(8000) }] } });
    expect(omitted.manifest.contextSources).toMatchObject({ recentConcepts: 0, omittedConcepts: 1 });
    expect(omitted.manifest.omitted).toContainEqual({ ref: 'concept:c:1', reason: 'context-budget' });
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
