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
});
