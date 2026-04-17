/**
 * test/agent/unify/llm/openai-responses.test.js
 *
 * Tests for OpenAIResponsesAdapter — /v1/responses API.
 *
 * Covers:
 *  1. text stream → text_delta
 *  2. tool call streaming → tool_call with parsed JSON input (call_id passthrough)
 *  3. multimodal user message translation (text + image → input_text + input_image)
 *  4. usage parsing (only emitted on response.completed)
 *  5. stop mapping (completed/tool_use/incomplete → end_turn/tool_use/max_tokens)
 *  6. error classification (401/429/413/500)
 *  7. abort signal
 *  8. tool_result message translation (tool role → function_call_output)
 *  9. tool def translation (flat {type,name,description,parameters})
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  OpenAIResponsesAdapter,
} from '../../../../agent/unify/llm/openai-responses.js';
import {
  LLMAuthError,
  LLMRateLimitError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
} from '../../../../agent/unify/llm/adapter.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Build a mock ReadableStream that emits the given SSE event objects. */
function sseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const ev of events) {
        // Each event is { event?: string, data: object }
        const lines = [];
        if (ev.event) lines.push(`event: ${ev.event}`);
        lines.push(`data: ${JSON.stringify(ev.data)}`);
        lines.push('', '');
        controller.enqueue(encoder.encode(lines.join('\n')));
      }
      controller.close();
    },
  });
}

function mockOkResponse(events) {
  return {
    ok: true,
    status: 200,
    body: sseStream(events),
    headers: new Map(),
  };
}

function mockErrorResponse(status, body = '') {
  return {
    ok: false,
    status,
    headers: new Map(),
    text: async () => body,
    json: async () => ({ error: { message: body } }),
  };
}

let originalFetch;
let capturedRequests;

beforeEach(() => {
  originalFetch = global.fetch;
  capturedRequests = [];
});

afterEach(() => {
  global.fetch = originalFetch;
});

function installFetchMock(handler) {
  global.fetch = async (url, opts) => {
    capturedRequests.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return handler(url, opts);
  };
}

// ═══════════════════════════════════════════════════════════════
// Basic construction
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter construction', () => {
  it('exposes baseUrl and strips trailing slashes', () => {
    const a = new OpenAIResponsesAdapter({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1/' });
    expect(a.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('defaults to api.openai.com when no baseUrl', () => {
    const a = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    expect(a.baseUrl).toContain('api.openai.com');
  });
});

// ═══════════════════════════════════════════════════════════════
// Text stream
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter stream — text', () => {
  it('emits text_delta events for response.output_text.delta', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Hello' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: ' world' } },
      { event: 'response.completed', data: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      } },
    ]));

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const events = [];
    for await (const ev of adapter.stream({
      model: 'gpt-5',
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(ev);
    }

    const textDeltas = events.filter(e => e.type === 'text_delta').map(e => e.text);
    expect(textDeltas).toEqual(['Hello', ' world']);

    const usage = events.find(e => e.type === 'usage');
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });

    const stop = events.find(e => e.type === 'stop');
    expect(stop.stopReason).toBe('end_turn');
  });

  it('posts to /v1/responses endpoint', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' });
    for await (const _ of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
    expect(capturedRequests[0].url).toBe('https://api.openai.com/v1/responses');
    expect(capturedRequests[0].opts.headers['Authorization']).toBe('Bearer sk-test');
  });

  it('sends stream: true in request body', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    for await (const _ of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
    expect(capturedRequests[0].body.stream).toBe(true);
    expect(capturedRequests[0].body.model).toBe('gpt-5');
  });
});

