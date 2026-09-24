/**
 * Tests for AdapterRouter per-model protocol routing.
 *
 * Backwards-compat: legacy `provider.models: string[]` still works.
 * New: per-model `{id, protocol}` overrides and id-based heuristics let
 * a single provider serve both Anthropic and OpenAI families.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLlmConfig, updateLlmConfig } from '../../agent/yeaft/config-api.js';
import { normalizeLlmRetry } from '../../agent/yeaft/config.js';
import { normalizeKnownProviderForRuntime } from '../../agent/yeaft/llm/known-providers.js';

vi.mock('../../agent/yeaft/llm/credentials/index.js', () => ({
  CREDENTIAL_PROVIDER_NAMES: { GITHUB_COPILOT: 'github-copilot' },
  getCredentialProvider: () => ({ getApiKey: async () => 'copilot-token' }),
}));

import {
  AdapterRouter,
  normalizeModelEntry,
  inferProtocolFromModelId,
} from '../../agent/yeaft/llm/router.js';

describe('normalizeModelEntry', () => {
  it("normalizes valid and invalid model entries", () => {
    {
    expect(normalizeModelEntry('gpt-5')).toEqual({ id: 'gpt-5' });
    expect(normalizeModelEntry({ id: 'claude-sonnet-4', protocol: 'anthropic' }))
      .toEqual({ id: 'claude-sonnet-4', protocol: 'anthropic' });

    }

    {
    expect(normalizeModelEntry('')).toBeNull();
    expect(normalizeModelEntry({})).toBeNull();
    expect(normalizeModelEntry(null)).toBeNull();
    expect(normalizeModelEntry({ id: 123 })).toBeNull();

    }
  });
});

describe('inferProtocolFromModelId', () => {
  it("classifies known and unknown model protocol ids", () => {
    {
    expect(inferProtocolFromModelId('claude-sonnet-4-20250514')).toBe('anthropic');
    expect(inferProtocolFromModelId('claude-opus-4')).toBe('anthropic');
    expect(inferProtocolFromModelId('claude-opus-4-8')).toBe('anthropic');
    expect(inferProtocolFromModelId('claude-opus-4.8')).toBe('anthropic');
    expect(inferProtocolFromModelId('anthropic.claude-3-haiku')).toBe('anthropic');
    expect(inferProtocolFromModelId('gpt-5')).toBe('openai-responses');
    expect(inferProtocolFromModelId('gpt-4o-mini')).toBe('openai-responses');
    expect(inferProtocolFromModelId('o1-preview')).toBe('openai-responses');
    expect(inferProtocolFromModelId('o3-mini')).toBe('openai-responses');
    expect(inferProtocolFromModelId('chatgpt-5')).toBe('openai-responses');

    }

    {
    expect(inferProtocolFromModelId('deepseek-chat')).toBeNull();
    expect(inferProtocolFromModelId('llama-3')).toBeNull();
    expect(inferProtocolFromModelId('')).toBeNull();
    expect(inferProtocolFromModelId(null)).toBeNull();

    }
  });
});

describe('AdapterRouter resolution', () => {
  it('keeps managed request policies across save, reload and per-model dispatch without persisting credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'managed-request-policy-'));
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), {
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetch;
    try {
      const capabilities = { eagerInputStreaming: true };
      const modelCapabilities = { eagerInputStreaming: false };
      const models = [
        { id: 'claude-opus-4.8', protocol: 'anthropic', streamIdleTimeoutMs: 0, capabilities: modelCapabilities },
        { id: 'claude-sonnet-4.6', protocol: 'anthropic' },
        { id: 'claude-opus-4.7', protocol: 'anthropic', streamIdleTimeoutMs: 400_000 },
      ];
      const saved = updateLlmConfig({ providers: [{ name: 'github-copilot', apiKey: 'PRIVATE-API-KEY',
        githubToken: 'PRIVATE-GITHUB-TOKEN', baseUrl: 'https://unused.invalid',
        streamIdleTimeoutMs: 200_000, capabilities, models }] }, dir);
      expect(saved.error).toBeUndefined();
      const expected = { name: 'github-copilot', managed: 'github-copilot', credentialProvider: 'github-copilot',
        streamIdleTimeoutMs: 200_000, capabilities, models };
      expect(saved.providers).toEqual([expected]);
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('PRIVATE');
      const reloaded = getLlmConfig(dir);
      expect(reloaded.providers).toEqual([expected]);
      expect(normalizeKnownProviderForRuntime(reloaded.providers[0])).toEqual({ ...expected, baseUrl: 'https://api.githubcopilot.com' });
      const router = new AdapterRouter({ providers: reloaded.providers, llmRetry: normalizeLlmRetry() });
      // All three share an adapter; no model's absolute override may leak to siblings.
      for (const [id, budget, eager] of [['claude-opus-4.8', 0, false], ['claude-sonnet-4.6', 200_000, true],
        ['claude-opus-4.7', 400_000, true], ['claude-sonnet-4.6', 200_000, true]]) {
        const onRequestStart = vi.fn();
        for await (const _ of router.stream({ model: `github-copilot/${id}`, messages: [], effort: 'high', effortSource: 'user',
          tools: [{ name: 'FileWrite', description: 'Write', parameters: { type: 'object' } }], onRequestStart })) {}
        expect(onRequestStart).toHaveBeenCalledWith({ effort: 'high', streamIdleTimeoutMs: budget });
        const [url, init] = fetch.mock.calls.at(-1);
        expect(url).toBe('https://api.githubcopilot.com/v1/messages');
        expect(JSON.parse(init.body).tools[0].eager_input_streaming).toBe(eager ? true : undefined);
      }
      const zeroSaved = updateLlmConfig({ providers: [{ ...reloaded.providers[0], streamIdleTimeoutMs: 0 }] }, dir);
      expect(zeroSaved.providers[0].streamIdleTimeoutMs).toBe(0);
      const zeroRouter = new AdapterRouter({ providers: getLlmConfig(dir).providers, llmRetry: normalizeLlmRetry() });
      const onRequestStart = vi.fn();
      for await (const _ of zeroRouter.stream({ model: 'github-copilot/claude-sonnet-4.6', messages: [], effort: 'high', effortSource: 'user', onRequestStart })) {}
      expect(onRequestStart).toHaveBeenCalledWith({ effort: 'high', streamIdleTimeoutMs: 0 });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves captured catalogs and routes managed protocol refs", async () => {
    {
    const oldFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(
        'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    try {
      const router = new AdapterRouter({
        providers: [{
          name: 'old',
          baseUrl: 'https://old.example/v1',
          apiKey: 'old-key',
          protocol: 'openai-responses',
          models: ['old-model'],
        }],
      });
      const stream = router.stream({ model: 'old/old-model', messages: [] });
      router.refreshProviders([{
        name: 'new',
        baseUrl: 'https://new.example/v1',
        apiKey: 'new-key',
        protocol: 'openai-responses',
        models: ['new-model'],
      }]);

      for await (const _event of stream) {
        // Consume the response.
      }

      expect(requests).toEqual([
        expect.objectContaining({
          url: 'https://old.example/v1/responses',
          body: expect.objectContaining({ model: 'old-model' }),
        }),
      ]);
      await expect(router.call({ model: 'old/old-model', messages: [] }))
        .rejects.toThrow('Model "old/old-model" not found');
    } finally {
      globalThis.fetch = oldFetch;
    }

    const staleCatalogRouter = new AdapterRouter({
      providers: [
        { name: 'copilot', baseUrl: 'https://x/', apiKey: 'k', protocol: 'anthropic', models: ['claude-opus-4.7'] },
        { name: 'copilot', baseUrl: 'https://x/', apiKey: 'k', protocol: 'openai-responses', models: ['gpt-5.5'] },
      ],
    });

    expect(staleCatalogRouter.getProviderForModel('copilot/claude-opus-4.8')?.protocol).toBe('anthropic');

    }

    {
    const responsesCompletedBody = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}',
      '',
    ].join('\n');
    const fetchFn = vi.fn(async (url) => ({
      ok: true,
      body: String(url).endsWith('/responses')
        ? new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(responsesCompletedBody));
            controller.close();
          },
        })
        : { getReader: () => ({ read: async () => ({ done: true }), releaseLock: () => {} }) },
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      const r = new AdapterRouter({
        providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot' }],
      });

      const claude = r.stream({ model: 'github-copilot/claude-opus-4.8', messages: [] });
      for await (const _ of claude) {}
      expect(fetchFn.mock.calls[0][0]).toBe('https://api.githubcopilot.com/v1/messages');
      expect(JSON.parse(fetchFn.mock.calls[0][1].body).model).toBe('claude-opus-4.8');

      fetchFn.mockClear();
      const gpt = r.stream({ model: 'github-copilot/gpt-5', messages: [] });
      for await (const _ of gpt) {}
      expect(fetchFn.mock.calls[0][0]).toBe('https://api.githubcopilot.com/responses');
      expect(JSON.parse(fetchFn.mock.calls[0][1].body).model).toBe('gpt-5');
    } finally {
      globalThis.fetch = originalFetch;
    }

    }
  });

  it("rejects removed refs and routes bare Claude refs safely", async () => {
    {
    const fetchFn = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      const r = new AdapterRouter({
        providers: [{
          name: 'github-copilot',
          credentialProvider: 'github-copilot',
          models: ['gpt-new'],
        }],
      });
      await expect(async () => {
        const gen = r.stream({ model: 'github-copilot/gpt-old', messages: [] });
        await gen.next();
      }).rejects.toThrow(/not listed under provider/);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }

    }

    {
    const fetchFn = vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), releaseLock: () => {} }) } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      const r = new AdapterRouter({
        providers: [{
          name: 'github-copilot',
          baseUrl: 'https://api.githubcopilot.com',
          credentialProvider: 'github-copilot',
          protocol: 'openai-responses',
          models: ['claude-opus-4.8', 'gpt-5'],
        }],
      });
      const gen = r.stream({ model: 'github-copilot/claude-opus-4.8', messages: [] });
      for await (const _ of gen) {}
      expect(fetchFn.mock.calls[0][0]).toBe('https://api.githubcopilot.com/v1/messages');
      expect(JSON.parse(fetchFn.mock.calls[0][1].body).model).toBe('claude-opus-4.8');
    } finally {
      globalThis.fetch = originalFetch;
    }

    }
  });

  it("resolves stale and mixed-protocol provider entries", async () => {
    {
    const fetchFn = vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), releaseLock: () => {} }) } }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      const r = new AdapterRouter({
        providers: [
          {
            name: 'copilot',
            baseUrl: 'https://x',
            apiKey: 'k',
            protocol: 'openai-responses',
            models: [{ id: 'claude-opus-4.7', protocol: 'anthropic' }, 'gpt-5'],
          },
        ],
      });

      const provider = r.getProviderForModel('copilot/claude-opus-4.8');
      expect(provider?.name).toBe('copilot');
      expect(provider?.protocol).toBe('openai-responses');

      const gen = r.stream({ model: 'copilot/claude-opus-4.8', messages: [] });
      await gen.next();
      expect(fetchFn.mock.calls[0][0]).toBe('https://x/v1/messages');
      expect(JSON.parse(fetchFn.mock.calls[0][1].body).model).toBe('claude-opus-4.8');
    } finally {
      globalThis.fetch = originalFetch;
    }

    }

    {
    const legacyRouter = new AdapterRouter({
      providers: [
        { name: 'p1', baseUrl: 'https://x/', apiKey: 'k', protocol: 'openai-responses', models: ['gpt-5'] },
      ],
    });
    expect(legacyRouter.getProviderForModel('gpt-5')?.name).toBe('p1');
    expect(legacyRouter.listAvailableModels()).toEqual([{ modelId: 'gpt-5', providerName: 'p1' }]);

    const inferredRouter = new AdapterRouter({
      providers: [
        {
          name: 'github-copilot',
          baseUrl: 'https://api.githubcopilot.com',
          apiKey: 'k',
          // No provider-level protocol — fully delegated to the heuristic.
          models: ['gpt-5', 'claude-sonnet-4-20250514'],
        },
      ],
    });
    // Both should resolve to the same provider but two different adapters.
    expect(inferredRouter.getProviderForModel('gpt-5')?.name).toBe('github-copilot');
    expect(inferredRouter.getProviderForModel('claude-sonnet-4-20250514')?.name).toBe('github-copilot');

    }
  });

  it("honors valid routes and rejects invalid provider references", async () => {
    {
    const overrideRouter = new AdapterRouter({
      providers: [
        {
          name: 'proxy',
          baseUrl: 'https://x/',
          apiKey: 'k',
          // No provider-level protocol; per-model says "anthropic" even though
          // id wouldn't infer it.
          models: [{ id: 'weird-claude-alias', protocol: 'anthropic' }],
        },
      ],
    });
    // The lookup succeeds and the provider object is returned.
    expect(overrideRouter.getProviderForModel('weird-claude-alias')?.name).toBe('proxy');

    const invalidRouter = new AdapterRouter({
      providers: [
        // Provider declares openai-responses but offers a claude-* model with
        // no per-model override — should refuse rather than silently mis-route.
        { name: 'bad', baseUrl: 'https://x/', apiKey: 'k', protocol: 'openai-responses',
          models: [{ id: 'claude-sonnet-4', protocol: 'openai-responses' }] },
      ],
    });
    await expect(async () => {
      // Trigger #resolveAdapter via the public stream path with a minimal params.
      const gen = invalidRouter.stream({ model: 'claude-sonnet-4', messages: [] });
      await gen.next();
    }).rejects.toThrow(/Claude models require protocol="anthropic"/);

    }

    {
    const r = new AdapterRouter({ providers: [] });
    await expect(async () => {
      const gen = r.stream({ model: 'nope', messages: [] });
      await gen.next();
    }).rejects.toThrow(/not found in any provider/);

    }
  });
});
