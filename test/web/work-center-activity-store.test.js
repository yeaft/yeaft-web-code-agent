// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = {};
globalThis.Pinia = {
  defineStore: (id, options) => {
    stores[id] = options;
    return () => ({});
  },
};
await import('../../web/stores/chat.js');
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

beforeEach(() => localStorage.clear());

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
});
