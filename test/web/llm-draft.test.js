// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuickSendSettings from '../../web/components/QuickSendSettings.js';
import { buildModelSelectionRows, getSessionEffortDisplay } from '../../web/utils/modelRefs.js';
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

describe('Chat Completions effort choices', () => {
  const carbon = { id: 'gemini-4-carbon', provider: 'chat', protocol: 'openai-chat-completions', effortOptions: ['medium', 'high'] };
  const generic = { ...carbon, id: 'generic', effortOptions: ['medium', 'high', 'xhigh', 'max', 'ultra'] };
  const responses = { ...carbon, provider: 'responses', protocol: 'openai-responses', effortOptions: ['medium', 'xhigh', 'max', 'ultra'] };

  it('selects Carbon High by default and displays saved effort using the actual wire protocol', () => {
    const rows = buildModelSelectionRows([carbon, generic, responses]);
    expect(rows.map(row => [row.efforts, row.defaultEffort])).toEqual([
      [carbon.effortOptions, 'high'], [generic.effortOptions, 'xhigh'], [responses.effortOptions, 'xhigh'],
    ]);
    for (const effort of ['xhigh', 'max', 'ultra']) {
      expect(getSessionEffortDisplay({}, effort, carbon)).toBe('high');
      expect(getSessionEffortDisplay({}, effort, { ...carbon, effortOptions: ['medium'] })).toBe('medium');
    }
    expect(getSessionEffortDisplay({}, 'high', generic)).toBe('high');
    expect(getSessionEffortDisplay({}, 'high', responses)).toBe('xhigh');
  });

  it('loads, switches and saves Quick Send efforts against the provider-qualified model', async () => {
    const store = Vue.reactive({ agents: [{ id: 'a', online: true }], llmConfig: {}, ws: { readyState: 1 }, sendWsMessage: vi.fn() });
    globalThis.Pinia = { useChatStore: () => store };
    wrapper = mount(QuickSendSettings, { props: { agentId: 'a' }, global: { mocks: { $t: key => en[key] || key } } });
    store.llmConfig.a = config(pendingRequest(store).requestId, { availableModels: [responses, carbon, generic], quickSends: [
      { id: '1', name: 'Carbon', model: 'chat/gemini-4-carbon', effort: 'xhigh' },
      { id: '2', name: 'Legacy', model: 'responses/gemini-4-carbon', effort: 'high' },
    ] });
    await Vue.nextTick();
    const vm = wrapper.vm;
    expect(vm.draft.map(item => item.effort)).toEqual(['high', 'xhigh']);
    vm.changeModel(vm.draft[1], 'chat/gemini-4-carbon');
    expect(vm.effortsFor(vm.draft[1])).toEqual(['medium', 'high']);
    vm.save();
    expect(pendingRequest(store).config.quickSends.map(item => item.effort)).toEqual(['high', 'high']);
  });
});

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

  it('exposes Decision Model selection in Yeaft LLM settings and persists explicit or Auto (null) choice', async () => {
    const store = await setup();
    store.llmConfig['agent-a'] = config('decision-read', {
      primaryModel: 'test/model-a',
      decisionModel: 'test/model-b',
    });
    await Vue.nextTick();
    expect(wrapper.text()).toContain('Decision Model');
    expect(wrapper.vm.localDecisionModel).toBe('test/model-b');

    // Switch back to Auto (null) via dropdown and save
    wrapper.vm.localDecisionModel = null;
    wrapper.vm.markDirty();
    await Vue.nextTick();
    await saveButton().trigger('click');
    expect(pendingRequest(store)).toMatchObject({
      type: 'update_llm_config',
      config: {
        primaryModel: 'test/model-a',
        decisionModel: null,
      },
    });

    // Acknowledge the pending save and verify removing a provider clears localDecisionModel
    const saveReqId = pendingRequest(store).requestId;
    store.llmConfig['agent-a'] = config(saveReqId, {
      providers: [
        { name: 'p1', baseUrl: 'https://p1.test', apiKey: 'k1', protocol: 'openai-responses', models: ['m1'] },
        { name: 'p2', baseUrl: 'https://p2.test', apiKey: 'k2', protocol: 'openai-responses', models: ['m2'] },
      ],
      primaryModel: 'p1/m1',
      decisionModel: 'p2/m2',
    });
    await Vue.nextTick();
    expect(wrapper.vm.localDecisionModel).toBe('p2/m2');
    wrapper.vm.removeProvider(1);
    expect(wrapper.vm.localDecisionModel).toBeNull();
  });

  it('replaces OpenAI Compatible with Chat Completions and persists protocol openai-chat-completions explicitly', async () => {
    const store = await setup();
    store.llmConfig['agent-a'] = config('chat-comp-read', {
      providers: [
        { name: 'mixed-auto', baseUrl: 'https://mixed.test/v1', apiKey: 'k1', models: ['gpt-5'] },
        { name: 'legacy-openai', baseUrl: 'https://legacy.test/v1', apiKey: 'k2', protocol: 'openai', models: ['gemini-4-neon'] },
      ],
      primaryModel: 'legacy-openai/gemini-4-neon',
    });
    await Vue.nextTick();

    // Legacy 'openai' normalizes to 'openai-chat-completions'; unset stays '' (Auto)
    expect(wrapper.vm.editableProviders[0].protocol).toBe('');
    expect(wrapper.vm.editableProviders[1].protocol).toBe('openai-chat-completions');

    // Add Provider defaults to Chat Completions and never shows "OpenAI Compatible"
    wrapper.vm.addProvider();
    await Vue.nextTick();
    const newProvider = wrapper.vm.editableProviders[2];
    expect(newProvider.protocol).toBe('openai-chat-completions');
    expect(wrapper.text()).not.toContain('OpenAI Compatible');
    expect(wrapper.text()).toContain('Chat Completions');

    newProvider.name = 'copilot-chat';
    newProvider.baseUrl = 'https://copilot.test/v1';
    newProvider.models = ['gemini-4-neon'];
    wrapper.vm.markDirty();
    await Vue.nextTick();
    await saveButton().trigger('click');

    const saved = pendingRequest(store).config.providers;
    expect(saved[0].protocol).toBeUndefined();
    expect(saved[1].protocol).toBe('openai-chat-completions');
    expect(saved[2]).toMatchObject({
      name: 'copilot-chat',
      baseUrl: 'https://copilot.test/v1',
      protocol: 'openai-chat-completions',
      models: ['gemini-4-neon'],
    });
  });

});
