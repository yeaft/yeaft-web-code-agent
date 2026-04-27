/**
 * test/agent/unify/llm/router.test.js — AdapterRouter tests (Phase 7)
 *
 * Phase 7 removed the chat-completions adapter. Only "anthropic" and
 * "openai-responses" are supported protocols. claude-* models must use a
 * provider with protocol="anthropic"; everything else uses openai-responses.
 */

import { describe, it, expect } from 'vitest';
import { AdapterRouter } from '../../../../agent/unify/llm/router.js';
import { LLMAdapter } from '../../../../agent/unify/llm/adapter.js';

// ─── Test Providers ─────────────────────────────────────────

// Default-protocol provider (now resolves to openai-responses).
const RESPONSES_PROXY_PROVIDER = {
  name: 'my-proxy',
  baseUrl: 'http://localhost:6628/v1',
  apiKey: 'proxy',
  models: ['gpt-5', 'deepseek-chat'],
};

const ANTHROPIC_PROVIDER = {
  name: 'anthropic-direct',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  models: ['claude-opus-4-20250514'],
};

const RESPONSES_OPENAI_PROVIDER = {
  name: 'openai-direct',
  protocol: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  models: ['gpt-4.1'],
};

// Provider that mistakenly uses removed protocol.
const LEGACY_OPENAI_PROVIDER = {
  name: 'legacy-openai',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  models: ['gpt-4.1'],
};

// Provider declaring openai-responses but lists Claude models — Phase 7
// requires this combo to throw rather than fall back to chat-completions.
const COPILOT_LIKE_PROVIDER = {
  name: 'copilot',
  protocol: 'openai-responses',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-copilot',
  models: ['gpt-5.4', 'claude-opus-4.7'],
};

// ═══════════════════════════════════════════════════════════════
// Constructor + Model Resolution
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter constructor', () => {
  it('should extend LLMAdapter', () => {
    const router = new AdapterRouter({ providers: [RESPONSES_PROXY_PROVIDER] });
    expect(router instanceof LLMAdapter).toBe(true);
  });

  it('should build model-to-provider index', () => {
    const router = new AdapterRouter({ providers: [RESPONSES_PROXY_PROVIDER, ANTHROPIC_PROVIDER] });

    expect(router.getProviderForModel('gpt-5')).toEqual(RESPONSES_PROXY_PROVIDER);
    expect(router.getProviderForModel('deepseek-chat')).toEqual(RESPONSES_PROXY_PROVIDER);
    expect(router.getProviderForModel('claude-opus-4-20250514')).toEqual(ANTHROPIC_PROVIDER);
  });

  it('should give first provider priority for duplicate models', () => {
    const providers = [
      RESPONSES_PROXY_PROVIDER,
      { ...RESPONSES_OPENAI_PROVIDER, models: ['gpt-5'] },
    ];
    const router = new AdapterRouter({ providers });
    expect(router.getProviderForModel('gpt-5')).toEqual(RESPONSES_PROXY_PROVIDER);
  });

  it('should return null for unknown model', () => {
    const router = new AdapterRouter({ providers: [RESPONSES_PROXY_PROVIDER] });
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
    const router = new AdapterRouter({ providers: [RESPONSES_PROXY_PROVIDER, ANTHROPIC_PROVIDER] });
    const models = router.listAvailableModels();

    expect(models.length).toBe(3);
    expect(models.find(m => m.modelId === 'gpt-5')?.providerName).toBe('my-proxy');
    expect(models.find(m => m.modelId === 'claude-opus-4-20250514')?.providerName).toBe('anthropic-direct');
  });
});

// ═══════════════════════════════════════════════════════════════
// providers getter
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter.providers', () => {
  it('should return raw providers array', () => {
    const providers = [RESPONSES_PROXY_PROVIDER, ANTHROPIC_PROVIDER];
    const router = new AdapterRouter({ providers });
    expect(router.providers).toBe(providers);
  });
});

