// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tasks from '../../web/stores/helpers/scheduled-tasks.js';
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import ScheduledTaskNotifications from '../../web/components/ScheduledTaskNotifications.js';


const options = {};
globalThis.Pinia = { defineStore: (id, value) => { options[id] = value; return () => ({}); } };
const { useChatStore } = await import('../../web/stores/chat.js');
const { setupVisibilityHandler } = await import('../../web/stores/helpers/websocket.js');
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
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    // Explicit ownership must win over the currently selected same-id Session.
    const stopStore = { ...store, currentAgent: 'b', sendWsMessage: vi.fn(() => true),
      activeVpTurns: { a: { agentId: 'a', sessionId: 'same' }, b: { agentId: 'b', sessionId: 'same' } },
      vpStatuses: { a: { agentId: 'a', sessionId: 'same' }, b: { agentId: 'b', sessionId: 'same' } },
      clearYeaftSessionProcessingIfIdle: vi.fn() };
    expect(options.chat.actions.cancelYeaftSession.call(stopStore, 'same', { agentId: 'a' })).toBe(true);
    expect(stopStore.sendWsMessage).toHaveBeenCalledWith({ type: 'yeaft_abort_all', agentId: 'a', sessionId: 'same' });
    expect(stopStore.activeVpTurns).toEqual({ b: { agentId: 'b', sessionId: 'same' } });
    expect(stopStore.vpStatuses).toEqual({ b: { agentId: 'b', sessionId: 'same' } });
    stopStore.sendWsMessage.mockReturnValue(false);
    expect(options.chat.actions.cancelYeaftSession.call(stopStore, 'same', { agentId: 'b' })).toBe(false);
    expect(stopStore.activeVpTurns.b).toBeDefined();
    stopStore.sendWsMessage.mockReturnValue(true);
    expect(options.chat.actions.cancelYeaftSession.call(stopStore, 'same', { agentId: 'b', waitForAck: true })).toBe(true);
    expect(stopStore.activeVpTurns.b).toBeDefined();
    expect(stopStore.vpStatuses.b).toBeDefined();
    // The existing authoritative ack, not the outgoing request, clears runtime.
    options.chat.actions.handleYeaftOutput.call(stopStore, { agentId: 'b', sessionId: 'same',
      event: { type: 'yeaft_aborted', sessionId: 'same', all: true } });
    expect(stopStore.activeVpTurns).toEqual({});
    expect(stopStore.vpStatuses).toEqual({});
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

  it('acknowledges every queued run on Session selection, including repeats, without muting future runs or other Agents', () => {
    const store = harness();
    Object.assign(store, {
      currentView: 'chat', currentAgent: 'a', yeaftActiveSessionFilter: 'same',
      activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'a', sessionId: 'same' },
      messagesMap: {}, yeaftConversationIdsByAgent: {},
      activateYeaftAgent: vi.fn(), markYeaftSessionRead: vi.fn(),
      syncActiveYeaftHistoryLoad: vi.fn(), requestYeaftSessionBootstrap: vi.fn(),
    });
    for (const runId of ['run', 'run-2']) tasks.acceptScheduledTaskNotification(store, { ...completed, runId }, 'a');
    tasks.acceptScheduledTaskNotification(store, completed, 'b');
    // Exercise the real activation path: selecting an already-active Session
    // must acknowledge before history de-duplication, even without an unread dot.
    store.currentView = 'yeaft';
    options.chat.actions.setActiveSessionFilter.call(store, 'same', { agentId: 'a' });
    expect(store.scheduledTaskNotifications.map(row => row.agentId)).toEqual(['b']);
    expect(store.requestYeaftSessionBootstrap).not.toHaveBeenCalled();
    const reloaded = harness();
    for (const runId of ['run', 'run-2']) {
      expect(tasks.acceptScheduledTaskNotification(reloaded, { ...completed, runId }, 'a')).toBe(false);
    }
    expect(tasks.acceptScheduledTaskNotification(reloaded, { ...completed, runId: 'new-run' }, 'a')).toBe(true);
    expect(tasks.acceptScheduledTaskNotification(reloaded, completed, 'b')).toBe(true);
    // A terminal inventory result is acknowledged even if its completion event
    // has not arrived yet; a currently running attempt is not acknowledged.
    tasks.markScheduledTaskSessionRead(reloaded, 'same', 'a', { id: 'inventory-run', status: 'failed' });
    expect(tasks.acceptScheduledTaskNotification(reloaded, { ...completed, runId: 'inventory-run' }, 'a')).toBe(false);
    tasks.markScheduledTaskSessionRead(reloaded, 'same', 'a', { id: 'ongoing', status: 'running' });
    expect(tasks.acceptScheduledTaskNotification(reloaded, { ...completed, runId: 'ongoing' }, 'a')).toBe(true);
  });

  it('silently receipts results only for the exact visible Task Session, including return from covered and background views', async () => {
    const desktopNotice = vi.fn();
    desktopNotice.permission = 'granted';
    vi.stubGlobal('Notification', desktopNotice);
    const store = Vue.reactive(harness());
    Object.assign(store, { currentView: 'yeaft',
      activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'a', sessionId: 'same' },
      markVisibleScheduledTaskSessionRead: options.chat.actions.markVisibleScheduledTaskSessionRead });
    expect(tasks.acceptScheduledTaskNotification(store, completed, 'a')).toBe(false);
    expect(store.scheduledTaskNotifications).toEqual([]);
    expect(store.markYeaftSessionUnread).not.toHaveBeenCalled();
    expect(desktopNotice).not.toHaveBeenCalled();
    expect(tasks.acceptScheduledTaskNotification(harness(), completed, 'a')).toBe(false);
    expect(tasks.acceptScheduledTaskNotification(store, completed, 'b')).toBe(true);
    const wrapper = mount(ScheduledTaskNotifications, { props: { store }, global: { mocks: { $t: key => key } } });
    for (const surface of ['workCenterOpen', 'pluginCenterOpen', 'digitalPersonOpen', 'yeaftConversationCovered']) {
      store[surface] = true;
      await Vue.nextTick();
      expect(tasks.acceptScheduledTaskNotification(store, { ...completed, runId: surface }, 'a')).toBe(true);
      store[surface] = false;
      await Vue.nextTick();
      expect(store.scheduledTaskNotifications.map(row => row.agentId)).toEqual(['b']);
    }
    store.workbenchExpanded = store.workbenchMaximized = true;
    await Vue.nextTick();
    expect(tasks.acceptScheduledTaskNotification(store, { ...completed, runId: 'maximized' }, 'a')).toBe(true);
    store.workbenchMaximized = false;
    await Vue.nextTick();
    expect(store.scheduledTaskNotifications.map(row => row.agentId)).toEqual(['b']);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(tasks.acceptScheduledTaskNotification(store, { ...completed, runId: 'background' }, 'a')).toBe(true);
    const backgroundStore = { ...store, currentAgent: 'a', yeaftActiveSessionFilter: 'same',
      messagesMap: {}, activateYeaftAgent: vi.fn(), markYeaftSessionRead: vi.fn(),
      syncActiveYeaftHistoryLoad: vi.fn() };
    options.chat.actions.setActiveSessionFilter.call(backgroundStore, 'same', { agentId: 'a' });
    expect(backgroundStore.scheduledTaskNotifications).toHaveLength(2);
    const listen = vi.spyOn(document, 'addEventListener');
    setupVisibilityHandler(store);
    const resume = listen.mock.calls.find(([type]) => type === 'visibilitychange')[1];
    vi.useFakeTimers();
    try {
      store.sendWsMessage = vi.fn();
      visibility.mockReturnValue('visible');
      resume();
      expect(store.scheduledTaskNotifications.map(row => row.agentId)).toEqual(['b']);
      expect(store.sendWsMessage).toHaveBeenCalledWith({ type: 'ping' });
    } finally { vi.useRealTimers(); wrapper.unmount(); }
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

  it('acknowledges a clicked notification even when its task is no longer present in the catalog', () => {
    const store = harness();
    tasks.acceptScheduledTaskNotification(store, completed, 'b');
    expect(tasks.openScheduledTaskNotification(store, store.scheduledTaskNotifications[0])).toBe(false);
    expect(store.openCatalogSession).not.toHaveBeenCalled();
    expect(store.scheduledTaskNotifications).toHaveLength(0);
    expect(tasks.acceptScheduledTaskNotification(store, completed, 'b')).toBe(false);
  });

  it('uploads local reads and applies another client receipt without echoing or muting the next run', () => {
    const first = harness();
    const second = harness(); // Independent in-memory clients, before either has read.
    for (const store of [first, second]) {
      store.scheduledTaskReceiptProtocolSupported = true;
      store.sendWsMessage = vi.fn(() => true);
      tasks.acceptScheduledTaskNotification(store, completed, 'a');
      tasks.acceptScheduledTaskNotification(store, completed, 'b');
    }
    tasks.markScheduledTaskSessionRead(first, 'same', 'a');
    const receipt = { agentId: 'a', sessionId: 'same', runId: 'run' };
    expect(first.sendWsMessage).toHaveBeenCalledExactlyOnceWith({ type: 'scheduled_task_notifications_read', receipts: [receipt], sessionRead: true, sessions: [{ agentId: 'a', sessionId: 'same' }] });
    tasks.applyScheduledTaskReceipts(second, [receipt]);
    expect(second.scheduledTaskNotifications.map(item => item.agentId)).toEqual(['b']);
    expect(second.sendWsMessage).not.toHaveBeenCalled();
    expect(tasks.acceptScheduledTaskNotification(second, completed, 'a')).toBe(false);
    expect(tasks.acceptScheduledTaskNotification(second, { ...completed, runId: 'new-run' }, 'a')).toBe(true);
    tasks.applyScheduledTaskReceipts(first, [receipt]);
    expect(JSON.parse(localStorage.getItem('yeaft-task-pending-receipts:owner'))).toEqual([]);
  });

  it('replays unconfirmed offline reads across reload and retries after reconnect until server acknowledgement', () => {
    const store = harness();
    store.scheduledTaskReceiptProtocolSupported = true;
    store.sendWsMessage = vi.fn(() => false);
    tasks.markScheduledTaskSessionRead(store, 'same', 'a', { id: 'offline-run', status: 'completed' });
    const reloaded = harness();
    reloaded.scheduledTaskReceiptProtocolSupported = true;
    reloaded.sendWsMessage = vi.fn(() => true);
    tasks.applyScheduledTaskReceipts(reloaded, [], { reconnect: true });
    const receipt = { agentId: 'a', sessionId: 'same', runId: 'offline-run' };
    expect(reloaded.sendWsMessage).toHaveBeenCalledExactlyOnceWith({ type: 'scheduled_task_notifications_read', receipts: [receipt] });
    tasks.flushScheduledTaskReceipts(reloaded);
    expect(reloaded.sendWsMessage).toHaveBeenCalledTimes(1);
    // Sending is not an acknowledgement: transport loss must retry the run.
    tasks.applyScheduledTaskReceipts(reloaded, [], { reconnect: true });
    expect(reloaded.sendWsMessage).toHaveBeenCalledTimes(2);
    tasks.applyScheduledTaskReceipts(reloaded, [receipt]);
    tasks.applyScheduledTaskReceipts(reloaded, [], { reconnect: true });
    expect(reloaded.sendWsMessage).toHaveBeenCalledTimes(2);
  });

  it('migrates exact local receipts independently so an unprovable deleted Run cannot block another, and gates old Servers', () => {
    const ids = Array.from({ length: 205 }, (_, i) => JSON.stringify(['a', 'same', `old-${i}`]));
    localStorage.setItem('yeaft-task-receipts:owner', JSON.stringify([...ids, 'invalid']));
    const store = harness();
    store.sendWsMessage = vi.fn(() => true);
    tasks.flushScheduledTaskReceipts(store);
    expect(store.sendWsMessage).not.toHaveBeenCalled();
    store.scheduledTaskReceiptProtocolSupported = true;
    tasks.applyScheduledTaskReceipts(store, [], { reconnect: true });
    expect(store.sendWsMessage).toHaveBeenCalledTimes(205);
    expect(store.sendWsMessage.mock.calls.every(([message]) => message.receipts.length === 1)).toBe(true);
    // Server may reject old-0 after Session deletion; acknowledgement of old-1
    // still independently settles, with no shared batch to reject.
    tasks.applyScheduledTaskReceipts(store, [{ agentId: 'a', sessionId: 'same', runId: 'old-1' }]);
    expect(JSON.parse(localStorage.getItem('yeaft-task-pending-receipts:owner'))).toContain(ids[0]);
    expect(JSON.parse(localStorage.getItem('yeaft-task-pending-receipts:owner'))).not.toContain(ids[1]);
    tasks.bindScheduledTaskNotificationOwner(store, 'other-owner');
    tasks.applyScheduledTaskReceipts(store, [], { reconnect: true });
    expect(store.sendWsMessage).toHaveBeenCalledTimes(205);
  });

  it('server hydration receipts cover more than the old local cache and close desktop notices', () => {
    const close = vi.fn();
    const NotificationMock = vi.fn(function () { this.close = close; });
    NotificationMock.permission = 'granted';
    vi.stubGlobal('Notification', NotificationMock);
    const store = harness();
    tasks.acceptScheduledTaskNotification(store, completed, 'a');
    const rows = Array.from({ length: 350 }, (_, i) => ({ agentId: 'a', sessionId: 'same', runId: `r-${i}` }));
    tasks.applyScheduledTaskReceipts(store, [...rows, { agentId: 'a', sessionId: 'same', runId: 'run' }], { reconnect: true });
    expect(close).toHaveBeenCalledTimes(1);
    expect(store.scheduledTaskNotifications).toEqual([]);
    expect(tasks.acceptScheduledTaskNotification(store, { ...completed, runId: 'r-0' }, 'a')).toBe(false);
  });

});
