// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceControl, { budgetAdditions } from '../../web/components/WorkCenterResourceControl.js';
import { isWorkItemDetailStale, mergeWorkItemSummary } from '../../web/stores/helpers/work-center.js';
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
  });
});

describe('Work Center resource store wire and scope', () => {
  function context() {
    const state = { currentAgent: 'agent-b', workCenterAgentId: 'agent-b', _workCenterListFiltersByAgent: {},
      _workCenterDetailRequestGenerationByAgent: {}, workCenterDetailByAgent: {},
      workCenterRequest: vi.fn(async () => itemFixture()), listWorkItems: vi.fn(async () => {}), workItemDeleted: () => false,
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
