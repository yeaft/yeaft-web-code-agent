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
import {
  LLMRateLimitError,
  LLMServerError,
  LLMAuthError,
  LLMPolicyError,
  LLMContextError,
  LLMStreamIdleTimeoutError,
  createBoundedTextAccumulator,
} from '../../../agent/yeaft/llm/adapter.js';
import { boundRawExchange, truncateUtf8Text } from '../../../agent/yeaft/perf-trace.js';

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

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
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

describe('bounded raw SSE capture', () => {
  it('bounds one oversized chunk with a constant number of byte-length scans', () => {
    const limit = 512 * 1024;
    const chunk = 'x'.repeat(768 * 1024);
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    try {
      const accumulator = createBoundedTextAccumulator(limit);
      accumulator.push(chunk);

      expect(byteLength).toHaveBeenCalledTimes(1);
      expect(accumulator.totalBytes).toBe(chunk.length);
      expect(accumulator.text()).toBe('x'.repeat(limit));
      expect(accumulator.truncated).toBe(true);
    } finally {
      byteLength.mockRestore();
    }
  });

  it('respects UTF-8 budgets without splitting a Unicode code point', () => {
    const accumulator = createBoundedTextAccumulator(5);
    accumulator.push('a😀b');

    expect(accumulator.text()).toBe('a😀');
    expect(Buffer.byteLength(accumulator.text(), 'utf8')).toBe(5);
    expect(accumulator.text().isWellFormed()).toBe(true);
    expect(accumulator.totalBytes).toBe(6);
    expect(accumulator.truncated).toBe(true);

    const zero = createBoundedTextAccumulator(0);
    zero.push('😀');
    expect(zero.text()).toBe('');
    expect(zero.totalBytes).toBe(4);
    expect(zero.truncated).toBe(true);
  });
});

