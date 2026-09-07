import { reconstructDebugRawRequest } from '../debug-trace.js';
import {
  boundedDebugIdentity,
  enforceActionRequestDetailBudget,
  limitActionRequestDebugInput,
  sanitizeDebugValue,
  sanitizeDiagnosticText,
} from './debug-projection.js';
import { runMatchesActionIdentity } from './action-identity.js';
import { normalizeOutputs } from './evidence.js';
import { taskSpecificActionBrief } from './workflow.js';
import { buildMainlineProjection } from './mainline-projection.js';

const MAX_ACTION_MESSAGE_CHARS = 16_000;
const MAX_ACTION_DIAGNOSTIC_CHARS = 8_000;
const MAX_ACTION_MESSAGES = 20;
const MAX_ACTION_REQUEST_TOOL_CALLS = 128;
const MAX_ACTION_REQUEST_ID_BYTES = 256;
const MAX_ACTION_REQUEST_NAME_BYTES = 512;
const MAX_ACTION_REQUEST_MODEL_BYTES = 1_024;
const MAX_ACTION_REQUEST_STOP_REASON_BYTES = 256;
const MAX_ACTION_REQUEST_METADATA_BYTES = 4 * 1_024;
const MAX_SPEAKER_ID_BYTES = 256;
const MAX_SPEAKER_NAME_BYTES = 512;
const MAX_HISTORICAL_BRIEF_CHARS = 256;
const MAX_CURRENT_BRIEF_BYTES = 8 * 1024;
export const MAX_WORK_ITEM_BROWSER_DTO_BYTES = 512 * 1024;

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function exceedsUtf8Bytes(value, maxBytes) {
  return Buffer.byteLength(String(value || ''), 'utf8') > maxBytes;
}

function currentAction(detail) {
  if (!detail?.currentActionId || !Array.isArray(detail.actions)) return null;
  return detail.actions.find(action => action.id === detail.currentActionId) || null;
}

function projectCurrentActionSummary(action, projectedAction = action) {
  if (!projectedAction?.id) return null;
  return {
    id: projectedAction.id,
    type: projectedAction.type,
    stageId: projectedAction.stageId,
    generation: actionGeneration(projectedAction.generation),
    assignmentMode: projectedAction.assignmentPolicy?.mode || (projectedAction.requiredRole ? 'fixed' : null),
    status: projectedAction.status,
    objective: truncateUtf8(action?.brief?.objective, 1_000) || null,
    ...(projectedAction.assignedVp ? { assignedVp: projectedAction.assignedVp } : {}),
  };
}

const BOARD_ACTION_STATUSES = ['completed', 'closed', 'running', 'ready', 'waiting', 'failed'];

function boardActionCounts(actions) {
  const counts = Object.fromEntries(BOARD_ACTION_STATUSES.map(status => [status, 0]));
  for (const action of Array.isArray(actions) ? actions : []) {
    if (Object.hasOwn(counts, action?.status)) counts[action.status] += 1;
  }
  return counts;
}

export function workItemBoardLane(detail) {
  const actions = (Array.isArray(detail?.actions) ? detail.actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action?.status));
  if (['done', 'cancelled'].includes(detail?.status)) return 'closed';
  if (['draft', 'waiting', 'needs_attention'].includes(detail?.status)
      || actions.some(action => ['waiting', 'failed'].includes(action?.status))) {
    return 'needs_attention';
  }
  return 'active';
}

function boardActionSummary(action, runs, events) {
  if (!action) return null;
  const projected = projectAction(action, runs, events, false);
  return {
    id: projected.id,
    type: projected.type,
    stageId: projected.stageId,
    status: projected.status,
    objective: truncateUtf8(action?.brief?.objective, 1_000) || null,
    assignedVp: projected.assignedVp || null,
  };
}

