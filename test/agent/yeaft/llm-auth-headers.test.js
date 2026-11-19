import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
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

});
