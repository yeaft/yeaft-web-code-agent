import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersonChildProvider } from '../../../../agent/yeaft/person/child-provider.js';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { LLMAuthError } from '../../../../agent/yeaft/llm/adapter.js';

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
