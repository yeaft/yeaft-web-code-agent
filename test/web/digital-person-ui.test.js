// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';
import SidebarDigitalPerson from '../../web/components/SidebarDigitalPerson.js';
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
    digitalPersonUiEnabledByAgent: { a: true, b: true },
    currentAgent: 'a', connectionState: 'connected', authenticated: true, theme: 'light',
    agents: [{ id: 'a', online: true, capabilities: ['digital_person'] }],
    leaveDigitalPerson: vi.fn(), leaveWorkCenter: vi.fn(), closePluginCenter: vi.fn(), toggleTheme: vi.fn(),
    enterYeaft: vi.fn(() => { chat.currentView = 'yeaft'; chat.currentAgent = 'previous-session-agent'; }), openPluginCenter: vi.fn(),
    sendWsMessage(request) {
      requests.push(request);
      const data = {
        status: { configured, renameSupported: true, reason: 'Model unavailable', models: [{ id: 'provider/a' }, { id: 'provider/b' }] }, open: {},
        snapshot: { person: { id: 'p', name: 'Ada' }, state: { version: 4 }, messages: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], busy: false },
        messages: { items: [{ id: 'm', role: 'assistant', text: '<img onerror=alert(1)>', createdAt: 1 }], nextCursor: null }, traces: { items: personRecords(), nextCursor: 'older' },
        think: { episodeId: 'e' }, send: { episodeId: 'e' }, settings: { settings: { modelCandidates: request.payload.modelCandidates || [] }, person: { id: 'p', name: request.payload.name || 'Ada', settings: { modelCandidates: request.payload.modelCandidates || [] } } },
        inspect: { items: request.payload.section === 'memory' ? [{ id: 'idea', kind: 'interest', statement: '<script>Keep uncertainty</script>', epistemicState: 'reported', revision: 2, sourceRefs: ['message:1'] }] : [{ id: 'Script.sum', domain: 'script', version: 1, description: 'Sum', code: 'return input' }], nextCursor: null },
        search: { items: [{ id: 'archive', role: 'user', text: '<img src=x> archived message', createdAt: 1 }], nextCursor: null },
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
  it('hides the sidebar entry when the optional store host is absent', () => {
    vi.stubGlobal('Pinia', {});
    wrapper = mount(SidebarDigitalPerson, { global: { mocks: { $t: t } } });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('only lists UI-enabled Agents in the Person breadcrumb', async () => {
    chat.agents.push({ id: 'disabled', online: true, capabilities: ['digital_person'] });
    await render();
    const options = wrapper.findComponent({ name: 'ModernSelect' }).props('options');
    expect(options.map(row => row.value)).toEqual(['a']);
  });

  it('shares the composer and separates readable thoughts from raw debug logs', async () => {
    await render();
    expect(wrapper.find('.session-sidebar-shell').exists()).toBe(false);
    expect(wrapper.find('[data-message-composer]').exists()).toBe(true);
    expect(wrapper.find('.person-views, .session-tab-bar, .person-manual-hint, .person-attachment-policy').exists()).toBe(false);
    expect(wrapper.find('#person-conversation').isVisible()).toBe(true);
    expect(wrapper.find('.person-status, .person-status-dot, .person-connection-notice').exists()).toBe(false);
    expect(wrapper.get('.person-message-text').text()).toBe('<img onerror=alert(1)>');
    expect(wrapper.find('.person-message img').exists()).toBe(false);
    expect(wrapper.get('#person-input').attributes('disabled')).toBeUndefined();
    await wrapper.get('.person-thoughts-button').trigger('click');
    const thoughts = wrapper.get('#person-thoughts');
    expect(thoughts.text()).toContain('Maybe the delay came from the final verification step.');
    expect(thoughts.text()).toContain('A repeated guess is not new evidence.');
    expect(thoughts.text()).toContain('<script>not HTML</script>');
    expect(thoughts.find('script').exists()).toBe(false);
    expect(thoughts.find('pre').exists()).toBe(false);
    for (const text of ['PRIVATE SYSTEM PROMPT', 'HIDDEN REASONING', 'contextBytes', 'test/model', 'secretCatalogField']) expect(thoughts.text()).not.toContain(text);
    expect(document.activeElement).toBe(wrapper.get('.person-panel-header .header-action-btn').element);
    expect(wrapper.get('#person-conversation').isVisible()).toBe(true);
    await wrapper.get('.person-debug-link').trigger('click');
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
    await wrapper.get('.person-thoughts-button').trigger('click');
    await wrapper.get('.person-panel-header .header-action-btn').trigger('click');
    await Vue.nextTick();
    expect(document.activeElement).toBe(wrapper.get('.person-thoughts-button').element);
    expect(input.element.value).toBe('A thought in progress');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(requests.filter(r => r.op === 'send')).toHaveLength(1);
  });

  it('contains focus in the mobile thought drawer, returns focus on Escape, and preserves the composer', async () => {
    const width = window.innerWidth;
    window.innerWidth = 320;
    try {
      await render();
      await wrapper.get('#person-input').setValue('mobile draft');
      await wrapper.get('.person-thoughts-button').trigger('click');
      await Vue.nextTick();
      expect(wrapper.get('#person-side-panel').attributes('aria-modal')).toBe('true');
      expect(wrapper.get('#person-conversation').attributes('inert')).toBeDefined();
      const first = wrapper.get('.person-panel-header .header-action-btn');
      first.element.focus();
      await first.trigger('keydown', { key: 'Tab', shiftKey: true });
      const last = wrapper.get('.person-journal .person-load-more');
      expect(document.activeElement).toBe(last.element);
      await last.trigger('keydown', { key: 'Tab' });
      expect(document.activeElement).toBe(first.element);
      await first.trigger('keydown', { key: 'Escape' });
      await Vue.nextTick();
      expect(wrapper.find('#person-side-panel').exists()).toBe(false);
      expect(document.activeElement).toBe(wrapper.get('.person-thoughts-button').element);
      expect(wrapper.get('#person-input').element.value).toBe('mobile draft');
      await wrapper.get('.person-thoughts-button').trigger('click');
      document.body.focus();
      await wrapper.get('.person-panel-backdrop').trigger('click');
      await Vue.nextTick();
      expect(document.activeElement).toBe(wrapper.get('.person-thoughts-button').element);
    } finally { window.innerWidth = width; }
  });

  it('shows compact panel failures and connection state without hiding the conversation draft', async () => {
    const width = window.innerWidth;
    window.innerWidth = 800;
    try {
      await render();
      await wrapper.get('#person-input').setValue('draft');
      await wrapper.get('.person-thoughts-button').trigger('click');
      wrapper.vm.state.error = { message: 'Trace request failed' };
      await Vue.nextTick();
      expect(wrapper.get('.person-panel-error').attributes('role')).toBe('alert');
      expect(wrapper.get('.person-panel-error').text()).toContain('Trace request failed');
      wrapper.get('.person-panel-error button').element.focus();
      wrapper.vm.state.error = null;
      await Vue.nextTick();
      expect(document.activeElement).toBe(wrapper.get('.person-panel-header .header-action-btn').element);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Vue.nextTick();
      expect(wrapper.find('#person-side-panel').exists()).toBe(false);
      await wrapper.get('.person-thoughts-button').trigger('click');
      chat.connectionState = 'reconnecting';
      await flushPromises();
      expect(wrapper.get('.person-panel-notice').text()).toContain(t('person.disconnected'));
      expect(wrapper.get('.person-panel-notice button').exists()).toBe(true);
      wrapper.get('.person-panel-notice button').element.focus();
      chat.connectionState = 'connected';
      await flushPromises();
      expect(document.activeElement).toBe(wrapper.get('.person-panel-header .header-action-btn').element);
      expect(wrapper.get('#person-input').element.value).toBe('draft');
    } finally { window.innerWidth = width; }
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

  it('shows conversation loading from admission through completion, without header cancel or tool calls', async () => {
    await render();
    expect(wrapper.find('.person-response-loading').exists()).toBe(false);
    wrapper.vm.state.commandPending = true;
    await Vue.nextTick();
    expect(wrapper.get('.person-response-loading').attributes('role')).toBe('status');
    expect(wrapper.get('.person-response-loading').attributes('aria-label')).toBe(t('person.busy'));
    expect(wrapper.get('.person-response-loading').findAll('span[aria-hidden="true"]')).toHaveLength(3);
    expect(wrapper.find('.person-status').exists()).toBe(false);
    expect(wrapper.find('.message-composer-spinner').exists()).toBe(true);
    expect(wrapper.find('.stop-btn').exists()).toBe(false); // No episode to stop before admission.
    wrapper.vm.state.commandPending = false;
    wrapper.vm.state.busy = true;
    wrapper.vm.state.episodeId = 'e';
    await Vue.nextTick();
    expect(wrapper.find('.person-response-loading').exists()).toBe(true);
    expect(wrapper.get('.person-composer .stop-btn').attributes('aria-label')).toBe(t('chatInput.stop'));
    expect(wrapper.find('.person-header .stop-btn, .tool-line, .person-debug-row').exists()).toBe(false);
    const cancel = vi.spyOn(wrapper.vm.controller, 'cancel').mockResolvedValue();
    await wrapper.get('.person-composer .stop-btn').trigger('click');
    expect(cancel).toHaveBeenCalledOnce();
    wrapper.vm.state.cancelPending = true;
    await Vue.nextTick();
    expect(wrapper.get('.stop-btn').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.person-response-loading').attributes('aria-label')).toBe(t('person.cancelling'));
    wrapper.vm.state.cancelPending = false;
    chat.connectionState = 'reconnecting';
    await Vue.nextTick();
    expect(wrapper.find('.person-response-loading, .stop-btn').exists()).toBe(false);
    expect(wrapper.get('.person-connection-notice').text()).toContain(t('person.disconnected'));
  });

  it('clears loading after completion without losing the conversation', async () => {
    await render();
    wrapper.vm.state.busy = true;
    await Vue.nextTick();
    expect(wrapper.find('.person-response-loading').exists()).toBe(true);
    wrapper.vm.state.busy = false;
    await Vue.nextTick();
    expect(wrapper.find('.person-response-loading, .message-composer-spinner, .stop-btn').exists()).toBe(false);
    expect(wrapper.find('.person-status, .person-status-dot, .person-connection-notice').exists()).toBe(false);
    expect(wrapper.get('#person-input').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('.person-message-text').text()).toBe('<img onerror=alert(1)>');
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
    await wrapper.findComponent({ name: 'ModernSelect' }).vm.$emit('update:modelValue', 'b'); await flushPromises();
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

  it('separates the centered name from the Agent picker, renames in settings and opens the read-only inner browser', async () => {
    await render();
    expect(wrapper.find('.theme-toggle').exists()).toBe(false);
    expect(wrapper.get('.person-navigation #person-agent').exists()).toBe(true);
    expect(wrapper.find('.person-breadcrumb h1, .person-status-dot').exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'ModernSelect' }).props('menuClass')).toBe('agent-select-menu');
    expect(wrapper.get('.person-identity h1').text()).toBe('Ada');
    const detailsButton = wrapper.get('.person-thoughts-button');
    expect(detailsButton.findComponent({ name: 'NavigationIcon' }).props('name')).toBe('eye');
    expect(detailsButton.attributes('aria-label')).toBe(t('person.inside'));
    expect(detailsButton.get('svg circle').attributes('r')).toBe('3');
    await wrapper.get('.person-settings-button').trigger('click');
    await wrapper.get('#person-name').setValue('Mira');
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click');
    await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ name: 'Mira' });
    expect(wrapper.get('.person-identity h1').text()).toBe('Mira');
    await wrapper.get('.person-thoughts-button').trigger('click');
    expect(wrapper.findAll('.person-inspector-nav svg')).toHaveLength(0);
    await wrapper.findAll('.person-inspector-nav button').find(b => b.text() === t('person.memory')).trigger('click');
    await flushPromises();
    expect(wrapper.get('.person-knowledge').text()).toContain('<script>Keep uncertainty</script>');
    expect(wrapper.get('.person-knowledge').find('script').exists()).toBe(false);
    expect(requests.filter(r => r.op === 'inspect')).toHaveLength(1);
    chat.connectionState = 'reconnecting'; await flushPromises();
    chat.connectionState = 'connected'; await flushPromises();
    expect(requests.filter(r => r.op === 'inspect' && r.payload.section === 'memory')).toHaveLength(2);
    expect(wrapper.get('.person-knowledge').text()).toContain('<script>Keep uncertainty</script>');
    await wrapper.findAll('.person-inspector-nav button').find(b => b.text() === t('person.skills')).trigger('click');
    await flushPromises();
    expect(wrapper.get('.person-knowledge').text()).toContain('Script.sum');
    expect(wrapper.get('#person-conversation').isVisible()).toBe(true);
    expect(requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
  });

  it('keeps model settings usable but disables rename for an older Agent without the capability', async () => {
    const send = chat.sendWsMessage;
    chat.sendWsMessage = request => {
      if (request.op !== 'status') return send(request);
      requests.push(request);
      queueMicrotask(() => acceptPersonResponse(chat, { ...request, type: 'person_response', ok: true,
        data: { configured: true, models: [{ id: 'provider/a' }] } }));
      return true;
    };
    await render();
    await wrapper.get('.person-settings-button').trigger('click');
    expect(wrapper.get('#person-name').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[role="dialog"]').text()).toContain(t('person.renameUpgrade'));
    await wrapper.get('#person-name').setValue('Not supported');
    await wrapper.get('.person-model-default input').setValue(false);
    await wrapper.get('.person-model-list input').setValue(true);
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click');
    await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ modelCandidates: ['provider/a'] });
    expect(wrapper.get('.person-identity h1').text()).toBe('Ada');
    chat.sendWsMessage = send;
    await wrapper.vm.controller.refresh();
    await wrapper.get('.person-settings-button').trigger('click');
    expect(wrapper.get('#person-name').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[role="dialog"]').text()).not.toContain(t('person.renameUpgrade'));
  });

  it('searches archived messages without replacing the conversation or losing the draft', async () => {
    await render();
    await wrapper.get('#person-input').setValue('my draft');
    await wrapper.get('.person-search-button').trigger('click');
    await Vue.nextTick();
    const input = wrapper.get('.person-search-form input');
    expect(document.activeElement).toBe(input.element);
    await input.setValue('archived');
    await wrapper.get('.person-search-form').trigger('submit');
    await flushPromises();
    expect(requests.find(r => r.op === 'search').payload).toEqual({ query: 'archived', cursor: null, limit: 20 });
    expect(wrapper.get('.person-search-result').text()).toContain('<img src=x> archived message');
    expect(wrapper.get('.person-search-result').find('img').exists()).toBe(false);
    expect(wrapper.get('.person-messages').text()).not.toContain('archived message');
    await wrapper.get('.person-panel-header button').trigger('click');
    await Vue.nextTick();
    expect(document.activeElement).toBe(wrapper.get('.person-search-button').element);
    expect(wrapper.get('#person-input').element.value).toBe('my draft');
  });

  it.each([
    { next: '', ok: true }, { next: '', ok: false },
    { next: 'beta', ok: true }, { next: 'beta', ok: false },
  ])('invalidates a delayed search during refresh after editing to "$next" (success: $ok)', async ({ next, ok }) => {
    await render();
    await wrapper.get('.person-search-button').trigger('click');
    const input = wrapper.get('.person-search-form input');
    const send = chat.sendWsMessage;
    let pendingSearch, resumeStatus;
    chat.sendWsMessage = request => {
      if (request.op === 'search') { requests.push(request); pendingSearch = request; return true; }
      if (request.op === 'status') { resumeStatus = () => send(request); return true; }
      return send(request);
    };
    await input.setValue('alpha');
    await wrapper.get('.person-search-form').trigger('submit');
    const oldSearch = pendingSearch;
    const refreshing = wrapper.vm.controller.refresh();
    await Vue.nextTick();
    expect(wrapper.vm.state.loading).toBe(true);
    await input.setValue(next);
    expect(wrapper.vm.state.search.query).toBe('');
    acceptPersonResponse(chat, { ...oldSearch, type: 'person_response', ok,
      data: { items: [{ id: 'alpha', text: 'alpha archive message' }], nextCursor: null }, error: 'old search failed' });
    await flushPromises();
    expect(wrapper.vm.state.search.items).toEqual([]);
    expect(wrapper.vm.state.search.error).toBeNull();
    resumeStatus(); await refreshing; await flushPromises();
    expect(input.element.value).toBe(next);
    expect(wrapper.findAll('.person-search-result')).toHaveLength(0);
    if (next) {
      expect(pendingSearch.payload.query).toBe(next);
      acceptPersonResponse(chat, { ...pendingSearch, type: 'person_response', ok: true,
        data: { items: [{ id: 'beta', text: 'beta new result', role: 'user' }], nextCursor: null } });
      await flushPromises();
      expect(wrapper.get('.person-search-result').text()).toContain('beta new result');
    } else expect(wrapper.vm.state.search.query).toBe('');
    expect(wrapper.vm.state.search.error).toBeNull();
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
    await Vue.nextTick(); await wrapper.findComponent({ name: 'ModernSelect' }).vm.$emit('update:modelValue', 'b'); await flushPromises();
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
