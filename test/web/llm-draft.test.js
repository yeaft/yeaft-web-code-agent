// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LlmTab from '../../web/components/LlmTab.js';
import ProviderPresetPicker from '../../web/components/ProviderPresetPicker.js';
import { GEMINI_BASE_URL as AGENT_GEMINI_BASE_URL } from '../../agent/yeaft/llm/gemini-endpoint.js';
import en from '../../web/i18n/en.js';

globalThis.Vue = Vue;
const auth = Vue.reactive({ isAuthenticated: false });
globalThis.Pinia = { defineStore: () => () => auth };
const { default: ChatInput } = await import('../../web/components/ChatInput.js');
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
async function editName(value = 'unfinished provider') {
  await wrapper.find('.llm-provider-card input[type="text"]').setValue(value);
}
const pendingRequest = store => store.sendWsMessage.mock.calls.at(-1)[0];

describe('Agent LLM editing draft ownership', () => {
  it('preserves all unsaved fields and raw model text through delayed reads, errors and external saves without auto-saving', async () => {
    const store = await setup();
    expect(wrapper.find('.llm-hero-copy > p:not(.llm-kicker), .llm-protocol-hint, .llm-model-hint').exists()).toBe(false);
    expect(wrapper.get('.llm-models-hint').text()).toBe(en['settings.llm.modelsHint']);
    expect(wrapper.text()).toContain(en['settings.llm.debugDesc']);
    const fields = wrapper.findAll('.llm-provider-card input');
    await fields[0].setValue('half written');
    await fields[1].setValue('https://new.example.test/part');
    await fields[2].setValue('fixture-new-key-part');
    await wrapper.find('textarea').setValue('model-a,\nnew-model, ');
    wrapper.vm.localPrimaryModel = 'half written/new-model';
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.find('.llm-eye-btn').trigger('click');
    await wrapper.find('.llm-add-btn').trigger('click');
    const draft = JSON.stringify({ providers: wrapper.vm.localProviders, text: wrapper.vm.providerModelsText });
    await vi.advanceTimersByTimeAsync(16000);
    for (const response of [config('late-read'), { loaded: true, error: 'offline' }, config('external-save')]) {
      store.llmConfig['agent-a'] = response;
      await Vue.nextTick();
      expect(JSON.stringify({ providers: wrapper.vm.localProviders, text: wrapper.vm.providerModelsText })).toBe(draft);
      expect(wrapper.vm.localPrimaryModel).toBe('half written/new-model');
      expect(wrapper.vm.localDebug).toBe(true);
      expect(wrapper.vm.showApiKey[0]).toBe(true);
      expect(wrapper.find('textarea').element.value).toBe('model-a,\nnew-model, ');
      expect(saveButton().attributes('disabled')).toBeUndefined();
    }
    expect(store.sendWsMessage.mock.calls.map(([request]) => request.type)).toEqual(['get_llm_config']);
    expect(wrapper.vm.loadError).toBeNull();
  });

  it('adopts an exact successful save acknowledgement only when the submitted draft is unchanged', async () => {
    const store = await setup();
    await editName(' normalized ');
    await saveButton().trigger('click');
    const request = pendingRequest(store);
    expect(request.config.providers[0].name).toBe('normalized');
    store.llmConfig['agent-a'] = config(request.requestId, { providers: request.config.providers });
    await Vue.nextTick();
    expect(wrapper.vm.localProviders[0].name).toBe('normalized');
    expect(wrapper.vm.isDirty).toBe(false);
    expect(wrapper.vm.saving).toBe(false);
    expect(saveButton().attributes('disabled')).toBeDefined();
    expect(wrapper.emitted('saved')).toHaveLength(1);
    const model = { id: 'claude-legacy', thinkingProtocol: 'anthropic', maxBudgetTokens: 6000,
      supportsEffort: false, effortOptions: ['low'] };
    store.llmConfig['agent-a'] = config('managed-refresh', { providers: [{ name: 'github-copilot', managed: 'github-copilot', models: [model] }] });
    await Vue.nextTick();
    wrapper.vm.applyDiscoveredProvider({ provider: { name: 'github-copilot' }, providerModels: [{ id: 'claude-legacy', protocol: 'anthropic' }] });
    await Vue.nextTick();
    await saveButton().trigger('click');
    expect(pendingRequest(store).config.providers[0].models[0]).toMatchObject(model);
  });

  it('keeps edits made during saving dirty and open, and saves them on the next explicit click', async () => {
    const store = await setup();
    await editName('submitted');
    await saveButton().trigger('click');
    const first = pendingRequest(store);
    await editName('newer unfinished draft');
    store.llmConfig['agent-a'] = config(first.requestId, { providers: first.config.providers });
    await Vue.nextTick();
    expect(wrapper.vm.localProviders[0].name).toBe('newer unfinished draft');
    expect(wrapper.vm.isDirty).toBe(true);
    expect(wrapper.vm.saving).toBe(false);
    expect(wrapper.emitted('saved')).toBeUndefined();
    await saveButton().trigger('click');
    const second = pendingRequest(store);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.config.providers[0].name).toBe('newer unfinished draft');
    store.llmConfig['agent-a'] = config(second.requestId, { providers: second.config.providers });
    await Vue.nextTick();
    expect(wrapper.vm.isDirty).toBe(false);
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });

  it('ignores unrelated responses while saving and retains the draft on a matching failure or refresh warning', async () => {
    const store = await setup();
    await editName();
    await saveButton().trigger('click');
    const first = pendingRequest(store);
    store.llmConfig['agent-a'] = config('another-client');
    await Vue.nextTick();
    expect(wrapper.vm.saving).toBe(true);
    expect(wrapper.vm.localProviders[0].name).toBe('unfinished provider');
    store.llmConfig['agent-a'] = { loaded: true, requestId: first.requestId, error: 'save rejected' };
    await Vue.nextTick();
    expect(wrapper.vm.isDirty).toBe(true);
    expect(wrapper.vm.saving).toBe(false);
    expect(wrapper.vm.loadError).toBeNull();
    expect(wrapper.emitted('message').at(-1)).toEqual(['save rejected', true]);
    await saveButton().trigger('click');
    const second = pendingRequest(store);
    store.llmConfig['agent-a'] = { ...config(second.requestId, { providers: second.config.providers }), statusRefreshError: 'catalog offline' };
    await Vue.nextTick();
    expect(wrapper.vm.isDirty).toBe(false);
    expect(wrapper.vm.saveRefreshWarning).toBeTruthy();
    expect(wrapper.emitted('saved')[0][0].warning).toBeTruthy();
  });

  it('retains the unsaved draft after a save timeout and ignores late acknowledgements', async () => {
    const store = await setup();
    await editName();
    await saveButton().trigger('click');
    const first = pendingRequest(store);
    await vi.advanceTimersByTimeAsync(10001);
    expect(wrapper.vm.saving).toBe(false);
    expect(wrapper.vm.isDirty).toBe(true);
    store.llmConfig['agent-a'] = config(first.requestId);
    await Vue.nextTick();
    expect(wrapper.vm.localProviders[0].name).toBe('unfinished provider');
    expect(wrapper.vm.isDirty).toBe(true);
    expect(wrapper.emitted('saved')).toBeUndefined();
  });

  it('fences drafts and pending saves across Agent switches and unmounts', async () => {
    const store = await setup();
    await editName();
    await saveButton().trigger('click');
    const request = pendingRequest(store);
    await wrapper.setProps({ agentId: 'agent-b' });
    expect(wrapper.vm.localProviders).toEqual([]);
    expect(wrapper.vm.isDirty).toBe(false);
    store.llmConfig['agent-a'] = config(request.requestId);
    store.llmConfig['agent-b'] = config('agent-b-read', { debug: true });
    await Vue.nextTick();
    expect(wrapper.vm.localDebug).toBe(true);
    expect(wrapper.vm.localProviders[0].name).toBe('test');
    expect(wrapper.emitted('saved')).toBeUndefined();
    await editName('agent-b draft');
    await saveButton().trigger('click');
    const messageCount = wrapper.emitted('message')?.length || 0;
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(16000);
    expect(wrapper.emitted('message')?.length || 0).toBe(messageCount);
  });

  it('still loads initial and clean refreshes and recovers from load failures', async () => {
    const store = await setup();
    store.llmConfig['agent-a'] = { loaded: true, error: 'load failed' };
    await Vue.nextTick();
    expect(wrapper.text()).toContain('load failed');
    store.llmConfig['agent-a'] = config('refresh', { debug: true, primaryModel: 'test/model-b' });
    await Vue.nextTick();
    expect(wrapper.vm.loadError).toBeNull();
    expect(wrapper.vm.localPrimaryModel).toBe('test/model-b');
    expect(wrapper.vm.localDebug).toBe(true);
    expect(wrapper.vm.isDirty).toBe(false);
  });

  it('reads config on real readiness edges, not routine Agent list replacement, elapsed time or config broadcasts', async () => {
    vi.useFakeTimers();
    const store = Vue.reactive({ currentAgent: 'agent-a', connectionState: 'connected',
      authenticated: true, _hasHandledAgentList: true,
      agents: [{ id: 'agent-a', online: true }], inputDrafts: {}, llmConfig: {}, sendWsMessage: vi.fn() });
    globalThis.Pinia = { useChatStore: () => store, useAuthStore: () => auth,
      useVpStore: () => ({ vpList: [] }) };
    const sendFn = vi.fn();
    wrapper = mount(ChatInput, { props: { quickSendEnabled: true, sendFn },
      global: { mocks: { $t: key => key }, stubs: { MessageComposer: { template: '<div />' } } } });
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    expect(store.sendWsMessage).toHaveBeenLastCalledWith({ type: 'get_llm_config', agentId: 'agent-a' });
    for (let i = 0; i < 10; i++) {
      store.agents = [{ id: 'agent-a', online: true, latency: i, status: 'ready' }, { id: 'other', online: i % 2 === 0 }];
      await Vue.nextTick();
    }
    await vi.advanceTimersByTimeAsync(60000);
    store.llmConfig['agent-a'] = config('changed');
    await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    store.connectionState = 'reconnecting'; store.authenticated = false; store._hasHandledAgentList = false;
    await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    store.connectionState = 'connected'; await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    store.authenticated = true; await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    store._hasHandledAgentList = true; await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(2);
    store.agents = [{ id: 'agent-a', online: false }]; await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(2);
    store.agents = [{ id: 'agent-a', online: true }]; await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(3);
    await wrapper.setProps({ quickSendEnabled: false });
    store.agents = [{ id: 'agent-b', online: true }]; store.currentAgent = 'agent-b';
    await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(3);
    await wrapper.setProps({ quickSendEnabled: true });
    expect(store.sendWsMessage).toHaveBeenCalledTimes(4);
    expect(store.sendWsMessage).toHaveBeenLastCalledWith({ type: 'get_llm_config', agentId: 'agent-b' });
    const blocked = { id: 'blocked', name: 'Unavailable shortcut', model: 'test/model-a', effort: 'high', available: false };
    store.llmConfig['agent-b'] = config('ready', { quickSends: [blocked, { id: 'next', name: 'Next', model: 'test/model-b' }] });
    wrapper.vm.inputText = 'Keep draft';
    wrapper.vm.inputFocused = true;
    await Vue.nextTick();
    expect(wrapper.vm.canQuickSend).toBe(true);
    expect(wrapper.findAll('.mobile-quick-send-button').map(button => button.element.disabled)).toEqual([true, false]);
    wrapper.vm.sendQuick(wrapper.vm.quickSends[0]);
    expect(sendFn).not.toHaveBeenCalled();
    expect(wrapper.vm.inputText).toBe('Keep draft');
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

  it('uses the Agent default in the Google preset and preserves beta on draft save', async () => {
    const emit = vi.fn();
    const beta = 'https://generativelanguage.googleapis.com/v1beta';
    ProviderPresetPicker.methods.confirm.call({ selectedProviderId: 'google',
      registry: { google: { api: beta } }, selectedModels: new Set(['gemini-2.5-pro']), $emit: emit });
    expect(emit).toHaveBeenCalledWith('pick', expect.objectContaining({ protocol: 'gemini', baseUrl: AGENT_GEMINI_BASE_URL }));

    const store = await setup();
    store.llmConfig['agent-a'] = config('gemini-read', { providers: [
      { name: 'beta', protocol: 'gemini', baseUrl: beta, models: ['gemini-2.5-pro'] },
      { name: 'stable', protocol: 'gemini', models: ['gemini-2.5-pro'] },
    ] });
    await Vue.nextTick();
    const vm = wrapper.vm;
    expect(vm.editableProviders.map(p => p.baseUrl)).toEqual([beta, AGENT_GEMINI_BASE_URL]);
    vm.editableProviders[1].baseUrl = '';
    vm.saveConfig();
    expect(pendingRequest(store)).toMatchObject({ type: 'update_llm_config', config: { providers: [
      { name: 'beta', baseUrl: beta }, { name: 'stable', baseUrl: AGENT_GEMINI_BASE_URL },
    ] } });
  });

  it('offers native protocol presets, refreshes the draft over catalog GET and preserves model metadata', async () => {
    const store = await setup();
    store.agents = [{ id: 'agent-a', online: true }];
    const vm = wrapper.vm;
    await Vue.nextTick();
    vm.addProvider();
    const idx = vm.editableProviders.length - 1;
    vm.editableProviders[idx].name = 'google';
    vm.editableProviders[idx].apiKey = 'fixture-gemini';
    vm.setProtocol(idx, 'gemini');
    await Vue.nextTick();
    expect(vm.editableProviders[idx].baseUrl).toBe('https://generativelanguage.googleapis.com/v1');
    expect(vm.editableProviders[idx].models).toEqual(['gemini-4-hydrogen', 'gemini-4-carbon']);
    expect(wrapper.text()).toContain(en['settings.llm.protocolGemini']);
    expect(wrapper.text()).toContain(en['settings.llm.testAndDiscover']);
    const pending = vm.refreshGeminiModels(idx);
    const request = pendingRequest(store);
    expect(request).toMatchObject({ type: 'discover_llm_models', providerType: 'gemini',
      apiKey: 'fixture-gemini', baseUrl: AGENT_GEMINI_BASE_URL });
    store.llmModelDiscovery = { 'agent-a': { requestId: request.requestId,
      providerModels: [{ id: 'gemini-2.5-pro', protocol: 'gemini', contextWindow: 1048576, maxOutput: 65536 }] } };
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(vm.editableProviders[idx].models[0]).toMatchObject({ protocol: 'gemini', contextWindow: 1048576 });
    expect(vm.modelDiscoveryWarning).toBe(en['settings.llm.testSuccess']);
    expect(vm.isDirty).toBe(true);
    expect(store.sendWsMessage.mock.calls.some(([msg]) => msg.type === 'update_llm_config')).toBe(false);
    vm.onPresetPick({ name: 'other', models: [{ id: 'gemini-2.5-pro', protocol: 'gemini' }], protocol: 'gemini' });
    expect(vm.providerModelsText.at(-1)).toBe('gemini-2.5-pro');
  });
});
