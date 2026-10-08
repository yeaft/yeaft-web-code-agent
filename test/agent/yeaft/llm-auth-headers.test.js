import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveOne } from '../../../agent/yeaft/archive/tool-results.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import {
  AdapterRouter,
  anthropicAuthHeaderModeForProvider,
} from '../../../agent/yeaft/llm/router.js';
import { classifyAuthError } from '../../../agent/yeaft/llm/adapter.js';
import { estimateMessagesTokens, trimSnapshotForBudget } from '../../../agent/yeaft/history-window.js';
import { _resetCacheForTests } from '../../../agent/yeaft/llm/credentials/github-copilot.js';

const originalFetch = global.fetch;
const cleanup = [];

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function anthropicResponse() {
  return jsonResponse({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

describe('LLM adapter auth headers', () => {
  afterEach(async () => {
    global.fetch = originalFetch;
    delete process.env.COPILOT_GITHUB_TOKEN;
    _resetCacheForTests();
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('classifies permanent forbidden responses without retry', () => {
    for (const body of [
      'access denied',
      'not authorized',
      'authorization denied',
      'model unavailable for your plan',
      'subscription required',
      '{"error":{"code":"model_access_denied","message":"forbidden"}}',
    ]) {
      const err = classifyAuthError(403, body);
      expect(err.reasonCode).toBe('permission_denied');
      expect(err.temporary).toBe(false);
    }
  });

  it('keeps only generic forbidden responses eligible for retry', () => {
    const err = classifyAuthError(403, '{"message":"forbidden"}');
    expect(err.reasonCode).toBe('unknown_forbidden');
    expect(err.temporary).toBe(true);
  });

  it('selects native and bearer Anthropic authentication headers', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return anthropicResponse();
    });

    const native = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.com',
    });
    await native.call({ model: 'claude-sonnet-4.5', system: '', messages: [] });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe('anthropic-key');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');

    const bearer = new AnthropicAdapter({
      apiKey: 'copilot-token',
      baseUrl: 'https://api.githubcopilot.com',
      authHeaderMode: 'bearer',
    });
    await bearer.call({ model: 'claude-opus-4.8', system: '', messages: [] });
    expect(calls[1].url).toBe('https://api.githubcopilot.com/v1/messages');
    expect(calls[1].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(calls[1].init.headers['x-api-key']).toBeUndefined();
    expect(calls[1].init.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('selects bearer auth for Copilot and credential-backed Anthropic providers', () => {
    expect(anthropicAuthHeaderModeForProvider({
      name: 'github-copilot',
      baseUrl: 'https://api.githubcopilot.com',
    })).toBe('bearer');
    expect(anthropicAuthHeaderModeForProvider({
      name: 'custom-token-provider',
      baseUrl: 'https://llm.example.test',
      credentialProvider: 'custom-token-provider',
    })).toBe('bearer');
    expect(anthropicAuthHeaderModeForProvider({
      name: 'custom-token-provider',
      baseUrl: 'https://llm.example.test',
      credentialProvider: 'custom-token-provider',
      anthropicAuthHeaderMode: 'x-api-key',
    })).toBe('x-api-key');
    expect(anthropicAuthHeaderModeForProvider({
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'static-key',
    })).toBe('x-api-key');
  });

  it('refreshes dynamic credentials once for call and stream while static keys fail once', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'raw-github-token';
    const dynamicProvider = {
      name: 'github-copilot',
      baseUrl: 'https://api.githubcopilot.com',
      credentialProvider: 'github-copilot',
      models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }],
    };
    for (const mode of ['call', 'stream']) {
      let attempts = 0;
      let exchanges = 0;
      global.fetch = vi.fn(async (url) => {
        if (String(url).includes('/copilot_internal/v2/token')) {
          exchanges += 1;
          return jsonResponse({ token: `api-token-${exchanges}`, expires_at: Math.floor(Date.now() / 1000) + 1800 });
        }
        attempts += 1;
        if (attempts === 1) return new Response('{"message":"bad token"}', { status: 401 });
        if (mode === 'call') return anthropicResponse();
        return new Response([
          'event: content_block_delta',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      });
      const router = new AdapterRouter({ providers: [dynamicProvider] });
      if (mode === 'call') {
        await router.call({ model: 'github-copilot/claude-opus-4.8', system: '', messages: [] });
      } else {
        for await (const _event of router.stream({ model: 'github-copilot/claude-opus-4.8', system: '', messages: [] })) {}
      }
      expect(attempts).toBe(2);
    }

    let staticAttempts = 0;
    global.fetch = vi.fn(async () => {
      staticAttempts += 1;
      return new Response('{"message":"bad token"}', { status: 401 });
    });
    const staticRouter = new AdapterRouter({ providers: [{
      name: 'static-test',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'static-key',
      models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }],
    }] });
    await expect(staticRouter.call({ model: 'static-test/claude-opus-4.8', system: '', messages: [] }))
      .rejects.toMatchObject({ statusCode: 401, credentialRefreshable: false });
    expect(staticAttempts).toBe(1);
  });

  it('keeps credential refresh response bodies out of call and stream errors', async () => {
    for (const [mode, credentialPath, refreshStatus] of [
      ['call', 'explicit', 401],
      ['stream', 'explicit', 403],
      ['call', 'explicit', 500],
      ['stream', 'managed', 401],
      ['call', 'managed', 403],
      ['stream', 'managed', 500],
    ]) {
      _resetCacheForTests();
      process.env.COPILOT_GITHUB_TOKEN = `managed-raw-token-${mode}-${refreshStatus}`;
      const secretBody = `refresh-secret-provider-body token=${mode}-${credentialPath}-${refreshStatus}`;
      let exchanges = 0;
      let providerRequests = 0;
      global.fetch = vi.fn(async (url) => {
        if (String(url).includes('/copilot_internal/v2/token')) {
          exchanges += 1;
          if (exchanges === 1) {
            return jsonResponse({ token: 'initial-api-token', expires_at: Math.floor(Date.now() / 1000) + 1800 });
          }
          return new Response(secretBody, { status: refreshStatus });
        }
        providerRequests += 1;
        return new Response('{"message":"provider rejected stale credential"}', { status: 401 });
      });
      const provider = {
        name: 'github-copilot',
        baseUrl: 'https://api.githubcopilot.com',
        credentialProvider: 'github-copilot',
        ...(credentialPath === 'explicit' ? { githubToken: `explicit-raw-token-${mode}-${refreshStatus}` } : {}),
        models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }],
      };
      const router = new AdapterRouter({ providers: [provider] });
      let caught;
      try {
        if (mode === 'call') {
          await router.call({ model: 'github-copilot/claude-opus-4.8', system: '', messages: [] });
        } else {
          for await (const _event of router.stream({ model: 'github-copilot/claude-opus-4.8', system: '', messages: [] })) {}
        }
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({
        name: 'LLMAuthError',
        statusCode: refreshStatus,
        reasonCode: 'credential_exchange_failed',
        provider: 'github-copilot',
        model: 'github-copilot/claude-opus-4.8',
        credentialRefreshable: true,
      });
      expect(caught.message).toBe('LLM credential refresh failed');
      expect(caught.message).not.toContain(secretBody);
      expect(exchanges).toBe(2);
      expect(providerRequests).toBe(1);
    }
  });

  it('stops dynamic credential refresh after the second 401', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'raw-github-token-second';
    let attempts = 0;
    let exchanges = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/copilot_internal/v2/token')) {
        exchanges += 1;
        return jsonResponse({ token: `api-token-second-${exchanges}`, expires_at: Math.floor(Date.now() / 1000) + 1800 });
      }
      attempts += 1;
      return new Response('{"message":"still bad"}', { status: 401 });
    });
    const router = new AdapterRouter({ providers: [{
      name: 'github-copilot',
      baseUrl: 'https://api.githubcopilot.com',
      credentialProvider: 'github-copilot',
      models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }],
    }] });
    await expect(router.call({ model: 'github-copilot/claude-opus-4.8', system: '', messages: [] }))
      .rejects.toMatchObject({ statusCode: 401, credentialRefreshable: true });
    expect(attempts).toBe(2);
  });

  it('routes Anthropic providers configured for bearer auth through the router', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return anthropicResponse();
    });

    const router = new AdapterRouter({ providers: [{
      name: 'copilot-static-test',
      baseUrl: 'https://api.githubcopilot.com',
      apiKey: 'copilot-token',
      anthropicAuthHeaderMode: 'bearer',
      models: [{ id: 'claude-opus-4.8', protocol: 'anthropic' }],
    }] });
    await router.call({ model: 'copilot-static-test/claude-opus-4.8', system: '', messages: [] });

    expect(calls[0].url).toBe('https://api.githubcopilot.com/v1/messages');
    expect(calls[0].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(calls[0].init.headers['x-api-key']).toBeUndefined();
  });

  it('keeps OpenAI Responses requests on bearer Authorization', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const adapter = new OpenAIResponsesAdapter({
      apiKey: 'copilot-token',
      baseUrl: 'https://api.githubcopilot.com/v1',
    });
    await adapter.call({ model: 'gpt-5.5', system: '', messages: [] });

    expect(calls[0].url).toBe('https://api.githubcopilot.com/v1/responses');
    expect(calls[0].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(calls[0].init.headers['x-api-key']).toBeUndefined();

    // Visible progress assistant messages carry continuity information. Both
    // provider formats must preserve their text while dropping UI metadata.
    vi.clearAllMocks();
    const messages = [
      { role: 'user', content: 'Original question' },
      { role: 'assistant', content: 'I found the state boundary.', responseKind: 'progress' },
      { role: 'assistant', content: 'The previous turn completed.', responseKind: 'result' },
    ];
    const anthropicCalls = [];
    global.fetch = vi.fn(async (url, init) => {
      anthropicCalls.push({ url, body: JSON.parse(init.body) });
      return anthropicResponse();
    });
    const anthropic = new AnthropicAdapter({ apiKey: 'key', baseUrl: 'https://anthropic.test' });
    await anthropic.call({ model: 'claude-sonnet-4.5', system: '', messages });

    expect(anthropicCalls[0].body.messages).toEqual([
      { role: 'user', content: 'Original question' },
      { role: 'assistant', content: [{ type: 'text', text: 'I found the state boundary.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'The previous turn completed.' }] },
    ]);
    expect(JSON.stringify(anthropicCalls[0].body)).not.toContain('responseKind');

    const openAiCalls = [];
    global.fetch = vi.fn(async (url, init) => {
      openAiCalls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const openai = new OpenAIResponsesAdapter({ apiKey: 'key', baseUrl: 'https://openai.test/v1' });
    await openai.call({ model: 'gpt-5.5', system: '', messages });

    expect(openAiCalls[0].body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Original question' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I found the state boundary.' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'The previous turn completed.' }],
      },
    ]);
    expect(JSON.stringify(openAiCalls[0].body)).not.toContain('responseKind');
  });

  it('omits an oversized signed thinking block atomically before Anthropic wire replay', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return anthropicResponse();
    });

    const messages = trimSnapshotForBudget([{
      role: 'assistant',
      content: 'prior answer',
      thinkingBlocks: [{ thinking: 'x'.repeat(100_000), signature: 'opaque-signature' }],
    }], { messageTokenBudget: 100 });
    expect(estimateMessagesTokens(messages)).toBeLessThanOrEqual(100);

    const adapter = new AnthropicAdapter({ apiKey: 'key', baseUrl: 'https://anthropic.test' });
    await adapter.call({ model: 'claude-sonnet-4.5', system: '', messages });

    expect(calls[0].body.messages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'prior answer' }],
    }]);
    expect(JSON.stringify(calls[0].body)).not.toContain('opaque-signature');
    expect(JSON.stringify(calls[0].body)).not.toContain('x'.repeat(1_000));
  });

  it('bounds object-valued tool output before Responses JSON serialization', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const messages = trimSnapshotForBudget([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-object-output', name: 'Inspect', input: {} }],
      },
      {
        role: 'tool',
        toolCallId: 'call-object-output',
        content: { payload: 'z'.repeat(100_000) },
      },
    ], { messageTokenBudget: 100 });
    expect(estimateMessagesTokens(messages)).toBeLessThanOrEqual(100);

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'key', baseUrl: 'https://openai.test/v1' });
    await adapter.call({ model: 'gpt-5.5', system: '', messages });

    const output = calls[0].body.input.find(item => item.type === 'function_call_output');
    expect(output).toBeDefined();
    expect(typeof output.output).toBe('string');
    expect(output.output).not.toContain('z'.repeat(1_000));
    expect(output.output.length).toBeLessThan(500);
  });

  it.each(['low', 'high', 'auto', undefined])('preserves explicit image detail %s without changing caller defaults', async detail => {
    global.fetch = vi.fn(async () => jsonResponse({ output_text: 'ok', usage: {} }));
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'key', baseUrl: 'https://openai.test/v1' });
    const sources = [{ type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' }, { type: 'url', url: 'https://image.test/picture.png' }];
    const parts = sources.map(source => ({ type: 'image', source, ...(detail ? { detail } : {}) }));
    const before = structuredClone(parts);
    await adapter.call({ model: 'gpt-4o-mini', system: '', messages: [
      { role: 'user', content: parts }, { role: 'tool', toolCallId: 'image-result', content: parts },
    ] });
    const input = JSON.parse(global.fetch.mock.calls[0][1].body).input;
    const expected = ['data:image/png;base64,aW1hZ2U=', 'https://image.test/picture.png'].map(image_url => ({
      type: 'input_image', image_url, ...(detail ? { detail } : {}),
    }));
    expect(input[0].content).toEqual(expected);
    expect(input[1].output).toEqual(expected);
    expect(parts).toEqual(before);
  });

  it('translates PDF document blocks to Responses input_file content', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const adapter = new OpenAIResponsesAdapter({ apiKey: 'key', baseUrl: 'https://openai.test/v1' });
    await adapter.call({
      model: 'gpt-5.5',
      system: '',
      messages: [{
        type: 'message',
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
          title: 'requirements.pdf',
        }],
      }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_file',
        filename: 'requirements.pdf',
        file_data: 'data:application/pdf;base64,cGRm',
      }],
    }]);
  });

  it('keeps provider request bodies and archive previews valid when strings contain lone surrogates', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, serializedBody: init.body });
      if (body.stream) {
        const event = JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
        });
        return new Response(`data: ${event}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return url.includes('anthropic')
        ? anthropicResponse()
        : jsonResponse({ output_text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const ownProto = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    const crossRealmText = runInNewContext(`new String('cross\\uD800')`);
    const spoofedText = { value: 'keep-me', [Symbol.toStringTag]: 'String' };
    const throwingTag = { value: 'still-here' };
    Object.defineProperty(throwingTag, Symbol.toStringTag, {
      get() { throw new Error('must not inspect Symbol.toStringTag'); },
    });
    const responses = new OpenAIResponsesAdapter({ apiKey: 'key', baseUrl: 'https://openai.test/v1' });
    await responses.call({
      model: 'gpt-5.5',
      system: `system \uDFFF`,
      messages: [
        { role: 'user', content: `valid 😀 user \uD800` },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'tool', input: { value: `arg \uD800` } }] },
        { role: 'tool', toolCallId: 'call-1', content: `output \uD83D` },
      ],
      extraBody: {
        metadata: {
          label: `meta \uDFFF`,
          at: new Date('2026-01-02T03:04:05Z'),
          bytes: Buffer.from([1, 2]),
          boxed: new Number(7),
          boxedText: { nested: new String(`boxed \uD800`), crossRealmText },
          spoofedText,
          throwingTag,
          custom: { toJSON(key) { return { key, text: `custom \uD800` }; } },
          customText: { toJSON() { return new String(`custom boxed \uDFFF`); } },
          ownProto,
        },
      },
    });
    expect(calls[0].body).toMatchObject({
      instructions: 'system �',
      metadata: {
        label: 'meta �',
        at: '2026-01-02T03:04:05.000Z',
        bytes: { type: 'Buffer', data: [1, 2] },
        boxed: 7,
        boxedText: { nested: 'boxed �', crossRealmText: 'cross�' },
        spoofedText: { value: 'keep-me' },
        throwingTag: { value: 'still-here' },
        custom: { key: 'custom', text: 'custom �' },
        customText: 'custom boxed �',
        ownProto: { __proto__: { polluted: 'yes' } },
      },
      input: [
        { content: [{ text: 'valid 😀 user �' }] },
        { arguments: '{"value":"arg �"}' },
        { output: 'output �' },
      ],
    });
    expect(calls[0].body.metadata.boxedText.nested.isWellFormed()).toBe(true);
    expect(calls[0].body.metadata.boxedText.crossRealmText.isWellFormed()).toBe(true);
    expect(calls[0].body.metadata.spoofedText).toEqual({ value: 'keep-me' });
    expect(calls[0].body.metadata.throwingTag).toEqual({ value: 'still-here' });
    expect(calls[0].body.metadata.customText.isWellFormed()).toBe(true);
    expect(Object.hasOwn(calls[0].body.metadata.ownProto, '__proto__')).toBe(true);
    expect(calls[0].body.metadata.ownProto.polluted).toBeUndefined();

    const anthropic = new AnthropicAdapter({ apiKey: 'key', baseUrl: 'https://anthropic.test' });
    await anthropic.call({
      model: 'claude-sonnet-4.5',
      system: `system \uD800`,
      messages: [{ role: 'user', content: `valid 😀 user \uDFFF` }],
    });
    expect(calls[1].body.system).toBe(`system ${String.fromCodePoint(0xFFFD)}`);
    expect(calls[1].body.messages[0].content).toBe(`valid 😀 user ${String.fromCodePoint(0xFFFD)}`);

    let rawExchange;
    for await (const _event of responses.stream({
      model: 'gpt-5.5',
      system: `stream \uD800`,
      messages: [{ role: 'user', content: 'hi' }],
      onRawExchange(exchange) { rawExchange = exchange; },
    })) { /* consume */ }
    expect(JSON.stringify(rawExchange.rawRequest.body)).toBe(calls[2].serializedBody);
    expect(rawExchange.rawRequest.body.instructions).toBe('stream �');

    const root = await mkdtemp(join(tmpdir(), 'yeaft-archive-preview-'));
    cleanup.push(root);
    const archived = await archiveOne({
      root,
      scopeDir: 'session/test',
      message: { role: 'tool', toolCallId: 'call-1', content: `${'a'.repeat(199)}😀tail` },
    });
    expect(archived.stub.content).toContain(`${'a'.repeat(199)}${String.fromCodePoint(0xFFFD)}`);
    expect(archived.stub.content.isWellFormed()).toBe(true);
  });
});