// ═══════════════════════════════════════════════════════════════
// Adapter Resolution (stream/call routing)
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter adapter creation', () => {
  it('should default to openai-responses protocol when provider omits protocol', async () => {
    const router = new AdapterRouter({ providers: [RESPONSES_PROXY_PROVIDER] });

    const originalFetch = global.fetch;
    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    try { await router.call({ model: 'gpt-5', system: 't', messages: [{ role: 'user', content: 'a' }] }); } catch {}
    // Default protocol is now openai-responses, which hits /responses
    expect(capturedUrl).toBe('http://localhost:6628/v1/responses');

    global.fetch = originalFetch;
  });

  it('should throw clear error with model list when model not found', async () => {
    const router = new AdapterRouter({ providers: [RESPONSES_PROXY_PROVIDER] });

    try {
      await router.call({ model: 'nonexistent-model' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('nonexistent-model');
      expect(err.message).toContain('not found in any provider');
      expect(err.message).toContain('gpt-5');
      expect(err.message).toContain('config.json');
    }
  });

  it('should create AnthropicAdapter for anthropic protocol provider', async () => {
    const router = new AdapterRouter({ providers: [ANTHROPIC_PROVIDER] });

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
      await router.call({ model: 'claude-opus-4-20250514', system: 'test', messages: [{ role: 'user', content: 'hi' }] });
    } catch {
      // Expected to throw (401)
    }

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');

    global.fetch = originalFetch;
  });

  it('should throw "Unsupported protocol" for legacy openai protocol provider', async () => {
    const router = new AdapterRouter({ providers: [LEGACY_OPENAI_PROVIDER] });

    await expect(
      router.call({ model: 'gpt-4.1', system: 'test', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/Unsupported protocol "openai".*chat-completions adapter was removed in Phase 7/s);
  });

  it('should create OpenAIResponsesAdapter for openai-responses protocol provider', async () => {
    const router = new AdapterRouter({ providers: [RESPONSES_OPENAI_PROVIDER] });

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
      await router.call({ model: 'gpt-4.1', system: 'test', messages: [{ role: 'user', content: 'hi' }] });
    } catch {
      // Expected 401
    }

    expect(capturedUrl).toBe('https://api.openai.com/v1/responses');
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-test');

    global.fetch = originalFetch;
  });

  it('should cache adapters — same provider reuses adapter', async () => {
    const router = new AdapterRouter({ providers: [RESPONSES_PROXY_PROVIDER] });
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

    try { await router.call({ model: 'gpt-5', system: 'test', messages: [{ role: 'user', content: 'a' }] }); } catch {}
    try { await router.call({ model: 'deepseek-chat', system: 'test', messages: [{ role: 'user', content: 'b' }] }); } catch {}

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
      providers: [RESPONSES_PROXY_PROVIDER, ANTHROPIC_PROVIDER, RESPONSES_OPENAI_PROVIDER],
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

    // claude-opus-4 → anthropic
    try { await router.call({ model: 'claude-opus-4-20250514', system: 'test', messages: [{ role: 'user', content: 'b' }] }); } catch {}
    expect(capturedUrls[1]).toContain('api.anthropic.com');

    // gpt-4.1 → openai-responses
    try { await router.call({ model: 'gpt-4.1', system: 'test', messages: [{ role: 'user', content: 'c' }] }); } catch {}
    expect(capturedUrls[2]).toContain('api.openai.com');

    global.fetch = originalFetch;
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 7: claude-* on a non-anthropic provider must throw —
// the chat-completions fallback path is gone.
// ═══════════════════════════════════════════════════════════════

describe('AdapterRouter Phase 7 — claude-* protocol enforcement', () => {
  it('should throw when claude-* model lives on a non-anthropic provider', async () => {
    const router = new AdapterRouter({ providers: [COPILOT_LIKE_PROVIDER] });

    // gpt-5.4 → still works (Responses API)
    const originalFetch = global.fetch;
    let capturedUrl = null;
    global.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: false, status: 401, headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };
    try { await router.call({ model: 'gpt-5.4', system: 't', messages: [{ role: 'user', content: 'a' }] }); } catch {}
    expect(capturedUrl).toBe('https://api.example.com/v1/responses');
    global.fetch = originalFetch;

    // claude-opus-4.7 → must throw (no chat-completions fallback)
    await expect(
      router.call({ model: 'claude-opus-4.7', system: 't', messages: [{ role: 'user', content: 'b' }] })
    ).rejects.toThrow(/Claude models require provider\.protocol="anthropic"/);
  });

  it('should leave anthropic-protocol providers untouched for claude-* models', async () => {
    const router = new AdapterRouter({ providers: [ANTHROPIC_PROVIDER] });

    const originalFetch = global.fetch;
    let capturedHeaders = null;
    global.fetch = async (_url, opts) => {
      capturedHeaders = opts?.headers || {};
      return {
        ok: false, status: 401, headers: new Map(),
        json: async () => ({ error: { message: 'test' } }),
        text: async () => 'Unauthorized',
      };
    };

    try { await router.call({ model: 'claude-opus-4-20250514', system: 't', messages: [{ role: 'user', content: 'a' }] }); } catch {}
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');

    global.fetch = originalFetch;
  });
});
