/**
 * task-344: verify LLM adapters expose full request/response payload to the
 * engine via the `onRawExchange` hook, with sensitive headers (apiKey /
 * authorization) redacted to `***`.
 *
 * Red lines:
 *   - apiKey MUST be redacted (never appear verbatim in rawRequest.headers).
 *   - rawRequest.body MUST include the translated request body (model,
 *     messages, tools, max_tokens...).
 *   - rawResponse.body MUST include the full SSE stream text as received.
 *   - Error responses (non-2xx) MUST also invoke onRawExchange before throwing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../agent/unify/llm/anthropic.js';
import { ChatCompletionsAdapter } from '../../agent/unify/llm/chat-completions.js';
import { redactRawRequest } from '../../agent/unify/llm/adapter.js';

// ─── helpers ─────────────────────────────────────────────────────

/**
 * Fake a fetch returning an SSE stream built from the given lines.
 */
function mockSseFetch(lines, { status = 200, headers = {} } = {}) {
  const body = lines.join('\n');
  const encoder = new TextEncoder();
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/event-stream', ...headers }),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoder.encode(body) };
          },
          releaseLock() {},
        };
      },
    },
    text: async () => body,
  });
}

async function consume(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ─── redactRawRequest ───────────────────────────────────────────

describe('redactRawRequest', () => {
  it('redacts x-api-key, authorization, api-key headers', () => {
    const redacted = redactRawRequest({
      url: 'https://api.example.com/v1',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-secret',
        'Authorization': 'Bearer super-secret',
        'api-key': 'another-secret',
      },
      body: { model: 'x' },
    });
    expect(redacted.headers['x-api-key']).toBe('***');
    expect(redacted.headers['Authorization']).toBe('***');
    expect(redacted.headers['api-key']).toBe('***');
    expect(redacted.headers['Content-Type']).toBe('application/json');
    expect(redacted.body).toEqual({ model: 'x' });
  });

  it('leaves body unchanged and does not mutate input', () => {
    const input = { url: '/x', method: 'POST', headers: { 'x-api-key': 'sk' }, body: {} };
    const out = redactRawRequest(input);
    expect(input.headers['x-api-key']).toBe('sk');
    expect(out.headers['x-api-key']).toBe('***');
  });
});

// ─── Anthropic adapter ──────────────────────────────────────────

describe('AnthropicAdapter onRawExchange', () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('emits redacted rawRequest + SSE rawResponse after successful stream', async () => {
    globalThis.fetch = mockSseFetch([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '',
    ]);
    const adapter = new AnthropicAdapter({ apiKey: 'sk-topsecret', baseUrl: 'https://api.anthropic.com' });
    let captured = null;
    const gen = adapter.stream({
      model: 'claude-sonnet-4-20250514',
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      onRawExchange: (ex) => { captured = ex; },
    });
    await consume(gen);
    expect(captured).toBeTruthy();
    // Request
    expect(captured.rawRequest.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured.rawRequest.method).toBe('POST');
    expect(captured.rawRequest.headers['x-api-key']).toBe('***');
    // never leak the key
    const serialized = JSON.stringify(captured.rawRequest);
    expect(serialized.includes('sk-topsecret')).toBe(false);
    expect(captured.rawRequest.body.model).toBe('claude-sonnet-4-20250514');
    expect(captured.rawRequest.body.messages[0].content).toBe('hi');
    // Response
    expect(captured.rawResponse.status).toBe(200);
    expect(captured.rawResponse.format).toBe('sse');
    expect(captured.rawResponse.body).toContain('message_start');
    expect(captured.rawResponse.body).toContain('end_turn');
  });

  it('emits rawResponse on non-2xx before throwing', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: async () => 'rate limited',
    });
    const adapter = new AnthropicAdapter({ apiKey: 'sk-x' });
    let captured = null;
    await expect((async () => {
      const gen = adapter.stream({
        model: 'claude-sonnet-4-20250514',
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
        onRawExchange: (ex) => { captured = ex; },
      });
      await consume(gen);
    })()).rejects.toThrow();
    expect(captured).toBeTruthy();
    expect(captured.rawResponse.status).toBe(429);
    expect(captured.rawResponse.body).toContain('rate limited');
    expect(captured.rawRequest.headers['x-api-key']).toBe('***');
  });
});

// ─── Chat Completions adapter ────────────────────────────────────

describe('ChatCompletionsAdapter onRawExchange', () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('emits redacted rawRequest + SSE rawResponse after successful stream', async () => {
    globalThis.fetch = mockSseFetch([
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
      '',
      'data: [DONE]',
      '',
    ]);
    const adapter = new ChatCompletionsAdapter({
      apiKey: 'sk-topsecret',
      baseUrl: 'https://api.openai.com/v1',
    });
    let captured = null;
    const gen = adapter.stream({
      model: 'gpt-5',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      onRawExchange: (ex) => { captured = ex; },
    });
    await consume(gen);
    expect(captured).toBeTruthy();
    expect(captured.rawRequest.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured.rawRequest.headers['Authorization']).toBe('***');
    const serialized = JSON.stringify(captured.rawRequest);
    expect(serialized.includes('sk-topsecret')).toBe(false);
    expect(captured.rawRequest.body.model).toBe('gpt-5');
    expect(captured.rawResponse.status).toBe(200);
    expect(captured.rawResponse.format).toBe('sse');
    expect(captured.rawResponse.body).toContain('"hi"');
    expect(captured.rawResponse.body).toContain('[DONE]');
  });
});
