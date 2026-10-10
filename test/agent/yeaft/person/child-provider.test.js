import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonChildProvider } from '../../../../agent/yeaft/person/child-provider.js';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { LLMAdapter, LLMAuthError } from '../../../../agent/yeaft/llm/adapter.js';
import { AnthropicAdapter } from '../../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../../agent/yeaft/llm/openai-responses.js';
import { resolveContextWindow, resolveMaxOutputTokens } from '../../../../agent/yeaft/models.js';

const MODEL = 'test/first';
const catalog = () => [
  { id: MODEL, contextWindow: 100000, maxOutput: 4096, efforts: ['low', 'high'] },
  { id: 'test/second', contextWindow: 80000, maxOutput: 2048, efforts: [] },
];
const nativeConfig = () => ({
  model: 'outside/large', primaryModel: 'outside/large', fastModel: 'outside/fast',
  fallbackModel: 'outside/fallback', secondaryModel: 'outside/secondary',
  models: { primary: 'outside/large', secondary: 'outside/secondary', reviewer: 'outside/review' },
  personaModels: { implementer: 'outside/code', reviewer: 'outside/review' },
  availableModels: [{ id: 'first', ref: MODEL, contextWindow: 999999, maxOutput: 99999 }, { id: 'outside' }],
  modelInfo: { id: 'outside', contextWindow: 999999, maxOutput: 99999 },
  providers: [{ name: 'test', models: ['first', 'second'] }, { name: 'outside', models: ['large'] }],
  maxOutputTokens: 16000, maxContextTokens: 999999, modelEffort: 'ultra',
  language: 'en', search: { backend: 'native' },
});
const textEvents = [
  { type: 'text_delta', text: 'Ordinary child response, not a Person proposal.' },
  { type: 'usage', inputTokens: 20, outputTokens: 8 },
  { type: 'stop', stopReason: 'end_turn' },
];
function setup({ selection = { model: MODEL, effort: 'low' }, config = nativeConfig(), adapter } = {}) {
  const calls = [];
  adapter ||= { async *stream(params) { calls.push(params); yield* textEvents; } };
  const provider = { adapter, catalog: catalog(), defaultSelection: { model: MODEL, effort: null } };
  return { ...createPersonChildProvider(provider, selection, config), provider, calls };
}
async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return events; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Person native child provider boundary', () => {
  it('pins native configuration and resolver metadata without mutating or sharing instance objects', () => {
    const instance = nativeConfig(), before = structuredClone(instance);
    const { config, provider } = setup({ config: instance });
    expect(config).toMatchObject({
      model: MODEL, primaryModel: MODEL, fastModel: MODEL, fastModelId: 'first', secondaryModel: MODEL,
      fallbackModel: null, modelEffort: 'low', maxOutputTokens: 4096, maxContextTokens: 100000,
      models: { primary: MODEL, secondary: MODEL, reviewer: MODEL, fast: MODEL },
      personaModels: { implementer: MODEL, reviewer: MODEL },
    });
    expect(config.availableModels).toHaveLength(1);
    expect(config.providers).toEqual([{ name: 'test', models: ['first'] }]);
    expect(resolveContextWindow(MODEL, config)).toBe(100000);
    expect(resolveMaxOutputTokens(MODEL, config)).toBe(4096);
    config.search.backend = 'changed'; config.providers[0].models.push('changed');
    config.modelInfo.effortOptions.push('ultra');
    expect(instance).toEqual(before);
    expect(provider.catalog).toEqual(catalog());
  });

  it('inherits native catalog capacities above 4K while preserving an explicit smaller instance ceiling', async () => {
    const calls = [], provider = { adapter: { async *stream(params) { calls.push(params); yield* textEvents; } },
      catalog: [{ id: MODEL, contextWindow: 1048576, maxOutput: 131072, efforts: [] }], defaultSelection: { model: MODEL, effort: null } };
    for (const ceiling of [undefined, 32768]) {
      const { adapter, config } = createPersonChildProvider(provider, null, ceiling ? { maxOutputTokens: ceiling } : {});
      await collect(adapter.stream({ model: MODEL, maxTokens: 131072 }));
      expect(calls.at(-1).maxTokens).toBe(ceiling ?? 131072);
      expect(resolveMaxOutputTokens(MODEL, config)).toBe(ceiling ?? 131072);
    }
  });
  it('uses only the default selection when omitted and rejects stale or invalid explicit selections', () => {
    const adapter = { async *stream() {} };
    const provider = { adapter, catalog: catalog(), defaultSelection: { model: MODEL, effort: null } };
    expect(createPersonChildProvider(provider).config.model).toBe(MODEL);
    expect(createPersonChildProvider(provider, null).config.modelEffort).toBeNull();
    for (const selection of [{}, { model: 'first' }, { model: 'outside/large' }, { model: MODEL, effort: 'medium' }, { model: MODEL, effort: 'bogus' }, { model: 'test/second', effort: 'low' }]) {
      expect(() => createPersonChildProvider(provider, selection)).toThrow(expect.objectContaining({ code: 'MODEL_SELECTION' }));
    }
    expect(() => createPersonChildProvider({ ...provider, catalog: [] })).toThrow(expect.objectContaining({ code: 'MODEL_UNAVAILABLE' }));
    expect(() => createPersonChildProvider({ ...provider, adapter: {} })).toThrow(expect.objectContaining({ code: 'MODEL_UNAVAILABLE' }));
    expect(() => createPersonChildProvider({ ...provider, catalog: [{ ...catalog()[0], maxOutput: NaN }] })).toThrow(expect.objectContaining({ code: 'MODEL_UNAVAILABLE' }));
  });

  it('strictly rejects missing, aliased and other allowed-candidate routes on every adapter entry point', async () => {
    const { adapter, calls } = setup();
    for (const model of [undefined, 'first', 'outside/large', 'test/second']) {
      for (const entry of [adapter, adapter.captureRequest()]) {
        expect(() => entry.stream({ model })).toThrow(expect.objectContaining({ code: 'MODEL_SELECTION' }));
        if (entry.captureStream) expect(() => entry.captureStream({ model })).toThrow(expect.objectContaining({ code: 'MODEL_SELECTION' }));
        await expect(entry.call({ model })).rejects.toMatchObject({ code: 'MODEL_SELECTION' });
      }
    }
    expect(calls).toHaveLength(0);
  });

  it('preserves tool schemas, normal text/tool events, callbacks and abort signal with an async iterable transport', async () => {
    const seen = [], events = [{ type: 'tool_call', id: 'one', name: 'FileRead', input: { file_path: 'README.md' } }, ...textEvents];
    const supplied = { stream(params) { seen.push(params); return { async *[Symbol.asyncIterator]() { yield* events; } }; } };
    const { adapter } = setup({ adapter: supplied });
    const params = { model: MODEL, tools: [{ name: 'FileRead', description: 'Read', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Read a file.' }], system: 'Native child soul', signal: new AbortController().signal,
      onEffortDecision: vi.fn(), onRawExchange: vi.fn(), onRequestStart: vi.fn(), maxTokens: 2000, effort: 'ultra' };
    const before = { ...params };
    expect(await collect(adapter.stream(params))).toEqual(events);
    expect(seen[0]).toMatchObject({ ...params, maxTokens: 2000, effort: 'low' });
    for (const key of ['tools', 'messages', 'signal', 'onEffortDecision', 'onRawExchange', 'onRequestStart']) expect(seen[0][key]).toBe(params[key]);
    expect(params).toEqual(before);
  });

  it('enforces output caps at dispatch and snapshots catalog/selection separately from caller mutations', async () => {
    const selection = { model: MODEL, effort: 'high' };
    const { adapter, config, calls, provider } = setup({ selection, config: { maxOutputTokens: 1500 } });
    expect(config.maxOutputTokens).toBe(1500);
    provider.catalog[0].maxOutput = 99999; provider.catalog[0].efforts.push('ultra');
    selection.model = 'test/second'; selection.effort = 'ultra'; config.maxOutputTokens = 99999;
    for (const [requested, expected] of [[undefined, 1500], [1000.9, 1000], [99999, 1500], [0, 1500], [-1, 1500], [Infinity, 1500], [NaN, 1500]]) {
      await collect(adapter.stream({ model: MODEL, maxTokens: requested, effort: 'ultra' }));
      expect(calls.at(-1)).toMatchObject({ model: MODEL, maxTokens: expected, effort: 'high' });
    }
  });

  it('uses catalog-safe effort, lowers inherited ceilings, removes synthesis/extraBody and never promotes null effort', async () => {
    const { adapter, calls } = setup({ selection: { model: MODEL, effort: 'high' } });
    const constraint = { parentDecision: { effective: 'medium' } };
    await collect(adapter.stream({ model: MODEL, effort: 'ultra', effortConstraint: constraint,
      extraBody: { model: 'outside/large', max_output_tokens: 99999, reasoning: { effort: 'ultra' } } }));
    expect(calls[0]).toMatchObject({ effort: 'low', effortConstraint: null, extraBody: undefined });
    await collect(adapter.stream({ model: MODEL, effortConstraint: { parentDecision: { effective: 'low', cap: 'minimal' } } }));
    expect(calls[1].effort).toBeUndefined();
    const noEffort = setup({ selection: { model: MODEL, effort: null } });
    await collect(noEffort.adapter.stream({ model: MODEL, effort: 'ultra', effortConstraint: constraint }));
    expect(noEffort.calls[0]).toMatchObject({ effort: undefined, effortConstraint: null });
    const unsupported = setup({ selection: { model: 'test/second', effort: null } });
    await collect(unsupported.adapter.stream({ model: 'test/second', effort: 'high' }));
    expect(unsupported.calls[0].effort).toBeUndefined();
  });

  it('omits manual thinking when a smaller request output reserve would be silently expanded', async () => {
    const calls = [], model = 'test/claude-sonnet-4-20250514';
    const { adapter } = createPersonChildProvider({ adapter: { async *stream(params) { calls.push(params); yield* textEvents; } },
      catalog: [{ id: model, contextWindow: 100000, maxOutput: 8192, efforts: ['low'] }] }, { model, effort: 'low' });
    await collect(adapter.stream({ model, maxTokens: 8192 }));
    await collect(adapter.stream({ model, maxTokens: 100 }));
    expect(calls[0].effort).toBe('low'); expect(calls[1].effort).toBeUndefined();
    expect(calls[1].maxTokens).toBe(100);
  });

  it('keeps real Anthropic wire output bounded and selected effort active with the feature flag off', async () => {
    vi.stubEnv('YEAFT_THINKING_V1', '0');
    const requests = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'reply', content: [{ type: 'text', text: 'Normal reply' }], stop_reason: 'end_turn', usage: {} }),
        { headers: { 'content-type': 'application/json' } });
    });
    const model = 'test/claude-sonnet-4-20250514';
    const { adapter, config } = createPersonChildProvider({ adapter: new AnthropicAdapter({ apiKey: 'test-key' }),
      catalog: [{ id: model, contextWindow: 100000, maxOutput: 8192, efforts: ['low', 'high'] }] }, { model, effort: 'high' });
    config.modelInfo.thinkingProtocol = 'anthropic-adaptive';
    config.modelInfo.effortOptions.push('ultra');
    const params = { model, system: 'Child', messages: [{ role: 'user', content: 'Reply' }], maxTokens: 99999,
      effortConstraint: { parentDecision: { effective: 'medium' } },
      extraBody: { max_tokens: 99999, thinking: { type: 'enabled', budget_tokens: 32000 } },
      effortContext: { thinkingProtocol: 'anthropic-adaptive', effortOptions: ['ultra'] },
      tools: [{ name: 'Read', parameters: { type: 'object' } }] };
    const events = await collect(adapter.stream(params));
    expect(events).toContainEqual({ type: 'text_delta', text: 'Normal reply' });
    expect(requests[0]).toMatchObject({ model, max_tokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 4096 }, tools: [{ name: 'Read', input_schema: { type: 'object' } }] });
    await collect(adapter.stream({ ...params, maxTokens: 100 }));
    expect(requests[1].max_tokens).toBe(100);
    expect(requests[1].thinking).toBeUndefined();
  });

  it('keeps real Responses wire effort inside the catalog with the feature flag off and inherited ceilings', async () => {
    vi.stubEnv('YEAFT_THINKING_V1', '0');
    const requests = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'reply', status: 'completed', output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Normal reply' }] }], usage: {} }),
      { headers: { 'content-type': 'application/json' } });
    });
    const model = 'test/gpt-5.4';
    const { adapter } = createPersonChildProvider({ adapter: new OpenAIResponsesAdapter({ apiKey: 'test-key' }),
      catalog: [{ id: model, contextWindow: 100000, maxOutput: 4096, efforts: ['low', 'high'] }] }, { model, effort: 'high' });
    const params = { model, messages: [{ role: 'user', content: 'Reply' }], maxTokens: 99999,
      effort: 'ultra', effortConstraint: { parentDecision: { effective: 'medium' } },
      extraBody: { max_output_tokens: 99999, reasoning: { effort: 'ultra' } },
      tools: [{ name: 'Read', parameters: { type: 'object' } }] };
    expect(await adapter.call(params)).toMatchObject({ text: 'Normal reply', stopReason: 'end_turn' });
    expect(requests[0]).toMatchObject({ model, max_output_tokens: 4096, reasoning: { effort: 'low' } });
    expect(requests[0].tools).toBeUndefined();
    await collect(adapter.stream({ ...params, effortConstraint: { parentDecision: { effective: 'low', cap: 'minimal' } } }));
    expect(requests[1].reasoning).toBeUndefined();
    expect(requests[1].tools[0]).toMatchObject({ type: 'function', name: 'Read' });
    const noEffort = createPersonChildProvider({ adapter: new OpenAIResponsesAdapter({ apiKey: 'test-key' }),
      catalog: [{ id: model, contextWindow: 100000, maxOutput: 4096, efforts: [] }] }, { model, effort: null });
    await collect(noEffort.adapter.stream(params));
    expect(requests[2].reasoning).toBeUndefined();
    expect(requests.every(request => request.max_output_tokens === 4096)).toBe(true);
  });

  it('retains private-field optional methods and guards inherited capture/call paths', async () => {
    class Adapter extends LLMAdapter {
      #label = 'original';
      label() { return this.#label; }
      seen = [];
      async *stream(params) { this.seen.push(params); yield* textEvents; }
      async call() { throw new Error('unguarded call must not run'); }
    }
    const supplied = new Adapter(), { adapter } = setup({ adapter: supplied });
    expect(adapter.label()).toBe('original');
    expect(await collect(adapter.captureStream({ model: MODEL }))).toEqual(textEvents);
    expect(await adapter.call({ model: MODEL, maxTokens: 99999 })).toEqual({ text: textEvents[0].text, stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 8 } });
    expect(supplied.seen).toHaveLength(2);
    expect(supplied.seen[1]).toMatchObject({ maxTokens: 4096, tools: undefined });
  });

  it('keeps native captured routing snapshots but guards every returned stream path', async () => {
    const captured = [], supplied = {
      stream: vi.fn(() => { throw new Error('live route must not be used'); }),
      captureRequest() { return { captureStream(params) { captured.push(params); return { async *[Symbol.asyncIterator]() { yield* textEvents; } }; } }; },
    };
    const { adapter } = setup({ adapter: supplied });
    const request = adapter.captureRequest();
    expect(await collect(request.captureStream({ model: MODEL, maxTokens: 99999 }))).toEqual(textEvents);
    expect(await collect(request.stream({ model: MODEL }))).toEqual(textEvents);
    expect(() => request.captureStream({ model: 'test/second' })).toThrow(expect.objectContaining({ code: 'MODEL_SELECTION' }));
    expect(captured).toHaveLength(2); expect(captured[0].maxTokens).toBe(4096);
    expect(supplied.stream).not.toHaveBeenCalled();
  });

  it('runs the real Engine tool loop using only the selected model and ordinary child text', async () => {
    const calls = [], supplied = { async *stream(params) {
      calls.push(params);
      if (calls.length === 1) {
        yield { type: 'tool_call', id: 'read-1', name: 'FileRead', input: { file_path: 'README.md' } };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else yield* textEvents;
    } };
    const { adapter, config } = setup({ adapter: supplied });
    const engine = new Engine({ adapter, config, trace: new NullTrace() });
    const execute = vi.fn(async () => 'Read successful.');
    engine.registerTool({ name: 'FileRead', description: 'Read file', parameters: { type: 'object' }, execute });
    const events = await collect(engine.query({ prompt: 'Read README.md.', messages: [], isSubAgent: true, scenario: 'sub_agent',
      parentEffortDecision: { effective: 'high' }, vpPersona: { vpId: 'child', displayName: 'Child', subAgent: { agentId: 'child' } } }));
    expect(execute).toHaveBeenCalledOnce(); expect(calls).toHaveLength(2);
    for (const params of calls) expect(params).toMatchObject({ model: MODEL, maxTokens: 4096, effort: 'low' });
    expect(calls[0].tools.some(tool => tool.name === 'FileRead')).toBe(true);
    expect(calls[1].messages.some(message => message.role === 'tool')).toBe(true);
    expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe(textEvents[0].text);
    expect(events.some(event => event.type === 'turn_end' && event.terminal === true)).toBe(true);
  });

  it('does not follow instance fallback routes when the real Engine sees a provider failure', async () => {
    const calls = [], supplied = { async *stream(params) { calls.push(params); throw new LLMAuthError('Denied', 401); } };
    const { adapter, config } = setup({ adapter: supplied });
    const engine = new Engine({ adapter, config, trace: new NullTrace() });
    const events = await collect(engine.query({ prompt: 'Hello', messages: [], isSubAgent: true, scenario: 'sub_agent' }));
    expect(calls).toHaveLength(1); expect(calls[0].model).toBe(MODEL);
    expect(events.some(event => event.type === 'fallback')).toBe(false);
    expect(events.some(event => event.type === 'turn_end' && event.terminal === true)).toBe(true);
  });
});
