// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import * as Vue from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceControl from '../../web/components/WorkCenterResourceControl.js';
import { applyWorkItemSummary, isWorkItemDetailStale, mergeWorkItemDetail, mergeWorkItemSummary } from '../../web/stores/helpers/work-center.js';
import en from '../../web/i18n/en.js';

const { reactive } = Vue;

// Capture the real store actions without booting a socket or browser owner.
const stores = {};
globalThis.Pinia = { defineStore: (id, options) => { stores[id] = options; return () => ({}); } };
await import('../../web/stores/chat.js');

globalThis.Vue = Vue;

const limits = { maxRequests: 200, maxTokens: 2000000, maxRunRequests: 40, maxActionAttempts: 3, maxCoordinatorFailures: 3 };
const usage = { llmRequestCount: 200, totalTokens: 500, chargedTokens: 1500, reservedTokens: 1000, unknownRequests: 1, inFlightRequests: 1 };
const itemFixture = () => ({
  id: 'item', revision: 4, status: 'needs_attention',
  executionControl: {
    revision: 7, limits: { ...limits }, usage, coordinatorFailures: 1,
    breakdown: { coordinator: { ...usage, llmRequestCount: 20 }, actions: { ...usage, llmRequestCount: 180 } },
    stopReason: { code: 'work_item_requests_exhausted' },
  },
});
let wrapper;
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); });
function setup(locale = en) {
  const item = reactive(itemFixture());
  const store = reactive({
    connectionState: 'connected', agents: [{ id: 'agent-a', online: true }],
    extendWorkItemBudget: vi.fn(async () => { item.executionControl.revision += 1; }),
    resumeWorkItem: vi.fn(async () => {}),
    getWorkItem: vi.fn(async () => { item.executionControl.revision += 1; return item; }),
  });
  globalThis.Pinia.useChatStore = () => store;
  wrapper = mount(ResourceControl, { props: { item, agentId: 'agent-a' }, global: { mocks: {
    $t: (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), locale[key] || key),
  } } });
  return { item, store };
}
const button = text => wrapper.findAll('button').find(node => node.text() === text);

function resourceSnapshot(dataRevision, requests, chargedTokens, progressRevision = 5) {
  const action = { id: 'action', generation: 1, attempt: 1, progressRevision, status: 'running' };
  const resourceUsage = { ...usage, llmRequestCount: requests, chargedTokens, reservedTokens: chargedTokens };
  return {
    ...itemFixture(), updatedAt: 10, coordinatorRevision: 2, status: 'running',
    actions: [action], actionStats: [action],
    executionControl: { ...itemFixture().executionControl, dataRevision, usage: resourceUsage,
      breakdown: { coordinator: { llmRequestCount: 0 }, actions: resourceUsage }, stopReason: null },
  };
}

describe('Work Center resource control', () => {

  it('requires refresh and new confirmation when the budget changes during editing', async () => {
    const { item, store } = setup();
    await button('Extend budget').trigger('click');
    await wrapper.find('[name="maxRequests"]').setValue('3');
    item.executionControl.revision = 9;
    await flushPromises();
    expect(button('Confirm budget addition').attributes('disabled')).toBeDefined();
    await wrapper.find('form').trigger('submit');
    expect(store.extendWorkItemBudget).not.toHaveBeenCalled();
    await button('Refresh resource state').trigger('click');
    await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
    await button('Extend budget').trigger('click');
    expect(wrapper.find('[name="maxRequests"]').element.value).toBe('');
    await wrapper.find('[name="maxRequests"]').setValue('3');
    await wrapper.find('form').trigger('submit');
    expect(store.extendWorkItemBudget).toHaveBeenCalledWith('item', 10, { maxRequests: 3 }, 'agent-a');
  });

  it('keeps mutations disabled after failed refresh or reconnect until a successful explicit refresh', async () => {
    const { store } = setup();
    store.resumeWorkItem.mockRejectedValueOnce(new Error('timeout'));
    store.getWorkItem.mockRejectedValueOnce(new Error('offline'));
    await button('Resume work item').trigger('click');
    await flushPromises();
    expect(button('Resume work item').attributes('disabled')).toBeDefined();
    store.connectionState = 'reconnecting';
    await flushPromises();
    expect(button('Refresh resource state').attributes('disabled')).toBeDefined();
    store.connectionState = 'connected';
    await flushPromises();
    expect(button('Resume work item').attributes('disabled')).toBeDefined();
    await button('Refresh resource state').trigger('click');
    await flushPromises();
    expect(button('Resume work item').attributes('disabled')).toBeUndefined();
    expect(store.resumeWorkItem).toHaveBeenCalledTimes(1);
  });

  it('fences pending operations and unmounted Agent scope; ignores a late error without refreshing another item', async () => {
    const { store } = setup();
    let reject;
    store.resumeWorkItem.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    await button('Resume work item').trigger('click');
    expect(button('Resume work item').attributes('disabled')).toBeDefined();
    expect(wrapper.attributes('aria-busy')).toBe('true');
    await wrapper.vm.changeBudget('resume');
    expect(store.resumeWorkItem).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    reject(new Error('late failure'));
    await flushPromises();
    expect(store.getWorkItem).not.toHaveBeenCalled();
  });
});

