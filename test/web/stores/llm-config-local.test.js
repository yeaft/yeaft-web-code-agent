import { describe, it, expect } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({ ...(options.state ? options.state() : {}), ...(options.actions || {}) });
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { handleMessage } = await import('../../../web/stores/helpers/messageHandler.js');

function makeStore() {
  return {
    _lastPongAt: 0,
    llmConfig: {},
    llmModelDiscovery: {},
  };
}

describe('web local LLM config state', () => {

  it('stores discovered model catalogs for the local agent config modal', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'llm_models_discovered',
      agentId: 'agent-a',
      requestId: 'req-1',
      providerType: 'github-copilot',
      provider: { name: 'github-copilot', credentialProvider: 'github-copilot' },
      models: ['claude-sonnet-4.5', 'gpt-5'],
      providerModels: [{ id: 'claude-sonnet-4.5', protocol: 'anthropic' }, 'gpt-5'],
      source: 'live',
    });

    expect(store.llmModelDiscovery['agent-a']).toMatchObject({
      requestId: 'req-1',
      source: 'live',
      models: ['claude-sonnet-4.5', 'gpt-5'],
    });
  });

  it('stores agent-local config as the effective config without global merge state', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'llm_config',
      agentId: 'agent-a',
      agentConfig: {
        providers: [{ name: 'local', baseUrl: 'http://local/v1', models: ['m'] }],
        primaryModel: 'local/m',
        fastModel: 'local/m',
        language: 'zh-CN',
      },
      effectiveConfig: {
        providers: [{ name: 'local', baseUrl: 'http://local/v1', models: ['m'] }],
        primaryModel: 'local/m',
        fastModel: 'local/m',
        language: 'zh-CN',
        needsSetup: false,
      }
    });

    expect(store.llmConfig['agent-a']).toMatchObject({
      providers: [{ name: 'local', baseUrl: 'http://local/v1', models: ['m'] }],
      primaryModel: 'local/m',
      fastModel: 'local/m',
      language: 'zh-CN',
      needsSetup: false,
      loaded: true,
      error: null,
    });
    expect(store.llmConfig['agent-a'].globalConfig).toBeUndefined();
  });

  it('falls back to top-level agent-local fields from older agent responses', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'llm_config_updated',
      agentId: 'agent-b',
      providers: [{ name: 'p', baseUrl: 'http://p/v1', models: ['m'] }],
      primaryModel: 'p/m',
      fastModel: 'p/m',
      language: 'en',
      needsSetup: false,
    });

    expect(store.llmConfig['agent-b'].agentConfig.providers.map(p => p.name)).toEqual(['p']);
    expect(store.llmConfig['agent-b'].effectiveConfig.providers.map(p => p.name)).toEqual(['p']);
  });
});