// ═══════════════════════════════════════════════════════════════
// Request body translation
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter request translation', () => {
  it('translates system to instructions field', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    for await (const _ of adapter.stream({
      model: 'gpt-5',
      system: 'you are a cat',
      messages: [{ role: 'user', content: 'meow' }],
    })) { /* drain */ }
    const body = capturedRequests[0].body;
    expect(body.instructions).toBe('you are a cat');
  });

  it('translates user string content to input item with input_text', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    for await (const _ of adapter.stream({
      model: 'gpt-5',
      system: '',
      messages: [{ role: 'user', content: 'hello' }],
    })) { /* drain */ }
    const body = capturedRequests[0].body;
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  });

  it('translates multimodal user array content (text + image)', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    for await (const _ of adapter.stream({
      model: 'gpt-5',
      system: '',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { url: 'https://example.com/cat.png' } },
        ],
      }],
    })) { /* drain */ }
    const body = capturedRequests[0].body;
    expect(body.input[0].content).toEqual([
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'https://example.com/cat.png' },
    ]);
  });

  it('translates assistant message with tool call to function_call item', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    for await (const _ of adapter.stream({
      model: 'gpt-5',
      system: '',
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_abc123', name: 'ls', input: { path: '.' } }],
        },
      ],
    })) { /* drain */ }
    const body = capturedRequests[0].body;
    // Should have the message, then a function_call item with call_id preserved
    const fnCall = body.input.find(i => i.type === 'function_call');
    expect(fnCall).toMatchObject({
      type: 'function_call',
      call_id: 'call_abc123',
      name: 'ls',
      arguments: JSON.stringify({ path: '.' }),
    });
  });

  it('translates tool role message to function_call_output item', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    for await (const _ of adapter.stream({
      model: 'gpt-5',
      system: '',
      messages: [
        { role: 'user', content: 'list' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_x', name: 'ls', input: {} }] },
        { role: 'tool', toolCallId: 'call_x', content: 'file1.txt\nfile2.txt' },
      ],
    })) { /* drain */ }
    const body = capturedRequests[0].body;
    const output = body.input.find(i => i.type === 'function_call_output');
    expect(output).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_x',
      output: 'file1.txt\nfile2.txt',
    });
  });

  it('translates tools to flat {type, name, description, parameters}', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    for await (const _ of adapter.stream({
      model: 'gpt-5',
      system: '',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        name: 'ls',
        description: 'list files',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    })) { /* drain */ }
    const body = capturedRequests[0].body;
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'ls',
      description: 'list files',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Tool call streaming
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter tool call streaming', () => {
  it('accumulates function_call_arguments.delta and emits tool_call on .done', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      { event: 'response.output_item.added', data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_42', name: 'search', arguments: '' },
      } },
      { event: 'response.function_call_arguments.delta', data: {
        type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":',
      } },
      { event: 'response.function_call_arguments.delta', data: {
        type: 'response.function_call_arguments.delta', output_index: 0, delta: '"cats"}',
      } },
      { event: 'response.function_call_arguments.done', data: {
        type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"q":"cats"}',
      } },
      { event: 'response.completed', data: {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'call_42', name: 'search', arguments: '{"q":"cats"}' }],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      } },
    ]));

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const events = [];
    for await (const ev of adapter.stream({
      model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'search cats' }],
      tools: [{ name: 'search', description: 's', parameters: {} }],
    })) { events.push(ev); }

    const tc = events.find(e => e.type === 'tool_call');
    expect(tc).toMatchObject({ id: 'call_42', name: 'search', input: { q: 'cats' } });

    const stop = events.find(e => e.type === 'stop');
    expect(stop.stopReason).toBe('tool_use');
  });

  it('handles malformed arguments by emitting tool_call with empty input', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.output_item.added', data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_bad', name: 'badfn', arguments: '' },
      } },
      { event: 'response.function_call_arguments.done', data: {
        type: 'response.function_call_arguments.done', output_index: 0, arguments: 'not-json',
      } },
      { event: 'response.completed', data: {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'call_bad', name: 'badfn', arguments: 'not-json' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } },
    ]));

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const events = [];
    for await (const ev of adapter.stream({
      model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'badfn', description: '', parameters: {} }],
    })) { events.push(ev); }
    const tc = events.find(e => e.type === 'tool_call');
    expect(tc).toMatchObject({ id: 'call_bad', name: 'badfn', input: {} });
  });
});

