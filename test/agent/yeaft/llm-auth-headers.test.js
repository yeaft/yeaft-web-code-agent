import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { classifyAuthError } from '../../../agent/yeaft/llm/adapter.js';
import { _resetCacheForTests } from '../../../agent/yeaft/llm/credentials/github-copilot.js';

const originalFetch = global.fetch;

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
});
