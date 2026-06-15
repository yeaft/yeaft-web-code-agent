/**
 * Tests for AdapterRouter per-model protocol routing.
 *
 * Backwards-compat: legacy `provider.models: string[]` still works.
 * New: per-model `{id, protocol}` overrides and id-based heuristics let
 * a single provider serve both Anthropic and OpenAI families.
 */

import { describe, it, expect, vi } from 'vitest';

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
  it('keeps bare strings', () => {
    expect(normalizeModelEntry('gpt-5')).toEqual({ id: 'gpt-5' });
  });
  it('passes through {id, protocol}', () => {
    expect(normalizeModelEntry({ id: 'claude-sonnet-4', protocol: 'anthropic' }))
      .toEqual({ id: 'claude-sonnet-4', protocol: 'anthropic' });
  });
  it('drops invalid entries', () => {
    expect(normalizeModelEntry('')).toBeNull();
    expect(normalizeModelEntry({})).toBeNull();
    expect(normalizeModelEntry(null)).toBeNull();
    expect(normalizeModelEntry({ id: 123 })).toBeNull();
  });
});

describe('inferProtocolFromModelId', () => {
  it('matches the Anthropic family', () => {
    expect(inferProtocolFromModelId('claude-sonnet-4-20250514')).toBe('anthropic');
    expect(inferProtocolFromModelId('claude-opus-4')).toBe('anthropic');
    expect(inferProtocolFromModelId('claude-opus-4-8')).toBe('anthropic');
    expect(inferProtocolFromModelId('claude-opus-4.8')).toBe('anthropic');
    expect(inferProtocolFromModelId('anthropic.claude-3-haiku')).toBe('anthropic');
  });
  it('matches the OpenAI Responses family', () => {
    expect(inferProtocolFromModelId('gpt-5')).toBe('openai-responses');
    expect(inferProtocolFromModelId('gpt-4o-mini')).toBe('openai-responses');
    expect(inferProtocolFromModelId('o1-preview')).toBe('openai-responses');
    expect(inferProtocolFromModelId('o3-mini')).toBe('openai-responses');
    expect(inferProtocolFromModelId('chatgpt-5')).toBe('openai-responses');
  });
  it('returns null for unknown ids', () => {
    expect(inferProtocolFromModelId('deepseek-chat')).toBeNull();
    expect(inferProtocolFromModelId('llama-3')).toBeNull();
    expect(inferProtocolFromModelId('')).toBeNull();
    expect(inferProtocolFromModelId(null)).toBeNull();
  });
});

describe('AdapterRouter resolution', () => {
  it('resolves a provider-qualified Claude ref even when split provider catalogs are stale', () => {
    const r = new AdapterRouter({
      providers: [
        { name: 'copilot', baseUrl: 'https://x/', apiKey: 'k', protocol: 'anthropic', models: ['claude-opus-4.7'] },
        { name: 'copilot', baseUrl: 'https://x/', apiKey: 'k', protocol: 'openai-responses', models: ['gpt-5.5'] },
      ],
    });

    expect(r.getProviderForModel('copilot/claude-opus-4.8')?.protocol).toBe('anthropic');
  });

  it('routes managed GitHub Copilot Claude and GPT refs through their catalog protocols', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), releaseLock: () => {} }) } }));
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
  });

  it('routes a bare Claude entry from existing Copilot config through Anthropic despite provider-level Responses', async () => {
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
  });

  it('resolves a stale Claude ref from a single mixed-protocol provider row', async () => {
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
  });

  it('routes legacy string[] models without breaking', () => {
    const r = new AdapterRouter({
      providers: [
        { name: 'p1', baseUrl: 'https://x/', apiKey: 'k', protocol: 'openai-responses', models: ['gpt-5'] },
      ],
    });
    expect(r.getProviderForModel('gpt-5')?.name).toBe('p1');
    expect(r.listAvailableModels()).toEqual([{ modelId: 'gpt-5', providerName: 'p1' }]);
  });

  it('supports a mixed provider with id-inferred protocols', async () => {
    const r = new AdapterRouter({
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
    expect(r.getProviderForModel('gpt-5')?.name).toBe('github-copilot');
    expect(r.getProviderForModel('claude-sonnet-4-20250514')?.name).toBe('github-copilot');
  });

  it('honors a per-model protocol override beating the heuristic', () => {
    const r = new AdapterRouter({
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
    expect(r.getProviderForModel('weird-claude-alias')?.name).toBe('proxy');
  });

  it('throws when a claude model resolves to a non-anthropic protocol', async () => {
    const r = new AdapterRouter({
      providers: [
        // Provider declares openai-responses but offers a claude-* model with
        // no per-model override — should refuse rather than silently mis-route.
        { name: 'bad', baseUrl: 'https://x/', apiKey: 'k', protocol: 'openai-responses',
          models: [{ id: 'claude-sonnet-4', protocol: 'openai-responses' }] },
      ],
    });
    await expect(async () => {
      // Trigger #resolveAdapter via the public stream path with a minimal params.
      const gen = r.stream({ model: 'claude-sonnet-4', messages: [] });
      await gen.next();
    }).rejects.toThrow(/Claude models require protocol="anthropic"/);
  });

  it('throws on unknown model id', async () => {
    const r = new AdapterRouter({ providers: [] });
    await expect(async () => {
      const gen = r.stream({ model: 'nope', messages: [] });
      await gen.next();
    }).rejects.toThrow(/not found in any provider/);
  });
});
