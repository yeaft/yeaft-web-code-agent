/**
 * Integration tests: adapter-level error classification + retry-after
 * header parsing.
 *
 * We mock global.fetch so we can drive the adapter through error paths
 * deterministically. Goal: prove the adapter throws the typed error the
 * engine relies on (`LLMRateLimitError.retryAfterMs`, `LLMServerError`),
 * so the engine's retry loop has the metadata it needs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { LLMRateLimitError, LLMServerError, LLMAuthError, LLMPolicyError, LLMContextError, LLMStreamIdleTimeoutError } from '../../../agent/yeaft/llm/adapter.js';

const originalFetch = global.fetch;

function errorResponse({ status, body = '', headers = {} }) {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => body,
  };
}

async function consume(generator) {
  // We only care about the throw — discard any events.
  // eslint-disable-next-line no-unused-vars
  for await (const _ of generator) { /* drain */ }
}

function idleStreamResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'));
      },
      cancel() {},
    }),
  };
}

function truncatedAnthropicStreamResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":118,"output_tokens":0}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
          '',
          'event: ping',
          'data: {"type":"ping"}',
          '',
        ].join('\n')));
        controller.close();
      },
      cancel() {},
    }),
  };
}

function truncatedResponsesStreamResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"partial"}',
          '',
        ].join('\n')));
        controller.close();
      },
      cancel() {},
    }),
  };
}

function failedResponsesStreamResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'event: response.failed',
          'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_request_error","message":"bad request body"}}}',
          '',
        ].join('\n')));
        controller.close();
      },
      cancel() {},
    }),
  };
}

describe('AnthropicAdapter error classification', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws LLMRateLimitError with parsed Retry-After on 429', async () => {
    global.fetch = async () => errorResponse({
      status: 429,
      body: 'rate limit',
      headers: { 'retry-after': '8' },
    });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    await expect(consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })))
      .rejects.toBeInstanceOf(LLMRateLimitError);
    // Re-invoke to inspect the thrown error directly.
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMRateLimitError);
    expect(caught.statusCode).toBe(429);
    expect(caught.retryAfterMs).toBe(8_000);
  });

  it('classifies a content-safety 422 without exposing the provider body', async () => {
    global.fetch = async () => errorResponse({
      status: 422,
      body: JSON.stringify({ error: { message: 'This content was flagged for possible cybersecurity risk. SECRET_SAMPLE' } }),
    });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMPolicyError);
    expect(caught).toMatchObject({ statusCode: 422, reasonCode: 'content_policy_denied' });
    expect(caught.message).not.toContain('SECRET_SAMPLE');
  });

  it('throws LLMContextError on prompt-too-long body', async () => {
    global.fetch = async () => errorResponse({ status: 400, body: 'prompt is too long' });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMContextError);
  });

  it('throws LLMAuthError on 401', async () => {
    global.fetch = async () => errorResponse({ status: 401, body: 'unauthorized' });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMAuthError);
  });

  it('throws retryable stream idle timeout when SSE stalls after message_start', async () => {
    global.fetch = async () => idleStreamResponse();
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k', streamIdleTimeoutMs: 5 });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMStreamIdleTimeoutError);
    expect(caught).toBeInstanceOf(LLMServerError);
  });

  it('throws retryable error when Anthropic SSE ends before a stop event', async () => {
    global.fetch = async () => truncatedAnthropicStreamResponse();
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'deepseek-v4-pro', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMServerError);
    expect(caught.message).toContain('stream ended before stop event');
  });
});

