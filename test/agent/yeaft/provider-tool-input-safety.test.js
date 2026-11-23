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
const responsesFailure = (code, message, headers) => ({
  type: 'response.failed', response: { status: 'failed', error: { code, message, headers } },
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

describe('Responses retries failed streams without replaying tools', () => {
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

  it('retries EOF and transient terminal errors, keeping text and completed tool results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'responses-stream-retry-'));
    try {
      const store = new ConversationStore(dir);
      const cases = [
        { session: 'eof-without-prefix' },
        { session: 'eof-with-prefix', prefix: 'I will check this. ' },
        { session: 'server-error', failure: responsesFailure('server_error', 'temporary upstream failure') },
        { session: 'overloaded', failure: responsesFailure('server_is_overloaded', 'overloaded', { 'Retry-After': 0.006 }),
          delayMs: 5, reason: 'transient_retry_after' },
        { session: 'limited-after-tool', prefix: 'I checked this. ', afterTool: true,
          failure: responsesFailure('rate_limit_exceeded', 'Try again in 3ms.', { 'Retry-After': '0.004' }),
          delayMs: 4, reason: 'rate_limit_retry_after' },
        { session: 'legacy-error', failure: { type: 'response.error', error: { code: 'slow_down', message: 'Try again in 3ms.' } },
          delayMs: 3, reason: 'rate_limit_retry_after' },
        { session: 'http-retry-after', failure: responsesFailure('server_error', 'Temporary error.', { 'Retry-After': { toString: null } }),
          httpRetryAfter: '0.003', delayMs: 3, reason: 'transient_retry_after' },
      ];
      for (const { session, prefix = '', afterTool = false, failure, httpRetryAfter,
        delayMs = 1, reason = 'transient_backoff' } of cases) {
        const requests = [];
        const cancel = vi.fn();
        const toolResponse = () => sse([...responsesSlot(0, '{}'), responsesEnd([responsesTool('call-0')])]);
        const failureRequest = afterTool ? 1 : 0;
        const fetch = vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body));
          const attempt = requests.length - 1;
          if (attempt === (afterTool ? 0 : 1)) return toolResponse();
          if (attempt === failureRequest) {
            const events = [...(prefix ? [{ type: 'response.output_text.delta', delta: prefix }] : []), ...truncated];
            if (!failure) return sse(events);
            // A terminal failure must cancel the reader without waiting for EOF.
            return new Response(new ReadableStream({
              start(controller) {
                const text = [...events, failure].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
                controller.enqueue(new TextEncoder().encode(text));
              },
              cancel,
            }), { headers: { 'content-type': 'text/event-stream', ...(httpRetryAfter ? { 'retry-after': httpRetryAfter } : {}) } });
          }
          return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Checked.' }] }], usage: {} });
        });
        vi.stubGlobal('fetch', fetch);
        const { engine, execute } = createEngine({ conversationStore: store, yeaftDir: dir });
        const seen = await collect(engine.query({ prompt: 'Use Tool', sessionId: session }));
        expect(seen.filter(e => e.type === 'llm_retry'), session).toEqual([expect.objectContaining({
          attempt: 1, maxRetries: 2, reason, delayMs, recoveryMode: prefix ? 'continue' : 'restart',
        })]);
        expect(cancel).toHaveBeenCalledTimes(failure ? 1 : 0);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0][0]).toEqual({});
        expect(seen.filter(e => e.type === 'tool_call')).toHaveLength(1);
        expect(seen.filter(e => e.type === 'text_delta').map(e => e.text).join('')).toBe(`${prefix}Checked.`);
        expect(seen.some(e => e.type === 'error')).toBe(false);
        expect(seen.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
          expect.objectContaining({ stopReason: 'end_turn' }),
        ]);
        const persisted = store.loadRecentBySession(session, 50);
        expect(persisted.flatMap(row => row.toolCalls || [])).toHaveLength(1);
        expect(persisted.filter(row => row.role === 'tool')).toHaveLength(1);
        const retry = requests[failureRequest + 1].input;
        expect(JSON.stringify(retry)).not.toMatch(/PRIVATE|unfinished/);
        if (afterTool) {
          const results = input => input.filter(item => item.type === 'function_call_output');
          expect(results(retry)).toEqual([expect.objectContaining({ call_id: 'call-0', output: 'executed once' })]);
          expect(results(retry)).toEqual(results(requests[failureRequest].input));
        }
        if (prefix) {
          expect(JSON.stringify(retry)).toContain(prefix);
          expect(persisted.filter(row => row.content === prefix)).toEqual([
            expect.objectContaining({ role: 'assistant', incomplete: true, stopReason: 'retry' }),
          ]);
        } else expect(retry).toEqual(requests[failureRequest].input);
      }
    } finally {
      await closeConversationHistoryIndexes();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not retry permanent errors, run rejected tools, or replay after tool publication', async () => {
    const headers = { 'Retry-After': '0.001' };
    for (const error of [
      { code: 'invalid_request_error', message: 'Bad request.' },
      { code: 'insufficient_quota', type: 'rate_limit_error', message: 'Quota exhausted.' },
      { code: 'content_policy_violation', message: 'Request rejected.' },
      { code: 'context_length_exceeded', message: 'Context too long.' },
      { code: 'unrecognized_code', message: 'Try again in 1ms.' },
      { message: 'No structured error code.' },
    ]) {
      const fetch = vi.fn(async () => sse([...truncated, {
        type: 'response.failed', response: { status: 'failed', error: { ...error, headers } },
      }]));
      vi.stubGlobal('fetch', fetch);
      const { engine, execute } = createEngine();
      const seen = await collect(engine.query({ prompt: 'Use Tool' }));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(seen.filter(e => e.type === 'llm_retry' || e.type === 'tool_call')).toEqual([]);
      expect(seen.filter(e => e.type === 'error')).toEqual([expect.objectContaining({
        retryable: false, error: expect.objectContaining({ code: error.code || 'failed', message: error.message }),
      })]);
      expect(seen.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
        expect.objectContaining({ stopReason: 'error' }),
      ]);
    }

    // Even a known transient failure is not replayable if the provider might
    // already have executed a hosted tool that Yeaft cannot account for.
    vi.stubGlobal('fetch', vi.fn(async () => sse([responsesFailure('server_error', 'Server error.')])));
    expect(await collect(adapter().stream({ model: 'test-model', messages: [], extraBody: { tools: [{ type: 'web_search' }] } })))
      .toEqual([{ type: 'error', retryable: false, error: expect.objectContaining({ code: 'server_error' }) }]);

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
