// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tasks from '../../web/stores/helpers/scheduled-tasks.js';

const options = {};
globalThis.Pinia = { defineStore: (id, value) => { options[id] = value; return () => ({}); } };
const { useChatStore } = await import('../../web/stores/chat.js');
await import('../../web/stores/sessions.js');

function harness() {
  const store = {
    agents: [{ id: 'a', online: true, capabilities: ['scheduled_tasks'] }, { id: 'b', online: true, capabilities: [] }],
    ws: { readyState: 1 }, scheduledTaskProtocolSupported: true, scheduledTaskNotifications: [], scheduledTaskNotificationOwnerId: null,
    sidebarSessionCatalog: [{ catalogKey: 'yeaft:a:same', routeRef: { runtimeProvider: 'yeaft', agentId: 'a', sessionId: 'same' } }],
    sessionCrudRequest: vi.fn(async () => ({ ok: true })),
    markYeaftSessionUnread: vi.fn(), openCatalogSession: vi.fn(() => true),
  };
  tasks.bindScheduledTaskNotificationOwner(store, 'owner');
  return store;
}
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

const completed = { sessionId: 'same', runId: 'run', status: 'completed', taskName: 'Daily review' };

describe('Session-backed task store integration', () => {
  it('passes task creation and explicit Agent through the existing Session creation API', () => {
    const store = harness();
    const task = { prompt: 'Review', trigger: { type: 'manual' } };
    options.chat.actions.createYeaftSession.call(store, { displayName: ' Review ', vpIds: ['omni'], workDir: '/repo', agentId: 'a', task, config: { model: 'test/model', modelEffort: 'xhigh' } });
    expect(store.sessionCrudRequest).toHaveBeenCalledWith('create', {
      name: 'Review', roster: ['omni'], defaultVpId: 'omni', workDir: '/repo', task, config: { model: 'test/model', modelEffort: 'xhigh' },
    }, { agentId: 'a' });
    options.chat.actions.createYeaftSession.call(store, { displayName: 'Chat', vpIds: ['omni'], agentId: 'a' });
    expect(store.sessionCrudRequest.mock.calls[1][1]).not.toHaveProperty('task');
  });

  it('uses the correlated CRUD transport with task operations and rejects unavailable Agents locally', async () => {
    const store = harness();
    await expect(tasks.updateScheduledTask(store, { agentId: 'a', sessionId: 'same', task: { enabled: false }, expectedRevision: 'revision-1' })).resolves.toEqual({ ok: true });
    expect(store.sessionCrudRequest).toHaveBeenLastCalledWith('update_task', { sessionId: 'same', task: { enabled: false }, expectedRevision: 'revision-1' }, { agentId: 'a' });
    await tasks.runScheduledTask(store, { agentId: 'a', sessionId: 'same' });
    expect(store.sessionCrudRequest).toHaveBeenLastCalledWith('run_task', { sessionId: 'same' }, { agentId: 'a' });
    await expect(tasks.runScheduledTask(store, { agentId: 'b', sessionId: 'same' })).resolves.toMatchObject({ ok: false, error: { code: 'scheduled_tasks_unsupported' } });
    store.agents[0].online = false;
    await expect(tasks.runScheduledTask(store, { agentId: 'a', sessionId: 'same' })).resolves.toMatchObject({ ok: false, error: { code: 'agent_offline' } });
    expect(store.sessionCrudRequest).toHaveBeenCalledTimes(2);
    store.agents[0].online = true;
    const task = { prompt: 'Monthly', trigger: { type: 'schedule', recurrence: { frequency: 'monthly', daysOfMonth: [1, 15] } } };
    await expect(tasks.updateScheduledTask(store, { agentId: 'a', sessionId: 'same', task })).resolves.toMatchObject({ error: { code: 'scheduled_task_month_days_unsupported' } });
    await expect(options.chat.actions.createYeaftSession.call(store, { agentId: 'a', task })).resolves.toMatchObject({ error: { code: 'scheduled_task_month_days_unsupported' } });
    expect(store.sessionCrudRequest).toHaveBeenCalledTimes(2);
    store.agents[0].capabilities.push('scheduled_task_month_days');
    await expect(tasks.updateScheduledTask(store, { agentId: 'a', sessionId: 'same', task })).resolves.toEqual({ ok: true });

  });

  it('normalizes task metadata and updates without switching the active conversation', () => {
    const store = { sessions: {}, sessionOrder: [], inventoryIdentityMode: 'agent-scoped', pending: {}, _normalize: options.sessions.actions._normalize };
    store.applySnapshotUpsert = (...args) => options.sessions.actions.applySnapshotUpsert.apply(store, args);
    const task = { revision: 'revision-1', prompt: 'Review', trigger: { type: 'manual' }, lastRun: null };
    options.sessions.actions.applyCrudResult.call(store, { op: 'update_task', ok: true, session: { id: 'same', task } }, 'a');
    expect(store.sessions['a\u001fsame'].task).toEqual(task);
    expect(store).not.toHaveProperty('activeSessionId');
    task.prompt = 'Changed outside';
    expect(store.sessions['a\u001fsame'].task.prompt).toBe('Review');
    expect(store._normalize({ id: 'plain' }, 'a').task).toBeNull();
  });

  it.each([undefined, false])('rejects task creation, updates and runs without sending on an old Server (protocol=%s)', async (supported) => {
    const store = harness();
    if (supported === undefined) delete store.scheduledTaskProtocolSupported;
    else store.scheduledTaskProtocolSupported = supported;
    const task = { prompt: 'Never downgrade this task to a chat', trigger: { type: 'manual' } };
    await expect(options.chat.actions.createYeaftSession.call(store, { agentId: 'a', task }))
      .resolves.toMatchObject({ ok: false, op: 'create', error: { code: 'scheduled_task_server_unsupported' } });
    await expect(tasks.updateScheduledTask(store, { agentId: 'a', sessionId: 'same', task, expectedRevision: 'revision-1' }))
      .resolves.toMatchObject({ ok: false, op: 'update_task', error: { code: 'scheduled_task_server_unsupported' } });
    await expect(tasks.runScheduledTask(store, { agentId: 'a', sessionId: 'same' }))
      .resolves.toMatchObject({ ok: false, op: 'run_task', error: { code: 'scheduled_task_server_unsupported' } });
    expect(store.sessionCrudRequest).not.toHaveBeenCalled();
  });

  it('preserves the configured model and effort from inventory through task acknowledgements', () => {
    const store = { sessions: {}, sessionOrder: [], inventoryIdentityMode: 'agent-scoped', pending: {}, _normalize: options.sessions.actions._normalize };
    store.applySnapshotUpsert = (...args) => options.sessions.actions.applySnapshotUpsert.apply(store, args);
    const config = { model: 'review-provider/review-model', modelEffort: 'high' };
    const task = { revision: 'revision-1', prompt: 'Review', enabled: true, trigger: { type: 'manual' }, lastRun: null };
    options.sessions.actions.applySnapshot.call(store, [{ id: 'same', config, task }], 'a', { deferActivation: true });
    for (const op of ['update_task', 'run_task']) {
      options.sessions.actions.applyCrudResult.call(store, { op, ok: true,
        session: { id: 'same', task: { ...task, revision: 'revision-2', enabled: false } } }, 'a');
      expect(store.sessions['a\u001fsame'].config).toEqual(config);
      expect(store.sessions['a\u001fsame'].task).toMatchObject({ revision: 'revision-2', enabled: false });
    }
  });

  it('deduplicates completion, requires exact Agent provenance and preserves other Agents with the same Session id', () => {
    const store = harness();
    expect(tasks.acceptScheduledTaskNotification(store, completed, null)).toBe(false);
    expect(tasks.acceptScheduledTaskNotification(store, { ...completed, status: 'running' }, 'a')).toBe(false);
    expect(tasks.acceptScheduledTaskNotification(store, completed, 'a')).toBe(true);
    expect(tasks.acceptScheduledTaskNotification(store, completed, 'a')).toBe(false);
    expect(tasks.acceptScheduledTaskNotification(store, completed, 'b')).toBe(true);
    expect(store.scheduledTaskNotifications).toHaveLength(2);
    const item = store.scheduledTaskNotifications[0];
    expect(tasks.openScheduledTaskNotification(store, item)).toBe(true);
    expect(store.openCatalogSession).toHaveBeenCalledWith(store.sidebarSessionCatalog[0]);
    expect(store.scheduledTaskNotifications.map(row => row.agentId)).toEqual(['b']);
    expect(tasks.acceptScheduledTaskNotification(store, completed, 'a')).toBe(false);
  });

  it('recovers the latest terminal result on hydration, persists only receipts, and clears private notices on owner changes', () => {
    const store = harness();
    const sessions = [{ id: 'same', name: 'Review', task: { notify: true, lastRun: { id: 'run', status: 'failed', error: 'private error' } } },
      { id: 'silent', task: { notify: false, lastRun: { id: 'silent-run', status: 'completed' } } }];
    tasks.reconcileScheduledTaskNotifications(store, sessions, 'a');
    expect(store.scheduledTaskNotifications).toHaveLength(1);
    tasks.dismissScheduledTaskNotification(store, store.scheduledTaskNotifications[0].id);
    expect(localStorage.getItem('yeaft-task-receipts:owner')).not.toContain('private error');
    const reloaded = harness();
    tasks.reconcileScheduledTaskNotifications(reloaded, sessions, 'a');
    expect(reloaded.scheduledTaskNotifications).toHaveLength(0);
    tasks.bindScheduledTaskNotificationOwner(reloaded, 'different-owner');
    tasks.reconcileScheduledTaskNotifications(reloaded, sessions, 'a');
    expect(reloaded.scheduledTaskNotifications).toHaveLength(1);
    tasks.bindScheduledTaskNotificationOwner(reloaded, null);
    expect(reloaded.scheduledTaskNotifications).toEqual([]);
  });

  it('does not dismiss a notification whose task is no longer present in the catalog', () => {
    const store = harness();
    tasks.acceptScheduledTaskNotification(store, completed, 'b');
    expect(tasks.openScheduledTaskNotification(store, store.scheduledTaskNotifications[0])).toBe(false);
    expect(store.openCatalogSession).not.toHaveBeenCalled();
    expect(store.scheduledTaskNotifications).toHaveLength(1);
  });
});
