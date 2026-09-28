// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';

vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => ({ userId: 'owner', authGeneration: 1 }) }));
let wrapper;
let chat;
let configured;
let requests;
const t = key => en[key] || key;
beforeEach(() => {
  configured = true;
  requests = [];
  chat = Vue.reactive({
    currentAgent: 'a', connectionState: 'connected', authenticated: true, theme: 'light',
    agents: [{ id: 'a', online: true, capabilities: ['digital_person'] }],
    leaveDigitalPerson: vi.fn(), leaveWorkCenter: vi.fn(), closePluginCenter: vi.fn(), toggleTheme: vi.fn(),
    enterYeaft: vi.fn(() => { chat.currentView = 'yeaft'; chat.currentAgent = 'previous-session-agent'; }), openPluginCenter: vi.fn(),
    sendWsMessage(request) {
      requests.push(request);
      const data = {
        status: { configured, reason: 'MongoDB not configured' }, open: {},
        snapshot: { person: { id: 'p', name: 'Ada' }, state: { version: 4 }, messages: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], busy: false },
        messages: { items: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], nextCursor: null }, traces: { items: [{ id: 't', kind: 'recall', episodeId: 'e', createdAt: 1, input: 'hi', output: 'recorded', model: 'test/model', stateAfterRef: 'v4' }], nextCursor: 'older' },
        think: { episodeId: 'e' },
      };
      queueMicrotask(() => acceptPersonResponse(chat, { ...request, type: 'person_response', ok: true, data: data[request.op] }));
      return true;
    },
  });
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('Pinia', { useChatStore: () => chat });
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });
async function render() {
  wrapper = mount(DigitalPersonPage, { attachTo: document.body, global: { provide: { t }, config: { globalProperties: { $t: t } } } });
  await flushPromises();
}

describe('Digital Person surface', () => {
  it('is Session-list free, renders untrusted text safely and exposes recorded Trace', async () => {
    await render();
    expect(wrapper.find('.session-sidebar-shell').exists()).toBe(false);
    expect(wrapper.get('.person-message-text').text()).toBe('<img onerror=alert(1)>');
    expect(wrapper.find('.person-message img').exists()).toBe(false);
    expect(wrapper.get('#person-input').attributes('disabled')).toBeUndefined();
    await wrapper.get('[aria-controls="person-trace"]').trigger('click');
    expect(wrapper.get('#person-trace').text()).toContain('not a provider’s hidden chain of thought');
    expect(wrapper.get('#person-trace').text()).toContain('stateAfterRef');
    expect(wrapper.get('#person-trace').text()).toContain('test/model');
    expect(document.activeElement).toBe(wrapper.get('.person-navigation button').element);
  });

  it('exposes explicit Think even with no topic; blocks repeated command while busy', async () => {
    await render();
    const think = wrapper.findAll('button').find(button => button.text() === 'Think');
    expect(think.attributes('disabled')).toBeUndefined();
    await think.trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'think').payload).toMatchObject({ text: '', clientMessageId: expect.any(String) });
    expect(wrapper.get('#person-input').attributes('disabled')).toBeDefined();
    expect(think.attributes('disabled')).toBeDefined();
  });

  it('waits for the complete reconnect auth handshake before opening and never resends commands', async () => {
    await render();
    chat.authenticated = false;
    chat.connectionState = 'reconnecting';
    await Vue.nextTick();
    expect(wrapper.get('#person-input').attributes('disabled')).toBeDefined();
    const before = requests.length;
    chat.serverEncryptionRequired = true;
    chat.connectionState = 'connected';
    chat.authenticated = true;
    expect(requests).toHaveLength(before);
    chat.serverEncryptionRequired = false;
    await flushPromises();
    expect(requests.slice(before).map(r => r.op)).toEqual(['status', 'open', 'snapshot', 'messages', 'traces']);
    expect(wrapper.get('#person-input').attributes('disabled')).toBeUndefined();
  });

  it('preserves unsent drafts across reconnect/offline but clears them when changing Agent', async () => {
    await render();
    await wrapper.get('#person-input').setValue('unfinished long thought');
    chat.connectionState = 'reconnecting'; await Vue.nextTick();
    expect(wrapper.get('#person-input').element.value).toBe('unfinished long thought');
    chat.connectionState = 'connected'; await flushPromises();
    chat.agents[0].online = false; await Vue.nextTick();
    expect(wrapper.get('#person-input').element.value).toBe('unfinished long thought');
    chat.agents.push({ id: 'b', online: true, capabilities: ['digital_person'] });
    await Vue.nextTick();
    await wrapper.get('#person-agent').setValue('b'); await flushPromises();
    expect(wrapper.get('#person-input').element.value).toBe('');
  });

  it('uses the established Chat-to-Yeaft transition before opening Plugins for the selected Agent', async () => {
    chat.currentView = 'chat';
    await render();
    await wrapper.findAll('button').find(b => b.text() === t('person.plugins')).trigger('click');
    expect(chat.enterYeaft).toHaveBeenCalledExactlyOnceWith();
    expect(chat.openPluginCenter).toHaveBeenCalledExactlyOnceWith('a');
    expect(chat.currentAgent).toBe('previous-session-agent');
    expect(chat.enterYeaft.mock.invocationCallOrder[0]).toBeLessThan(chat.openPluginCenter.mock.invocationCallOrder[0]);
  });

  it('explains missing MongoDB without a credential form or fallback Session', async () => {
    configured = false; await render();
    expect(wrapper.get('.person-configuration').text()).toContain('Do not paste credentials');
    expect(wrapper.get('#person-input').attributes('disabled')).toBeDefined();
    expect(requests.map(r => r.op)).toEqual(['status']);
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    for (const key of Object.keys(en).filter(key => key.startsWith('person.'))) expect(zhCN[key]).toBeTruthy();
  });
});
