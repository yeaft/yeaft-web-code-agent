// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';
import { createPersonConversationProjector, projectPersonConversation } from '../../web/utils/person-conversation.js';
import SidebarDigitalPerson from '../../web/components/SidebarDigitalPerson.js';
import PersonThoughtJournal from '../../web/components/PersonThoughtJournal.js';
import PersonActivity from '../../web/components/PersonActivity.js';
import PersonTaskBrowser from '../../web/components/PersonTaskBrowser.js';
import PersonTurnUsage from '../../web/components/PersonTurnUsage.js';
import { personTurn } from '../fixtures/person-turns.js';
import { personRecords } from '../fixtures/person-records.js';
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';

vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => ({ userId: 'owner', authGeneration: 1 }) }));
let wrapper;
let chat;
let configured;
let requests;
const t = (key, params = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
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
        tasks: { tasks: [{ id: 'background', title: '<script>build</script>', status: 'running' }], agents: [{ id: 'child', taskId: 'child-log', name: 'Research', status: 'completed' }] },
        turns: { items: [personTurn()], nextCursor: null },
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

describe('Digital Person conversation projection', () => {
  const reply = (id, episodeId, extra = {}) => ({ id, role: 'assistant', episodeId, text: id, createdAt: 1, ...extra });

  it('groups only contiguous replies with an explicit episode, never legacy, user or system records', () => {
    const rows = [reply('p1', 'a'), reply('p2', 'a'), reply('f', 'a', { replyKind: 'final' }),
      reply('other', 'b'), { id: 'user', role: 'user', episodeId: 'b' }, reply('later', 'b'),
      { id: 'system', role: 'system', episodeId: 'b' }, reply('after-system', 'b'), reply('legacy'), reply('legacy2')];
    const before = JSON.stringify(rows);
    const blocks = projectPersonConversation(rows);
    expect(blocks.map(block => block.parts?.map(part => part.id) || block.id)).toEqual([
      ['p1', 'p2', 'f'], ['other'], 'user', ['later'], 'system', ['after-system'], ['legacy'], ['legacy2'],
    ]);
    expect(new Set(blocks.map(block => block.key)).size).toBe(blocks.length);
    expect(JSON.stringify(rows)).toBe(before);
    expect(blocks[0].parts[0]).toBe(rows[0]);
  });

  it('keeps an extended episode key stable through append, replay and older page prepend', () => {
    const rows = [reply('p2', 'a'), reply('f', 'a')];
    const project = createPersonConversationProjector();
    const key = project(rows, 'owner/a')[0].key;
    expect(project(rows.map(row => ({ ...row })), 'owner/a')[0].key).toBe(key);
    expect(project([...rows, reply('next', 'b')], 'owner/a')[0].key).toBe(key);
    expect(project([reply('p1', 'a'), ...rows], 'owner/a')[0].key).toBe(key);
    const split = project([reply('old-run', 'a'), { id: 'boundary', role: 'user' }, ...rows], 'owner/a');
    expect(split.at(-1).key).toBe(key);
    expect(split[0].key).not.toBe(key);
    const appended = project([...rows, { id: 'new-boundary', role: 'system' }, reply('new-run', 'a')], 'owner/a');
    expect(appended[0].key).toBe(key);
    expect(appended.at(-1).key).not.toBe(key);
    expect(project(rows, 'other-owner/a')[0].key).not.toBe(key);
  });
});

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
      { ...p1, id: 'final', replyKind: 'final', text: '## Final conclusion', createdAt: 93000 });
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

  it.each(['cancelled', 'failed', 'interrupted', 'budget_exhausted'])('keeps grouped progress on %s without labelling it final', async status => {
    await render();
    Object.assign(wrapper.vm.state, { messages: [1, 2].map(index => ({ id: `p${index}`, role: 'assistant', episodeId: 'turn', replyKind: 'progress', text: `Finding ${index}`, createdAt: index })),
      busy: false, episodeId: null, latestEpisode: { id: 'turn', status } });
    await Vue.nextTick();
    expect(wrapper.findAll('.person-reply')).toHaveLength(1);
    expect(wrapper.findAll('.person-reply-part')).toHaveLength(2);
    expect(wrapper.findAll('.person-reply-kind').every(node => node.text() === en['person.progressReply'])).toBe(true);
    expect(wrapper.find('.person-response-loading').exists()).toBe(false);
  });

  it('preserves article, section and focused link when a separated same-episode reply is appended', async () => {
    const markdown = {};
    runInNewContext(readFileSync(resolve(process.cwd(), 'web/vendor/marked.min.js'), 'utf8'), markdown);
    vi.stubGlobal('marked', markdown.marked);
    await render();
    const first = { id: 'first', role: 'assistant', episodeId: 'turn', text: '[Verified evidence](https://example.com/evidence)', createdAt: 1 };
    wrapper.vm.state.messages = [first];
    await Vue.nextTick();
    const article = wrapper.get('.person-reply').element;
    const part = wrapper.get('.person-reply-part').element;
    const link = wrapper.get('.person-reply-part a').element;
    link.focus();
    expect(document.activeElement).toBe(link);
    wrapper.vm.state.messages.push({ id: 'boundary', role: 'system', text: 'Boundary', createdAt: 2 }, { ...first, id: 'later', text: 'Later reply', createdAt: 3 });
    await Vue.nextTick();
    expect(wrapper.findAll('.person-reply')).toHaveLength(2);
    expect(wrapper.get('.person-reply[data-message-id="first"]').element).toBe(article);
    expect(wrapper.get('.person-reply-part[data-message-id="first"]').element).toBe(part);
    expect(document.activeElement).toBe(link);
    wrapper.vm.state.messages = wrapper.vm.state.messages.map(row => ({ ...row }));
    await Vue.nextTick();
    expect(document.activeElement).toBe(link);
  });

  it('preserves reply and part DOM identity when an older page extends the same episode', async () => {
    await render();
    const last = { id: 'tail', role: 'assistant', episodeId: 'turn', text: 'Visible final part', createdAt: 90000 };
    wrapper.vm.state.messages = [last];
    await Vue.nextTick();
    const article = wrapper.get('.person-reply').element;
    const tail = wrapper.get('[data-message-id="tail"] .person-reply-part').element;
    wrapper.vm.state.messages.unshift({ ...last, id: 'earlier', text: 'Earlier progress', createdAt: 30000 });
    await Vue.nextTick();
    expect(wrapper.get('.person-reply').element).toBe(article);
    expect(wrapper.get('.person-reply-part[data-message-id="tail"]').element).toBe(tail);
    expect(wrapper.findAll('.person-message-meta')).toHaveLength(1);
  });

  it.each([en, zhCN])('labels intermediate replies and renders only backend-confirmed waiting feedback inline', async messages => {
    await render(messages);
    wrapper.vm.state.busy = true;
    wrapper.vm.state.episodeId = 'waiting';
    wrapper.vm.state.latestEpisode = { id: 'waiting', status: 'running', createdAt: 1000 };
    await Vue.nextTick();
    expect(wrapper.find('.person-wait-feedback').exists()).toBe(false);
    wrapper.vm.state.messages.push({ id: 'progress', role: 'assistant', text: 'A verified finding.', replyKind: 'progress', episodeId: 'waiting', callId: 'call', createdAt: 31000 });
    await Vue.nextTick();
    expect(wrapper.get('[data-message-id="progress"] .person-reply-kind').text()).toBe(messages['person.progressReply']);
    expect(wrapper.find('.person-response-loading').exists()).toBe(true);
    expect(messages['person.progressReply']).toBeTruthy();
    for (const phase of ['model', 'capability', 'preparing']) {
      wrapper.vm.state.latestEpisode.feedback = { at: 91000, phase, capabilityId: '<script>PRIVATE_CAPABILITY</script>', output: 'PRIVATE_OUTPUT', decision: 'PRIVATE_DECISION' };
      await Vue.nextTick();
      const feedback = wrapper.get('#person-conversation .person-wait-feedback');
      expect(feedback.text()).toContain(messages[`person.feedback.${phase}`]);
      expect(messages[`person.feedback.${phase}`]).toBeTruthy();
      expect(feedback.get('time').attributes('datetime')).toBe(new Date(91000).toISOString());
      expect(wrapper.findAll('.person-wait-feedback')).toHaveLength(1);
      expect(feedback.text()).not.toMatch(/PRIVATE_|person\.feedback\./);
    }
    wrapper.vm.state.messages.push({ id: 'later-progress', role: 'assistant', text: 'Another verified finding.', replyKind: 'progress', episodeId: 'waiting', createdAt: 92000 });
    await Vue.nextTick();
    expect(wrapper.find('.person-wait-feedback').exists()).toBe(false);
    expect(wrapper.find('.person-response-loading').exists()).toBe(true);
    wrapper.vm.state.latestEpisode.feedback.at = 153000;
    await Vue.nextTick();
    expect(wrapper.find('.person-wait-feedback').exists()).toBe(true);
    wrapper.vm.state.latestEpisode.status = 'completed';
    await Vue.nextTick();
    expect(wrapper.find('.person-wait-feedback, .person-response-loading').exists()).toBe(false);
  });

  it.each(['cancelPending', 'commandPending', 'loading', 'activityStale', 'progressStale'])('suppresses backend waiting feedback while %s', async flag => {
    await render();
    Object.assign(wrapper.vm.state, { busy: true, episodeId: 'waiting', latestEpisode: { id: 'waiting', status: 'running', createdAt: 1000, feedback: { at: 61000, phase: 'model' } } });
    await Vue.nextTick();
    expect(wrapper.find('.person-wait-feedback').exists()).toBe(true);
    wrapper.vm.state[flag] = true;
    await Vue.nextTick();
    expect(wrapper.find('.person-wait-feedback').exists()).toBe(false);
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

  it('shows complete turn flow and token metadata only in the kernel, without clearing the draft or starting cognition', async () => {
    await render(); await wrapper.get('#person-input').setValue('Keep my draft');
    await wrapper.get('.person-thoughts-button').trigger('click');
    await wrapper.findAll('.person-inspector-nav button').find(b => b.text() === 'Flow & usage').trigger('click');
    await flushPromises();
    const panel = wrapper.get('#person-turns');
    expect(panel.text()).toContain('2 loops');
    expect(panel.text()).toContain('Total tokens: 170');
    expect(panel.text()).toContain('test/first → test/second');
    expect(panel.text()).toContain('Recall');
    expect(panel.text()).toContain('Loop 2');
    expect(wrapper.get('#person-conversation').text()).not.toContain('170');
    expect(wrapper.get('#person-input').element.value).toBe('Keep my draft');
    expect(requests.filter(r => r.op === 'turns')).toHaveLength(1);
    expect(requests.some(r => ['send', 'think', 'dream'].includes(r.op))).toBe(false);
  });

  it.each([en, zhCN])('distinguishes missing usage, zero and incomplete turns, rendering metadata inertly', messages => {
    const turn = personTurn(2, { status: 'failed', models: ['<img src=x>'], terminalCode: 'PROVIDER_FAILED',
      usage: { totalTokens: 0, complete: false }, calls: [{ callId: 'partial', index: 1, status: 'failed',
        dispatched: { model: '<script>model</script>' }, reason: '<img src=x>', usage: null }] });
    wrapper = mount(PersonTurnUsage, { props: { page: { items: [turn], loaded: true, nextCursor: 1 } },
      global: { config: { globalProperties: { $t: (key, params = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (m, name) => params[name] ?? m) } } } });
    expect(wrapper.text()).toContain(messages['person.usage.partial']);
    expect(wrapper.text()).toContain('0');
    expect(wrapper.text()).toContain('—');
    expect(wrapper.text()).toContain('<script>model</script>');
    expect(wrapper.find('script, img').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/person\.usage\./);
    wrapper.findAll('button').find(b => b.text() === messages['person.usage.older']).trigger('click');
    expect(wrapper.emitted('more')).toHaveLength(1);
  });

  it.each([en, zhCN])('keeps usage dense, distinguishing model tokens, request bytes and actual recall sources', messages => {
    wrapper = mount(PersonTurnUsage, { props: { page: { items: [personTurn()], loaded: true } },
      global: { config: { globalProperties: { $t: (key, params = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (m, name) => params[name] ?? m) } } } });
    const call = wrapper.get('[data-call-id="call-1-2"]');
    expect(call.get('.person-context-metrics').text()).toContain('1,048,576 tokens');
    expect(call.get('.person-context-metrics').text()).toContain(`3,000 ${messages['person.usage.bytes']}`);
    expect(call.get('.person-context-metrics').text()).toContain(messages['person.usage.recall']);
    expect(call.get('.person-context-metrics').text()).toContain(messages['person.usage.messagesCount'].replace('{n}', '5'));
    expect(call.text()).toContain(messages['person.usage.omitted'].replace('{messages}', '1').replace('{concepts}', '2'));
    const totals = wrapper.get('.person-turn-row > summary .person-turn-totals');
    expect(totals.text()).toContain(messages['person.usage.inputTotalTokens']);
    expect(totals.text()).not.toContain(messages['person.usage.inputTokens']);
    expect(wrapper.get('.person-usage-accounting').attributes('open')).toBeUndefined();
    for (const detail of wrapper.findAll('.person-call-diagnostics')) expect(detail.attributes('open')).toBeUndefined();
    const tokens = wrapper.get('[data-call-id="call-1-1"] .person-call-tokens');
    expect(tokens.text()).toContain(messages['person.usage.cacheReadTokens']);
    expect(tokens.text()).not.toContain(messages['person.usage.cacheWriteTokens']);
    expect(wrapper.text()).not.toMatch(/person\.usage\./);
  });

  it('does not invent model windows or source counts for historical records, and keeps zero primary usage', () => {
    const turn = personTurn(3, { usage: { inputTokens: 0, outputTokens: 0, complete: false }, calls: [{ callId: 'old', index: 1, status: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 }, contextBytes: 16309, contextBudgetBytes: 65536 }] });
    wrapper = mount(PersonTurnUsage, { props: { page: { items: [turn], loaded: true } }, global: { config: { globalProperties: { $t: t } } } });
    const call = wrapper.get('[data-call-id="old"]');
    expect(call.get('.person-call-tokens').text()).toContain('Input (raw): 0');
    expect(call.get('.person-call-tokens').text()).toContain('Output: 0');
    expect(call.get('.person-context-metrics').text()).toContain('16,309 bytes');
    expect(call.get('.person-context-metrics').text()).not.toContain('65,536');
    expect(call.get('.person-context-metrics').text()).not.toContain('Model context window');
    expect(call.get('.person-context-metrics').text()).not.toContain('Recent history');
    expect(call.get('.person-call-diagnostics').text()).toContain('65,536 bytes');
  });

  it('shows cross-episode task management in the kernel without starting cognition, keeping logs inert and draft intact', async () => {
    await render(); await wrapper.get('#person-input').setValue('Keep this draft');
    await wrapper.get('.person-thoughts-button').trigger('click');
    await wrapper.findAll('.person-inspector-nav button').find(b => b.text() === 'Tasks').trigger('click');
    await flushPromises();
    const pane = wrapper.get('.person-task-browser');
    expect(pane.text()).toContain('<script>build</script>');
    expect(pane.find('script').exists()).toBe(false);
    await pane.findAll('button').find(b => b.text() === 'View log').trigger('click'); await flushPromises();
    expect(pane.get('pre').text()).toBe('<img onerror=alert(1)> shell output');
    expect(pane.find('img').exists()).toBe(false);
    await pane.findAll('button').find(b => b.text() === 'Stop').trigger('click');
    expect(requests.some(r => r.op === 'task_cancel')).toBe(false);
    await pane.findAll('button').find(b => b.text() === 'Stop').trigger('click'); await flushPromises();
    expect(requests.filter(r => r.op === 'task_cancel')).toHaveLength(1);
    expect(requests.some(r => ['send', 'think', 'dream'].includes(r.op))).toBe(false);
    expect(wrapper.get('#person-input').element.value).toBe('Keep this draft');
  });

  it('treats succeeded shells as terminal and associates child logs without duplicate task rows', () => {
    wrapper = mount(PersonTaskBrowser, { props: { page: { tasks: [
      { id: 'done', kind: 'shell', title: 'Finished', status: 'succeeded' },
      { id: 'child-log', kind: 'sub_agent', agentId: 'child', status: 'succeeded' },
    ], agents: [{ id: 'child', name: 'Research', status: 'completed' }] }, log: {} }, global: { config: { globalProperties: { $t: t } } } });
    expect(wrapper.findAll('.person-task-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('Completed');
    expect(wrapper.text()).not.toContain('person.taskStatus.');
    expect(wrapper.findAll('button').some(button => button.text() === 'Stop')).toBe(false);
    wrapper.findAll('button').filter(button => button.text() === 'View log')[1].trigger('click');
    expect(wrapper.emitted('log')[0]).toEqual(['child-log']);
  });

  it('distinguishes incomplete outcomes and keeps terminal child cleanup controls available', async () => {
    wrapper = mount(PersonTaskBrowser, { props: { page: { tasks: [], agents: [
      { id: 'cutoff', name: 'Cutoff', status: 'completed', outcome: { status: 'incomplete', complete: false, reason: 'budget_exceeded' } },
      { id: 'pending', name: 'After-effects', status: 'completed', executionPending: true, outcome: { status: 'succeeded', complete: true } },
      { id: 'orphan', name: 'Lost handle', status: 'failed', recoveryStatus: 'orphaned', executionPending: true },
      ...Array.from({ length: 97 }, (_, i) => ({ id: `settled-${i}`, name: `Settled ${i}`, status: 'completed', executionPending: false })),
    ], truncated: true }, log: {} }, global: { config: { globalProperties: { $t: t } } } });
    expect(wrapper.findAll('.person-task-item')).toHaveLength(100);
    expect(wrapper.findAll('button').filter(b => b.text() === 'Stop')).toHaveLength(1);
    expect(wrapper.get('[data-task-id="cutoff"]').text()).toContain('Incomplete — budget exhausted');
    expect(wrapper.get('[data-task-id="cutoff"]').findAll('button')).toHaveLength(0);
    expect(wrapper.get('[data-task-id="orphan"]').findAll('button')).toHaveLength(0);
    const pending = wrapper.get('[data-task-id="pending"]');
    expect(pending.text()).toContain('Tool execution is still pending');
    await pending.findAll('button').find(b => b.text() === 'Stop').trigger('click');
    expect(wrapper.emitted('stop')).toBeUndefined();
    await pending.findAll('button').find(b => b.text() === 'Stop').trigger('click');
    expect(wrapper.emitted('stop')[0]).toEqual(['agent', 'pending']);
    await wrapper.setProps({ page: { tasks: [], agents: [{ id: 'pending', status: 'closed', executionPending: false }] } });
    expect(wrapper.findAll('button').some(b => b.text() === 'Stop')).toBe(false);
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

  it('focuses the locally submitted reply start, not historical or autonomous messages, and cleans up layout work', async () => {
    const frames = new Map(); let sequence = 0; let observe;
    const disconnect = vi.fn();
    let observerCount = 0;
    vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++sequence, callback); return sequence; });
    vi.stubGlobal('cancelAnimationFrame', handle => frames.delete(handle));
    vi.stubGlobal('ResizeObserver', class { constructor(callback) { observe = callback; observerCount++; } observe() {} disconnect = disconnect; });
    await render();
    const pane = wrapper.get('.person-messages').element;
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 });
    pane.getBoundingClientRect = () => ({ top: 100, left: 0, right: 800 });
    let replyTop = 700, replyHeight = 100;
    const rect = top => () => ({ top: 100 + top - pane.scrollTop });
    async function layout() {
      await Vue.nextTick();
      if (wrapper.find('.person-response-start').exists()) wrapper.get('.person-response-start').element.getBoundingClientRect = rect(600);
      if (wrapper.find('.person-response-tail').exists()) wrapper.get('.person-response-tail').element.getBoundingClientRect = () => rect(wrapper.vm.focusedResponseId ? replyTop + replyHeight : 620)();
      for (const element of pane.querySelectorAll('.person-message')) element.getBoundingClientRect = rect(element.dataset.messageId === 'reply' ? replyTop : 0);
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());
      await Vue.nextTick();
    }
    expect(wrapper.vm.hasResponseFocus).toBe(false);
    wrapper.vm.state.messages.push({ id: 'remote', role: 'assistant', text: 'Remote response', createdAt: 2 });
    await layout(); expect(pane.scrollTop).toBe(0);
    await wrapper.get('#person-input').setValue('New question');
    await wrapper.get('#person-input').trigger('keydown', { key: 'Enter' });
    await flushPromises(); await layout();
    expect(pane.scrollTop).toBe(600);
    wrapper.vm.state.messages.push(
      { id: 'other', role: 'assistant', episodeId: 'other-episode', text: 'Not this reply', createdAt: 3 },
      { id: 'reply', role: 'assistant', replyKind: 'progress', episodeId: 'e', text: 'This reply', createdAt: 4 });
    await layout(); observe(); await layout();
    expect(wrapper.vm.focusedResponseId).toBe('reply');
    expect(pane.scrollTop).toBe(700);
    expect(wrapper.get('.person-response-tail').element.style.height).toBe('300px');
    wrapper.vm.state.messages.push({ id: 'second-progress', role: 'assistant', replyKind: 'progress', episodeId: 'e', text: 'Another update', createdAt: 5 });
    await layout();
    expect(wrapper.vm.focusedResponseId).toBe('reply');
    expect(pane.scrollTop).toBe(700);
    expect(wrapper.find('.person-response-loading').exists()).toBe(true);
    replyHeight = 600; observe(); await layout();
    expect(pane.scrollTop).toBe(700);
    expect(wrapper.get('.person-response-tail').element.style.height).toBe('0px');
    await wrapper.get('.person-messages').trigger('keydown', { key: 'PageUp' });
    pane.scrollTop = 200; replyTop = 800; observe(); await layout();
    expect(pane.scrollTop).toBe(200);
    wrapper.vm.state.messages.push({ id: 'progress-after-scroll', role: 'assistant', replyKind: 'progress', episodeId: 'e', text: 'Another verified finding', createdAt: 6 });
    await layout();
    expect(wrapper.vm.focusedResponseId).toBe('reply');
    expect(wrapper.vm.responsePinned).toBe(false);
    expect(pane.scrollTop).toBe(200);
    expect(wrapper.find('.person-response-loading').exists()).toBe(true);
    wrapper.vm.state.messages.push({ id: 'final-after-scroll', role: 'assistant', replyKind: 'final', episodeId: 'e', text: 'Final answer', createdAt: 7 });
    wrapper.vm.state.busy = false;
    await layout();
    expect(pane.scrollTop).toBe(200);
    expect(wrapper.find('.person-response-loading').exists()).toBe(false);
    expect(wrapper.vm.state.messages.some(message => message.id === 'm')).toBe(true);
    observe(); await Vue.nextTick(); expect(frames.size).toBe(1);
    // A post-flush synchronous reconciliation must retain the already queued
    // RAF handle. No frame runs between this update and unmount.
    wrapper.vm.state.messages.at(-1).text = 'Update while a frame is queued';
    await Vue.nextTick(); await Vue.nextTick();
    expect(frames.size).toBe(1);
    wrapper.unmount(); wrapper = null;
    expect(disconnect).toHaveBeenCalledTimes(observerCount); expect(frames.size).toBe(0);
  });

  it.each(['wheel', 'touchmove'])('yields response focus to intentional %s and refocuses on the next send', async event => {
    await render();
    await wrapper.get('#person-input').setValue('First'); await wrapper.vm.command('send');
    expect(wrapper.vm.hasResponseFocus).toBe(true);
    await wrapper.get('.person-messages').trigger(event);
    wrapper.vm.state.busy = false;
    await wrapper.get('#person-input').setValue('Second'); await wrapper.vm.command('send');
    expect(wrapper.vm.focusedResponseId).toBe('');
    expect(wrapper.find('.person-response-start').exists()).toBe(true);
    chat.chatHistoryConnectionGeneration = 2;
    await flushPromises();
    expect(wrapper.vm.hasResponseFocus).toBe(false);
    expect(wrapper.find('.person-response-tail').exists()).toBe(false);
  });

  it('does not create reply focus for Think or failed admission, and preserves the target during receipt retry', async () => {
    await render();
    await wrapper.vm.command('think');
    expect(wrapper.vm.hasResponseFocus).toBe(false);
    wrapper.vm.state.busy = false;
    wrapper.vm.state.latestEpisode = null;
    wrapper.vm.state.activityRecords = [];
    await Vue.nextTick();
    const command = vi.spyOn(wrapper.vm.controller, 'command').mockResolvedValue(false);
    await wrapper.get('#person-input').setValue('Question'); await wrapper.vm.command('send');
    expect(wrapper.vm.hasResponseFocus).toBe(false);
    command.mockImplementation(async () => {
      wrapper.vm.state.retryCommand = { op: 'send', payload: {} };
      return false;
    });
    await wrapper.vm.command('send');
    expect(command).toHaveBeenCalledTimes(2);
    expect(wrapper.vm.state.retryCommand).not.toBeNull();
    expect(wrapper.vm.hasResponseFocus).toBe(true);
    wrapper.vm.focusedResponseId = 'already-visible-reply';
    await wrapper.vm.command('send', true);
    expect(wrapper.vm.focusedResponseId).toBe('already-visible-reply');
    await wrapper.findAll('.person-retry button').at(-1).trigger('click');
    expect(wrapper.vm.state.retryCommand).toBeNull();
    expect(wrapper.vm.hasResponseFocus).toBe(false);
    expect(wrapper.find('.person-response-tail').exists()).toBe(false);
    await wrapper.vm.command('send');
    expect(wrapper.vm.hasResponseFocus).toBe(true);
    chat.agents.push({ id: 'b', online: true, capabilities: ['digital_person'] });
    wrapper.vm.agentId = 'b'; await flushPromises();
    expect(wrapper.vm.hasResponseFocus).toBe(false);
  });

  it('focuses the receipted local reply even when refresh sees a newer remote episode', async () => {
    const frames = new Map(); let sequence = 0;
    vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++sequence, callback); return sequence; });
    vi.stubGlobal('cancelAnimationFrame', handle => frames.delete(handle));
    await render();
    const originalSend = chat.sendWsMessage;
    const replies = [
      { id: 'local-reply', role: 'assistant', episodeId: 'local-episode', text: 'Local answer', createdAt: 2 },
      { id: 'remote-reply', role: 'assistant', episodeId: 'remote-episode', text: 'Another tab', createdAt: 3 },
    ];
    chat.sendWsMessage = request => {
      if (!['send', 'receipt', 'snapshot', 'messages'].includes(request.op)) return originalSend(request);
      requests.push(request);
      const data = request.op === 'receipt'
        ? { found: true, kind: 'send', text: 'Local question', episodeId: 'local-episode', status: 'completed' }
        : request.op === 'snapshot'
          ? { person: { id: 'p', name: 'Ada' }, busy: true, episodeId: 'remote-episode', latestEpisode: { id: 'remote-episode', status: 'running' }, messages: replies }
          : { items: replies, nextCursor: null };
      queueMicrotask(() => acceptPersonResponse(chat, { ...request, type: 'person_response', ok: request.op !== 'send', data,
        ...(request.op === 'send' ? { errorCode: 'outcome_unknown', error: 'Admission unknown' } : {}) }));
      return true;
    };
    await wrapper.get('#person-input').setValue('Local question');
    await wrapper.vm.command('send');
    expect(wrapper.vm.state.retryCommand).not.toBeNull();
    await wrapper.vm.command('send', true);
    await flushPromises();
    for (const callback of frames.values()) callback(); frames.clear();
    await Vue.nextTick();
    expect(wrapper.vm.state.episodeId).toBe('remote-episode');
    expect(wrapper.vm.state.commandEpisodeId).toBe('local-episode');
    expect(wrapper.vm.focusedResponseId).toBe('local-reply');
    expect(wrapper.get('.person-messages').classes()).toContain('is-response-pinned');
    await wrapper.get('.person-messages').trigger('wheel');
    expect(wrapper.get('.person-messages').classes()).not.toContain('is-response-pinned');
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
    expect(wrapper.get('.person-response-loading').attributes('aria-label')).toBe(t('sidebar.sessions.processing'));
    expect(wrapper.get('.person-response-loading').text()).toBe('');
    expect(wrapper.find('#person-conversation .person-activity, #person-conversation details').exists()).toBe(false);
    expect(wrapper.get('.person-response-loading').findAll('.typing-indicator > span')).toHaveLength(3);
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
    expect(wrapper.get('.person-response-loading').text()).toBe('');
    wrapper.vm.state.cancelPending = false;
    chat.connectionState = 'reconnecting';
    await Vue.nextTick();
    expect(wrapper.find('.person-response-loading, .person-activity .typing-indicator, .stop-btn').exists()).toBe(false);
    expect(wrapper.find('#person-conversation .person-activity').exists()).toBe(false);
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

  it('keeps completed activity only in the thought drawer, never below the reply', async () => {
    await render();
    wrapper.vm.state.latestEpisode = { id: 'finished', status: 'completed', startedAt: 1000, endedAt: 3000 };
    wrapper.vm.state.activityRecords = [
      { id: 'accepted', episodeId: 'finished', kind: 'accepted', trigger: 'send', at: 1000 },
      { id: 'model', episodeId: 'finished', kind: 'call_started', callId: 'call', at: 1000 },
      { id: 'output', episodeId: 'finished', kind: 'call_output', callId: 'call', at: 3000 },
    ];
    await Vue.nextTick();
    expect(wrapper.find('.person-response-loading, .person-activity').exists()).toBe(false);
    expect(wrapper.get('#person-input').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('.person-message-text').text()).toBe('<img onerror=alert(1)>');
    await wrapper.get('.person-thoughts-button').trigger('click');
    const activity = wrapper.get('#person-thoughts .person-activity');
    expect(activity.get('.person-activity-status').text()).toBe(t('person.activity.completed'));
    expect(activity.attributes('open')).toBeUndefined();
    expect(activity.get('.person-activity-row-status').text()).toBe(t('person.activity.status.completed'));
    expect(wrapper.find('#person-conversation .person-activity').exists()).toBe(false);
    await wrapper.get('.person-panel-header .header-action-btn').trigger('click');
    expect(wrapper.find('.person-activity').exists()).toBe(false);
  });

  it.each(['completed', 'committed', 'cancelled', 'failed', 'interrupted', 'budget_exhausted'])('removes the animation on %s even before the busy snapshot catches up', async status => {
    await render();
    wrapper.vm.state.busy = true;
    wrapper.vm.state.episodeId = 'finished';
    await Vue.nextTick();
    expect(wrapper.find('#person-conversation .person-response-loading').exists()).toBe(true);
    wrapper.vm.state.latestEpisode = { id: 'finished', status };
    await Vue.nextTick();
    expect(wrapper.find('#person-conversation .person-response-loading, #person-conversation .person-activity').exists()).toBe(false);
    expect(wrapper.get('.person-message-text').text()).toBe('<img onerror=alert(1)>');
  });

  it.each(['activityStale', 'progressStale'])('does not animate unconfirmed progress when %s is set', async flag => {
    await render();
    wrapper.vm.state.busy = true;
    await Vue.nextTick();
    expect(wrapper.find('#person-conversation .person-response-loading').exists()).toBe(true);
    wrapper.vm.state[flag] = true;
    await Vue.nextTick();
    expect(wrapper.find('#person-conversation .person-response-loading, #person-conversation .person-activity').exists()).toBe(false);
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

  it('shows the reported inherited candidates and a configurable starting default', async () => {
    await render();
    Object.assign(wrapper.vm.state, { defaultModelSupported: true, effectiveModelCandidates: ['provider/b'],
      agentDefaultModel: 'provider/a', effectiveDefaultModel: 'provider/b' });
    await wrapper.get('.person-settings-button').trigger('click');
    const models = wrapper.findAll('.person-model-list input');
    expect(models.map(input => input.element.checked)).toEqual([false, true]);
    expect(wrapper.get('.person-model-summary').text()).toContain(t('person.candidatesSummary', { count: 1 }));
    expect(wrapper.get('.person-default-model-field').text()).toContain(t('person.agentDefaultModel', { model: 'provider/a' }));
    expect(wrapper.get('#person-default-model').findAll('option').map(option => option.element.value)).toEqual(['', 'provider/b']);
    await wrapper.get('#person-default-model').setValue('provider/b');
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ defaultModel: 'provider/b' });
    expect(requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
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

  it('allows resetting stale candidates and default when no configured models remain', async () => {
    await render();
    Object.assign(wrapper.vm.state, { defaultModelSupported: true, models: [], modelCandidates: ['removed/model'],
      defaultModel: 'removed/model', effectiveModelCandidates: [], agentDefaultModel: null });
    await wrapper.get('.person-settings-button').trigger('click');
    expect(wrapper.get('#person-default-model').attributes('disabled')).toBeUndefined();
    await wrapper.get('.person-model-default input').setValue(true);
    expect(wrapper.get('[role="dialog"] .btn-primary').attributes('disabled')).toBeDefined();
    await wrapper.get('#person-default-model').setValue('');
    expect(wrapper.get('[role="dialog"] .btn-primary').attributes('disabled')).toBeUndefined();
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ modelCandidates: [], defaultModel: null });
    expect(requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
  });

  it('does not invent inherited candidates or send unsupported default fields to an older Agent', async () => {
    await render();
    await wrapper.get('.person-settings-button').trigger('click');
    expect(wrapper.get('.person-model-summary').text()).toBe(t('person.candidatesUnknown'));
    expect(wrapper.findAll('.person-model-list input').every(input => !input.element.checked)).toBe(true);
    expect(wrapper.get('#person-default-model').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.person-default-model-field').text()).toContain(t('person.defaultModelUpgrade'));
    await wrapper.get('#person-name').setValue('Mira');
    await wrapper.get('[role="dialog"] .btn-primary').trigger('click'); await flushPromises();
    expect(requests.find(r => r.op === 'settings').payload).toEqual({ name: 'Mira' });
  });

  it('preserves edited defaults during refresh and includes the select in the focus trap', async () => {
    await render();
    Object.assign(wrapper.vm.state, { defaultModelSupported: true, effectiveModelCandidates: ['provider/a', 'provider/b'],
      agentDefaultModel: 'provider/a' });
    await wrapper.get('.person-settings-button').trigger('click');
    const select = wrapper.get('#person-default-model');
    await select.setValue('provider/b');
    wrapper.vm.state.defaultModel = 'provider/a'; await Vue.nextTick();
    expect(select.element.value).toBe('provider/b');
    select.element.focus();
    await select.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(select.element); // Interior controls must not wrap to the dialog header.
    const save = wrapper.get('[role="dialog"] .btn-primary');
    save.element.focus(); await save.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(wrapper.get('.person-settings-close').element);
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

let activityWrapper;
afterEach(() => activityWrapper?.unmount());
const translator = messages => (key, params = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
const activityProject = overrides => ({ visible: true, loading: true, label: 'person.activity.thinking', params: {}, episodeId: 'episode', rows: [], startedAt: null, endedAt: null, limited: false, ...overrides });
const renderActivity = (activity, messages = en) => {
  activityWrapper = mount(PersonActivity, { props: { activity }, global: { mocks: { $t: translator(messages) } } });
};

describe('Person activity', () => {
  it('shows one readable loading line without an empty disclosure or invented timer', async () => {
    renderActivity(activityProject());
    const status = activityWrapper.get('.person-response-loading');
    expect(status.attributes()).toMatchObject({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-label': en['person.activity.thinking'] });
    expect(status.text()).toBe(en['person.activity.thinking']);
    expect(status.find('.typing-indicator').attributes('aria-hidden')).toBe('true');
    expect(status.findAll('.typing-indicator > span')).toHaveLength(3);
    expect(activityWrapper.find('details, summary, time, .person-activity-elapsed').exists()).toBe(false);
    await activityWrapper.setProps({ activity: activityProject({ visible: false }) });
    expect(activityWrapper.find('.person-activity').exists()).toBe(false);
  });

  it.each([en, zhCN])('defaults to a native collapsed disclosure with safe names, localized statuses and durations', messages => {
    const name = 'Script.' + 'very-long-name-'.repeat(30) + '<img src=x onerror=alert(1)>';
    const statuses = ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'];
    renderActivity(activityProject({ rows: statuses.map((status, index) => ({ id: `${index}`, label: 'person.activity.script', params: { name }, status, durationMs: index === 0 ? null : index === 1 ? 62500 : 5000 })), limited: true }), messages);
    expect(activityWrapper.element.tagName).toBe('DETAILS');
    expect(activityWrapper.attributes('open')).toBeUndefined();
    expect(activityWrapper.get('summary').text()).toContain(messages['person.activity.details']);
    expect(activityWrapper.findAll('summary')).toHaveLength(1);
    expect(activityWrapper.findAll('li')).toHaveLength(6);
    expect(activityWrapper.get('li').text()).toContain(name);
    for (const status of statuses) expect(activityWrapper.text()).toContain(messages['person.activity.status.' + status]);
    const duration = translator(messages)('person.activity.durationMinutes', { minutes: 1, seconds: 2 });
    expect(activityWrapper.text()).toContain(translator(messages)('person.activity.elapsed', { duration }));
    expect(activityWrapper.text()).toContain(messages['person.activity.limited']);
    expect(activityWrapper.find('img, script, pre, .tool-line').exists()).toBe(false);
    expect(activityWrapper.text()).not.toContain('person.activity.');
    expect(activityWrapper.get('.person-activity-status').find('.person-activity-elapsed').exists()).toBe(false);
    expect(activityWrapper.get('.person-activity-rows').attributes('aria-live')).toBeUndefined();
  });

  it('keeps the end-of-round summary and details without treating one capability result as the whole task', async () => {
    const row = { id: 'script', label: 'person.activity.script', params: { name: 'Script.sum' }, status: 'completed', durationMs: 1200 };
    renderActivity(activityProject({ rows: [row] }));
    expect(activityWrapper.get('.person-response-loading').text()).toBe(en['person.activity.thinking']);
    expect(activityWrapper.get('.person-activity-row-status').text()).toBe(en['person.activity.status.completed']);
    await activityWrapper.setProps({ activity: activityProject({ label: 'person.activity.completed', loading: false, rows: [row] }) });
    expect(activityWrapper.get('.person-activity-status').text()).toBe(en['person.activity.completed']);
    expect(activityWrapper.find('.person-response-loading, .typing-indicator').exists()).toBe(false);
    expect(activityWrapper.get('summary').exists()).toBe(true);
  });

  it.each(['stale', 'disconnected', 'uncertain'])('retains unknown progress without loading motion for %s', state => {
    renderActivity(activityProject({ label: 'person.activity.' + state, loading: false, rows: [{ id: 'model', label: 'person.activity.model', params: {}, status: 'unknown', durationMs: null }] }));
    expect(activityWrapper.get('[role="status"]').text()).toBe(en['person.activity.' + state]);
    expect(activityWrapper.find('.typing-indicator, .person-response-loading').exists()).toBe(false);
    expect(activityWrapper.get('li').text()).toContain(en['person.activity.status.unknown']);
  });

  it('does not show invalid durations and can disclose a limited projection with no remaining rows', () => {
    renderActivity(activityProject({ loading: false, limited: true, rows: [-1, Infinity, undefined].map((durationMs, id) => ({ id, label: 'person.activity.model', params: {}, status: 'completed', durationMs })) }));
    expect(activityWrapper.find('.person-activity-elapsed').exists()).toBe(false);
    expect(activityWrapper.get('summary').exists()).toBe(true);
  });

  it('provides matching summary, row, status and timing keys in both languages', () => {
    const keys = Object.keys(en).filter(key => key.startsWith('person.activity.'));
    expect(keys).toHaveLength(40);
    for (const key of keys) expect(zhCN[key]).toBeTruthy();
    expect(Object.keys(zhCN).filter(key => key.startsWith('person.activity.')).sort()).toEqual(keys.sort());
  });
});