function boardFields(detail) {
  const actions = (Array.isArray(detail?.actions) ? detail.actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action?.status));
  const runs = Array.isArray(detail?.runs) ? detail.runs : [];
  const events = Array.isArray(detail?.events) ? detail.events : [];
  const bySequence = (left, right) => count(left?.sequence) - count(right?.sequence)
    || String(left?.id || '').localeCompare(String(right?.id || ''));
  const attentionAction = [...actions]
    .filter(action => ['waiting', 'failed'].includes(action?.status))
    .sort((left, right) => {
      const priority = { waiting: 0, failed: 1 };
      return priority[left.status] - priority[right.status] || bySequence(left, right);
    })[0] || null;
  const activeAction = [...actions]
    .filter(action => ['running', 'ready'].includes(action?.status))
    .sort((left, right) => {
      const priority = { running: 0, ready: 1 };
      return priority[left.status] - priority[right.status] || bySequence(left, right);
    })[0] || null;
  const executors = [];
  const seenExecutors = new Set();
  for (const action of actions) {
    const assignedVp = projectAction(action, runs, events, false).assignedVp;
    if (!assignedVp?.id || seenExecutors.has(assignedVp.id)) continue;
    seenExecutors.add(assignedVp.id);
    executors.push(assignedVp);
  }
  return {
    boardLane: workItemBoardLane({ ...detail, actions }),
    actionCounts: boardActionCounts(actions),
    attentionAction: boardActionSummary(attentionAction, runs, events),
    activeAction: boardActionSummary(activeAction, runs, events),
    executors,
  };
}

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function emptyExecutionStats() {
  return {
    llmRequestCount: 0,
    loopCount: 0,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function executionStats(value) {
  const stats = emptyExecutionStats();
  for (const key of Object.keys(stats)) stats[key] = count(value?.[key]);
  return stats;
}

function sumExecutionStats(values) {
  return values.reduce((total, value) => {
    const next = executionStats(value);
    for (const key of Object.keys(total)) total[key] += next[key];
    return total;
  }, emptyExecutionStats());
}

function actionGeneration(value) {
  return Math.max(1, count(value) || 1);
}

function runGeneration(run) {
  return actionGeneration(run?.actionGeneration ?? run?.executionManifest?.actionGeneration);
}

function runSpecHash(run) {
  return typeof run?.actionSpecHash === 'string' && run.actionSpecHash
    ? run.actionSpecHash
    : typeof run?.executionManifest?.actionSpecHash === 'string'
      ? run.executionManifest.actionSpecHash
      : '';
}

function conversationIdentitySelection(action) {
  const currentGeneration = actionGeneration(action?.generation);
  const generations = new Set([currentGeneration]);
  const selectedSpecByGeneration = new Map();
  for (const identity of Array.isArray(action?.identityHistory) ? action.identityHistory : []) {
    const generation = Number(identity?.generation);
    if (!Number.isInteger(generation) || generation <= 0 || generation > currentGeneration) continue;
    const specHash = typeof identity?.specHash === 'string' ? identity.specHash : '';
    if (!specHash && generation !== 1) continue;
    generations.add(generation);
    if (specHash) selectedSpecByGeneration.set(generation, specHash);
  }
  if (typeof action?.specHash === 'string' && action.specHash) {
    selectedSpecByGeneration.set(currentGeneration, action.specHash);
  }
  return { generations, selectedSpecByGeneration };
}

function conversationRuns(action, runs) {
  const source = (Array.isArray(runs) ? runs : []).filter(run => run?.actionId === action?.id);
  const { generations, selectedSpecByGeneration } = conversationIdentitySelection(action);
  return source.filter(run => {
    const generation = runGeneration(run);
    if (!generations.has(generation)) return false;
    const selectedSpec = selectedSpecByGeneration.get(generation) || '';
    const spec = runSpecHash(run);
    return selectedSpec ? spec === selectedSpec : generation === 1 && !spec;
  });
}

function projectVpSpeaker(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const sourceId = typeof snapshot.id === 'string' ? snapshot.id.trim() : '';
  if (!sourceId) return null;
  const id = truncateUtf8(sourceId, MAX_SPEAKER_ID_BYTES);
  const sourceName = typeof snapshot.name === 'string' ? snapshot.name.trim() : '';
  const name = truncateUtf8(sourceName || id, MAX_SPEAKER_NAME_BYTES) || id;
  return { id, name };
}

function compareEventIds(leftId, rightId) {
  const left = String(leftId ?? '');
  const right = String(rightId ?? '');
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    return 0;
  }
  return left.localeCompare(right);
}

function compareStoredEvents(left, right) {
  return count(left?.createdAt) - count(right?.createdAt)
    || compareEventIds(left?.id, right?.id);
}

function projectedEventId(message) {
  return typeof message?.id === 'string' && message.id.startsWith('event:')
    ? message.id.slice('event:'.length)
    : null;
}

function compareProjectedMessages(left, right) {
  const timeOrder = count(left?.createdAt) - count(right?.createdAt);
  if (timeOrder) return timeOrder;
  const leftEventId = projectedEventId(left);
  const rightEventId = projectedEventId(right);
  if (leftEventId != null && rightEventId != null) {
    return compareEventIds(leftEventId, rightEventId);
  }
  const leftRole = left?.role === 'user' ? 0 : 1;
  const rightRole = right?.role === 'user' ? 0 : 1;
  if (leftRole !== rightRole) return leftRole - rightRole;
  const generationOrder = count(left?.generation) - count(right?.generation);
  if (generationOrder) return generationOrder;
  const attemptOrder = count(left?.attempt) - count(right?.attempt);
  return attemptOrder
    || String(left?.id || '').localeCompare(String(right?.id || ''));
}

function projectedMessageQuote(value) {
  if (!value || typeof value !== 'object') return null;
  const content = truncateUtf8(value.content || '', MAX_ACTION_MESSAGE_CHARS);
  const todos = Array.isArray(value.todos) ? value.todos.slice(0, 100).map(todo => ({
    content: truncateUtf8(todo?.content || '', 2_000),
    status: ['pending', 'in_progress', 'completed'].includes(todo?.status) ? todo.status : 'pending',
    ...(todo?.activeForm ? { activeForm: truncateUtf8(todo.activeForm, 2_000) } : {}),
  })).filter(todo => todo.content) : [];
  if (!content && todos.length === 0) return null;
  return {
    id: truncateUtf8(value.id || '', 256) || null,
    role: value.role === 'assistant' ? 'assistant' : 'user',
    author: truncateUtf8(value.author || '', 256) || (value.role === 'assistant' ? 'Assistant' : 'User'),
    content,
    ...(Number(value.timestamp) > 0 ? { timestamp: Number(value.timestamp) } : {}),
    ...(todos.length > 0 ? { todos } : {}),
  };
}

function normalizeProjectedMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const text = typeof message.text === 'string'
    ? message.text.trim().slice(0, MAX_ACTION_MESSAGE_CHARS)
    : '';
  const attachments = projectAttachments(message.attachments);
  if (!text && attachments.length === 0) return null;
  const speaker = message.role === 'user' ? null : projectVpSpeaker(message.speaker);
  return {
    id: String(message.id || ''),
    role: message.role === 'user' ? 'user' : 'assistant',
    kind: message.kind === 'input' ? 'input' : 'response',
    status: message.status || null,
    text,
    attachments,
    ...(projectedMessageQuote(message.quote) ? { quote: projectedMessageQuote(message.quote) } : {}),
    createdAt: count(message.createdAt),
    updatedAt: count(message.updatedAt || message.createdAt),
    ...(message.progressRevision == null ? {} : { progressRevision: count(message.progressRevision) }),
    ...(message.generation == null ? {} : { generation: Math.max(1, count(message.generation) || 1) }),
    ...(message.attempt == null ? {} : { attempt: Math.max(1, count(message.attempt) || 1) }),
    ...(message.runId == null ? {} : { runId: String(message.runId) }),
    ...(speaker ? { speaker } : {}),
  };
}

function actionInputMessages(action, events, generation = actionGeneration(action?.generation)) {
  return (Array.isArray(events) ? events : [])
    .filter(event => event?.actionId === action?.id
      && actionGeneration(event.actionGeneration) === generation
      && ['action.guidance_added', 'action.input_added'].includes(event.type))
    .map(event => normalizeProjectedMessage({
      id: `event:${event.id}`,
      role: 'user',
      kind: 'input',
      status: 'sent',
      text: event.data?.text || event.data?.guidance || '',
      quote: event.data?.quote,
      attachments: event.data?.attachments,
      createdAt: event.createdAt,
    }))
    .filter(Boolean);
}

function runResponseMessage(run) {
  const response = typeof run?.response === 'string' ? run.response : '';
  const text = response.trim() || (run?.status === 'failed' ? failedRunMessageText(run) : '');
  return normalizeProjectedMessage({
    id: `run:${run.id}`,
    role: 'assistant',
    kind: 'response',
    status: run.status || 'running',
    text,
    createdAt: count(run.endedAt || run.startedAt),
    updatedAt: count(run.endedAt || run.startedAt),
    progressRevision: count(run.progressRevision),
    generation: runGeneration(run),
    attempt: Math.max(1, count(run.actionAttempt) || 1),
    runId: run.id,
    speaker: run.vpSnapshot,
  });
}

function loopOutputMessages(action, events, matchingRuns, generation = actionGeneration(action?.generation)) {
  const runById = new Map(matchingRuns.map(run => [run.id, run]));
  const projected = [];
  let previousTranscriptEvent = null;
  const timeline = (Array.isArray(events) ? events : [])
    .filter(event => event?.actionId === action?.id
      && actionGeneration(event.actionGeneration ?? event.data?.actionGeneration) === generation)
    .sort(compareStoredEvents);
  for (const event of timeline) {
    if (['action.guidance_added', 'action.input_added'].includes(event.type)) {
      previousTranscriptEvent = { type: 'input' };
      continue;
    }
    if (event.type !== 'run.loop_output') continue;
    if (!runById.has(event.runId)) {
      previousTranscriptEvent = { type: 'other_loop_output' };
      continue;
    }
    const run = runById.get(event.runId);
    const message = normalizeProjectedMessage({
      id: `event:${event.id}`,
      role: 'assistant',
      kind: 'response',
      status: 'completed',
      text: event.data?.response || '',
      createdAt: count(run.endedAt || event.createdAt),
      generation: runGeneration(run),
      attempt: Math.max(1, count(run.actionAttempt) || 1),
      runId: event.runId,
      speaker: run.vpSnapshot,
    });
    if (!message) continue;
    if (previousTranscriptEvent?.type === 'loop_output'
      && previousTranscriptEvent.runId === message.runId
      && previousTranscriptEvent.text === message.text) continue;
    previousTranscriptEvent = { type: 'loop_output', runId: message.runId, text: message.text };
    projected.push(message);
  }
  return projected;
}

