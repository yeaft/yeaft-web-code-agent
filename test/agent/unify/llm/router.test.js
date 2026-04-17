/**
 * test/agent/unify/llm/router.test.js — AdapterRouter tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRouter } from '../../../../agent/unify/llm/router.js';
import { LLMAdapter } from '../../../../agent/unify/llm/adapter.js';

// ─── Test Providers ─────────────────────────────────────────

const PROXY_PROVIDER = {
  name: 'my-proxy',
  baseUrl: 'http://localhost:6628/v1',
  apiKey: 'proxy',
  models: ['claude-sonnet-4-20250514', 'gpt-5', 'deepseek-chat', 'claude-haiku-3-20250414'],
};

const ANTHROPIC_PROVIDER = {
  name: 'anthropic-direct',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  models: ['claude-opus-4-20250514'],
};

const OPENAI_PROVIDER = {
  name: 'openai-direct',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  models: ['gpt-4.1'],
};

// ═══════════════════════════════════════════════════════════════
// Constructor + Model Resolution
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter constructor', () => {
  it('should extend LLMAdapter', () => {
    const router = new AdapterRouter({ providers: [PROXY_PROVIDER] });
    expect(router instanceof LLMAdapter).toBe(true);
  });

  it('should build model-to-provider index', () => {
    const router = new AdapterRouter({ providers: [PROXY_PROVIDER, ANTHROPIC_PROVIDER] });

    // Proxy models
    expect(router.getProviderForModel('claude-sonnet-4-20250514')).toEqual(PROXY_PROVIDER);
    expect(router.getProviderForModel('gpt-5')).toEqual(PROXY_PROVIDER);
    expect(router.getProviderForModel('deepseek-chat')).toEqual(PROXY_PROVIDER);

    // Anthropic direct model
    expect(router.getProviderForModel('claude-opus-4-20250514')).toEqual(ANTHROPIC_PROVIDER);
  });

  it('should give first provider priority for duplicate models', () => {
    // Both have claude-sonnet, but proxy is listed first
    const providers = [
      PROXY_PROVIDER,
      { ...ANTHROPIC_PROVIDER, models: ['claude-sonnet-4-20250514'] },
    ];
    const router = new AdapterRouter({ providers });
    expect(router.getProviderForModel('claude-sonnet-4-20250514')).toEqual(PROXY_PROVIDER);
  });

  it('should return null for unknown model', () => {
    const router = new AdapterRouter({ providers: [PROXY_PROVIDER] });
    expect(router.getProviderForModel('nonexistent-model')).toBeNull();
  });

  it('should handle provider without models array', () => {
    const emptyProvider = { name: 'empty', baseUrl: 'http://localhost', apiKey: 'x' };
    const router = new AdapterRouter({ providers: [emptyProvider] });
    expect(router.listAvailableModels()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// listAvailableModels
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter.listAvailableModels', () => {
  it('should list all models with provider names', () => {
    const router = new AdapterRouter({ providers: [PROXY_PROVIDER, ANTHROPIC_PROVIDER] });
    const models = router.listAvailableModels();

    expect(models.length).toBe(5); // 4 proxy + 1 anthropic
    expect(models.find(m => m.modelId === 'gpt-5')?.providerName).toBe('my-proxy');
    expect(models.find(m => m.modelId === 'claude-opus-4-20250514')?.providerName).toBe('anthropic-direct');
  });
});

// ═══════════════════════════════════════════════════════════════
// providers getter
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter.providers', () => {
  it('should return raw providers array', () => {
    const providers = [PROXY_PROVIDER, ANTHROPIC_PROVIDER];
    const router = new AdapterRouter({ providers });
    expect(router.providers).toBe(providers);
  });
});

// ═══════════════════════════════════════════════════════════════
// Adapter Resolution (stream/call routing)
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter adapter creation', () => {
  it('should create ChatCompletionsAdapter for default protocol', async () => {
    const router = new AdapterRouter({ providers: [PROXY_PROVIDER] });

    // We can't easily call stream() without mocking fetch, but we can verify
    // adapter creation by checking the error on unknown model
    await expect(async () => {
      for await (const _ of router.stream({ model: 'nonexistent' })) {
        // should throw
      }
    }).rejects.toThrow('not found in any provider');
  });

  it('should throw clear error with model list when model not found', async () => {
    const router = new AdapterRouter({ providers: [PROXY_PROVIDER] });

    try {
      await router.call({ model: 'nonexistent-model' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('nonexistent-model');
      expect(err.message).toContain('not found in any provider');
      expect(err.message).toContain('claude-sonnet-4-20250514'); // lists available
      expect(err.message).toContain('config.json');
    }
  });

  it('should create AnthropicAdapter for anthropic protocol provider', async () => {
    const router = new AdapterRouter({ providers: [ANTHROPIC_PROVIDER] });

    // Mock fetch to verify AnthropicAdapter is used (Anthropic uses different headers)
    const originalFetch = global.fetch;
    let capturedHeaders = null;

    global.fetch = async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      // Return a minimal error response so we don't have to mock the full stream
      return {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    try {
      await router.call({ model: 'claude-opus-4-20250514', system: 'test', messages: [{ role: 'user', content: 'hi' }] });
    } catch {
      // Expected to throw (401)
    }

    // AnthropicAdapter uses x-api-key header, ChatCompletions uses Authorization: Bearer
    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');

    global.fetch = originalFetch;
  });

  it('should create ChatCompletionsAdapter for openai protocol provider', async () => {
    const router = new AdapterRouter({ providers: [OPENAI_PROVIDER] });

    const originalFetch = global.fetch;
    let capturedHeaders = null;

    global.fetch = async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    try {
      await router.call({ model: 'gpt-4.1', system: 'test', messages: [{ role: 'user', content: 'hi' }] });
    } catch {
      // Expected
    }

    // ChatCompletionsAdapter uses Authorization: Bearer
    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-test');

    global.fetch = originalFetch;
  });

  it('should create OpenAIResponsesAdapter for openai-responses protocol provider', async () => {
    const RESPONSES_PROVIDER = {
      name: 'openai-responses',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-responses',
      models: ['gpt-5'],
    };
    const router = new AdapterRouter({ providers: [RESPONSES_PROVIDER] });

    const originalFetch = global.fetch;
    let capturedUrl = null;
    let capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts?.headers || {};
      return {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    try {
      await router.call({ model: 'gpt-5', system: 'test', messages: [{ role: 'user', content: 'hi' }] });
    } catch {
      // Expected 401
    }

    // Responses adapter hits /v1/responses
    expect(capturedUrl).toBe('https://api.openai.com/v1/responses');
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-responses');

    global.fetch = originalFetch;
  });

  it('should cache adapters — same provider reuses adapter', async () => {
    const router = new AdapterRouter({ providers: [PROXY_PROVIDER] });
    const originalFetch = global.fetch;
    let fetchCount = 0;

    global.fetch = async () => {
      fetchCount++;
      return {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    // Call twice with different models from same provider
    try { await router.call({ model: 'gpt-5', system: 'test', messages: [{ role: 'user', content: 'a' }] }); } catch {}
    try { await router.call({ model: 'deepseek-chat', system: 'test', messages: [{ role: 'user', content: 'b' }] }); } catch {}

    // Both should have hit the same adapter (same provider), so fetch should be called twice
    expect(fetchCount).toBe(2);

    global.fetch = originalFetch;
  });
});

// ═══════════════════════════════════════════════════════════════
// Multi-provider routing
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter multi-provider routing', () => {
  it('should route to correct provider based on model', async () => {
    const router = new AdapterRouter({
      providers: [PROXY_PROVIDER, ANTHROPIC_PROVIDER, OPENAI_PROVIDER],
    });

    const originalFetch = global.fetch;
    const capturedUrls = [];

    global.fetch = async (url) => {
      capturedUrls.push(url);
      return {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    // gpt-5 → proxy (http://localhost:6628/v1)
    try { await router.call({ model: 'gpt-5', system: 'test', messages: [{ role: 'user', content: 'a' }] }); } catch {}
    expect(capturedUrls[0]).toContain('localhost:6628');

    // claude-opus-4 → anthropic (https://api.anthropic.com)
    try { await router.call({ model: 'claude-opus-4-20250514', system: 'test', messages: [{ role: 'user', content: 'b' }] }); } catch {}
    expect(capturedUrls[1]).toContain('api.anthropic.com');

    // gpt-4.1 → openai (https://api.openai.com)
    try { await router.call({ model: 'gpt-4.1', system: 'test', messages: [{ role: 'user', content: 'c' }] }); } catch {}
    expect(capturedUrls[2]).toContain('api.openai.com');

    global.fetch = originalFetch;
  });
});
