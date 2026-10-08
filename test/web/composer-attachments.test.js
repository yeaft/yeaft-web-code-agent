// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ChatInput from '../../web/components/ChatInput.js';
import DigitalPersonPage from '../../web/components/DigitalPersonPage.js';
import { acceptPersonResponse } from '../../web/stores/helpers/digital-person.js';
import en from '../../web/i18n/en.js';

vi.mock('../../web/stores/auth.js', () => ({ useAuthStore: () => auth }));
let auth;
let chat;
let wrappers;
let fetchMock;
let requests;
let sendFn;
const t = key => en[key] || key;
const file = (name = 'notes.txt', type = 'text/plain') => new File(['notes'], name, { type });
const uploaded = (ids = ['upload-1']) => ({ ok: true, json: async () => ({ files: ids.map(fileId => ({ fileId })) }) });

beforeEach(() => {
  wrappers = []; requests = []; sendFn = vi.fn();
  auth = Vue.reactive({ userId: 'owner', authGeneration: 1, token: 'owner-token' });
  chat = Vue.reactive({
    activeConversationId: 'c1', currentConversation: 'c1', currentView: 'yeaft',
    currentAgent: 'a', agents: [{ id: 'a', online: true, capabilities: ['digital_person'] }],
    digitalPersonUiEnabledByAgent: { a: true },
    connectionState: 'connected', authenticated: true, theme: 'light',
    btwMode: false, compactStatus: null, customExpertRoles: [], expertSelections: [], inputDrafts: {},
    isProcessing: false, slashCommandDescriptions: {}, yeaftActiveSessionFilter: 's1',
    leaveDigitalPerson: vi.fn(), leaveWorkCenter: vi.fn(), closePluginCenter: vi.fn(), toggleTheme: vi.fn(),
    sendWsMessage(request) {
      requests.push(request);
      const data = {
        status: { configured: true, models: [{ id: 'p/model' }] }, open: {},
        snapshot: { person: { id: 'p', name: 'Ada' }, state: { version: 1 }, messages: [], busy: false },
        messages: { items: [], nextCursor: null }, traces: { items: [], nextCursor: null },
        send: { episodeId: 'e' }, think: { episodeId: 'e' }, dream: { episodeId: 'e' },
      };
      queueMicrotask(() => acceptPersonResponse(chat, { ...request, type: 'person_response', ok: true, data: data[request.op] }));
      return true;
    },
  });
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('Pinia', {
    useChatStore: () => chat, useAuthStore: () => auth,
    useSessionsStore: () => ({ activeSessionId: 's1', sessionById: () => null, sessions: {} }),
    useVpStore: () => ({ vpList: [] }),
  });
  fetchMock = vi.fn().mockResolvedValue(uploaded());
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { wrappers.forEach(w => w.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function render(kind, props = {}) {
  const wrapper = mount(kind === 'person' ? DigitalPersonPage : ChatInput, {
    attachTo: document.body,
    props: kind === 'person' ? {} : { sendFn, ...props },
    global: { provide: { t }, config: { globalProperties: { $t: t } }, stubs: { VpMentionAutocomplete: true } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}
async function pick(wrapper, files) {
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, 'files', { value: files, configurable: true });
  await input.trigger('change'); await flushPromises();
}
function setDisabled(wrapper, kind) {
  if (kind === 'person') { wrapper.vm.state.busy = true; return Vue.nextTick(); }
  return wrapper.setProps({ disabled: true });
}

for (const kind of ['session', 'person']) describe(`${kind}: shared attachment composer`, () => {
  it('uses the paperclip, preview/name/size, removable attachment and no implicit model controls', async () => {
    const wrapper = await render(kind);
    const paperclip = wrapper.get('button.attach-btn');
    expect(paperclip.attributes('aria-label')).toBe(t('chatInput.upload'));
    expect(paperclip.find('svg').exists()).toBe(true);
    await pick(wrapper, [file('photo.png', 'image/png')]);
    const card = wrapper.get('.attachment-item');
    expect(card.get('.attachment-thumb').attributes('src')).toBe('blob:local-preview');
    expect(card.get('.attachment-name').text()).toBe('photo.png');
    expect(card.get('.attachment-status').text()).toBe('5 B');
    expect(wrapper.find('.person-attachment-list').exists()).toBe(false);
    expect(wrapper.find('.composer-send-modes, .mobile-quick-send-bar, .yeaft-model-selector').exists()).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/upload');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer owner-token');
    await card.get('.attachment-remove').trigger('click');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
    expect(wrapper.find('.attachment-item').exists()).toBe(false);
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
  });

  it('blocks sending until upload finishes, retains failures and retries through the same card', async () => {
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = await render(kind);
    await pick(wrapper, [file()]);
    expect(wrapper.get('.attachment-item').classes()).toContain('is-uploading');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    finish({ ok: false }); await flushPromises();
    expect(wrapper.get('.attachment-item').classes()).toContain('has-error');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    await wrapper.get('.attachment-retry').trigger('click'); await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.get('.attachment-item').classes()).not.toContain('has-error');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeUndefined();
    await wrapper.get('.send-btn').trigger('click'); await flushPromises();
    if (kind === 'person') expect(requests.find(r => r.op === 'send').payload).toMatchObject({ text: '', attachments: [{ fileId: 'upload-1' }] });
    else expect(sendFn).toHaveBeenCalledWith('', [expect.objectContaining({ fileId: 'upload-1', name: 'notes.txt' })]);
    expect(wrapper.find('.attachment-item').exists()).toBe(false);
  });

  it('accepts clipboard item files and drag/drop through the same upload flow', async () => {
    const wrapper = await render(kind);
    const input = wrapper.get('textarea');
    await input.trigger('paste', { clipboardData: { items: [{ kind: 'file', getAsFile: () => file() }] } });
    await flushPromises();
    expect(wrapper.findAll('.attachment-item')).toHaveLength(1);
    await wrapper.get('[data-message-composer]').trigger('drop', { dataTransfer: { files: [file('second.md')] } });
    await flushPromises();
    expect(wrapper.findAll('.attachment-item')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await input.trigger('paste', { clipboardData: { items: [{ kind: 'string' }], files: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not bypass disabled state via picker, paste, drop, remove or retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    const wrapper = await render(kind);
    await pick(wrapper, [file()]);
    await setDisabled(wrapper, kind);
    expect(wrapper.get('.attach-btn').attributes('disabled')).toBeDefined();
    expect(wrapper.get('input[type="file"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.attachment-remove').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.attachment-retry').attributes('disabled')).toBeDefined();
    await pick(wrapper, [file('ignored.md')]);
    await wrapper.get('textarea').trigger('paste', { clipboardData: { files: [file()] } });
    await wrapper.get('[data-message-composer]').trigger('drop', { dataTransfer: { files: [file()] } });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll('.attachment-item')).toHaveLength(1);
  });

  it('rejects an incomplete batch response instead of enabling send with a partial upload', async () => {
    fetchMock.mockResolvedValueOnce(uploaded(['only-first']));
    const wrapper = await render(kind);
    await pick(wrapper, [file(), file('second.md')]);
    expect(wrapper.findAll('.attachment-item')).toHaveLength(2);
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.attachment-retry').exists()).toBe(true);
  });

  it('keeps batch upload results aligned when an uploading row is removed', async () => {
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = await render(kind);
    await pick(wrapper, [file('removed.txt'), file('kept.md')]);
    await wrapper.findAll('.attachment-remove')[0].trigger('click');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    finish(uploaded(['removed-id', 'kept-id'])); await flushPromises();
    expect(wrapper.get('.attachment-name').text()).toBe('kept.md');
    await wrapper.get('.send-btn').trigger('click'); await flushPromises();
    const sent = kind === 'person' ? requests.find(r => r.op === 'send').payload.attachments : sendFn.mock.calls[0][1];
    expect(sent.map(row => row.fileId)).toEqual(['kept-id']);
  });

  it('aborts a removed retry and ignores its late result after a new file is added', async () => {
    let finish;
    fetchMock.mockResolvedValueOnce({ ok: false })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(uploaded(['new-id']));
    const wrapper = await render(kind);
    await pick(wrapper, [file('removed.png', 'image/png')]);
    await wrapper.get('.attachment-retry').trigger('click'); await flushPromises();
    await wrapper.get('.attachment-remove').trigger('click');
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
    await pick(wrapper, [file('new.md')]);
    finish(uploaded(['removed-id'])); await flushPromises();
    expect(wrapper.findAll('.attachment-item')).toHaveLength(1);
    expect(wrapper.get('.attachment-name').text()).toBe('new.md');
    await wrapper.get('.send-btn').trigger('click'); await flushPromises();
    const sent = kind === 'person' ? requests.find(r => r.op === 'send').payload.attachments : sendFn.mock.calls[0][1];
    expect(sent.map(row => row.fileId)).toEqual(['new-id']);
  });

  it('fences pending upload and draft attachments when authenticated owner changes', async () => {
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = await render(kind);
    await pick(wrapper, [file('photo.png', 'image/png')]);
    auth.userId = 'other-owner'; auth.authGeneration++;
    await flushPromises();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    finish(uploaded(['previous-owner-file'])); await flushPromises();
    expect(wrapper.find('.attachment-item').exists()).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
  });

  it('aborts pending uploads and releases unsent previews on unmount', async () => {
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = await render(kind);
    await pick(wrapper, [file('photo.png', 'image/png')]);
    const signal = fetchMock.mock.calls[0][1].signal;
    wrapper.unmount(); wrappers = wrappers.filter(w => w !== wrapper);
    expect(signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
    finish(uploaded()); await flushPromises();
    expect(sendFn).not.toHaveBeenCalled();
    expect(requests.filter(r => r.op === 'send')).toHaveLength(0);
  });
});

it('keeps picker identity unique when two composer instances coexist', async () => {
  const session = await render('session');
  const person = await render('person');
  const a = session.get('input[type="file"]').attributes('id');
  const b = person.get('input[type="file"]').attributes('id');
  expect(a).toBeTruthy(); expect(b).toBeTruthy(); expect(a).not.toBe(b);
});

it('Session preserves files and draft on an asynchronous rejection, then transfers previews only after acceptance', async () => {
  let acknowledge;
  sendFn = vi.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  const wrapper = await render('session');
  await pick(wrapper, [file('photo.png', 'image/png')]);
  await wrapper.get('textarea').setValue('with a file');
  await wrapper.get('.send-btn').trigger('click');
  expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
  expect(wrapper.findAll('.attachment-item')).toHaveLength(1);
  acknowledge(false); await flushPromises();
  expect(wrapper.get('textarea').element.value).toBe('with a file');
  expect(wrapper.findAll('.attachment-item')).toHaveLength(1);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await wrapper.get('.send-btn').trigger('click');
  acknowledge(true); await flushPromises();
  expect(wrapper.get('textarea').element.value).toBe('');
  expect(wrapper.findAll('.attachment-item')).toHaveLength(0);
  wrapper.unmount(); wrappers = wrappers.filter(w => w !== wrapper);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled(); // Message projection owns the sent preview.
});

it.each(['throw', 'reject'])('Session preserves draft and files when custom send fails via %s', async failureMode => {
  const error = new Error('Send unavailable');
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  sendFn = vi.fn(() => { if (failureMode === 'throw') throw error; return Promise.reject(error); });
  const wrapper = await render('session');
  await pick(wrapper, [file('photo.png', 'image/png')]);
  await wrapper.get('textarea').setValue('keep me');
  await wrapper.get('.send-btn').trigger('click'); await flushPromises();
  expect(wrapper.get('textarea').element.value).toBe('keep me');
  expect(wrapper.findAll('.attachment-item')).toHaveLength(1);
  expect(wrapper.get('.send-btn').attributes('disabled')).toBeUndefined();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  expect(logged).toHaveBeenCalledWith('Send failed:', error);
});

it.each(['replace', 'add', 'unchanged'])('Session consumes only the sent quote after asynchronous acknowledgement (%s)', async mode => {
  let acknowledge;
  sendFn = vi.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  const quoteA = { messageId: 'a', text: 'original quote' };
  const quoteB = { messageId: 'b', text: 'later quote' };
  const wrapper = await render('session', { quote: mode === 'add' ? null : quoteA });
  await wrapper.get('textarea').setValue('sent draft');
  await wrapper.get('.send-btn').trigger('click');
  if (mode !== 'unchanged') await wrapper.setProps({ quote: quoteB });
  wrapper.vm.replaceDraft('later draft');
  acknowledge(true); await flushPromises();
  expect(wrapper.get('textarea').element.value).toBe('later draft');
  expect(wrapper.emitted('quote-consumed')?.length || 0).toBe(mode === 'unchanged' ? 1 : 0);
  if (mode === 'add') expect(sendFn).toHaveBeenCalledWith('sent draft', undefined);
  else expect(sendFn).toHaveBeenCalledWith('sent draft', undefined, quoteA);
});

it('Session ignores a late acknowledgement after switching the logical composer identity', async () => {
  let acknowledge;
  sendFn = vi.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  const wrapper = await render('session', { draftKey: 'first' });
  await pick(wrapper, [file('photo.png', 'image/png')]);
  await wrapper.get('textarea').setValue('old draft');
  await wrapper.get('.send-btn').trigger('click');
  await wrapper.setProps({ draftKey: 'second' });
  await wrapper.get('textarea').setValue('new draft');
  await pick(wrapper, [file('new.md')]);
  acknowledge(true); await flushPromises();
  expect(wrapper.get('textarea').element.value).toBe('new draft');
  expect(wrapper.get('.attachment-name').text()).toBe('new.md');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
});

it('Person Dream preserves draft/files; Think consumes them only on acknowledgement', async () => {
  const wrapper = await render('person');
  await pick(wrapper, [file()]);
  await wrapper.get('textarea').setValue('topic');
  await wrapper.findAll('button').find(b => b.text() === t('person.dream')).trigger('click');
  await flushPromises();
  expect(requests.find(r => r.op === 'dream').payload.attachments).toBeUndefined();
  expect(wrapper.get('textarea').element.value).toBe('topic');
  expect(wrapper.findAll('.attachment-item')).toHaveLength(1);
  wrapper.vm.state.busy = false; await Vue.nextTick();
  await wrapper.findAll('button').find(b => b.text() === t('person.think')).trigger('click');
  await flushPromises();
  expect(requests.find(r => r.op === 'think').payload).toMatchObject({ text: 'topic', attachments: [{ fileId: 'upload-1' }] });
  expect(wrapper.find('.attachment-item').exists()).toBe(false);
});
