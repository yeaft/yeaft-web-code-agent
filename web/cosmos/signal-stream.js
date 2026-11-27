/**
 * Yeaft Cosmos — Interstellar Signal Stream Builder
 *
 * Unifies all actionable planetary signals into a single priority-ordered feed
 * anchored to the top-right corner of the universe:
 *   0. waiting — AskUser prompts requiring confirmation (amber)
 *   1. unread  — Finished background replies & scheduled task completions (planet atmosphere accent)
 *   2. running — Lightweight 1-line active turns that smoothly evolve in-place into unread replies on completion
 */
import { formatRelativeTime } from './agent-projection.js';

function parseMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val) {
    const ms = Date.parse(val);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function scheduledStatusText(notice, t) {
  if (!notice) return '';
  if (notice.error) return String(notice.error).trim();
  const status = notice.status || 'completed';
  if (typeof t === 'function') {
    const key = `scheduledTasks.status.${status}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return status;
}

/**
 * Build deduplicated, priority-ordered Signal Stream entries across all Agents.
 */
export function buildCosmosSignalStream({
  projectedAgents = [],
  agentToPlanet = {},
  scheduledTaskNotifications = [],
  activeDrawerKey = '',
  nowMs = Date.now(),
  isEn = false,
  t = null,
} = {}) {
  const agents = Array.isArray(projectedAgents) ? projectedAgents : Object.values(projectedAgents || {});
  const agentById = new Map();
  for (const ag of agents) {
    if (ag?.id) agentById.set(ag.id, ag);
  }

  const bySignalKey = new Map();
  const runningFallback = typeof t === 'function' ? t('cosmos.panel.runningFallback') : 'Working…';
  const waitingFallback = typeof t === 'function' ? t('cosmos.panel.waitingFallback') : 'Waiting for confirmation';
  const completedFallback = typeof t === 'function' ? t('cosmos.signals.completedFallback') : 'Response ready';

  for (const ag of agents) {
    if (!ag?.id) continue;
    const planetId = agentToPlanet[ag.id] || 'earth';
    for (const s of (ag.sessions || [])) {
      if (!s?.id) continue;
      const signalKey = `${ag.id}\u001f${s.id}`;
      const isVisibleInDrawer = Boolean(activeDrawerKey && activeDrawerKey === signalKey);

      let kind = '';
      if (s.status === 'waiting') {
        kind = 'waiting';
      } else if (s.status === 'running') {
        kind = 'running';
      } else if (s.unread && !isVisibleInDrawer) {
        kind = 'unread';
      } else {
        continue;
      }

      const notice = s.scheduledNotice || null;
      const isError = Boolean(notice && (notice.status === 'failed' || notice.status === 'interrupted'));

      let preview = '';
      if (kind === 'waiting') {
        preview = s.askQuestion || s.summary || waitingFallback;
      } else if (kind === 'unread') {
        preview = s.replyPreview
          || (notice ? scheduledStatusText(notice, t) : '')
          || s.summary
          || completedFallback;
      } else {
        preview = s.replyPreview || s.summary || runningFallback;
      }

      const activityAt = Math.max(
        parseMs(s.updatedAt),
        parseMs(s.replyAt),
        parseMs(notice?.createdAt),
      );

      bySignalKey.set(signalKey, {
        signalKey,
        kind,
        priority: kind === 'waiting' ? 0 : (kind === 'unread' ? 1 : 2),
        agentId: ag.id,
        agentName: ag.name || ag.id,
        planetId,
        sessionId: s.id,
        sessionTitle: s.title || s.id,
        projectPath: s.projectPath || '',
        preview,
        activityAt,
        timeLabel: formatRelativeTime(activityAt, nowMs, isEn),
        dismissible: kind === 'unread',
        scheduledTask: notice
          ? {
              id: notice.id,
              taskName: notice.taskName || s.title || s.id,
              status: notice.status || 'completed',
              error: notice.error || '',
            }
          : null,
        isError,
        session: s,
      });
    }
  }

  // Ensure scheduled task notifications whose Session is not yet in the projected catalog
  // still surface faithfully in the Signal Stream (deduped by agentId + sessionId).
  for (const notice of (Array.isArray(scheduledTaskNotifications) ? scheduledTaskNotifications : [])) {
    if (!notice?.agentId || !notice?.sessionId) continue;
    const signalKey = `${notice.agentId}\u001f${notice.sessionId}`;
    if (activeDrawerKey && activeDrawerKey === signalKey) continue;
    const existing = bySignalKey.get(signalKey);
    const noticeAt = parseMs(notice.createdAt);
    if (existing) {
      if (!existing.scheduledTask || noticeAt >= existing.activityAt) {
        existing.scheduledTask = {
          id: notice.id,
          taskName: notice.taskName || existing.sessionTitle,
          status: notice.status || 'completed',
          error: notice.error || '',
        };
        existing.isError = notice.status === 'failed' || notice.status === 'interrupted';
        if (noticeAt > existing.activityAt) {
          existing.activityAt = noticeAt;
          existing.timeLabel = formatRelativeTime(noticeAt, nowMs, isEn);
        }
      }
      continue;
    }

    const ag = agentById.get(notice.agentId);
    const isError = notice.status === 'failed' || notice.status === 'interrupted';
    bySignalKey.set(signalKey, {
      signalKey,
      kind: 'unread',
      priority: 1,
      agentId: notice.agentId,
      agentName: ag?.name || notice.agentId,
      planetId: agentToPlanet[notice.agentId] || 'earth',
      sessionId: notice.sessionId,
      sessionTitle: notice.taskName || notice.sessionId,
      projectPath: '',
      preview: scheduledStatusText(notice, t) || completedFallback,
      activityAt: noticeAt,
      timeLabel: formatRelativeTime(noticeAt, nowMs, isEn),
      dismissible: true,
      scheduledTask: {
        id: notice.id,
        taskName: notice.taskName || notice.sessionId,
        status: notice.status || 'completed',
        error: notice.error || '',
      },
      isError,
      session: {
        id: notice.sessionId,
        agentId: notice.agentId,
        title: notice.taskName || notice.sessionId,
        runtimeProvider: 'yeaft',
      },
    });
  }

  const items = Array.from(bySignalKey.values());
  items.sort((a, b) => (
    a.priority - b.priority
    || b.activityAt - a.activityAt
    || a.signalKey.localeCompare(b.signalKey)
  ));

  let waitingCount = 0;
  let unreadCount = 0;
  let runningCount = 0;
  for (const item of items) {
    if (item.kind === 'waiting') waitingCount += 1;
    else if (item.kind === 'unread') unreadCount += 1;
    else runningCount += 1;
  }

  return {
    items,
    waitingCount,
    unreadCount,
    runningCount,
    badgeCount: waitingCount + unreadCount,
    dismissibleCount: unreadCount,
    totalCount: items.length,
  };
}
