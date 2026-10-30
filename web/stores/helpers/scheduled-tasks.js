import { yeaftCatalogKey } from './session-catalog.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const MAX_NOTIFICATIONS = 30;
const MAX_RECEIPTS = 300;
const receiptState = new WeakMap();

function ownerId(store) {
  return store.scheduledTaskNotificationOwnerId || null;
}

/** Receipts contain only run identities, scoped to the authenticated browser owner. */
function receipts(store) {
  const owner = ownerId(store);
  let state = receiptState.get(store);
  if (state?.owner === owner) return state;
  let seen = [];
  if (owner) {
    try {
      const saved = JSON.parse(localStorage.getItem(`yeaft-task-receipts:${owner}`) || '[]');
      if (Array.isArray(saved)) seen = saved.filter(value => typeof value === 'string').slice(-MAX_RECEIPTS);
    } catch { /* Storage is optional; in-memory deduplication still applies. */ }
  }
  state = { owner, seen: new Set(seen) };
  receiptState.set(store, state);
  return state;
}

function recordReceipt(store, id) {
  const state = receipts(store);
  state.seen.add(id);
  state.seen = new Set([...state.seen].slice(-MAX_RECEIPTS));
  if (state.owner) {
    try { localStorage.setItem(`yeaft-task-receipts:${state.owner}`, JSON.stringify([...state.seen])); } catch {}
  }
}

export function bindScheduledTaskNotificationOwner(store, nextOwnerId) {
  const next = typeof nextOwnerId === 'string' && nextOwnerId ? nextOwnerId : null;
  if (ownerId(store) === next) return;
  store.scheduledTaskNotificationOwnerId = next;
  store.scheduledTaskNotifications = [];
  receiptState.delete(store);
}

export function scheduledTaskRequestError(store, agentId, op, task) {
  const agent = store.agents?.find(row => row.id === agentId);
  const error = store.scheduledTaskProtocolSupported !== true ? 'scheduled_task_server_unsupported'
    : !agentId ? 'missing_agent'
    : !agent?.online || store.ws?.readyState !== 1 ? 'agent_offline'
      : !agent.capabilities?.includes('scheduled_tasks') ? 'scheduled_tasks_unsupported'
        : task?.trigger?.recurrence?.daysOfMonth && !agent.capabilities.includes('scheduled_task_month_days') ? 'scheduled_task_month_days_unsupported' : null;
  return error ? { ok: false, op, error: { code: error } } : null;
}

export function updateScheduledTask(store, { agentId, sessionId, task, expectedRevision } = {}) {
  const rejection = scheduledTaskRequestError(store, agentId, 'update_task', task);
  if (rejection) return Promise.resolve(rejection);
  return store.sessionCrudRequest('update_task', { sessionId, task, expectedRevision }, { agentId });
}

export function runScheduledTask(store, { agentId, sessionId } = {}) {
  const rejection = scheduledTaskRequestError(store, agentId, 'run_task');
  if (rejection) return Promise.resolve(rejection);
  return store.sessionCrudRequest('run_task', { sessionId }, { agentId });
}

/** Accept only an Agent-stamped run completion, never the active UI Session. */
export function acceptScheduledTaskNotification(store, event, agentId) {
  if (typeof agentId !== 'string' || !agentId || typeof event?.sessionId !== 'string' || !event.sessionId
      || typeof event.runId !== 'string' || !event.runId || !TERMINAL_STATUSES.has(event.status)) return false;
  const id = JSON.stringify([agentId, event.sessionId, event.runId]);
  if (receipts(store).seen.has(id) || store.scheduledTaskNotifications?.some(item => item.id === id)) return false;
  const item = {
    id, agentId, sessionId: event.sessionId, runId: event.runId,
    taskName: typeof event.taskName === 'string' ? event.taskName : event.sessionId,
    status: event.status, error: typeof event.error === 'string' ? event.error.slice(0, 1000) : '',
    createdAt: event.finishedAt || Date.now(),
  };
  store.scheduledTaskNotifications = [...(store.scheduledTaskNotifications || []), item].slice(-MAX_NOTIFICATIONS);
  store.markYeaftSessionUnread?.(item.sessionId, agentId);
  // Permission is never requested during background execution. In-app notices
  // remain available regardless of browser desktop-notification permission.
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const notice = new Notification(item.taskName, { tag: id });
      notice.onclick = () => { globalThis.window?.focus?.(); store.openScheduledTaskNotification(item); notice.close(); };
    } catch { /* Browsers without a desktop notification backend use in-app UI. */ }
  }
  return true;
}

/** Hydration recovers the latest terminal result even if the browser was closed. */
export function reconcileScheduledTaskNotifications(store, sessions, agentId) {
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session?.task || session.task.notify === false) continue;
    const run = session.task.lastRun;
    if (!run) continue;
    acceptScheduledTaskNotification(store, {
      sessionId: session.id, taskName: session.name, runId: run.id,
      status: run.status, error: run.error, finishedAt: run.finishedAt,
    }, agentId || session.agentId);
  }
}

export function dismissScheduledTaskNotification(store, id) {
  if (!store.scheduledTaskNotifications?.some(item => item.id === id)) return false;
  recordReceipt(store, id);
  store.scheduledTaskNotifications = store.scheduledTaskNotifications.filter(item => item.id !== id);
  return true;
}

export function openScheduledTaskNotification(store, item) {
  if (!item?.agentId || !item.sessionId) return false;
  const catalogKey = yeaftCatalogKey(item.agentId, item.sessionId);
  const descriptor = store.sidebarSessionCatalog?.find(row => row.catalogKey === catalogKey);
  if (!descriptor || !store.openCatalogSession(descriptor)) return false;
  if (store.workCenterOpen) store.leaveWorkCenter?.();
  if (store.digitalPersonOpen) store.leaveDigitalPerson?.();
  dismissScheduledTaskNotification(store, item.id);
  return true;
}