describe('independently ordered Work Center resource snapshots', () => {
  it('rejects delayed reservations and accepts lower-cost settlement at identical control/goal/Action/time revisions', () => {
    const two = resourceSnapshot(12, 2, 200);
    const three = resourceSnapshot(13, 3, 300);
    const settled = resourceSnapshot(14, 3, 207);
    settled.executionControl.usage.reservedTokens = 200;
    settled.executionControl.usage.totalTokens = 7;
    for (const merge of [mergeWorkItemSummary, mergeWorkItemDetail, (current, incoming) => applyWorkItemSummary([current], incoming)[0]]) {
      let current = merge(two, three);
      expect(current.executionControl).toEqual(three.executionControl);
      current = merge(current, two);
      expect(current.executionControl).toEqual(three.executionControl);
      current = merge(current, settled);
      expect(current.executionControl).toEqual(settled.executionControl);
      current = merge(current, three);
      expect(current.executionControl).toEqual(settled.executionControl);
    }
    expect(isWorkItemDetailStale(two, three)).toBe(true);
    expect(isWorkItemDetailStale(three, settled)).toBe(true);
    expect(isWorkItemDetailStale(settled, three)).toBe(false);
  });

  it('merges resource and Action versions independently in both directions', () => {
    const actionNewer = resourceSnapshot(12, 2, 200, 6);
    const resourceNewer = resourceSnapshot(13, 3, 300, 5);
    for (const [snapshot, loops] of [[actionNewer, 6], [resourceNewer, 5]]) {
      snapshot.executionStats = { loopCount: loops, toolCount: loops * 2,
        llmRequestCount: snapshot.executionControl.usage.llmRequestCount,
        inputTokens: loops * 10, outputTokens: loops, cacheReadTokens: loops, cacheWriteTokens: loops, totalTokens: loops * 13 };
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
        snapshot.executionControl.usage[key] = snapshot.executionStats[key];
      }
    }
    for (const merge of [mergeWorkItemSummary, mergeWorkItemDetail, (current, incoming) => applyWorkItemSummary([current], incoming)[0]]) {
      const freshUsage = merge(actionNewer, resourceNewer);
      expect(freshUsage.executionControl).toEqual(resourceNewer.executionControl);
      expect((freshUsage.actionStats || freshUsage.actions)[0].progressRevision).toBe(6);
      const freshAction = merge(resourceNewer, actionNewer);
      expect(freshAction.executionControl).toEqual(resourceNewer.executionControl);
      for (const combined of [freshUsage, freshAction]) {
        expect(combined.executionStats).toEqual({ ...resourceNewer.executionStats, loopCount: 6, toolCount: 12 });
      }
      expect((freshAction.actions || freshAction.actionStats)[0].progressRevision).toBe(6);
      const olderState = { ...resourceSnapshot(14, 3, 207), revision: 3, updatedAt: 5 };
      const settled = merge(freshAction, olderState);
      expect(settled.executionControl).toEqual(olderState.executionControl);
      expect(settled.revision).toBe(4);
      expect(settled.updatedAt).toBe(10);
    }
  });
});