function messagesForGeneration(action, runs, events, generation) {
  const matchingRuns = conversationRuns(action, runs).filter(run => (
    runGeneration(run) === generation && run?.status !== 'running'
  ));
  const failedWithoutResponse = new Set(matchingRuns
    .filter(run => run?.status === 'failed' && !String(run?.response || '').trim())
    .map(run => run.id));
  const loopMessages = loopOutputMessages(
    action,
    events,
    matchingRuns.filter(run => !failedWithoutResponse.has(run.id)),
    generation,
  );
  const runsWithLoopOutput = new Set(loopMessages.map(message => message.runId).filter(Boolean));
  return [
    ...actionInputMessages(action, events, generation),
    ...loopMessages,
    ...matchingRuns
      .sort((left, right) => count(left.startedAt) - count(right.startedAt))
      .filter(run => !runsWithLoopOutput.has(run.id))
      .map(run => runResponseMessage(run))
      .filter(Boolean),
  ].sort(compareProjectedMessages);
}

function actionConversationMessages(action, runs, events) {
  const allRuns = conversationRuns(action, runs);
  const { generations } = conversationIdentitySelection(action);
  return [...generations]
    .flatMap(generation => messagesForGeneration(action, allRuns, events, generation))
    .sort(compareProjectedMessages);
}



const MAX_FAILURE_REASON_LENGTH = 2_000;
const MAX_FAILURE_INSPECTION_LENGTH = 16_000;
const DEFAULT_FAILED_RUN_MESSAGE = 'The Action failed.';
const SAFE_FAILURE_FALLBACK = 'The Action failed. Sensitive details were omitted.';
const CREDENTIAL_ASSIGNMENT_PATTERN = /\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|api[_-]?key|access[_-]?token|authorization|password|secret|token)\s*[:=]/i;
const PROVIDER_TOKEN_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,})\b/i;
const HIGH_ENTROPY_SECRET_PATTERN = /\b(?=[A-Za-z0-9_./+=-]{32,}\b)(?=[A-Za-z0-9_./+=-]*[A-Za-z])(?=[A-Za-z0-9_./+=-]*\d)[A-Za-z0-9_./+=-]+\b/;
const LOCAL_PATH_ASSIGNMENT_PATTERN = /\b(?:path|cwd|file|filename|directory)\s*[:=]\s*(?:\/(?!\/)|[A-Za-z]:\\|\\\\)/i;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])\/(?!\/)[^\r\n]*/m;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`])(?:[A-Za-z]:\\|\\\\)[^\r\n]*/m;

function sanitizedUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '[redacted URL]';
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[redacted URL]';
  }
}

function unsafeFailureText(raw) {
  return PROVIDER_TOKEN_PATTERN.test(raw) || HIGH_ENTROPY_SECRET_PATTERN.test(raw)
    || LOCAL_PATH_ASSIGNMENT_PATTERN.test(raw) || POSIX_ABSOLUTE_PATH_PATTERN.test(raw)
    || WINDOWS_ABSOLUTE_PATH_PATTERN.test(raw);
}

function sanitizeFailureDiagnostic(value) {
  const raw = typeof value === 'string'
    ? value.trim().slice(0, MAX_FAILURE_INSPECTION_LENGTH)
    : '';
  if (!raw) return '';
  if (unsafeFailureText(raw)) return SAFE_FAILURE_FALLBACK;
  return sanitizeDiagnosticText(raw, MAX_ACTION_DIAGNOSTIC_CHARS);
}

function failedRunMessageText(run) {
  const diagnostics = [
    sanitizeFailureDiagnostic(run?.summary),
    sanitizeFailureDiagnostic(run?.error),
  ].filter(Boolean);
  return [...new Set(diagnostics)].join('\n\n') || DEFAULT_FAILED_RUN_MESSAGE;
}

function sanitizeFailureReason(value) {
  const raw = typeof value === 'string'
    ? value.trim().slice(0, MAX_FAILURE_INSPECTION_LENGTH)
    : '';
  if (!raw) return '';
  if (unsafeFailureText(raw)) return SAFE_FAILURE_FALLBACK;
  const text = raw.replace(/https?:\/\/[^\s<>'"`]+/gi, sanitizedUrl);
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(text)) return SAFE_FAILURE_FALLBACK;
  return text
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted credential]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, MAX_FAILURE_REASON_LENGTH);
}



function actionExecution(action, runs, events, includeBody = true) {
  let conversationMessages = Array.isArray(runs)
    ? actionConversationMessages(action, runs, events)
    : [];
  if (conversationMessages.length === 0 && Array.isArray(action?.messages)) {
    conversationMessages = action.messages.map(normalizeProjectedMessage).filter(Boolean);
  }
  const messageCount = Array.isArray(runs)
    ? conversationMessages.length
    : count(action?.messageCount) || conversationMessages.length;
  const messages = includeBody ? conversationMessages.slice(-MAX_ACTION_MESSAGES) : [];
  const messageCursor = Array.isArray(runs)
    ? (includeBody
        ? (messageCount > messages.length ? String(messageCount - messages.length) : null)
        : (messageCount > 0 ? String(messageCount) : null))
    : action?.messageCursor == null ? null : String(action.messageCursor);
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action?.id && runMatchesActionIdentity(run, action))
    : [];
  if (matchingRuns.length === 0) {
    return {
      ...executionStats(action?.executionStats || action),
      response: includeBody && typeof action?.response === 'string' ? action.response : '',
      failure: includeBody && action?.failure && typeof action.failure === 'object'
        ? {
            ...(action.failure.kind === 'system_blocked' ? {
              kind: 'system_blocked',
              code: typeof action.failure.code === 'string' ? truncateUtf8(action.failure.code, 128) : null,
            } : {}),
            error: sanitizeFailureDiagnostic(action.failure.error),
            summary: sanitizeFailureDiagnostic(action.failure.summary),
            failedAt: count(action.failure.failedAt),
          }
        : null,
      progressRevision: count(action?.progressRevision),
      messages,
      liveMessage: includeBody ? normalizeProjectedMessage(action?.liveMessage) : null,
      messageCount,
      messageCursor,
      failureReason: sanitizeFailureReason(action?.failureReason),
    };
  }
  const stats = sumExecutionStats(matchingRuns);
  const latest = [...matchingRuns].sort((left, right) => (
    count(right.progressRevision) - count(left.progressRevision)
      || count(right.startedAt) - count(left.startedAt)
  ))[0];
  const latestFailure = action?.status === 'failed'
    ? [...matchingRuns]
        .filter(run => run?.status === 'failed')
        .sort((left, right) => count(right.endedAt || right.startedAt) - count(left.endedAt || left.startedAt))[0]
    : null;
  const liveMessage = includeBody ? runResponseMessage(latest) : null;
  return {
    ...stats,
    response: includeBody && typeof latest?.response === 'string' ? latest.response : '',
    failure: includeBody && latestFailure ? {
      ...(latestFailure.failureKind === 'system_blocked' ? {
        kind: 'system_blocked',
        code: typeof latestFailure.failureCode === 'string' ? truncateUtf8(latestFailure.failureCode, 128) : null,
      } : {}),
      error: sanitizeFailureDiagnostic(latestFailure.error),
      summary: sanitizeFailureDiagnostic(latestFailure.summary),
      failedAt: count(latestFailure.endedAt || latestFailure.startedAt),
    } : null,
    failureReason: sanitizeFailureReason(latestFailure?.error),
    progressRevision: count(latest?.progressRevision),
    messages,
    liveMessage,
    messageCount,
    messageCursor,
  };
}

function projectAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map(attachment => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: count(attachment.size),
    isImage: attachment.isImage === true,
  }));
}

function projectAssignmentPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null;
  return {
    mode: policy.mode || null,
    capability: policy.capability || null,
    fixedVpId: policy.fixedVpId || null,
  };
}

function projectAction(action, runs, events, includeBody = true) {
  if (!action) return null;
  const execution = actionExecution(action, runs, events, includeBody);
  const alreadyProjected = !Array.isArray(runs) && Array.isArray(action.messages);
  const brief = taskSpecificActionBrief(action.brief, action.type);
  const projectedBrief = !brief
    ? brief
    : Object.fromEntries(Object.entries(brief).map(([key, value]) => [
        key,
        truncateUtf8(value, includeBody ? MAX_CURRENT_BRIEF_BYTES : MAX_HISTORICAL_BRIEF_CHARS),
      ]));
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action.id && runMatchesActionIdentity(run, action))
    : [];
  const latestRun = [...matchingRuns].sort((left, right) => (
    count(right.startedAt) - count(left.startedAt) || count(right.progressRevision) - count(left.progressRevision)
  ))[0];
  const assignedVp = latestRun?.vpSnapshot ? {
    id: latestRun.vpSnapshot.id || null,
    name: latestRun.vpSnapshot.name || latestRun.vpSnapshot.id || null,
  } : null;
  const contentSummary = truncateUtf8(
    execution.response || latestRun?.summary || brief?.objective || brief?.expectedOutcome || '',
    MAX_HISTORICAL_BRIEF_CHARS,
  );
  return {
    id: action.id,
    sequence: action.sequence,
    type: action.type,
    stageId: action.stageId || action.type,
    assignmentPolicy: alreadyProjected
      ? (action.assignmentPolicy || null)
      : projectAssignmentPolicy(action.assignmentPolicy),
    dependsOnStageIds: Array.isArray(action.dependsOnStageIds) ? action.dependsOnStageIds : [],
    sourceActionIds: Array.isArray(action.sourceActionIds) ? action.sourceActionIds : [],
    workspaceMode: action.workspaceMode || 'shared',
    requiredRole: action.requiredRole || '',
    generation: Math.max(1, count(action.generation) || 1),
    replacesActionId: action.replacesActionId || null,
    closeReason: action.closeReason || null,
    closedAt: count(action.closedAt),
    brief: projectedBrief,
    status: action.status,
    assignedVp,
    contentSummary,
    executionStats: executionStats(execution),
    loopCount: execution.loopCount,
    toolCount: execution.toolCount,
    ...(includeBody ? {
      response: execution.response,
      failureReason: execution.failureReason,
    } : {}),
    progressRevision: execution.progressRevision,
    messageCount: execution.messageCount,
    messageCursor: execution.messageCursor,
    ...(includeBody ? {
      response: execution.response,
      failure: execution.failure,
      messages: execution.messages,
      liveMessage: execution.liveMessage,
    } : {}),
  };
}

function bodyActionId(detail) {
  const actions = Array.isArray(detail?.actions) ? detail.actions : [];
  if (detail?.currentActionId && actions.some(action => action?.id === detail.currentActionId)) {
    return detail.currentActionId;
  }
  return [...actions].sort((left, right) => (
    count(right?.sequence) - count(left?.sequence)
      || String(right?.id || '').localeCompare(String(left?.id || ''))
  ))[0]?.id || null;
}

function stripActionBody(action, keepFailure = false) {
  if (!action) return action;
  const projected = { ...action };
  delete projected.response;
  delete projected.messages;
  delete projected.thread;
  delete projected.liveMessage;
  if (!keepFailure) delete projected.failure;
  if (projected.brief) {
    projected.brief = Object.fromEntries(Object.entries(projected.brief).map(([key, value]) => [
      key,
      truncateUtf8(value, MAX_HISTORICAL_BRIEF_CHARS),
    ]));
  }
  return projected;
}

function canonicalActions(detail) {
  return Array.isArray(detail?.actions)
    ? detail.actions.filter(action => !['superseded', 'cancelled'].includes(action?.status))
    : [];
}

function projectActionStats(detail, liveActionId = bodyActionId(detail)) {
  return canonicalActions(detail).map(action => {
    const projected = projectAction(
      action,
      detail.runs,
      detail.events,
      action?.id === liveActionId,
    );
    const stats = {
      id: projected.id,
      generation: actionGeneration(projected.generation),
      status: projected.status,
      assignedVp: projected.assignedVp,
      contentSummary: projected.contentSummary,
      executionStats: projected.executionStats,
      loopCount: projected.loopCount,
      toolCount: projected.toolCount,
      progressRevision: projected.progressRevision,
      attempt: Math.max(0, count(action?.attempt)),
    };
    if (projected.failureReason) stats.failureReason = projected.failureReason;
    if (projected.id === liveActionId) {
      stats.response = projected.response;
      stats.failure = projected.failure;
      if (projected.liveMessage) stats.liveMessage = projected.liveMessage;
    }
    return stats;
  });
}

