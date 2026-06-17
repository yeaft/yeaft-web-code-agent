/**
 * Integration tests: adapter-level error classification + retry-after
 * header parsing.
 *
 * We mock global.fetch so we can drive the adapter through error paths
 * deterministically. Goal: prove the adapter throws the typed error the
 * engine relies on (`LLMRateLimitError.retryAfterMs`, `LLMServerError`),
 * so the engine's retry loop has the metadata it needs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import {
  LLMRateLimitError,
  LLMServerError,
  LLMAuthError,
  LLMContextError,
} from '../../../agent/yeaft/llm/adapter.js';

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
});
