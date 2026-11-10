import { yeaftCatalogKey } from './session-catalog.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const MAX_NOTIFICATIONS = 30;
const MAX_RECEIPTS = 300;
const receiptState = new WeakMap();

function ownerId(store) {
  return store.scheduledTaskNotificationOwnerId || null;
}

/** Receipts contain only run identities, scoped to the authenticated browser owner. */
function receiptIdentity(id) {
  try {
    const values = JSON.parse(id);
    if (Array.isArray(values) && values.length === 3 && values.every(value => typeof value === 'string'
        && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\s\u0000-\u001f\u007f]/u.test(value))) {
      const [agentId, sessionId, runId] = values;
      return { agentId, sessionId, runId };
    }
  } catch { /* Ignore malformed legacy browser receipts. */ }
  return null;
}

function receipts(store) {
  const owner = ownerId(store);
  let state = receiptState.get(store);
  if (state?.owner === owner) return state;
  let seen = [];
  let pending = [];
  if (owner) {
    try {
      const saved = JSON.parse(localStorage.getItem(`yeaft-task-receipts:${owner}`) || '[]');
      if (Array.isArray(saved)) seen = saved.filter(value => receiptIdentity(value)).slice(-MAX_RECEIPTS);
      // Old local-only receipts are uploaded once as well. Unacknowledged reads
      // are not evicted by the bounded display cache, including offline reads.
      const savedPending = JSON.parse(localStorage.getItem(`yeaft-task-pending-receipts:${owner}`) || 'null');
      pending = Array.isArray(savedPending) ? savedPending.filter(value => receiptIdentity(value)) : seen;
    } catch { /* Storage is optional; in-memory deduplication still applies. */ }
  }
  state = { owner, seen: new Set([...seen, ...pending]), pending: new Set(pending), sent: new Set(), notices: new Map() };
  receiptState.set(store, state);
  return state;
}

function persistReceipts(state) {
  if (!state.owner) return;
  try {
    localStorage.setItem(`yeaft-task-receipts:${state.owner}`, JSON.stringify([...state.seen].slice(-MAX_RECEIPTS)));
    localStorage.setItem(`yeaft-task-pending-receipts:${state.owner}`, JSON.stringify([...state.pending]));
  } catch { /* Server receipts remain authoritative when browser storage is unavailable. */ }
}

/** Upload exact runs only; a read must never suppress a future attempt. */
export function flushScheduledTaskReceipts(store) {
  const state = receipts(store);
  if (!state.owner || store.scheduledTaskReceiptProtocolSupported !== true) return;
  const sessions = new Map();
  for (const id of state.pending) {
    if (state.sent.has(id)) continue;
    const row = receiptIdentity(id);
    const key = JSON.stringify([row.agentId, row.sessionId]);
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(id);
  }
  // One deleted/legacy Session must not reject another Session's read batch.
  for (const pending of sessions.values()) {
    for (let offset = 0; offset < pending.length; offset += 100) {
      const ids = pending.slice(offset, offset + 100);
      if (store.sendWsMessage?.({ type: 'scheduled_task_notifications_read', receipts: ids.map(receiptIdentity) }) !== true) return;
      for (const id of ids) state.sent.add(id);
    }
  }
}

function recordReceipt(store, id, sync = true) {
  const state = receipts(store);
  if (!state.seen.has(id)) {
    state.seen.add(id);
    state.pending.add(id);
    persistReceipts(state);
  }
  state.notices.get(id)?.close?.();
  state.notices.delete(id);
  if (sync) flushScheduledTaskReceipts(store);
}

/** Server acknowledgements merge without echoing another client's read. */
export function applyScheduledTaskReceipts(store, rows, { reconnect = false } = {}) {
  const state = receipts(store);
  if (reconnect) state.sent.clear();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = JSON.stringify([row?.agentId, row?.sessionId, row?.runId]);
    if (!receiptIdentity(id)) continue;
    state.seen.add(id);
    state.pending.delete(id);
    state.sent.delete(id);
    state.notices.get(id)?.close?.();
    state.notices.delete(id);
  }
  const removed = (store.scheduledTaskNotifications || []).filter(item => state.seen.has(item.id));
  store.scheduledTaskNotifications = (store.scheduledTaskNotifications || []).filter(item => !state.seen.has(item.id));
  for (const item of removed) {
    if (!store.scheduledTaskNotifications.some(row => row.agentId === item.agentId && row.sessionId === item.sessionId)) {
      store.markYeaftSessionRead?.(item.sessionId, item.agentId);
    }
  }
  persistReceipts(state);
  if (reconnect) flushScheduledTaskReceipts(store);
}

