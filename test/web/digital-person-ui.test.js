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
        status: { configured, reason: 'Model unavailable', models: [{ id: 'provider/a' }, { id: 'provider/b' }] }, open: {},
        snapshot: { person: { id: 'p', name: 'Ada' }, state: { version: 4 }, messages: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], busy: false },
        messages: { items: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], nextCursor: null }, traces: { items: personRecords(), nextCursor: 'older' },
        think: { episodeId: 'e' }, send: { episodeId: 'e' }, settings: { settings: request.payload },
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

  it.each([en, zhCN])('renders translated capability outcomes as text, independently of adopted cognition', messages => {
    const html = '<img src=x onerror="alert(1)"><script>not executable</script>';
    const traces = [
      { id: 'created', episodeId: 'e', seq: 1, callId: 'a', kind: 'capability_result', capability: { id: 'Capability.create', args: { code: 'PRIVATE_CODE', tests: 'PRIVATE_TESTS' } },
        result: { ok: true, published: true, contract: { id: 'Script.sum', description: html, version: 1 }, evidence: { testsPassed: 2 } } },
      { id: 'executed', episodeId: 'e', seq: 2, callId: 'a', kind: 'capability_result', capability: { id: 'Script.sum', args: { input: 'PRIVATE_INPUT' } },
        result: { ok: true, id: 'Script.sum', version: 1, output: 'PRIVATE_OUTPUT', access: 'pure-computation' } },
      ...['SCRIPT_TEST_FAILED', 'SCRIPT_EXECUTION', 'SCRIPT_TIMEOUT', 'SCRIPT_OUTPUT', 'SCRIPT_VERSION', 'SCRIPT_BUSY', 'PRIVATE_PROVIDER'].map((code, index) => ({
        id: `failure-${index}`, episodeId: 'e', seq: index + 3, kind: 'capability_failed', capabilityId: 'Script.sum', code,
        result: { ok: false, message: 'PRIVATE_DIAGNOSTICS' },
      })),
      { id: 'commit', episodeId: 'e', seq: 10, callId: 'a', kind: 'committed' },
    ];
    wrapper = mount(PersonThoughtJournal, { props: { traces }, global: { config: { globalProperties: { $t: key => messages[key] || key } } } });
    const publication = wrapper.get('[data-thought-kind="capability_created"]');
    expect(publication.text()).toContain(messages['person.thought.capability_created']);
    expect(publication.text()).toContain(messages['person.thought.capability_published']);
    expect(publication.text()).toContain(messages['person.thought.capability_tests_limit']);
    expect(publication.text()).toContain(html);
    expect(publication.get('.person-thought-status').text()).toBe(messages['person.thought.recorded']);
    expect(wrapper.get('[data-thought-kind="script_executed"]').text()).toContain(messages['person.thought.script_succeeded']);
    expect(wrapper.findAll('[data-thought-kind="capability_failed"]')).toHaveLength(7);
    expect(wrapper.text()).not.toMatch(/PRIVATE_|person\.thought\./);
    expect(wrapper.find('img, script, pre').exists()).toBe(false);
  });

  it('preserves the draft between views and shares Enter / Shift+Enter and IME behavior with Session', async () => {
    await render();
    const input = wrapper.get('#person-input');
    await input.setValue('A thought in progress');
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    await input.trigger('keydown', { key: 'Enter', shiftKey: true });
    await input.trigger('keydown', { key: 'Enter', keyCode: 229 });
    expect(requests.filter(r => r.op === 'send')).toHaveLength(0);
    await wrapper.get('[aria-controls="person-thoughts"]').trigger('click');
    await wrapper.get('[aria-controls="person-conversation"]').trigger('click');
    expect(input.element.value).toBe('A thought in progress');
    await input.trigger('keydown', { key: 'Enter' });
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

  it('only returns to Sessions; model candidates stay in an in-page modal', async () => {
    await render();
    expect(wrapper.find('.person-menu').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(t('person.plugins'));
    await wrapper.get('.person-settings-button').trigger('click');
    expect(wrapper.get('[role="dialog"]').text()).toContain(t('person.modelCandidates'));
    await wrapper.get('[role="dialog"] input[type="checkbox"]').setValue(false);
    await wrapper.findAll('[role="dialog"] input[type="checkbox"]')[2].setValue(true);
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ modelCandidates: ['provider/b'] });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
    expect(chat.enterYeaft).not.toHaveBeenCalled();
    expect(chat.openPluginCenter).not.toHaveBeenCalled();
    await wrapper.get('.person-navigation button').trigger('click');
    expect(chat.leaveDigitalPerson).toHaveBeenCalledOnce();
    expect(chat.closePluginCenter).toHaveBeenCalledOnce();
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

  it('retains failed uploads, blocks send, and fences upload completion after Agent changes', async () => {
    let finish;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    await render();
    const files = wrapper.get('input[type="file"]');
    Object.defineProperty(files.element, 'files', { value: [new File(['x'], 'private.txt', { type: 'text/plain' })], configurable: true });
    await files.trigger('change');
    await wrapper.get('#person-input').setValue('an instruction');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    chat.agents.push({ id: 'b', online: true, capabilities: ['digital_person'] });
    await Vue.nextTick(); await wrapper.get('#person-agent').setValue('b'); await flushPromises();
    finish({ ok: true, json: async () => ({ files: [{ fileId: 'private-upload' }] }) }); await flushPromises();
    expect(wrapper.find('.attachments-preview').exists()).toBe(false);
    expect(wrapper.get('#person-input').element.value).toBe('');
    expect(requests.some(r => r.payload.attachments)).toBe(false);
  });

  it('supports paste and rejects unsupported files instead of silently sending text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await render();
    const event = { clipboardData: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } };
    await wrapper.get('#person-input').trigger('paste', event); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain(t('person.filesFailed'));
    expect(wrapper.get('.attachments-preview').text()).toContain(t('chatInput.retryUpload'));
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    Object.defineProperty(wrapper.get('input[type="file"]').element, 'files', { value: [new File(['x'], 'report.pdf', { type: 'application/pdf' })], configurable: true });
    await wrapper.get('input[type="file"]').trigger('change'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain(t('person.filesUnsupported'));
  });

  it('clears upload failure after successful retry and permits removing unavailable model candidates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, json: async () => ({ files: [{ fileId: 'restored' }] }) }));
    await render();
    await wrapper.get('#person-input').trigger('paste', { clipboardData: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } });
    await flushPromises(); expect(wrapper.get('[role="alert"]').text()).toContain(t('person.filesFailed'));
    await wrapper.findAll('.attachments-preview button')[0].trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeUndefined();
    wrapper.vm.state.modelCandidates = ['provider/a', 'removed/model'];
    await wrapper.get('.person-settings-button').trigger('click');
    expect(wrapper.get('[role="dialog"]').text()).toContain('removed/model');
    const checkbox = wrapper.findAll('[role="dialog"] input').find(input => input.element.value === 'removed/model');
    await checkbox.setValue(false);
    expect(wrapper.get('[role="dialog"] .btn-primary').attributes('disabled')).toBeUndefined();
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
