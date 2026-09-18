// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

globalThis.Vue = Vue;
globalThis.Pinia = { defineStore: () => () => ({}) };
const { default: Page } = await import('../../web/components/WorkCenterPage.js');
const { default: ActionDetail } = await import('../../web/components/WorkCenterActionDetail.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');
let wrapper;
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); });
const waiting = { id: 'a2', generation: 2, status: 'waiting', canonicalResult: { waitingReason: 'Which branch?' } };

describe('Work Center explicit user input', () => {
  it('follows actual message updates only at the bottom of the same Agent and Work Item', () => {
    const stream = { dataset: { workItemId: 'item' }, scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
    const tick = vi.fn();
    const vm = { agentId: 'agent', selectedId: 'item', $refs: { detailScroll: stream }, $nextTick: tick };
    const state = { agentId: 'agent', workItemId: 'item', blocks: [] };
    const update = previous => Page.watch.conversationScrollState.call(vm, state, previous);
    update(undefined); // Initial load stays at the overview.
    update({ ...state, workItemId: null }); // Delayed first detail is not a live message.
    update({ ...state, workItemId: 'another-item' }); // New keyed DOM cannot inherit scroll intent.
    update({ ...state, agentId: 'another-agent' });
    expect(tick).not.toHaveBeenCalled();
    stream.scrollTop = 0;
    update(state); // Reading requirements must not be interrupted.
    expect(tick).not.toHaveBeenCalled();
    stream.scrollTop = 800;
    update(state);
    stream.scrollHeight = 1200;
    tick.mock.calls[0][0]();
    expect(stream.scrollTop).toBe(1200);
  });

  it('does not apply a queued scroll after the reader moves or the Work Item changes', () => {
    const stream = { dataset: { workItemId: 'item' }, scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
    const tick = vi.fn();
    const vm = { agentId: 'agent', selectedId: 'item', $refs: { detailScroll: stream }, $nextTick: tick };
    const state = { agentId: 'agent', workItemId: 'item', blocks: [] };
    Page.watch.conversationScrollState.call(vm, state, state);
    stream.scrollTop = 100;
    tick.mock.calls[0][0]();
    expect(stream.scrollTop).toBe(100);
    stream.scrollTop = 800;
    vm.selectedId = 'another-item';
    tick.mock.calls[0][0]();
    expect(stream.scrollTop).toBe(800);
    vm.selectedId = 'item';
    vm.agentId = 'another-agent';
    tick.mock.calls[0][0]();
    expect(stream.scrollTop).toBe(800);
    vm.agentId = 'agent';
    vm.$refs.detailScroll = {};
    tick.mock.calls[0][0]();
    expect(stream.scrollTop).toBe(800);
  });

  it('routes a Coordinator question to the Coordinator, not an arbitrary current Action', () => {
    const selected = { status: 'waiting', currentActionId: 'a2', actions: [waiting], messages: [
      { role: 'assistant', decision: { kind: 'request_human', question: 'May we use a worktree?' } },
      { role: 'user', text: 'Additional context' },
    ] };
    expect(Page.computed.waitingPrompt.call({ selected })).toEqual({ question: 'May we use a worktree?', action: null });
    selected.messages[0].recovery = { actionId: 'a2', actionGeneration: 2 };
    expect(Page.computed.waitingPrompt.call({ selected }).action).toBe(waiting);
    selected.messages[0].recovery.actionGeneration = 1;
    expect(Page.computed.waitingPrompt.call({ selected }).action).toBeNull();
    selected.status = 'done';
    expect(Page.computed.waitingPrompt.call({ selected })).toBeNull();
  });

  it('uses the waiting Action question without a Coordinator decision', () => {
    expect(Page.computed.waitingPrompt.call({ selected: {
      status: 'waiting', currentActionId: 'a2', actions: [waiting], messages: [],
    } })).toEqual({ question: 'Which branch?', action: waiting });
  });

  it.each([en, zh])('offers an explicit Action reply only when usable', async locale => {
    wrapper = mount(ActionDetail, { props: { action: waiting, canMessage: true }, global: {
      mocks: { $t: key => locale[key] || key }, stubs: ['UserTurnBlock', 'VpTurnBlock'],
    } });
    const button = wrapper.find('.work-center-action-waiting button');
    expect(button.text()).toBe(locale['workCenter.replyToAction']);
    await button.trigger('click');
    expect(wrapper.emitted('reply')).toEqual([[waiting]]);
    await wrapper.setProps({ replyDisabled: true });
    expect(button.attributes('disabled')).toBeDefined();
    await wrapper.setProps({ canMessage: false });
    expect(wrapper.find('.work-center-action-waiting button').exists()).toBe(false);
  });

  it('selects and focuses a reply without sending or replacing the draft', async () => {
    const focus = vi.fn();
    const vm = {
      replyEntryDisabled: false, canMessageAction: () => true, coordinatorThinking: false,
      workItemMessage: 'Keep the existing diff', composerTargetValue: 'coordinator',
      $refs: { shell: { clientWidth: 320 }, workItemComposer: { getTextarea: () => ({ focus }) } },
      saveComposerDraft: vi.fn(), closeContentPanel: vi.fn(), $nextTick: callback => callback(),
    };
    Page.methods.replyToWaitingPrompt.call(vm, waiting);
    expect(vm.composerTargetValue).toBe('action:a2:2');
    expect(vm.workItemMessage).toBe('Keep the existing diff');
    expect(focus).toHaveBeenCalledOnce();
    expect(vm.closeContentPanel).toHaveBeenCalledOnce();
    vm.replyEntryDisabled = true;
    Page.methods.replyToWaitingPrompt.call(vm);
    expect(vm.composerTargetValue).toBe('action:a2:2');
  });

  it('preserves only the allowlisted pre-apply rejection code across the wire', () => {
    for (const errorCode of ['WORK_CENTER_INPUT_STALE', undefined, 'OTHER_FAILURE']) {
      const reject = vi.fn();
      const store = { workCenterPending: { r: { reject, timer: setTimeout(() => {}, 1000) } } };
      handleMessage(store, { type: 'work_center_response', requestId: 'r', ok: false, error: 'Rejected', errorCode });
      expect(reject.mock.calls[0][0].code).toBe(errorCode === 'WORK_CENTER_INPUT_STALE' ? errorCode : undefined);
      expect(store.workCenterPending.r).toBeUndefined();
    }
  });

  it.each(['WORK_CENTER_INPUT_STALE', undefined])('unlocks only a confirmed rejection and keeps all draft content (%s)', async code => {
    const envelope = Vue.ref({ workItemId: 'item', clientMessageId: 'client' });
    const failure = Object.assign(new Error('Request failed'), { code });
    const store = {
      postWorkItemMessage: vi.fn().mockRejectedValue(failure),
      loadWorkCenterMessageEnvelope: () => envelope.value,
      discardWorkCenterMessageEnvelope: vi.fn(() => { envelope.value = null; return true; }),
      getWorkItem: vi.fn().mockResolvedValue({}),
    };
    wrapper = mount({
      template: '<div/>',
      data: () => ({
        selected: { id: 'item', revision: 1 }, selectedId: 'item', agentId: 'agent',
        workItemComposerScope: 'agent:item:1', composerCanSend: true, composerTargetValue: 'action:a2:2',
        composerTargetAction: waiting, composerTargetIsCoordinator: false, canonicalMessageWireSupported: true,
        workItemMessage: 'Use a new worktree', workItemMessageQuote: null,
        workItemMessageAttachments: [{ fileId: 'file', name: 'note.txt', size: 12 }],
        actionInputRequestGeneration: 0, workItemMessageSending: false, workItemMessageError: '',
        preserveComposerOnEnvelopeClear: false, store,
      }),
      computed: { pendingMessageEnvelope: () => envelope.value },
      watch: { pendingMessageEnvelope: Page.watch.pendingMessageEnvelope },
      methods: {
        send: Page.methods.sendSelectedWorkItemMessage,
        clearPendingMessageEnvelope: Page.methods.clearPendingMessageEnvelope,
        saveComposerDraft: vi.fn(),
      },
    }, { global: { mocks: { $t: key => en[key] || key } } });
    await wrapper.vm.send();
    await flushPromises();
    expect(wrapper.vm.workItemMessage).toBe('Use a new worktree');
    expect(wrapper.vm.workItemMessageAttachments[0].fileId).toBe('file');
    expect(wrapper.vm.workItemMessageSending).toBe(false);
    expect(envelope.value === null).toBe(code === 'WORK_CENTER_INPUT_STALE');
    expect(store.getWorkItem).toHaveBeenCalledTimes(code ? 1 : 0);
    expect(wrapper.vm.workItemMessageError).toBe(code ? en['workCenter.inputStale'] : 'Request failed');
  });

  it('switches the create Agent only through an explicit available selection', () => {
    const vm = { saving: false, agentId: 'a', onlineAgents: [{ id: 'a' }, { id: 'b' }],
      selectWorkCenterAgent: vi.fn(), createAgentSelection: null };
    for (const id of ['a', 'offline', 'unknown']) Page.methods.selectCreateAgent.call(vm, id);
    expect(vm.selectWorkCenterAgent).not.toHaveBeenCalled();
    Page.methods.selectCreateAgent.call(vm, 'b');
    expect(vm.createAgentSelection).toBe('b');
    expect(vm.selectWorkCenterAgent).toHaveBeenCalledExactlyOnceWith('b');
    vm.saving = true;
    Page.methods.selectCreateAgent.call(vm, 'b');
    expect(vm.selectWorkCenterAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit create draft open but clears Agent-owned context and late upload/history results', async () => {
    let finishUpload, finishHistory;
    const vm = {
      ...Page.data(), agentId: 'a', createOpen: true, workDirTouched: true, startTouched: true,
      workItemAttachmentsSupported: true,
      createAttachments: [{ fileId: 'old-file' }],
      form: { requirement: 'Keep my request', workDir: '/agent-a/private', deliveryTarget: 'response',
        deliveryInstructions: 'Summarize results', start: false, scheduled: true, scheduleDraft: {} },
      store: {
        workCenterAgentId: 'a', workCenterCreateDraft: { sourceAgentId: 'a', requirement: 'Keep my request',
          origin: { sessionId: 'private-session' }, linkedSessionIds: ['private-session'] },
        listWorkItems: vi.fn().mockResolvedValue([]), loadWorkCenterSettings: vi.fn().mockResolvedValue(null),
        loadWorkCenterDeliveryInstructions: vi.fn(() => new Promise(resolve => { finishHistory = resolve; })),
      },
      closeFolderPicker: vi.fn(), createDefaultWorkDir: '/agent-b/project', createDefaultStart: true,
      resetCreateExecutionContext: Page.methods.resetCreateExecutionContext,
      applyCreateDefaults: Page.methods.applyCreateDefaults, loadDeliveryInstructionOptions: vi.fn(),
      uploadPendingAttachments: () => new Promise(resolve => { finishUpload = resolve; }),
    };
    const upload = Page.methods.addCreateAttachments.call(vm, [{ name: 'late.png' }]);
    const history = Page.methods.loadDeliveryInstructionOptions.call(vm);
    vm.agentId = 'b';
    vm.store.workCenterAgentId = 'b';
    vm.createAgentSelection = 'b';
    Page.watch.agentId.handler.call(vm, 'b', 'a');
    expect(vm.createOpen).toBe(true);
    expect(vm.form).toMatchObject({ requirement: 'Keep my request', workDir: '/agent-b/project',
      deliveryInstructions: 'Summarize results', deliveryTarget: 'response', start: true, scheduled: false });
    expect(vm.createAttachments).toEqual([]);
    expect(vm.store.workCenterCreateDraft).toMatchObject({ sourceAgentId: 'b', origin: null, linkedSessionIds: [] });
    expect(vm.store.loadWorkCenterSettings).toHaveBeenCalledWith('b');
    expect(vm.loadDeliveryInstructionOptions).toHaveBeenCalledOnce();
    finishUpload([{ fileId: 'late-file' }]);
    finishHistory(['Private Agent A goal']);
    await Promise.all([upload, history]);
    expect(vm.createAttachments).toEqual([]);
    expect(vm.deliveryInstructionOptions).toEqual([]);
    expect(vm.attachmentsUploading).toBe(false);
    // An implicit offline/fallback Agent change retains the existing close behavior.
    vm.workDirTouched = true;
    vm.agentId = null;
    vm.store.workCenterAgentId = null;
    Page.watch.agentId.handler.call(vm, null, 'b');
    expect(vm.createOpen).toBe(false);
  });

  it('unifies built-in, custom and historical delivery without hidden goals or extra permissions', () => {
    const vm = { ...Page.data(), $t: key => en[key], deliveryInstructionOptions: ['Ship the report'],
      deliveryTargetLabel: value => value || 'Ask' };
    const options = Page.computed.deliveryTargetOptions.call(vm);
    expect(options.map(option => option.value)).toContain('custom');
    expect(options.at(-1)).toEqual({ value: 'history:Ship the report', label: 'Ship the report' });
    const choose = value => Page.computed.deliveryTargetChoice.set.call(vm, value);
    choose('history:Ship the report');
    expect(vm.form).toMatchObject({ deliveryTarget: '', deliveryInstructions: 'Ship the report' });
    expect(vm.customDeliveryTarget).toBe(true);
    choose('pull_request');
    expect(vm.form).toMatchObject({ deliveryTarget: 'pull_request', deliveryInstructions: '' });
    expect(vm.customDeliveryTarget).toBe(false);
    choose('custom');
    expect(vm.form.deliveryTarget).toBe('');
    expect(Page.computed.deliveryTargetChoice.get.call(vm)).toBe('custom');
  });

  it('uses themed Agent options with offline choices disabled', () => {
    const options = Page.computed.createAgentOptions.call({ sidebarAgents: [
      { id: 'a', name: 'C1', online: true }, { id: 'b', online: false },
    ], $t: key => en[key] });
    expect(options).toEqual([
      { value: 'a', label: 'C1', badge: '', disabled: false },
      { value: 'b', label: 'b', badge: 'Offline', disabled: true },
    ]);
  });

  it('rejects an empty custom goal and always enables scoped memory on creation', async () => {
    const store = { createWorkItem: vi.fn().mockResolvedValue({ id: 'new-item' }) };
    const vm = { ...Page.data(), store, agentId: 'a', customDeliveryTarget: true,
      form: { requirement: 'Request', workDir: '/tmp/test', deliveryTarget: 'merge', deliveryInstructions: '  ', reuseMemory: false },
      openWorkItem: vi.fn() };
    await Page.methods.submitCreate.call(vm);
    expect(store.createWorkItem).not.toHaveBeenCalled();
    vm.form.deliveryInstructions = 'Report the result';
    await Page.methods.submitCreate.call(vm);
    expect(store.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({ deliveryTarget: null,
      deliveryInstructions: 'Report the result', reuseMemory: true }), 'a');
    expect(vm.customDeliveryTarget).toBe(false);
  });

  it('does not submit a create while uploading, saving or without an Agent', async () => {
    const store = { createWorkItem: vi.fn() };
    for (const state of [{ attachmentsUploading: true, agentId: 'a' }, { saving: true, agentId: 'a' }, { agentId: null }]) {
      await Page.methods.submitCreate.call({ ...state, store, form: { requirement: 'Request', workDir: '/tmp/test' } });
    }
    expect(store.createWorkItem).not.toHaveBeenCalled();
  });

});
