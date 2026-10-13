import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonChildProvider } from '../../../../agent/yeaft/person/child-provider.js';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { LLMAuthError } from '../../../../agent/yeaft/llm/adapter.js';
import { AnthropicAdapter } from '../../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../../agent/yeaft/llm/openai-responses.js';

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
