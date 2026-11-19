import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { LLMServerError } from '../../../agent/yeaft/llm/adapter.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});
async function collect(generator) {
  const seen = [];
  for await (const event of generator) seen.push(event);
  return seen;
}

const responsesTool = (id, ...args) => ({ type: 'function_call', call_id: id, name: 'Tool', arguments: args.length ? args[0] : '{}' });
const responsesSlot = (index, args) => [
  { type: 'response.output_item.added', output_index: index, item: responsesTool(`call-${index}`, '') },
  { type: 'response.function_call_arguments.delta', output_index: index, delta: args },
  { type: 'response.function_call_arguments.done', output_index: index, arguments: args },
];
const responsesEnd = (output = [], status = 'completed') => ({ type: `response.${status}`, response: {
  status, output, usage: { input_tokens: 10, output_tokens: 25 },
} });
const anthropicTool = (id, input = {}) => ({ type: 'tool_use', id, name: 'Tool', input });
const anthropicSlot = (index, input) => [
  { type: 'content_block_start', index, content_block: anthropicTool(`call-${index}`) },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input } },
  { type: 'content_block_stop', index },
];
const anthropicEnd = (stop_reason = 'tool_use') => [
  { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 25 } },
  { type: 'message_stop' },
];
const fixtures = [
  { protocol: 'openai-responses', create: () => new OpenAIResponsesAdapter({ apiKey: 'synthetic', baseUrl: 'https://proxy.invalid' }),
    invalidJson: () => ({ status: 'completed', output: [responsesTool('good'), responsesTool('bad', '{"PRIVATE":')], usage: {} }),
    invalidSse: () => [...responsesSlot(0, '{}'), ...responsesSlot(1, '{"PRIVATE":'), responsesEnd()],
    validJson: () => ({ status: 'completed', output: [responsesTool('empty'), responsesTool('object', '{"value":1}')], usage: {} }) },
  { protocol: 'anthropic', create: () => new AnthropicAdapter({ apiKey: 'synthetic', baseUrl: 'https://proxy.invalid' }),
    invalidJson: () => ({ content: [anthropicTool('good'), anthropicTool('bad', ['PRIVATE'])], stop_reason: 'tool_use', usage: {} }),
    invalidSse: () => [...anthropicSlot(0, '{}'), ...anthropicSlot(1, '{"PRIVATE":'), ...anthropicEnd()],
    validJson: () => ({ content: [anthropicTool('empty'), anthropicTool('object', { value: 1 })], stop_reason: 'tool_use', usage: {} }) },
];

afterEach(() => vi.unstubAllGlobals());

describe('Responses retries transport EOF only before tool publication', () => {
  const adapter = fixtures[0].create;
  const partial = [
    { type: 'response.output_item.added', output_index: 1, item: responsesTool('unfinished', '') },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"PRIVATE":' },
  ];
  const truncated = [...responsesSlot(0, '{}'), ...partial];
  const retryPolicy = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 };

  function createEngine(options = {}) {
    const execute = vi.fn(async () => 'executed once');
    const registry = new ToolRegistry();
    registry.register({ name: 'Tool', description: 'test', parameters: { type: 'object', properties: {} }, execute });
    return { execute, engine: new Engine({ adapter: adapter(), trace: new NullTrace(), toolRegistry: registry,
      config: { model: 'test-model', maxOutputTokens: 1024, projectDocMaxBytes: 0, llmRetry: retryPolicy }, ...options }) };
  }

  it('restarts or continues after EOF, discarding the failed batch and executing only the successful request once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'responses-eof-retry-'));
    try {
      const store = new ConversationStore(dir);
      for (const prefix of ['', 'I will check this.']) {
        const requests = [];
        const fetch = vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          if (requests.length === 1) return sse([
            ...(prefix ? [{ type: 'response.output_text.delta', delta: prefix }] : []), ...truncated,
          ]);
          if (requests.length === 2) return sse(responsesSlot(0, '{}').concat(responsesEnd([responsesTool('call-0')])));
          return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Checked.' }] }], usage: {} });
        });
        vi.stubGlobal('fetch', fetch);
        const { engine, execute } = createEngine({ conversationStore: store, yeaftDir: dir });
        const sessionId = prefix ? 'with-prefix' : 'without-prefix';
        const seen = await collect(engine.query({ prompt: 'Use Tool', sessionId }));
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0][0]).toEqual({});
        expect(seen.filter(e => e.type === 'llm_retry')).toEqual([expect.objectContaining({
          attempt: 1, maxRetries: 2, reason: 'transient_backoff', recoveryMode: prefix ? 'continue' : 'restart',
        })]);
        expect(seen.filter(e => e.type === 'tool_call')).toHaveLength(1);
        expect(seen.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe(`${prefix}Checked.`);
        expect(seen.some(e => e.type === 'error')).toBe(false);
        expect(seen.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'end_turn' }),
        ]);
        const persisted = store.loadRecentBySession(sessionId, 50);
        expect(persisted.flatMap(row => row.toolCalls || [])).toHaveLength(1);
        expect(persisted.filter(row => row.role === 'tool')).toHaveLength(1);
        expect(JSON.stringify(requests[1])).not.toContain('PRIVATE');
        if (prefix) {
          expect(JSON.stringify(requests[1])).toContain(prefix);
          expect(persisted.filter(row => row.content === prefix)).toEqual([
            expect.objectContaining({ role: 'assistant', incomplete: true, stopReason: 'retry' }),
          ]);
        } else expect(requests[1].input).toEqual(requests[0].input);
      }
    } finally {
      await closeConversationHistoryIndexes();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not replay a transport failure after a tool call crossed the adapter boundary', async () => {
    let requests = 0;
    const { engine, execute } = createEngine({ adapter: { async *stream() {
      requests += 1;
      yield { type: 'tool_call', id: 'published', name: 'Tool', input: {} };
      throw new LLMServerError('stream ended after tool publication', 0);
    } } });
    const seen = await collect(engine.query({ prompt: 'Use Tool' }));
    expect(requests).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(seen.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(seen.filter(e => e.type === 'llm_retry')).toEqual([]);
    expect(seen.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
      expect.objectContaining({ stopReason: 'error' }),
    ]);
  });
});
