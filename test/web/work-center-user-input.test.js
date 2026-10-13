// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../web/i18n/en.js';

globalThis.Vue = Vue;
globalThis.Pinia = { defineStore: () => () => ({}) };
const { default: Page } = await import('../../web/components/WorkCenterPage.js');

let wrapper;
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); });
const waiting = { id: 'a2', generation: 2, status: 'waiting', canonicalResult: { waitingReason: 'Which branch?' } };

describe('Work Center explicit user input', () => {
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
});
