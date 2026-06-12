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
    llmGithubDevice: null,
  };
}

describe('web LLM config scope state', () => {
  it('stores global, agent, and effective config separately for an agent', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'llm_config',
      agentId: 'agent-a',
      globalConfig: { providers: [{ name: 'global', scope: 'global' }] },
      agentConfig: { providers: [{ name: 'local', scope: 'agent' }], primaryModel: 'local/m' },
      effectiveConfig: { providers: [{ name: 'global', scope: 'global' }, { name: 'local', scope: 'agent' }], primaryModel: 'local/m' },
    });

    expect(store.llmConfig['agent-a'].globalConfig.providers.map(p => p.name)).toEqual(['global']);
    expect(store.llmConfig['agent-a'].agentConfig.providers.map(p => p.name)).toEqual(['local']);
    expect(store.llmConfig['agent-a'].providers.map(p => p.name)).toEqual(['global', 'local']);
  });

  it('updates global config without overwriting agent-local config', () => {
    const store = makeStore();
    store.llmConfig['agent-a'] = {
      globalConfig: { providers: [{ name: 'old-global' }] },
      agentConfig: { providers: [{ name: 'local' }] },
      effectiveConfig: { providers: [] },
    };

    handleMessage(store, {
      type: 'llm_global_config_updated',
      globalConfig: { providers: [{ name: 'new-global' }] },
    });

    expect(store.llmConfig['agent-a'].globalConfig.providers.map(p => p.name)).toEqual(['new-global']);
    expect(store.llmConfig['agent-a'].agentConfig.providers.map(p => p.name)).toEqual(['local']);
  });

  it('recomputes effective providers for every loaded agent when global providers change', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'llm_config',
      agentId: 'agent-a',
      globalConfig: { providers: [{ name: 'old-global', models: ['old'] }] },
      agentConfig: { providers: [{ name: 'local-a', models: ['a'] }], primaryModel: 'local-a/a', language: 'zh' },
    });
    handleMessage(store, {
      type: 'llm_config',
      agentId: 'agent-b',
      globalConfig: { providers: [{ name: 'old-global', models: ['old'] }] },
      agentConfig: { providers: [{ name: 'local-b', models: ['b'] }], primaryModel: 'local-b/b' },
    });

    handleMessage(store, {
      type: 'llm_global_config_updated',
      globalConfig: { providers: [{ name: 'new-global', models: ['new'], credentialProvider: 'github-copilot' }] },
    });

    expect(store.llmConfig['agent-a'].effectiveConfig.providers.map(p => p.name)).toEqual(['new-global', 'local-a']);
    expect(store.llmConfig['agent-b'].effectiveConfig.providers.map(p => p.name)).toEqual(['new-global', 'local-b']);
    expect(store.llmConfig['agent-a'].providers.map(p => p.name)).toEqual(['new-global', 'local-a']);
    expect(store.llmConfig['agent-a'].agentConfig.providers.map(p => p.name)).toEqual(['local-a']);
    expect(store.llmConfig['agent-a'].primaryModel).toBe('local-a/a');
    expect(store.llmConfig['agent-a'].language).toBe('zh');
  });

  it('uses agent-merge conflict naming when global updates collide with local providers', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'llm_config',
      agentId: 'agent-a',
      globalConfig: { providers: [{ name: 'shared', models: ['global-old'] }] },
      agentConfig: { providers: [{ name: 'shared', models: ['local'] }] },
    });

    handleMessage(store, {
      type: 'llm_global_config_updated',
      globalConfig: { providers: [{ name: 'shared', models: ['global-new'] }] },
    });

    const providers = store.llmConfig['agent-a'].effectiveConfig.providers;
    expect(providers.map(p => p.name)).toEqual(['global:shared', 'shared']);
    expect(providers[0].scope).toBe('global');
    expect(providers[0].originalName).toBe('shared');
    expect(providers[1].scope).toBe('agent');
  });

  it('removes deleted global providers from effective config immediately', () => {
    const store = makeStore();
    handleMessage(store, {
      type: 'llm_config',
      agentId: 'agent-a',
      globalConfig: { providers: [{ name: 'global', models: ['g'] }] },
      agentConfig: { providers: [{ name: 'local', models: ['l'] }] },
    });

    handleMessage(store, {
      type: 'llm_global_config_updated',
      globalConfig: { providers: [] },
    });

    expect(store.llmConfig['agent-a'].effectiveConfig.providers.map(p => p.name)).toEqual(['local']);
    expect(store.llmConfig['agent-a'].providers.map(p => p.name)).toEqual(['local']);
  });

});