// ═══════════════════════════════════════════════════════════════
// Usage parsing
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter usage', () => {
  it('extracts cached tokens from input_tokens_details', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'hi' } },
      { event: 'response.completed', data: {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 75 },
          },
        },
      } },
    ]));

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const events = [];
    for await (const ev of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) {
      events.push(ev);
    }
    const usage = events.find(e => e.type === 'usage');
    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 75,
    });
  });

  it('only emits usage once (on response.completed, not mid-stream)', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'a' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'b' } },
      { event: 'response.completed', data: {
        type: 'response.completed',
        response: { status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2 } },
      } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const events = [];
    for await (const ev of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) {
      events.push(ev);
    }
    const usageEvents = events.filter(e => e.type === 'usage');
    expect(usageEvents.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Stop reason mapping
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter stop reasons', () => {
  it('maps incomplete with max_output_tokens to max_tokens', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'ab' } },
      { event: 'response.incomplete', data: {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
          usage: { input_tokens: 5, output_tokens: 8 },
        },
      } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const events = [];
    for await (const ev of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) {
      events.push(ev);
    }
    const stop = events.find(e => e.type === 'stop');
    expect(stop.stopReason).toBe('max_tokens');
  });

  it('maps completed with no tool calls to end_turn', async () => {
    installFetchMock(() => mockOkResponse([
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'done' } },
      { event: 'response.completed', data: {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } },
    ]));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test' });
    const events = [];
    for await (const ev of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) {
      events.push(ev);
    }
    expect(events.find(e => e.type === 'stop').stopReason).toBe('end_turn');
  });
});

// ═══════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter error classification', () => {
  it('401 → LLMAuthError', async () => {
    installFetchMock(() => mockErrorResponse(401, 'Invalid api key'));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'bad' });
    await expect(async () => {
      for await (const _ of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
    }).rejects.toBeInstanceOf(LLMAuthError);
  });

  it('429 → LLMRateLimitError', async () => {
    installFetchMock(() => mockErrorResponse(429, 'rate limited'));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk' });
    await expect(async () => {
      for await (const _ of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
    }).rejects.toBeInstanceOf(LLMRateLimitError);
  });

  it('413 / context_length_exceeded → LLMContextError', async () => {
    installFetchMock(() => mockErrorResponse(400, 'context_length_exceeded: too long'));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk' });
    await expect(async () => {
      for await (const _ of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
    }).rejects.toBeInstanceOf(LLMContextError);
  });

  it('500 → LLMServerError', async () => {
    installFetchMock(() => mockErrorResponse(500, 'boom'));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk' });
    await expect(async () => {
      for await (const _ of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
    }).rejects.toBeInstanceOf(LLMServerError);
  });
});

// ═══════════════════════════════════════════════════════════════
// Abort signal
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter abort', () => {
  it('throws LLMAbortError if signal already aborted', async () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk' });
    const ac = new AbortController();
    ac.abort();
    await expect(async () => {
      for await (const _ of adapter.stream({
        model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'x' }], signal: ac.signal,
      })) { /* drain */ }
    }).rejects.toBeInstanceOf(LLMAbortError);
  });
});

// ═══════════════════════════════════════════════════════════════
// Non-streaming call()
// ═══════════════════════════════════════════════════════════════

describe('OpenAIResponsesAdapter.call (non-streaming)', () => {
  it('returns { text, usage } from non-stream response', async () => {
    installFetchMock(() => ({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        id: 'resp_abc',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello back' }] }],
        usage: { input_tokens: 3, output_tokens: 2 },
        // Convenience property that the Responses API exposes
        output_text: 'hello back',
      }),
      text: async () => '',
    }));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk' });
    const result = await adapter.call({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('hello back');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    // stream: false (or omitted) for call
    expect(capturedRequests[0].body.stream).toBeFalsy();
  });
});
