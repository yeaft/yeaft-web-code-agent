// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';
import PersonManagement from '../../web/components/PersonManagement.js';
import PersonTurnUsage from '../../web/components/PersonTurnUsage.js';
import { personTurn } from '../fixtures/person-turns.js';
import { personRecords } from '../fixtures/person-records.js';
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';
import { createPersonConversationProjector, projectPersonConversation, personResponseOrigins } from '../../web/utils/person-conversation.js';

vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => ({ userId: 'owner', authGeneration: 1 }) }));
let wrapper;
let chat;
let requests;
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
  it.each([en, zhCN])('offers labelled mobile actions, restores the visible opener and preserves the draft', async messages => {
    vi.stubGlobal('innerWidth', 320);
    await render(messages);
    const more = wrapper.get('.person-more-button');
    const input = wrapper.get('#person-input');
    await input.setValue('Keep my draft');
    await more.trigger('click'); await flushPromises();
    const sheet = wrapper.get('#person-actions-sheet');
    expect(sheet.attributes('aria-modal')).toBe('true');
    expect(sheet.text()).toContain(messages['person.moreActions']);
    expect(sheet.findAll('.person-actions-list button').map(button => button.text())).toEqual([
      'person.searchMessages', 'person.outputs', 'person.inside', 'person.settings', 'common.refresh',
    ].map(key => messages[key]));
    expect(wrapper.get('.person-header').attributes('inert')).toBeDefined();
    expect(wrapper.get('#person-conversation').attributes('inert')).toBeDefined();
    expect(document.activeElement).toBe(sheet.get('.person-actions-close').element);
    const last = sheet.get('.person-action-refresh');
    last.element.focus(); await last.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(sheet.get('.person-actions-close').element);
    await sheet.get('.person-actions-close').trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last.element);
    await last.trigger('keydown', { key: 'Escape' }); await flushPromises();
    expect(wrapper.find('#person-actions-sheet').exists()).toBe(false);
    expect(document.activeElement).toBe(more.element);
    await more.trigger('click'); await flushPromises();
    await wrapper.get('.person-action-search').trigger('click'); await flushPromises();
    expect(wrapper.find('#person-actions-sheet').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.person-search-form input').element);
    await wrapper.get('.person-panel-header button').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(more.element);
    await more.trigger('click'); await flushPromises();
    await wrapper.get('.person-action-settings').trigger('click'); await flushPromises();
    expect(wrapper.find('.person-settings-modal').exists()).toBe(true);
    await wrapper.get('.person-settings-close').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(more.element);
    expect(input.element.value).toBe('Keep my draft');
    expect(requests.some(r => ['send', 'think', 'dream', 'cancel'].includes(r.op))).toBe(false);
  });

  it('keeps inspection available while offline/busy but disables unsafe refresh and settings', async () => {
    vi.stubGlobal('innerWidth', 320);
    await render();
    Object.assign(wrapper.vm.state, { busy: true, commandPending: true });
    await wrapper.get('.person-more-button').trigger('click'); await flushPromises();
    expect(wrapper.get('.person-action-settings').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.person-action-refresh').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.person-action-search').attributes('disabled')).toBeUndefined();
    wrapper.vm.state.commandPending = null;
    chat.connectionState = 'disconnected';
    await Vue.nextTick();
    expect(wrapper.get('.person-action-refresh').attributes('disabled')).toBeDefined();
    await wrapper.get('.person-action-inside').trigger('click'); await flushPromises();
    expect(wrapper.get('#person-side-panel').text()).toContain(en['person.disconnected']);
  });

  it('dismisses transient actions on Agent/desktop changes without executing a stale settings selection', async () => {
    vi.stubGlobal('innerWidth', 320);
    await render();
    await wrapper.get('.person-more-button').trigger('click'); await flushPromises();
    // The select handler awaits removal of inert before mounting settings.
    const pending = wrapper.vm.selectMore('settings');
    wrapper.vm.agentId = 'b';
    await pending; await flushPromises();
    expect(wrapper.vm.settingsOpen).toBe(false);
    expect(wrapper.find('#person-actions-sheet').exists()).toBe(false);
    await wrapper.get('.person-more-button').trigger('click'); await flushPromises();
    vi.stubGlobal('innerWidth', 1280);
    window.dispatchEvent(new Event('resize')); await flushPromises();
    expect(wrapper.find('#person-actions-sheet').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.person-thoughts-button').element);
  });

  it.each([en, zhCN])('offers explicit autonomy control only in Management and distinguishes autonomous activity', async messages => {
    const localize = key => messages[key] || key;
    wrapper = mount(PersonManagement, { props: {
      execution: { active: { episodeId: 'auto', kind: 'autonomous', status: 'paused', models: [] }, loaded: true },
      page: { tasks: [], agents: [], loaded: true }, log: {}, autonomySupported: true,
    }, global: { config: { globalProperties: { $t: localize } } } });
    const toggle = wrapper.get('input[type="checkbox"]');
    expect(toggle.element.checked).toBe(false);
    expect(wrapper.text()).toContain(messages['person.autonomy.label']);
    expect(wrapper.text()).toContain(messages['person.autonomy.scope']);
    expect(wrapper.text()).toContain(messages['person.autonomous']);
    await toggle.setValue(true);
    expect(wrapper.emitted('autonomy')).toEqual([[true]]);
    expect(toggle.element.checked).toBe(false); // rejected/unacknowledged consent is not displayed as enabled
    await wrapper.setProps({ autonomyPending: true, autonomyEnabled: true });
    expect(toggle.attributes('disabled')).toBeDefined();
    await wrapper.setProps({ autonomyPending: false, autonomyDisabled: true });
    expect(toggle.attributes('disabled')).toBeDefined();
    await wrapper.setProps({ autonomyDisabled: false, disabled: true });
    expect(toggle.attributes('disabled')).toBeDefined();
    await wrapper.setProps({ autonomySupported: false });
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });

  it.each([en, zhCN])('renders one reply header with timestamped progress/final parts and a single inline waiting status', async messages => {
    const markdown = {};
    runInNewContext(readFileSync(resolve(process.cwd(), 'web/vendor/marked.min.js'), 'utf8'), markdown);
    vi.stubGlobal('marked', markdown.marked);
    await render(messages);
    const state = wrapper.vm.state;
    const p1 = { id: 'p1', role: 'assistant', episodeId: 'turn', replyKind: 'progress', text: 'First verified finding.', createdAt: 31000 };
    Object.assign(state, { messages: [{ id: 'question', role: 'user', text: 'Question', episodeId: 'turn', createdAt: 1 }, p1],
      busy: true, episodeId: 'turn', latestEpisode: { id: 'turn', status: 'running' } });
    await Vue.nextTick();
    const article = wrapper.get('.person-reply');
    const articleElement = article.element;
    const firstPartElement = article.get('.person-reply-part').element;
    expect(article.get('.person-response-loading').exists()).toBe(true);
    state.messages.push({ ...p1, id: 'p2', text: '<script>Not active HTML</script>', createdAt: 62000 },
      { ...p1, id: 'final', replyKind: 'execution-final', text: '## Final conclusion', createdAt: 93000 });
    await Vue.nextTick();
    expect(wrapper.findAll('.person-reply')).toHaveLength(1);
    expect(article.findAll('.person-message-meta')).toHaveLength(1);
    expect(article.get('.person-message-meta').text()).toBe('Ada');
    expect(article.findAll('.person-reply-part')).toHaveLength(3);
    expect(article.findAll('.person-reply-divider')).toHaveLength(2);
    expect(article.findAll('.person-reply-kind').map(node => node.text())).toEqual([
      messages['person.progressReply'], messages['person.progressReply'], messages['person.finalReply'],
    ]);
    expect(article.findAll('time').map(node => node.attributes('datetime'))).toEqual([31000, 62000, 93000].map(at => new Date(at).toISOString()));
    expect(article.find('script').exists()).toBe(false);
    expect(article.get('.person-reply-part[data-message-id="final"] .person-message-text h2').text()).toBe('Final conclusion');
    state.messages = state.messages.map(row => ({ ...row })); // snapshot replay
    await Vue.nextTick();
    expect(wrapper.get('.person-reply').element).toBe(articleElement);
    expect(wrapper.get('.person-reply-part').element).toBe(firstPartElement);
    Object.assign(state, { busy: false, episodeId: null, latestEpisode: { id: 'turn', status: 'completed' } });
    await Vue.nextTick();
    expect(wrapper.find('.person-response-loading').exists()).toBe(false);
    expect(article.findAll('.person-reply-part')).toHaveLength(3);
    state.messages.push({ id: 'question2', role: 'user', text: 'New question', createdAt: 94000 }, { ...p1, id: 'next', episodeId: 'next-turn' });
    await Vue.nextTick();
    expect(wrapper.findAll('.person-reply')).toHaveLength(2);
  });

  it('keeps answer target sets separate with stable owner-scoped identities and legacy progress grouping', () => {
    const reply = (id, ids) => ({ id, role: 'assistant', episodeId: 'continuous', ...(ids ? { replyToMessageIds: ids } : {}) });
    const rows = [reply('a', ['q1']), reply('b', ['q2']), reply('c', ['q2']), reply('d'), reply('e'), reply('f', ['q1', 'q2']), reply('g', ['q2', 'q1'])];
    expect(projectPersonConversation(rows).map(block => block.parts.map(part => part.id))).toEqual([['a'], ['b', 'c'], ['d', 'e'], ['f', 'g']]);
    const project = createPersonConversationProjector();
    const original = project(rows, 'owner-a');
    const replay = project(rows.map(row => ({ ...row })), 'owner-a');
    expect(replay.map(row => row.key)).toEqual(original.map(row => row.key));
    const changed = project(rows.map(row => row.id === 'a' ? { ...row, replyToMessageIds: ['q3'] } : row), 'owner-a');
    expect(changed[0].key).not.toBe(original[0].key);
    expect(project(rows, 'owner-b').map(row => row.key)).not.toEqual(original.map(row => row.key));
    const blocks = project([
      { id: 'q1', role: 'user', episodeId: 'continuous' }, reply('a', ['q1']),
      { id: 'q2', role: 'user', episodeId: 'continuous' }, reply('b', ['q2']),
      reply('legacy'), reply('unloaded', ['missing']),
      { id: 'dream', role: 'assistant', episodeId: 'dream' },
    ], 'owner-a');
    const origins = personResponseOrigins(blocks);
    expect(blocks.filter(row => row.role === 'assistant').map(row => origins.get(row.key)))
      .toEqual([blocks[0].key, blocks[2].key, blocks[0].key, blocks[5].key, blocks[6].key]);
    // A partial assistant block never borrows a question from another episode.
    const partial = project([{ id: 'q', role: 'user', episodeId: 'old' }, { id: 'a', role: 'assistant', episodeId: 'new' }], 'owner-b');
    expect(personResponseOrigins(partial).get(partial[1].key)).toBe(partial[1].key);
  });

  it.each([en, zhCN])('shows accurate delivery and compact reply context using only loaded user records', async messages => {
    await render(messages);
    const user = (id, deliveryState) => ({ id, role: 'user', text: `Question ${id} <script>quoted only</script> ` + 'long excerpt '.repeat(40), episodeId: 'continuous', deliveryState, createdAt: 1 });
    const reply = (id, ids) => ({ id, role: 'assistant', text: 'Answer', episodeId: 'continuous', replyToMessageIds: ids, createdAt: 2 });
    wrapper.vm.state.messages = [user('q1', 'queued'), user('q2', 'received'), user('q3', 'stopped'), reply('a1', ['q1', 'q2', 'q3']), reply('a2', ['not-loaded'])];
    await Vue.nextTick();
    expect(wrapper.findAll('.person-delivery').map(node => node.text())).toEqual(['queued', 'received', 'stopped'].map(state => messages[`person.delivery.${state}`]));
    const contexts = wrapper.findAll('.person-reply-context');
    expect(contexts).toHaveLength(2);
    expect(contexts[0].findAll('blockquote')).toHaveLength(2);
    expect(contexts[0].text()).toContain(messages['person.replyContext'].replace('{count}', '3'));
    expect(contexts[0].find('script').exists()).toBe(false);
    expect(contexts[1].text()).toBe(messages['person.replyContext'].replace('{count}', '1'));
    expect(contexts[1].find('blockquote').exists()).toBe(false);
    expect(requests.some(r => r.op === 'search')).toBe(false);
  });

  it('allows busy/paused input, repeated sends and uploads without refocusing the reader on each supplement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ files: [{ fileId: 'busy-file' }] }) })));
    await render();
    Object.assign(wrapper.vm.state, { busy: true, episodeId: 'e', latestEpisode: { id: 'e', status: 'paused' } });
    await Vue.nextTick();
    const input = wrapper.get('#person-input');
    expect(input.attributes('disabled')).toBeUndefined();
    expect(wrapper.get('.person-inbox-hint').text()).toBe(en['person.inboxHint']);
    const idleActions = wrapper.findAll('.person-composer .btn-ghost').filter(button => ['Think', 'Dream'].includes(button.text()));
    expect(idleActions.every(button => button.attributes('disabled') !== undefined)).toBe(true);
    const files = wrapper.get('input[type="file"]');
    Object.defineProperty(files.element, 'files', { value: [new File(['x'], 'busy.txt', { type: 'text/plain' })], configurable: true });
    await files.trigger('change'); await flushPromises();
    const send = chat.sendWsMessage;
    let pending;
    chat.sendWsMessage = request => {
      if (request.op !== 'send') return send(request);
      requests.push(request); pending = request; return true;
    };
    const acknowledge = async () => {
      acceptPersonResponse(chat, { ...pending, type: 'person_response', ok: true, data: { episodeId: 'e' } });
      await flushPromises();
    };
    input.element.focus();
    await input.setValue('First supplement'); await input.trigger('keydown', { key: 'Enter' });
    expect(input.attributes('disabled')).toBeDefined(); // short transport lock only
    input.element.blur(); // browser blurs a disabled textarea (happy-dom does not)
    await acknowledge();
    expect(document.activeElement).toBe(input.element);
    expect(wrapper.vm.hasResponseFocus).toBe(false);
    await input.setValue('New question'); await input.trigger('keydown', { key: 'Enter' });
    const stop = wrapper.get('.stop-btn'); stop.element.focus();
    await acknowledge();
    expect(document.activeElement).toBe(stop.element); // never steal deliberate reading/control focus
    input.element.focus();
    expect(requests.filter(r => r.op === 'send')).toHaveLength(2);
    expect(requests.filter(r => r.op === 'send')[0].payload.attachments).toEqual([{ fileId: 'busy-file' }]);
    wrapper.vm.state.messages.push({ id: 'streaming-progress', role: 'assistant', episodeId: 'e', text: 'Still working' });
    await Vue.nextTick();
    expect(document.activeElement).toBe(input.element);
    expect(input.attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.stop-btn').exists()).toBe(true);
  });

  it('renders one model with multiple independent tool trace rows and prefers the new array over legacy scalar', async () => {
    const turn = personTurn(1, { calls: [{ callId: 'model', index: 1, status: 'completed', capabilities: [
      { callId: 'trace-a', id: 'FileRead', status: 'completed', modelCallId: 'model', toolUseId: 'provider-a', toolIndex: 0, args: 'PRIVATE_ARGS' },
      { callId: 'trace-b', id: 'Bash', status: 'future-status', code: 'UNCONFIRMED', modelCallId: 'model', toolUseId: 'provider-b', toolIndex: 1 },
    ], capability: { id: 'legacy-duplicate', status: 'completed' } }] });
    wrapper = mount(PersonTurnUsage, { props: { page: { items: [turn], loaded: true, nextCursor: 'older' } }, global: { config: { globalProperties: { $t: key => en[key] || key } } } });
    expect(wrapper.findAll('.person-call-step')).toHaveLength(1);
    expect(wrapper.findAll('.person-call-capability').map(row => row.attributes('data-tool-call-id'))).toEqual(['trace-a', 'trace-b']);
    expect(wrapper.text()).toContain('FileRead'); expect(wrapper.text()).toContain('Bash');
    expect(wrapper.get('[data-tool-call-id="trace-b"]').text()).toContain('Unknown');
    expect(wrapper.text()).not.toMatch(/PRIVATE_ARGS|legacy-duplicate|provider-a|provider-b/);
    await wrapper.setProps({ page: { items: [personTurn()], loaded: true } });
    expect(wrapper.findAll('.person-call-capability')).toHaveLength(1); // legacy scalar reader
    await wrapper.setProps({ page: { items: [{ ...turn, calls: [{ ...turn.calls[0], capabilities: [] }] }], loaded: true } });
    expect(wrapper.findAll('.person-call-capability')).toHaveLength(0);
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