describe('bounded raw debug exchange capture', () => {
  it('keeps raw request and response previews within budget and Unicode-safe', () => {
    const limit = 64 * 1024;
    const mixedPayload = `${'😀'.repeat(8_000)}${'x'.repeat(320 * 1024)}`;
    const request = boundRawExchange({ body: mixedPayload }, limit);
    const response = boundRawExchange({ status: 200, body: mixedPayload }, limit);

    expect(truncateUtf8Text('😀', 3)).toEqual({ value: '', truncated: true, originalBytes: 4 });
    for (const exchange of [request, response]) {
      expect(exchange).toMatchObject({ __truncated: true, maxBytes: limit });
      expect(exchange.originalBytes).toBeGreaterThan(limit);
      expect(exchange.preview).toContain('😀');
      expect(exchange.preview).toContain('x');
      expect(exchange.preview.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(exchange.preview, 'utf8')).toBeLessThanOrEqual(limit);
    }

    expect(boundRawExchange({ body: '😀' }, 0)).toEqual({ __truncated: true, maxBytes: 0 });
  });

  it('does not rescan a large mixed raw exchange for each truncated code unit', () => {
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    let exchange;
    try {
      exchange = boundRawExchange({
        body: `${'😀'.repeat(8_000)}${'x'.repeat(320 * 1024)}`,
      }, 64 * 1024);
      expect(byteLength).toHaveBeenCalledTimes(1);
    } finally {
      byteLength.mockRestore();
    }

    expect(exchange.preview.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(exchange.preview, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('AnthropicAdapter error classification', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the non-streaming stop reason', async () => {
    global.fetch = async () => jsonResponse({
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    const result = await adapter.call({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ text: 'partial', stopReason: 'max_tokens' });
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

  it('throws LLMRateLimitError on 529 (overloaded) with no header', async () => {
    global.fetch = async () => errorResponse({ status: 529, body: 'overloaded' });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMRateLimitError);
    expect(caught.statusCode).toBe(529);
    expect(caught.retryAfterMs).toBeNull();
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

  it('throws LLMServerError on 503', async () => {
    global.fetch = async () => errorResponse({ status: 503, body: 'unavailable' });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMServerError);
    expect(caught.statusCode).toBe(503);
  });

  it('throws LLMAuthError on 401', async () => {
    global.fetch = async () => errorResponse({ status: 401, body: 'unauthorized' });
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMAuthError);
  });

  it('wraps fetch-level ECONNRESET as LLMServerError', async () => {
    global.fetch = async () => {
      const err = new Error('socket reset by peer');
      err.code = 'ECONNRESET';
      throw err;
    };
    const adapter = new AnthropicAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'claude-3-5-sonnet', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMServerError);
    expect(caught.message).toContain('Anthropic');
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

  it('returns the non-streaming stop reason', async () => {
    global.fetch = async () => jsonResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'partial',
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    const result = await adapter.call({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ text: 'partial', stopReason: 'max_tokens' });
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

  it('classifies a content-safety 422 without exposing the provider body', async () => {
    global.fetch = async () => errorResponse({
      status: 422,
      body: JSON.stringify({ error: { message: 'This content was flagged for possible cybersecurity risk. SECRET_SAMPLE' } }),
    });
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMPolicyError);
    expect(caught).toMatchObject({ statusCode: 422, reasonCode: 'content_policy_denied' });
    expect(caught.message).not.toContain('SECRET_SAMPLE');
  });

  it('throws LLMContextError on 413', async () => {
    global.fetch = async () => errorResponse({ status: 413, body: 'too large' });
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMContextError);
  });

  it('throws LLMServerError on 502', async () => {
    global.fetch = async () => errorResponse({ status: 502, body: 'bad gateway' });
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMServerError);
  });

  it('wraps fetch TypeError as LLMServerError', async () => {
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    const adapter = new OpenAIResponsesAdapter({ baseUrl: 'https://x', apiKey: 'k' });
    let caught;
    try { await consume(adapter.stream({ model: 'gpt-5', system: '', messages: [{ role: 'user', content: 'hi' }] })); }
    catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LLMServerError);
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

describe('provider stream activity', () => {
  afterEach(() => { global.fetch = originalFetch; });

  const request = { model: 'test', system: '', messages: [{ role: 'user', content: 'hi' }] };
  const sse = events => ({
    ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
      controller.close();
    } }),
  });
  const anthropicDelta = (type, field, value) => ({
    type: 'content_block_delta', index: 0, delta: { type, [field]: value },
  });

  it('reports every non-empty hidden delta without content, ignores empty/metadata and preserves completed tool input', async () => {
    const chunks = ['{"secret":"', ...Array(200).fill('x'), '"}'];
    for (const protocol of ['anthropic', 'responses']) {
      const anthropic = protocol === 'anthropic';
      const metadata = anthropic ? [
        { type: 'ping' },
        anthropicDelta('signature_delta', 'signature', 'signature-only'),
        anthropicDelta('text_delta', 'text', ''),
        anthropicDelta('thinking_delta', 'thinking', ''),
      ] : [
        { type: 'response.created' },
        { type: 'response.reasoning_summary_part.added', part: { text: 'metadata' } },
        { type: 'response.output_text.delta', delta: '' },
      ];
      const delta = value => anthropic
        ? anthropicDelta('input_json_delta', 'partial_json', value)
        : { type: 'response.function_call_arguments.delta', output_index: 0, delta: value };
      const events = anthropic ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'Tool', input: {} } },
      ] : [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call', name: 'Tool' } },
      ];
      events.push(...metadata, ...['', null, undefined, 42].map(delta), ...chunks.map(delta));
      // Both Responses reasoning variants stay hidden. Anthropic keeps its
      // existing visible thinking_delta projection, but never emits empties.
      if (anthropic) {
        events.push(anthropicDelta('thinking_delta', 'thinking', 'visible thinking'));
        events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_stop' });
      } else {
        for (const type of ['response.reasoning_text.delta', 'response.reasoning_summary_text.delta']) {
          events.push(...['', null, undefined, 42].map(value => ({ type, delta: value })));
          events.push({ type, delta: 'hidden reasoning' });
        }
        events.push({ type: 'response.function_call_arguments.done', output_index: 0 });
        events.push({ type: 'response.completed', response: { status: 'completed', output: [], usage: {} } });
      }
      // Buffered post-terminal deltas are not activity.
      events.push(delta('late'), { type: 'response.reasoning_text.delta', delta: 'late' });
      global.fetch = async () => sse(events);
      const Adapter = anthropic ? AnthropicAdapter : OpenAIResponsesAdapter;
      const output = [];
      for await (const event of new Adapter({ baseUrl: 'https://x', apiKey: 'k' }).stream(request)) output.push(event);
      const activity = output.filter(event => event.type === 'provider_activity');
      expect(activity).toEqual(Array.from({ length: chunks.length + (anthropic ? 0 : 2) }, () => ({ type: 'provider_activity' })));
      expect(output.filter(event => event.type === 'tool_call')).toEqual([
        { type: 'tool_call', id: 'call', name: 'Tool', input: { secret: 'x'.repeat(200) } },
      ]);
      expect(output.filter(event => event.type === 'thinking_delta')).toEqual(anthropic
        ? [{ type: 'thinking_delta', text: 'visible thinking' }] : []);
      expect(output.filter(event => event.type === 'text_delta')).toEqual([]);
    }
  });

  it('drops buffered hidden deltas after abort and starts the next stream independently', async () => {
    for (const Adapter of [AnthropicAdapter, OpenAIResponsesAdapter]) {
      const events = Adapter === AnthropicAdapter ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'Tool' } },
        anthropicDelta('input_json_delta', 'partial_json', '{'),
        anthropicDelta('input_json_delta', 'partial_json', '}'),
        { type: 'content_block_stop', index: 0 }, { type: 'message_stop' },
      ] : [
        { type: 'response.reasoning_text.delta', delta: 'first' },
        { type: 'response.reasoning_text.delta', delta: 'late' },
        { type: 'response.completed', response: { status: 'completed' } },
      ];
      global.fetch = async () => sse(events);
      const adapter = new Adapter({ baseUrl: 'https://x', apiKey: 'k' });
      const ctrl = new AbortController();
      const stream = adapter.stream({ ...request, signal: ctrl.signal });
      expect((await stream.next()).value).toEqual({ type: 'provider_activity' });
      ctrl.abort();
      await expect(stream.next()).rejects.toMatchObject({ name: 'LLMAbortError' });
      const next = [];
      for await (const event of adapter.stream(request)) next.push(event);
      expect(next.filter(event => event.type === 'provider_activity')).toHaveLength(2);
    }
  });
});
