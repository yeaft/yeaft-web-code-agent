import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { LLMAbortError, LLMServerError, LLMToolInputError } from '../../../agent/yeaft/llm/adapter.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
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

  it('rejects malformed, missing, and non-object JSON fallback inputs before projecting valid siblings', async () => {
    for (const input of invalid) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'completed', output: [responsesTool('good'), responsesTool('bad', input)],
        usage: { input_tokens: 10, output_tokens: 25 } })));
      const seen = await collect(adapter().stream(request));
      assertRejected(seen);
      expect(seen.find(e => e.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 25 });
    }
  });

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

  it('rejects incomplete terminal batches, unfinished siblings, and tool EOF without replay', async () => {
    const tails = [
      [responsesEnd([], 'incomplete')],
      [responsesEnd([responsesTool('call-0')], 'incomplete')],
      [responsesEnd([{ ...responsesTool('call-0'), status: 'incomplete' }])],
      [{ type: 'response.output_item.added', output_index: 1, item: responsesTool('unfinished', '') }, responsesEnd()],
      [],
    ];
    for (const tail of tails) {
      vi.stubGlobal('fetch', vi.fn(async () => sse([...responsesSlot(0, '{}'), ...tail])));
      assertRejected(await collect(adapter().stream(request)));
    }
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'incomplete', output: [responsesTool('call-0')] })));
    assertRejected(await collect(adapter().stream(request)));
  });

  it('publishes valid empty/UTF-8 objects once and permits authoritative terminal completion without arguments.done', async () => {
    const pending = { type: 'response.output_item.added', output_index: 1, item: responsesTool('call-1', '') };
    vi.stubGlobal('fetch', vi.fn(async () => sse([...responsesSlot(0, '{}'), pending,
      responsesEnd([responsesTool('call-0'), responsesTool('call-1', '{"text":"你好"}')])])));
    const seen = await collect(adapter().stream(request));
    expect(seen.filter(e => e.type === 'tool_call').map(e => [e.id, e.input])).toEqual([['call-0', {}], ['call-1', { text: '你好' }]]);
    expect(seen.some(e => e.type === 'error')).toBe(false);
    expect(seen.find(e => e.type === 'stop').stopReason).toBe('tool_use');
  });

  it('finishes at the native terminal event without waiting for transport EOF', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(responsesEnd([responsesTool('empty')]))}\n\n`));
    }, cancel }))));
    const seen = await collect(adapter().stream(request));
    expect(seen.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(1);
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
    ['duplicate done-only siblings', () => [
      { type: 'response.output_item.done', output_index: 0, item: responsesTool('PRIVATE-duplicate') },
      { type: 'response.output_item.done', output_index: 1, item: responsesTool('PRIVATE-duplicate') }, responsesEnd()]],
    ['duplicate terminal siblings', () => [responsesEnd([responsesTool('PRIVATE-duplicate'), responsesTool('PRIVATE-duplicate')])]],
    ['duplicate terminal sibling hidden by an incremental projection', () => [...slot(0, 'good'), responsesEnd([responsesTool('good'), responsesTool('good')])]],
    ['incremental identity changing in terminal output', () => [...slot(0, 'good'), responsesEnd([responsesTool('changed')])]],
    ['same ID reused by a different terminal slot', () => [...slot(0, 'good'), responsesEnd([{ type: 'reasoning', id: 'reason' }, responsesTool('good')])]],
    ['missing incremental ID', () => [...slot(0, 'good'), ...slot(1, undefined), responsesEnd()]],
    ['missing incremental ID hidden by a valid final projection', () => [...slot(0, 'good'), ...slot(1, undefined), responsesEnd([responsesTool('good'), responsesTool('repaired')])]],
    ['missing done-only ID', () => [...slot(0, 'good'), { type: 'response.output_item.done', output_index: 1, item: responsesTool(undefined) }, responsesEnd()]],
    ['missing terminal ID', () => [responsesEnd([responsesTool('good'), responsesTool(undefined)])]],
    ['internal item ID cannot substitute for missing call_id', () => [responsesEnd([responsesTool('good'), { ...responsesTool(undefined), id: 'internal-item-id' }])]],
    ['untracked arguments.done cannot acquire an identity from the final output', () => [...slot(0, 'good'),
      { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{}' }, responsesEnd([responsesTool('good'), responsesTool('untracked')])]],
    ['missing output index', () => [...slot(0, 'good'), ...slot(undefined, 'unindexed'), responsesEnd()]],
    ['negative output index', () => [...slot(0, 'good'), ...slot(-1, 'negative'), responsesEnd()]],
    ['out-of-bounds incremental ID', () => [...slot(0, 'good'), ...slot(1, 'x'.repeat(257)), responsesEnd()]],
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
      expect(engineEvents).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'error' }));
    });
  }

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

  it('uses numeric output slot order even when terminal output omits done-only tools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      { type: 'response.output_item.done', output_index: 10, item: responsesTool('ten') },
      { type: 'response.output_item.done', output_index: 2, item: responsesTool('two') },
      responsesEnd(),
    ])));
    const seen = await collect(adapter().stream(request));
    expect(seen.filter(e => e.type === 'tool_call').map(e => e.id)).toEqual(['two', 'ten']);
    expect(seen.some(e => e.type === 'error')).toBe(false);
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

  it('shares nonempty, unique, bounded ID validation between JSON stream fallback and call()', async () => {
    for (const id of [undefined, null, '', '   ', 42, {}, 'good', 'x'.repeat(257)]) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'completed', output: [responsesTool('good'), responsesTool(id)], usage: {} })));
      assertRejected(await collect(adapter().stream(request)));
      await expect(adapter().call(request)).rejects.toMatchObject({ name: 'LLMToolInputError', retryable: false });
    }
  });

  it('allows the same slot in incremental, item.done and terminal representations exactly once', async () => {
    const id = 'x'.repeat(256);
    const first = responsesTool(id, '{"value":1}');
    const second = responsesTool('next');
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      ...slot(0, id),
      { type: 'response.output_item.done', output_index: 0, item: first },
      { type: 'response.output_item.added', output_index: 1, item: responsesTool('next', '') },
      { type: 'response.output_item.done', output_index: 1, item: second },
      responsesEnd([first, second]),
    ])));
    const seen = await collect(adapter().stream(nativeRequest));
    expect(seen.filter(e => e.type === 'tool_call').map(e => [e.id, e.input])).toEqual([[id, { value: 1 }], ['next', {}]]);
    expect(seen.filter(e => e.type === 'provider_state')).toHaveLength(1);
    expect(seen.some(e => e.type === 'error')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'completed', output: [first, second], usage: {} })));
    expect((await collect(adapter().stream(request))).filter(e => e.type === 'tool_call')).toHaveLength(2);
    await expect(adapter().call(request)).resolves.toMatchObject({ stopReason: 'tool_use' });
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

    it('throws typed non-retryable errors for nonstream call(), including truncation', async () => {
      const bad = fixture.invalidJson();
      const truncated = fixture.validJson();
      if (fixture.protocol === 'anthropic') truncated.stop_reason = 'max_tokens';
      else truncated.status = 'incomplete';
      for (const result of [bad, truncated]) {
        const fetch = vi.fn(async () => json(result));
        vi.stubGlobal('fetch', fetch);
        await expect(fixture.create().call(request)).rejects.toMatchObject({ name: 'LLMToolInputError', toolInputRejected: true, retryable: false });
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    });

    it('never lets a later network drain failure replay an already malformed tool batch', async () => {
      for (const malformedEvent of [false, true]) {
        const events = fixture.invalidSse();
        // Remove the terminal boundary: first read contains a complete invalid
        // batch; the second read fails while the adapter drains for final usage.
        events.splice(fixture.protocol === 'anthropic' ? -2 : -1);
        if (malformedEvent) {
          events.splice(-3, 3, 'malformed-PRIVATE');
        }
        let read = 0;
        const cancel = vi.fn();
        const reader = { read: async () => {
          if (read++ === 0) return { done: false, value: new TextEncoder().encode(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')) };
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

    it('preserves known tool rejection when the provider later emits a failure event', async () => {
      const events = fixture.invalidSse();
      events.splice(fixture.protocol === 'anthropic' ? -2 : -1);
      events.push(fixture.protocol === 'anthropic'
        ? { type: 'error', error: { type: 'overloaded_error', message: 'PRIVATE provider failure' } }
        : { type: 'response.failed', response: { error: { message: 'PRIVATE provider failure' } } });
      vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
      assertRejected(await collect(fixture.create().stream(request)));
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

    it('returns valid JSON object/empty tool batches normally', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => json(fixture.validJson())));
      const seen = await collect(fixture.create().stream(request));
      expect(seen.filter(e => e.type === 'tool_call').map(e => e.input)).toEqual([{}, { value: 1 }]);
      expect(seen.some(e => e.type === 'error')).toBe(false);
      await expect(fixture.create().call(request)).resolves.toMatchObject({ stopReason: 'tool_use' });
    });

    it('router forwards rejection without credential refresh or request replay', async () => {
      const fetch = vi.fn(async () => json(fixture.invalidJson()));
      vi.stubGlobal('fetch', fetch);
      const router = new AdapterRouter({ providers: [{ name: 'fixture', apiKey: 'synthetic', protocol: fixture.protocol,
        baseUrl: 'https://proxy.invalid', models: ['test-model'] }] });
      assertRejected(await collect(router.stream({ ...request, model: 'fixture/test-model' })));
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(router.call({ ...request, model: 'fixture/test-model' })).rejects.toBeInstanceOf(LLMToolInputError);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps non-tool stream damage and fetch network failures ordinary provider errors', async () => {
      const terminal = fixture.protocol === 'anthropic' ? [{ type: 'message_stop' }] : [responsesEnd()];
      vi.stubGlobal('fetch', vi.fn(async () => sse(['malformed-PRIVATE', ...terminal])));
      await expect(collect(fixture.create().stream(request))).rejects.toMatchObject({ name: 'LLMServerError' });
      for (const method of ['stream', 'call']) {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
        try {
          if (method === 'stream') await collect(fixture.create().stream(request));
          else await fixture.create().call(request);
          throw new Error('Expected network rejection');
        } catch (error) {
          expect(error).toBeInstanceOf(LLMServerError);
          expect(error).not.toBeInstanceOf(LLMToolInputError);
          expect(error.toolInputRejected).toBeUndefined();
        }
      }
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
        expect(seen).toContainEqual(expect.objectContaining({ type: 'turn_end', stopReason: 'error' }));
      }
    });
  });
}
