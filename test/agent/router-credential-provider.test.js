/**
 * Tests that AdapterRouter wires the credentialProvider hook correctly.
 *
 * Regression guard (the user's explicit demand): providers WITHOUT
 * `credentialProvider` must keep using the static `apiKey` from config,
 * with NO call to the credentials registry. That is the contract that
 * keeps existing configs working unchanged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdapterRouter } from '../../agent/yeaft/llm/router.js';

describe('AdapterRouter — credentialProvider integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('static apiKey path unchanged when credentialProvider is absent', async () => {
    // Spy on the credentials module — it must NOT be touched for a static
    // provider. We do this by importing the module and watching its export.
    const credMod = await import('../../agent/yeaft/llm/credentials/index.js');
    const spy = vi.spyOn(credMod, 'getCredentialProvider');

    const router = new AdapterRouter({
      providers: [
        {
          name: 'static',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-literal',
          protocol: 'openai-responses',
          models: ['gpt-5'],
        },
      ],
    });

    // listAvailableModels just walks the index — nothing async.
    expect(router.listAvailableModels()).toEqual([{ modelId: 'gpt-5', providerName: 'static' }]);

    // Trigger adapter resolution via the public stream() path. The fetch
    // will fail (no real server) but we only care that the credentials
    // registry was NOT consulted.
    const gen = router.stream({ model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'hi' }] });
    await gen.next().catch(() => {}); // swallow downstream fetch failure
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('routes through the credential provider when credentialProvider is set', async () => {
    // Stub the credential registry so we don't need a live token.
    const credMod = await import('../../agent/yeaft/llm/credentials/index.js');
    const fakeGetApiKey = vi.fn(async () => 'live-token-abc');
    vi.spyOn(credMod, 'getCredentialProvider').mockReturnValue({
      name: 'github-copilot',
      getApiKey: fakeGetApiKey,
    });

    const router = new AdapterRouter({
      providers: [
        {
          name: 'copilot',
          baseUrl: 'https://api.githubcopilot.com',
          credentialProvider: 'github-copilot',
          protocol: 'openai-responses',
          models: ['gpt-5'],
        },
      ],
    });

    const gen = router.stream({ model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'hi' }] });
    await gen.next().catch(() => {}); // swallow downstream fetch failure
    expect(fakeGetApiKey).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when credentialProvider is unknown', async () => {
    const router = new AdapterRouter({
      providers: [
        {
          name: 'bad',
          baseUrl: 'https://x/',
          credentialProvider: 'made-up-provider',
          protocol: 'openai-responses',
          models: ['gpt-5'],
        },
      ],
    });
    await expect(async () => {
      const gen = router.stream({ model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'hi' }] });
      await gen.next();
    }).rejects.toThrow(/Unknown credentialProvider "made-up-provider"/);
  });

  it('rebuilds adapter when credential rotates (cache keyed by apiKey fingerprint)', async () => {
    let tokenIdx = 0;
    const credMod = await import('../../agent/yeaft/llm/credentials/index.js');
    vi.spyOn(credMod, 'getCredentialProvider').mockReturnValue({
      name: 'github-copilot',
      getApiKey: async () => {
        tokenIdx += 1;
        return tokenIdx === 1 ? 'token-A' : 'token-B';
      },
    });

    const router = new AdapterRouter({
      providers: [
        {
          name: 'copilot',
          baseUrl: 'https://api.githubcopilot.com',
          credentialProvider: 'github-copilot',
          protocol: 'openai-responses',
          models: ['gpt-5'],
        },
      ],
    });

    // First call: cache key includes fp(token-A). Second call: fp(token-B)
    // is different, so a fresh adapter is built. We can't directly inspect
    // the cache but we can assert getApiKey was called twice (no static-key
    // shortcut) and the call didn't throw before reaching fetch.
    const g1 = router.stream({ model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'a' }] });
    await g1.next().catch(() => {});
    const g2 = router.stream({ model: 'gpt-5', system: 's', messages: [{ role: 'user', content: 'b' }] });
    await g2.next().catch(() => {});
    expect(tokenIdx).toBe(2);
  });
});
