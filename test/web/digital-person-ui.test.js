// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';
import PersonThoughtJournal from '../../web/components/PersonThoughtJournal.js';
import { personRecords } from '../fixtures/person-records.js';
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
        status: { configured, reason: 'Model unavailable' }, open: {},
        snapshot: { person: { id: 'p', name: 'Ada' }, state: { version: 4 }, messages: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], busy: false },
        messages: { items: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], nextCursor: null }, traces: { items: personRecords(), nextCursor: 'older' },
        think: { episodeId: 'e' }, send: { episodeId: 'e' },
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
  it('shares the composer and separates readable thoughts from raw debug logs', async () => {
    await render();
    expect(wrapper.find('.session-sidebar-shell').exists()).toBe(false);
    expect(wrapper.find('[data-message-composer]').exists()).toBe(true);
    expect(wrapper.get('.person-identity').text()).toContain(en['person.manualMode']);
    expect(wrapper.get('.person-manual-hint').text()).toBe(en['person.manualHint']);
    expect(wrapper.get('.person-status').text()).toContain(en['person.ready']);
    expect(wrapper.get('.person-message-text').text()).toBe('<img onerror=alert(1)>');
    expect(wrapper.find('.person-message img').exists()).toBe(false);
    expect(wrapper.get('#person-input').attributes('disabled')).toBeUndefined();
    await wrapper.get('[aria-controls="person-thoughts"]').trigger('click');
    const thoughts = wrapper.get('#person-thoughts');
    expect(thoughts.text()).toContain('Maybe the delay came from the final verification step.');
    expect(thoughts.text()).toContain('A repeated guess is not new evidence.');
    expect(thoughts.text()).toContain('<script>not HTML</script>');
    expect(thoughts.find('script').exists()).toBe(false);
    expect(thoughts.find('pre').exists()).toBe(false);
    for (const text of ['PRIVATE SYSTEM PROMPT', 'HIDDEN REASONING', 'contextBytes', 'test/model', 'secretCatalogField']) expect(thoughts.text()).not.toContain(text);
    expect(document.activeElement).toBe(wrapper.get('[aria-controls="person-thoughts"]').element);
    await wrapper.get('[aria-controls="person-debug"]').trigger('click');
    expect(wrapper.find('#person-thoughts').exists()).toBe(false);
    expect(wrapper.get('#person-debug').text()).toContain('contextBytes');
    expect(wrapper.get('#person-debug').text()).toContain('test/model');
    await wrapper.findAll('button').find(b => b.text() === 'Back').trigger('click');
    expect(wrapper.find('#person-thoughts').exists()).toBe(true);
    expect(wrapper.find('#person-debug').exists()).toBe(false);
  });

  it('labels continuation input as earlier candidate and hides truncated technical output', () => {
    const traces = personRecords();
    const request = traces.find(t => t.kind === 'call_started');
    const context = JSON.parse(request.request.messages[0].content);
    context.previousProposal = { state: { summary: 'An earlier possible explanation.' }, next: { capability: { id: 'Recall' } } };
    context.capabilityResult = { kind: 'messages', items: [{ role: 'user', text: 'A recalled report at this page boundary.' }] };
    request.request.messages[0].content = JSON.stringify(context);
    traces.push({ id: 'partial', episodeId: 'e', seq: 9, kind: 'call_failed', output: { text: '{"sourceRefs":["private-ref"],"next":{"model":"private-model"', complete: false } });
    wrapper = mount(PersonThoughtJournal, { props: { traces }, global: { config: { globalProperties: { $t: t } } } });
    expect(wrapper.text()).toContain('Earlier candidate — not adopted · Current understanding');
    expect(wrapper.text()).toContain('Recalled for this thought');
    expect(wrapper.text()).toContain('A recalled report at this page boundary.');
    expect(wrapper.text()).toContain(en['person.thought.structured_unavailable']);
    expect(wrapper.text()).not.toMatch(/sourceRefs|private-ref|private-model/);
  });

  it('preserves the draft between views and sends only on the explicit keyboard shortcut', async () => {
    await render();
    const input = wrapper.get('#person-input');
    await input.setValue('A thought in progress');
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    await input.trigger('keydown', { key: 'Enter' });
    expect(requests.filter(r => r.op === 'send')).toHaveLength(0);
    await wrapper.get('[aria-controls="person-thoughts"]').trigger('click');
    await wrapper.get('[aria-controls="person-conversation"]').trigger('click');
    expect(input.element.value).toBe('A thought in progress');
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true });
    await flushPromises();
    expect(requests.filter(r => r.op === 'send')).toHaveLength(1);
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

  it('explains unavailable storage or model configuration without a credential form or fallback Session', async () => {
    configured = false; await render();
    expect(wrapper.get('.person-configuration').text()).toContain('Do not paste credentials');
    expect(wrapper.get('#person-input').attributes('disabled')).toBeDefined();
    expect(requests.map(r => r.op)).toEqual(['status']);
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    for (const key of Object.keys(en).filter(key => key.startsWith('person.'))) expect(zhCN[key]).toBeTruthy();
  });
});
