// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import QuickSendSettings from '../../web/components/QuickSendSettings.js';
import AgentSettingsPanel from '../../web/components/AgentSettingsPanel.js';
import { en, zhCN } from '../../web/i18n/quick-send.js';

const models = [
  { id: 'gpt-5', ref: 'p/gpt-5', provider: 'p', maxOutput: 2048, effortOptions: ['low', 'high'] },
  { id: 'simple', ref: 'p/simple', provider: 'p', maxOutput: 1000, effortOptions: [] },
];
const entry = (id = 'fast') => ({ id, name: 'Fast', model: 'p/gpt-5', effort: null, maxOutputTokens: null });
let store; const wrappers = [];
const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, value), en[key] || key);
function render(component = QuickSendSettings, props = { agentId: 'a' }) {
  const wrapper = mount(component, { props, global: { mocks: { $t: t } } });
  wrappers.push(wrapper); return wrapper;
}
async function reply(wrapper, quickSends = [], options = {}) {
  const req = store.sendWsMessage.mock.calls.at(-1)[0];
  store.llmConfig[req.agentId] = { requestId: req.requestId, loaded: true, agentConfig: { quickSends, availableModels: models }, ...options };
  await Vue.nextTick(); return req;
}
beforeEach(() => {
  vi.useFakeTimers();
  globalThis.Vue = Vue;
  store = Vue.reactive({ ws: { readyState: 1 }, agents: [{ id: 'a', online: true }, { id: 'b', online: true }],
    llmConfig: {}, sendWsMessage: vi.fn(), loadTelemetrySettings: vi.fn().mockResolvedValue({}) });
  globalThis.Pinia = { useChatStore: () => store };
});
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Quick-send Agent settings', () => {
  it('loads only the chosen Agent, defaults empty and adds no samples', async () => {
    const wrapper = render();
    expect(wrapper.vm.loading).toBe(true);
    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'get_llm_config', agentId: 'a', requestId: expect.any(String) }));
    await reply(wrapper);
    expect(wrapper.findAll('fieldset')).toHaveLength(0);
    expect(wrapper.text()).toContain(en['quickSend.empty']);
    expect(wrapper.vm.models).toHaveLength(2);
    expect(wrapper.vm.dirty).toBe(false);
  });
  it('adds/edits/deletes at most five and saves only quickSends with exact acknowledgement', async () => {
    const wrapper = render(); await reply(wrapper);
    for (let i = 0; i < 6; i++) wrapper.vm.add();
    expect(wrapper.vm.draft).toHaveLength(5);
    expect(wrapper.vm.draft[0].name).toBe('');
    while (wrapper.vm.draft.length > 1) wrapper.vm.remove(1);
    await Vue.nextTick();
    await wrapper.get('input[maxlength]').setValue(' Fast ');
    wrapper.vm.changeModel(wrapper.vm.draft[0], 'p/gpt-5');
    wrapper.vm.draft[0].effort = 'high';
    wrapper.vm.setMaxOutput(wrapper.vm.draft[0], '2048');
    wrapper.vm.save();
    const request = store.sendWsMessage.mock.calls.at(-1)[0];
    expect(request).toMatchObject({ type: 'update_llm_config', agentId: 'a', config: { quickSends: [expect.objectContaining({ name: 'Fast', effort: 'high', maxOutputTokens: 2048 })] } });
    expect(Object.keys(request.config)).toEqual(['quickSends']);
    expect(wrapper.vm.saving).toBe(true);
    store.llmConfig.a = { requestId: 'other-save', agentConfig: { quickSends: [] } }; await Vue.nextTick();
    expect(wrapper.vm.saving).toBe(true);
    await reply(wrapper, request.config.quickSends);
    expect(wrapper.vm.dirty).toBe(false);
    expect(wrapper.emitted('saved')).toEqual([['a']]);
    wrapper.vm.remove(0); wrapper.vm.save();
    expect(store.sendWsMessage.mock.calls.at(-1)[0].config.quickSends).toEqual([]);
  });
  it('validates inputs and clears incompatible effort when model changes', async () => {
    const wrapper = render(); await reply(wrapper, [entry()]);
    wrapper.vm.draft[0].effort = 'high';
    wrapper.vm.changeModel(wrapper.vm.draft[0], 'p/simple');
    expect(wrapper.vm.draft[0].effort).toBeNull();
    wrapper.vm.setMaxOutput(wrapper.vm.draft[0], '1001'); wrapper.vm.save();
    expect(wrapper.vm.error).toContain('1000');
    expect(store.sendWsMessage).toHaveBeenCalledTimes(1);
    wrapper.vm.setMaxOutput(wrapper.vm.draft[0], '');
    expect(wrapper.vm.validate()).toBe('');
    wrapper.vm.draft[0].model = 'missing'; expect(wrapper.vm.validate()).toBe(en['quickSend.modelRequired']);
  });
  it('fences A→B→A loads and delayed saves by generation and request id', async () => {
    const wrapper = render();
    const oldLoad = store.sendWsMessage.mock.calls.at(-1)[0];
    await wrapper.setProps({ agentId: 'b' });
    await reply(wrapper, [entry('b')]);
    expect(wrapper.vm.draft[0].id).toBe('b');
    await wrapper.setProps({ agentId: 'a' });
    store.llmConfig.a = { requestId: oldLoad.requestId, agentConfig: { quickSends: [entry('stale')] } }; await Vue.nextTick();
    expect(wrapper.vm.draft).toEqual([]); expect(wrapper.vm.loading).toBe(true);
    await reply(wrapper, [entry('a')]);
    wrapper.vm.changed(); wrapper.vm.save();
    const oldSave = store.sendWsMessage.mock.calls.at(-1)[0];
    await wrapper.setProps({ agentId: 'b' }); await reply(wrapper, [entry('new-b')]);
    store.llmConfig.a = { requestId: oldSave.requestId, agentConfig: { quickSends: [entry('old-a')] } }; await Vue.nextTick();
    expect(wrapper.vm.draft[0].id).toBe('new-b');
    expect(wrapper.emitted('saved')).toBeUndefined();
  });
  it('disables offline mutation, retries on reconnect, keeps dirty edits and reports timeout/error', async () => {
    store.agents[0].online = false;
    const wrapper = render(); expect(store.sendWsMessage).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain(en['quickSend.offline']);
    wrapper.vm.add(); expect(wrapper.vm.draft).toEqual([]);
    store.agents[0].online = true; await Vue.nextTick();
    await reply(wrapper, [entry()]);
    wrapper.vm.draft[0].name = 'Edited'; wrapper.vm.changed();
    store.ws.readyState = 3; await Vue.nextTick();
    expect(wrapper.vm.disabled).toBe(true);
    store.ws.readyState = 1; await Vue.nextTick(); await reply(wrapper, [entry()]);
    expect(wrapper.vm.draft[0].name).toBe('Edited');
    wrapper.vm.save(); await reply(wrapper, [], { error: 'Write failed' });
    expect(wrapper.vm.error).toBe('Write failed'); expect(wrapper.vm.dirty).toBe(true);
    wrapper.vm.save(); await vi.advanceTimersByTimeAsync(15001);
    expect(wrapper.vm.saving).toBe(false); expect(wrapper.vm.error).toBe(en['quickSend.saveFailed']);
  });
  it('exposes an Agent category and bilingual strings without a shortcut field', async () => {
    const wrapper = render(AgentSettingsPanel, { initialAgentId: 'b', initialCategory: 'quick-send' });
    expect(wrapper.findComponent(QuickSendSettings).props('agentId')).toBe('b');
    expect(wrapper.findAll('.agent-settings-nav-item').at(-1).text()).toBe(en['quickSend.title']);
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(QuickSendSettings.template).not.toMatch(/shortcut|hotkey/i);
  });
});
