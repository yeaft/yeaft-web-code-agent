// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LlmTab from '../../web/components/LlmTab.js';
import en from '../../web/i18n/en.js';

globalThis.Vue = Vue;
const auth = Vue.reactive({ isAuthenticated: false });
globalThis.Pinia = { defineStore: () => () => auth };
let wrapper;
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); });

const config = (requestId = null, changes = {}) => ({
  loaded: true, requestId, agentConfig: {
    providers: [{ name: 'test', baseUrl: 'https://example.test', apiKey: 'fixture-key',
      protocol: 'openai-responses', models: ['model-a', 'model-b'] }],
    primaryModel: 'test/model-a', debug: false, ...changes,
  },
});
async function setup() {
  vi.useFakeTimers();
  const store = Vue.reactive({ currentAgent: 'agent-a', llmConfig: {}, sendWsMessage: vi.fn() });
  globalThis.Pinia = { useChatStore: () => store };
  wrapper = mount(LlmTab, { props: { agentId: 'agent-a', context: 'yeaft' },
    global: { mocks: { $t: key => en[key] || key } } });
  store.llmConfig['agent-a'] = config();
  await Vue.nextTick();
  return store;
}
const saveButton = () => wrapper.find('.llm-save-row button');

const pendingRequest = store => store.sendWsMessage.mock.calls.at(-1)[0];

describe('native Gemini settings', () => {
  it('retains manual model options through draft edits, rediscovery and save while refreshing catalog limits', async () => {
    const store = await setup();
    const id = 'gemini-2.5-flash';
    const geminiOptions = { serviceTier: 'flex', generationConfig: { stopSequences: ['END'] } };
    const saved = { id, protocol: 'anthropic', effortOptions: ['high'], supportsEffort: true,
      thinkingProtocol: 'anthropic', maxBudgetTokens: 6000, contextWindow: 2048, maxOutput: 512, geminiOptions };
    store.agents = [{ id: 'agent-a', online: true }];
    store.llmConfig['agent-a'] = config('gemini-read', { primaryModel: `google/${id}`, providers: [
      { name: 'google', protocol: 'gemini', baseUrl: 'https://gemini.invalid/v1', apiKey: 'fixture', models: [saved] },
    ] });
    await Vue.nextTick();
    const vm = wrapper.vm;
    expect(vm.editableProviders[0].models[0].geminiOptions).not.toBe(geminiOptions);
    await wrapper.find('textarea').setValue(`${id}, new-model`);
    expect(vm.editableProviders[0].models[0]).toEqual(saved);
    const pending = vm.refreshGeminiModels(0);
    store.llmModelDiscovery = { 'agent-a': { requestId: pendingRequest(store).requestId,
      providerModels: [{ id, protocol: 'gemini', supportsEffort: false, contextWindow: 65536, maxOutput: 8192 }] } };
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    await saveButton().trigger('click');
    expect(pendingRequest(store)).toMatchObject({ type: 'update_llm_config', config: { providers: [
      { name: 'google', models: [{ ...saved, contextWindow: 65536, maxOutput: 8192 }] },
    ] } });
  });

});
