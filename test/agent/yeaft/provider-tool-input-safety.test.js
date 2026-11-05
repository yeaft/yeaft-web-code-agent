import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { LLMAbortError, LLMServerError, LLMToolInputError } from '../../../agent/yeaft/llm/adapter.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { _resetCacheForTests } from '../../../agent/yeaft/llm/credentials/github-copilot.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { collectOutput } from '../../../agent/yeaft/person/provider.js';
import { createPersonToolHost } from '../../../agent/yeaft/person/native-tools.js';
import fileRead from '../../../agent/yeaft/tools/file-read.js';
import fileWrite from '../../../agent/yeaft/tools/file-write.js';

const request = { model: 'test-model', system: '', messages: [] };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});
async function collect(generator) {
  const seen = [];
  for await (const event of generator) seen.push(event);
  return seen;
}
function assertRejected(seen) {
  expect(seen.some(e => e.type === 'tool_call' || e.type === 'provider_state')).toBe(false);
  const failures = seen.filter(e => e.type === 'error');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ retryable: false, error: { toolInputRejected: true, retryable: false } });
  expect(failures[0].error).toBeInstanceOf(LLMToolInputError);
  expect(failures[0].error).toBeInstanceOf(LLMServerError);
  expect(failures[0].error.message).not.toContain('PRIVATE');
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