function enforceWorkItemBrowserDtoBudget(value, options = {}) {
  if (!value || jsonByteLength(value) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return value;
  const dto = value;
  const workItem = options.event === true ? dto.workItem : dto;
  let actions = Array.isArray(workItem?.actions)
    ? workItem.actions
    : Array.isArray(workItem?.actionStats) ? workItem.actionStats : [];
  const keepId = options.keepActionId || workItem?.currentActionId || actions.at(-1)?.id || null;
  workItem.truncated = true;

  if (!Array.isArray(workItem.actions) && Array.isArray(workItem.actionStats)) {
    workItem.actionStats = actions.map(action => ({
      id: action?.id,
      generation: actionGeneration(action?.generation),
      status: action?.status,
      progressRevision: count(action?.progressRevision),
      attempt: Math.max(0, count(action?.attempt)),
    }));
    actions = workItem.actionStats;
    if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;
  }

  for (let index = 0; index < actions.length; index += 1) {
    if (actions[index]?.id === keepId) continue;
    actions[index] = stripActionBody(actions[index]);
  }
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  const keep = actions.find(action => action?.id === keepId);
  if (keep) {
    delete keep.response;
    delete keep.messages;
    delete keep.thread;
    delete keep.liveMessage;
  }
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  const originalCount = actions.length;
  const retained = keep ? [stripActionBody(keep, true)] : [];
  if (Array.isArray(workItem.actions)) workItem.actions = retained;
  else workItem.actionStats = retained;
  workItem.omittedActionCount = originalCount - retained.length;
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  if (retained[0]) {
    delete retained[0].brief;
    delete retained[0].failure;
  }
  workItem.title = truncateUtf8(workItem.title, 4 * 1024);
  workItem.goal = truncateUtf8(workItem.goal, 4 * 1024);
  workItem.waitingReason = truncateUtf8(workItem.waitingReason, 4 * 1024);
  workItem.actionSummary = truncateUtf8(workItem.actionSummary, 4 * 1024);
  if (Array.isArray(workItem.acceptanceCriteria)) workItem.acceptanceCriteria = [];
  if (Array.isArray(workItem.linkedSessionIds)) workItem.linkedSessionIds = [];
  if (Array.isArray(workItem.attachments)) workItem.attachments = [];
  if (jsonByteLength(dto) <= MAX_WORK_ITEM_BROWSER_DTO_BYTES) return dto;

  const minimalWorkItem = {
    id: truncateUtf8(workItem.id, 4 * 1024),
    revision: count(workItem.revision),
    title: truncateUtf8(workItem.title, 4 * 1024),
    goal: truncateUtf8(workItem.goal, 4 * 1024),
    status: truncateUtf8(workItem.status, 256),
    currentActionId: truncateUtf8(workItem.currentActionId, 4 * 1024) || null,
    executionStats: workItem.executionStats,
    actionCount: count(workItem.actionCount),
    actions: Array.isArray(workItem.actions) ? [] : undefined,
    actionStats: Array.isArray(workItem.actionStats) ? [] : undefined,
    truncated: true,
    omittedActionCount: originalCount,
    createdAt: count(workItem.createdAt),
    updatedAt: count(workItem.updatedAt),
    coordinatorRevision: count(workItem.coordinatorRevision),
  };
  if (options.event === true) dto.workItem = minimalWorkItem;
  else return minimalWorkItem;
  return dto;
}

function sanitizeMainlineDiagnostic(value, maxBytes) {
  return sanitizeDiagnosticText(value, maxBytes)
    .replace(/\bfile:\/\/[^\r\n"'<>]+/gi, '[path redacted]')
    .replace(/\\\\(?:\?\\)?[^\\\r\n"'<>]+(?:\\[^\\\r\n"'<>]+)+/g, '[path redacted]')
    .replace(/\b[A-Za-z]:\\[^\r\n"'<>]+/g, '[path redacted]')
    .replace(/(?<![:/])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/g, '[path redacted]');
}

function projectCanonicalEvidence(value, options = {}) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(item => {
    if (typeof item === 'string') return sanitizeMainlineDiagnostic(item, 1_000);
    if (!item || typeof item !== 'object') return null;
    const projected = {};
    for (const key of ['kind', 'label', 'ref', 'status']) {
      if (typeof item[key] !== 'string') continue;
      projected[key] = options.preserveRef === true && key === 'ref'
        ? truncateUtf8(item[key], 1_000)
        : sanitizeMainlineDiagnostic(item[key], 1_000);
    }
    return Object.keys(projected).length > 0 ? projected : null;
  }).filter(Boolean);
}

function projectMainlineBrowser(detail) {
  if (!detail?.id || Number(detail.executionSchemaVersion) < 2) return null;
  const mainline = buildMainlineProjection(detail);
  const actionSet = mainline.actionJournal || mainline.graph;
  const nodes = actionSet.entries || actionSet.nodes || [];
  const frontier = actionSet.runnableActionIds || actionSet.frontier || [];
  const actionById = new Map((detail.actions || []).map(action => [action.id, action]));
  const activeActionIds = Array.isArray(detail.activeActionIds)
    ? detail.activeActionIds
    : nodes.filter(node => ['ready', 'running'].includes(node.status)).map(node => node.id);
  const attentionActionIds = Array.isArray(detail.attentionActionIds)
    ? detail.attentionActionIds
    : nodes.filter(node => ['waiting', 'failed'].includes(node.status)).map(node => node.id);
  const counts = Object.fromEntries(['completed', 'closed', 'running', 'ready', 'waiting', 'failed']
    .map(status => [status, nodes.filter(node => node.status === status).length]));
  return {
    contract: {
      title: truncateUtf8(mainline.contract.title, 8_000),
      goal: truncateUtf8(mainline.contract.goal, 16_000),
      acceptanceCriteria: mainline.contract.acceptanceCriteria.slice(0, 100)
        .map(criterion => truncateUtf8(criterion, 4_000)),
    },
    progress: {
      lifecycle: detail.lifecycle || (counts.completed === nodes.length ? 'done' : 'active'),
      attentionState: detail.attentionState || (counts.waiting && counts.failed ? 'mixed'
        : counts.waiting ? 'waiting' : counts.failed ? 'failed' : 'none'),
      activeActionIds: [...activeActionIds],
      attentionActionIds: [...attentionActionIds],
      frontierActionIds: [...frontier],
      counts,
    },
    actions: nodes.map(node => {
      const action = actionById.get(node.id) || {};
      const result = mainline.canonicalActionResults[node.id];
      return {
        id: node.id,
        stageId: node.stageId,
        type: node.type,
        status: node.status,
        generation: node.generation,
        brief: taskSpecificActionBrief(action.brief, action.type)
          ? Object.fromEntries(Object.entries(taskSpecificActionBrief(action.brief, action.type)).map(([key, value]) => [
              key,
              truncateUtf8(value, MAX_CURRENT_BRIEF_BYTES),
            ]))
          : null,
        dependencies: [...(node.sourceActionIds?.length ? node.sourceActionIds : node.dependsOnStageIds || [])],
        canonicalResult: result ? {
          status: result.status,
          summary: sanitizeMainlineDiagnostic(result.summary, MAX_ACTION_DIAGNOSTIC_CHARS),
          evidence: projectCanonicalEvidence(result.evidence),
          outputs: projectCanonicalEvidence(normalizeOutputs(result.outputs), { preserveRef: true }),
          waitingReason: sanitizeDiagnosticText(result.waitingReason, MAX_ACTION_DIAGNOSTIC_CHARS) || null,
          reviewDecision: typeof result.reviewDecision === 'string'
            ? truncateUtf8(result.reviewDecision, 256) : null,
        } : null,
      };
    }),
  };
}

function waitingReason(detail) {
  if (typeof detail?.waitingReason === 'string') return detail.waitingReason;
  const coordinatorQuestion = [...(Array.isArray(detail?.messages) ? detail.messages : [])]
    .reverse().find(message => message?.role === 'assistant'
      && message?.decision?.kind === 'request_human')?.decision?.question;
  if (typeof coordinatorQuestion === 'string' && coordinatorQuestion.trim()) return coordinatorQuestion;
  if (detail?.status !== 'waiting') return '';
  const waitingEvent = Array.isArray(detail?.events)
    ? detail.events.find(event => event?.type === 'action.waiting'
      && event?.actionId === detail.currentActionId
      && typeof event?.data?.reason === 'string')
    : null;
  if (waitingEvent) return waitingEvent.data.reason;
  if (!Array.isArray(detail.runs)) return '';
  return detail.runs.find(run => (
    run?.actionId === detail.currentActionId && typeof run.waitingReason === 'string'
  ))?.waitingReason || '';
}

function workItemFailureReason(detail) {
  if (!['needs_attention', 'cancelled'].includes(detail?.status) || !Array.isArray(detail?.runs)) return '';
  const ordered = [...detail.runs].sort((left, right) => (
    count(right.endedAt || right.startedAt) - count(left.endedAt || left.startedAt)
  ));
  const current = ordered.find(run => run?.actionId === detail.currentActionId && sanitizeFailureReason(run.error));
  return sanitizeFailureReason(current?.error || ordered.find(run => sanitizeFailureReason(run?.error))?.error);
}

/**
 * Authenticated browser detail DTO. Raw execution records stay Agent-local;
 * the browser receives only aggregate execution stats plus the explicit user-facing response.
 */
export function projectWorkItemDetail(detail, options = {}) {
  if (!detail) return null;
  const liveActionId = bodyActionId(detail);
  const bodyActionEvents = Array.isArray(options.bodyActionEvents)
    ? options.bodyActionEvents
    : detail.events;
  const mainline = projectMainlineBrowser(detail);
  const mainlineActionById = new Map((mainline?.actions || []).map(action => [action.id, action]));
  const canonicalOutputs = [];
  const seenOutputs = new Set();
  const runById = new Map((Array.isArray(detail.runs) ? detail.runs : []).map(run => [run.id, run]));
  for (const action of Array.isArray(detail.actions) ? detail.actions : []) {
    const run = action?.resultRunId ? runById.get(action.resultRunId) : null;
    if (!run || run.status !== 'completed') continue;
    for (const output of normalizeOutputs(run.outputs)) {
      const key = `${output.kind}\u0000${output.ref}`;
      if (seenOutputs.has(key)) continue;
      seenOutputs.add(key);
      canonicalOutputs.push({ ...output, actionId: action.id, runId: run.id });
    }
  }
  const projected = {
    id: detail.id,
    revision: detail.revision,
    planRevision: count(detail.planRevision),
    ledgerRevision: count(detail.ledgerRevision),
    coordinatorRevision: count(detail.coordinatorRevision),
    coordinationMode: detail.coordinationMode || 'legacy',
    outputs: canonicalOutputs.slice(0, 50).map(output => ({
      ...projectCanonicalEvidence([output], { preserveRef: true })[0],
      actionId: truncateUtf8(output.actionId || '', 256) || null,
      runId: truncateUtf8(output.runId || '', 256) || null,
    })).filter(output => output.kind && output.label && output.ref),
    finalResult: detail.finalResult && typeof detail.finalResult === 'object' ? {
      summary: truncateUtf8(detail.finalResult.summary || '', MAX_ACTION_MESSAGE_CHARS),
      acceptanceResults: Array.isArray(detail.finalResult.acceptanceResults)
        ? detail.finalResult.acceptanceResults.slice(0, 24).map(result => ({
            criterion: truncateUtf8(result?.criterion || '', MAX_ACTION_MESSAGE_CHARS),
            status: result?.status === 'passed' ? 'passed' : null,
            evidenceRunIds: Array.isArray(result?.evidenceRunIds)
              ? result.evidenceRunIds.map(String).slice(0, 24) : [],
          })) : [],
      evidenceRunIds: Array.isArray(detail.finalResult.evidenceRunIds)
        ? detail.finalResult.evidenceRunIds.map(String).slice(0, 64) : [],
      outputs: Array.isArray(detail.finalResult.outputs)
        ? detail.finalResult.outputs.slice(0, 50).map(rawOutput => {
            const output = normalizeOutputs([rawOutput])[0];
            if (!output) return null;
            return {
              ...projectCanonicalEvidence([output], { preserveRef: true })[0],
              runId: truncateUtf8(rawOutput?.runId || '', 256) || null,
            };
          }).filter(output => output?.kind && output.label && output.ref) : [],
      residualRisks: Array.isArray(detail.finalResult.residualRisks)
        ? detail.finalResult.residualRisks
          .map(risk => truncateUtf8(risk, MAX_ACTION_MESSAGE_CHARS)).slice(0, 24) : [],
    } : null,
    title: detail.title,
    goal: detail.goal,
    acceptanceCriteria: Array.isArray(detail.acceptanceCriteria) ? detail.acceptanceCriteria : [],
    workflowTemplate: detail.workflowTemplate,
    workItemType: detail.workflowSnapshot?.workItemType || detail.workItemType || null,
    planningMode: detail.workflowSnapshot?.planningMode || detail.planningMode || 'static',
    executionMode: detail.workflowSnapshot?.executionMode || detail.executionMode || 'linear',
    status: detail.status,
    lifecycle: detail.lifecycle,
    attentionState: detail.attentionState,
    activeActionIds: Array.isArray(detail.activeActionIds) ? detail.activeActionIds : undefined,
    attentionActionIds: Array.isArray(detail.attentionActionIds) ? detail.attentionActionIds : undefined,
    mainline,
    currentActionId: detail.currentActionId || null,
    executionStats: Array.isArray(detail.runs)
      ? sumExecutionStats(detail.runs)
      : executionStats(detail.executionStats),
    reuseMemory: detail.reuseMemory !== false,
    deliveryTarget: ['workspace_files', 'pull_request', 'merge'].includes(detail.deliveryTarget)
      ? detail.deliveryTarget : null,
    waitingReason: sanitizeDiagnosticText(waitingReason(detail), MAX_ACTION_DIAGNOSTIC_CHARS),
    failureReason: workItemFailureReason(detail),

    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    messages: (Array.isArray(detail.messages) ? detail.messages : []).slice(-100).map(message => ({
      id: String(message.id || ''),
      turnId: String(message.turnId || message.id || ''),
      role: message.role === 'assistant' ? 'assistant' : message.role === 'legacy_instruction' ? 'legacy_instruction' : 'user',
      ...(message.role === 'assistant' && projectVpSpeaker(message.speaker)
        ? { speaker: projectVpSpeaker(message.speaker) } : {}),
      text: truncateUtf8(message.text || '', MAX_ACTION_MESSAGE_CHARS),
      ...(message.role !== 'assistant' && projectedMessageQuote(message.quote)
        ? { quote: projectedMessageQuote(message.quote) } : {}),
      attachments: projectAttachments(message.attachments),
      status: ['thinking', 'completed', 'failed'].includes(message.status) ? message.status : 'completed',
      error: truncateUtf8(message.error || '', MAX_ACTION_DIAGNOSTIC_CHARS) || null,
      decision: message.decision && typeof message.decision === 'object' ? {
        kind: ['answer', 'create_actions', 'guide_actions', 'replan', 'request_human', 'complete']
          .includes(message.decision.kind)
          ? message.decision.kind : null,
        reason: truncateUtf8(message.decision.reason || '', MAX_ACTION_DIAGNOSTIC_CHARS),
        question: truncateUtf8(message.decision.question || '', MAX_ACTION_DIAGNOSTIC_CHARS) || null,
        changedContract: message.decision.changedContract === true,
        affectedActionIds: Array.isArray(message.decision.affectedActionIds)
          ? message.decision.affectedActionIds.map(id => String(id)).slice(0, 8) : [],
      } : null,
      recovery: message.recovery && typeof message.recovery === 'object' ? {
        actionId: truncateUtf8(String(message.recovery.actionId || ''), 256),
        actionGeneration: Math.max(0, count(message.recovery.actionGeneration)),
        stageId: truncateUtf8(String(message.recovery.stageId || ''), 256),
      } : null,
      createdAt: count(message.createdAt),
      updatedAt: count(message.updatedAt || message.createdAt),
    })),
    attachments: projectAttachments(detail.attachments),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    actionCount: Array.isArray(detail.actions) ? detail.actions.length : count(detail.actionCount),
    actionSummary: Array.isArray(detail.actions)
      ? detail.actions.map(action => action.type).filter(Boolean).join(' → ')
      : String(detail.actionSummary || ''),
    actions: Array.isArray(detail.actions)
      ? detail.actions.map(action => ({
          ...projectAction(
            action,
            detail.runs,
            action?.id === liveActionId ? bodyActionEvents : detail.events,
            action?.id === liveActionId,
          ),
          ...(mainlineActionById.get(action.id) || {}),
        }))
      : [],
  };
  return enforceWorkItemBrowserDtoBudget(projected, { keepActionId: liveActionId });
}

/**
 * Browser list projection. This deliberately excludes local filesystem paths
 * and all Run-level execution detail.
 */
export function projectWorkItemSummary(detail) {
  if (!detail) return null;
  if (!Array.isArray(detail.actions)) {
    return enforceWorkItemBrowserDtoBudget({
      id: detail.id,
      revision: detail.revision,
      planRevision: count(detail.planRevision),
      ledgerRevision: count(detail.ledgerRevision),
      coordinatorRevision: count(detail.coordinatorRevision),
      coordinationMode: detail.coordinationMode || 'legacy',
      title: detail.title,
      goal: detail.goal,
      workItemType: detail.workflowSnapshot?.workItemType || detail.workItemType || null,
      planningMode: detail.workflowSnapshot?.planningMode || detail.planningMode || 'static',
      status: detail.status,
      lifecycle: detail.lifecycle,
      attentionState: detail.attentionState,
      activeActionIds: Array.isArray(detail.activeActionIds) ? detail.activeActionIds : undefined,
      attentionActionIds: Array.isArray(detail.attentionActionIds) ? detail.attentionActionIds : undefined,
      currentActionId: detail.currentActionId || null,
      currentAction: projectCurrentActionSummary(detail.currentAction),
      actionStats: Array.isArray(detail.actionStats)
        ? detail.actionStats.map(action => ({ ...action })) : [],
      actionCount: count(detail.actionCount),
      completedActionCount: count(detail.completedActionCount),
      executionStats: executionStats(detail.executionStats),
      origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
      linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
      attachmentCount: Array.isArray(detail.attachments) ? detail.attachments.length : 0,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      boardLane: detail.boardLane || workItemBoardLane(detail),
      actionCounts: detail.actionCounts || boardActionCounts([]),
      attentionAction: detail.attentionAction || null,
      activeAction: detail.activeAction || null,
      executors: Array.isArray(detail.executors) ? detail.executors : [],
    }, { keepActionId: detail.currentActionId || null });
  }
  const action = currentAction(detail);
  const projectedAction = action ? projectAction(action, detail.runs, detail.events, false) : null;
  return enforceWorkItemBrowserDtoBudget({
    id: detail.id,
    revision: detail.revision,
    planRevision: count(detail.planRevision),
    ledgerRevision: count(detail.ledgerRevision),
    coordinatorRevision: count(detail.coordinatorRevision),
    coordinationMode: detail.coordinationMode || 'legacy',
    title: detail.title,
    goal: detail.goal,
    workItemType: detail.workflowSnapshot?.workItemType || detail.workItemType || null,
    planningMode: detail.workflowSnapshot?.planningMode || detail.planningMode || 'static',
    executionMode: detail.workflowSnapshot?.executionMode || detail.executionMode || 'linear',
    status: detail.status,
    lifecycle: detail.lifecycle,
    attentionState: detail.attentionState,
    activeActionIds: Array.isArray(detail.activeActionIds) ? detail.activeActionIds : undefined,
    attentionActionIds: Array.isArray(detail.attentionActionIds) ? detail.attentionActionIds : undefined,
    currentActionId: detail.currentActionId || null,
    actionCount: detail.actions.filter(item => !['superseded', 'cancelled'].includes(item?.status)).length,
    completedActionCount: detail.actions.filter(item => item?.status === 'completed').length,
    executionStats: Array.isArray(detail.runs)
      ? sumExecutionStats(detail.runs)
      : executionStats(detail.executionStats),
    failureReason: workItemFailureReason(detail),

    currentAction: projectCurrentActionSummary(action, projectedAction),
    actionStats: projectActionStats(detail, null),
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    attachmentCount: Array.isArray(detail.attachments) ? detail.attachments.length : 0,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    ...boardFields(detail),
  }, { keepActionId: action?.id || null });
}

export function projectWorkCenterEvent(event) {
  const type = truncateUtf8(event?.type || 'work_item.updated', 256);
  if (type === 'work_item.deleted') {
    return {
      type,
      workItem: {
        id: String(event?.workItem?.id || ''),
        revision: count(event?.workItem?.revision),
      },
    };
  }
  const eventActionId = typeof event?.actionId === 'string'
    && event.workItem?.actions?.some(action => action?.id === event.actionId)
    ? event.actionId
    : null;
  const liveActionId = eventActionId || bodyActionId(event?.workItem);
  return enforceWorkItemBrowserDtoBudget({
    type,
    ...(eventActionId ? { actionId: eventActionId } : {}),
    ...(typeof event?.runId === 'string' && event.runId ? { runId: event.runId } : {}),
    ...(typeof event?.clientMessageId === 'string' && event.clientMessageId
      ? { clientMessageId: truncateUtf8(event.clientMessageId, 256) } : {}),
    workItem: {
      ...projectWorkItemSummary(event?.workItem),
      actionStats: projectActionStats(event?.workItem, liveActionId),
    },
  }, { event: true, keepActionId: liveActionId });
}

function projectDebugUsage(value) {
  return {
    inputTokens: count(value?.inputTokens),
    outputTokens: count(value?.outputTokens),
    cacheReadTokens: count(value?.cacheReadTokens),
    cacheWriteTokens: count(value?.cacheWriteTokens),
    totalInputTokens: count(value?.totalInputTokens),
    totalTokens: count(value?.totalTokens),
  };
}

export function projectActionMessagePage(action, runs, events, options = {}) {
  const messages = actionConversationMessages(action, runs, events);
  const requestedCursor = options.cursor == null ? messages.length : Number(options.cursor);
  const end = Number.isFinite(requestedCursor)
    ? Math.max(0, Math.min(messages.length, Math.floor(requestedCursor)))
    : messages.length;
  const limit = Math.max(1, Math.min(50, Number(options.limit) || MAX_ACTION_MESSAGES));
  const start = Math.max(0, end - limit);
  return {
    actionId: action.id,
    generation: Math.max(1, count(action.generation) || 1),
    messages: messages.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
    total: messages.length,
  };
}

export function actionThreadIncludesRun(action, runs, runId) {
  return conversationRuns(action, runs).some(run => run.id === runId);
}

export function projectActionRequestIndex(action, entries) {
  const source = Array.isArray(entries) ? entries : [];
  const allowedRunIds = new Set(conversationRuns(action, source.map(({ run }) => run)).map(run => run.id));
  return {
    actionId: action.id,
    generation: Math.max(1, count(action.generation) || 1),
    requests: source
      .filter(({ run }) => allowedRunIds.has(run?.id))
      .map(({ run, turn }) => ({
      id: turn.turnId,
      runId: run.id,
      generation: Math.max(1, count(run.actionGeneration) || 1),
      attempt: Math.max(1, count(run.actionAttempt) || 1),
      status: run.status || 'running',
      model: run.modelSnapshot?.id || null,
      vp: run.vpSnapshot ? {
        id: run.vpSnapshot.id || null,
        name: run.vpSnapshot.name || run.vpSnapshot.id || null,
      } : null,
      openedAt: count(turn.openedAt || run.startedAt),
      closedAt: count(turn.closedAt || run.endedAt),
      loopCount: count(turn.loopCount),
      totalMs: count(turn.totalMs),
      inputTokens: count(turn.summaryInputTokens),
      outputTokens: count(turn.summaryOutputTokens),
      totalTokens: count(turn.totalTokens),
    })).sort((left, right) => right.generation - left.generation
      || right.attempt - left.attempt
      || right.openedAt - left.openedAt
      || right.id.localeCompare(left.id)),
  };
}

export function projectActionRequestDetail(action, run, history, runs = [run]) {
  if (!actionThreadIncludesRun(action, runs, run?.id)) return null;
  const turn = Array.isArray(history?.turns) ? history.turns[0] : null;
  if (!turn) return null;
  const sourceLoops = Array.isArray(history?.loops) ? history.loops : [];
  const limited = limitActionRequestDebugInput(sourceLoops, turn.tools);
  const tools = limited.tools;
  const toolsByCall = new Map(tools.map(tool => [
    `${count(tool.loopNumber)}:${tool.callId}`,
    tool,
  ]));
  const requestModel = run.modelSnapshot?.id || limited.loops[0]?.model || null;
  const metadataTruncated = exceedsUtf8Bytes(action.id, MAX_ACTION_REQUEST_METADATA_BYTES)
    || exceedsUtf8Bytes(turn.turnId, MAX_ACTION_REQUEST_METADATA_BYTES)
    || exceedsUtf8Bytes(run.id, MAX_ACTION_REQUEST_METADATA_BYTES)
    || exceedsUtf8Bytes(run.status || 'running', MAX_ACTION_REQUEST_METADATA_BYTES)
    || exceedsUtf8Bytes(requestModel, MAX_ACTION_REQUEST_MODEL_BYTES)
    || exceedsUtf8Bytes(run.vpSnapshot?.id, MAX_ACTION_REQUEST_METADATA_BYTES)
    || exceedsUtf8Bytes(run.vpSnapshot?.name || run.vpSnapshot?.id, MAX_ACTION_REQUEST_METADATA_BYTES);
  const loops = limited.loops.map(loop => {
    const sourceId = loop.loopInstanceId || `${turn.turnId}:${loop.loopNumber}`;
    const sourceModel = loop.model || run.modelSnapshot?.id || '';
    const sourceCalls = Array.isArray(loop.toolCalls) ? loop.toolCalls : [];
    let detailTruncated = loop.detailTruncated === true
      || exceedsUtf8Bytes(sourceId, MAX_ACTION_REQUEST_ID_BYTES)
      || exceedsUtf8Bytes(sourceModel, MAX_ACTION_REQUEST_MODEL_BYTES)
      || exceedsUtf8Bytes(loop.stopReason, MAX_ACTION_REQUEST_STOP_REASON_BYTES)
      || sourceCalls.length > MAX_ACTION_REQUEST_TOOL_CALLS;
    const projectedTools = sourceCalls.slice(0, MAX_ACTION_REQUEST_TOOL_CALLS).map((call, index) => {
      const result = toolsByCall.get(`${count(loop.loopNumber)}:${call.id}`);
      const sourceCallId = call.id || `${sourceId}:tool:${index}`;
      const sourceName = call.name || result?.name || '?';
      if (exceedsUtf8Bytes(sourceCallId, MAX_ACTION_REQUEST_ID_BYTES)
        || exceedsUtf8Bytes(sourceName, MAX_ACTION_REQUEST_NAME_BYTES)) {
        detailTruncated = true;
      }
      return {
        id: boundedDebugIdentity(sourceCallId, MAX_ACTION_REQUEST_ID_BYTES),
        name: truncateUtf8(sourceName, MAX_ACTION_REQUEST_NAME_BYTES) || '?',
        input: sanitizeDebugValue(call.input),
        output: sanitizeDebugValue(result?.toolOutput ?? null),
        durationMs: count(result?.durationMs),
        isError: result?.isError === true,
      };
    });
    return {
      id: boundedDebugIdentity(sourceId, MAX_ACTION_REQUEST_ID_BYTES) || null,
      loopNumber: count(loop.loopNumber),
      model: truncateUtf8(sourceModel, MAX_ACTION_REQUEST_MODEL_BYTES) || null,
      systemPrompt: sanitizeDebugValue(typeof loop.systemPrompt === 'string' ? loop.systemPrompt : ''),
      messages: sanitizeDebugValue(Array.isArray(loop.messages) ? loop.messages : []),
      response: sanitizeDebugValue(typeof loop.response === 'string' ? loop.response : ''),
      usage: projectDebugUsage(loop.usage),
      latencyMs: count(loop.latencyMs),
      ttfbMs: loop.ttfbMs == null ? null : count(loop.ttfbMs),
      stopReason: truncateUtf8(loop.stopReason, MAX_ACTION_REQUEST_STOP_REASON_BYTES) || null,
      at: count(loop.at),
      detailTruncated,
      tools: projectedTools,
      rawRequest: sanitizeDebugValue(loop.rawRequest ?? reconstructDebugRawRequest(
        loop.rawRequestBase ?? loop.requestBase?.rawRequest ?? null,
        loop.requestDelta || null,
      )),
      rawResponse: sanitizeDebugValue(loop.rawResponse ?? null),
    };
  });
  return enforceActionRequestDetailBudget({
    actionId: boundedDebugIdentity(action.id, MAX_ACTION_REQUEST_METADATA_BYTES),
    generation: Math.max(1, count(action.generation) || 1),
    request: {
      id: boundedDebugIdentity(turn.turnId, MAX_ACTION_REQUEST_METADATA_BYTES),
      runId: boundedDebugIdentity(run.id, MAX_ACTION_REQUEST_METADATA_BYTES),
      status: truncateUtf8(run.status || 'running', MAX_ACTION_REQUEST_METADATA_BYTES),
      model: truncateUtf8(requestModel, MAX_ACTION_REQUEST_MODEL_BYTES) || null,
      vp: run.vpSnapshot ? {
        id: boundedDebugIdentity(run.vpSnapshot.id, MAX_ACTION_REQUEST_METADATA_BYTES) || null,
        name: truncateUtf8(run.vpSnapshot.name || run.vpSnapshot.id, MAX_ACTION_REQUEST_METADATA_BYTES) || null,
      } : null,
      openedAt: count(turn.openedAt || run.startedAt),
      closedAt: count(turn.closedAt || run.endedAt),
      loopCount: sourceLoops.length,
      totalMs: count(turn.totalMs),
      totalTokens: count(turn.totalTokens),
      loops,
      truncated: metadataTruncated || limited.omittedLoopCount > 0 || limited.summarizedLoopCount > 0,
      omittedLoopCount: limited.omittedLoopCount,
      summarizedLoopCount: limited.summarizedLoopCount,
    },
  }, limited.omittedLoopCount);
}