export function bindScheduledTaskNotificationOwner(store, nextOwnerId) {
  const next = typeof nextOwnerId === 'string' && nextOwnerId ? nextOwnerId : null;
  if (ownerId(store) === next) return;
  for (const notice of receiptState.get(store)?.notices?.values() || []) notice?.close?.();
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

/** Reading a Session acknowledges all of its queued runs, not other Agents' Sessions. */
export function markScheduledTaskSessionRead(store, sessionId, agentId, lastRun = null) {
  if (!sessionId || !agentId) return false;
  if (typeof lastRun?.id === 'string' && lastRun.id && TERMINAL_STATUSES.has(lastRun.status)) {
    recordReceipt(store, JSON.stringify([agentId, sessionId, lastRun.id]), false);
  }
  const items = (store.scheduledTaskNotifications || [])
    .filter(item => item.agentId === agentId && item.sessionId === sessionId);
  for (const item of items) recordReceipt(store, item.id, false);
  store.scheduledTaskNotifications = (store.scheduledTaskNotifications || []).filter(item => !items.includes(item));
  // Expand a foreground Session visit to already-known results on the Server,
  // even when this fresh client only knows lastRun. Never replay this expansion
  // after disconnect: offline retries contain exact runs, not future results.
  const ids = items.map(item => item.id);
  if (typeof lastRun?.id === 'string' && TERMINAL_STATUSES.has(lastRun.status)) ids.push(JSON.stringify([agentId, sessionId, lastRun.id]));
  const batch = [...new Set(ids)].map(receiptIdentity).filter(Boolean);
  if (store.scheduledTaskReceiptProtocolSupported === true
      && store.sendWsMessage?.({ type: 'scheduled_task_notifications_read', receipts: batch,
        sessionRead: true, sessions: [{ agentId, sessionId }] }) === true) {
    for (const row of batch) receipts(store).sent.add(JSON.stringify([row.agentId, row.sessionId, row.runId]));
  }
  flushScheduledTaskReceipts(store);
  return items.length > 0;
}

export function isScheduledTaskSessionVisible(store, sessionId, agentId) {
  const route = store.activeSessionRoute;
  return !!sessionId && !!agentId && store.currentView === 'yeaft' && !store.workCenterOpen
    && !store.pluginCenterOpen && !store.digitalPersonOpen && !store.yeaftConversationCovered
    && !(store.workbenchExpanded && store.workbenchMaximized)
    && globalThis.document?.visibilityState !== 'hidden'
    && route?.runtimeProvider === 'yeaft'
    && route.agentId === agentId && route.sessionId === sessionId;
}

/** Accept only an Agent-stamped run completion; the active UI never supplies its identity. */
export function acceptScheduledTaskNotification(store, event, agentId) {
  if (typeof agentId !== 'string' || !agentId || typeof event?.sessionId !== 'string' || !event.sessionId
      || typeof event.runId !== 'string' || !event.runId || !TERMINAL_STATUSES.has(event.status)) return false;
  const id = JSON.stringify([agentId, event.sessionId, event.runId]);
  if (receipts(store).seen.has(id)) return false;
  if (isScheduledTaskSessionVisible(store, event.sessionId, agentId)) {
    recordReceipt(store, id);
    markScheduledTaskSessionRead(store, event.sessionId, agentId);
    return false;
  }
  if (store.scheduledTaskNotifications?.some(item => item.id === id)) return false;
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
      receipts(store).notices.set(id, notice);
      notice.onclose = () => receipts(store).notices.delete(id);
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
  // Clicking acknowledges this run even if its Session cannot be opened.
  const id = JSON.stringify([item.agentId, item.sessionId, item.runId]);
  if (receiptIdentity(id)) {
    recordReceipt(store, id);
    store.scheduledTaskNotifications = (store.scheduledTaskNotifications || []).filter(row => row.id !== id);
  }
  const catalogKey = yeaftCatalogKey(item.agentId, item.sessionId);
  const descriptor = store.sidebarSessionCatalog?.find(row => row.catalogKey === catalogKey);
  if (!descriptor || !store.openCatalogSession(descriptor)) return false;
  if (store.workCenterOpen) store.leaveWorkCenter?.();
  if (store.digitalPersonOpen) store.leaveDigitalPerson?.();
  markScheduledTaskSessionRead(store, item.sessionId, item.agentId);
  return true;
}