describe('Responses rejects the complete tool batch, not individual siblings', () => {
  const adapter = fixtures[0].create;
  const invalid = ['{"PRIVATE":', 'null', '[]', '"PRIVATE"', '42', 'true', '', undefined, null, {}];

  it('holds arguments.done calls until terminal validation, draining final usage for malformed siblings', async () => {
    // Only strings are incremental arguments. Missing/non-string authoritative
    // arguments are exercised by terminal-output validation below.
    for (const input of invalid.filter(value => typeof value === 'string')) {
      vi.stubGlobal('fetch', vi.fn(async () => sse([...responsesSlot(0, '{}'), ...responsesSlot(1, input), responsesEnd()])));
      const seen = await collect(adapter().stream(request));
      assertRejected(seen);
      expect(seen.find(e => e.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 25 });
    }
  });

  it('validates terminal-only/fallback items and does not let a final valid projection hide a malformed done slot', async () => {
    const tails = invalid.map(input => [responsesEnd([responsesTool('call-0'), responsesTool('bad', input)])]);
    tails.push(
      [{ type: 'response.output_item.done', output_index: 1, item: responsesTool('bad', 'null') }, responsesEnd()],
      [{ type: 'response.output_item.done', output_index: 1, item: responsesTool('bad', '[]') }, responsesEnd([responsesTool('call-0')])],
      [...responsesSlot(1, '{"PRIVATE":'), responsesEnd([responsesTool('call-0'), responsesTool('call-1')])],
      ['malformed-PRIVATE', responsesEnd([responsesTool('call-0')])],
      [{ type: 'response.function_call_arguments.done', output_index: 1, arguments: 'null' }, responsesEnd([responsesTool('call-0')])],
    );
    for (const tail of tails) {
      vi.stubGlobal('fetch', vi.fn(async () => sse([...responsesSlot(0, '{}'), ...tail])));
      assertRejected(await collect(adapter().stream(request)));
    }
  });

  it('rejects incomplete terminal batches and unfinished siblings without replay', async () => {
    const tails = [
      [responsesEnd([], 'incomplete')],
      [responsesEnd([responsesTool('call-0')], 'incomplete')],
      [responsesEnd([{ ...responsesTool('call-0'), status: 'incomplete' }])],
      [{ type: 'response.output_item.added', output_index: 1, item: responsesTool('unfinished', '') }, responsesEnd()],
    ];
    for (const tail of tails) {
      vi.stubGlobal('fetch', vi.fn(async () => sse([...responsesSlot(0, '{}'), ...tail])));
      assertRejected(await collect(adapter().stream(request)));
    }
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'incomplete', output: [responsesTool('call-0')] })));
    assertRejected(await collect(adapter().stream(request)));
  });
});

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

  it('classifies unfinished and buffered complete tool EOF as transport failures without publishing tools or state', async () => {
    for (const events of [partial, responsesSlot(0, '{}'), truncated, [...truncated, '[DONE]']]) {
      vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
      const seen = [];
      await expect((async () => { for await (const event of adapter().stream(request)) seen.push(event); })())
        .rejects.toMatchObject({ name: 'LLMServerError', message: 'OpenAI tool stream ended before terminal event' });
      expect(seen.filter(e => ['tool_call', 'provider_state', 'stop', 'error'].includes(e.type))).toEqual([]);
    }
  });

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

  it('honours disabled, configured and default retry limits, ending with one terminal error and no tool execution', async () => {
    for (const maxRetries of [0, 2, undefined]) {
      const fetch = vi.fn(async () => sse(truncated));
      vi.stubGlobal('fetch', fetch);
      const { engine, execute } = createEngine({ config: { model: 'test-model', maxOutputTokens: 1024,
        projectDocMaxBytes: 0, llmRetry: { ...retryPolicy, maxRetries } } });
      const seen = await collect(engine.query({ prompt: 'Use Tool' }));
      const retries = maxRetries ?? 3;
      expect(fetch).toHaveBeenCalledTimes(retries + 1);
      expect(execute).not.toHaveBeenCalled();
      expect(seen.filter(e => e.type === 'llm_retry').map(e => [e.attempt, e.maxRetries, e.delayMs]))
        .toEqual(Array.from({ length: retries }, (_, i) => [i + 1, retries, Math.min(5, 2 ** i)]));
      expect(seen.filter(e => e.type === 'error')).toEqual([
        expect.objectContaining({ retryable: true, error: expect.objectContaining({ name: 'LLMServerError' }) }),
      ]);
      expect(seen.filter(e => e.type === 'tool_call' || e.type === 'tool_start')).toEqual([]);
      expect(seen.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
        expect.objectContaining({ stopReason: 'error' }),
      ]);
    }
  });

  it('honours cancellation at EOF and during retry backoff without issuing a new request', async () => {
    for (const boundary of ['eof', 'backoff']) {
      const controller = new AbortController();
      const fetch = vi.fn(async () => {
        if (boundary === 'backoff') return sse(truncated);
        let reads = 0;
        return { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
          read: async () => {
            if (reads++ === 0) return { done: false, value: new TextEncoder().encode(truncated.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')) };
            controller.abort();
            return { done: true };
          }, cancel() {}, releaseLock() {},
        }) } };
      });
      vi.stubGlobal('fetch', fetch);
      const { engine, execute } = createEngine();
      const seen = [];
      for await (const event of engine.query({ prompt: 'Use Tool', signal: controller.signal })) {
        seen.push(event);
        if (event.type === 'llm_retry') controller.abort();
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(seen.some(e => e.type === 'error' || e.type === 'tool_call')).toBe(false);
      expect(seen.filter(e => e.type === 'llm_retry')).toHaveLength(boundary === 'backoff' ? 1 : 0);
      expect(seen.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
        expect.objectContaining({ stopReason: 'aborted' }),
      ]);
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

describe('Responses validates raw tool slot identities before merging projections', () => {
  const adapter = fixtures[0].create;
  const nativeRequest = { ...request,
    providerContext: { protocol: 'openai-responses', origin: { providerId: 'fixture', endpointFingerprint: 'fixture',
      model: 'test-model', credentialScopeId: 'synthetic' }, capabilities: { nativeReasoningState: true } },
    requestIdentity: { instanceScope: 'fixture', ownerScope: 'fixture', sessionId: 'fixture', vpId: 'fixture', threadId: 'fixture' } };
  const slot = (index, id) => [
    { type: 'response.output_item.added', output_index: index, item: responsesTool(id, '') },
    { type: 'response.function_call_arguments.done', output_index: index, arguments: '{}' },
  ];
  const malformedSse = [
    ['duplicate incremental siblings', () => [...slot(0, 'PRIVATE-duplicate'), ...slot(1, 'PRIVATE-duplicate'), responsesEnd()]],
    ['same ID reused by a different terminal slot', () => [...slot(0, 'good'), responsesEnd([{ type: 'reasoning', id: 'reason' }, responsesTool('good')])]],
    ['missing incremental ID hidden by a valid final projection', () => [...slot(0, 'good'), ...slot(1, undefined), responsesEnd([responsesTool('good'), responsesTool('repaired')])]],
    ['untracked arguments.done cannot acquire an identity from the final output', () => [...slot(0, 'good'),
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{}' }, responsesEnd([responsesTool('good'), responsesTool('untracked')])]],
  ];

  for (const [label, events] of malformedSse) {
    it(`rejects ${label} in the real adapter and old Engine without replay or dispatch`, async () => {
      const fetch = vi.fn(async () => sse(events()));
      vi.stubGlobal('fetch', fetch);
      const seen = await collect(adapter().stream(nativeRequest));
      assertRejected(seen);
      expect(seen.find(e => e.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 25 });
      expect(fetch).toHaveBeenCalledTimes(1);

      fetch.mockClear();
      const rejected = await collectOutput(adapter(), { ...nativeRequest, signal: new AbortController().signal,
        tools: [{ name: 'Tool', description: 'test', parameters: { type: 'object', properties: {} } }] }).catch(error => error);
      expect(rejected).toMatchObject({ code: 'INVALID_TOOL_INPUT', partialOutput: {
        complete: false, accepted: false, usage: { inputTokens: 10, outputTokens: 25 },
      } });
      expect(rejected.partialOutput.toolCalls).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);

      fetch.mockClear();
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => 'must not execute');
      registry.register({ name: 'Tool', description: 'test', parameters: { type: 'object', properties: {} }, execute });
      const engine = new Engine({ adapter: adapter(), trace: new NullTrace(), toolRegistry: registry,
        config: { model: 'test-model', maxOutputTokens: 1024,
          llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 } } });
      const engineEvents = await collect(engine.query({ prompt: 'Use Tool' }));
      expect(execute).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(engineEvents.filter(e => ['tool_call', 'tool_start', 'provider_state', 'llm_retry'].includes(e.type))).toHaveLength(0);
      expect(engineEvents.find(e => e.type === 'error')).toMatchObject({ retryable: false, error: { name: 'LLMToolInputError' } });
      expect(engineEvents.filter(e => e.type === 'turn_end')).toEqual([
        expect.objectContaining({ type: 'turn_end', stopReason: 'error', terminal: true }),
      ]);
    });
  }

  it('shares nonempty, unique, bounded ID validation between JSON stream fallback and call()', async () => {
    for (const id of [undefined, null, '', '   ', 42, {}, 'good', 'x'.repeat(257)]) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'completed', output: [responsesTool('good'), responsesTool(id)], usage: {} })));
      assertRejected(await collect(adapter().stream(request)));
      await expect(adapter().call(request)).rejects.toMatchObject({ name: 'LLMToolInputError', retryable: false });
    }
  });

  const orderedCalls = [
    { type: 'function_call', call_id: 'write', name: 'FileWrite', arguments: JSON.stringify({ file_path: 'ordered.txt', content: 'written before read' }) },
    { type: 'function_call', call_id: 'read', name: 'FileRead', arguments: JSON.stringify({ file_path: 'ordered.txt' }) },
  ];
  const outOfOrder = (doneType = 'arguments.done') => [
    ...orderedCalls.map((item, output_index) => ({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } })),
    ...[1, 0].map(output_index => doneType === 'arguments.done'
      ? { type: 'response.function_call_arguments.done', output_index, arguments: orderedCalls[output_index].arguments }
      : { type: 'response.output_item.done', output_index, item: orderedCalls[output_index] }),
    responsesEnd(orderedCalls),
  ];
  const orderedTools = new ToolRegistry().registerAll([fileWrite, fileRead]).getToolDefs('en');

  it.each(['arguments.done', 'output_item.done'])('publishes tools in output slot order after out-of-order %s, preserving usage and continuity', async doneType => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(outOfOrder(doneType))));
    const seen = await collect(adapter().stream(nativeRequest));
    expect(seen.filter(e => e.type === 'tool_call').map(e => [e.id, e.name])).toEqual([['write', 'FileWrite'], ['read', 'FileRead']]);
    expect(seen.filter(e => e.type === 'usage')).toHaveLength(1);
    expect(seen.find(e => e.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 25 });
    expect(seen.filter(e => e.type === 'provider_state')).toHaveLength(1);
    expect(seen.some(e => e.type === 'error')).toBe(false);

    const output = await collectOutput(adapter(), { ...nativeRequest, signal: new AbortController().signal, tools: orderedTools });
    expect(output.toolCalls.map(call => [call.id, call.name])).toEqual([['write', 'FileWrite'], ['read', 'FileRead']]);
    expect(output).toMatchObject({ stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 25 } });
    expect(output.continuationState).toMatchObject({ items: orderedCalls });
  });

  it('dispatches out-of-order SSE as write then read in the old Engine and the native tool host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'responses-tool-order-'));
    try {
      const fetch = vi.fn()
        .mockImplementationOnce(async () => sse(outOfOrder()))
        .mockImplementationOnce(async () => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Verified.' }] }], usage: {} }));
      vi.stubGlobal('fetch', fetch);
      const engine = new Engine({ adapter: adapter(), trace: new NullTrace(), toolRegistry: new ToolRegistry().registerAll([fileWrite, fileRead]),
        config: { model: 'test-model', maxOutputTokens: 1024 } });
      const seen = await collect(engine.query({ prompt: 'Write then read ordered.txt', workDir: dir }));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(seen.filter(e => e.type === 'tool_start').map(e => e.name)).toEqual(['FileWrite', 'FileRead']);
      expect(seen.find(e => e.type === 'tool_end' && e.name === 'FileRead')).toMatchObject({ isError: false, output: expect.stringContaining('written before read') });
      expect(seen.some(e => e.type === 'error')).toBe(false);
      expect(await readFile(join(dir, 'ordered.txt'), 'utf8')).toBe('written before read');

      vi.stubGlobal('fetch', vi.fn(async () => sse(outOfOrder())));
      const output = await collectOutput(adapter(), { ...nativeRequest, signal: new AbortController().signal, tools: orderedTools });
      const nativeDir = join(dir, 'native');
      const host = createPersonToolHost({ workDir: nativeDir, yeaftDir: dir, config: {} });
      const results = [];
      for (const call of output.toolCalls) results.push(await host.execute(call.name, call.input, { callId: call.id, episodeId: 'order' }));
      expect(results.map(result => [result.id, result.ok])).toEqual([['FileWrite', true], ['FileRead', true]]);
      expect(results[1].output).toContain('written before read');
      expect(await readFile(join(nativeDir, 'ordered.txt'), 'utf8')).toBe('written before read');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

for (const fixture of fixtures) {
  describe(`${fixture.protocol} typed tool-input rejection compatibility`, () => {
    it('rejects every non-object/missing wire input in JSON stream fallback and call()', async () => {
      const inputs = fixture.protocol === 'anthropic'
        ? [undefined, null, [], 'PRIVATE', 42, true]
        : [undefined, null, {}, '', '{"PRIVATE":', 'null', '[]', '"PRIVATE"', '42', 'true'];
      for (const input of inputs) {
        const result = fixture.validJson();
        if (fixture.protocol === 'anthropic') result.content[1].input = input;
        else result.output[1].arguments = input;
        vi.stubGlobal('fetch', vi.fn(async () => json(result)));
        assertRejected(await collect(fixture.create().stream(request)));
        await expect(fixture.create().call(request)).rejects.toMatchObject({ name: 'LLMToolInputError', toolInputRejected: true, retryable: false });
      }
    });

    it('router forwards rejection without dynamic credential refresh or request replay', async () => {
      _resetCacheForTests();
      let exchanges = 0;
      let providerRequests = 0;
      const fetch = vi.fn(async url => {
        if (String(url).includes('/copilot_internal/v2/token')) {
          exchanges += 1;
          return json({ token: 'synthetic-api-token', expires_at: Math.floor(Date.now() / 1000) + 1800 });
        }
        providerRequests += 1;
        return json(fixture.invalidJson());
      });
      vi.stubGlobal('fetch', fetch);
      const router = new AdapterRouter({ providers: [{ name: 'fixture', credentialProvider: 'github-copilot',
        githubToken: 'synthetic-github-token', protocol: fixture.protocol,
        baseUrl: 'https://proxy.invalid', models: ['test-model'] }] });
      try {
        assertRejected(await collect(router.stream({ ...request, model: 'fixture/test-model' })));
        expect(providerRequests).toBe(1);
        expect(exchanges).toBe(1);
        await expect(router.call({ ...request, model: 'fixture/test-model' })).rejects.toBeInstanceOf(LLMToolInputError);
        expect(providerRequests).toBe(2);
        expect(exchanges).toBe(1);
      } finally {
        _resetCacheForTests();
      }
    });

    it('never lets a later network drain failure replay an already malformed tool batch', async () => {
      for (const [malformedEvent, cleanEof] of [[false, false], [true, false], [false, true], [true, true]]) {
        const events = fixture.invalidSse();
        // Remove the terminal boundary: first read contains a complete invalid
        // batch; the second fails or reaches clean EOF while draining for usage.
        events.splice(fixture.protocol === 'anthropic' ? -2 : -1);
        if (malformedEvent) {
          events.splice(-3, 3, 'malformed-PRIVATE');
        }
        let read = 0;
        const cancel = vi.fn();
        const reader = { read: async () => {
          if (read++ === 0) return { done: false, value: new TextEncoder().encode(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')) };
          if (cleanEof) return { done: true };
          throw new TypeError('fetch failed while draining');
        }, cancel, releaseLock() {} };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader } })));
        assertRejected(await collect(fixture.create().stream(request)));
        expect(cancel).toHaveBeenCalled();
      }
    });

    it('rejects non-string or untracked argument deltas instead of executing start placeholders', async () => {
      const responses = fixture.protocol === 'openai-responses';
      for (const input of [undefined, null, {}, 42]) {
        for (const tracked of [true, false]) {
          const first = responses ? responsesSlot(0, '{}') : anthropicSlot(0, '{}');
          const start = responses
            ? { type: 'response.output_item.added', output_index: 1, item: responsesTool('bad', '') }
            : { type: 'content_block_start', index: 1, content_block: anthropicTool('bad') };
          const delta = responses
            ? { type: 'response.function_call_arguments.delta', output_index: 1, delta: input }
            : { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: input } };
          const end = responses
            ? [responsesEnd([responsesTool('call-0'), responsesTool('bad')])]
            : [{ type: 'content_block_stop', index: 1 }, ...anthropicEnd()];
          vi.stubGlobal('fetch', vi.fn(async () => sse([...first, ...(tracked ? [start] : []), delta, ...end])));
          const seen = await collect(fixture.create().stream(request));
          assertRejected(seen);
          expect(seen.find(e => e.type === 'usage')).toMatchObject({ outputTokens: 25 });
        }
      }
    });

    it('abort wins over malformed-input recovery during drain', async () => {
      const controller = new AbortController();
      const events = fixture.invalidSse();
      events.splice(fixture.protocol === 'anthropic' ? -2 : -1);
      let read = 0;
      const reader = { read: async () => {
        if (read++ === 0) return { done: false, value: new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')) };
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      }, cancel() {}, releaseLock() {} };
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader } })));
      const seen = [];
      await expect((async () => { for await (const event of fixture.create().stream({ ...request, signal: controller.signal })) seen.push(event); })())
        .rejects.toBeInstanceOf(LLMAbortError);
      expect(seen.some(e => e.type === 'tool_call' || e.type === 'provider_state' || e.type === 'error')).toBe(false);
    });

    it('old Engine rejects mixed valid/invalid SSE and JSON batches with zero dispatch and zero retry', async () => {
      for (const response of [() => sse(fixture.invalidSse()), () => json(fixture.invalidJson())]) {
        const fetch = vi.fn(async () => response());
        vi.stubGlobal('fetch', fetch);
        const registry = new ToolRegistry();
        const execute = vi.fn(async () => 'must not execute');
        registry.register({ name: 'Tool', description: 'test', parameters: { type: 'object', properties: {} }, execute });
        const engine = new Engine({ adapter: fixture.create(), trace: new NullTrace(), toolRegistry: registry,
          config: { model: 'test-model', maxOutputTokens: 1024,
            llmRetry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 } } });
        const seen = await collect(engine.query({ prompt: 'Use Tool' }));
        expect(execute).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(seen.filter(e => e.type === 'tool_call' || e.type === 'tool_start' || e.type === 'llm_retry')).toHaveLength(0);
        expect(seen.find(e => e.type === 'error')).toMatchObject({ retryable: false, error: { name: 'LLMToolInputError' } });
        expect(seen.filter(e => e.type === 'turn_end')).toEqual([
          expect.objectContaining({ type: 'turn_end', stopReason: 'error', terminal: true }),
        ]);
      }
    });
  });
}
