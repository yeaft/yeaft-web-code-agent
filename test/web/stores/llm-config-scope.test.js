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
});
