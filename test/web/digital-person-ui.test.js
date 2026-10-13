// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';

import PersonTaskBrowser from '../../web/components/PersonTaskBrowser.js';

import { personTurn } from '../fixtures/person-turns.js';
import { personRecords } from '../fixtures/person-records.js';
import en from '../../web/i18n/en.js';

vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => ({ userId: 'owner', authGeneration: 1 }) }));
let wrapper;
let chat;
let requests;
const t = (key, params = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
beforeEach(() => {
  requests = [];
  chat = Vue.reactive({
    digitalPersonUiEnabledByAgent: { a: true, b: true },
    currentAgent: 'a', connectionState: 'connected', authenticated: true, theme: 'light',
    agents: [{ id: 'a', online: true, capabilities: ['digital_person'] }],
    leaveDigitalPerson: vi.fn(), leaveWorkCenter: vi.fn(), closePluginCenter: vi.fn(), toggleTheme: vi.fn(),
    enterYeaft: vi.fn(() => { chat.currentView = 'yeaft'; chat.currentAgent = 'previous-session-agent'; }), openPluginCenter: vi.fn(),
    sendWsMessage(request) {
      requests.push(request);
      const data = {
        status: { configured: true, renameSupported: true, reason: 'Model unavailable', models: [{ id: 'provider/a' }, { id: 'provider/b' }] }, open: {},
        snapshot: { person: { id: 'p', name: 'Ada' }, state: { version: 4 }, messages: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], busy: false },
        messages: { items: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], nextCursor: null }, traces: { items: personRecords(), nextCursor: 'older' },
        think: { episodeId: 'e' }, send: { episodeId: 'e' }, settings: { settings: { modelCandidates: request.payload.modelCandidates || [] }, person: { id: 'p', name: request.payload.name || 'Ada', settings: { modelCandidates: request.payload.modelCandidates || [] } } },
        inspect: { items: request.payload.section === 'memory' ? [{ id: 'idea', kind: 'interest', statement: '<script>Keep uncertainty</script>', epistemicState: 'reported', revision: 2, sourceRefs: ['message:1'] }] : [{ id: 'Script.sum', domain: 'script', version: 1, description: 'Sum', code: 'return input' }], nextCursor: null },
        search: { items: [{ id: 'archive', role: 'user', text: '<img src=x> archived message', createdAt: 1 }], nextCursor: null },
        tasks: { tasks: [{ id: 'background', title: '<script>build</script>', status: 'running' }], agents: [{ id: 'child', taskId: 'child-log', name: 'Research', status: 'completed' }] },
        turns: { items: [personTurn()], nextCursor: null }, executions: { main: null, items: [] },
        task_log: { text: '<img onerror=alert(1)> shell output', nextOffset: 35 }, task_cancel: {}, agent_close: {},
      };
      queueMicrotask(() => acceptPersonResponse(chat, { ...request, type: 'person_response', ok: true, data: data[request.op] }));
      return true;
    },
  });
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('Pinia', { useChatStore: () => chat });
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });
async function render(messages = en) {
  const localize = (key, params = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
  wrapper = mount(DigitalPersonPage, { attachTo: document.body, global: { provide: { t: localize }, config: { globalProperties: { $t: localize } } } });
  await flushPromises();
}

describe('Digital Person surface', () => {
  it('treats succeeded shells as terminal and associates child logs without duplicate task rows', () => {
    wrapper = mount(PersonTaskBrowser, { props: { page: { tasks: [
      { id: 'done', kind: 'shell', title: 'Finished', status: 'succeeded' },
      { id: 'child-log', kind: 'sub_agent', agentId: 'child', status: 'succeeded' },
    ], agents: [{ id: 'child', name: 'Research', status: 'completed' }] }, log: {} }, global: { config: { globalProperties: { $t: t } } } });
    expect(wrapper.findAll('.person-task-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('Completed');
    expect(wrapper.text()).not.toContain('person.taskStatus.');
    expect(wrapper.findAll('button').some(button => button.text() === 'Stop')).toBe(false);
    expect(wrapper.findAll('.person-task-item').map(row => row.attributes('data-task-id'))).toEqual(['child', 'done']);
    wrapper.get('[data-task-id="child"]').findAll('button').find(button => button.text() === 'View log').trigger('click');
    expect(wrapper.emitted('log')[0]).toEqual(['child-log']);
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

  it('preselects inherited models when customizing candidates and saves both fields', async () => {
    await render();
    Object.assign(wrapper.vm.state, { defaultModelSupported: true, effectiveModelCandidates: ['provider/a', 'provider/b'],
      agentDefaultModel: 'provider/a', effectiveDefaultModel: 'provider/a' });
    await wrapper.get('.person-settings-button').trigger('click');
    await wrapper.get('.person-model-default input').setValue(false);
    const models = wrapper.findAll('.person-model-list input');
    expect(models.every(input => input.element.checked)).toBe(true);
    await models[0].setValue(false);
    await wrapper.get('#person-default-model').setValue('provider/b');
    expect(wrapper.get('.person-model-role').text()).toBe(t('person.defaultModel'));
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ modelCandidates: ['provider/b'], defaultModel: 'provider/b' });
  });

  it('requires correcting a removed default but permits a name-only save with stale models', async () => {
    await render();
    Object.assign(wrapper.vm.state, { defaultModelSupported: true, modelCandidates: ['provider/a', 'removed/model'],
      defaultModel: 'removed/model', agentDefaultModel: 'provider/a' });
    await wrapper.get('.person-settings-button').trigger('click');
    expect(wrapper.get('#person-default-model').element.value).toBe('removed/model');
    await wrapper.get('#person-name').setValue('Mira');
    expect(wrapper.get('[role="dialog"] .btn-primary').attributes('disabled')).toBeUndefined();
    await wrapper.findAll('.person-model-list input').find(input => input.element.value === 'removed/model').setValue(false);
    expect(wrapper.get('[role="dialog"] .btn-primary').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.person-default-model-field [role="alert"]').text()).toBe(t('person.defaultModelInvalid'));
    await wrapper.get('#person-default-model').setValue('');
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ name: 'Mira', modelCandidates: ['provider/a'], defaultModel: null });
  });

  it('uploads a file and explicitly sends it without text, clearing only after acknowledgement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ files: [{ fileId: 'upload-1' }] }) })));
    await render();
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(wrapper.get('input[type="file"]').element, 'files', { value: [file], configurable: true });
    await wrapper.get('input[type="file"]').trigger('change'); await flushPromises();
    expect(wrapper.get('.attachments-preview').text()).toContain('notes.txt');
    expect(requests.filter(r => r.op === 'send')).toHaveLength(0);
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeUndefined();
    await wrapper.get('.send-btn').trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'send').payload).toMatchObject({ text: '', attachments: [{ fileId: 'upload-1' }] });
    expect(wrapper.find('.attachments-preview').exists()).toBe(false);
    expect(fetch.mock.calls[0][0]).toBe('/api/upload');
  });

  it('blocks send during uploads and fences completion after Agent changes', async () => {
    let finish;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    await render();
    const files = wrapper.get('input[type="file"]');
    Object.defineProperty(files.element, 'files', { value: [new File(['x'], 'private.txt', { type: 'text/plain' })], configurable: true });
    await files.trigger('change');
    await wrapper.get('#person-input').setValue('an instruction');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    chat.agents.push({ id: 'b', online: true, capabilities: ['digital_person'] });
    await Vue.nextTick(); await wrapper.findComponent({ name: 'ModernSelect' }).vm.$emit('update:modelValue', 'b'); await flushPromises();
    finish({ ok: true, json: async () => ({ files: [{ fileId: 'private-upload' }] }) }); await flushPromises();
    expect(wrapper.find('.attachments-preview').exists()).toBe(false);
    expect(wrapper.get('#person-input').element.value).toBe('');
    expect(requests.some(r => r.payload.attachments)).toBe(false);
  });
});
