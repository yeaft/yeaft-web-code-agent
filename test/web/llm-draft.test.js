// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LlmTab from '../../web/components/LlmTab.js';
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
      agents: [{ id: 'agent-a', online: true }], inputDrafts: {}, llmConfig: {}, sendWsMessage: vi.fn() });
    globalThis.Pinia = { useChatStore: () => store, useAuthStore: () => auth,
      useVpStore: () => ({ vpList: [] }) };
    wrapper = mount(ChatInput, { props: { quickSendEnabled: true, sendFn: vi.fn() },
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
    store.connectionState = 'reconnecting'; await Vue.nextTick();
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    store.connectionState = 'connected'; await Vue.nextTick();
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
  });
});
