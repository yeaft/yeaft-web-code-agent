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
  resolveStreamIdleTimeoutMs,
} from '../../../agent/yeaft/llm/adapter.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { normalizeLlmRetry } from '../../../agent/yeaft/config.js';
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

describe('request-scoped stream idle policy', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('keeps defaults bounded and preserves explicit legacy/zero budgets', () => {
    const defaults = normalizeLlmRetry();
    expect(defaults).toMatchObject({ streamIdleTimeoutMs: 90_000, highEffortStreamIdleTimeoutMs: 270_000 });
    for (const effort of ['high', 'xhigh', 'max', 'ultra']) expect(resolveStreamIdleTimeoutMs(defaults, effort)).toBe(270_000);
    for (const effort of ['low', 'medium', null]) expect(resolveStreamIdleTimeoutMs(defaults, effort)).toBe(90_000);
    for (const timeout of [0, 1234]) {
      const legacy = normalizeLlmRetry({ streamIdleTimeoutMs: timeout });
      expect(resolveStreamIdleTimeoutMs(legacy, 'max')).toBe(timeout);
    }
    expect(resolveStreamIdleTimeoutMs(normalizeLlmRetry({ streamIdleTimeoutMs: 0, highEffortStreamIdleTimeoutMs: 5000 }), 'high')).toBe(0);
    expect(resolveStreamIdleTimeoutMs(normalizeLlmRetry({ streamIdleTimeoutMs: 100, highEffortStreamIdleTimeoutMs: 500 }), 'high')).toBe(500);
    expect(resolveStreamIdleTimeoutMs(normalizeLlmRetry(defaults, { streamIdleTimeoutMs: 200 }), 'high')).toBe(200);
    expect(resolveStreamIdleTimeoutMs(defaults, 'high', 0)).toBe(0);
    expect(resolveStreamIdleTimeoutMs(defaults, 'high', 999_999)).toBe(600_000);
    expect(resolveStreamIdleTimeoutMs(defaults, 'high', NaN)).toBe(270_000);
  });

  it('uses final effort and absolute overrides independently for cached models and both protocols', async () => {
    for (const protocol of ['anthropic', 'openai-responses']) {
      const model = protocol === 'anthropic' ? 'claude-opus-4.8' : 'gpt-5';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(protocol === 'anthropic'
        ? { content: [], stop_reason: 'end_turn' } : { output: [], status: 'completed' })));
      const router = new AdapterRouter({ llmRetry: normalizeLlmRetry(), providers: [{ name: 'fixture', apiKey: 'synthetic', baseUrl: 'https://proxy.invalid', protocol,
        models: [model, { id: `${model}-zero`, streamIdleTimeoutMs: 0 }, { id: `${model}-slow`, streamIdleTimeoutMs: 400_000 }] }] });
      const run = async (id, effort, extraBody, effortConstraint) => {
        const onRequestStart = vi.fn();
        await consume(router.stream({ model: `fixture/${id}`, system: '', messages: [], effort, effortSource: 'user', extraBody, effortConstraint, onRequestStart }));
        return onRequestStart.mock.calls[0][0];
      };
      expect(await run(model, 'high')).toEqual({ effort: 'high', streamIdleTimeoutMs: 270_000 });
      expect(await run(model, 'low')).toEqual({ effort: 'low', streamIdleTimeoutMs: 90_000 });
      expect((await run(`${model}-zero`, 'high')).streamIdleTimeoutMs).toBe(0);
      expect((await run(`${model}-slow`, 'high')).streamIdleTimeoutMs).toBe(400_000);
      const lowWire = protocol === 'anthropic' ? { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } } : { reasoning: { effort: 'low' } };
      expect(await run(model, 'high', lowWire)).toEqual({ effort: 'low', streamIdleTimeoutMs: 90_000 });
      const capped = await run(model, 'high', undefined, { parentDecision: { effective: 'medium' } });
      expect(capped).toEqual({ effort: 'medium', streamIdleTimeoutMs: 90_000 });
      expect(await run(model, 'high')).toEqual({ effort: 'high', streamIdleTimeoutMs: 270_000 });

      const providerOverride = new AdapterRouter({ llmRetry: normalizeLlmRetry(), providers: [{ name: 'fixture', apiKey: 'synthetic', baseUrl: 'https://proxy.invalid', protocol,
        streamIdleTimeoutMs: 200_000, models: [model, { id: `${model}-zero`, streamIdleTimeoutMs: 0 }] }] });
      for (const [id, budget] of [[model, 200_000], [`${model}-zero`, 0]]) {
        const onRequestStart = vi.fn();
        await consume(providerOverride.stream({ model: `fixture/${id}`, messages: [], effort: 'high', effortSource: 'user', onRequestStart }));
        expect(onRequestStart.mock.calls[0][0].streamIdleTimeoutMs).toBe(budget);
      }
    }
  });

  it('waits past 90s for high effort partial FileWrite input but still cancels at its exact bounded deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const partial = [
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'write', name: 'FileWrite', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"design.md",' } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(partial.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
    }, cancel }))));
    const adapter = new AnthropicAdapter({ baseUrl: 'https://proxy.invalid', apiKey: 'synthetic', ...normalizeLlmRetry() });
    const events = [];
    let finished = false;
    const pump = (async () => {
      try { for await (const event of adapter.stream({ model: 'claude-opus-4.8', messages: [], effort: 'xhigh', effortSource: 'user' })) events.push(event); }
      catch (error) { return error; }
      finally { finished = true; }
    })();
    await vi.advanceTimersByTimeAsync(269_999);
    expect(finished).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pump).toMatchObject({ name: 'LLMStreamIdleTimeoutError', idleMs: 270_000 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === 'tool_call' || e.type === 'provider_state')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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

  it('accepts interleaved complete objects, empty tools, initial inputs and split UTF-8 exactly once', async () => {
    const events = [start(0), start(1), delta(1, '{"content":"你'), delta(0, '{"value":1}'),
      delta(1, '好\\nworld"}'), stop(1), stop(0), start(2), stop(2), start(3, { ready: true }), stop(3), messageStop];
    for (const compact of [false, true]) {
      const bytes = new TextEncoder().encode(wire(events, compact));
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      } }))));
      const seen = [];
      for await (const e of adapter().stream(request)) seen.push(e);
      expect(seen.filter(e => e.type === 'tool_call').map(e => [e.id, e.input])).toEqual([
        ['call-0', { value: 1 }], ['call-1', { content: '你好\nworld' }], ['call-2', {}], ['call-3', { ready: true }],
      ]);
    }
  });

  it('finishes at message_stop without waiting for transport EOF', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode([start(0), stop(0), messageStop].map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
    }, cancel }))));
    await consume(adapter().stream(request));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid/truncated JSON fallback before exposing any tools', async () => {
    for (const [input, stop_reason] of [[null, 'tool_use'], [[], 'tool_use'], [{}, 'max_tokens']]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [start(0).content_block, start(1, input).content_block], stop_reason })));
      const seen = [];
      await expect((async () => { for await (const e of adapter().stream(request)) seen.push(e); })()).rejects.toBeInstanceOf(LLMServerError);
      expect(seen).toEqual([]);
    }
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
