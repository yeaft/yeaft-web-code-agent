/**
 * openai-responses-raw-exchange.test.js — feat-openai-raw-exchange-parity.
 *
 * Pins parity with anthropic.js on the `onRawExchange` contract:
 *   1. On streaming success: callback fires once with rawRequest + rawResponse.
 *   2. rawRequest.body equals the actual JSON body we sent (no truncation).
 *   3. Authorization header is redacted to "***" (no bearer token leaks).
 *   4. rawResponse.body is the verbatim accumulated SSE stream (no truncation).
 *   5. rawResponse.format === 'sse'.
 *   6. On error path (non-OK status): callback STILL fires with the error body
 *      so the debug panel can show what the server returned.
 *
 * Why this matters: pre-PR, openai-responses.js never called onRawExchange,
 * so users on the OpenAI Responses protocol got an empty "copy request" /
 * "copy response" silently. The whole point of the verbatim debug feature
 * is byte-equality with what we sent — half-coverage broke that contract
 * for half of all users.
 */

import { describe, it, expect } from 'vitest';
import { OpenAIResponsesAdapter } from '../../../../agent/unify/llm/openai-responses.js';

/** Build a streaming Response that emits the given SSE chunks. */
function mkSseResponse(chunks, { ok = true, status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  const body = {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[i++]);
          return { done: false, value };
        },
        releaseLock() { /* noop */ },
      };
    },
  };
  return {
    ok,
    status,
    headers: {
      entries: () => Object.entries(headers),
    },
    body,
    text: async () => chunks.join(''),
  };
}

async function drain(gen) {
  const events = [];
  try {
    for await (const ev of gen) events.push(ev);
  } catch { /* swallow — error path is exercised explicitly elsewhere */ }
  return events;
}

describe('OpenAIResponsesAdapter — onRawExchange parity (verbatim)', () => {
  it('fires onRawExchange once on streaming success with verbatim SSE body', async () => {
    const orig = globalThis.fetch;
    const sseChunks = [
      'data: {"type":"response.created","response":{}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    ];
    let capturedUrl = null;
    let capturedAuth = null;
    let capturedBody = null;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedAuth = init.headers['Authorization'];
      capturedBody = init.body;
      return mkSseResponse(sseChunks, { headers: { 'content-type': 'text/event-stream' } });
    };

    let exchange = null;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-secret-token', baseUrl: 'https://stub.example' });
    try {
      await drain(adapter.stream({
        model: 'gpt-5',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        onRawExchange: (e) => { exchange = e; },
      }));
    } finally {
      globalThis.fetch = orig;
    }

    // Sanity: the request actually went out with the unredacted bearer.
    expect(capturedUrl).toBe('https://stub.example/responses');
    expect(capturedAuth).toBe('Bearer sk-secret-token');
    expect(capturedBody).toContain('"model":"gpt-5"');

    // The callback fired.
    expect(exchange).not.toBeNull();

    // 1. rawRequest.body equals the in-memory body object (verbatim, not stringified-then-cut).
    expect(exchange.rawRequest).toBeDefined();
    expect(exchange.rawRequest.url).toBe('https://stub.example/responses');
    expect(exchange.rawRequest.method).toBe('POST');
    expect(exchange.rawRequest.body).toMatchObject({
      model: 'gpt-5',
      instructions: 'sys',
      stream: true,
    });

    // 2. Authorization redacted.
    expect(exchange.rawRequest.headers['Authorization']).toBe('***');
    expect(exchange.rawRequest.headers['Content-Type']).toBe('application/json');

    // 3. rawResponse.body is the verbatim concatenated SSE stream — byte-for-byte.
    expect(exchange.rawResponse).toBeDefined();
    expect(exchange.rawResponse.format).toBe('sse');
    expect(exchange.rawResponse.body).toBe(sseChunks.join(''));
    expect(exchange.rawResponse.status).toBe(200);
    expect(exchange.rawResponse.headers['content-type']).toBe('text/event-stream');
  });

  it('preserves a payload past 50_000 bytes verbatim — no truncation', async () => {
    const big = 'x'.repeat(60_000);
    const sseChunks = [
      'data: {"type":"response.output_text.delta","delta":"' + big + '"}\n\n',
      'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ];
    const orig = globalThis.fetch;
    globalThis.fetch = async () => mkSseResponse(sseChunks);

    let exchange = null;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'k', baseUrl: 'https://stub' });
    try {
      await drain(adapter.stream({
        model: 'gpt-5',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        onRawExchange: (e) => { exchange = e; },
      }));
    } finally {
      globalThis.fetch = orig;
    }

    expect(exchange.rawResponse.body.length).toBe(sseChunks.join('').length);
    expect(exchange.rawResponse.body.length).toBeGreaterThan(60_000);
    expect(exchange.rawResponse.body).toBe(sseChunks.join(''));
  });

  it('fires onRawExchange on error path (non-OK status) before throwing', async () => {
    const orig = globalThis.fetch;
    const errBody = '{"error":{"message":"forbidden"}}';
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      headers: { entries: () => [['x-request-id', 'abc']] },
      text: async () => errBody,
    });

    let exchange = null;
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'k', baseUrl: 'https://stub' });
    let threw = null;
    try {
      await drain(adapter.stream({
        model: 'gpt-5',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        onRawExchange: (e) => { exchange = e; },
      }));
    } catch (err) {
      threw = err;
    } finally {
      globalThis.fetch = orig;
    }
    // The drain helper swallows the throw, but onRawExchange should still
    // have fired with the error response.
    expect(threw).toBeNull();
    expect(exchange).not.toBeNull();
    expect(exchange.rawResponse.status).toBe(403);
    expect(exchange.rawResponse.body).toBe(errBody);
    expect(exchange.rawRequest.headers['Authorization']).toBe('***');
  });

  it('does not crash if onRawExchange callback throws', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => mkSseResponse([
      'data: {"type":"response.completed","response":{"output":[],"usage":{}}}\n\n',
    ]);

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'k', baseUrl: 'https://stub' });
    let events = [];
    try {
      events = await drain(adapter.stream({
        model: 'gpt-5',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        onRawExchange: () => { throw new Error('subscriber bug'); },
      }));
    } finally {
      globalThis.fetch = orig;
    }
    // We still got the engine events out — the failing callback didn't poison
    // the stream. Defensive guard parity with anthropic.js.
    expect(events.some(e => e.type === 'usage')).toBe(true);
    expect(events.some(e => e.type === 'stop')).toBe(true);
  });

  it('still works without onRawExchange (backward compat)', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => mkSseResponse([
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"output":[],"usage":{}}}\n\n',
    ]);

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'k', baseUrl: 'https://stub' });
    let events = [];
    try {
      // No onRawExchange — must not throw.
      events = await drain(adapter.stream({
        model: 'gpt-5',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
      }));
    } finally {
      globalThis.fetch = orig;
    }
    expect(events.find(e => e.type === 'text_delta')?.text).toBe('hi');
  });
});