describe('OpenAIResponsesAdapter error classification', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws LLMRateLimitError with parsed Retry-After on 429', async () => {
    global.fetch = async () => errorResponse({
      status: 429,
      body: 'too fast',
      headers: { 'retry-after': '3' },
    });
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMRateLimitError);
    expect(caught.retryAfterMs).toBe(3_000);
  });

  it('throws LLMContextError on 413', async () => {
    global.fetch = async () => errorResponse({ status: 413, body: 'too large' });
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMContextError);
  });

  it('throws retryable stream idle timeout when Responses SSE stalls', async () => {
    global.fetch = async () => idleStreamResponse();
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k', streamIdleTimeoutMs: 5 });
    let caught;
    try { await consume(adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMStreamIdleTimeoutError);
    expect(caught).toBeInstanceOf(LLMServerError);
  });

  it('throws retryable error when Responses SSE ends before a terminal event', async () => {
    global.fetch = async () => truncatedResponsesStreamResponse();
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    const seen = [];
    try {
      for await (const event of adapter.stream({ model: 'deepseek-chat', system: '', messages: [{ role: 'user', content: 'hi' }] })) {
        seen.push(event);
      }
    } catch (err) { caught = err; }
    expect(seen).toContainEqual({ type: 'text_delta', text: 'partial' });
    expect(caught).toBeInstanceOf(LLMServerError);
    expect(caught.message).toContain('stream ended before terminal event');
  });

  it('treats Responses failed event as terminal non-retryable error event', async () => {
    global.fetch = async () => failedResponsesStreamResponse();
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    const events = [];
    for await (const event of adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', retryable: false });
    expect(events[0].error.message).toBe('bad request body');
    expect(events[0].error.code).toBe('invalid_request_error');
  });
});

describe('Anthropic tool input completion boundary', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const start = (index, input = {}) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${index}`, name: 'Tool', input } });
  const delta = (index, partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
  const stop = index => ({ type: 'content_block_stop', index });
  const messageStop = { type: 'message_stop' };
  const wire = (events, compact) => events.map(e => `data:${compact && (e.type === 'content_block_delta' || e.type === 'message_delta') ? '' : ' '}${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const response = (events, compact = false) => new Response(wire(events, compact));
  const adapter = () => new AnthropicAdapter({ baseUrl: 'https://proxy.invalid', apiKey: 'synthetic' });
  const request = { model: 'claude-opus-4.8', messages: [] };

  it('rejects malformed/non-object input and incomplete sibling batches before publishing any tool', async () => {
    const validFirst = [start(0), delta(0, '{"value":1}'), stop(0)];
    const failures = [
      ...['{"secret":"PRIVATE', 'null', '[]', '"PRIVATE"', '42'].map(input => [start(1), delta(1, input), stop(1), messageStop]),
      ...[null, [], 'PRIVATE'].map(input => [start(1, input), stop(1), messageStop]),
      [start(1), delta(1, '{"value":'), messageStop],
      [start(1), 'malformed-SSE-PRIVATE', stop(1), messageStop],
      [start(1), delta(1, '{"value":'), '[DONE]'],
      [start(1), delta(1, '{"value":')],
      [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
      ['[DONE]'],
      [{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, messageStop],
    ];
    for (const compact of [false, true]) {
      for (const tail of failures) {
        const seen = [];
        vi.stubGlobal('fetch', vi.fn(async () => response([...validFirst, ...tail], compact)));
        let caught;
        try { for await (const e of adapter().stream(request)) seen.push(e); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(LLMServerError);
        expect(caught.message).not.toContain('PRIVATE');
        expect(seen.some(e => e.type === 'tool_call' || e.type === 'provider_state')).toBe(false);
      }
    }
  });

  it('accounts for cumulative usage before rejecting truncated or malformed SSE tool batches', async () => {
    for (const compact of [false, true]) {
      for (const [input, stop_reason] of [['{}', 'max_tokens'], ['{"value":', 'max_tokens'], ['null', 'tool_use']]) {
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } },
          start(0), delta(0, input), stop(0),
          { type: 'message_delta', usage: { output_tokens: 7 } },
          { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 65536 } },
          messageStop,
        ];
        vi.stubGlobal('fetch', vi.fn(async () => response(events, compact)));
        const seen = [];
        await expect((async () => { for await (const e of adapter().stream(request)) seen.push(e); })()).rejects.toBeInstanceOf(LLMServerError);
        const usage = seen.filter(e => e.type === 'usage');
        expect(usage.map(e => e.outputTokens)).toEqual([1, 6, 65529]);
        expect(usage[0]).toMatchObject({ inputTokens: 10, cacheReadTokens: 7, cacheWriteTokens: 3 });
        expect(seen.some(e => e.type === 'tool_call' || e.type === 'provider_state')).toBe(false);
      }
    }
  });
});
