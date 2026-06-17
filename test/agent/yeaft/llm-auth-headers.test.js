import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import {
  AdapterRouter,
  anthropicAuthHeaderModeForProvider,
} from '../../../agent/yeaft/llm/router.js';

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
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('keeps native Anthropic requests on x-api-key', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return anthropicResponse();
    });

    const adapter = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.com',
    });
    await adapter.call({ model: 'claude-sonnet-4.5', system: '', messages: [] });

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe('anthropic-key');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('uses bearer auth for GitHub Copilot Anthropic-compatible requests', async () => {
    const calls = [];
    global.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return anthropicResponse();
    });

    const adapter = new AnthropicAdapter({
      apiKey: 'copilot-token',
      baseUrl: 'https://api.githubcopilot.com',
      authHeaderMode: 'bearer',
    });
    await adapter.call({ model: 'claude-opus-4.8', system: '', messages: [] });

    expect(calls[0].url).toBe('https://api.githubcopilot.com/v1/messages');
    expect(calls[0].init.headers.Authorization).toBe('Bearer copilot-token');
    expect(calls[0].init.headers['x-api-key']).toBeUndefined();
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
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
  });
});
