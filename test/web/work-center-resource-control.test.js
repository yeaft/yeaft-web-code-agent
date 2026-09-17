// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceControl, { budgetAdditions } from '../../web/components/WorkCenterResourceControl.js';
import { applyWorkItemSummary, isWorkItemDetailStale, mergeWorkItemDetail, mergeWorkItemSummary } from '../../web/stores/helpers/work-center.js';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

// Capture the real store actions without booting a socket or browser owner.
const stores = {};
globalThis.Pinia = { defineStore: (id, options) => { stores[id] = options; return () => ({}); } };
await import('../../web/stores/chat.js');
const actions = stores.chat.actions;

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
  it('accepts only nonempty positive safe integer additions for all five limits', () => {
    for (const value of ['0', '-1', '1.5', '1e3', 'NaN', 'Infinity', '9007199254740992']) {
      expect(budgetAdditions({ maxRequests: value }, limits)).toBeNull();
    }
    expect(budgetAdditions({}, limits)).toBeNull();
    expect(budgetAdditions({ maxRequests: String(Number.MAX_SAFE_INTEGER) }, limits)).toBeNull();
    expect(budgetAdditions(Object.fromEntries(Object.keys(limits).map(key => [key, '2'])), limits))
      .toEqual(Object.fromEntries(Object.keys(limits).map(key => [key, 2])));
    expect(budgetAdditions({ maxRequests: ' 1 ', maxTokens: '' }, limits)).toEqual({ maxRequests: 1 });
  });

  it.each([en, zh])('shows localized totals, both consumers and unknown usage without adding reservations twice', locale => {
    setup(locale);
    expect(wrapper.text()).not.toContain('workCenter.resource.');
    expect(wrapper.find('.work-center-resource-totals').text()).toContain('200 / 200');
    expect(wrapper.find('.work-center-resource-totals').text()).toContain('1,500 / 2,000,000');
    expect(wrapper.findAll('.work-center-resource-breakdown > div')).toHaveLength(3);
    expect(wrapper.text()).toContain(locale['workCenter.resource.stop.work_item_requests_exhausted']);
    expect(wrapper.text()).toContain('500');
    expect(wrapper.text()).toContain('1,000');
  });

  it.each([en, zh])('localizes every stop code with a safe fallback for newer Agents', async locale => {
    const { item } = setup(locale);
    for (const code of ['work_item_requests_exhausted', 'work_item_tokens_exhausted', 'run_requests_exhausted', 'action_attempts_exhausted', 'coordinator_failures_exhausted']) {
      item.executionControl.stopReason = { code };
      await flushPromises();
      expect(wrapper.find('.work-center-resource-stop').text()).toBe(locale[`workCenter.resource.stop.${code}`]);
    }
    item.executionControl.stopReason = { code: 'future_reason' };
    await flushPromises();
    expect(wrapper.find('.work-center-resource-stop').text()).toBe(locale['workCenter.resource.stopped']);
  });

  it('disables mutations while the parent detail is loading or stale; supports cancelled resource-aware resume', async () => {
    const { item, store } = setup();
    await wrapper.setProps({ disabled: true });
    await wrapper.vm.changeBudget('resume');
    expect(store.resumeWorkItem).not.toHaveBeenCalled();
    expect(button('Extend budget').attributes('disabled')).toBeDefined();
    await wrapper.setProps({ disabled: false });
    item.executionControl.stopReason = null;
    item.status = 'cancelled';
    await flushPromises();
    await button('Resume work item').trigger('click');
    expect(store.resumeWorkItem).toHaveBeenCalledWith('item', 4, 'agent-a', 7);
  });

  it('extends all fields explicitly without resuming; resume uses latest contract and resource CAS', async () => {
    const { item, store } = setup();
    await button('Extend budget').trigger('click');
    expect(button('Confirm budget addition').attributes('disabled')).toBeDefined();
    for (const key of Object.keys(limits)) await wrapper.find(`[name="${key}"]`).setValue('2');
    expect(wrapper.text()).toContain('ALL current and future Actions');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(store.extendWorkItemBudget).toHaveBeenCalledWith('item', 7, Object.fromEntries(Object.keys(limits).map(key => [key, 2])), 'agent-a');
    expect(store.resumeWorkItem).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Execution was not resumed');
    item.revision = 5;
    await button('Resume work item').trigger('click');
    expect(store.resumeWorkItem).toHaveBeenCalledWith('item', 5, 'agent-a', 8);
  });

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

  it.each(['extend', 'resume'])('refreshes after %s errors, never retries mutations and preserves the error', async op => {
    const { store } = setup();
    const method = op === 'extend' ? store.extendWorkItemBudget : store.resumeWorkItem;
    method.mockRejectedValueOnce(new Error('Execution control changed; refresh before changing execution budget or resuming'));
    if (op === 'extend') {
      await button('Extend budget').trigger('click');
      await wrapper.find('[name="maxRequests"]').setValue('4');
      await wrapper.find('form').trigger('submit');
    } else await button('Resume work item').trigger('click');
    await flushPromises();
    expect(method).toHaveBeenCalledTimes(1);
    expect(store.getWorkItem).toHaveBeenCalledWith('item', 'agent-a');
    expect(wrapper.find('[role="alert"]').text()).toContain('Execution control changed');
    expect(wrapper.text()).toContain('confirm a new operation');
    expect(wrapper.find('form').exists()).toBe(false);
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

  it('never rolls back an execution management revision at equal contract/timestamp; merges live summary usage', () => {
    const current = { ...itemFixture(), updatedAt: 10 };
    const stale = { ...current, updatedAt: 20, executionControl: { ...current.executionControl, revision: 6 } };
    expect(isWorkItemDetailStale(stale, current)).toBe(true);
    expect(mergeWorkItemSummary(current, stale)).toBe(current);
    const fresh = { ...current, executionControl: { ...current.executionControl, revision: 8 } };
    expect(mergeWorkItemSummary(current, fresh).executionControl.revision).toBe(8);
    const usageUpdate = { ...current, executionControl: { ...current.executionControl, usage: { ...usage, totalTokens: 900 } } };
    expect(mergeWorkItemSummary(current, usageUpdate).executionControl.usage.totalTokens).toBe(900);
    const running = { ...current, actions: [{ id: 'action', attempt: 2, progressRevision: 5 }] };
    const lateActionEvent = { ...usageUpdate, actionStats: [{ id: 'action', attempt: 1, progressRevision: 3 }] };
    expect(mergeWorkItemSummary(running, lateActionEvent).executionControl).toBe(current.executionControl);
    const newerManagement = { ...lateActionEvent, executionControl: { ...fresh.executionControl, stopReason: null } };
    expect(mergeWorkItemSummary(running, newerManagement).executionControl).toBe(newerManagement.executionControl);
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

  it('preserves an execution stop against an older same-time/same-progress snapshot', () => {
    const running = resourceSnapshot(12, 2, 200);
    const stopped = resourceSnapshot(13, 2, 200);
    stopped.status = 'needs_attention';
    stopped.executionControl = { ...stopped.executionControl, revision: 8,
      stopReason: { code: 'run_requests_exhausted', at: 10 } };
    for (const merge of [mergeWorkItemSummary, mergeWorkItemDetail, (current, incoming) => applyWorkItemSummary([current], incoming)[0]]) {
      expect(merge(stopped, running).status).toBe('needs_attention');
      expect(merge(running, stopped).status).toBe('needs_attention');
      expect(merge(stopped, running).executionControl).toEqual(stopped.executionControl);
    }
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

  it('keeps legacy Agents compatible and does not let unversioned details erase known versioned usage', () => {
    const versioned = resourceSnapshot(13, 3, 300);
    const legacy = resourceSnapshot(undefined, 2, 200, 6);
    legacy.executionControl.revision = 8;
    for (const merge of [mergeWorkItemSummary, mergeWorkItemDetail, (current, incoming) => applyWorkItemSummary([current], incoming)[0]]) {
      expect(merge(versioned, legacy).executionControl).toEqual(versioned.executionControl);
      expect(merge(legacy, versioned).executionControl).toEqual(versioned.executionControl);
    }
    expect(isWorkItemDetailStale(legacy, versioned)).toBe(true);
    const old = resourceSnapshot(undefined, 2, 200);
    const settled = resourceSnapshot(undefined, 2, 107);
    expect(mergeWorkItemSummary(old, settled).executionControl.usage.chargedTokens).toBe(107);
    expect(applyWorkItemSummary([old], settled)[0].executionControl.usage.chargedTokens).toBe(107);
  });
});

describe('Work Center resource store wire and scope', () => {
  function context() {
    const state = { currentAgent: 'agent-b', workCenterAgentId: 'agent-b', _workCenterListFiltersByAgent: {},
      _workCenterDetailRequestGenerationByAgent: {}, workCenterDetailByAgent: {},
      syncWorkCenterActivity: vi.fn(), workCenterRequest: vi.fn(async () => itemFixture()), listWorkItems: vi.fn(async () => {}), workItemDeleted: () => false,
    };
    for (const key of ['beginWorkCenterDetailWrite', 'commitWorkCenterDetail', 'resumeWorkItem', 'extendWorkItemBudget']) state[key] = actions[key].bind(state);
    return state;
  }
  it('sends exact extension and resume payloads, preserving optional old cancelled resume signature', async () => {
    const store = context();
    await store.extendWorkItemBudget('item', 7, { maxRequests: 10 }, 'agent-a');
    expect(store.workCenterRequest).toHaveBeenLastCalledWith('extend_budget', { id: 'item', executionControlRevision: 7, additions: { maxRequests: 10 } }, 'agent-a');
    expect(store.workCenterDetailByAgent['agent-a'].id).toBe('item');
    expect(store.workCenterDetailByAgent['agent-b']).toBeUndefined();
    await store.resumeWorkItem('item', 4, 'agent-a', 8);
    expect(store.workCenterRequest).toHaveBeenLastCalledWith('resume', { id: 'item', revision: 4, executionControlRevision: 8 }, 'agent-a');
    await store.resumeWorkItem('item', 4, 'agent-a');
    expect(store.workCenterRequest).toHaveBeenLastCalledWith('resume', { id: 'item', revision: 4 }, 'agent-a');
  });
  it('fences late full detail usage while still accepting lower-cost settlements and independent Action updates', async () => {
    const store = context();
    store.getWorkItem = actions.getWorkItem.bind(store);
    const three = resourceSnapshot(13, 3, 300);
    store.workCenterDetailByAgent['agent-a'] = three;
    store.workCenterRequest.mockResolvedValueOnce(resourceSnapshot(12, 2, 200));
    await store.getWorkItem('item', 'agent-a');
    expect(store.workCenterDetailByAgent['agent-a'].executionControl).toEqual(three.executionControl);
    const settled = resourceSnapshot(14, 3, 207);
    store.workCenterRequest.mockResolvedValueOnce(settled);
    await store.getWorkItem('item', 'agent-a');
    expect(store.workCenterDetailByAgent['agent-a'].executionControl).toEqual(settled.executionControl);
    store.workCenterRequest.mockResolvedValueOnce(three);
    await store.getWorkItem('item', 'agent-a');
    expect(store.workCenterDetailByAgent['agent-a'].executionControl).toEqual(settled.executionControl);
    store.workCenterRequest.mockResolvedValueOnce(resourceSnapshot(undefined, 2, 200, 6));
    await store.getWorkItem('item', 'agent-a');
    expect(store.workCenterDetailByAgent['agent-a'].executionControl).toEqual(settled.executionControl);
    expect(store.workCenterDetailByAgent['agent-a'].actions[0].progressRevision).toBe(6);
    const newerUsageOldAction = resourceSnapshot(15, 3, 107, 5);
    store.workCenterRequest.mockResolvedValueOnce(newerUsageOldAction);
    await store.getWorkItem('item', 'agent-a');
    expect(store.workCenterDetailByAgent['agent-a'].executionControl).toEqual(newerUsageOldAction.executionControl);
    expect(store.workCenterDetailByAgent['agent-a'].actions[0].progressRevision).toBe(6);
  });

  it.each(['current rows', 'cached event outside current query'])('fences old list pages against %s, including events preceding the request', async source => {
    const store = { ...stores.chat.state(), currentAgent: 'agent-a', workCenterAgentId: 'agent-a',
      workItemDeleted: () => false, workCenterRequest: vi.fn(), syncWorkCenterActivity: vi.fn(),
    };
    for (const key of ['listWorkItems', 'loadMoreWorkItems', 'workItemMatchesBoardQuery', 'applyWorkItemBoardSummary']) {
      store[key] = actions[key].bind(store);
    }
    const two = resourceSnapshot(12, 2, 200);
    const three = resourceSnapshot(13, 3, 300);
    if (source === 'current rows') store.workCenterItemsByAgent['agent-a'] = [three];
    else {
      store._workCenterListEventGenerationByAgent['agent-a'] = 1;
      store._workCenterListEventsByAgent['agent-a'] = { item: { summary: three, generation: 1, queryKey: 'another-query' } };
    }
    store.workCenterRequest.mockResolvedValueOnce({ items: [two], nextCursor: 'page2' });
    await store.listWorkItems('agent-a');
    expect(store.workCenterItemsByAgent['agent-a'][0].executionControl).toEqual(three.executionControl);
    const settled = resourceSnapshot(14, 3, 207);
    store.workCenterRequest.mockResolvedValueOnce({ items: [settled], nextCursor: 'page2' });
    await store.listWorkItems('agent-a');
    expect(store.workCenterItemsByAgent['agent-a'][0].executionControl).toEqual(settled.executionControl);
    store.workCenterRequest.mockResolvedValueOnce({ items: [three], nextCursor: 'page3' });
    await store.loadMoreWorkItems('agent-a');
    expect(store.workCenterItemsByAgent['agent-a'][0].executionControl).toEqual(settled.executionControl);
    // A cached off-page event must also fence a previously unseen old row.
    store.workCenterItemsByAgent['agent-a'] = [];
    store._workCenterListEventsByAgent['agent-a'] = { item: { summary: settled, generation: 1, queryKey: 'another-query' } };
    store.workCenterRequest.mockResolvedValueOnce({ items: [three] });
    await store.loadMoreWorkItems('agent-a');
    expect(store.workCenterItemsByAgent['agent-a'][0].executionControl).toEqual(settled.executionControl);
  });

  it('does not overwrite a newer detail selection when extension completes late', async () => {
    const store = context();
    let resolve;
    store.workCenterRequest.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = store.extendWorkItemBudget('item', 7, { maxRequests: 10 }, 'agent-a');
    store.beginWorkCenterDetailWrite('agent-a');
    store.workCenterDetailByAgent['agent-a'] = { id: 'other' };
    resolve(itemFixture());
    await pending;
    expect(store.workCenterDetailByAgent['agent-a'].id).toBe('other');
  });
});
