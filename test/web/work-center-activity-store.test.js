// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive, nextTick } from 'vue';
import { workCenterActivityActions, orderWorkCenterActions, workCenterActionTime, workCenterItemTime } from '../../web/stores/helpers/work-center.js';
import { projectWorkItemSummary } from '../../agent/yeaft/work-center/projection.js';
import WorkCenterSidebar from '../../web/components/WorkCenterSidebar.js';
import { bindWorkCenterBrowserOwner, clearWorkCenterBrowserOwner } from '../../web/stores/helpers/work-center-browser-state.js';

const stores = {};
const authState = {};
globalThis.Pinia = {
  defineStore: (id, options) => {
    stores[id] = options;
    return () => id === 'auth' ? authState : {};
  },
};
await import('../../web/stores/chat.js');
const { handleMessage } = await import('../../web/stores/helpers/messageHandler.js');
const definition = stores.chat;

function createStore(overrides = {}) {
  const store = { ...definition.state(), ...definition.actions, ...overrides };
  store.workCenterRequest ||= vi.fn();
  return store;
}

function item(id, status, revision = 1, progressRevision = revision) {
  return {
    id,
    status,
    revision,
    updatedAt: revision,
    currentActionId: `${id}-action`,
    actionStats: [{ id: `${id}-action`, generation: 1, attempt: 1, progressRevision, status: 'running' }],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => { localStorage.clear(); clearWorkCenterBrowserOwner(); });

describe('Work Center activity store', () => {
  it('loads exact active statuses independently from board filters and detail state', async () => {
    const detail = { id: 'selected', actions: [{ id: 'full-detail' }] };
    const store = createStore({
      workCenterAgentId: 'agent-a',
      workCenterDetailByAgent: { 'agent-a': detail },
      _workCenterListFiltersByAgent: { 'agent-a': { lane: 'closed', keyword: 'unrelated' } },
    });
    store.workCenterRequest = vi.fn(async (op, payload, agentId) => ({
      items: [item(`${agentId}-${payload.status}`, payload.status)], nextCursor: null,
    }));

    await store.loadWorkCenterActivity('agent-a');

    expect(store.workCenterRequest.mock.calls.map(([, payload]) => payload)).toEqual([
      { status: 'running', limit: 100 },
      { status: 'waiting', limit: 100 },
    ]);
    expect(store.workCenterRequest).not.toHaveBeenCalledWith('get', expect.anything(), expect.anything());
    expect(store.workCenterActivityByAgent['agent-a'].map(row => row.status).sort()).toEqual(['running', 'waiting']);
    expect(store.workCenterDetailByAgent['agent-a']).toBe(detail);
    expect(store.workCenterItemsByAgent['agent-a']).toBeUndefined();
  });

  it('preserves a newer event over an in-flight snapshot and removes terminal or deleted items', async () => {
    const running = deferred();
    const waiting = deferred();
    const store = createStore();
    store.workCenterRequest = vi.fn((op, payload) => (
      payload.status === 'running' ? running.promise : waiting.promise
    ));

    const load = store.loadWorkCenterActivity('agent-a');
    store.applyWorkCenterEvent('agent-a', { type: 'run.progress', workItem: item('one', 'running', 3, 8) });
    running.resolve({ items: [item('one', 'running', 2, 4)], nextCursor: null });
    waiting.resolve({ items: [], nextCursor: null });
    await load;

    expect(store.workCenterActivityByAgent['agent-a'][0].revision).toBe(3);
    expect(store.workCenterActivityByAgent['agent-a'][0].actionStats[0].progressRevision).toBe(8);
    store.applyWorkCenterEvent('agent-a', { type: 'work_item.updated', workItem: item('one', 'done', 4, 9) });
    expect(store.workCenterActivityByAgent['agent-a']).toEqual([]);
    store.applyWorkCenterEvent('agent-a', { type: 'work_item.updated', workItem: item('two', 'waiting', 1) });
    store.applyWorkCenterEvent('agent-a', { type: 'work_item.deleted', workItem: item('two', 'waiting', 2) });
    expect(store.workCenterActivityByAgent['agent-a']).toEqual([]);
  });

  it('isolates Agent snapshots and events', async () => {
    const store = createStore();
    store.workCenterRequest = vi.fn(async (op, payload, agentId) => ({
      items: payload.status === 'running' ? [item(`${agentId}-item`, 'running')] : [],
      nextCursor: null,
    }));

    await Promise.all([
      store.loadWorkCenterActivity('agent-a'),
      store.loadWorkCenterActivity('agent-b'),
    ]);
    store.applyWorkCenterEvent('agent-a', {
      type: 'work_item.updated', workItem: item('agent-a-event', 'waiting'),
    });

    expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id).sort())
      .toEqual(['agent-a-event', 'agent-a-item']);
    expect(store.workCenterActivityByAgent['agent-b'].map(row => row.id)).toEqual(['agent-b-item']);
  });

  it('uses bounded cursor pagination, stops repeated cursors, and preserves stale data on error', async () => {
    const store = createStore({ workCenterActivityByAgent: { 'agent-a': [item('old', 'running')] } });
    store.workCenterRequest = vi.fn(async (op, payload) => {
      if (payload.status === 'waiting') throw new Error('offline');
      return { items: [item('page', 'running')], nextCursor: 'same-cursor' };
    });

    await expect(store.loadWorkCenterActivity('agent-a')).rejects.toThrow('offline');

    const runningCalls = store.workCenterRequest.mock.calls.filter(([, payload]) => payload.status === 'running');
    expect(runningCalls).toHaveLength(2);
    expect(runningCalls[1][1].cursor).toBe('same-cursor');
    expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['old']);
    expect(store.workCenterActivityLoadingByAgent['agent-a']).toBe(false);
    expect(store.workCenterActivityErrorByAgent['agent-a']).toBe('offline');
  });

  it('ignores stale load generations and pending snapshots after owner reset', async () => {
    const requests = [];
    const store = createStore();
    store.workCenterRequest = vi.fn(() => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    });

    const first = store.loadWorkCenterActivity('agent-a');
    const second = store.loadWorkCenterActivity('agent-a');
    requests[2].resolve({ items: [item('new', 'running', 2)], nextCursor: null });
    requests[3].resolve({ items: [], nextCursor: null });
    await second;
    requests[0].resolve({ items: [item('old', 'running', 1)], nextCursor: null });
    requests[1].resolve({ items: [], nextCursor: null });
    await first;
    expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['new']);

    const pending = store.loadWorkCenterActivity('agent-a');
    store.clearWorkCenterActivityState();
    requests[4].resolve({ items: [item('foreign-owner', 'running', 9)], nextCursor: null });
    requests[5].resolve({ items: [], nextCursor: null });
    await pending;
    expect(store.workCenterActivityByAgent).toEqual({});
    expect(store.workCenterActivityLoadingByAgent).toEqual({});
    expect(store.workCenterActivityErrorByAgent).toEqual({});
  });

  it('keeps canonical board fields on equal identity and rejects late older attempts', () => {
    const live = item('one', 'running', 2, 5);
    live.actionStats[0] = { ...live.actionStats[0], attempt: 2, response: 'current partial' };
    const canonical = structuredClone(live);
    delete canonical.actionStats[0].response;
    const store = createStore();
    store.applyWorkCenterEvent('agent-a', { type: 'run.progress', workItem: live });
    store.workCenterItemsByAgent['agent-a'] = [canonical];
    const older = item('one', 'running', 2, 4);
    store.applyWorkCenterEvent('agent-a', { type: 'run.finished', workItem: older });
    expect(store.workCenterItemsByAgent['agent-a']).toEqual([canonical]);
    expect(store.workCenterActivityByAgent['agent-a']).toEqual([canonical]);
    // Activity lifecycle fences stay independent of canonical board fields.
    store.workCenterActivityByAgent['agent-a'] = [item('one', 'running', 4, 8)];
    store.applyWorkCenterEvent('agent-a', { type: 'run.progress', workItem: item('one', 'running', 3, 6) });
    expect(store.workCenterItemsByAgent['agent-a'][0].revision).toBe(3);
    expect(store.workCenterActivityByAgent['agent-a'][0].actionStats[0].progressRevision).toBe(8);
  });

  it('refreshes once after authenticated reconnect with the same online Agent and preserves detail', async () => {
    const agent = { id: 'agent-a', online: true };
    let snapshot = [item('missed-completion', 'running')];
    const store = reactive(createStore({
      agents: [agent], connectionState: 'connected', chatHistoryConnectionGeneration: 1,
      workCenterActivityConnectionGeneration: 1,
      workCenterDetailByAgent: { 'agent-a': { id: 'selected-detail' } },
    }));
    store.workCenterRequest = vi.fn(async (op, payload) => ({
      items: payload.status === 'running' ? snapshot : [],
    }));
    Pinia.useChatStore = () => store;
    const wrapper = mount(WorkCenterSidebar, {
      props: { agents: store.agents, agentId: agent.id },
      global: { mocks: { $t: key => key } },
    });
    try {
      await flushPromises();
      expect(store.workCenterRequest).toHaveBeenCalledTimes(2);
      expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['missed-completion']);
      store.connectionState = 'disconnected';
      store.chatHistoryConnectionGeneration = 2;
      await nextTick();
      snapshot = [item('new-during-disconnect', 'running')];
      store.connectionState = 'connected';
      await flushPromises();
      // Socket open is not an authenticated Agent inventory.
      expect(store.workCenterRequest).toHaveBeenCalledTimes(2);
      store.workCenterActivityConnectionGeneration = 2;
      await flushPromises();
      expect(store.workCenterRequest).toHaveBeenCalledTimes(4);
      expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['new-during-disconnect']);
      store.workCenterActivityConnectionGeneration = 2;
      await wrapper.setProps({ agents: [{ ...agent, latency: 10 }] });
      await flushPromises();
      expect(store.workCenterRequest).toHaveBeenCalledTimes(4);
      expect(store.workCenterDetailByAgent['agent-a']).toEqual({ id: 'selected-detail' });
      store.chatHistoryConnectionGeneration = 3;
      await wrapper.setProps({ agents: [{ ...agent, online: false }] });
      store.workCenterActivityConnectionGeneration = 3;
      await flushPromises();
      expect(store.workCenterRequest).toHaveBeenCalledTimes(4);
    } finally { wrapper.unmount(); }
  });

  it('reconciles a completed detail and fences stale activity snapshots/events without leaking bodies', async () => {
    const old = { ...item('one', 'running', 1), boardLane: 'active',
      actionCounts: { running: 1 }, activeAction: { id: 'one-action' },
      attentionAction: null, executors: [{ id: 'vp-a' }] };
    const store = createStore({ workCenterAgentId: 'agent-a' });
    store.applyWorkCenterEvent('agent-a', { type: 'run.progress', workItem: old });
    store.workCenterRequest = vi.fn(async () => ({
      ...item('one', 'done', 5), messages: [{ text: 'private body' }],
      actions: [{ id: 'one-action', status: 'closed', generation: 1, progressRevision: 5, response: 'private response' }],
    }));
    await store.getWorkItem('one', 'agent-a');
    expect(store.workCenterActivityByAgent['agent-a']).toEqual([]);
    const cached = store._workCenterActivityEventsByAgent['agent-a'].one.summary;
    expect(cached).not.toHaveProperty('messages');
    expect(cached.actionStats[0]).not.toHaveProperty('response');
    store.workCenterRequest = vi.fn(async () => ({ items: [old] }));
    await store.loadWorkCenterActivity('agent-a');
    store.applyWorkCenterEvent('agent-a', { type: 'run.finished', workItem: old });
    expect(store.workCenterActivityByAgent['agent-a']).toEqual([]);
    expect(store.workCenterItemsByAgent['agent-a']).toEqual([old]);
    expect(store.workCenterDetailByAgent['agent-a'].status).toBe('done');
    store.applyWorkCenterEvent('agent-a', { type: 'work_item.updated', workItem: item('one', 'running', 6) });
    expect(store.workCenterActivityByAgent['agent-a'][0].status).toBe('running');
  });

  it('a board refresh repairs missed terminal events without clearing unrelated activity', async () => {
    const store = createStore({ workCenterAgentId: 'agent-a' });
    for (const id of ['one', 'other']) store.applyWorkCenterEvent('agent-a', { type: 'run.progress', workItem: item(id, 'running') });
    store.workCenterRequest = vi.fn(async () => ({ items: [item('one', 'done', 3)] }));
    await store.listWorkItems('agent-a', { lane: 'closed' });
    expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['other']);
    store.applyWorkCenterEvent('agent-a', { type: 'run.progress', workItem: item('one', 'running', 2) });
    expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['other']);
  });

  it('accepts a new Coordinator lifecycle with no overlapping Actions and loads its reply', async () => {
    const store = createStore({ workCenterAgentId: 'agent-a' });
    const terminal = { ...item('one', 'done', 5), lifecycle: 'done', coordinatorRevision: 2,
      actions: [{ id: 'old-action', status: 'closed' }], messages: [] };
    store.workCenterDetailByAgent['agent-a'] = terminal;
    const next = { ...item('one', 'running', 6), lifecycle: 'open', coordinatorRevision: 3,
      currentActionId: null, currentAction: null, actionStats: [] };
    const detail = { ...next, actions: [], messages: [{ text: 'New plan' }] };
    store.workCenterRequest = vi.fn(async () => detail);
    store.applyWorkCenterEvent('agent-a', { type: 'coordinator.turn_completed', workItem: next });
    expect(store.workCenterDetailByAgent['agent-a']).toMatchObject({ status: 'running', lifecycle: 'open' });
    await flushPromises();
    expect(store.workCenterDetailByAgent['agent-a'].messages).toEqual([{ text: 'New plan' }]);
  });

  it.each(['done', 'cancelled'])('does not resurrect %s from equal-version list/events/details', async status => {
    const store = createStore({ workCenterAgentId: 'agent-a' });
    const terminal = { ...item('one', status, 5), lifecycle: status, coordinatorRevision: 3 };
    const running = { ...terminal, status: 'running', lifecycle: 'open' };
    store.workCenterRequest = vi.fn(async () => terminal);
    await store.getWorkItem('one', 'agent-a');
    store.workCenterRequest = vi.fn(async () => ({ items: [running] }));
    await store.loadWorkCenterActivity('agent-a');
    await store.listWorkItems('agent-a');
    store.applyWorkCenterEvent('agent-a', { type: 'work_item.updated', workItem: running });
    store.workCenterRequest = vi.fn(async () => running);
    await store.getWorkItem('one', 'agent-a');
    expect(store.workCenterActivityByAgent['agent-a']).toEqual([]);
    expect(store.workCenterDetailByAgent['agent-a'].status).toBe(status);
    store.applyWorkCenterEvent('agent-a', {
      type: 'work_item.updated', workItem: { ...running, revision: 6, updatedAt: 6 },
    });
    expect(store.workCenterActivityByAgent['agent-a'][0].status).toBe('running');
  });

  it.each(['reset', 'owner', 'connection', 'agent'])('fences late board and detail activity writes across %s changes', async change => {
    bindWorkCenterBrowserOwner('owner-a');
    const store = createStore({ workCenterAgentId: 'agent-a' });
    const list = deferred();
    const detail = deferred();
    store.workCenterRequest = vi.fn(op => op === 'list' ? list.promise : detail.promise);
    const pendingList = store.listWorkItems('agent-a');
    const pendingDetail = store.getWorkItem('one', 'agent-a');
    if (change === 'reset') store.clearWorkCenterActivityState();
    if (change === 'owner') bindWorkCenterBrowserOwner('owner-b');
    if (change === 'connection') store.chatHistoryConnectionGeneration += 1;
    if (change === 'agent') store.workCenterAgentId = 'agent-b';
    list.resolve({ items: [item('board', 'running')] });
    detail.resolve(item('one', 'running'));
    await Promise.all([pendingList, pendingDetail]);
    // Agent-scoped detail cache may finish for Agent A; it must not leak to B.
    if (change === 'agent') {
      expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['one']);
      expect(store.workCenterActivityByAgent['agent-b']).toBeUndefined();
    } else {
      expect(store.workCenterActivityByAgent).toEqual({});
      expect(store.workCenterDetailByAgent).toEqual({});
    }
    expect(store.workCenterItemsByAgent).toEqual({});
  });

  it('rejects activity from a replaced browser owner without relying on a reset listener', async () => {
    bindWorkCenterBrowserOwner('owner-a');
    const store = createStore();
    const request = deferred();
    store.workCenterRequest = vi.fn(() => request.promise);
    const pending = store.loadWorkCenterActivity('agent-a');
    bindWorkCenterBrowserOwner('owner-b');
    request.resolve({ items: [item('old-owner', 'running')], nextCursor: 'more' });
    await pending;
    expect(store.workCenterActivityByAgent).toEqual({});
    expect(store.workCenterRequest).toHaveBeenCalledTimes(2);
  });

  it('ignores pagination from a previous browser owner', async () => {
    bindWorkCenterBrowserOwner('owner-a');
    const store = createStore({ workCenterAgentId: 'agent-a' });
    store.workCenterRequest = vi.fn(async () => ({ items: [], nextCursor: 'page-2' }));
    await store.listWorkItems('agent-a');
    const page = deferred();
    store.workCenterRequest = vi.fn(() => page.promise);
    const pending = store.loadMoreWorkItems('agent-a');
    bindWorkCenterBrowserOwner('owner-b');
    page.resolve({ items: [item('old-owner', 'running')] });
    await pending;
    expect(store.workCenterActivityByAgent).toEqual({});
    expect(store.workCenterItemsByAgent['agent-a']).toEqual([]);
  });

  it('rejects events and responses from an old authenticated socket', () => {
    Object.assign(authState, { token: 'new-token', authGeneration: 2 });
    const store = createStore();
    const resolve = vi.fn();
    const timer = setTimeout(() => {}, 10000);
    store.workCenterPending.request = { timer, resolve };
    const event = { type: 'work_center_event', agentId: 'agent-a',
      event: { type: 'run.progress', workItem: item('one', 'running') },
      _wsAuthToken: 'old-token', _wsAuthGeneration: 1 };
    handleMessage(store, event);
    handleMessage(store, { ...event, type: 'work_center_response', requestId: 'request', ok: true });
    expect(store.workCenterActivityByAgent).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
    handleMessage(store, { ...event, _wsAuthToken: 'new-token', _wsAuthGeneration: 2 });
    expect(store.workCenterActivityByAgent['agent-a'][0].id).toBe('one');
    clearTimeout(timer);
  });

  it('only lists live actions by creation time, retaining the complete journal separately', () => {
    const actions = ['failed', 'closed', 'superseded', 'cancelled', 'completed', 'running', 'waiting', 'ready']
      .map((status, index) => ({ id: status, status, sequence: index + 1, createdAt: 100 + index, updatedAt: 900 - index }));
    const summary = { status: 'waiting', actionStats: actions };
    expect(workCenterActivityActions(summary).map(action => action.id)).toEqual(['ready', 'waiting', 'running']);
    expect(workCenterActivityActions({ ...summary, status: 'done' })).toEqual([]);
    expect(workCenterActivityActions({ ...summary, lifecycle: 'done' })).toEqual([]);
    expect(orderWorkCenterActions(actions).map(action => action.id)).toEqual([...actions].reverse().map(action => action.id));
    expect(actions[0].id).toBe('failed');
    expect(workCenterActivityActions({ status: 'running', currentAction: { id: 'legacy', status: 'running' } })).toHaveLength(1);
    expect(workCenterActivityActions({ ...summary, actionStats: [], currentAction: { id: 'stale', status: 'running' } })).toEqual([]);
    expect(orderWorkCenterActions([{ sequence: 1 }, { sequence: 3 }, { sequence: 2 }]).map(a => a.sequence)).toEqual([3, 2, 1]);
    expect(workCenterActionTime({ createdAt: 1e100, updatedAt: -1 })).toBe(0);
    expect(workCenterItemTime({ createdAt: 10, updatedAt: 50 })).toBe(50);
  });

  it('projects Action sequence and timestamps without exposing execution inputs', () => {
    const summary = projectWorkItemSummary({
      ...item('one', 'running'), actions: [{ id: 'action', status: 'running', sequence: 7, createdAt: 100, updatedAt: 200, prompt: 'private' }],
      runs: [], events: [],
    });
    expect(summary.actionStats[0]).toMatchObject({ sequence: 7, createdAt: 100, updatedAt: 200 });
    expect(summary.actionStats[0]).not.toHaveProperty('prompt');
  });

  it('discloses activity and each Item independently, with Agent-scoped expansion and time labels', async () => {
    const summary = { ...item('one', 'running'), title: 'One', createdAt: 1000, updatedAt: 2000, actionStats: [{ id: 'a', status: 'running', createdAt: 1000, contentSummary: 'Working' }] };
    const store = reactive(createStore({ workCenterActivityByAgent: { 'agent-a': [summary], 'agent-b': [summary] } }));
    Pinia.useChatStore = () => store;
    const wrapper = mount(WorkCenterSidebar, { attachTo: document.body, props: { agentId: 'agent-a' }, global: { mocks: { $t: key => key } } });
    try {
      expect(wrapper.get('.work-center-activity-item time').attributes('datetime')).toBe('1970-01-01T00:00:02.000Z');
      const toggle = wrapper.get('.work-center-item-disclosure');
      expect(toggle.attributes('aria-expanded')).toBe('true');
      expect(wrapper.get('.work-center-activity-actions time').attributes('datetime')).toBe('1970-01-01T00:00:01.000Z');
      await toggle.trigger('click');
      expect(wrapper.get('.work-center-activity-actions').isVisible()).toBe(false);
      expect(wrapper.emitted('select-item')).toBeUndefined();
      await wrapper.setProps({ agentId: 'agent-b' });
      expect(toggle.attributes('aria-expanded')).toBe('true');
      await wrapper.setProps({ agentId: 'agent-a' });
      expect(toggle.attributes('aria-expanded')).toBe('false');
      await wrapper.get('.work-center-activity-disclosure').trigger('click');
      expect(wrapper.get('.work-center-activity-items').isVisible()).toBe(false);
    } finally { wrapper.unmount(); }
  });

  it('rejects old-socket snapshots before starting any follow-up page', async () => {
    const requests = [];
    const store = createStore({ chatHistoryConnectionGeneration: 1 });
    store.workCenterRequest = vi.fn(() => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    });
    const oldLoad = store.loadWorkCenterActivity('agent-a');
    store.chatHistoryConnectionGeneration = 2;
    requests[0].resolve({ items: [item('old-socket', 'running')], nextCursor: 'page-2' });
    requests[1].resolve({ items: [] });
    await oldLoad;
    expect(store.workCenterActivityByAgent['agent-a']).toBeUndefined();
    expect(store.workCenterRequest).toHaveBeenCalledTimes(2);
    const freshLoad = store.loadWorkCenterActivity('agent-a');
    requests[2].resolve({ items: [item('fresh-socket', 'running')] });
    requests[3].resolve({ items: [] });
    await freshLoad;
    expect(store.workCenterActivityByAgent['agent-a'].map(row => row.id)).toEqual(['fresh-socket']);
  });

});
