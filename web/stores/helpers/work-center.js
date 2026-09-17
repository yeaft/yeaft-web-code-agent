const DETAIL_SUMMARY_FIELDS = Object.freeze([
  'revision',
  'planRevision',
  'ledgerRevision',
  'coordinatorRevision',
  'title',
  'goal',
  'workItemType',
  'planningMode',
  'status',
  'lifecycle',
  'attentionState',
  'activeActionIds',
  'attentionActionIds',
  'currentActionId',
  'currentAction',
  'executionStats',
  'executionControl',
  'failureReason',
  'schedule',
  'sourceScheduleId',
  'scheduledOccurrenceAt',
  'origin',
  'linkedSessionIds',
  'createdAt',
  'updatedAt',
]);

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveIntegerOrNull(value) {
  const number = numberOrNull(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeIntegerOrNull(value) {
  const number = numberOrNull(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

const TERMINAL_ACTION_MESSAGE_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'superseded',
  'interrupted',
]);

function actionMessageStatusRank(status) {
  return TERMINAL_ACTION_MESSAGE_STATUSES.has(status) ? 1 : 0;
}

export function pickFresherActionMessage(current, candidate) {
  if (!current) return candidate || null;
  if (!candidate) return current;
  const currentRevision = numberOrNull(current.progressRevision);
  const candidateRevision = numberOrNull(candidate.progressRevision);
  if (currentRevision != null || candidateRevision != null) {
    if (currentRevision == null) return candidate;
    if (candidateRevision == null) return current;
    if (currentRevision !== candidateRevision) {
      return candidateRevision > currentRevision ? candidate : current;
    }
  }
  const currentStatus = actionMessageStatusRank(current.status);
  const candidateStatus = actionMessageStatusRank(candidate.status);
  if (currentStatus !== candidateStatus) return candidateStatus > currentStatus ? candidate : current;
  const currentUpdatedAt = numberOrNull(current.updatedAt) ?? numberOrNull(current.createdAt) ?? 0;
  const candidateUpdatedAt = numberOrNull(candidate.updatedAt) ?? numberOrNull(candidate.createdAt) ?? 0;
  return candidateUpdatedAt > currentUpdatedAt ? candidate : current;
}

function actionMessageTime(value) {
  return Math.max(0, Number(value) || 0);
}

function actionMessageEventId(message) {
  return typeof message?.id === 'string' && message.id.startsWith('event:')
    ? message.id.slice('event:'.length)
    : null;
}

function compareActionMessageEventIds(leftId, rightId) {
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const left = BigInt(leftId);
    const right = BigInt(rightId);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }
  return leftId.localeCompare(rightId);
}

function compareActionMessages(left, right) {
  const timeOrder = actionMessageTime(left?.createdAt) - actionMessageTime(right?.createdAt);
  if (timeOrder) return timeOrder;
  const leftEventId = actionMessageEventId(left);
  const rightEventId = actionMessageEventId(right);
  if (leftEventId != null && rightEventId != null) {
    return compareActionMessageEventIds(leftEventId, rightEventId);
  }
  const leftRole = left?.role === 'user' ? 0 : 1;
  const rightRole = right?.role === 'user' ? 0 : 1;
  if (leftRole !== rightRole) return leftRole - rightRole;
  const generationOrder = actionMessageTime(left?.generation) - actionMessageTime(right?.generation);
  if (generationOrder) return generationOrder;
  const attemptOrder = actionMessageTime(left?.attempt) - actionMessageTime(right?.attempt);
  return attemptOrder
    || String(left?.id || '').localeCompare(String(right?.id || ''));
}

export function mergeActionMessages(...sources) {
  const byId = new Map();
  for (const source of sources) {
    const messages = Array.isArray(source) ? source : [source];
    for (const message of messages) {
      if (!message?.id) continue;
      byId.set(message.id, pickFresherActionMessage(byId.get(message.id), message));
    }
  }
  return [...byId.values()].sort(compareActionMessages);
}

export function normalizeWorkCenterActionGeneration(value) {
  const generation = Number(value);
  return Number.isInteger(generation) && generation > 0 ? generation : 1;
}

export function workCenterActionMessageKey(agentId, workItemId, actionId, generation) {
  return `${agentId}:${workItemId}:${actionId}:${normalizeWorkCenterActionGeneration(generation)}`;
}

export function workCenterActionRequestScopeKey(agentId, workItemId, actionId, generation) {
  return `${agentId}:${workItemId}:${actionId}:${normalizeWorkCenterActionGeneration(generation)}`;
}

function compareExecutionControl(candidate, current) {
  const dataRevision = positiveIntegerOrNull(candidate?.dataRevision);
  const currentDataRevision = positiveIntegerOrNull(current?.dataRevision);
  if (dataRevision != null || currentDataRevision != null) {
    // Once versioned usage is known, an old Agent snapshot cannot erase it.
    if (dataRevision == null) return -1;
    if (currentDataRevision == null) return 1;
    return Math.sign(dataRevision - currentDataRevision);
  }
  // Compatibility with Agents predating the independent projection version.
  const revision = numberOrNull(candidate?.revision);
  const currentRevision = numberOrNull(current?.revision);
  return revision != null && currentRevision != null ? Math.sign(revision - currentRevision) : 0;
}

function workItemIsTerminal(item) {
  return ['done', 'cancelled'].includes(item?.status) || ['done', 'cancelled'].includes(item?.lifecycle);
}

function isWorkItemStateStale(summary, current) {
  if (!summary || !current || summary.id !== current.id) return false;
  // Equal-version delayed state cannot reopen a terminal Item. A real resume
  // has a newer lifecycle version; independent resource settlement is preserved.
  if (isSameWorkItemVersion(current, summary)
      && workItemIsTerminal(current) && !workItemIsTerminal(summary)) return true;
  const legacyResourceOrder = positiveIntegerOrNull(summary.executionControl?.dataRevision) == null
    && positiveIntegerOrNull(current.executionControl?.dataRevision) == null
    ? compareExecutionControl(summary.executionControl, current.executionControl) : 0;
  if (legacyResourceOrder < 0) return true;
  const summaryRevision = numberOrNull(summary.revision);
  const currentRevision = numberOrNull(current.revision);
  if (summaryRevision != null && currentRevision != null && summaryRevision !== currentRevision) {
    return summaryRevision < currentRevision;
  }
  const summaryCoordinatorRevision = numberOrNull(summary.coordinatorRevision);
  const currentCoordinatorRevision = numberOrNull(current.coordinatorRevision);
  if (summaryCoordinatorRevision != null && currentCoordinatorRevision != null
      && summaryCoordinatorRevision !== currentCoordinatorRevision) {
    return summaryCoordinatorRevision < currentCoordinatorRevision;
  }
  if (legacyResourceOrder > 0) return false;
  const summaryUpdatedAt = numberOrNull(summary.updatedAt);
  const currentUpdatedAt = numberOrNull(current.updatedAt);
  return summaryUpdatedAt != null && currentUpdatedAt != null && summaryUpdatedAt < currentUpdatedAt;
}

export function isWorkItemSummaryStale(summary, current) {
  if (!summary || !current || summary.id !== current.id) return false;
  return compareExecutionControl(summary.executionControl, current.executionControl) < 0
    || isWorkItemStateStale(summary, current);
}

// Resource and WorkItem/Action projections have independent clocks. Preserve
// newer usage even when accepting newer Action fields from an older snapshot,
// and accept a new settlement without rolling back newer Action progress.
function withLatestExecutionControl(current, candidate, accepted) {
  const order = compareExecutionControl(candidate.executionControl, current.executionControl);
  const executionControl = order > 0 || (order === 0 && accepted !== current && candidate.executionControl)
    ? candidate.executionControl : current.executionControl;
  let merged = executionControl === accepted.executionControl ? accepted : { ...accepted, executionControl };
  if (merged.executionStats && executionControl?.usage) {
    const executionStats = { ...merged.executionStats };
    for (const key of ['llmRequestCount', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
      if (Number.isFinite(executionControl.usage[key])) executionStats[key] = executionControl.usage[key];
    }
    if (Object.keys(executionStats).some(key => executionStats[key] !== merged.executionStats[key])) {
      merged = { ...merged, executionStats };
    }
  }
  return merged;
}

export function isWorkItemDetailResponseStale(detail, current) {
  if (isWorkItemSummaryStale(detail, current)) return true;
  if (!detail || !current || detail.id !== current.id) return false;
  const detailRevision = numberOrNull(detail.revision);
  const currentRevision = numberOrNull(current.revision);
  return detail.currentActionId !== current.currentActionId
    && detailRevision != null
    && currentRevision != null
    && detailRevision <= currentRevision;
}

function isActionProgressStale(currentStats, nextStats) {
  const currentGeneration = positiveIntegerOrNull(currentStats?.generation);
  const nextGeneration = positiveIntegerOrNull(nextStats?.generation);
  if (currentGeneration != null && nextGeneration != null && currentGeneration !== nextGeneration) {
    return nextGeneration < currentGeneration;
  }
  const currentAttempt = nonNegativeIntegerOrNull(currentStats?.attempt);
  const nextAttempt = nonNegativeIntegerOrNull(nextStats?.attempt);
  if (currentAttempt != null && nextAttempt != null && currentAttempt !== nextAttempt) {
    return nextAttempt < currentAttempt;
  }
  const currentProgress = numberOrNull(currentStats?.progressRevision);
  const nextProgress = numberOrNull(nextStats?.progressRevision);
  return currentProgress != null && nextProgress != null && nextProgress < currentProgress;
}

export function workItemDetailRefreshIdentity(current, summary) {
  if (!current || current.id !== summary?.id || isWorkItemStateStale(summary, current)) return null;
  const actions = Array.isArray(current.actions) ? current.actions : [];
  const stats = Array.isArray(summary.actionStats) ? summary.actionStats : [];
  const currentActionId = current.currentActionId || null;
  const nextActionId = Object.prototype.hasOwnProperty.call(summary, 'currentActionId')
    ? summary.currentActionId || null
    : currentActionId;
  const eventActionId = typeof summary.eventActionId === 'string'
    && stats.some(action => action?.id === summary.eventActionId)
    ? summary.eventActionId
    : null;
  const actionId = eventActionId || (currentActionId !== nextActionId
    ? (currentActionId || nextActionId)
    : nextActionId);
  if (!actionId) return null;
  const currentAction = actions.find(action => action?.id === actionId) || null;
  const summaryAction = stats.find(action => action?.id === actionId)
    || (summary.currentAction?.id === actionId ? summary.currentAction : null);
  if (currentAction && summaryAction && isActionProgressStale(currentAction, summaryAction)) return null;
  const currentGeneration = positiveIntegerOrNull(currentAction?.generation);
  const summaryGeneration = positiveIntegerOrNull(summaryAction?.generation);
  const summaryAttempt = nonNegativeIntegerOrNull(summaryAction?.attempt);
  const refreshIdentity = {
    actionId,
    generation: summaryGeneration || currentGeneration || 1,
    ...(summaryAttempt == null ? {} : { attempt: summaryAttempt }),
  };
  if (eventActionId || currentActionId !== nextActionId || !currentAction) return refreshIdentity;
  if (currentGeneration != null && summaryGeneration != null && summaryGeneration > currentGeneration) {
    return refreshIdentity;
  }
  if (currentAction?.status === 'running' && summaryAction?.status && summaryAction.status !== 'running') {
    return refreshIdentity;
  }
  return null;
}

export function workItemDetailNeedsRefresh(current, summary) {
  if (!current || current.id !== summary?.id || isWorkItemStateStale(summary, current)) return false;
  const coordinatorRevision = numberOrNull(summary.coordinatorRevision);
  const currentCoordinatorRevision = numberOrNull(current.coordinatorRevision) ?? 0;
  if (coordinatorRevision != null && coordinatorRevision > currentCoordinatorRevision) return true;
  return workItemDetailRefreshIdentity(current, summary) != null;
}

const PROGRESS_BOUND_SUMMARY_FIELDS = new Set([
  'status',
  'lifecycle',
  'attentionState',
  'activeActionIds',
  'attentionActionIds',
  'currentActionId',
  'currentAction',
  'executionStats',
  'failureReason',
]);

export function mergeWorkItemSummary(current, summary) {
  if (!current || current.id !== summary?.id) return current;
  if (isWorkItemStateStale(summary, current)
      || isOlderResourceOnlySnapshot(current, summary, current.actions, summary.actionStats)) {
    return withLatestExecutionControl(current, summary, current);
  }
  const merged = { ...current };
  let aggregateAccepted = !Array.isArray(current.actions) || !Array.isArray(summary.actionStats);
  if (Array.isArray(current.actions) && Array.isArray(summary.actionStats)) {
    const statsById = new Map(summary.actionStats.map(stats => [stats?.id, stats]));
    let matchedStats = false;
    aggregateAccepted = true;
    merged.actions = current.actions.map(action => {
      const stats = statsById.get(action?.id);
      if (!stats) return action;
      matchedStats = true;
      if (isActionProgressStale(action, stats)) {
        aggregateAccepted = false;
        return action;
      }
      const nextProgress = numberOrNull(stats?.progressRevision);
      if (nextProgress == null) {
        const { response, messages, ...legacyStats } = stats;
        return { ...action, ...legacyStats };
      }
      const currentGeneration = positiveIntegerOrNull(action?.generation);
      const nextGeneration = positiveIntegerOrNull(stats?.generation);
      if (currentGeneration != null && nextGeneration != null && nextGeneration > currentGeneration) {
        const {
          messages: _messages,
          thread: _thread,
          liveMessage: _liveMessage,
          response: _response,
          failure: _failure,
          messageCursor: _messageCursor,
          messageCount: _messageCount,
          failureReason: _failureReason,
          ...generationIndependent
        } = action;
        return { ...generationIndependent, ...stats };
      }
      return { ...action, ...stats };
    });
    // A new Coordinator turn can replace/close the entire Action set. Its
    // lifecycle must advance with its version, even when no old Action matches;
    // otherwise we manufacture an equal-version terminal snapshot that blocks
    // the subsequent authoritative detail response.
    if (!matchedStats) aggregateAccepted = Number(summary.coordinatorRevision) > Number(current.coordinatorRevision || 0);
  }
  for (const field of DETAIL_SUMMARY_FIELDS) {
    if (!aggregateAccepted && PROGRESS_BOUND_SUMMARY_FIELDS.has(field)) continue;
    if (field === 'executionControl') continue;
    if (Object.prototype.hasOwnProperty.call(summary, field)) merged[field] = summary[field];
  }
  const resourceSource = aggregateAccepted ? summary : current;
  merged.executionControl = withLatestExecutionControl(current, summary, resourceSource).executionControl;
  return withLatestExecutionControl(current, merged, merged);
}

function hasStaleActionProgress(currentStats, nextStats) {
  if (!Array.isArray(currentStats) || !Array.isArray(nextStats)) return false;
  const currentById = new Map(currentStats.map(stats => [stats?.id, stats]));
  return nextStats.some(stats => {
    const current = currentById.get(stats?.id);
    return current ? isActionProgressStale(current, stats) : false;
  });
}

function isSameWorkItemVersion(current, summary) {
  const independentResources = positiveIntegerOrNull(current?.executionControl?.dataRevision) != null
    || positiveIntegerOrNull(summary?.executionControl?.dataRevision) != null;
  return (independentResources
      || numberOrNull(current?.executionControl?.revision) === numberOrNull(summary?.executionControl?.revision))
    && numberOrNull(current?.revision) === numberOrNull(summary?.revision)
    && numberOrNull(current?.coordinatorRevision) === numberOrNull(summary?.coordinatorRevision)
    && numberOrNull(current?.updatedAt) === numberOrNull(summary?.updatedAt);
}

function isOlderResourceOnlySnapshot(current, candidate, currentStats, candidateStats) {
  return compareExecutionControl(candidate.executionControl, current.executionControl) < 0
    && isSameWorkItemVersion(current, candidate)
    && !hasStaleActionProgress(candidateStats, currentStats);
}

export function isWorkItemDetailStale(detail, current) {
  if (!detail || !current || detail.id !== current.id) return false;
  if (isWorkItemSummaryStale(detail, current)) return true;
  return isSameWorkItemVersion(current, detail)
    && hasStaleActionProgress(current.actions, detail.actions);
}

export function mergeWorkItemDetail(current, detail) {
  if (!current || current.id !== detail?.id) return detail;
  const stateStale = isWorkItemStateStale(detail, current)
    || isOlderResourceOnlySnapshot(current, detail, current.actions, detail.actions)
    || (isSameWorkItemVersion(current, detail) && hasStaleActionProgress(current.actions, detail.actions));
  return withLatestExecutionControl(current, detail, stateStale ? current : detail);
}

export function applyWorkItemSummary(items, summary) {
  const current = Array.isArray(items) ? items : [];
  const existing = current.find(item => item.id === summary?.id) || null;
  let nextSummary = existing && isWorkItemStateStale(summary, existing) ? existing : summary;
  if (existing && nextSummary === summary && (
    isOlderResourceOnlySnapshot(existing, summary, existing.actionStats, summary.actionStats)
    || (isSameWorkItemVersion(existing, summary) && hasStaleActionProgress(existing.actionStats, summary.actionStats)))) {
    nextSummary = existing;
  }
  if (!nextSummary?.id) return current;
  if (existing) nextSummary = withLatestExecutionControl(existing, summary, nextSummary);
  return [nextSummary, ...current.filter(item => item.id !== nextSummary.id)]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

/** Activity is a live navigation projection, not the Action execution journal. */
export function workCenterActivityActions(item) {
  if (!item || ['done', 'cancelled'].includes(item.status) || ['done', 'cancelled'].includes(item.lifecycle)) return [];
  const actions = Array.isArray(item.actionStats) ? item.actionStats
    : item.currentAction?.id ? [item.currentAction] : [];
  return orderWorkCenterActions(actions.filter(action => ['ready', 'running', 'waiting'].includes(action?.status)));
}

export function workCenterItemTime(item) {
  return validWorkCenterTime(item?.updatedAt) || validWorkCenterTime(item?.createdAt);
}

export function workCenterActionTime(action) {
  return validWorkCenterTime(action?.createdAt) || validWorkCenterTime(action?.updatedAt);
}

function validWorkCenterTime(value) {
  const time = Number(value);
  return time > 0 && Number.isFinite(new Date(time).getTime()) ? time : 0;
}

/** Newest creation first; older Agents can supply sequence without timestamps. */
export function orderWorkCenterActions(actions) {
  return [...actions].sort((left, right) => {
    const leftTime = workCenterActionTime(left);
    const rightTime = workCenterActionTime(right);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return (Number(right?.sequence) || 0) - (Number(left?.sequence) || 0);
  });
}

/** Only summary fields may cross from a full detail into the activity cache. */
export function workCenterActivitySnapshot(detail) {
  if (!detail?.id) return null;
  const summary = { id: detail.id };
  for (const field of DETAIL_SUMMARY_FIELDS) {
    if (Object.hasOwn(detail, field)) summary[field] = detail[field];
  }
  if (Array.isArray(detail.actions)) {
    summary.actionStats = detail.actions.map(action => Object.fromEntries([
      'id', 'generation', 'attempt', 'status', 'sequence', 'createdAt', 'updatedAt',
      'assignedVp', 'contentSummary', 'progressRevision',
    ].filter(field => Object.hasOwn(action, field)).map(field => [field, action[field]])));
  } else if (Array.isArray(detail.actionStats)) summary.actionStats = detail.actionStats;
  return summary;
}
