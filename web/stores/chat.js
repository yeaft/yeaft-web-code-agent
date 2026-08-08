import { useAuthStore } from './auth.js';
import {
  currentWorkCenterBrowserOwner,
  isWorkCenterBrowserFenceCurrent,
  readWorkCenterBrowserState,
  subscribeWorkCenterBrowserOwner,
  writeWorkCenterDrafts,
  writeWorkCenterOutbox,
} from './helpers/work-center-browser-state.js';
import { setLocale, getLocale } from '../utils/i18n.js';

// Helper modules
import * as wsHelpers from './helpers/websocket.js';
import * as msgHelpers from './helpers/messages.js';
import * as assistantOutputHelpers from './helpers/assistantOutput.js';
import * as handlerHelpers from './helpers/messageHandler.js';
import * as convHelpers from './helpers/conversation.js';
import * as sessionHelpers from './helpers/session.js';
import * as watchdogHelpers from './helpers/watchdog.js';
import { conversationRepositoryFor } from './helpers/conversation-repository.js';
import * as yeaftViewHelpers from './helpers/yeaft-view.js';
import {
  clearYeaftConversationPromotion,
  migrateYeaftConversationState,
  pendingYeaftConversationPromotion,
  rememberYeaftConversationPromotion,
  retargetYeaftConversationPromotion,
} from './helpers/yeaft-conversation-state.js';
import {
  isRetiredYeaftConversation,
  resolveCurrentYeaftConversation,
  retireYeaftConversation,
  reviveYeaftConversation,
} from './helpers/yeaft-conversation-generation.js';
import { incVpTyping, decVpTyping } from './helpers/vp-typing.js';
import { selectActiveConversationId } from './helpers/active-conv.js';
import { trimDebugRetention } from './helpers/debug-retention.js';
import {
  beginCatalogMutation,
  beginChatHistoryRequest,
  cancelChatHistoryRequest,
  chatCatalogKey,
  finishCatalogMutation,
  yeaftCatalogKey,
} from './helpers/session-catalog.js';
import {
  applyWorkItemSummary,
  isWorkItemDetailResponseStale,
  isWorkItemDetailStale,
  mergeActionMessages,
  normalizeWorkCenterActionGeneration,
  workCenterActionMessageKey,
  workCenterActionRequestScopeKey,
  mergeWorkItemSummary,
  workItemDetailNeedsRefresh,
  workItemDetailRefreshIdentity,
} from './helpers/work-center.js';
import { createPerfTraceId, recordPerfTrace, measureNextPaint } from './helpers/perfTrace.js';
import { normalizeSessionMessageQuote } from '../utils/session-message-quote.js';
import { markTurnResponseKinds } from '../utils/turn-response.js';
import {
  yeaftHistoryIdentityKey,
  yeaftHistoryResultIdentity,
  yeaftOptimisticMessageIdentity,
} from './helpers/yeaft-history-identity.js';
import {
  activeYeaftHistoryIdentity,
  activeYeaftHistoryLoadState,
  beginYeaftHistoryLoad,
  failYeaftHistoryLoad,
  finishYeaftHistoryLoad,
  isCurrentYeaftHistoryResponse,
  syncActiveYeaftHistoryLoad,
  YEAFT_HISTORY_LOAD_TIMEOUT_MS,
} from './helpers/yeaft-history-load.js';
import {
  yeaftAgentSessionIdentityPrefix,
  yeaftSessionIdentityKey,
  yeaftTurnIdentityKey,
} from './helpers/yeaft-session-identity.js';
import {
  getDefaultYeaftVisibleTurns,
  getYeaftWindowLoadStepTurns,
  buildYeaftMessageTurnSpans,
  hasHiddenScopedYeaftMessageTurns,
  sliceScopedYeaftMessagesByRecentTurns,
} from './helpers/yeaft-message-window.js';
import {
  isDurableYeaftHistoryRow,
  pruneConversationMessageRetention,
  touchYeaftHistoryCache,
} from './helpers/yeaft-history-cache.js';
import { planNextYeaftHistoryPage } from './helpers/yeaft-history-pagination.js';

const { defineStore } = Pinia;

// Stable empty array for getters — avoids creating new [] on every call,
// which prevents Vue computed from treating each call as a new value.
const EMPTY_ARRAY = Object.freeze([]);

// UI status mirrors are Agent-scoped. The broker key is Session + VP inside
// one Agent process; the Web aggregates multiple Agent processes, so omitting
// agentId conflates identical Session/VP ids across Agents.
const vpStatusKey = (agentId, sessionId, vpId) => `${agentId || ''}::${sessionId || ''}::${vpId}`;

function yeaftSessionOwnerIds(state, sessionId) {
  const owners = new Set();
  if (!sessionId) return owners;
  for (const row of state?.sessionCatalog || []) {
    if (row?.runtimeProvider !== 'yeaft' || row?.routeRef?.sessionId !== sessionId) continue;
    if (row.routeRef.agentId) owners.add(row.routeRef.agentId);
  }
  if (owners.size === 0) {
    const sessionsStore = getSessionsStore();
    for (const row of sessionsStore?.sessionList || []) {
      if (row?.id === sessionId && row?.agentId) owners.add(row.agentId);
    }
  }
  return owners;
}

function uniqueYeaftSessionOwner(state, sessionId) {
  const owners = yeaftSessionOwnerIds(state, sessionId);
  return owners.size === 1 ? owners.values().next().value : null;
}

function hasUniqueLegacyYeaftSessionOwner(state, sessionId, agentId) {
  return !!agentId && uniqueYeaftSessionOwner(state, sessionId) === agentId;
}

function matchesYeaftRuntimeIdentity(row, sessionId, agentId) {
  if (!row || row.sessionId !== sessionId) return false;
  return agentId ? row.agentId === agentId : !row.agentId;
}

function isYeaftSessionProcessingState(state, sessionId, agentId = null) {
  if (!sessionId) return false;
  const resolvedAgentId = agentId || resolveAgentIdForSession(state, sessionId);
  const processingKey = yeaftSessionIdentityKey(resolvedAgentId, sessionId);
  if (processingKey && state.yeaftProcessingSessions?.[processingKey]) return true;
  if (state.yeaftProcessingSessions?.[sessionId]
      && hasUniqueLegacyYeaftSessionOwner(state, sessionId, resolvedAgentId)) return true;
  for (const info of Object.values(state.activeVpTurns || {})) {
    if (matchesYeaftRuntimeIdentity(info, sessionId, resolvedAgentId)) return true;
  }
  for (const status of Object.values(state.vpStatuses || {})) {
    if (!matchesYeaftRuntimeIdentity(status, sessionId, resolvedAgentId)) continue;
    if (YEAFT_RUNNING_VP_STATES.has(status?.state)) return true;
  }
  return false;
}

function projectYeaftProcessingSnapshot(state, agentId, statuses, scopedSessionId = null) {
  let next = { ...(state.yeaftProcessingSessions || {}) };
  if (agentId) {
    const prefix = yeaftAgentSessionIdentityPrefix(agentId);
    next = Object.fromEntries(Object.entries(next).filter(([key]) => (
      scopedSessionId ? key !== yeaftSessionIdentityKey(agentId, scopedSessionId) : !key.startsWith(prefix)
    )));
    if (scopedSessionId) {
      if (hasUniqueLegacyYeaftSessionOwner(state, scopedSessionId, agentId)) delete next[scopedSessionId];
    } else {
      for (const key of Object.keys(next)) {
        if (hasUniqueLegacyYeaftSessionOwner(state, key, agentId)) delete next[key];
      }
    }
  } else if (scopedSessionId) {
    delete next[scopedSessionId];
  } else {
    next = {};
  }
  for (const row of statuses || []) {
    const sessionId = row?.sessionId || row?.groupId || null;
    if (!sessionId || !YEAFT_RUNNING_VP_STATES.has(row?.state)) continue;
    const key = yeaftSessionIdentityKey(agentId, sessionId) || sessionId;
    next[key] = true;
  }
  return next;
}

function yeaftTurnStateKey(state, agentId, turnId) {
  const scopedKey = yeaftTurnIdentityKey(agentId, turnId);
  if (scopedKey && state?.activeVpTurns?.[scopedKey]) return scopedKey;
  if (state?.activeVpTurns?.[turnId]
      && (!agentId || !state.activeVpTurns[turnId]?.agentId || state.activeVpTurns[turnId].agentId === agentId)) return turnId;
  return scopedKey || turnId || '';
}

function clearYeaftAgentRuntimeState(state, agentId) {
  if (!agentId) {
    state.activeVpTurns = {};
    state.stoppingVpTurnIds = {};
    state.vpStatuses = {};
    state.yeaftProcessingSessions = {};
    return;
  }
  state.activeVpTurns = Object.fromEntries(
    Object.entries(state.activeVpTurns || {}).filter(([, row]) => row?.agentId && row.agentId !== agentId)
  );
  state.stoppingVpTurnIds = Object.fromEntries(
    Object.entries(state.stoppingVpTurnIds || {}).filter(([turnId]) => state.activeVpTurns?.[turnId])
  );
  state.vpStatuses = Object.fromEntries(
    Object.entries(state.vpStatuses || {}).filter(([, row]) => row?.agentId && row.agentId !== agentId)
  );
  const prefix = yeaftAgentSessionIdentityPrefix(agentId);
  state.yeaftProcessingSessions = Object.fromEntries(
    Object.entries(state.yeaftProcessingSessions || {}).filter(([key]) => !key.startsWith(prefix))
  );
}

// Bootstrap pane window when no delta cursor is known yet (cold start, or
// a session the UI has never seen). User-confirmed: 5 turns is the sweet
// spot — small enough to paint instantly, large enough to give context.
const YEAFT_RECENT_TURNS = 5;
const YEAFT_HISTORY_DELTA_ROWS = 100;
const YEAFT_HISTORY_DELTA_BYTES = 512 * 1024;
const YEAFT_SESSION_INVENTORY_TIMEOUT_MS = 15_000;
const YEAFT_HISTORY_OUTLINE_RETRY_DELAYS_MS = Object.freeze([150, 300, 600, 1_000]);
const YEAFT_HISTORY_OUTLINE_RETRYABLE_ERRORS = new Set(['index_building', 'stale_result']);
const YEAFT_RUNNING_VP_STATES = new Set(['typing', 'thinking', 'retrying', 'streaming', 'tool']);
const YEAFT_CATALOG_STATUS_FIELDS = Object.freeze([
  'model',
  'availableModels',
  'refreshedAt',
  'catalogRefreshedAt',
  'catalogEpoch',
  'catalogRevision',
  'catalogDigest',
  'refreshStartedAt',
  'refreshReason',
  'refreshError',
  'refreshing',
]);
const YEAFT_RETIRED_CATALOG_EPOCH_LIMIT = 8;
const YEAFT_ASK_TERMINAL_CACHE_LIMIT = 64;
function workCenterClientMessageKey(agentId, workItemId) {
  return `${agentId || ''}:${workItemId || ''}`;
}

function normalizedWorkCenterMessageTarget(target) {
  if (target?.kind === 'action' && typeof target.actionId === 'string'
      && Number.isInteger(Number(target.generation)) && Number(target.generation) > 0) {
    return { kind: 'action', actionId: target.actionId, generation: Number(target.generation) };
  }
  return { kind: 'coordinator' };
}

function normalizedWorkCenterDraftTarget(target) {
  if (typeof target === 'string') return target;
  if (target?.kind === 'action' && typeof target.actionId === 'string') {
    return {
      kind: 'action',
      actionId: target.actionId,
      generation: Number.isInteger(Number(target.generation)) ? Number(target.generation) : 0,
    };
  }
  return { kind: 'coordinator' };
}

function workCenterEnvelopePayload(value = {}) {
  const quote = normalizeSessionMessageQuote(value.quote);
  return {
    agentId: value.agentId || '',
    workItemId: value.workItemId || '',
    target: normalizedWorkCenterMessageTarget(value.target),
    text: String(value.text || ''),
    ...(quote ? { quote } : {}),
    attachments: Array.isArray(value.attachments) ? value.attachments.map(attachment => ({
      fileId: attachment?.fileId || '',
      name: attachment?.name || '',
      mimeType: attachment?.mimeType || '',
      size: Math.max(0, Number(attachment?.size) || 0),
    })) : [],
    revision: Number(value.revision) || 0,
    planRevision: Number(value.planRevision) || 0,
    ledgerRevision: Number(value.ledgerRevision) || 0,
    coordinatorRevision: Number(value.coordinatorRevision) || 0,
  };
}

function askUserEventIdentity(msg, event, conversationId) {
  return {
    conversationId: conversationId || null,
    agentId: msg?.agentId || event?.agentId || null,
    requestId: event?.requestId || null,
    toolCallId: event?.toolCallId || null,
    sessionId: msg?.sessionId || event?.sessionId || null,
    vpId: msg?.vpId || event?.vpId || null,
    turnId: msg?.turnId || event?.turnId || null,
    threadId: msg?.threadId || event?.threadId || null,
  };
}

function askUserRowIdentity(row, conversationId) {
  return {
    conversationId: conversationId || null,
    agentId: row?.agentId || null,
    requestId: row?.askRequestId || null,
    toolCallId: row?.toolId || null,
    sessionId: row?.sessionId || row?.groupId || null,
    vpId: row?.vpId || row?.speakerVpId || null,
    turnId: row?.turnId || null,
    threadId: row?.threadId || null,
  };
}

const ASK_USER_IDENTITY_FIELDS = Object.freeze([
  'conversationId',
  'agentId',
  'requestId',
  'toolCallId',
  'sessionId',
  'vpId',
  'turnId',
  'threadId',
]);

function exactAskUserIdentity(candidate, expected) {
  return ASK_USER_IDENTITY_FIELDS.every(field => !expected[field] || candidate[field] === expected[field]);
}

function compatibleAskUserIdentity(candidate, expected) {
  return ASK_USER_IDENTITY_FIELDS.every(field => !candidate[field] || !expected[field] || candidate[field] === expected[field]);
}

function findAskUserRow(messages, identity, conversationId) {
  const candidates = (messages || []).filter(row => row?.type === 'tool-use'
    && (row.toolName === 'AskUser' || row.toolName === 'AskUserQuestion')
    && (!identity.requestId || !row.askRequestId || row.askRequestId === identity.requestId)
    && (!identity.toolCallId || !row.toolId || row.toolId === identity.toolCallId));
  const exact = candidates.filter(row => exactAskUserIdentity(askUserRowIdentity(row, conversationId), identity));
  if (exact.length === 1) return exact[0];
  const compatible = candidates.filter(row => compatibleAskUserIdentity(askUserRowIdentity(row, conversationId), identity));
  return compatible.length === 1 ? compatible[0] : null;
}

function askUserTerminalKey(identity) {
  return ASK_USER_IDENTITY_FIELDS.map(field => identity[field] || '').join('\u0000');
}

function rememberAskUserTerminal(state, identity, event) {
  const key = askUserTerminalKey(identity);
  const entries = {
    ...(state._yeaftAskTerminalEvents || {}),
    [key]: { identity, event, receivedAt: Date.now() },
  };
  const keys = Object.keys(entries);
  if (keys.length > YEAFT_ASK_TERMINAL_CACHE_LIMIT) {
    keys.sort((a, b) => entries[a].receivedAt - entries[b].receivedAt);
    for (const staleKey of keys.slice(0, keys.length - YEAFT_ASK_TERMINAL_CACHE_LIMIT)) delete entries[staleKey];
  }
  state._yeaftAskTerminalEvents = entries;
}

function takeAskUserTerminal(state, identity) {
  const entries = state._yeaftAskTerminalEvents || {};
  const exactKey = askUserTerminalKey(identity);
  let key = entries[exactKey] ? exactKey : null;
  if (!key) {
    const compatible = Object.entries(entries)
      .filter(([, entry]) => compatibleAskUserIdentity(entry.identity || {}, identity));
    if (compatible.length === 1) key = compatible[0][0];
  }
  if (!key) return null;
  const terminal = entries[key];
  const { [key]: _removed, ...rest } = entries;
  state._yeaftAskTerminalEvents = rest;
  return terminal?.event || null;
}

function hasPendingToolCall(state, conversationId, sessionId) {
  return (state.messagesMap?.[conversationId] || []).some(row => row?.type === 'tool-use'
    && row.sessionId === sessionId
    && row.hasResult === false);
}

function applyAskUserTerminal(row, event) {
  if (event.type === 'ask_user_answered') {
    row.askAnswered = true;
    row.selectedAnswers = event.answers || {};
    row.askExpired = false;
  } else {
    row.isHistory = true;
    row.askExpired = true;
    row.askAnswered = false;
    row.selectedAnswers = null;
  }
  row.askPending = false;
  row.pendingAnswers = null;
  row.askSubmitGeneration = null;
  row.askRequestId = null;
}

// Yeaft message ids are `NNNNNN-…` where NNNNNN is the zero-padded seq.
// Pull the seq out so the store can stamp / advance its delta cursor on
// every live message that arrives.
function parseYeaftMessageSeq(id) {
  if (!id || typeof id !== 'string') return null;
  const m = id.match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parsePersistedMessageSeq(id) {
  if (!id || typeof id !== 'string') return null;
  const match = id.match(/^m(\d+)$/);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isFinite(seq) ? seq : null;
}

function outlineResultIdentity(row) {
  return yeaftHistoryResultIdentity(row);
}

function taskStopKey(agentId, sessionId, taskId) {
  return `${yeaftSessionIdentityKey(agentId, sessionId)}::${taskId || ''}`;
}

function keepRunningSessionTasks(tasksById) {
  return Object.fromEntries(
    Object.entries(tasksById || {}).filter(([, task]) => task?.status === 'running')
  );
}

function getSessionsStore() {
  try {
    if (typeof window === 'undefined') return null;
    return window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore()) || null;
  } catch {
    return null;
  }
}

function persistCatalogYeaftOrder(rows) {
  const sessionsStore = getSessionsStore();
  if (!sessionsStore?.reorderSessionsGlobally) return;
  const yeaftOrder = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.runtimeProvider === 'yeaft')
    .map(row => `${row.routeRef?.agentId || ''}\u001f${row.routeRef?.sessionId || ''}`)
    .filter(key => !key.startsWith('\u001f'));
  sessionsStore.reorderSessionsGlobally(yeaftOrder);
}

/**
 * Resolve the agent that owns a given Yeaft session. This is the single
 * source of truth for routing session-scoped operations (send / history /
 * abort / config), replacing the old page-level `yeaftAgentId` pointer that
 * could drift out of sync with the selected session and cause cross-agent
 * "Session not found" races.
 *
 * Resolution order:
 *   1. The session row in the sessions store (`sessionById(id).agentId`) —
 *      authoritative, kept fresh by `group_list_updated` snapshots.
 *   2. The per-session agent cache `yeaftSessionAgentById` — covers the brief
 *      window before the sessions store has the row.
 *   3. `currentAgent` — the agent this client is bound to (also what the
 *      server falls back to). Used when no session id is given.
 */
function resolveAgentIdForSession(state, sessionId, explicitAgentId = null) {
  if (explicitAgentId) return explicitAgentId;
  if (sessionId) {
    const gs = getSessionsStore();
    const activeSession = gs?.activeSessionKey ? gs.sessions?.[gs.activeSessionKey] : null;
    if (activeSession?.id === sessionId && activeSession.agentId) return activeSession.agentId;
    const sess = gs && typeof gs.sessionById === 'function' ? gs.sessionById(sessionId, state?.currentAgent || null) : null;
    if (sess && sess.agentId) return sess.agentId;
    const mapped = state?.yeaftSessionAgentById ? state.yeaftSessionAgentById[sessionId] : null;
    if (mapped) return mapped;
  }
  return state?.currentAgent || null;
}

function isAgentVersionAtLeast(version, minimum) {
  const parse = value => String(value || '').replace(/^v/, '').split('.').slice(0, 3).map(part => Number.parseInt(part, 10));
  const current = parse(version);
  const required = parse(minimum);
  if (current.length < 3 || required.length < 3 || [...current, ...required].some(part => !Number.isFinite(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

function agentHasCapability(state, agentId, capability) {
  if (!agentId || !capability) return false;
  const agent = Array.isArray(state?.agents) ? state.agents.find(candidate => candidate?.id === agentId) : null;
  const selectedAgent = state?.currentAgentInfo?.id === agentId ? state.currentAgentInfo : null;
  const capabilities = agent?.capabilities || selectedAgent?.capabilities || [];
  if (capabilities.includes(capability)) return true;
  // Session history search shipped before its explicit capability token. Keep
  // those transitional Agents working while rejecting older builds that would
  // silently drop the request and leave the panel spinning forever.
  return capability === 'session_history_search'
    && isAgentVersionAtLeast(agent?.version || selectedAgent?.version, '1.0.166');
}

function resolveActiveYeaftSessionId(state, { fallbackDefault = false } = {}) {
  if (state?.yeaftActiveSessionFilter) return state.yeaftActiveSessionFilter;
  const gs = getSessionsStore();
  if (gs?.activeSessionId) return gs.activeSessionId;
  if (fallbackDefault) return 'grp_default';
  return null;
}

function resolveActiveDreamDebugSessionId(state) {
  const debugFilter = state.yeaftDebugSessionFilter;
  if (debugFilter === '__all__') return null;
  if (debugFilter) return debugFilter;
  const resolved = resolveActiveYeaftSessionId(state);
  if (resolved) return resolved;
  const gs = getSessionsStore();
  if (gs?.sessions?.grp_default) return 'grp_default';
  return null;
}

function yeaftWatchdogOwner(event, fallback = 'session') {
  return [
    event?.vpId || event?.ownerVpId || 'vp',
    event?.threadId || 'thread',
    event?.turnId || fallback,
  ].join(':');
}

function resolveYeaftEnvelopeConversationId(state, agentId, conversationId = null) {
  if (conversationId) return conversationId;
  return (agentId && state?.yeaftConversationIdsByAgent?.[agentId])
    || state?.yeaftConversationId
    || null;
}

function resolveYeaftConversationIdForSession(state, sessionId = null, preferredAgentId = null) {
  const targetSessionId = sessionId || state?.yeaftActiveSessionFilter || null;
  // Reuse the single owner-resolver so this stays in lock-step with how
  // sends / history / aborts pick the agent. An explicit Agent id from a
  // history result wins so delayed hover/click work cannot retarget itself.
  const agentId = preferredAgentId || resolveAgentIdForSession(state, targetSessionId);
  const agentConversationId = agentId && state?.yeaftConversationIdsByAgent
    ? state.yeaftConversationIdsByAgent[agentId]
    : null;
  return agentConversationId || state?.yeaftConversationId || null;
}

function isVisibleYeaftOutput(state, sessionId, agentId) {
  if (state?.currentView !== 'yeaft') return false;
  const activeSessionId = state?.yeaftActiveSessionFilter || null;
  // A Session-scoped page cannot grant an anonymous metadata frame authority
  // to move its visible pointer. Older/malformed producers may omit sessionId;
  // those frames can refresh caches, but only an identified active Session can
  // promote a local conversation to the real bridge id.
  if (activeSessionId && sessionId !== activeSessionId) return false;
  const activeAgentId = resolveAgentIdForSession(state, activeSessionId);
  return !activeAgentId || !agentId || activeAgentId === agentId;
}

// Debug history is request-bounded on disk. The panel loads only the newest
// request globally by default; search can ask the agent-side index for a small
// result window, and details are fetched one request at a time on expansion.
// A single request can legitimately run 100-200 loops, so the live
// in-memory loop cap must not be smaller than that or the panel will miss loops
// while the request is still streaming. 1000 covers the expected 5-request
// window while staying finite.
const MAX_YEAFT_DEBUG_LOOPS = 1000;
const DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT = 1;
const SEARCH_YEAFT_DEBUG_HISTORY_LIMIT = 5;

// PR feat-dream-debug-panel-full: per-scope ring buffer cap for dream
// events. Bounds the yeaftDreamEvents map so long-running sessions
// (auto-dream every hour) don't grow unbounded. 200 is generous:
// a typical dream pass emits ~6-10 events (start, load-diff per
// group, triage per group, merge, apply per target, done, result),
// so this holds ~20-30 recent passes.
const MAX_YEAFT_DREAM_EVENTS_PER_SCOPE = 200;

export const useChatStore = defineStore('chat', {
  state: () => ({
    ws: null,
    authenticated: false,
    _hasHandledAgentList: false,
    _hasHandledYeaftSessionHydrate: false,
    yeaftSessionInventoryCompleteSupported: null,
    workbenchRouteProtocolSupported: null,
    yeaftSessionHydrateRequestId: null,
    yeaftSessionHydrateSlices: [],
    yeaftSessionHydrateError: null,
    _yeaftSessionInventorySocketQuarantined: false,
    sessionKey: null, // Uint8Array for encryption
    // feat-ws-plaintext-negotiation: defaults `true` (= assume old
    // server, keep encrypting outbound for back-compat). Cleared to
    // `false` in the auth_result handler when the server advertises
    // `acceptPlaintext: true`. Receive path (parseWsMessage) stays
    // unconditional so old encrypted frames still decrypt.
    serverEncryptionRequired: true,
    // 连接状态
    connectionState: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    reconnectTimer: null,
    agents: [],
    currentAgent: null,
    currentAgentInfo: null,
    // 所有活跃的 conversations（跨所有 agents）
    // 每个 conversation 包含 { id, agentId, agentName, workDir, claudeSessionId, createdAt, processing }
    conversations: [],
    // ★ Multi-column: active conversations (max 3), replaces old currentConversation
    activeConversations: [],  // [convId, ...] — first element is primary
    currentWorkDir: null,
    // ★ Multi-column: unified message store, replaces old messages[] + messagesCache{}
    messagesMap: {},  // { [conversationId]: messages[] }
    _messageUiKeySequence: 0,
    // perf-chat-session-switch-cache: per-conversation pagination /
    // cursor state for the chat-mode cache in messagesMap.
    //
    // Replaces the global `hasMoreMessages` singleton (still kept
    // below as a backwards-compatible mirror for MessageList) — the
    // singleton got clobbered on every selectConversation switch and
    // silently dropped the "Load older" affordance in multi-panel use.
    //
    // Shape: { [conversationId]: {
    //   lastSeenDbId: number|null, // max(dbMessageId) cached so
    //                              // selectConversation doesn't have
    //                              // to re-walk messagesMap on every
    //                              // sidebar click. `null` when the
    //                              // conv was hydrated with only
    //                              // streaming partials (cold-load
    //                              // fallback re-anchors next sync).
    //   hasMoreOlder: boolean,     // server-asserted "older rows
    //                              // exist on disk." ONLY stamped
    //                              // from cold-load / older-pagination
    //                              // responses; delta syncs do NOT
    //                              // overwrite it (the server's
    //                              // `hasMore` field doesn't speak to
    //                              // older history on the
    //                              // `afterMessageId` branch — see
    //                              // handleSyncMessagesResult).
    // } }
    //
    // Naming intentionally mirrors yeaftSessionHistoryState (below).
    chatSessionState: {},
    // ★ Split-screen: panel state (unified single/multi-panel)
    panels: [],  // [{ id: 'panel-0', conversationId: convId }, ...] — empty = single-screen mode
    activePanelId: null,  // Currently focused panel ID (for multi-panel click routing)
    _pendingPaneId: null,  // Tracks which panel requested a new session (split mode only)
    // 会话标题缓存：conversationId -> title (最新用户消息，使用对象而非 Map 以确保响应式)
    conversationTitles: {},
    customConversationTitles: {},
    // Per-conversation 处理状态：conversationId -> true (使用对象而非 Set 以确保响应式)
    processingConversations: {},
    // Per-Yeaft-session processing state: `${agentId}\u001f${sessionId}` -> true.
    // A bare sessionId is accepted only as a legacy wire fallback when the
    // catalog proves exactly one Agent owns that id.
    yeaftProcessingSessions: {},
    // Session completion notifications live only for the current Web client.
    // A terminal end_turn received while another Session is open marks the
    // source Session unread until the user opens it. Key by catalog identity so
    // equal sessionIds owned by different Agents never clear each other.
    yeaftUnreadSessionKeys: {},
    theme: localStorage.getItem('theme') || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    themeFollowSystem: !localStorage.getItem('theme'),
    locale: localStorage.getItem('locale') || 'zh-CN',
    // Per-conversation 执行状态追踪：conversationId -> { currentTool, toolHistory, lastActivity }
    executionStatusMap: {},
    // Per-conversation session health: conversationId -> { status: 'agent-offline'|'session-lost'|'cli-exited' }
    sessionHealth: {},
    // 历史会话列表 (用于恢复对话框)
    historySessions: [],
    historySessionsLoading: false,
    // 可用的工作目录列表
    folders: [],
    foldersLoading: false,
    providerModels: [],
    providerModelsLoading: false,
    // Context 用量
    contextUsage: null,
    // 上次使用的 agent 和 session（持久化）
    lastUsedAgent: localStorage.getItem('lastUsedAgent') || null,
    lastUsedSession: JSON.parse(localStorage.getItem('lastUsedSession') || 'null'),
    // 所有打开的会话信息（持久化）
    lastViewedConversation: localStorage.getItem('lastViewedConversation') || null,
    // 会话恢复状态
    pendingRecovery: null,  // 待恢复的会话信息
    recoveryDismissed: false,  // 用户是否已拒绝恢复
    // Loading 状态
    sessionLoading: false,  // 创建/恢复会话时的 loading
    sessionLoadingText: '',  // loading 时显示的文字
    agentSwitching: false,  // 切换 agent 时的 loading
    pendingAgentSelection: null, // { agentId, requestId }; fences stale agent_selected replies
    // 临时保存恢复会话时的标题
    _pendingSessionTitle: null,
    // Workbench 面板是否展开（替代 backgroundPanelExpanded）
    workbenchExpanded: false,
    // Workbench 面板是否最大化（隐藏 conversation）
    workbenchMaximized: false,
    // 桌面侧栏折叠与移动端抽屉开关由 Chat / Yeaft Session 共用。
    sidebarCollapsed: false,
    sessionSidebarOpen: false,
    // Context compact 状态: { conversationId, status: 'compacting'|'completed', message }
    compactStatus: null,
    // Context clear 状态: { conversationId, status: 'clearing'|'completed' }
    clearStatus: null,
    // Refresh session loading 状态
    refreshingSession: false,       // legacy global fallback for non-split mode
    refreshingSessionMap: {},       // per-conversation: { [convId]: boolean }
    // 代理端口映射: agentId → [{port, label, enabled}]
    proxyPorts: {},
    // ★ Phase 6: 消息分页状态
    hasMoreMessages: false,
    loadingMoreMessages: false,
    chatHistoryRequests: {},
    chatHistoryRequestIdSupported: null,
    chatHistoryConnectionGeneration: 0,
    sessionCatalog: [],
    hiddenSessionCatalog: [],
    sessionProjects: [],
    sessionCatalogLoaded: false,
    sessionCatalogMutationRequests: {},
    projectMutationRequests: {},
    activeCatalogKey: null,
    openUnifiedSessionCreate: false,
    openUnifiedChatCreate: false,
    pendingUnifiedSessionSettings: null,
    pluginCenterOpen: false,
    pluginCenterAgentId: null,
    pluginConfigByAgent: {},
    pluginCatalogByKey: {},
    _pluginPending: {},
    // Yeaft 分页状态 (parallel to the Chat-mode flags above):
    //  - yeaftHasMoreHistory: server told us there's at least one earlier
    //    turn for the active group that we haven't loaded yet.
    //  - yeaftLoadingMoreHistory: a `yeaft_load_more_history` request is
    //    in flight; gates the click handler + drives the spinner.
    //  - yeaftOldestLoadedSeq: the seq of the oldest message currently
    //    in messagesMap[yeaftConversationId]. Doubles as the cursor
    //    (`beforeSeq`) for the next page request.
    yeaftHasMoreHistory: false,
    yeaftLoadingMoreHistory: false,
    yeaftOldestLoadedSeq: null,
    yeaftHistoryLoadError: null,
    // Exact request joined or started by the topbar message-refresh action.
    // Automatic bootstrap, browser-cache revalidation, reconnect delta, and
    // older-page loads must not animate or disable that manual control.
    _yeaftManualHistoryRefresh: null,
    // Group-scoped Yeaft history cursors/cache metadata. The legacy three
    // flags above mirror the currently active group for component
    // compatibility; this map is the source of truth across group switches.
    // Shape: { [groupId || '__all__']: { loaded, hasMore, loading, oldestSeq, count } }
    yeaftSessionHistoryState: {},
    // Legacy per-Session reveal budget. The default is now unbounded because
    // VirtualTranscript already limits DOM work; explicit history navigation may
    // still record a larger value here without hiding resident rows on switches.
    yeaftMessageWindowState: {},
    // Resident Session ranges keyed by Agent + Session. These describe only
    // the small Agent-provided windows in this page; they are not persisted.
    yeaftHistoryCacheState: {},
    // De-dupe metadata-only Yeaft bootstrap requests while waiting for the
    // session_ready replay. Group history requests are de-duped separately by
    // yeaftSessionHistoryState[groupId].loading.
    yeaftBootstrapMetaLoadingKey: null,
    yeaftHistoryPerfTraceBySession: {},
    // One idle prefetch timer per Agent-scoped Session. Timers only start an
    // older-page request after the shared recent/delta/older fence is idle.
    _yeaftHistoryPrefetchBySession: {},
    // Session history search is request-scoped. Results are never derived from
    // the bounded render cache, and the request id prevents stale debounce
    // responses from one query/session replacing a newer panel state.
    yeaftHistorySearchState: {
      requestId: null,
      agentId: null,
      sessionId: null,
      query: '',
      senderKey: '',
      loading: false,
      results: [],
      hasMore: false,
      nextBeforeSeq: null,
      nextCursor: null,
      error: null,
    },
    // Lightweight Session outline pages live only for this browser page. They
    // are keyed by agent + session so duplicate session ids cannot bleed across
    // agents, and avoid creating a second persistent copy of conversation text.
    yeaftHistoryOutlineBySession: {},
    _yeaftHistoryOutlineTimeouts: {},
    _yeaftHistorySearchTimeout: null,
    _yeaftHistoryWindowPendingByKey: {},
    // A versioned search/outline locator can become stale after transcript
    // mutation. These request-scoped waiters allow one bounded locator refresh
    // without weakening Agent/Session/generation ownership checks.
    _yeaftHistoryResultRefreshByRequestId: {},
    _yeaftHistoryRevealLeases: {},
    _yeaftHistoryRevealSequence: 0,
    // Search/outline navigation temporarily renders one server-provided,
    // contiguous history window. Detached windows remain cached but never mix
    // with the recent tail as if the missing interval were present.
    yeaftHistoryFocusWindowBySession: {},
    // One-shot marker: set true by the websocket onclose handler on a real
    // disconnect, consumed by handleAgentList to run bounded Yeaft history and
    // visible Work Center catch-up after the socket comes back. Without this
    // gate those requests would re-fire on every routine agent_list broadcast
    // (status flips, turn_completed, latency pings).
    _yeaftReconnectCatchUpPending: false,
    // Agents whose opened Yeaft sessions have been listed during the current
    // Yeaft page visit. Used by agent_list to catch agents that become online
    // after enterYeaft(), without spamming yeaft_list_sessions on every
    // routine status broadcast.
    _yeaftOpenedSessionsLoadedAgents: {},
    // Last-known {online, version} of the Yeaft agent, persisted ACROSS
    // agent_list frames. Needed because the server DELETES an agent from its
    // map on disconnect (server/ws-agent.js handleAgentDisconnect), so a
    // process restart appears as present(v1) → ABSENT → present(v2) — the
    // agent is never broadcast as present-but-offline. Diffing only against
    // the immediately-previous store.agents misses the restart because the
    // intermediate absent frame already erased the agent. This snapshot
    // survives the absent frame so handleAgentList can detect "came back
    // online" / "version changed" across the gap. Keyed by agent id so a
    // cross-agent switch doesn't compare against a stale agent.
    _yeaftAgentSeen: null, // { id, online, version } | null
    // 可用的 slash commands 列表（按 conversationId 隔离，从 Claude SDK init 消息获取）
    slashCommandsMap: {},  // { [conversationId]: string[] }
    // Slash command 描述映射（从 agent 端传递，所有 conversation 共用）
    slashCommandDescriptions: {},  // { commandName: description }
    // 输入框草稿（按 conversationId 保存，切换时不丢失）
    inputDrafts: {},

    // MCP servers 配置: agentId -> [{ name, enabled, source }]
    mcpServers: {},

    // Expert role definitions (from agent): { [roleId]: { name, messagePrefix, messagePrefixEn, actions } }
    expertRoleDefinitions: null,

    // LLM config: agentId -> { providers, primaryModel, fastModel, language, loaded }
    llmConfig: {},
    llmModelDiscovery: {},
    llmGithubDevice: null,

    // models.dev community registry snapshot (shared across agents — same
    // public catalog). Shape: { registry, fetchedAt, error, loaded }.
    // Populated by store.loadModelsDevRegistry() on demand.
    modelsDevRegistry: { registry: {}, fetchedAt: 0, error: null, loaded: false },
    _modelsDevPending: null,

    // task-318: per-agent Yeaft runtime settings cache. Keyed by agentId.
    // Shape: { maxConcurrentThreads, autoArchiveIdleDays, error, loaded, at }
    yeaftSettings: {},

    // Search settings cache (web-search backend + Tavily key state).
    // Single record (not per-agent) — config.json is one file per agent's
    // ~/.yeaft, so the active `currentAgent` determines which agent we
    // talked to last. Shape:
    //   { backend, tavilyKeyConfigured, tavilyKeyMasked, disableHtmlFallback,
    //     loaded, error, at }
    searchSettings: null,

    // Local telemetry settings cache. Trace payloads never travel through
    // this state; only the bounded configuration does.
    telemetrySettings: null,
    // Last live Tavily /usage probe.
    //   { plan, used, limit, paygoUsed, paygoLimit } | { error }
    tavilyUsage: null,
    tavilyUsageLoading: false,

    // Yeaft MCP servers UI state — populated from `yeaft_mcp_list_result`
    // (initial load) and refreshed on every `yeaft_mcp_updated` broadcast
    // (after add/remove/reload on any client). Shape:
    //   yeaftMcpServers: [{ name, command, args, env }, ...]
    //   yeaftMcpRuntime: { connected, toolCount, perServer: [{ name, ready, toolCount }] }
    _perfTraceQueue: [],
    _perfTraceFlushTimer: null,
    yeaftPerfTraceByMessageId: {},
    yeaftPerfTraceByTurnId: {},
    yeaftMcpServers: [],
    yeaftMcpRuntime: { connected: false, toolCount: 0, perServer: [] },
    yeaftMcpLoading: false,
    yeaftMcpError: null,

    // /btw mode state (multi-turn side question)
    btwMode: false,              // whether in btw mode
    btwMessages: [],             // [{ role: 'user'|'assistant', content }]
    btwLoading: false,           // waiting for assistant reply
    btwSessionId: null,          // forked session ID for multi-turn

    // Per-conversation MCP servers: conversationId -> [{ name, enabled, source }]
    conversationMcpServers: {},
    // Per-conversation MCP server tools: conversationId -> { serverName: [toolName, ...] }
    conversationMcpServerTools: {},
    // MCP 面板是否展开
    mcpPanelOpen: false,

    // =====================
    // Expert Panel (帮帮团) 状态
    // =====================
    expertSelections: [],             // 当前已选的角色/Action: [{ role: string, action: string|null }]
    customExpertRoles: [],            // 自定义帮帮团角色 (from server DB)

    // =====================
    // Sub-Agent 状态 (JSONL watcher)
    // =====================
    subagents: {},                    // { [conversationId]: { [subagentId]: SubagentInfo } }
    activeSubagentId: null,           // 当前展开的 subagent ID (null = 列表模式)
    activeRightPanel: null,           // null | 'subagents' | 'experts' — 右侧面板互斥切换

    // =====================
    // Session Pin 置顶
    // =====================
    pinnedSessions: JSON.parse(localStorage.getItem('pinned-sessions') || '[]'),

    // =====================
    // Yeaft 独立页面状态
    // =====================
    // Refresh restores the last user-selected conversation surface. Runtime
    // transition state stays separate so a cold Yeaft restore can still return
    // to the last Chat conversation after bootstrap replaces the active id.
    ...yeaftViewHelpers.createInitialConversationViewState(),
    workCenterOpen: false,
    workCenterAgentId: null,
    workCenterItemsByAgent: {},
    workCenterListPageByAgent: {},
    workCenterListMoreLoadingByAgent: {},
    _workCenterListGenerationByAgent: {},
    _workCenterListQueryByAgent: {},
    _workCenterListFiltersByAgent: {},
    _workCenterListMoreRequestsByAgent: {},
    _workCenterListEventGenerationByAgent: {},
    _workCenterListEventsByAgent: {},
    _workCenterDeletedIdsByAgent: {},
    workCenterDetailByAgent: {},
    workCenterActionMessages: {},
    workCenterActionMessagesLoading: {},
    workCenterActionMessagesError: {},
    workCenterActionRequests: {},
    workCenterActionRequestDetails: {},
    workCenterActionRequestsLoading: {},
    workCenterActionRequestsError: {},
    workCenterActionRequestDetailsLoading: {},
    workCenterActionRequestDetailsError: {},
    workCenterLoadedByAgent: {},
    workCenterLoadingByAgent: {},
    workCenterErrorByAgent: {},
    workCenterWatcherByAgent: {},
    workCenterSettingsByAgent: {},
    workCenterRuntimeByAgent: {},
    workCenterSettingsLoadingByAgent: {},
    workCenterSettingsErrorByAgent: {},
    _workCenterSettingsGenerationByAgent: {},
    _workCenterDetailRequestGenerationByAgent: {},
    _workCenterDetailEventRefreshByAgent: {},
    _workCenterActionInputGenerationByAgent: {},
    _workCenterActionMessageRequests: {},
    _workCenterActionMessageGenerationByKey: {},
    _workCenterActionRequestsGeneration: {},
    _workCenterActionRequestDetailsGeneration: {},

    workCenterPending: {},
    workCenterComposerDrafts: {},
    workCenterMessageOutbox: {},
    _workCenterBrowserFence: null,
    _workCenterBrowserUnsubscribe: null,
    workCenterCreateDraft: null,
    yeaftConversationId: null,     // 当前 Yeaft agent 的虚拟 conversationId（从 agent session_ready 获取）
    yeaftConversationIdsByAgent: {}, // { [agentId]: conversationId } 跨机器 agent 的 Yeaft message cache 隔离
    _yeaftPendingConversationPromotions: {}, // { [agentId]: { sourceConversationId, targetConversationId } }
    _yeaftRetiredConversationIdsByAgent: {}, // { [agentId]: string[] }, bounded bridge-generation fence
    _yeaftRetiredConversationTargetsByAgent: {}, // { [agentId]: { [retiredId]: currentId } }
    yeaftSessionAgentById: {},      // Legacy bare-session owner cache; activeSessionKey wins when ids collide.
    yeaftModel: null,              // agent/default Yeaft 模型名；Session override lives in sessions[].config.model
    yeaftModelEffort: null,        // agent/default effort；Session override lives in sessions[].config.modelEffort
    yeaftSessionReady: false,     // Session 是否已初始化
    yeaftStatus: null,            // { skills, mcpServers, tools } 从 session_ready 获取
    yeaftAvailableModels: [],     // 可用模型列表 [{ id, provider, label }]
    yeaftStatusByAgent: {},       // { [agentId]: cached yeaft_status/session_ready payload }
    _yeaftRetiredCatalogEpochsByAgent: {}, // { [agentId]: string[] }, bounded restart fence
    yeaftModelsRefreshing: false, // 当前 agent 的 model/status 后台刷新状态
    yeaftModelRefreshError: null, // 当前 agent 最近一次 refresh 错误（保留旧模型列表）
    yeaftYeaftDir: null,          // agent 的 ~/.yeaft 绝对路径（session_ready 携带）— Yeaft workbench 的默认 workDir
    yeaftActiveTasksBySession: {}, // { [`${agentId}\u001f${sessionId}`]: { [taskId]: task snapshot } }
    yeaftStoppingTasksById: {}, // { [`${agentId}\u001f${sessionId}::${taskId}`]: true }
    // 2026-05-13: tool-call usage stats for the Yeaft debug drawer.
    // Populated by `fetchYeaftToolStats()` → backend → `yeaft_tool_stats`
    // case in handleYeaftOutput. Shape:
    //   { snapshot: {[name]: {callCount, errorCount, errorRate, avgMs,
    //                          p50Ms, p95Ms, lastCalledAt, lastError}},
    //     registered: string[],   // all built-in tool names
    //     unused: string[],       // registered & callCount==0
    //     error: string|null,
    //     fetchedAt: number }
    yeaftToolStats: null,
    yeaftToolStatsLoading: false,
    // feat-6af5f9f1 PR B: debug panel data refactor.
    //
    //   Turn = one user prompt + all AI responses (top level)
    //   Loop = one LLM call inside a Turn
    //   Tool = one tool execution inside a Loop
    //
    // `yeaftDebugLoops` is a flat list (per-LLM-call). `yeaftDebugTurnsById`
    // is a {turnId -> turn record} map carrying turn-level data (user
    // prompt, vp, group, memory_used, memory_adjust, totals).
    // `yeaftDebugTurnOrder` preserves insertion order so the panel can
    // render newest-first.
    yeaftDebugLoops: [],
    yeaftDebugTurnsById: {},
    yeaftDebugTurnOrder: [],
    // Hydration status for the persistent file-backed trace round-trip.
    // `loadYeaftDebugHistory()` flips `yeaftDebugHistoryLoading` while
    // the request is in flight; the
    // `yeaft_debug_history` case in messageHandler resets it and stamps
    // `yeaftDebugHistoryFetchedAt`. `yeaftDebugHistoryError` is non-null
    // when the 10-second guard timer fires before the agent replies
    // (agent down / relay loss).
    yeaftDebugHistoryLoading: false,
    yeaftDebugHistoryError: null,
    yeaftDebugHistoryFetchedAt: 0,
    yeaftDebugHistoryProjection: null,
    yeaftDebugHistoryLimit: DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT,
    yeaftDebugHistoryHasMore: false,
    // Turn-level debug panel (per-turn action entry). The panel no longer boots
    // into a history browser: clicking the debug action on an AI turn opens this
    // panel and issues a precise `yeaft_fetch_debug_history` detail request
    // for exactly that turn. `requestId` guards stale responses; the panel
    // only renders `yeaftDebugTurnsById[yeaftDebugPanel.turnId]`.
    yeaftDebugPanel: {
      open: false,
      status: 'idle', // idle | loading | ready | unavailable | error
      requestId: null,
      agentId: null,
      sessionId: null,
      turnId: null,
      error: null,
    },
    // Debug-panel toolbar state.
    // `yeaftDebugSearch` is sent to the agent as a regex over bounded request
    // summaries so the request log can find traces outside the 5-row window.
    // `yeaftDebugSessionFilter` is an optional debug-side pin; default null
    // means the request log is global across Sessions.
    yeaftDebugSearch: '',
    yeaftDebugSessionFilter: null,
    // v0.1.755: latest dream pass status per scope, keyed by scope string
    // (e.g. 'group/abc', 'vp/alice'). Auto-triggered and manual passes both
    // feed the same map via `dream_progress` events. Schema per entry:
    //   { scope, status: 'running'|'success'|'error', startedAt, finishedAt?,
    //     stage?, mergedCount?, error?, manual?, durationMs? }
    // YeaftDebugPanel reads `yeaftDreamLatestForActiveSession` (getter) to
    // render a single row showing the most recent pass for the active
    // group's scope.
    yeaftDreamLatest: {},
    // Loadable dream output snapshots keyed by scope. Unlike
    // `yeaftDreamLatest` (run status) this holds the current contents of
    // the dream-produced memory files so switching sessions can restore
    // what the session has learned.
    yeaftDreamSnapshots: {},
    // Last per-turn Dream resident summaries that were actually injected into
    // the system prompt Memory section, keyed by scope (e.g. sessions/<id>).
    yeaftDreamPromptLoads: {},
    // PR feat-dream-debug-panel-full: per-scope ring buffer of dream
    // events. Each entry is the raw event payload augmented with `at`
    // (receive timestamp). Buffer is capped at YEAFT_DREAM_EVENT_LIMIT
    // per scope so the array stays bounded across long sessions. Both
    // auto-triggered and manually-triggered passes append here. The
    // debug panel renders this under the Dream row when expanded.
    // Shape: { [scope: string]: Array<{phase, status?, target?, groupId?,
    //   error?, segments?, actions?, manual?, ts, at, ...}> }
    yeaftDreamEvents: {},
    // PR-L: V7 tool-history reflection cards. Keyed by `${conversationId}:${trigger}:${loopRange[0]}-${loopRange[1]}`.
    // Each entry: { trigger, status, loopRange, toolCount, content, durationMs, error,
    // anchorMsgId, anchorOrder }. Rendered inline by MessageList — anchored
    // after the message present at first emit (`pending`).
    yeaftReflectionCards: {},
    // PR-M3: sub-agent cards. Keyed by `${conversationId}:${agentId}`.
    // Each entry: { agentId, agentName, status, text, toolCallCount, turns,
    // error, anchorMsgId, anchorOrder, expanded, updatedAt }.
    // Populated by `sub_agent_event` handler — fed by Engine
    // sub-agent event sink → web-bridge.js → yeaft_output.
    yeaftSubAgentCards: {},
    // ★ task-341: Sidebar V2 is now the only sidebar. Flag kept as a
    // constant `true` for backward-compat with any lingering reads.
    // Legacy <aside class="yeaft-sidebar"> deleted in YeaftPage.
    yeaftSidebarV2Enabled: true,

    // ★ task-fix (group-switch): active group filter for the Yeaft stream.
    // When a user clicks a group row in the sidebar, the main pane narrows
    // to messages tagged with that groupId (both inbound agent messages
    // and outbound user messages sent via the group-chat action). null =
    // no group filter. Mutually exclusive with yeaftActiveThreadFilter —
    // setting one clears the other so the view has a single predicate.
    yeaftActiveSessionFilter: null,

    // (PR #693 review I4 + Fowler M2: removed `pendingGroupSettingsRequest`
    // store-as-event-bus field — replaced by a normal emit chain since
    // MessageList is mounted directly inside YeaftPage.)

    // Bug 1: in-flight SEND-context group, set transiently by
    // handleYeaftOutput before dispatching streaming chunks. Read by
    // addMessageToConversation so arriving messages get stamped with the
    // ORIGINATING group (carried in the yeaft_output envelope) rather than
    // the user's CURRENT filter (which can change while a reply streams).
    _currentYeaftSessionId: null,

    // Per-VP turn routing: set transiently by handleYeaftOutput so that
    // addMessageToConversation / appendToAssistant can route by turnId.
    _currentYeaftVpId: null,
    _currentYeaftTurnId: null,
    _currentYeaftThreadId: null,
    // Terminal AskUser events can beat their tool-use row during reconnect.
    // Keep a small bounded cache and apply the event when the row replays.
    _yeaftAskTerminalEvents: {},
    // Feature system fully removed 2026-05-13; per-VP turns are folded
    // by VpTurnBlock keyed off vpId + message id.

    // Active VP turns — keyed by turnId. Cleared on result or abort ack.
    activeVpTurns: {},

    // vp-status (2026-05-15): authoritative per-VP status table, mirrored
    // from the agent broker. Shape: { [vpId]: { state, since, turnId,
    // groupId } }. Populated by `vp_status_snapshot` (bulk) and updated
    // by `vp_status_changed` (per transition). The vp-timeline helper
    // reads this as the single source of truth — the previous design
    // reverse-inferred from message-level `isStreaming` flags and would
    // drift any time a flag-clearing event was missed.
    //
    // Keyed by vpId only (not (groupId, vpId)) because the timeline
    // pane is already group-scoped: it renders rows for the active
    // group's roster, so multiple groups' status tables never share
    // a row. The composite key lives on the wire (see broker.snapshot)
    // and the `groupId` field is preserved in each entry, so if a
    // future feature wants to display VP status across groups the
    // data is there.
    vpStatuses: {},

    // Per-turn stop requests awaiting the agent ack / terminal event. Used to
    // keep VP-list stop buttons from firing duplicate aborts while the agent
    // tears down a running or queued VP turn.
    stoppingVpTurnIds: {},

    // VP runtime turns: the conversation is a single message stream, and
    // Yeaft message blocks are keyed by VP + message id.

    // task-fix: per-VP typing indicator for Yeaft group chat.
    //   Shape: { [conversationId]: { [vpId]: refCount } }
    //   Nesting by conversationId is what isolates Yeaft typing state from
    //   the Chat view — so a VP that's still streaming when the user
    //   switches to a Chat tab does NOT bleed its avatar / typing dots
    //   into the Chat view (cross-mode state leak).
    // Populated by `vp_typing_start` / `vp_typing_end` events emitted from
    // the agent's handleYeaftGroupChat fan-out loop. Consumed by
    // VpSpeakerHeader to render a three-dot animation next to the VP's
    // avatar — replaces the old global "running cat" which was ambiguous
    // when N VPs were speaking concurrently.
    // The refCount (not a boolean) is so overlapping sends to the same VP
    // degrade gracefully — the dot stays on until the last concurrent
    // dispatch ends.
    yeaftVpTyping: {},

    // ★ task-334-ui-g: VP CRUD pending-request map.
    // Each `vpCrudRequest()` stashes its resolver here keyed by requestId;
    // the `vp_crud_result` event looks it up and resolves the caller. Using
    // a Map (not a plain object) because request IDs are ephemeral and we
    // want O(1) delete on resolve. Guarded with lazy-init in the action so
    // hydration from SSR / rehydration doesn't trip on a non-Map value.
    _vpCrudPending: null,


    // VP-block redesign (2026-05-08): the per-turn detail drawer
    // (`yeaftOpenVpTurnDetail`) was retired alongside VpQuickCard /
    // VpTurnDetailDrawer. Per-turn inspection now happens through the
    // VpTurnBlock collapse layer in the message list.
  }),

  getters: {
    // ★ Multi-column: compatibility shim — reads activeConversations[0]
    currentConversation: (state) => state.activeConversations[0] || null,
    // The single source-of-truth selector for "which conversation is the
    // active view sourcing from?". Lives in
    // `helpers/active-conv.js` so the rule can be unit-tested against a
    // plain state shape, and so the three getters below share the
    // canonical implementation instead of each open-coding the ternary.
    activeConversationId: (state) => selectActiveConversationId(state),
    activeSessionRoute(state) {
      if (state.currentView === 'yeaft') {
        const sessionId = resolveActiveYeaftSessionId(state);
        if (!sessionId) return null;
        return {
          runtimeProvider: 'yeaft',
          agentId: resolveAgentIdForSession(state, sessionId),
          sessionId,
        };
      }
      const conversationId = selectActiveConversationId(state);
      if (!conversationId) return null;
      const conversation = state.conversations.find(row => row?.id === conversationId && row.type !== 'yeaft');
      if (!conversation) return null;
      return {
        runtimeProvider: conversation.provider === 'copilot' ? 'copilot' : 'claude-code',
        agentId: conversation.agentId || state.currentAgent || null,
        sessionId: conversationId,
      };
    },
    // ★ Multi-column: compatibility shim — reads messagesMap for primary conversation
    messages(state) {
      const convId = this.activeConversationId;
      const raw = convId ? (state.messagesMap[convId] || EMPTY_ARRAY) : EMPTY_ARRAY;
      // task-fix (session-switch): session filter narrows the stream to one session.
      // Every Yeaft message is stamped with a sessionId at creation time
      // (addMessageToConversation defaults to grp_default), so strict
      // equality is safe — no message can slip through "untagged".
      // Falls back to legacy `groupId` so in-flight messages from older
      // builds still match during a deploy window.
      if (state.currentView === 'yeaft') {
        const sessionId = state.yeaftActiveSessionFilter || null;
        const sessionKey = yeaftHistoryIdentityKey(resolveAgentIdForSession(state, sessionId), sessionId);
        const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
          || getDefaultYeaftVisibleTurns();
        const focusWindowKey = state.yeaftHistoryFocusWindowBySession?.[sessionKey]?.windowKey || null;
        return sliceScopedYeaftMessagesByRecentTurns(
          raw,
          state.yeaftActiveSessionFilter || null,
          visibleTurns,
          focusWindowKey,
        );
      }
      return raw;
    },
    // ★ Yeaft: the raw message list for the active Yeaft conversation (no thread filter applied).
    yeaftAllMessages: (state) => {
      const convId = resolveYeaftConversationIdForSession(state);
      return convId ? (state.messagesMap[convId] || EMPTY_ARRAY) : EMPTY_ARRAY;
    },
    yeaftVisibleMessages(state) {
      const convId = resolveYeaftConversationIdForSession(state);
      const raw = convId ? (state.messagesMap[convId] || EMPTY_ARRAY) : EMPTY_ARRAY;
      const sessionId = state.yeaftActiveSessionFilter || null;
      const sessionKey = yeaftHistoryIdentityKey(resolveAgentIdForSession(state, sessionId), sessionId);
      const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
        || getDefaultYeaftVisibleTurns();
      const focusWindowKey = state.yeaftHistoryFocusWindowBySession?.[sessionKey]?.windowKey || null;
      return sliceScopedYeaftMessagesByRecentTurns(
        raw,
        state.yeaftActiveSessionFilter || null,
        visibleTurns,
        focusWindowKey,
      );
    },
    hasHiddenYeaftMessages(state) {
      if (state.currentView !== 'yeaft') return false;
      const convId = resolveYeaftConversationIdForSession(state);
      const raw = convId ? (state.messagesMap[convId] || EMPTY_ARRAY) : EMPTY_ARRAY;
      const sessionId = state.yeaftActiveSessionFilter || null;
      const sessionKey = yeaftHistoryIdentityKey(resolveAgentIdForSession(state, sessionId), sessionId);
      const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
        || getDefaultYeaftVisibleTurns();
      return hasHiddenScopedYeaftMessageTurns(raw, state.yeaftActiveSessionFilter || null, visibleTurns);
    },
    activeYeaftHistoryState(state) {
      return activeYeaftHistoryLoadState(state);
    },
    yeaftManualHistoryRefreshLoading(state) {
      const manual = state._yeaftManualHistoryRefresh || null;
      if (!manual?.requestId) return false;
      const sessionKey = yeaftHistoryIdentityKey(manual.agentId, manual.sessionId);
      const activeIdentity = activeYeaftHistoryIdentity(state);
      const load = state.yeaftSessionHistoryState?.[sessionKey] || null;
      return activeIdentity.sessionKey === sessionKey
        && load?.loading === true
        && load.requestId === manual.requestId;
    },
    yeaftInitialHistoryLoading(state) {
      const load = activeYeaftHistoryLoadState(state);
      return state.currentView === 'yeaft'
        && !!state.yeaftActiveSessionFilter
        && !!load?.loading
        && !load?.loaded
        && this.yeaftVisibleMessages.length === 0;
    },
    // task-fix: per-VP typing-indicator getters scoped to the CURRENT
    // conversation. Components read these instead of the underlying
    // `yeaftVpTyping` shape so the nested data layout stays an internal
    // detail of the store. The cross-mode isolation invariant is then
    // a property of the getter contract, not something each consumer has
    // to remember to enforce.
    //
    // Routes through `activeConversationId` so chat-mode handlers that
    // clobber `activeConversations` while the user is in Yeaft cannot
    // make typing badges silently disappear.
    vpsTypingInCurrentConv(state) {
      const convId = this.activeConversationId;
      if (!convId) return EMPTY_ARRAY;
      const inner = (state.yeaftVpTyping || {})[convId];
      if (!inner) return EMPTY_ARRAY;
      const ids = Object.keys(inner).filter((vpId) => (inner[vpId] || 0) > 0);
      return ids.length === 0 ? EMPTY_ARRAY : ids;
    },
    // Factory getter: "is `vpId` typing in the current conversation?"
    // Pinia getters that return a function of the props are how we
    // expose argument-taking lookups while still keeping the underlying
    // shape private to the store. VpSpeakerHeader uses this so it never
    // touches the nested map directly.
    isVpTypingInCurrentConv(state) {
      return (vpId) => {
        if (!vpId) return false;
        const convId = this.activeConversationId;
        if (!convId) return false;
        const inner = (state.yeaftVpTyping || {})[convId];
        if (!inner) return false;
        return (inner[vpId] || 0) > 0;
      };
    },
    // v0.1.755: latest dream pass for the currently-focused session (or null).
    // Reads from `yeaftDreamLatest` keyed by scope. The active session's
    // scope is `sessions/<id>` — we resolve that from `yeaftActiveSessionFilter`
    // (or fall back to the debug-side filter). Returns null when nothing
    // has been recorded yet for this scope.
    yeaftDreamLatestForActiveSession(state) {
      const targetSessionId = resolveActiveDreamDebugSessionId(state);
      if (!targetSessionId) return null;
      const scope = `sessions/${targetSessionId}`;
      return state.yeaftDreamLatest?.[scope] || null;
    },
    yeaftDreamSnapshotForActiveSession(state) {
      const targetSessionId = resolveActiveDreamDebugSessionId(state);
      if (!targetSessionId) return null;
            const scope = `sessions/${targetSessionId}`;
      return state.yeaftDreamSnapshots?.[scope] || null;
    },
    yeaftDreamPromptLoadForActiveSession(state) {
      const targetSessionId = resolveActiveDreamDebugSessionId(state);
      if (!targetSessionId) return null;
      // Prompt-load records describe what the LLM sees in system prompt
      // memory, so they use product terminology (`sessions/<id>`), even
      // when the underlying disk store still has historical group paths.
      const scope = `sessions/${targetSessionId}`;
      return state.yeaftDreamPromptLoads?.[scope] || null;
    },
    // PR feat-dream-debug-panel-full: per-group event log for the
    // expanded debug-panel view. Same filter precedence as
    // `yeaftDreamLatestForActiveSession`. Returns the full ring-buffer
    // array for the active group's scope (oldest first), or an empty
    // array. Includes `'*'`-scoped events broadcast to all groups
    // (start/done) merged in chronological order so the user sees a
    // single coherent timeline regardless of whether a given event
    // landed in the scoped bucket or the broadcast bucket.
    yeaftDreamEventsForActiveSession(state) {
      const targetSessionId = resolveActiveDreamDebugSessionId(state);
      if (!targetSessionId) return [];
      const scope = `sessions/${targetSessionId}`;
      const scoped = Array.isArray(state.yeaftDreamEvents?.[scope])
        ? state.yeaftDreamEvents[scope] : [];
      const broadcast = Array.isArray(state.yeaftDreamEvents?.['*'])
        ? state.yeaftDreamEvents['*'] : [];
      if (broadcast.length === 0) return scoped;
      if (scoped.length === 0) return broadcast;
      // Merge by `at` timestamp (already monotonic per source since both
      // are append-only ring buffers). A simple concat+sort is fine at
      // this scale (≤400 entries).
      return [...scoped, ...broadcast].sort((a, b) => (a.at || 0) - (b.at || 0));
    },
    // feat-6af5f9f1 PR B: Turn-grouped debug records for the redesigned
    // panel. Returns `[{ turnId, userPrompt, vpId, groupId, openedAt,
    //                    loops: Loop[], reflections: Card[], memoryLoaded,
    //                    memoryAdjust, totalMs, totalTokens, loopCount }, ...]`
    // sorted newest-first.
    //
    // Request log filtering is independent from the main Session pane. By
    // default it shows the loaded global trace window; an explicit debug filter
    // may still pin a Session for legacy callers, but active Session selection
    // no longer narrows the request log.
    yeaftDebugTurnsForActiveSession: (state) => {
      const order = state.yeaftDebugTurnOrder || EMPTY_ARRAY;
      const byId = state.yeaftDebugTurnsById || {};
      const allLoops = state.yeaftDebugLoops || EMPTY_ARRAY;
      const reflections = state.yeaftReflectionCards || {};

      const debugFilter = state.yeaftDebugSessionFilter;
      let target;
      if (debugFilter === '__all__') {
        target = null;
      } else if (debugFilter) {
        target = debugFilter;
      } else {
        target = null;
      }

      // Group loops by turnId once.
      const loopsByTurn = {};
      for (const loop of allLoops) {
        if (!loop || !loop.turnId) continue;
        if (!loopsByTurn[loop.turnId]) loopsByTurn[loop.turnId] = [];
        loopsByTurn[loop.turnId].push(loop);
      }
      // Group reflections by turnId.
      const reflectionsByTurn = {};
      for (const key of Object.keys(reflections)) {
        const card = reflections[key];
        if (!card || !card.turnId) continue;
        if (!reflectionsByTurn[card.turnId]) reflectionsByTurn[card.turnId] = [];
        reflectionsByTurn[card.turnId].push(card);
      }

      const out = [];
      for (let i = order.length - 1; i >= 0; i--) {
        const turnId = order[i];
        const turn = byId[turnId];
        if (!turn) continue;
        if (target && turn.sessionId && turn.sessionId !== target) continue;

        const loops = loopsByTurn[turnId] || EMPTY_ARRAY;
        const refls = reflectionsByTurn[turnId] || EMPTY_ARRAY;

        // fix-debug-panel-live-aggregates: the turn header (NL · Xms · Y tok)
        // is sourced from `turn.loopCount` / `totalMs` / `totalTokens`, which
        // are only stamped by the `turn_close` event (chat.js:1130). While a
        // turn is still in flight those fields are 0, so the header shows
        // "0L 0ms 0 tok". Worse, the template falls back to
        // `turn.loops.length` for the L count, but the global loop ring is
        // capped at MAX_YEAFT_DEBUG_LOOPS for live detail payloads,
        // so a long in-flight turn can otherwise pin the header at that cap.
        // For old turns hydrated from SQLite
        // whose `turn_close` was never persisted, the row stays "0L" forever.
        //
        // Fix: derive live aggregates from the per-turn loops we just
        // grouped and prefer them whenever the turn isn't closed. For
        // closed turns we trust the stamped totals (they include the
        // final partial loop), but still backfill loopCount when it's 0
        // — that's the SQLite-hydration case where the engine recorded
        // every loop row but never wrote a turn-level summary.
        const liveLoopCount = loops.length;
        let liveTokens = 0;
        let liveMs = 0;
        for (const lp of loops) {
          const u = lp && lp.usage;
          if (u && Number.isFinite(u.totalTokens)) liveTokens += u.totalTokens;
          else if (u) liveTokens += (u.totalInputTokens || ((u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0))) + (u.outputTokens || 0);
          if (lp && Number.isFinite(lp.latencyMs)) liveMs += lp.latencyMs;
        }
        const isOpen = !turn.closedAt;
        const merged = {
          ...turn,
          loopCount: (isOpen || !turn.loopCount) ? liveLoopCount : turn.loopCount,
          totalTokens: (isOpen || !turn.totalTokens) ? liveTokens : turn.totalTokens,
          totalMs: (isOpen || !turn.totalMs) ? liveMs : turn.totalMs,
          loops,
          reflections: refls,
        };
        out.push(merged);
      }
      return out;
    },
    // PR C: distinct sessionIds present in the current debug history,
    // for the toolbar session-filter dropdown.
    yeaftDebugAvailableSessions: (state) => {
      const seen = new Set();
      for (const turnId of state.yeaftDebugTurnOrder || EMPTY_ARRAY) {
        const turn = state.yeaftDebugTurnsById[turnId];
        if (turn && turn.sessionId) seen.add(turn.sessionId);
      }
      return Array.from(seen).sort();
    },
    // PR C: total turns ignoring filters — used to render "showing M of N"
    // in the toolbar so the user knows when they have unsearched data.
    yeaftDebugTurnTotal: (state) => {
      return (state.yeaftDebugTurnOrder || EMPTY_ARRAY).length;
    },
    // ★ Multi-column: compatibility shim — alias for messagesMap
    messagesCache: (state) => state.messagesMap,
    // ★ Multi-column: whether multiple columns are active
    isMultiColumn: (state) => state.activeConversations.length > 1,
    // ★ Split-screen: whether in split-screen mode (2+ panels)
    isSplitMode: (state) => state.panels.length > 1,
    // 当前页面/session 是否在处理中。
    // Chat uses the active conversation id; Yeaft must be scoped to the
    // selected Session because one virtual Yeaft conversation contains many
    // Sessions and VP turns can overlap across them.
    isProcessing: (state) => {
      if (state.currentView === 'yeaft') {
        const sessionId = resolveActiveYeaftSessionId(state);
        if (!sessionId) return false;
        return isYeaftSessionProcessingState(state, sessionId, resolveAgentIdForSession(state, sessionId));
      }
      return state.currentConversation ? !!state.processingConversations[state.currentConversation] : false;
    },
    canSend: (state) => {
      if (!state.currentAgent || !state.currentConversation) return false;
      return true; // 始终允许发送（排队机制支持）
    },
    currentAgentName: (state) => {
      return state.currentAgentInfo?.name || '选择 Agent';
    },
    currentAgentWorkDir: (state) => {
      return state.currentAgentInfo?.workDir || '';
    },
    // Effective workDir for the workbench (Files / Git tabs).
    //
    // Chat mode: the conversation's project dir (`currentWorkDir`) takes
    // precedence, falling back to the agent's cwd. Preserves prior behavior.
    //
    // Yeaft mode: the Chat agent's cwd is the wrong default — it leaks
    // whichever Chat conversation the user last opened into the group's
    // workbench. Precedence:
    //   1. active group's own workDir (groups don't carry one on main yet,
    //      but the lookup is wired so the day they do, no consumer changes
    //      are needed),
    //   2. agent's ~/.yeaft home, advertised via session_ready.yeaftDir,
    //   3. agent cwd as a final fallback if session_ready hasn't landed.
    //
    // Until `yeaftSessionReady`, we still return the fallback chain rather
    // than '' so first-paint Files/Git RPCs don't hit a no-op — a brief
    // flicker is preferable to a blank workbench during the ~1 tick gap.
    effectiveWorkDir: (state) => {
      if (state.currentView === 'yeaft') {
        const groupWorkDir = getSessionsStore()?.activeSession?.workDir;
        return groupWorkDir
          || state.yeaftYeaftDir
          || state.currentAgentInfo?.workDir
          || '';
      }
      return state.currentWorkDir || state.currentAgentInfo?.workDir || '';
    },
    // 当前 Agent 的能力列表
    currentAgentCapabilities: (state) => {
      return state.currentAgentInfo?.capabilities || ['terminal', 'file_editor', 'background_tasks'];
    },
    // 检查当前 Agent 是否支持指定能力
    hasCapability: (state) => (capability) => {
      const caps = state.currentAgentInfo?.capabilities || ['terminal', 'file_editor', 'background_tasks'];
      return caps.includes(capability);
    },
    // 获取会话标题
    getConversationTitle: (state) => (conversationId) => {
      return state.customConversationTitles[conversationId] || state.conversationTitles[conversationId] || null;
    },
    // 获取当前会话的执行状态
    executionStatus: (state) => {
      if (!state.currentConversation) {
        return { currentTool: null, toolHistory: [], lastActivity: null };
      }
      return state.executionStatusMap[state.currentConversation] || { currentTool: null, toolHistory: [], lastActivity: null };
    },
    // 检查某个会话是否在处理中
    isConversationProcessing: (state) => (conversationId) => {
      return !!state.processingConversations[conversationId];
    },
    // True while a non-Claude provider session boots in the background (between
    // conversation_created and its system_init / error frame). Drives the
    // "connecting" indicator so a deferred boot doesn't look idle.
    isConversationConnecting: (state) => (conversationId) => {
      if (!conversationId) return false;
      const conv = state.conversations.find(c => c.id === conversationId);
      return !!conv?.connecting;
    },
    isConversationCompacting: (state) => (conversationId) => {
      if (!conversationId) return false;
      return state.compactStatus?.conversationId === conversationId
        && state.compactStatus?.status === 'compacting';
    },
    isYeaftSessionProcessing: (state) => (sessionId, agentId = null) => (
      isYeaftSessionProcessingState(state, sessionId, agentId)
    ),
    isSessionHistorySyncing: (state) => (routeRef) => {
      const sessionId = routeRef?.sessionId || null;
      if (!sessionId) return false;
      if (routeRef.runtimeProvider === 'yeaft') {
        return !!state.yeaftSessionHistoryState?.[
          yeaftHistoryIdentityKey(routeRef.agentId || null, sessionId)
        ]?.loading;
      }
      return !!state.chatHistoryRequests?.[chatCatalogKey(sessionId)]?.loading;
    },
    isYeaftSessionUnread: (state) => (sessionId, agentId = null) => {
      if (!sessionId) return false;
      const ownerAgentId = resolveAgentIdForSession(state, sessionId, agentId);
      if (!ownerAgentId) return false;
      return !!state.yeaftUnreadSessionKeys?.[yeaftCatalogKey(ownerAgentId, sessionId)];
    },
    // 是否显示恢复提示
    showRecoveryBanner: (state) => {
      return state.pendingRecovery && !state.recoveryDismissed && !state.currentConversation;
    },
    // 当前会话的 subagent 列表
    currentSubagents: (state) => {
      if (!state.currentConversation) return EMPTY_ARRAY;
      const convSubagents = state.subagents[state.currentConversation];
      if (!convSubagents) return EMPTY_ARRAY;
      return Object.values(convSubagents);
    },
    // 是否有正在运行的 subagent
    hasRunningSubagents: (state) => {
      if (!state.currentConversation) return false;
      const convSubagents = state.subagents[state.currentConversation];
      if (!convSubagents) return false;
      return Object.values(convSubagents).some(s => s.status === 'running');
    },
    // 运行中的 subagent 数
    runningSubagentCount: (state) => {
      if (!state.currentConversation) return 0;
      const convSubagents = state.subagents[state.currentConversation];
      if (!convSubagents) return 0;
      return Object.values(convSubagents).filter(s => s.status === 'running').length;
    },
    // 当前展开的 subagent 的消息列表
    activeSubagentMessages: (state) => {
      if (!state.currentConversation || !state.activeSubagentId) return EMPTY_ARRAY;
      const convSubagents = state.subagents[state.currentConversation];
      if (!convSubagents) return EMPTY_ARRAY;
      const agent = convSubagents[state.activeSubagentId];
      const messages = Array.isArray(agent?.messages) ? agent.messages : EMPTY_ARRAY;
      return messages.filter((msg) => msg?.type === 'text');
    },
    // 当前选中的后台任务详情（保留接口兼容）
    selectedTaskInfo: () => {
      return null;
    },
    // 当前 conversation 的 MCP servers 列表
    currentMcpServers: (state) => {
      if (!state.currentConversation) return EMPTY_ARRAY;
      return state.conversationMcpServers[state.currentConversation] || EMPTY_ARRAY;
    }
  },

  actions: {
    /**
     * Activate the Chat surface and finish any suspended Yeaft-to-Chat
     * transition. Cold Yeaft restores carry a pending Chat conversation rather
     * than a live snapshot; consume it here so every route to Chat restores the
     * same workDir, history and server-side conversation selection.
     *
     * @param {{ persistPreference?: boolean }} options
     */
    activateChatView({ persistPreference = false } = {}) {
      const pendingChatRestoreConversationId = this._pendingChatRestoreConversationId;
      this._pendingChatRestoreConversationId = null;
      const pendingChatConversation = pendingChatRestoreConversationId
        ? this.conversations.find(conversation => conversation.id === pendingChatRestoreConversationId)
        : null;
      const pendingChatAgent = pendingChatConversation?.agentId
        ? this.agents.find(agent => agent.id === pendingChatConversation.agentId && agent.online)
        : null;
      if (!this._savedChatIdentity && pendingChatConversation && pendingChatAgent) {
        this._savedChatIdentity = {
          agentId: pendingChatAgent.id,
          agentInfo: { ...pendingChatAgent },
          workDir: pendingChatConversation.workDir || pendingChatAgent.workDir || null,
        };
      }
      this.currentView = 'chat';
      if (persistPreference) {
        yeaftViewHelpers.persistPreferredConversationView('chat');
      }
      const chatIdentity = this._savedChatIdentity || null;
      const pendingTargetsAnotherAgent = this.pendingAgentSelection
        && this.pendingAgentSelection.agentId !== chatIdentity?.agentId;
      if (chatIdentity?.agentId
          && (this.currentAgent !== chatIdentity.agentId || pendingTargetsAnotherAgent)) {
        this.selectAgent(chatIdentity.agentId);
      }
      yeaftViewHelpers.applyLeaveYeaftTransition(this);
      if (pendingChatRestoreConversationId && pendingChatConversation && pendingChatAgent) {
        this.autoRestoreConversation(pendingChatRestoreConversationId);
        this.sendWsMessage({
          type: 'refresh_conversation',
          conversationId: pendingChatRestoreConversationId,
        });
      }
    },

    // =====================
    // Work Center
    // =====================
    enterWorkCenter(agentId = null) {
      if (!this.hydrateWorkCenterBrowserState()) return false;
      const compatibleAgents = this.agents.filter(agent => agent?.online
        && Array.isArray(agent.capabilities) && agent.capabilities.includes('work_center'));
      const target = compatibleAgents.some(agent => agent.id === agentId)
        ? agentId
        : (compatibleAgents[0]?.id || null);
      if (!target) {
        this.workCenterOpen = false;
        this.workCenterAgentId = null;
        return false;
      }
      if (this.currentAgent !== target) {
        this.selectAgent(target);
        this.currentAgent = target;
        const info = this.agents.find(agent => agent.id === target);
        if (info) this.currentAgentInfo = info;
      }
      this.workCenterAgentId = target;
      this.workCenterOpen = true;
      this.listWorkItems(target).catch(() => {});
      return true;
    },
    leaveWorkCenter() {
      this.workCenterOpen = false;
    },
    openPluginCenter(agentId = null) {
      const target = this.agents.find(agent => agent?.online && agent.id === agentId)
        || this.agents.find(agent => agent?.online && agent.id === this.currentAgent)
        || this.agents.find(agent => agent?.online)
        || null;
      if (!target) return false;
      this.pluginCenterAgentId = target.id;
      this.pluginCenterOpen = true;
      return true;
    },
    closePluginCenter() {
      this.pluginCenterOpen = false;
    },
    pluginCatalogKey(agentId, workDir = '') {
      return `${agentId || ''}\u001f${String(workDir || '').trim()}`;
    },
    loadPluginConfig(agentId = this.pluginCenterAgentId || this.currentAgent) {
      if (!agentId) return Promise.resolve({ plugins: {}, error: 'no agent' });
      const requestId = `plugins-get-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const pending = this._pluginPending?.[requestId];
          if (!pending) return;
          delete this._pluginPending[requestId];
          resolve({ plugins: {}, error: 'timeout' });
        }, 10_000);
        this._pluginPending[requestId] = { resolve, timer, kind: 'config', agentId };
        this.sendWsMessage({ type: 'get_yeaft_plugins', agentId, requestId });
      });
    },
    savePluginConfig(plugins, agentId = this.pluginCenterAgentId || this.currentAgent) {
      if (!agentId) return Promise.resolve({ plugins: {}, error: 'no agent' });
      const requestId = `plugins-save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const pending = this._pluginPending?.[requestId];
          if (!pending) return;
          delete this._pluginPending[requestId];
          resolve({ plugins: {}, error: 'timeout' });
        }, 10_000);
        this._pluginPending[requestId] = { resolve, timer, kind: 'save', agentId };
        this.sendWsMessage({ type: 'update_yeaft_plugins', agentId, requestId, plugins });
      });
    },
    loadPluginCatalog(agentId = this.pluginCenterAgentId || this.currentAgent, workDir = '') {
      if (!agentId) return Promise.resolve({ catalog: { tools: [], skills: [], mcpServers: [] }, error: 'no agent' });
      const key = this.pluginCatalogKey(agentId, workDir);
      const requestId = `plugins-catalog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.pluginCatalogByKey = {
        ...this.pluginCatalogByKey,
        [key]: { ...(this.pluginCatalogByKey[key] || {}), loading: true, error: null },
      };
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const pending = this._pluginPending?.[requestId];
          if (!pending) return;
          delete this._pluginPending[requestId];
          this.pluginCatalogByKey = {
            ...this.pluginCatalogByKey,
            [key]: { ...(this.pluginCatalogByKey[key] || {}), loading: false, error: 'timeout' },
          };
          resolve({ catalog: { tools: [], skills: [], mcpServers: [] }, error: 'timeout' });
        }, 10_000);
        this._pluginPending[requestId] = { resolve, timer, kind: 'catalog', agentId, key };
        this.sendWsMessage({ type: 'yeaft_plugin_catalog', agentId, requestId, workDir: String(workDir || '').trim() });
      });
    },
    enterWorkCenterFromSession(session, seedGoal = '') {
      if (!session?.id) return;
      const agentId = session.agentId || resolveAgentIdForSession(this, session.id);
      const requirement = String(seedGoal || session.title || session.name || '').trim();
      this.workCenterCreateDraft = {
        sourceAgentId: agentId,
        requirement,
        workDir: String(session.workDir || '').trim(),
        origin: { sessionId: session.id, messageId: null, createdBy: 'user' },
        linkedSessionIds: [session.id],
      };
      this.enterWorkCenter(agentId);
    },
    hydrateWorkCenterBrowserState() {
      if (!this._workCenterBrowserUnsubscribe) {
        this._workCenterBrowserUnsubscribe = subscribeWorkCenterBrowserOwner(() => {
          if (!isWorkCenterBrowserFenceCurrent(this._workCenterBrowserFence)) {
            this.clearWorkCenterBrowserState();
          }
        });
      }
      const fence = currentWorkCenterBrowserOwner();
      if (!fence) {
        this._workCenterBrowserFence = null;
        this.workCenterComposerDrafts = {};
        this.workCenterMessageOutbox = {};
        return false;
      }
      if (!isWorkCenterBrowserFenceCurrent(this._workCenterBrowserFence)) {
        const persisted = readWorkCenterBrowserState(fence);
        this._workCenterBrowserFence = fence;
        this.workCenterComposerDrafts = persisted.drafts;
        this.workCenterMessageOutbox = persisted.outbox;
      }
      return true;
    },
    clearWorkCenterBrowserState() {
      this._workCenterBrowserFence = null;
      this.workCenterComposerDrafts = {};
      this.workCenterMessageOutbox = {};
    },
    workCenterComposerKey(agentId, workItemId) {
      return workCenterClientMessageKey(agentId, workItemId);
    },
    saveWorkCenterComposerDraft(agentId, workItemId, draft = {}) {
      const key = workCenterClientMessageKey(agentId, workItemId);
      if (!agentId || !workItemId) return;
      const quote = normalizeSessionMessageQuote(draft.quote);
      const next = {
        ...(this.workCenterComposerDrafts || {}),
        [key]: {
          text: String(draft.text || ''),
          ...(quote ? { quote } : {}),
          attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
          target: normalizedWorkCenterDraftTarget(draft.target),
          error: String(draft.error || ''),
        },
      };
      if (!writeWorkCenterDrafts(next, this._workCenterBrowserFence)) return false;
      this.workCenterComposerDrafts = next;
      return true;
    },
    loadWorkCenterComposerDraft(agentId, workItemId) {
      return this.workCenterComposerDrafts?.[workCenterClientMessageKey(agentId, workItemId)] || null;
    },
    removeWorkCenterComposerDraft(agentId, workItemId) {
      const key = workCenterClientMessageKey(agentId, workItemId);
      const next = { ...(this.workCenterComposerDrafts || {}) };
      delete next[key];
      if (!writeWorkCenterDrafts(next, this._workCenterBrowserFence)) return false;
      this.workCenterComposerDrafts = next;
      return true;
    },
    prepareWorkCenterMessageEnvelope(input = {}) {
      const payload = workCenterEnvelopePayload(input);
      const key = workCenterClientMessageKey(payload.agentId, payload.workItemId);
      const existing = this.workCenterMessageOutbox?.[key] || null;
      if (existing) return existing;
      const envelope = {
        ...payload,
        clientMessageId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
        createdAt: Date.now(),
      };
      const next = { ...(this.workCenterMessageOutbox || {}), [key]: envelope };
      if (!writeWorkCenterOutbox(next, this._workCenterBrowserFence)) return null;
      this.workCenterMessageOutbox = next;
      return envelope;
    },
    loadWorkCenterMessageEnvelope(agentId, workItemId) {
      return this.workCenterMessageOutbox?.[workCenterClientMessageKey(agentId, workItemId)] || null;
    },
    replaceWorkCenterMessageEnvelopeAttachments(agentId, workItemId, attachments = []) {
      const key = workCenterClientMessageKey(agentId, workItemId);
      const envelope = this.workCenterMessageOutbox?.[key];
      if (!envelope) return null;
      const replacement = {
        ...envelope,
        attachments: Array.isArray(attachments) ? attachments.map(attachment => ({
          fileId: attachment?.fileId || '',
          name: attachment?.name || '',
          mimeType: attachment?.mimeType || '',
          size: Math.max(0, Number(attachment?.size) || 0),
        })) : [],
      };
      const next = { ...(this.workCenterMessageOutbox || {}), [key]: replacement };
      if (!writeWorkCenterOutbox(next, this._workCenterBrowserFence)) return null;
      this.workCenterMessageOutbox = next;
      return replacement;
    },
    discardWorkCenterMessageEnvelope(agentId, workItemId) {
      const key = workCenterClientMessageKey(agentId, workItemId);
      const next = { ...(this.workCenterMessageOutbox || {}) };
      delete next[key];
      if (!writeWorkCenterOutbox(next, this._workCenterBrowserFence)) return false;
      this.workCenterMessageOutbox = next;
      return true;
    },
    confirmWorkCenterMessageEnvelope(agentId, workItemId, clientMessageId) {
      const key = workCenterClientMessageKey(agentId, workItemId);
      const envelope = this.workCenterMessageOutbox?.[key];
      if (!envelope || envelope.clientMessageId !== clientMessageId) return false;
      const next = { ...(this.workCenterMessageOutbox || {}) };
      delete next[key];
      if (!writeWorkCenterOutbox(next, this._workCenterBrowserFence)) return false;
      this.workCenterMessageOutbox = next;
      this.removeWorkCenterComposerDraft(agentId, workItemId);
      return true;
    },
    workCenterRequest(op, payload = {}, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      if (!target) return Promise.reject(new Error('No Agent selected'));
      const requestId = `work-center-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          delete this.workCenterPending[requestId];
          reject(new Error('Work Center request timed out'));
        }, 30_000);
        this.workCenterPending[requestId] = {
          resolve,
          reject,
          timer,
          agentId: target,
          op,
          clientMessageId: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : null,
        };
        this.sendWsMessage({ type: 'work_center_request', agentId: target, requestId, op, payload });
      });
    },
    workItemMatchesBoardQuery(item, filters = {}) {
      if (!item) return false;
      if (filters.lane && item.boardLane !== filters.lane) return false;
      if (filters.vpId && !(item.executors || []).some(executor => executor?.id === filters.vpId)) return false;
      if (filters.workItemType && item.workItemType !== filters.workItemType) return false;
      if (filters.updatedFrom && Number(item.updatedAt) < Number(filters.updatedFrom)) return false;
      if (filters.updatedTo && Number(item.updatedAt) > Number(filters.updatedTo)) return false;
      const keyword = String(filters.keyword || '').trim().toLowerCase();
      return !keyword || String(item.title || '').toLowerCase().includes(keyword)
        || String(item.goal || '').toLowerCase().includes(keyword);
    },
    applyWorkItemBoardSummary(items, summary, filters = {}) {
      const merged = applyWorkItemSummary(items, summary);
      const accepted = merged.find(item => item?.id === summary?.id) || null;
      if (!accepted || this.workItemMatchesBoardQuery(accepted, filters)) return merged;
      return merged.filter(item => item.id !== accepted.id);
    },
    async listWorkItems(agentId = null, filters = {}) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      if (!target) return [];
      const normalizedFilters = {
        lane: ['needs_attention', 'active', 'closed'].includes(filters.lane) ? filters.lane : null,
        keyword: String(filters.keyword || filters.search || '').trim(),
        vpId: String(filters.vpId || '').trim(),
        workItemType: String(filters.workItemType || '').trim(),
        createdFrom: Number(filters.createdFrom) || null,
        createdTo: Number(filters.createdTo) || null,
        updatedFrom: Number(filters.updatedFrom) || null,
        updatedTo: Number(filters.updatedTo) || null,
        limit: Math.min(Math.max(Number(filters.limit) || 100, 1), 200),
      };
      const queryKey = JSON.stringify(normalizedFilters);
      const generation = Number(this._workCenterListGenerationByAgent[target] || 0) + 1;
      const eventGeneration = Number(this._workCenterListEventGenerationByAgent[target] || 0);
      this._workCenterListGenerationByAgent = { ...this._workCenterListGenerationByAgent, [target]: generation };
      this._workCenterListQueryByAgent = { ...this._workCenterListQueryByAgent, [target]: queryKey };
      this._workCenterListFiltersByAgent = { ...this._workCenterListFiltersByAgent, [target]: normalizedFilters };
      this.workCenterLoadingByAgent = { ...this.workCenterLoadingByAgent, [target]: true };
      this.workCenterErrorByAgent = { ...this.workCenterErrorByAgent, [target]: null };
      try {
        const data = await this.workCenterRequest('list', normalizedFilters, target);
        const items = (Array.isArray(data?.items) ? data.items : [])
          .filter(item => !this.workItemDeleted(target, item?.id));
        const requestStillCurrent = this._workCenterListGenerationByAgent[target] === generation
          && this._workCenterListQueryByAgent[target] === queryKey
          && this.workCenterAgentId === target;
        if (requestStillCurrent) {
          let mergedItems = items;
          const events = this._workCenterListEventsByAgent[target] || {};
          for (const entry of Object.values(events)) {
            if (Number(entry?.generation) <= eventGeneration || entry?.queryKey !== queryKey) continue;
            mergedItems = this.applyWorkItemBoardSummary(
              mergedItems, entry.summary, normalizedFilters,
            );
          }
          this.workCenterItemsByAgent = { ...this.workCenterItemsByAgent, [target]: mergedItems };
          this.workCenterListPageByAgent = {
            ...this.workCenterListPageByAgent,
            [target]: { nextCursor: data?.nextCursor || null, queryKey },
          };
          this.workCenterWatcherByAgent = { ...this.workCenterWatcherByAgent, [target]: data?.watcher || null };
          this.workCenterLoadedByAgent = { ...this.workCenterLoadedByAgent, [target]: true };
        }
        return items;
      } catch (err) {
        if (this._workCenterListGenerationByAgent[target] === generation
            && this._workCenterListQueryByAgent[target] === queryKey) {
          this.workCenterErrorByAgent = { ...this.workCenterErrorByAgent, [target]: err?.message || String(err) };
        }
        throw err;
      } finally {
        if (this._workCenterListGenerationByAgent[target] === generation
            && this._workCenterListQueryByAgent[target] === queryKey) {
          this.workCenterLoadingByAgent = { ...this.workCenterLoadingByAgent, [target]: false };
        }
      }
    },
    async loadMoreWorkItems(agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const page = this.workCenterListPageByAgent[target];
      const filters = this._workCenterListFiltersByAgent[target];
      if (!target || !page?.nextCursor || !filters) return [];
      const queryKey = page.queryKey;
      const generation = this._workCenterListGenerationByAgent[target];
      const eventGeneration = Number(this._workCenterListEventGenerationByAgent[target] || 0);
      const cursor = page.nextCursor;
      const requestKey = `${generation}:${queryKey}:${cursor}`;
      if (this._workCenterListMoreRequestsByAgent[target]?.key === requestKey) {
        return this._workCenterListMoreRequestsByAgent[target].request;
      }
      this.workCenterListMoreLoadingByAgent = {
        ...this.workCenterListMoreLoadingByAgent, [target]: true,
      };
      const request = (async () => {
        try {
          const data = await this.workCenterRequest('list', { ...filters, cursor }, target);
          const currentPage = this.workCenterListPageByAgent[target];
          if (this._workCenterListGenerationByAgent[target] !== generation
              || this._workCenterListQueryByAgent[target] !== queryKey
              || currentPage?.queryKey !== queryKey
              || currentPage?.nextCursor !== cursor
              || this.workCenterAgentId !== target) return [];
          let merged = [...(this.workCenterItemsByAgent[target] || [])];
          for (const item of Array.isArray(data?.items) ? data.items : []) {
            if (this.workItemDeleted(target, item?.id)) continue;
            const index = merged.findIndex(current => current.id === item.id);
            if (index < 0) merged.push(item);
            else merged[index] = applyWorkItemSummary([merged[index]], item)[0];
          }
          const events = this._workCenterListEventsByAgent[target] || {};
          for (const entry of Object.values(events)) {
            if (Number(entry?.generation) <= eventGeneration || entry?.queryKey !== queryKey) continue;
            merged = this.applyWorkItemBoardSummary(merged, entry.summary, filters);
          }
          this.workCenterItemsByAgent = { ...this.workCenterItemsByAgent, [target]: merged };
          this.workCenterListPageByAgent = {
            ...this.workCenterListPageByAgent,
            [target]: { nextCursor: data?.nextCursor || null, queryKey },
          };
          return data?.items || [];
        } finally {
          if (this._workCenterListMoreRequestsByAgent[target]?.key === requestKey) {
            const pending = { ...this._workCenterListMoreRequestsByAgent };
            delete pending[target];
            this._workCenterListMoreRequestsByAgent = pending;
            this.workCenterListMoreLoadingByAgent = {
              ...this.workCenterListMoreLoadingByAgent, [target]: false,
            };
          }
        }
      })();
      this._workCenterListMoreRequestsByAgent = {
        ...this._workCenterListMoreRequestsByAgent,
        [target]: { key: requestKey, request },
      };
      return request;
    },
    workItemDeleted(agentId, id) {
      return !!this._workCenterDeletedIdsByAgent[agentId]?.[id];
    },
    removeWorkItemState(agentId, id) {
      this._workCenterDeletedIdsByAgent = {
        ...this._workCenterDeletedIdsByAgent,
        [agentId]: { ...(this._workCenterDeletedIdsByAgent[agentId] || {}), [id]: true },
      };
      this.beginWorkCenterDetailWrite(agentId);
      this.workCenterItemsByAgent = {
        ...this.workCenterItemsByAgent,
        [agentId]: (this.workCenterItemsByAgent[agentId] || []).filter(item => item.id !== id),
      };
      if (this.workCenterDetailByAgent[agentId]?.id === id) {
        this.workCenterDetailByAgent = { ...this.workCenterDetailByAgent, [agentId]: null };
      }
      const prefix = `${agentId}:${id}:`;
      for (const field of [
        'workCenterActionMessages', 'workCenterActionMessagesLoading', 'workCenterActionMessagesError',
        'workCenterActionRequests', 'workCenterActionRequestsLoading', 'workCenterActionRequestsError',
        'workCenterActionRequestDetails', 'workCenterActionRequestDetailsLoading', 'workCenterActionRequestDetailsError',
        '_workCenterActionMessageRequests', '_workCenterActionMessageGenerationByKey',
        '_workCenterActionRequestsGeneration', '_workCenterActionRequestDetailsGeneration',
      ]) {
        const next = {};
        for (const [key, value] of Object.entries(this[field] || {})) {
          if (!key.startsWith(prefix)) next[key] = value;
        }
        this[field] = next;
      }
    },
    beginWorkCenterDetailWrite(agentId) {
      const generation = Number(this._workCenterDetailRequestGenerationByAgent[agentId] || 0) + 1;
      this._workCenterDetailRequestGenerationByAgent = {
        ...this._workCenterDetailRequestGenerationByAgent,
        [agentId]: generation,
      };
      return generation;
    },
    commitWorkCenterDetail(agentId, detail, generation) {
      if (detail?.id && this.workItemDeleted(agentId, detail.id)) return false;
      if (generation != null
          && Number(this._workCenterDetailRequestGenerationByAgent[agentId] || 0) !== generation) return false;
      const current = this.workCenterDetailByAgent[agentId];
      if (current?.id === detail?.id && isWorkItemDetailStale(detail, current)) return false;
      this.workCenterDetailByAgent = { ...this.workCenterDetailByAgent, [agentId]: detail };
      return true;
    },
    async getWorkItem(id, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('get', { id }, target);
      this.commitWorkCenterDetail(target, detail, generation);
      return this.workCenterDetailByAgent[target] || detail;
    },
    invalidateWorkItemActionMessages(agentId, id, actionId, actionGeneration) {
      if (!agentId || !id || !actionId) return null;
      const expectedGeneration = normalizeWorkCenterActionGeneration(actionGeneration);
      const key = workCenterActionMessageKey(agentId, id, actionId, expectedGeneration);
      this._workCenterActionMessageGenerationByKey = {
        ...this._workCenterActionMessageGenerationByKey,
        [key]: Number(this._workCenterActionMessageGenerationByKey[key] || 0) + 1,
      };
      for (const field of [
        'workCenterActionMessages',
        'workCenterActionMessagesLoading',
        'workCenterActionMessagesError',
      ]) {
        const next = { ...this[field] };
        delete next[key];
        this[field] = next;
      }
      const pending = { ...this._workCenterActionMessageRequests };
      for (const requestKey of Object.keys(pending)) {
        if (requestKey.startsWith(`${key}:`)) delete pending[requestKey];
      }
      this._workCenterActionMessageRequests = pending;
      return key;
    },
    async loadWorkItemActionMessages(id, actionId, actionGeneration, cursor, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const expectedGeneration = normalizeWorkCenterActionGeneration(actionGeneration);
      const key = workCenterActionMessageKey(target, id, actionId, expectedGeneration);
      const cacheGeneration = Number(this._workCenterActionMessageGenerationByKey[key] || 0);
      const requestKey = `${key}:${cursor == null ? 'latest' : String(cursor)}`;
      if (this._workCenterActionMessageRequests[requestKey]) return this._workCenterActionMessageRequests[requestKey];
      this.workCenterActionMessagesLoading = { ...this.workCenterActionMessagesLoading, [key]: true };
      this.workCenterActionMessagesError = { ...this.workCenterActionMessagesError, [key]: null };
      const request = (async () => {
        try {
          const data = await this.workCenterRequest('get_action_messages', {
            id, actionId, generation: expectedGeneration, cursor, limit: 20,
          }, target);
          if (this.workItemDeleted(target, id)
              || normalizeWorkCenterActionGeneration(data?.generation) !== expectedGeneration
              || Number(this._workCenterActionMessageGenerationByKey[key] || 0) !== cacheGeneration) return data;
          const current = this.workCenterActionMessages[key]?.messages || [];
          const messages = mergeActionMessages(current, data?.messages || []);
          const existingPage = this.workCenterActionMessages[key];
          const currentCursor = existingPage?.nextCursor;
          const requestedCursor = cursor == null ? null : Number(cursor);
          const activeCursor = currentCursor == null ? null : Number(currentCursor);
          const shouldAdvanceCursor = !existingPage
            || requestedCursor == null
            || (activeCursor != null && requestedCursor === activeCursor);
          this.workCenterActionMessages = {
            ...this.workCenterActionMessages,
            [key]: {
              generation: expectedGeneration,
              messages,
              nextCursor: shouldAdvanceCursor ? (data?.nextCursor ?? null) : currentCursor,
              total: Math.max(Number(data?.total) || 0, Number(existingPage?.total) || 0, messages.length),
            },
          };
          return data;
        } catch (error) {
          if (Number(this._workCenterActionMessageGenerationByKey[key] || 0) === cacheGeneration) {
            this.workCenterActionMessagesError = {
              ...this.workCenterActionMessagesError,
              [key]: error?.message || String(error),
            };
          }
          throw error;
        } finally {
          if (this._workCenterActionMessageRequests[requestKey] === request) {
            const pending = { ...this._workCenterActionMessageRequests };
            delete pending[requestKey];
            this._workCenterActionMessageRequests = pending;
            const stillLoading = Object.keys(pending).some(candidate => candidate.startsWith(`${key}:`));
            this.workCenterActionMessagesLoading = { ...this.workCenterActionMessagesLoading, [key]: stillLoading };
          }
        }
      })();
      this._workCenterActionMessageRequests = {
        ...this._workCenterActionMessageRequests,
        [requestKey]: request,
      };
      return request;
    },
    async loadWorkItemActionRequests(id, actionId, actionGeneration, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const expectedGeneration = normalizeWorkCenterActionGeneration(actionGeneration);
      const key = workCenterActionRequestScopeKey(target, id, actionId, expectedGeneration);
      const requestGeneration = Number(this._workCenterActionRequestsGeneration[key] || 0) + 1;
      this._workCenterActionRequestsGeneration = {
        ...this._workCenterActionRequestsGeneration,
        [key]: requestGeneration,
      };
      this.workCenterActionRequestsLoading = { ...this.workCenterActionRequestsLoading, [key]: true };
      this.workCenterActionRequestsError = { ...this.workCenterActionRequestsError, [key]: null };
      try {
        const data = await this.workCenterRequest('get_action_requests', {
          id, actionId, generation: expectedGeneration,
        }, target);
        const accepted = !this.workItemDeleted(target, id)
          && normalizeWorkCenterActionGeneration(data?.generation) === expectedGeneration
          && this._workCenterActionRequestsGeneration[key] === requestGeneration;
        if (accepted) {
          this.workCenterActionRequests = { ...this.workCenterActionRequests, [key]: data?.requests || [] };
        }
        return accepted ? (data?.requests || []) : (this.workCenterActionRequests[key] || []);
      } catch (error) {
        if (this._workCenterActionRequestsGeneration[key] === requestGeneration) {
          this.workCenterActionRequestsError = {
            ...this.workCenterActionRequestsError,
            [key]: error?.message || String(error),
          };
        }
        throw error;
      } finally {
        if (this._workCenterActionRequestsGeneration[key] === requestGeneration) {
          this.workCenterActionRequestsLoading = { ...this.workCenterActionRequestsLoading, [key]: false };
        }
      }
    },
    async loadWorkItemActionRequest(id, actionId, actionGeneration, runId, requestId, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const expectedGeneration = normalizeWorkCenterActionGeneration(actionGeneration);
      const scopeKey = workCenterActionRequestScopeKey(target, id, actionId, expectedGeneration);
      const key = `${scopeKey}:${runId}:${requestId}`;
      const requestGeneration = Number(this._workCenterActionRequestDetailsGeneration[key] || 0) + 1;
      this._workCenterActionRequestDetailsGeneration = {
        ...this._workCenterActionRequestDetailsGeneration,
        [key]: requestGeneration,
      };
      this.workCenterActionRequestDetailsLoading = {
        ...this.workCenterActionRequestDetailsLoading,
        [key]: true,
      };
      this.workCenterActionRequestDetailsError = {
        ...this.workCenterActionRequestDetailsError,
        [key]: null,
      };
      try {
        const data = await this.workCenterRequest('get_action_request', {
          id, actionId, generation: expectedGeneration, runId, requestId,
        }, target);
        const accepted = !this.workItemDeleted(target, id)
          && normalizeWorkCenterActionGeneration(data?.generation) === expectedGeneration
          && this._workCenterActionRequestDetailsGeneration[key] === requestGeneration;
        if (accepted) {
          this.workCenterActionRequestDetails = {
            ...this.workCenterActionRequestDetails,
            [key]: data?.request || null,
          };
        }
        return accepted ? (data?.request || null) : (this.workCenterActionRequestDetails[key] || null);
      } catch (error) {
        if (this._workCenterActionRequestDetailsGeneration[key] === requestGeneration) {
          this.workCenterActionRequestDetailsError = {
            ...this.workCenterActionRequestDetailsError,
            [key]: error?.message || String(error),
          };
        }
        throw error;
      } finally {
        if (this._workCenterActionRequestDetailsGeneration[key] === requestGeneration) {
          this.workCenterActionRequestDetailsLoading = {
            ...this.workCenterActionRequestDetailsLoading,
            [key]: false,
          };
        }
      }
    },
    async loadWorkCenterSettings(agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      if (!target) throw new Error('No Agent selected');
      const generation = Number(this._workCenterSettingsGenerationByAgent[target] || 0) + 1;
      this._workCenterSettingsGenerationByAgent = {
        ...this._workCenterSettingsGenerationByAgent,
        [target]: generation,
      };
      this.workCenterSettingsLoadingByAgent = { ...this.workCenterSettingsLoadingByAgent, [target]: true };
      this.workCenterSettingsErrorByAgent = { ...this.workCenterSettingsErrorByAgent, [target]: null };
      try {
        const data = await this.workCenterRequest('get_settings', {}, target);
        if (this._workCenterSettingsGenerationByAgent[target] === generation) {
          this.workCenterSettingsByAgent = { ...this.workCenterSettingsByAgent, [target]: data?.settings || null };
          this.workCenterRuntimeByAgent = { ...this.workCenterRuntimeByAgent, [target]: data?.runtime || null };
        }
        return data;
      } catch (err) {
        if (this._workCenterSettingsGenerationByAgent[target] === generation) {
          this.workCenterSettingsErrorByAgent = {
            ...this.workCenterSettingsErrorByAgent,
            [target]: err?.message || String(err),
          };
        }
        throw err;
      } finally {
        if (this._workCenterSettingsGenerationByAgent[target] === generation) {
          this.workCenterSettingsLoadingByAgent = { ...this.workCenterSettingsLoadingByAgent, [target]: false };
        }
      }
    },
    async refreshWorkCenterRuntime(agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      if (!target) throw new Error('No Agent selected');
      const generation = Number(this._workCenterSettingsGenerationByAgent[target] || 0) + 1;
      this._workCenterSettingsGenerationByAgent = {
        ...this._workCenterSettingsGenerationByAgent,
        [target]: generation,
      };
      this.workCenterSettingsLoadingByAgent = { ...this.workCenterSettingsLoadingByAgent, [target]: true };
      this.workCenterSettingsErrorByAgent = { ...this.workCenterSettingsErrorByAgent, [target]: null };
      try {
        const data = await this.workCenterRequest('refresh_runtime', {}, target);
        if (this._workCenterSettingsGenerationByAgent[target] === generation) {
          this.workCenterSettingsByAgent = { ...this.workCenterSettingsByAgent, [target]: data?.settings || null };
          this.workCenterRuntimeByAgent = { ...this.workCenterRuntimeByAgent, [target]: data?.runtime || null };
        }
        return data;
      } catch (err) {
        if (this._workCenterSettingsGenerationByAgent[target] === generation) {
          this.workCenterSettingsErrorByAgent = {
            ...this.workCenterSettingsErrorByAgent,
            [target]: err?.message || String(err),
          };
        }
        throw err;
      } finally {
        if (this._workCenterSettingsGenerationByAgent[target] === generation) {
          this.workCenterSettingsLoadingByAgent = { ...this.workCenterSettingsLoadingByAgent, [target]: false };
        }
      }
    },
    async saveWorkCenterSettings(settings, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      if (!target) throw new Error('No Agent selected');
      const generation = Number(this._workCenterSettingsGenerationByAgent[target] || 0) + 1;
      this._workCenterSettingsGenerationByAgent = {
        ...this._workCenterSettingsGenerationByAgent,
        [target]: generation,
      };
      const data = await this.workCenterRequest('update_settings', { settings }, target);
      if (this._workCenterSettingsGenerationByAgent[target] === generation) {
        this.workCenterSettingsByAgent = { ...this.workCenterSettingsByAgent, [target]: data?.settings || null };
        this.workCenterRuntimeByAgent = { ...this.workCenterRuntimeByAgent, [target]: data?.runtime || null };
        this.workCenterSettingsErrorByAgent = { ...this.workCenterSettingsErrorByAgent, [target]: null };
      }
      return data;
    },
    previewWorkCenterPlan(payload = {}, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      return this.workCenterRequest('preview', payload, target);
    },
    async createWorkItem(payload, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('create', payload, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.commitWorkCenterDetail(target, detail, generation);
      return detail;
    },
    async updateWorkItem(id, patch, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('update', { id, patch }, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.commitWorkCenterDetail(target, detail, generation);
      return detail;
    },
    async startWorkItem(id, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('start', { id }, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.commitWorkCenterDetail(target, detail, generation);
      return detail;
    },
    async cancelWorkItem(id, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('cancel', { id }, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.commitWorkCenterDetail(target, detail, generation);
      return detail;
    },
    async resumeWorkItem(id, revision, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('resume', { id, revision }, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.commitWorkCenterDetail(target, detail, generation);
      return detail;
    },
    async deleteWorkItem(id, revision, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const result = await this.workCenterRequest('delete', { id, revision }, target);
      this.removeWorkItemState(target, id);
      return result;
    },
    async postWorkItemMessage(id, text, targetRef, revision, attachments = [], agentId = null, fence = {}, quote = null) {
      if (!this.hydrateWorkCenterBrowserState()) {
        throw new Error('Work Center browser owner is unavailable; sign in again and retry');
      }
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const envelope = this.prepareWorkCenterMessageEnvelope({
        agentId: target,
        workItemId: id,
        target: targetRef,
        text,
        quote,
        attachments,
        revision,
        planRevision: fence.planRevision,
        ledgerRevision: fence.ledgerRevision,
        coordinatorRevision: fence.coordinatorRevision,
      });
      if (!envelope) throw new Error('Work Center browser owner changed; reopen Work Center and try again');
      const clientMessageId = envelope.clientMessageId;
      const current = this.workCenterDetailByAgent[target]?.id === id
        ? this.workCenterDetailByAgent[target] : null;
      const detail = await this.workCenterRequest('post_work_item_message', {
        id: envelope.workItemId,
        clientMessageId,
        text: envelope.text,
        target: envelope.target,
        revision: envelope.revision,
        planRevision: envelope.planRevision || Number(current?.planRevision) || 0,
        ledgerRevision: envelope.ledgerRevision || Number(current?.ledgerRevision) || 0,
        coordinatorRevision: Number.isInteger(Number(envelope.coordinatorRevision))
          ? Number(envelope.coordinatorRevision) : Number(current?.coordinatorRevision) || 0,
        ...(envelope.quote ? { quote: envelope.quote } : {}),
        attachments: envelope.attachments,
      }, target);
      if (envelope.target.kind === 'coordinator') {
        if (!detail?.accepted) throw new Error('Work Center Coordinator did not accept the message');
        this.confirmWorkCenterMessageEnvelope(target, id, clientMessageId);
        return detail;
      }
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.confirmWorkCenterMessageEnvelope(target, id, clientMessageId);
      return detail;
    },
    async sendWorkItemMessage(id, text, revision, attachments = [], agentId = null, fence = {}, quote = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const current = this.workCenterDetailByAgent[target]?.id === id
        ? this.workCenterDetailByAgent[target] : null;
      const accepted = await this.workCenterRequest('work_item_message', {
        id,
        text,
        revision,
        planRevision: Number.isInteger(Number(fence.planRevision))
          ? Number(fence.planRevision) : Number(current?.planRevision) || 0,
        ledgerRevision: Number.isInteger(Number(fence.ledgerRevision))
          ? Number(fence.ledgerRevision) : Number(current?.ledgerRevision) || 0,
        coordinatorRevision: Number.isInteger(Number(fence.coordinatorRevision))
          ? Number(fence.coordinatorRevision) : Number(current?.coordinatorRevision) || 0,
        ...(normalizeSessionMessageQuote(quote) ? { quote: normalizeSessionMessageQuote(quote) } : {}),
        attachments: Array.isArray(attachments) ? attachments : [],
      }, target);
      if (!accepted?.accepted) throw new Error('Work Center Coordinator did not accept the message');
      return accepted;
    },
    async retryWorkItemAction(id, actionId, revision, actionGeneration, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('retry_action', {
        id, actionId, revision, generation: actionGeneration,
      }, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.commitWorkCenterDetail(target, detail, generation);
      return detail;
    },
    async sendWorkItemActionInput(id, text, actionId, revision, actionGeneration, attachments = [], agentId = null, quote = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = Number(this._workCenterActionInputGenerationByAgent[target] || 0) + 1;
      this._workCenterActionInputGenerationByAgent = {
        ...this._workCenterActionInputGenerationByAgent,
        [target]: generation,
      };
      const safeQuote = normalizeSessionMessageQuote(quote);
      const detail = await this.workCenterRequest('action_input', {
        id, text, actionId, revision, generation: actionGeneration, attachments,
        ...(safeQuote ? { quote: safeQuote } : {}),
      }, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      const current = this.workCenterDetailByAgent[target];
      const currentAction = current?.actions?.find(action => action?.id === actionId);
      const requestStillCurrent = current?.id === id
        && Number(current.revision) === Number(revision)
        && currentAction
        && Number(currentAction.generation) === Number(actionGeneration);
      if (this._workCenterActionInputGenerationByAgent[target] === generation
        && requestStillCurrent
        && !isWorkItemDetailResponseStale(detail, current)) {
        this.workCenterDetailByAgent = { ...this.workCenterDetailByAgent, [target]: detail };
        return detail;
      }
      return current?.id === id ? current : detail;
    },
    async guideWorkItemAction(id, guidance, actionId, revision, actionGeneration, attachments = [], agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      const generation = this.beginWorkCenterDetailWrite(target);
      const detail = await this.workCenterRequest('guide', {
        id, guidance, actionId, revision, generation: actionGeneration, attachments,
      }, target);
      await this.listWorkItems(target, this._workCenterListFiltersByAgent[target] || {});
      this.commitWorkCenterDetail(target, detail, generation);
      return detail;
    },
    previewWorkItemAttachment(id, attachmentId, agentId = null) {
      const target = agentId || this.workCenterAgentId || this.currentAgent;
      return this.workCenterRequest('preview_attachment', { id, attachmentId }, target);
    },
    applyWorkCenterEvent(agentId, event) {
      if (!agentId || !event?.workItem) return;
      const summary = event.workItem;
      if (event.clientMessageId) {
        this.confirmWorkCenterMessageEnvelope(agentId, summary.id, event.clientMessageId);
        const pendingEntry = Object.entries(this.workCenterPending || {}).find(([, pending]) => (
          pending?.agentId === agentId && pending.clientMessageId === event.clientMessageId
        ));
        if (pendingEntry) {
          const [requestId, pending] = pendingEntry;
          clearTimeout(pending.timer);
          delete this.workCenterPending[requestId];
          pending.resolve(event.type === 'coordinator.turn_started'
            ? { accepted: true, turnId: null, receipt: true }
            : event.workItem);
        }
      }
      const current = this.workCenterItemsByAgent[agentId] || [];
      if (event.type === 'work_item.deleted') {
        this.removeWorkItemState(agentId, summary.id);
        return;
      }
      if (this.workItemDeleted(agentId, summary.id)) return;
      const filters = this._workCenterListFiltersByAgent[agentId] || {};
      const cachedSummary = this._workCenterListEventsByAgent[agentId]?.[summary.id]?.summary || null;
      const identityBase = current.some(item => item?.id === summary.id)
        ? current
        : (cachedSummary ? [cachedSummary] : []);
      const acceptedSummary = applyWorkItemSummary(identityBase, summary)
        .find(item => item?.id === summary.id) || summary;
      const eventGeneration = Number(this._workCenterListEventGenerationByAgent[agentId] || 0) + 1;
      this._workCenterListEventGenerationByAgent = {
        ...this._workCenterListEventGenerationByAgent, [agentId]: eventGeneration,
      };
      this._workCenterListEventsByAgent = {
        ...this._workCenterListEventsByAgent,
        [agentId]: {
          ...(this._workCenterListEventsByAgent[agentId] || {}),
          [summary.id]: {
            generation: eventGeneration,
            queryKey: this._workCenterListQueryByAgent[agentId] || null,
            summary: acceptedSummary,
          },
        },
      };
      const nextItems = this.applyWorkItemBoardSummary(current, acceptedSummary, filters);
      this.workCenterItemsByAgent = {
        ...this.workCenterItemsByAgent,
        [agentId]: nextItems,
      };
      const selected = this.workCenterDetailByAgent[agentId];
      if (selected?.id === summary.id) {
        const eventSummary = event.type === 'run.finished'
          && event.actionId
          && Array.isArray(summary.actionStats)
          && summary.actionStats.some(action => action?.id === event.actionId)
          ? { ...summary, eventActionId: event.actionId }
          : summary;
        const refreshIdentity = workItemDetailRefreshIdentity(selected, eventSummary);
        const coordinatorRevision = Number(summary.coordinatorRevision);
        const currentCoordinatorRevision = Number(selected.coordinatorRevision) || 0;
        const coordinatorRefresh = Number.isInteger(coordinatorRevision)
          && coordinatorRevision > currentCoordinatorRevision;
        const needsRefresh = workItemDetailNeedsRefresh(selected, eventSummary);
        this.workCenterDetailByAgent = {
          ...this.workCenterDetailByAgent,
          [agentId]: mergeWorkItemSummary(selected, summary),
        };
        if (needsRefresh) {
          this.refreshWorkItemDetailAfterActionChange(
            agentId,
            summary,
            coordinatorRefresh ? null : refreshIdentity,
          );
        }
      }
    },
    async refreshWorkItemDetailAfterActionChange(agentId, summary, refreshIdentity = null) {
      const summaryAction = refreshIdentity
        ? (Array.isArray(summary.actionStats) ? summary.actionStats : [])
            .find(action => action?.id === refreshIdentity.actionId)
        : ((Array.isArray(summary.actionStats) ? summary.actionStats : [])
            .find(action => action?.id === summary.currentActionId) || summary.currentAction);
      const expectedActionId = refreshIdentity?.actionId || summary.currentActionId || null;
      const summaryGeneration = Number(refreshIdentity?.generation ?? summaryAction?.generation);
      const expectedGeneration = Number.isInteger(summaryGeneration) && summaryGeneration > 0
        ? summaryGeneration
        : null;
      const coordinatorRevision = Number(summary.coordinatorRevision);
      const expectedCoordinatorRevision = !refreshIdentity
        && Number.isInteger(coordinatorRevision) && coordinatorRevision >= 0
        ? coordinatorRevision : null;
      const expectedAttempt = Number(refreshIdentity?.attempt);
      const refreshAttempt = Number.isInteger(expectedAttempt) && expectedAttempt >= 0
        ? expectedAttempt
        : null;
      const key = expectedCoordinatorRevision != null
        ? `${summary.id}:coordinator:${expectedCoordinatorRevision}`
        : `${summary.id}:${expectedActionId}${expectedGeneration == null ? '' : `:${expectedGeneration}`}${refreshAttempt == null ? '' : `:${refreshAttempt}`}`;
      if (this._workCenterDetailEventRefreshByAgent[agentId]?.key === key) return;
      const generation = this.beginWorkCenterDetailWrite(agentId);
      const refresh = { key, generation };
      this._workCenterDetailEventRefreshByAgent = {
        ...this._workCenterDetailEventRefreshByAgent,
        [agentId]: refresh,
      };
      if (refreshIdentity) {
        this.invalidateWorkItemActionMessages(
          agentId,
          summary.id,
          refreshIdentity.actionId,
          refreshIdentity.generation,
        );
      }
      const latestMessages = expectedActionId && expectedGeneration != null
        ? this.loadWorkItemActionMessages(
            summary.id,
            expectedActionId,
            expectedGeneration,
            null,
            agentId,
          ).catch(() => null)
        : null;
      try {
        const detail = await this.workCenterRequest('get', { id: summary.id }, agentId);
        const selected = this.workCenterDetailByAgent[agentId];
        const selectedAction = selected?.actions?.find(action => action?.id === expectedActionId);
        const detailAction = detail?.actions?.find(action => action?.id === expectedActionId);
        const selectedGenerationMatches = expectedGeneration == null
          || normalizeWorkCenterActionGeneration(selectedAction?.generation) === expectedGeneration;
        const detailGenerationMatches = expectedGeneration == null
          || normalizeWorkCenterActionGeneration(detailAction?.generation) >= expectedGeneration;
        const coordinatorRevisionMatches = expectedCoordinatorRevision == null
          || Number(detail?.coordinatorRevision) === expectedCoordinatorRevision;
        const actionIdentityMatches = expectedCoordinatorRevision != null
          || (selectedGenerationMatches
            && detailGenerationMatches
            && (summary.currentActionId == null
              ? detail?.currentActionId == null
              : selected?.currentActionId === summary.currentActionId
                && detail?.currentActionId === summary.currentActionId));
        if (selected?.id === summary.id
            && coordinatorRevisionMatches
            && actionIdentityMatches
            && this.commitWorkCenterDetail(agentId, detail, generation)
            && latestMessages) {
          await latestMessages;
        }
      } catch {
        // The next event or explicit selection retries; event handling remains non-fatal.
      } finally {
        if (this._workCenterDetailEventRefreshByAgent[agentId] === refresh) {
          const next = { ...this._workCenterDetailEventRefreshByAgent };
          delete next[agentId];
          this._workCenterDetailEventRefreshByAgent = next;
        }
      }
    },

    // =====================
    // Yeaft 页面
    // =====================
    cacheYeaftAgentStatus(agentId, status, { allowBootstrapCatalog = false } = {}) {
      if (!agentId || !status) return;
      const previous = this.yeaftStatusByAgent[agentId] || {};
      const previousRevision = Number(previous.catalogRevision) || 0;
      const incomingRevision = Number(status.catalogRevision) || 0;
      const previousEpoch = typeof previous.catalogEpoch === 'string' ? previous.catalogEpoch : '';
      const incomingEpoch = typeof status.catalogEpoch === 'string' ? status.catalogEpoch : '';
      const previousCatalogAt = Number(previous.catalogRefreshedAt) || 0;
      const incomingCatalogAt = Number(status.catalogRefreshedAt) || 0;
      const statusHasCatalog = Array.isArray(status.availableModels);
      const statusIsConfigCatalog = status.type === 'yeaft_status'
        && statusHasCatalog
        && (incomingRevision > 0 || incomingCatalogAt > 0);
      const retiredEpochs = Array.isArray(this._yeaftRetiredCatalogEpochsByAgent?.[agentId])
        ? this._yeaftRetiredCatalogEpochsByAgent[agentId]
        : [];
      const incomingEpochRetired = !!incomingEpoch && retiredEpochs.includes(incomingEpoch);
      const sameEpoch = !!incomingEpoch && incomingEpoch === previousEpoch;
      const sameVersion = incomingRevision > 0
        ? sameEpoch && incomingRevision === previousRevision
        : incomingCatalogAt > 0 && incomingCatalogAt === previousCatalogAt;
      const newerVersion = incomingRevision > 0
        ? (!!incomingEpoch && (incomingEpoch !== previousEpoch || incomingRevision > previousRevision))
        : previousRevision === 0 && incomingCatalogAt > previousCatalogAt;
      const sameDigest = incomingRevision > 0
        ? !!status.catalogDigest && !!previous.catalogDigest && status.catalogDigest === previous.catalogDigest
        : status.catalogDigest === previous.catalogDigest;
      const acceptConfigCatalog = statusIsConfigCatalog
        && !incomingEpochRetired
        && (newerVersion || (sameVersion && sameDigest));
      const acceptBootstrapCatalog = allowBootstrapCatalog
        && previousRevision === 0
        && previousCatalogAt === 0
        && !statusIsConfigCatalog
        && statusHasCatalog;
      const acceptedCatalog = acceptConfigCatalog || acceptBootstrapCatalog;
      const nextStatus = { ...status };
      if (!acceptedCatalog) {
        for (const field of YEAFT_CATALOG_STATUS_FIELDS) delete nextStatus[field];
      }
      const next = { ...previous, ...nextStatus };
      if (acceptedCatalog) {
        if (acceptConfigCatalog && previousEpoch && incomingEpoch && previousEpoch !== incomingEpoch) {
          const nextRetiredEpochs = [...retiredEpochs.filter(epoch => epoch !== previousEpoch), previousEpoch]
            .slice(-YEAFT_RETIRED_CATALOG_EPOCH_LIMIT);
          this._yeaftRetiredCatalogEpochsByAgent = {
            ...(this._yeaftRetiredCatalogEpochsByAgent || {}),
            [agentId]: nextRetiredEpochs,
          };
        }
        next.availableModels = status.availableModels;
        next.catalogRefreshedAt = acceptConfigCatalog ? incomingCatalogAt : null;
        next.catalogEpoch = acceptConfigCatalog ? incomingEpoch || null : null;
        next.catalogRevision = acceptConfigCatalog ? incomingRevision || null : null;
        next.catalogDigest = acceptConfigCatalog ? status.catalogDigest || null : null;
      }
      this.yeaftStatusByAgent = { ...this.yeaftStatusByAgent, [agentId]: next };
      if (this.currentAgent === agentId) this.applyCachedYeaftStatus(agentId);
    },
    applyCachedYeaftStatus(agentId = this.currentAgent) {
      const cached = agentId ? this.yeaftStatusByAgent[agentId] : null;
      if (!cached) return false;
      this.yeaftModel = cached.model || null;
      this.yeaftModelEffort = cached.modelEffort || null;
      this.yeaftAvailableModels = Array.isArray(cached.availableModels) ? cached.availableModels : [];
      this.yeaftModelsRefreshing = !!cached.refreshing;
      this.yeaftModelRefreshError = cached.refreshError || null;
      this.yeaftYeaftDir = cached.yeaftDir || null;
      this.yeaftStatus = {
        skills: cached.skills,
        mcpServers: cached.mcpServers,
        tools: cached.tools,
        multiVp: !!cached.multiVp,
      };
      return true;
    },
    activateYeaftAgentCatalog(targetAgentId, previousAgentId = this.currentAgent) {
      const cached = targetAgentId ? this.yeaftStatusByAgent[targetAgentId] : null;
      if (cached) this.applyCachedYeaftStatus(targetAgentId);
      if (Array.isArray(cached?.availableModels)) return true;
      this.yeaftModel = null;
      this.yeaftModelEffort = null;
      this.yeaftAvailableModels = [];
      if (!cached) this.yeaftStatus = null;
      this.yeaftModelsRefreshing = !!targetAgentId && !cached?.refreshError;
      this.yeaftModelRefreshError = cached?.refreshError || null;
      if (previousAgentId !== targetAgentId) this.yeaftYeaftDir = null;
      return false;
    },
    activateYeaftAgent(agentId, agentInfo = null) {
      if (!agentId) return false;
      const previousAgentId = this.currentAgent;
      this.currentAgent = agentId;
      if (agentInfo) this.currentAgentInfo = agentInfo;
      return this.activateYeaftAgentCatalog(agentId, previousAgentId);
    },
    resolveYeaftSessionAgentId(sessionId) {
      return resolveAgentIdForSession(this, sessionId);
    },
    requestYeaftSessionInventory() {
      // Legacy Servers do not echo requestId, so overlapping requests cannot be
      // separated safely. Reuse the current owner until its slice quiet-window
      // commits. After either a quiet commit or timeout, replace the socket before
      // another request: the old request may still deliver identity-less slices.
      if (this.yeaftSessionInventoryCompleteSupported === false
          && this.yeaftSessionHydrateRequestId) {
        return this.yeaftSessionHydrateRequestId;
      }
      if (this._yeaftSessionInventorySocketQuarantined) {
        this.manualReconnect();
        return null;
      }
      clearTimeout(this._legacyYeaftSessionHydrateTimer);
      this._legacyYeaftSessionHydrateTimer = null;
      const requestId = `session_inventory_${crypto.randomUUID()}`;
      this.yeaftSessionHydrateRequestId = requestId;
      this.yeaftSessionHydrateSlices = [];
      this._hasHandledAgentList = false;
      this._hasHandledYeaftSessionHydrate = false;
      this.yeaftSessionHydrateError = null;
      const knownConvIds = this.conversations.map(c => c.id).filter(Boolean);
      const sent = this.sendWsMessage({
        type: 'get_agents',
        requestId,
        conversationIds: knownConvIds.length > 0 ? knownConvIds : undefined,
      });
      if (!sent) {
        this.yeaftSessionHydrateRequestId = null;
        this.yeaftSessionHydrateSlices = [];
        this.yeaftSessionHydrateError = 'session_inventory_send_failed';
        return null;
      }
      setTimeout(() => {
        if (this.yeaftSessionHydrateRequestId !== requestId) return;
        this.yeaftSessionHydrateRequestId = null;
        this.yeaftSessionHydrateSlices = [];
        this.yeaftSessionHydrateError = 'session_inventory_timeout';
        if (this.yeaftSessionInventoryCompleteSupported !== true) {
          this._yeaftSessionInventorySocketQuarantined = true;
        }
      }, YEAFT_SESSION_INVENTORY_TIMEOUT_MS);
      return requestId;
    },
    beginYeaftHistoryLoad(options) {
      const request = beginYeaftHistoryLoad(this, options);
      if (!request) return null;
      const { agentId, sessionId } = options || {};
      setTimeout(() => {
        if (failYeaftHistoryLoad(this, {
          agentId,
          sessionId,
          requestId: request.requestId,
          error: 'history_load_timeout',
        })) {
          console.warn(`[Yeaft] history load timed out for ${agentId}/${sessionId}`);
        }
      }, YEAFT_HISTORY_LOAD_TIMEOUT_MS);
      return request;
    },
    finishYeaftHistoryLoad(msg, patch = {}, frame = 'chunk') {
      return finishYeaftHistoryLoad(this, msg, patch, frame);
    },
    isCurrentYeaftHistoryResponse(msg) {
      return isCurrentYeaftHistoryResponse(this, msg);
    },
    syncActiveYeaftHistoryLoad() {
      return syncActiveYeaftHistoryLoad(this);
    },
    enterYeaft(agentId = null, { deferBootstrap = false } = {}) {
      const previousAgentId = this.currentAgent;
      yeaftViewHelpers.beginYeaftTransition(this);
      // Capture the chat-side activeConversations snapshot BEFORE flipping
      // currentView. The transition helper is idempotent: if we're
      // already in Yeaft (e.g. switching agents, programmatic re-entry,
      // a redundant call), it will NOT overwrite the existing snapshot
      // with the yeaft-only array — which would otherwise cause
      // leaveYeaft to "restore" the yeaft conversationId back into Chat
      // and leak yeaft messages into the Chat view.
      //
      // The agent the Yeaft page operates on is `currentAgent` — the single
      // client/server-synced pointer. An explicit caller remains authoritative;
      // ordinary Chat → Yeaft entry must otherwise adopt the exact active
      // Session owner before falling back to the Chat Agent. Inventory restore
      // intentionally does not switch currentAgent while Chat is still visible.
      const activeSessionId = resolveActiveYeaftSessionId(this);
      const activeSessionAgentId = !agentId && activeSessionId
        ? resolveAgentIdForSession(this, activeSessionId)
        : null;
      let targetAgentId = agentId || activeSessionAgentId || this.currentAgent || null;
      if (!targetAgentId) {
        const online = this.agents.find(a => a.online);
        if (online) targetAgentId = online.id;
      }
      // Keep currentAgent / currentAgentInfo in sync with the Yeaft agent
      // selection. The sidebar header indicator and the entire Files /
      // Workbench subsystem key off `currentAgent` (e.g. file ops send
      // `agentId: store.currentAgent`). Without this sync they remained
      // stuck on whichever agent Chat had auto-selected first, so opening
      // Yeaft for the 2nd/3rd agent showed the wrong agent badge and
      // browsed the first agent's folder.
      //
      // `selectAgent` only kicks off the async agent_selected round-trip, so
      // we ALSO set `currentAgent` synchronously here: the rest of this method
      // and `requestYeaftSessionBootstrap` (called at the end) route on
      // `currentAgent`, and must see the new agent this turn rather than after
      // the round-trip lands. selectAgent runs first (while currentAgent is
      // still the old value) so its same-agent guard doesn't swallow the
      // select_agent frame; the sync assignment then mirrors what
      // handleAgentSelected will re-affirm.
      if (targetAgentId && this.currentAgent !== targetAgentId) {
        this.selectAgent(targetAgentId);
        this.currentAgent = targetAgentId;
        const info = this.agents.find(a => a.id === targetAgentId);
        if (info) this.currentAgentInfo = info;
      }
      const appliedCachedStatus = this.applyCachedYeaftStatus(targetAgentId);
      if (!appliedCachedStatus && previousAgentId && previousAgentId !== targetAgentId) {
        this.yeaftAvailableModels = [];
        this.yeaftStatus = null;
        this.yeaftModelsRefreshing = true;
        this.yeaftModelRefreshError = null;
      }
      // Create/select a per-agent local conversationId immediately so
      // MessageList has something to render. A/B agents run distinct Yeaft
      // bridges, so sharing one global placeholder lets their history frames
      // collide before session_ready has replayed.
      if (targetAgentId) {
        let agentConvId = this.yeaftConversationIdsByAgent?.[targetAgentId] || null;
        if (!agentConvId) {
          agentConvId = `yeaft-local-${targetAgentId}-${Date.now()}`;
          this.yeaftConversationIdsByAgent = {
            ...(this.yeaftConversationIdsByAgent || {}),
            [targetAgentId]: agentConvId,
          };
        }
        this.yeaftConversationId = agentConvId;
      } else if (!this.yeaftConversationId) {
        this.yeaftConversationId = `yeaft-local-${Date.now()}`;
      }
      if (!this.messagesMap[this.yeaftConversationId]) {
        this.messagesMap[this.yeaftConversationId] = [];
      }
      // Snapshot (only on the Chat → Yeaft edge) and swap activeConversations.
      // Reads `this.currentView` to decide; must run BEFORE the flip below.
      yeaftViewHelpers.applyEnterYeaftTransition(this);
      this.currentView = 'yeaft';
      yeaftViewHelpers.persistPreferredConversationView('yeaft');
      // task-fix-yeaft-load-more-empty: clear leaked Chat-mode pagination
      // flags. `hasMoreMessages` is set true by Chat's `db_messages_loaded`
      // / `sync_messages_result` handlers and would otherwise survive the
      // Chat → Yeaft transition, surfacing a "加载更多消息" hint that does
      // nothing in Yeaft (Yeaft history doesn't live in messageDb).
      this.hasMoreMessages = false;
      this.loadingMoreMessages = false;
      // Reset Yeaft pagination cursor on every entry. The agent will re-prime
      // these via `history_loaded` once the bootstrap replay completes.
      this.yeaftHasMoreHistory = false;
      this.yeaftLoadingMoreHistory = false;
      this.yeaftOldestLoadedSeq = null;

      // Always request a session_ready replay so model + status + session
      // snapshot are repopulated on every Yeaft entry. Backend's
      // handleYeaftLoadHistory is idempotent: the session_ready handler
      // either migrates the local convId (first time) or refreshes model /
      // status fields (re-entry). For the active session, also replay the
      // visible history unless that session has already completed a history
      // load in this UI lifecycle. A non-empty shared messagesMap is not
      // enough evidence: it may hold stale rows for `grp_fun` while newer
      // persisted rows were written during a previous page/session.
      // Entering Yeaft runs its own catch-up bootstrap below, so any pending
      // reconnect catch-up flag (possibly set while the user was in Chat view
      // during a drop) is subsumed — clear it so handleAgentList doesn't fire
      // a redundant second catch-up on the next routine agent_list.
      this._yeaftReconnectCatchUpPending = false;
      this.loadOpenedYeaftSessionsForConnectedAgents(null, { force: true });
      if (!deferBootstrap) {
        this.requestYeaftSessionBootstrap({ forceSessionReady: true, catchUpHistory: true, forceHistoryReplay: true });
      }
    },

    loadOpenedYeaftSessionsForConnectedAgents(agentIds = null, { force = false } = {}) {
      const ids = Array.isArray(agentIds)
        ? agentIds.filter(Boolean)
        : (Array.isArray(this.agents) ? this.agents.filter(a => a && a.online && a.id).map(a => a.id) : []);
      const uniqueIds = [...new Set(ids)];
      if (!this._yeaftOpenedSessionsLoadedAgents || typeof this._yeaftOpenedSessionsLoadedAgents !== 'object') {
        this._yeaftOpenedSessionsLoadedAgents = {};
      }
      const requested = [];
      for (const agentId of uniqueIds) {
        if (!force && this._yeaftOpenedSessionsLoadedAgents[agentId]) continue;
        this._yeaftOpenedSessionsLoadedAgents[agentId] = Date.now();
        requested.push(agentId);
        this.sessionCrudRequest('list', {}, { agentId }).catch((err) => {
          delete this._yeaftOpenedSessionsLoadedAgents[agentId];
          console.warn(`[Yeaft] failed to load opened sessions for agent ${agentId}:`, err?.message || err);
        });
      }
      return requested;
    },

    requestYeaftSessionBootstrap({ forceSessionReady = false, catchUpHistory = false, forceHistoryReplay = false } = {}) {
      if (!this.currentAgent) return;
      const activeSessionId = resolveActiveYeaftSessionId(this);
      const targetAgentId = activeSessionId
        ? resolveAgentIdForSession(this, activeSessionId)
        : this.currentAgent;
      const sessionKey = yeaftHistoryIdentityKey(targetAgentId, activeSessionId);
      const sessionState = activeSessionId
        ? this.yeaftSessionHistoryState[sessionKey]
        : null;
      const needSessionReady = forceSessionReady || !this.yeaftSessionReady || !this.yeaftModel || !this.yeaftStatus;
      const latestSeq = Number.isFinite(sessionState?.latestSeq) ? sessionState.latestSeq : null;
      const hasCachedSessionRows = !!activeSessionId
        && !!this.yeaftConversationId
        && Array.isArray(this.messagesMap?.[this.yeaftConversationId])
        && this.messagesMap[this.yeaftConversationId].some(row => row && (row.sessionId ?? row.groupId ?? null) === activeSessionId);
      const needHistoryReplay = !!activeSessionId
        && msgHelpers.shouldReplayYeaftSessionHistory({
          sessionState,
          hasCachedSessionRows,
          force: !!forceHistoryReplay,
        });
      const needHistoryCatchUp = !!activeSessionId
        && !needHistoryReplay
        && msgHelpers.shouldCatchUpLoadedYeaftSession(sessionState, catchUpHistory);
      if (!needSessionReady && !needHistoryReplay && !needHistoryCatchUp) return false;
      // Route session-scoped history through the single resolver (sessions
      // store → per-session cache → currentAgent), same as every other
      // session-scoped emitter. The old inline `cache || currentAgent` skipped
      // the authoritative sessionById lookup, so in the cold/cross-agent window
      // it could ship yeaft_load_history to an agent that doesn't own the
      // session — the exact misroute this refactor removes.
      const metaKey = `${targetAgentId}:${activeSessionId || '__none__'}`;
      const metadataOnly = needSessionReady && !needHistoryReplay && !needHistoryCatchUp;
      if (metadataOnly && this.yeaftBootstrapMetaLoadingKey === metaKey) return false;
      if (metadataOnly) this.yeaftBootstrapMetaLoadingKey = metaKey;
      let historyRequest = null;
      if (activeSessionId && needHistoryReplay) {
        historyRequest = this.beginYeaftHistoryLoad({
          agentId: targetAgentId,
          sessionId: activeSessionId,
          mode: 'recent',
          preserveLoaded: false,
        });
      } else if (activeSessionId && hasCachedSessionRows && !sessionState?.loaded) {
        this.yeaftSessionHistoryState = {
          ...this.yeaftSessionHistoryState,
          [sessionKey]: {
            ...(sessionState || {}),
            loaded: true,
            loading: false,
            hasMore: !!sessionState?.hasMore,
            oldestSeq: Number.isFinite(sessionState?.oldestSeq) ? sessionState.oldestSeq : null,
            count: sessionState?.count || 0,
            latestSeq,
          },
        };
        this.yeaftLoadingMoreHistory = false;
      } else if (activeSessionId && needHistoryCatchUp) {
        historyRequest = this.beginYeaftHistoryLoad({
          agentId: targetAgentId,
          sessionId: activeSessionId,
          mode: 'delta',
          preserveLoaded: true,
          latestSeq,
        });
      }
      const payload = {
        type: 'yeaft_load_history',
        agentId: targetAgentId,
        sessionId: activeSessionId,
        ...(historyRequest ? { requestId: historyRequest.requestId } : {}),
      };
      if (needHistoryCatchUp) payload.afterSeq = latestSeq;
      else payload.limit = needHistoryReplay ? YEAFT_RECENT_TURNS : 0;
      const perfTraceId = createPerfTraceId();
      payload.perfTraceId = perfTraceId;
      const historyMode = needHistoryCatchUp ? 'delta' : (needHistoryReplay ? 'recent' : 'metadata');
      if (activeSessionId) {
        this.yeaftHistoryPerfTraceBySession = {
          ...(this.yeaftHistoryPerfTraceBySession || {}),
          [sessionKey]: perfTraceId,
        };
      }
      recordPerfTrace(this, {
        traceId: perfTraceId,
        phase: 'history.request_send',
        agentId: targetAgentId,
        sessionId: activeSessionId,
        messageType: payload.type,
        bytes: JSON.stringify(payload).length,
        detail: {
          mode: historyMode,
          limit: payload.limit ?? null,
          afterSeq: payload.afterSeq ?? null,
          hasCachedSessionRows,
          needSessionReady,
        },
      });
      this.sendWsMessage(payload);
      return true;
    },
    leaveYeaft() {
      this.activateChatView({ persistPreference: true });
    },
    /**
     * 2026-05-13: ask the agent for the latest tool-call usage stats.
     * Round-trip: web → server → agent (handleYeaftFetchToolStats) →
     * web (`yeaft_tool_stats` case writes to this.yeaftToolStats).
     * Used by the YeaftDebugDrawer "Tool Stats" panel.
     */
    fetchYeaftToolStats() {
      if (!this.currentAgent) return;
      this.yeaftToolStatsLoading = true;
      this.sendWsMessage({
        type: 'yeaft_fetch_tool_stats',
        agentId: this.currentAgent,
      });
      // Guard against silent drops (agent down, relay loss). Without a
      // timeout the drawer spinner runs forever; surface the failure to
      // the user so they at least know to retry / reload.
      if (this._fetchYeaftToolStatsTimer) clearTimeout(this._fetchYeaftToolStatsTimer);
      this._fetchYeaftToolStatsTimer = setTimeout(() => {
        if (this.yeaftToolStatsLoading) {
          this.yeaftToolStatsLoading = false;
          this.yeaftToolStats = {
            ...(this.yeaftToolStats || { snapshot: {}, registered: [], unused: [] }),
            error: null,
            notice: 'Tool stats are unavailable right now. Try again after the agent reconnects.',
            fetchedAt: Date.now(),
          };
        }
        this._fetchYeaftToolStatsTimer = null;
      }, 10_000);
    },
    /**
     * Hydrate the Yeaft debug panel from the persistent file-backed trace.
     * The agent keeps request JSON under the Yeaft debug folder; before this
     * action existed the panel only displayed turns observed live via
     * `yeaft_output`, so everything before the panel was mounted was invisible.
     *
     * Round-trip: web → server → agent (handleYeaftFetchDebugHistory) →
     * web (`yeaft_debug_history` case in messageHandler merges into
     * `yeaftDebugLoops` / `yeaftDebugTurnsById` / `yeaftDebugTurnOrder`).
     */
    loadYeaftDebugHistory({ groupId, limit, dreamLimit, indexOnly = false, detailTurnId = null, search = undefined } = {}) {
      const targetAgentId = resolveAgentIdForSession(this, groupId);
      if (!targetAgentId) return;
      const searchPattern = typeof search === 'string' ? search.trim() : (this.yeaftDebugSearch || '').trim();
      const isDetailRequest = typeof detailTurnId === 'string' && detailTurnId;
      const maxListLimit = searchPattern && !isDetailRequest ? SEARCH_YEAFT_DEBUG_HISTORY_LIMIT : DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT;
      const rawLimit = Number.isFinite(limit) && limit > 0 ? limit : this.yeaftDebugHistoryLimit || maxListLimit;
      const requestedLimit = Math.max(1, Math.min(maxListLimit, rawLimit));
      const requestKind = isDetailRequest ? 'detail' : 'list';
      const requestId = `dbg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const requestKey = JSON.stringify({
        agentId: targetAgentId,
        groupId: groupId || null,
        limit: requestedLimit,
        dreamLimit: Number.isFinite(dreamLimit) && dreamLimit > 0 ? dreamLimit : 5,
        indexOnly: !!indexOnly,
        detailTurnId: detailTurnId || null,
        search: isDetailRequest ? '' : searchPattern,
      });
      if (this._yeaftDebugHistoryInFlightKey === requestKey) return;
      this._yeaftDebugHistoryInFlightKey = requestKey;
      if (isDetailRequest) this._yeaftDebugHistoryLatestDetailRequestId = requestId;
      else this._yeaftDebugHistoryLatestListRequestId = requestId;
      this.yeaftDebugHistoryLimit = requestedLimit;
      this.yeaftDebugHistoryLoading = true;
      this.yeaftDebugHistoryError = null;
      this.yeaftDebugHistoryProjection = null;
      const payload = {
        type: 'yeaft_fetch_debug_history',
        agentId: targetAgentId,
        requestId,
        requestKind,
        limit: requestedLimit,
        dreamLimit: Number.isFinite(dreamLimit) && dreamLimit > 0 ? dreamLimit : 5,
      };
      if (indexOnly) payload.indexOnly = true;
      if (typeof detailTurnId === 'string' && detailTurnId) payload.detailTurnId = detailTurnId;
      else if (searchPattern) payload.search = searchPattern;
      if (typeof groupId === 'string' && groupId) payload.sessionId = groupId;
      this.sendWsMessage(payload);
      if (this._fetchYeaftDebugHistoryTimer) clearTimeout(this._fetchYeaftDebugHistoryTimer);
      // Detail replies may be absent because the Agent is offline, the relay was
      // interrupted, or the transport rejected an oversized payload. Keep the
      // store error machine-readable so the panel can localize an accurate,
      // retryable timeout instead of incorrectly blaming reconnect alone.
      this._fetchYeaftDebugHistoryTimer = setTimeout(() => {
        if (this.yeaftDebugHistoryLoading) {
          this.yeaftDebugHistoryLoading = false;
          this.yeaftDebugHistoryError = 'debug_history_timeout';
          if (this.yeaftDebugPanel?.status === 'loading') {
            this.yeaftDebugPanel = {
              ...this.yeaftDebugPanel,
              status: 'error',
              error: this.yeaftDebugHistoryError,
            };
          }
        }
        this._yeaftDebugHistoryInFlightKey = null;
        this._fetchYeaftDebugHistoryTimer = null;
      }, 10_000);
    },

    /**
     * Turn-level debug entry (action in an AI turn footer). Opens the debug
     * panel and issues a precise detail fetch for exactly this turn — the
     * panel no longer boots into a history browser. The requestId on the
     * panel plus messageHandler's `_yeaftDebugHistoryLatestDetailRequestId`
     * guard guarantee a stale response can never overwrite a newer panel.
     *
     * @param {{ sessionId?: string|null, turnId: string }} params
     */
    openYeaftTurnDebug({ sessionId = null, turnId = null } = {}) {
      const targetAgentId = resolveAgentIdForSession(this, sessionId);
      if (!targetAgentId) return;
      this.workbenchExpanded = false;
      this.workbenchMaximized = false;
      const requestId = `dbgpanel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      // Turn-scoped entries flip to loading until the detail response arrives.
      const status = turnId ? 'loading' : 'idle';
      this.yeaftDebugPanel = {
        open: true,
        status,
        requestId,
        agentId: targetAgentId,
        sessionId: sessionId || null,
        turnId: turnId || null,
        error: null,
      };
      // Only a concrete finished Turn issues a detail fetch.
      if (!turnId) return;
      // Detail fetches carry the full request for one turn; the bounded
      // list limit does not apply (agent returns the complete turn).
      this.loadYeaftDebugHistory({
        groupId: sessionId || undefined,
        limit: 1,
        dreamLimit: 5,
        detailTurnId: turnId,
      });
    },

    /**
     * Close the turn-level debug panel and release the single-turn detail
     * payload so large raw request bodies do not stay resident in the
     * browser after the panel is dismissed.
     */
    closeYeaftDebugPanel() {
      const panel = this.yeaftDebugPanel || {};
      const turnId = panel.turnId || null;
      this.yeaftDebugPanel = {
        open: false,
        status: 'idle',
        requestId: null,
        agentId: null,
        sessionId: null,
        turnId: null,
        error: null,
      };
      if (turnId && this.yeaftDebugTurnsById && this.yeaftDebugTurnsById[turnId]) {
        const nextTurnsById = { ...this.yeaftDebugTurnsById };
        delete nextTurnsById[turnId];
        this.yeaftDebugTurnsById = nextTurnsById;
        this.yeaftDebugTurnOrder = (this.yeaftDebugTurnOrder || []).filter(id => id !== turnId);
        this.yeaftDebugLoops = (this.yeaftDebugLoops || []).filter(loop => !loop || loop.turnId !== turnId);
      }
    },
    /**
     * Resolve the agent that owns a Yeaft session. Public wrapper over the
     * module-private resolver so components / sibling stores (vp.js) can route
     * session-scoped frames by the session's owning agent instead of a
     * page-level pointer. Falls back to `currentAgent` when no session id is
     * given or the session's agent is not yet known.
     */
    agentIdForSession(sessionId) {
      return resolveAgentIdForSession(this, sessionId);
    },
    /**
     * Send a group-scoped Yeaft chat message. Routes through the agent-side
     * GroupCoordinator which fans out to the target VP(s) or falls back to
     * the group's defaultVpId. This is the SOLE Yeaft send path —
     * `sendYeaftChat` (legacy 1:1) was removed; callers without a real
     * groupId should pass `'grp_default'`.
     *
     * @param {{groupId:string, text:string, mentions?:string[],
     *           attachments?:Array<{fileId:string,name:string,preview?:string,
     *                               isImage?:boolean,mimeType?:string}>,
     *           quote?:object}} payload
     */
    sendYeaftSessionMessage({ groupId, text, mentions, attachments, quote }) {
      // Route by the session's owning agent, not a page-level pointer. A
      // cross-agent click or a late session_ready replay used to leave the
      // old `yeaftAgentId` pointing at a different agent, so the send hit an
      // agent that has no such session on disk → "Session not found".
      const targetAgentId = resolveAgentIdForSession(this, groupId);
      if (!groupId || !targetAgentId) return;
      const safeAttachments = Array.isArray(attachments)
        ? attachments.filter((a) => a && a.fileId)
        : [];
      const safeQuote = normalizeSessionMessageQuote(quote);
      // PR #721: image-only send guard. The previous early-return on
      // `!text?.trim()` silently dropped sends where the user attached
      // a file with no text. When attachments are present we synthesize
      // a placeholder so the agent path runs end-to-end; the LLM still
      // sees the image content blocks via `_promptParts`.
      const hasAttachments = safeAttachments.length > 0;
      if (!text?.trim() && !hasAttachments) return;
      const effectiveText = text?.trim() ? text : '(attached files)';
      const clientMessageId = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const perfTraceId = createPerfTraceId();
      this.yeaftPerfTraceByMessageId = {
        ...(this.yeaftPerfTraceByMessageId || {}),
        [clientMessageId]: perfTraceId,
      };
      recordPerfTrace(this, {
        traceId: perfTraceId,
        phase: 'send.prepare',
        agentId: targetAgentId,
        sessionId: groupId,
        turnId: clientMessageId,
        messageType: 'yeaft_session_send',
        detail: {
          mentionCount: Array.isArray(mentions) ? mentions.length : 0,
          attachmentCount: safeAttachments.length,
          quoted: !!safeQuote,
        },
      });
      const activeYeaftConvId = resolveYeaftConversationIdForSession(this, groupId);
      if (activeYeaftConvId) {
        const localMsg = {
          id: clientMessageId,
          messageId: clientMessageId,
          clientMessageId,
          stableKey: yeaftOptimisticMessageIdentity(targetAgentId, groupId, clientMessageId),
          uiKey: yeaftOptimisticMessageIdentity(targetAgentId, groupId, clientMessageId),
          type: 'user',
          content: effectiveText,
          sessionId: groupId,
          // Use the client message id as the optimistic local turn id so
          // the row has a stable message-block key until server frames arrive.
          turnId: clientMessageId,
          ...(safeQuote ? { quote: safeQuote } : {}),
        };
        if (safeAttachments.length > 0) {
          // Local-render shape mirrors what `MessageItem` already
          // expects for Chat-mode user messages (preview thumbnail +
          // attachments badge). We deliberately KEEP the `preview`
          // data-URL on the local copy only — the WS frame strips it
          // because the server already has the file bytes via fileId.
          localMsg.attachments = safeAttachments.map((a) => ({
            fileId: a.fileId,
            name: a.name,
            preview: a.preview,
            isImage: !!a.isImage,
            mimeType: a.mimeType || '',
          }));
        }
        conversationRepositoryFor(this).upsertOverlay({
          conversationId: activeYeaftConvId,
          agentId: targetAgentId,
          sessionId: groupId,
          row: localMsg,
        });
        this.processingConversations[activeYeaftConvId] = true;
        if (groupId) {
          const processingKey = yeaftSessionIdentityKey(targetAgentId, groupId);
          this.yeaftProcessingSessions = {
            ...this.yeaftProcessingSessions,
            ...(processingKey ? { [processingKey]: true } : {}),
          };
        }
        this._turnCompletedConvs?.delete(activeYeaftConvId);
        if (this._closedAt?.[activeYeaftConvId]) {
          delete this._closedAt[activeYeaftConvId];
        }
        this.getOrCreateExecutionStatus(activeYeaftConvId);
        watchdogHelpers.startYeaftWatchdog(this, activeYeaftConvId);
      }
      const wsMsg = {
        type: 'yeaft_session_send',
        agentId: targetAgentId,
        id: clientMessageId,
        sessionId: groupId,
        text: effectiveText,
        mentions: Array.isArray(mentions) ? mentions : [],
        perfTraceId,
        ...(safeQuote ? { quote: safeQuote } : {}),
      };
      if (safeAttachments.length > 0) {
        // Wire-side: only the fields the server resolver needs. The
        // server (`client-conversation.js` yeaft_* relay) consumes
        // `attachments[].fileId` against pendingFiles and forwards
        // `files: [{name,mimeType,data:base64,isImage}]` to the agent.
        wsMsg.attachments = safeAttachments.map((a) => ({
          fileId: a.fileId,
          isImage: !!a.isImage,
        }));
      }
      recordPerfTrace(this, {
        traceId: perfTraceId,
        phase: 'send.websocket_send',
        agentId: targetAgentId,
        sessionId: groupId,
        turnId: clientMessageId,
        messageType: wsMsg.type,
        bytes: JSON.stringify(wsMsg).length,
      });
      this.sendWsMessage(wsMsg);
    },

    cancelYeaftTask({ agentId = null, sessionId, taskId }) {
      const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      const targetTaskId = typeof taskId === 'string' ? taskId.trim() : '';
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId, agentId);
      if (!targetAgentId || !targetSessionId || !targetTaskId) return false;
      this.yeaftStoppingTasksById = {
        ...this.yeaftStoppingTasksById,
        [taskStopKey(targetAgentId, targetSessionId, targetTaskId)]: true,
      };
      this.sendWsMessage({
        type: 'yeaft_task_cancel',
        agentId: targetAgentId,
        sessionId: targetSessionId,
        taskId: targetTaskId,
        clientRequestId: `task_cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
      return true;
    },

    continueYeaftHistoryDelta(sessionId, agentId = null, afterSeq = null) {
      const targetSessionId = sessionId || null;
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId, agentId);
      if (!targetAgentId || !targetSessionId || !Number.isFinite(afterSeq)) return false;
      const sessionKey = yeaftHistoryIdentityKey(targetAgentId, targetSessionId);
      const current = this.yeaftSessionHistoryState?.[sessionKey] || null;
      if (current?.loading) return false;
      const historyRequest = this.beginYeaftHistoryLoad({
        agentId: targetAgentId,
        sessionId: targetSessionId,
        mode: 'delta',
        preserveLoaded: true,
        latestSeq: afterSeq,
      });
      if (!historyRequest) return false;
      this.yeaftSessionHistoryState = {
        ...this.yeaftSessionHistoryState,
        [sessionKey]: {
          ...this.yeaftSessionHistoryState[sessionKey],
          syncingAfterSeq: afterSeq,
        },
      };
      const payload = {
        type: 'yeaft_load_history',
        agentId: targetAgentId,
        sessionId: targetSessionId,
        requestId: historyRequest.requestId,
        afterSeq,
        maxRows: YEAFT_HISTORY_DELTA_ROWS,
        maxBytes: YEAFT_HISTORY_DELTA_BYTES,
        ...(typeof current?.streamId === 'string' ? { streamId: current.streamId } : {}),
        ...(Number.isFinite(current?.revision) ? { revision: current.revision } : {}),
      };
      if (!this.sendWsMessage(payload)) {
        failYeaftHistoryLoad(this, {
          agentId: targetAgentId,
          sessionId: targetSessionId,
          requestId: historyRequest.requestId,
          error: 'history_load_send_failed',
        });
        return false;
      }
      return true;
    },

    clearYeaftHistoryMemory({
      agentId = null,
      sessionId = null,
      preserveLiveRows = false,
      preserveSessionOwner = false,
    } = {}) {
      const targetAgentId = agentId || null;
      const targetSessionId = sessionId || null;
      const sessionKey = targetAgentId && targetSessionId
        ? yeaftHistoryIdentityKey(targetAgentId, targetSessionId)
        : null;
      const remainingPendingWindows = {};
      for (const [pendingKey, pending] of Object.entries(this._yeaftHistoryWindowPendingByKey || {})) {
        const matches = !sessionKey
          || (pending?.agentId === targetAgentId && pending?.sessionId === targetSessionId);
        if (!matches) {
          remainingPendingWindows[pendingKey] = pending;
          continue;
        }
        clearTimeout(pending?.timeout);
        pending?.resolve?.(false);
      }
      this._yeaftHistoryWindowPendingByKey = remainingPendingWindows;
      const remainingPrefetches = {};
      for (const [prefetchKey, pending] of Object.entries(this._yeaftHistoryPrefetchBySession || {})) {
        if (sessionKey && prefetchKey !== sessionKey) {
          remainingPrefetches[prefetchKey] = pending;
          continue;
        }
        pending.cancelled = true;
        if (pending.idle && typeof globalThis.cancelIdleCallback === 'function') {
          globalThis.cancelIdleCallback(pending.handle);
        } else {
          clearTimeout(pending.handle);
        }
      }
      this._yeaftHistoryPrefetchBySession = remainingPrefetches;
      const remainingResultRefreshes = {};
      for (const [requestId, refresh] of Object.entries(this._yeaftHistoryResultRefreshByRequestId || {})) {
        const matches = !sessionKey
          || (refresh?.agentId === targetAgentId && refresh?.sessionId === targetSessionId);
        if (!matches) {
          remainingResultRefreshes[requestId] = refresh;
          continue;
        }
        clearTimeout(refresh?.timeout);
        refresh?.resolve?.(null);
      }
      this._yeaftHistoryResultRefreshByRequestId = remainingResultRefreshes;

      const scopedConversationId = targetAgentId
        ? this.yeaftConversationIdsByAgent?.[targetAgentId] || null
        : null;
      const conversationIds = sessionKey
        ? new Set([scopedConversationId].filter(Boolean))
        : new Set(Object.values(this.yeaftConversationIdsByAgent || {}).filter(Boolean));
      if (!sessionKey && this.yeaftConversationId) conversationIds.add(this.yeaftConversationId);
      const nextMessagesMap = { ...(this.messagesMap || {}) };
      for (const conversationId of conversationIds) {
        if (!Array.isArray(nextMessagesMap[conversationId])) continue;
        nextMessagesMap[conversationId] = sessionKey
          ? nextMessagesMap[conversationId].filter(row => {
              if ((row?.sessionId ?? row?.groupId ?? null) !== targetSessionId) return true;
              return preserveLiveRows && !isDurableYeaftHistoryRow(row);
            })
          : [];
      }
      this.messagesMap = nextMessagesMap;

      const clearMapKey = (source) => {
        if (!sessionKey) return {};
        const { [sessionKey]: _removed, ...remaining } = source || {};
        return remaining;
      };
      this.yeaftSessionHistoryState = clearMapKey(this.yeaftSessionHistoryState);
      this.yeaftHistoryCacheState = clearMapKey(this.yeaftHistoryCacheState);
      this.yeaftMessageWindowState = clearMapKey(this.yeaftMessageWindowState);
      this.yeaftHistoryFocusWindowBySession = clearMapKey(this.yeaftHistoryFocusWindowBySession);
      this.yeaftHistoryOutlineBySession = clearMapKey(this.yeaftHistoryOutlineBySession);
      if (sessionKey) {
        const outlineTimeout = this._yeaftHistoryOutlineTimeouts?.[sessionKey];
        if (outlineTimeout) clearTimeout(outlineTimeout);
        this._yeaftHistoryOutlineTimeouts = clearMapKey(this._yeaftHistoryOutlineTimeouts);
      } else {
        for (const timeout of Object.values(this._yeaftHistoryOutlineTimeouts || {})) {
          if (timeout) clearTimeout(timeout);
        }
        this._yeaftHistoryOutlineTimeouts = {};
      }
      const searchMatches = !sessionKey || (
        this.yeaftHistorySearchState?.agentId === targetAgentId
        && this.yeaftHistorySearchState?.sessionId === targetSessionId
      );
      if (searchMatches) {
        if (this._yeaftHistorySearchTimeout) clearTimeout(this._yeaftHistorySearchTimeout);
        this._yeaftHistorySearchTimeout = null;
        this.yeaftHistorySearchState = {
          requestId: null,
          agentId: null,
          sessionId: null,
          query: '',
          senderKey: '',
          loading: false,
          results: [],
          hasMore: false,
          nextBeforeSeq: null,
          nextCursor: null,
          error: null,
        };
      }
      this._yeaftHistoryRevealLeases = sessionKey
        ? Object.fromEntries(Object.entries(this._yeaftHistoryRevealLeases || {})
          .filter(([, lease]) => lease?.sessionKey !== sessionKey))
        : {};
      if (!sessionKey) {
        this.yeaftHasMoreHistory = false;
        this.yeaftLoadingMoreHistory = false;
        this.yeaftOldestLoadedSeq = null;
      }
      if (!preserveSessionOwner && targetSessionId
          && this.yeaftSessionAgentById?.[targetSessionId] === targetAgentId) {
        const { [targetSessionId]: _removed, ...remaining } = this.yeaftSessionAgentById;
        this.yeaftSessionAgentById = remaining;
      }
      this.syncActiveYeaftHistoryLoad();
    },

    getYeaftMessageWindowKey(sessionId = null, agentId = null) {
      const targetSessionId = sessionId || this.yeaftActiveSessionFilter || null;
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId, agentId);
      return yeaftHistoryIdentityKey(targetAgentId, targetSessionId);
    },

    showLatestYeaftMessageWindow(sessionId = null, agentId = null) {
      const sessionKey = this.getYeaftMessageWindowKey(sessionId, agentId);
      if (!sessionKey || !this.yeaftHistoryFocusWindowBySession?.[sessionKey]) return false;
      const { [sessionKey]: _focused, ...remaining } = this.yeaftHistoryFocusWindowBySession;
      this.yeaftHistoryFocusWindowBySession = remaining;
      return true;
    },

    pruneYeaftMessageWindow(sessionId = null, agentId = null) {
      if (this.currentView !== 'yeaft') return;
      const sessionKey = this.getYeaftMessageWindowKey(sessionId, agentId);
      const revealProtected = Object.values(this._yeaftHistoryRevealLeases || {})
        .some(lease => lease?.sessionKey === sessionKey);
      if (revealProtected) return;
      this.yeaftMessageWindowState = {
        ...this.yeaftMessageWindowState,
        [sessionKey]: { visibleTurns: getDefaultYeaftVisibleTurns() },
      };
    },

    expandYeaftMessageWindow(sessionId = null, turns = getYeaftWindowLoadStepTurns(), agentId = null) {
      if (this.currentView !== 'yeaft') return;
      const sessionKey = this.getYeaftMessageWindowKey(sessionId, agentId);
      const current = this.yeaftMessageWindowState[sessionKey]?.visibleTurns
        || getDefaultYeaftVisibleTurns();
      const next = current + Math.max(1, Number.isFinite(turns) ? Math.floor(turns) : getYeaftWindowLoadStepTurns());
      this.yeaftMessageWindowState = {
        ...this.yeaftMessageWindowState,
        [sessionKey]: { visibleTurns: next },
      };
    },

    isYeaftMessageCached(sessionId, messageId, conversationId = null, agentId = null) {
      const targetSessionId = sessionId || this.yeaftActiveSessionFilter || null;
      const targetConversationId = conversationId
        || resolveYeaftConversationIdForSession(this, targetSessionId, agentId);
      if (!targetConversationId || !messageId) return false;
      return (this.messagesMap[targetConversationId] || []).some(message => (
        (!targetSessionId || (message?.sessionId ?? message?.groupId ?? null) === targetSessionId)
        && ((message?.id || message?.messageId) === messageId || message?.persistedMessageId === messageId)
      ));
    },

    revealYeaftMessage(sessionId, messageId, conversationId = null, agentId = null) {
      const targetSessionId = sessionId || this.yeaftActiveSessionFilter || null;
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId, agentId);
      const targetConversationId = conversationId
        || resolveYeaftConversationIdForSession(this, targetSessionId, targetAgentId);
      if (!targetConversationId || !messageId) return false;
      const scoped = (this.messagesMap[targetConversationId] || []).filter((message) => {
        if (message?._historyWindowPrefetched === true) return false;
        if (!targetSessionId) return true;
        return (message?.sessionId ?? message?.groupId ?? null) === targetSessionId;
      });
      const targetIndex = scoped.findIndex(message => (
        (message?.id || message?.messageId) === messageId
        || message?.persistedMessageId === messageId
      ));
      let resolvedTargetIndex = targetIndex;
      if (resolvedTargetIndex < 0) {
        const prefetched = (this.messagesMap[targetConversationId] || []).find(message => (
          message?._historyWindowPrefetched === true
          && (message?.sessionId ?? message?.groupId ?? null) === targetSessionId
          && ((message?.id || message?.messageId) === messageId || message?.persistedMessageId === messageId)
        ));
        if (!prefetched) return false;
        prefetched._historyWindowPrefetched = false;
        scoped.push(prefetched);
        scoped.sort((left, right) => {
          const leftSeq = Number.isFinite(left?.seq) ? left.seq : null;
          const rightSeq = Number.isFinite(right?.seq) ? right.seq : null;
          if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) return leftSeq - rightSeq;
          if (leftSeq !== null && rightSeq === null) return -1;
          if (leftSeq === null && rightSeq !== null) return 1;
          return (left?.timestamp || 0) - (right?.timestamp || 0);
        });
        resolvedTargetIndex = scoped.indexOf(prefetched);
      }
      const target = scoped[resolvedTargetIndex];
      const windowKey = target?._historyWindowKey || null;
      const sessionKey = this.getYeaftMessageWindowKey(targetSessionId, targetAgentId);
      if (windowKey) {
        const focusedRows = (this.messagesMap[targetConversationId] || []).filter(message => (
          (message?.sessionId ?? message?.groupId ?? null) === targetSessionId
          && message?._historyWindowKey === windowKey
        ));
        const spans = buildYeaftMessageTurnSpans(focusedRows);
        if (spans.length === 0) return false;
        this.yeaftHistoryFocusWindowBySession = {
          ...(this.yeaftHistoryFocusWindowBySession || {}),
          [sessionKey]: { windowKey, messageId, conversationId: targetConversationId },
        };
        this.yeaftMessageWindowState = {
          ...this.yeaftMessageWindowState,
          [sessionKey]: { visibleTurns: getDefaultYeaftVisibleTurns() },
        };
        return true;
      }

      // Compatibility for already-resident contiguous history and synthetic
      // tool-only rows that predate explicit history-window metadata.
      const spans = buildYeaftMessageTurnSpans(scoped);
      const targetSpan = spans.findIndex(span => resolvedTargetIndex >= span.start && resolvedTargetIndex < span.end);
      if (targetSpan < 0) return false;
      const visibleTurns = Math.max(getDefaultYeaftVisibleTurns(), spans.length - targetSpan);
      this.yeaftMessageWindowState = {
        ...this.yeaftMessageWindowState,
        [sessionKey]: { visibleTurns },
      };
      return true;
    },

    getYeaftHistoryOutlineState(sessionId = null, agentId = null) {
      const targetSessionId = sessionId || this.yeaftActiveSessionFilter || null;
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId, agentId);
      const key = yeaftHistoryIdentityKey(targetAgentId, targetSessionId);
      const base = this.yeaftHistoryOutlineBySession[key] || {
        requestId: null,
        agentId: targetAgentId,
        sessionId: targetSessionId,
        loading: false,
        results: [],
        hasMore: false,
        nextBeforeSeq: null,
        nextCursor: null,
        totalCount: null,
        loaded: false,
        retryAttempt: 0,
        error: null,
      };
      const conversationId = resolveYeaftConversationIdForSession(
        this,
        targetSessionId,
        targetAgentId,
      );
      const liveRows = conversationId ? (this.messagesMap[conversationId] || []) : [];
      const byId = new Map((base.results || []).map(result => [outlineResultIdentity(result), result]));
      let liveOnlyCount = 0;
      for (const row of liveRows) {
        if ((row?.sessionId ?? row?.groupId ?? null) !== targetSessionId) continue;
        const messageId = row.messageId || row.id;
        if (!messageId) continue;
        const optimisticUser = row.type === 'user'
          && !!row.clientMessageId
          && messageId === row.clientMessageId;
        const inFlightAssistant = row.type === 'assistant' && row.isStreaming === true;
        if (!optimisticUser && !inFlightAssistant) continue;
        const role = row.type;
        const turnId = row.turnId || row.threadId || messageId;
        const speakerVpId = row.speakerVpId || row.vpId || null;
        const identity = outlineResultIdentity({
          role,
          messageId,
          clientMessageId: row.clientMessageId,
          turnId,
          speakerVpId,
        });
        const existing = byId.get(identity);
        const raw = typeof row.content === 'string' ? row.content : '';
        const text = raw.replace(/\s+/g, ' ').trim();
        byId.set(identity, {
          ...existing,
          agentId: targetAgentId,
          sessionId: targetSessionId,
          messageId: Number.isFinite(existing?.seq) ? existing.messageId : messageId,
          ...(row.clientMessageId ? { clientMessageId: row.clientMessageId } : {}),
          turnId,
          role,
          speakerVpId: speakerVpId || existing?.speakerVpId || null,
          timestamp: row.timestamp || row.ts || existing?.timestamp || null,
          snippet: text.length > 180 ? `${text.slice(0, 180).trimEnd()}…` : (text || existing?.snippet || ''),
        });
        if (!existing) liveOnlyCount += 1;
      }
      const asTime = value => {
        const parsed = typeof value === 'number' ? value : Date.parse(value || '');
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const results = Array.from(byId.values()).sort((a, b) => {
        if (Number.isFinite(a.seq) && Number.isFinite(b.seq)) return a.seq - b.seq;
        return asTime(a.timestamp) - asTime(b.timestamp);
      });
      return {
        ...base,
        results,
        totalCount: Number.isFinite(base.totalCount) ? base.totalCount + liveOnlyCount : base.totalCount,
      };
    },

    promoteYeaftHistoryOutlineRow(row, agentId = null) {
      const sessionId = row?.sessionId ?? row?.groupId ?? null;
      const key = yeaftHistoryIdentityKey(agentId, sessionId);
      const state = this.yeaftHistoryOutlineBySession[key];
      if (!sessionId || !agentId || !state?.loaded || state.loading) return false;
      const role = row?.type;
      if (role !== 'user' && role !== 'assistant') return false;
      const messageId = row.dbMessageId || row.messageId || row.id || null;
      const seq = parsePersistedMessageSeq(messageId);
      if (!messageId || !Number.isFinite(seq)) return false;
      const turnId = row.turnId || row.threadId || messageId;
      const speakerVpId = row.speakerVpId || row.vpId || null;
      const raw = typeof row.content === 'string' ? row.content : '';
      const text = raw.replace(/\s+/g, ' ').trim();
      const identity = outlineResultIdentity({
        role,
        messageId,
        clientMessageId: row.clientMessageId,
        turnId,
        speakerVpId,
      });
      const byId = new Map((state.results || []).map(result => [outlineResultIdentity(result), result]));
      const existing = byId.get(identity);
      byId.set(identity, {
        ...existing,
        agentId,
        sessionId,
        messageId,
        ...(row.clientMessageId ? { clientMessageId: row.clientMessageId } : {}),
        turnId,
        seq,
        role,
        speakerVpId,
        timestamp: row.timestamp || row.ts || existing?.timestamp || null,
        snippet: text.length > 180 ? `${text.slice(0, 180).trimEnd()}…` : (text || existing?.snippet || ''),
      });
      const limit = 50;
      const ordered = Array.from(byId.values()).sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const overflowed = ordered.length > limit;
      const results = ordered.slice(-limit);
      this.yeaftHistoryOutlineBySession = {
        ...this.yeaftHistoryOutlineBySession,
        [key]: {
          ...state,
          results,
          hasMore: state.hasMore || overflowed,
          nextBeforeSeq: overflowed && Number.isFinite(results[0]?.seq)
            ? results[0].seq
            : state.nextBeforeSeq,
          totalCount: Number.isFinite(state.totalCount) && !existing ? state.totalCount + 1 : state.totalCount,
        },
      };
      return true;
    },

    promoteCompletedYeaftHistoryOutline(conversationId, turnId = null, agentId = null) {
      const rows = this.messagesMap[conversationId] || [];
      let anchor = null;
      const textParts = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row?.type === 'user') break;
        if (turnId && row?.turnId && row.turnId !== turnId) continue;
        if (row?.type !== 'assistant') continue;
        const text = typeof row.content === 'string' ? row.content.replace(/\s+/g, ' ').trim() : '';
        if (!anchor) anchor = row;
        else if (!String(anchor.content || '').trim() && text) anchor = row;
        if (text) textParts.unshift(text);
      }
      if (!anchor) return false;
      return this.promoteYeaftHistoryOutlineRow(
        { ...anchor, content: textParts.join(' ') },
        agentId,
      );
    },

    invalidateYeaftHistoryOutline(sessionId, agentId = null) {
      const key = yeaftHistoryIdentityKey(agentId, sessionId);
      const state = this.yeaftHistoryOutlineBySession[key];
      if (!sessionId || !agentId || !state) return false;
      if (state.loading) {
        this.yeaftHistoryOutlineBySession = {
          ...this.yeaftHistoryOutlineBySession,
          [key]: { ...state, refreshPending: true },
        };
        return true;
      }
      this.yeaftHistoryOutlineBySession = {
        ...this.yeaftHistoryOutlineBySession,
        [key]: { ...state, loaded: false, refreshPending: false },
      };
      const activeAgentId = resolveAgentIdForSession(this, sessionId);
      if (this.currentView === 'yeaft'
        && this.yeaftActiveSessionFilter === sessionId
        && activeAgentId === agentId) {
        return this.loadYeaftHistoryOutline({
          force: true,
          targetSessionId: sessionId,
          targetAgentId: agentId,
        });
      }
      return true;
    },

    loadYeaftHistoryOutline({
      append = false,
      force = false,
      targetSessionId = null,
      targetAgentId = null,
      retryAttempt = 0,
    } = {}) {
      if (this.currentView !== 'yeaft' && !targetSessionId) return false;
      const sessionId = targetSessionId || this.yeaftActiveSessionFilter || null;
      const agentId = targetAgentId || resolveAgentIdForSession(this, sessionId);
      if (!sessionId || !agentId) return false;
      const key = yeaftHistoryIdentityKey(agentId, sessionId);
      const previous = this.getYeaftHistoryOutlineState(sessionId, agentId);
      if (!append && previous.loaded && !force) return true;
      if (append && (!previous.hasMore || !Number.isFinite(previous.nextBeforeSeq))) return false;
      if (previous.loading) return false;
      if (!agentHasCapability(this, agentId, 'session_history_outline')) {
        this.yeaftHistoryOutlineBySession = {
          ...this.yeaftHistoryOutlineBySession,
          [key]: { ...previous, error: 'unsupported', loading: false },
        };
        return false;
      }

      const requestId = `history_outline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const nextState = {
        ...previous,
        requestId,
        agentId,
        sessionId,
        loading: true,
        requestAppend: append,
        refreshPending: false,
        retryAttempt,
        error: null,
      };
      this.yeaftHistoryOutlineBySession = { ...this.yeaftHistoryOutlineBySession, [key]: nextState };
      const previousTimeout = this._yeaftHistoryOutlineTimeouts[key];
      if (previousTimeout) clearTimeout(previousTimeout);
      const timeout = setTimeout(() => {
        const current = this.yeaftHistoryOutlineBySession[key];
        if (current?.requestId !== requestId) return;
        const nextTimeouts = { ...this._yeaftHistoryOutlineTimeouts };
        delete nextTimeouts[key];
        this._yeaftHistoryOutlineTimeouts = nextTimeouts;
        const refreshPending = current.refreshPending === true;
        this.yeaftHistoryOutlineBySession = {
          ...this.yeaftHistoryOutlineBySession,
          [key]: {
            ...current,
            requestId: null,
            loading: false,
            requestAppend: false,
            loaded: refreshPending ? false : current.loaded,
            refreshPending: false,
            error: refreshPending ? null : 'timeout',
          },
        };
        if (refreshPending) {
          this.loadYeaftHistoryOutline({
            force: true,
            targetSessionId: sessionId,
            targetAgentId: agentId,
          });
        }
      }, 10000);
      this._yeaftHistoryOutlineTimeouts = { ...this._yeaftHistoryOutlineTimeouts, [key]: timeout };
      const perfTraceId = createPerfTraceId();
      const payload = {
        type: 'yeaft_load_history_outline',
        agentId,
        sessionId,
        requestId,
        perfTraceId,
        limit: 50,
        ...(append && previous.nextCursor ? { cursor: previous.nextCursor } : {}),
        ...(append && !previous.nextCursor && Number.isFinite(previous.nextBeforeSeq)
          ? { beforeSeq: previous.nextBeforeSeq }
          : {}),
      };
      recordPerfTrace(this, {
        traceId: perfTraceId,
        phase: 'history_outline.request_send',
        agentId,
        sessionId,
        messageType: payload.type,
        bytes: JSON.stringify(payload).length,
        detail: { append, limit: payload.limit },
      });
      this.sendWsMessage(payload);
      return true;
    },

    handleYeaftHistoryOutline(msg) {
      if (!msg?.agentId || !msg?.sessionId) return false;
      const key = yeaftHistoryIdentityKey(msg.agentId, msg.sessionId);
      const state = this.yeaftHistoryOutlineBySession[key];
      if (!state || msg.requestId !== state.requestId) return false;
      const timeout = this._yeaftHistoryOutlineTimeouts[key];
      if (timeout) clearTimeout(timeout);
      const nextTimeouts = { ...this._yeaftHistoryOutlineTimeouts };
      delete nextTimeouts[key];
      this._yeaftHistoryOutlineTimeouts = nextTimeouts;
      const retryAttempt = Number.isInteger(state.retryAttempt) ? state.retryAttempt : 0;
      if (YEAFT_HISTORY_OUTLINE_RETRYABLE_ERRORS.has(msg.error)
        && retryAttempt < YEAFT_HISTORY_OUTLINE_RETRY_DELAYS_MS.length) {
        const delay = YEAFT_HISTORY_OUTLINE_RETRY_DELAYS_MS[retryAttempt];
        const nextTimeout = setTimeout(() => {
          const current = this.yeaftHistoryOutlineBySession[key];
          if (current?.requestId !== msg.requestId || current.loading !== true) return;
          const nextRetryTimeouts = { ...this._yeaftHistoryOutlineTimeouts };
          delete nextRetryTimeouts[key];
          this._yeaftHistoryOutlineTimeouts = nextRetryTimeouts;
          const refreshPending = current.refreshPending === true;
          this.yeaftHistoryOutlineBySession = {
            ...this.yeaftHistoryOutlineBySession,
            [key]: {
              ...current,
              requestId: null,
              loading: false,
              refreshPending: false,
            },
          };
          this.loadYeaftHistoryOutline({
            // A durable mutation during backoff invalidates the old append cursor.
            // Restart from the newest page instead of letting the retry clear the
            // pending refresh and leave the outline stale.
            append: refreshPending ? false : state.requestAppend === true,
            force: true,
            targetSessionId: msg.sessionId,
            targetAgentId: msg.agentId,
            retryAttempt: retryAttempt + 1,
          });
        }, delay);
        this._yeaftHistoryOutlineTimeouts = {
          ...this._yeaftHistoryOutlineTimeouts,
          [key]: nextTimeout,
        };
        return true;
      }
      const incoming = Array.isArray(msg.results)
        ? msg.results.map(result => ({ ...result, agentId: msg.agentId, sessionId: msg.sessionId }))
        : [];
      const sourceResults = state.requestAppend ? [...(state.results || []), ...incoming] : incoming;
      const byId = new Map(sourceResults
        .filter(result => result?.messageId)
        .map(result => [outlineResultIdentity(result), result]));
      const results = Array.from(byId.values()).sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const refreshPending = state.refreshPending === true;
      this.yeaftHistoryOutlineBySession = {
        ...this.yeaftHistoryOutlineBySession,
        [key]: {
          ...state,
          requestId: null,
          loading: false,
          requestAppend: false,
          refreshPending: false,
          loaded: refreshPending ? false : !msg.error,
          results,
          hasMore: !!msg.hasMore,
          nextBeforeSeq: Number.isFinite(msg.nextBeforeSeq) ? msg.nextBeforeSeq : null,
          nextCursor: msg.nextCursor && typeof msg.nextCursor === 'object' ? msg.nextCursor : null,
          totalCount: Number.isFinite(msg.totalCount) ? msg.totalCount : state.totalCount,
          error: refreshPending ? null : (msg.error || null),
        },
      };
      const resultRefresh = this._yeaftHistoryResultRefreshByRequestId?.[msg.requestId];
      if (resultRefresh?.source === 'outline') {
        clearTimeout(resultRefresh.timeout);
        const { [msg.requestId]: _resolved, ...rest } = this._yeaftHistoryResultRefreshByRequestId;
        this._yeaftHistoryResultRefreshByRequestId = rest;
        const refreshed = results.find(candidate => (
          (resultRefresh.messageId && candidate?.messageId === resultRefresh.messageId)
          || (resultRefresh.entryId && candidate?.entryId === resultRefresh.entryId)
        ));
        resultRefresh.resolve(refreshed || null);
      }
      if (refreshPending) {
        this.loadYeaftHistoryOutline({
          force: true,
          targetSessionId: msg.sessionId,
          targetAgentId: msg.agentId,
        });
      }
      return true;
    },

    searchYeaftHistory(query, { append = false, senderKey = '' } = {}) {
      if (this.currentView !== 'yeaft') return false;
      const normalized = typeof query === 'string' ? query.trim() : '';
      const normalizedSenderKey = typeof senderKey === 'string' && (senderKey === 'user' || senderKey.startsWith('vp:'))
        ? senderKey.slice(0, 103)
        : '';
      const sessionId = this.yeaftActiveSessionFilter || null;
      const agentId = resolveAgentIdForSession(this, sessionId);
      if (this._yeaftHistorySearchTimeout) {
        clearTimeout(this._yeaftHistorySearchTimeout);
        this._yeaftHistorySearchTimeout = null;
      }
      if (!sessionId || !agentId || (Array.from(normalized).length < 1 && !normalizedSenderKey)) {
        this.yeaftHistorySearchState = {
          requestId: null,
          agentId,
          sessionId,
          query: normalized,
          senderKey: normalizedSenderKey,
          loading: false,
          results: [],
          hasMore: false,
          nextBeforeSeq: null,
          nextCursor: null,
          error: null,
        };
        return false;
      }

      const previous = this.yeaftHistorySearchState || {};
      if (!agentHasCapability(this, agentId, 'session_history_search')) {
        this.yeaftHistorySearchState = {
          requestId: null,
          agentId,
          sessionId,
          query: normalized,
          senderKey: normalizedSenderKey,
          loading: false,
          results: [],
          hasMore: false,
          nextBeforeSeq: null,
          nextCursor: null,
          error: 'unsupported',
        };
        return false;
      }

      const requestId = `history_search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.yeaftHistorySearchState = {
        requestId,
        agentId,
        sessionId,
        query: normalized,
        senderKey: normalizedSenderKey,
        loading: true,
        results: append && previous.query === normalized && previous.senderKey === normalizedSenderKey ? previous.results : [],
        hasMore: false,
        nextBeforeSeq: append && previous.query === normalized && previous.senderKey === normalizedSenderKey
          ? previous.nextBeforeSeq
          : null,
        nextCursor: append && previous.query === normalized && previous.senderKey === normalizedSenderKey
          ? previous.nextCursor || null
          : null,
        error: null,
      };
      this._yeaftHistorySearchTimeout = setTimeout(() => {
        if (this.yeaftHistorySearchState?.requestId !== requestId) return;
        this._yeaftHistorySearchTimeout = null;
        this.yeaftHistorySearchState = {
          ...this.yeaftHistorySearchState,
          loading: false,
          error: 'timeout',
        };
      }, 10000);
      const perfTraceId = createPerfTraceId();
      const payload = {
        type: 'yeaft_search_history',
        agentId,
        sessionId,
        requestId,
        perfTraceId,
        query: normalized,
        senderKey: normalizedSenderKey,
        limit: 20,
        ...(append
          && previous.query === normalized
          && previous.senderKey === normalizedSenderKey
          && previous.nextCursor
          ? { cursor: previous.nextCursor }
          : {}),
        ...(append
          && previous.query === normalized
          && previous.senderKey === normalizedSenderKey
          && !previous.nextCursor
          && Number.isFinite(previous.nextBeforeSeq)
          ? { beforeSeq: previous.nextBeforeSeq }
          : {}),
      };
      recordPerfTrace(this, {
        traceId: perfTraceId,
        phase: 'history_search.request_send',
        agentId,
        sessionId,
        messageType: payload.type,
        bytes: JSON.stringify(payload).length,
        detail: {
          append,
          limit: payload.limit,
          queryLength: Array.from(normalized).length,
          senderFilter: !!normalizedSenderKey,
        },
      });
      this.sendWsMessage(payload);
      return true;
    },

    handleYeaftHistorySearchResult(msg) {
      const state = this.yeaftHistorySearchState || {};
      if (!msg || msg.requestId !== state.requestId) return false;
      if (msg.agentId !== state.agentId || msg.sessionId !== state.sessionId || msg.query !== state.query || (msg.senderKey || '') !== state.senderKey) return false;
      if (this._yeaftHistorySearchTimeout) {
        clearTimeout(this._yeaftHistorySearchTimeout);
        this._yeaftHistorySearchTimeout = null;
      }
      const incoming = Array.isArray(msg.results)
        ? msg.results.map(result => ({ ...result, agentId: msg.agentId, sessionId: msg.sessionId }))
        : [];
      const byId = new Map((state.results || []).map(result => [yeaftHistoryResultIdentity(result), result]));
      for (const result of incoming) {
        if (result?.entryId || result?.messageId) byId.set(yeaftHistoryResultIdentity(result), result);
      }
      const results = Array.from(byId.values());
      this.yeaftHistorySearchState = {
        ...state,
        loading: false,
        results,
        hasMore: !!msg.hasMore,
        nextBeforeSeq: Number.isFinite(msg.nextBeforeSeq) ? msg.nextBeforeSeq : null,
        nextCursor: msg.nextCursor && typeof msg.nextCursor === 'object' ? msg.nextCursor : null,
        error: msg.error || null,
      };
      const refresh = this._yeaftHistoryResultRefreshByRequestId?.[msg.requestId];
      if (refresh) {
        clearTimeout(refresh.timeout);
        const { [msg.requestId]: _resolved, ...rest } = this._yeaftHistoryResultRefreshByRequestId;
        this._yeaftHistoryResultRefreshByRequestId = rest;
        const refreshed = results.find(candidate => (
          (refresh.messageId && candidate?.messageId === refresh.messageId)
          || (refresh.entryId && candidate?.entryId === refresh.entryId)
        ));
        refresh.resolve(refreshed || null);
      }
      return true;
    },

    reloadYeaftHistoryResult(result) {
      const sessionId = result?.sessionId || null;
      const agentId = result?.agentId || null;
      const state = this.yeaftHistorySearchState || {};
      const searchMatches = state.agentId === agentId
        && state.sessionId === sessionId
        && (Array.from(String(state.query || '').trim()).length > 0 || !!state.senderKey);
      const useSearch = searchMatches;
      if (!sessionId || !agentId) return Promise.resolve(null);
      const query = useSearch ? (state.query || '') : '';
      const senderKey = useSearch ? (state.senderKey || '') : '';
      let requestId = null;
      let started = false;
      if (useSearch) {
        started = this.searchYeaftHistory(query, { senderKey });
        requestId = this.yeaftHistorySearchState?.requestId || null;
      } else {
        const outlineKey = yeaftHistoryIdentityKey(agentId, sessionId);
        const outlineState = this.yeaftHistoryOutlineBySession?.[outlineKey] || null;
        // A newest-page outline refresh already in flight is itself a valid
        // relocation source. Bind this bounded waiter to its exact request
        // instead of treating the outline loading guard as a permanent miss.
        if (outlineState?.loading === true
          && outlineState.requestAppend !== true
          && outlineState.requestId) {
          started = true;
          requestId = outlineState.requestId;
        } else {
          started = this.loadYeaftHistoryOutline({
            force: true,
            targetSessionId: sessionId,
            targetAgentId: agentId,
          });
          requestId = this.yeaftHistoryOutlineBySession?.[outlineKey]?.requestId || null;
        }
      }
      if (!started || !requestId) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          const current = this._yeaftHistoryResultRefreshByRequestId?.[requestId];
          if (current?.resolve !== resolve) return;
          const { [requestId]: _expired, ...rest } = this._yeaftHistoryResultRefreshByRequestId;
          this._yeaftHistoryResultRefreshByRequestId = rest;
          resolve(null);
        }, 10000);
        this._yeaftHistoryResultRefreshByRequestId = {
          ...(this._yeaftHistoryResultRefreshByRequestId || {}),
          [requestId]: {
            agentId,
            sessionId,
            query,
            senderKey,
            source: useSearch ? 'search' : 'outline',
            messageId: result?.messageId || null,
            entryId: result?.entryId || null,
            resolve,
            timeout,
          },
        };
      });
    },

    loadYeaftHistoryWindow(result, { validateCached = false } = {}) {
      const sessionId = result?.sessionId || this.yeaftActiveSessionFilter || null;
      const agentId = result?.agentId || resolveAgentIdForSession(this, sessionId);
      const resultId = yeaftHistoryResultIdentity(result);
      if (!sessionId || !agentId || !result?.entryId
        || !Number.isFinite(result.indexGeneration)
        || !Number.isFinite(result.entryStartSeq)
        || !result?.messageId
        || !Number.isFinite(result.seq)) return Promise.resolve(false);
      const conversationId = resolveYeaftConversationIdForSession(this, sessionId, agentId);
      const validatedCacheHit = (this.messagesMap[conversationId] || []).some(row => (
        (row?.sessionId ?? row?.groupId ?? null) === sessionId
        && row?.historyEntryId === result.entryId
        && row?.historyIndexGeneration === result.indexGeneration
      ));
      if (validatedCacheHit && !validateCached) return Promise.resolve(true);

      const pendingKey = yeaftHistoryIdentityKey(
        agentId,
        `${sessionId}:${resultId}:generation:${result.indexGeneration}`,
      );
      const pendingByKey = this._yeaftHistoryWindowPendingByKey || {};
      if (pendingByKey[pendingKey]?.promise) return pendingByKey[pendingKey].promise;

      const requestId = `history_window_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let resolvePending = null;
      let pendingError = null;
      const promise = new Promise((resolve) => { resolvePending = resolve; });
      Object.defineProperty(promise, 'error', { get: () => pendingError });
      const setPendingError = error => { pendingError = error || null; };
      const timeout = setTimeout(() => {
        const current = this._yeaftHistoryWindowPendingByKey?.[pendingKey];
        if (current?.requestId !== requestId) return;
        const { [pendingKey]: _expired, ...rest } = this._yeaftHistoryWindowPendingByKey;
        this._yeaftHistoryWindowPendingByKey = rest;
        resolvePending(false);
      }, 10000);
      this._yeaftHistoryWindowPendingByKey = {
        ...pendingByKey,
        [pendingKey]: {
          requestId,
          agentId,
          sessionId,
          entryId: result.entryId || null,
          indexGeneration: Number.isFinite(result.indexGeneration) ? result.indexGeneration : null,
          entryStartSeq: Number.isFinite(result.entryStartSeq) ? result.entryStartSeq : null,
          resultId,
          messageId: result.messageId,
          prefetch: !validateCached,
          validateCached: !!validateCached,
          setError: setPendingError,
          resolve: resolvePending,
          timeout,
          promise,
        },
      };
      this.sendWsMessage({
        type: 'yeaft_load_history_window',
        agentId,
        sessionId,
        requestId,
        prefetch: !validateCached,
        ...(result.entryId ? { entryId: result.entryId } : {}),
        ...(Number.isFinite(result.indexGeneration) ? { indexGeneration: result.indexGeneration } : {}),
        ...(Number.isFinite(result.entryStartSeq) ? { entryStartSeq: result.entryStartSeq } : {}),
        anchorMessageId: result.messageId,
        anchorSeq: result.seq,
        beforeTurns: 5,
        afterTurns: 5,
        maxRows: 200,
        maxBytes: 512 * 1024,
      });
      return promise;
    },

    beginYeaftHistoryReveal(result) {
      const sessionId = result?.sessionId || null;
      const agentId = result?.agentId || null;
      const conversationId = resolveYeaftConversationIdForSession(this, sessionId, agentId);
      if (!sessionId || !agentId || !conversationId) return null;
      const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
      const key = `${sessionKey}\u001f${conversationId}`;
      const token = ++this._yeaftHistoryRevealSequence;
      const lease = { key, token, sessionKey, agentId, sessionId, conversationId };
      this._yeaftHistoryRevealLeases = {
        ...(this._yeaftHistoryRevealLeases || {}),
        [key]: lease,
      };
      return lease;
    },

    finishYeaftHistoryReveal(lease) {
      if (!lease?.key || !Number.isFinite(lease.token)) return false;
      const current = this._yeaftHistoryRevealLeases?.[lease.key];
      if (current?.token !== lease.token) return false;
      const { [lease.key]: _finished, ...remaining } = this._yeaftHistoryRevealLeases;
      this._yeaftHistoryRevealLeases = remaining;
      return true;
    },

    async revealYeaftHistoryResult(result, revealLease = null) {
      const ownsLease = !revealLease;
      const lease = revealLease || this.beginYeaftHistoryReveal(result);
      const sessionId = result?.sessionId || null;
      const agentId = result?.agentId || null;
      const conversationId = resolveYeaftConversationIdForSession(this, sessionId, agentId);
      if (!lease || !sessionId || !agentId || !conversationId || !result?.messageId) {
        this.finishYeaftHistoryReveal(lease);
        return false;
      }

      let revealResult = result;
      let windowLoad = this.loadYeaftHistoryWindow(revealResult, { validateCached: true });
      let loaded = await windowLoad;
      if (!loaded && windowLoad.error === 'stale_result') {
        const refreshed = await this.reloadYeaftHistoryResult(revealResult);
        if (refreshed) {
          revealResult = refreshed;
          windowLoad = this.loadYeaftHistoryWindow(revealResult, { validateCached: true });
          loaded = await windowLoad;
        }
      }
      if (!loaded) {
        this.finishYeaftHistoryReveal(lease);
        return false;
      }
      // A window response can settle after the reader changes Agent or Session.
      // Keep the click bound to the transcript that initiated it rather than
      // expanding an unrelated current view with the same Session id.
      if (this.currentView !== 'yeaft'
        || this.yeaftActiveSessionFilter !== sessionId
        || resolveAgentIdForSession(this, sessionId) !== agentId
        || resolveYeaftConversationIdForSession(this, sessionId, agentId) !== conversationId) {
        this.finishYeaftHistoryReveal(lease);
        return false;
      }
      const revealed = this.revealYeaftMessage(sessionId, revealResult.messageId, conversationId, agentId);
      if (!revealed || ownsLease) this.finishYeaftHistoryReveal(lease);
      return revealed;
    },

    pendingYeaftHistoryWindow(msg) {
      const pendingEntries = Object.entries(this._yeaftHistoryWindowPendingByKey || {});
      const match = pendingEntries.find(([, pending]) => pending?.requestId === msg?.requestId);
      if (!match) return null;
      const [pendingKey, pending] = match;
      if (msg.agentId !== pending.agentId || msg.sessionId !== pending.sessionId) return null;
      if (msg.entryId && pending.entryId && msg.entryId !== pending.entryId) return null;
      if (Number.isFinite(msg.indexGeneration)
        && Number.isFinite(pending.indexGeneration)
        && msg.indexGeneration !== pending.indexGeneration) return null;
      return { pendingKey, pending };
    },

    handleYeaftHistoryWindow(msg, conversationId = null) {
      const match = this.pendingYeaftHistoryWindow(msg);
      if (!match) return false;
      const { pendingKey, pending } = match;
      // A validateCached click intentionally promotes a prior hover-prefetched
      // island into the focused contiguous window. Preserve cache-only semantics
      // only for the original prefetch response, not for this validation request.
      if (pending.prefetch === true && msg.prefetch !== true && pending.validateCached !== true) msg.prefetch = true;
      clearTimeout(pending.timeout);
      const { [pendingKey]: _settled, ...rest } = this._yeaftHistoryWindowPendingByKey;
      this._yeaftHistoryWindowPendingByKey = rest;
      // The merge handler passes the exact conversation it updated. Validate
      // that same cache so agent/session switches cannot make a successful wire
      // response look navigable in the wrong transcript. Rendering expands only
      // on click; hover prefetch must not move the reader's current position.
      const loaded = !msg.error
        && !!conversationId
        && this.isYeaftMessageCached(pending.sessionId, pending.messageId, conversationId, pending.agentId);
      pending.setError?.(msg.error || null);
      pending.resolve(!!loaded);
      return !!loaded;
    },

    // ─── Yeaft Session creation ────────────────────────────────
    // Phase 3: unified Session creation. A session is operationally a
    // group with N≥1 VPs. Phase 2 router accepts `yeaft_create_session`
    // as an alias of `yeaft_create_group`; this action goes through the
    // shared sessionCrudRequest path so callers can `await` and surface
    // the new session row immediately. Phase 4 will rename the wire +
    // store fields; until then this is a thin facade.
    createYeaftSession({ displayName, vpIds, defaultVpId, workDir, agentId } = {}) {
      const roster = Array.isArray(vpIds) ? vpIds.slice() : [];
      // Caller may pin the default VP (e.g. SessionCreateModal's star button).
      // Fall back to the first roster member when omitted or invalid so the
      // agent never receives a default outside the roster.
      const resolvedDefault = (defaultVpId && roster.includes(defaultVpId))
        ? defaultVpId
        : (roster[0] || null);
      const trimmed = (displayName || '').trim();
      const trimmedWorkDir = (workDir || '').trim();
      const payload = { roster, defaultVpId: resolvedDefault };
      if (trimmed) payload.name = trimmed;
      if (trimmedWorkDir) payload.workDir = trimmedWorkDir;
      return this.sessionCrudRequest('create', payload, { agentId });
    },
    handleYeaftOutput(msg) {
      if (!msg) return;
      const envelopeAgentId = msg.agentId || this.yeaftAgentId || this.currentAgent || null;
      const envelopeConversationId = msg.conversationId || msg.event?.conversationId || null;
      const retiredEnvelopeConversation = isRetiredYeaftConversation(
        this,
        envelopeAgentId,
        envelopeConversationId,
      );
      if (msg.data && retiredEnvelopeConversation) {
        if (msg.data.type !== 'result') return;
        const currentConversationId = resolveCurrentYeaftConversation(
          this,
          envelopeAgentId,
          envelopeConversationId,
        );
        if (!currentConversationId) return;
        const currentTurnKey = msg.turnId
          ? yeaftTurnStateKey(this, envelopeAgentId, msg.turnId)
          : '';
        const currentOwnsTurn = !!(currentTurnKey && this.activeVpTurns?.[currentTurnKey])
          || (this.messagesMap?.[currentConversationId] || []).some(row => (
            row?.turnId === msg.turnId && (row.isStreaming || row.status === 'pending')
          ));
        if (!msg.turnId || !currentOwnsTurn) return;
        msg = { ...msg, conversationId: currentConversationId };
      }
      if (msg.perfTraceId) {
        recordPerfTrace(this, {
          traceId: msg.perfTraceId,
          phase: 'receive.yeaft_output',
          agentId: msg.agentId || null,
          sessionId: msg.sessionId || null,
          vpId: msg.vpId || null,
          turnId: msg.turnId || null,
          threadId: msg.threadId || null,
          messageType: msg.data?.type || msg.event?.type || msg.type,
        });
        if (msg.turnId) {
          this.yeaftPerfTraceByTurnId = {
            ...(this.yeaftPerfTraceByTurnId || {}),
            [msg.turnId]: msg.perfTraceId,
          };
        }
      }

      // ── Assistant output frame data: dispatch through the shared pipeline ──
      if (msg.data) {
        // Only the wire envelope may authorize Agent-scoped outline mutation.
        // UI pointers and conversation caches are not provenance.
        const frameAgentId = msg.agentId || null;
        const conversationId = resolveYeaftEnvelopeConversationId(this, frameAgentId, msg.conversationId);
        if (conversationId) {
          const frameOwner = yeaftWatchdogOwner(msg, msg.turnId || 'session');
          // A real output frame proves provider/retry/thinking silence ended.
          // Tool-result frames are also the authoritative tool_end boundary.
          for (const phase of ['retry', 'retrying', 'thinking']) {
            watchdogHelpers.resumeYeaftWatchdog(this, conversationId, `${phase}:${frameOwner}`);
          }
          if (msg.data?.tool_use_result) {
            watchdogHelpers.resumeYeaftWatchdog(this, conversationId, `tool:${frameOwner}`);
          }
        }
        // `llm_retry` remains visible while the replacement request is silent.
        // Its first real output frame proves recovery, so clear only the retry
        // annotation; the turn itself stays active until vp_turn_end.
        const frameTurnKey = msg.turnId ? yeaftTurnStateKey(this, msg.agentId || null, msg.turnId) : '';
        if (frameTurnKey && this.activeVpTurns?.[frameTurnKey]?.retryAttempt) {
          const {
            retryAttempt: _retryAttempt,
            retryMax: _retryMax,
            retryDelayMs: _retryDelayMs,
            retryReason: _retryReason,
            retryRecoveryMode: _retryRecoveryMode,
            ...activeTurn
          } = this.activeVpTurns[frameTurnKey];
          this.activeVpTurns = {
            ...this.activeVpTurns,
            [frameTurnKey]: activeTurn,
          };
        }
        if (conversationId) {
          const msgSessionId = msg.sessionId ?? msg.groupId ?? null;
          const outputIsVisible = isVisibleYeaftOutput(this, msgSessionId, frameAgentId);
          const previousAgentConvId = frameAgentId && this.yeaftConversationIdsByAgent
            ? this.yeaftConversationIdsByAgent[frameAgentId]
            : null;
          const pendingForAgent = pendingYeaftConversationPromotion(this, frameAgentId);
          if (pendingForAgent && pendingForAgent.targetConversationId !== conversationId) {
            retargetYeaftConversationPromotion(this, frameAgentId, conversationId);
          } else if (!pendingForAgent && previousAgentConvId && previousAgentConvId !== conversationId
              && !String(previousAgentConvId).startsWith('yeaft-local-')) {
            migrateYeaftConversationState(this, previousAgentConvId, conversationId, {
              removeSource: previousAgentConvId !== this.yeaftConversationId,
            });
            retireYeaftConversation(this, frameAgentId, previousAgentConvId, conversationId);
          }
          reviveYeaftConversation(this, frameAgentId, conversationId);
          const pendingPromotion = pendingYeaftConversationPromotion(this, frameAgentId, conversationId);
          const promotionSourceId = pendingPromotion?.sourceConversationId || previousAgentConvId;
          const retainVisibleSource = !outputIsVisible && promotionSourceId === this.yeaftConversationId;
          if (this.currentView === 'yeaft' && frameAgentId && promotionSourceId && promotionSourceId !== conversationId) {
            // An inactive same-agent Session can be the first frame carrying
            // the real bridge id. Copy the visible placeholder into that cache,
            // but keep the source alive until an authoritative visible frame
            // finalizes every runtime slot and watchdog under the new id.
            const removeSource = !retainVisibleSource
              && (!!pendingPromotion || String(promotionSourceId).startsWith('yeaft-local-'));
            migrateYeaftConversationState(this, promotionSourceId, conversationId, { removeSource });
            if (retainVisibleSource) {
              rememberYeaftConversationPromotion(this, frameAgentId, promotionSourceId, conversationId);
            } else if (removeSource) {
              clearYeaftConversationPromotion(this, frameAgentId, conversationId);
            }
          }
          if (frameAgentId) {
            this.yeaftConversationIdsByAgent = {
              ...(this.yeaftConversationIdsByAgent || {}),
              [frameAgentId]: conversationId,
            };
          }
          // Cache every agent's conversation, but only move the visible Yeaft
          // pointer for output from the Session the user is actually reading.
          // Otherwise a background reply looks like a conversation switch to
          // MessageList, which explicitly resumes bottom-follow and jumps away
          // from history.
          if (outputIsVisible || !this.yeaftConversationId) {
            this.yeaftConversationId = conversationId;
          }
          if (outputIsVisible) this.activeConversations = [conversationId];
          // Ensure messagesMap exists for this conversation
          if (!this.messagesMap[conversationId]) {
            this.messagesMap[conversationId] = [];
          }
          // Stamp the in-flight SEND-context session so messages land in the
          // originating session regardless of the user's current filter.
          // Inbound envelopes now carry `sessionId` (legacy `groupId` is
          // accepted as a fallback for older agents that haven't been
          // upgraded yet — drop after the next major version).
          const prevAgentId = this._currentYeaftAgentId;
          const prevGroup = this._currentYeaftSessionId;
          const prevVpId = this._currentYeaftVpId;
          const prevTurnId = this._currentYeaftTurnId;
          const prevThreadId = this._currentYeaftThreadId;
          if (frameAgentId) this._currentYeaftAgentId = frameAgentId;
          if (msgSessionId != null) this._currentYeaftSessionId = msgSessionId;
          if (msg.vpId) this._currentYeaftVpId = msg.vpId;
          if (msg.turnId) this._currentYeaftTurnId = msg.turnId;
          if (msg.threadId) this._currentYeaftThreadId = msg.threadId;
          // (2026-05-13) featureId stamping removed along with the Feature system.
          try {
            const renderStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
            this.handleAssistantOutputFrame(conversationId, msg.data, frameAgentId);
            if (msg.perfTraceId) {
              const renderEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
              recordPerfTrace(this, {
                traceId: msg.perfTraceId,
                phase: 'store.apply_output',
                agentId: msg.agentId || null,
                sessionId: msgSessionId || null,
                vpId: msg.vpId || null,
                turnId: msg.turnId || null,
                threadId: msg.threadId || null,
                messageType: msg.data?.type || null,
                durationMs: renderEnd - renderStart,
              });
              measureNextPaint(this, {
                traceId: msg.perfTraceId,
                agentId: msg.agentId || null,
                sessionId: msgSessionId || null,
                vpId: msg.vpId || null,
                turnId: msg.turnId || null,
                threadId: msg.threadId || null,
                messageType: msg.data?.type || null,
              });
            }
            // Advance the delta cursor only for rows that the Web can restore
            // independently. A tool-use row is not durable UI state until its
            // matching result has also been persisted/projected; advancing here
            // could skip that result after a Session switch.
            const data = msg.data;
            const liveId = data?.message?.id || data?.id || null;
            const seq = parseYeaftMessageSeq(liveId);
            const contentBlocks = Array.isArray(data?.message?.content) ? data.message.content : [];
            const hasToolUse = contentBlocks.some(block => block?.type === 'tool_use');
            const hasToolResult = !!data?.tool_use_result
              || contentBlocks.some(block => block?.type === 'tool_result');
            if (msgSessionId) {
              const candidateSeq = !hasToolResult
                && !hasPendingToolCall(this, conversationId, msgSessionId)
                && (data?.type === 'user' || (data?.type === 'assistant' && !hasToolUse))
                ? seq
                : null;
              const sessionKey = yeaftHistoryIdentityKey(msg.agentId || null, msgSessionId);
              const prevState = this.yeaftSessionHistoryState[sessionKey] || {};
              const prevLatest = Number.isFinite(prevState.latestSeq) ? prevState.latestSeq : -1;
              if (candidateSeq !== null && candidateSeq > prevLatest) {
                this.yeaftSessionHistoryState = {
                  ...this.yeaftSessionHistoryState,
                  [sessionKey]: { ...prevState, latestSeq: candidateSeq },
                };
              }
            }
          } finally {
            this._currentYeaftAgentId = prevAgentId;
            this._currentYeaftSessionId = prevGroup;
            this._currentYeaftVpId = prevVpId;
            this._currentYeaftTurnId = prevTurnId;
            this._currentYeaftThreadId = prevThreadId;
          }
        }
        return;
      }

      // ── Metadata events ──
      const event = msg.event;
      if (!event) return;
      const phaseEvent = {
        ...event,
        vpId: event.vpId || msg.vpId || null,
        threadId: event.threadId || msg.threadId || null,
        turnId: event.turnId || msg.turnId || null,
      };
      const eventConversationId = resolveYeaftEnvelopeConversationId(
        this,
        msg.agentId || null,
        msg.conversationId,
      );
      if (eventConversationId) {
        const owner = yeaftWatchdogOwner(phaseEvent);
        if (event.type === 'tool_start') {
          watchdogHelpers.pauseYeaftWatchdog(this, eventConversationId, `tool:${owner}`);
        } else if (event.type === 'tool_end') {
          watchdogHelpers.resumeYeaftWatchdog(this, eventConversationId, `tool:${owner}`);
        } else if (event.type === 'llm_retry') {
          watchdogHelpers.pauseYeaftWatchdog(this, eventConversationId, `retry:${owner}`);
        } else if (event.type === 'vp_async_task_wait_start') {
          watchdogHelpers.pauseYeaftWatchdog(this, eventConversationId, `async-wait:${owner}`);
        } else if (event.type === 'vp_async_task_wait_end') {
          watchdogHelpers.resumeYeaftWatchdog(this, eventConversationId, `async-wait:${owner}`);
        }
      }

      switch (event.type) {
        case 'project_mutation_result':
          if (event.projectsAuthoritative === true) this.finishProjectMutation(event);
          else this.finishLegacyProjectMutation(event, msg.agentId || null);
          break;

        case 'ask_user_question': {
          const conversationId = resolveYeaftEnvelopeConversationId(this, msg.agentId || null, msg.conversationId);
          if (!conversationId || !event.requestId) break;
          const identity = askUserEventIdentity(msg, event, conversationId);
          const linkPrompt = () => {
            const messages = this.messagesMap[conversationId] || [];
            const existingRow = findAskUserRow(messages, identity, conversationId);
            if (existingRow) {
              if (existingRow.askAnswered || existingRow.askExpired) return true;
              existingRow.toolName = 'AskUserQuestion';
              if (event.toolCallId && !existingRow.toolId) existingRow.toolId = event.toolCallId;
              existingRow.agentId = identity.agentId || existingRow.agentId || null;
              existingRow.askRequestId = event.requestId;
              existingRow.askQuestions = event.questions || [];
              existingRow.askCreatedAt = event.createdAt || null;
              existingRow.askExpiresAt = event.expiresAt || null;
              if (event.replay) {
                existingRow.askPending = false;
                existingRow.pendingAnswers = null;
                existingRow.askSubmitGeneration = null;
              }
              existingRow.isHistory = false;
              const terminal = takeAskUserTerminal(this, identity);
              if (terminal) applyAskUserTerminal(existingRow, terminal);
              this.messagesMap = { ...this.messagesMap, [conversationId]: messages.slice() };
              return true;
            }
            if (!event.replay) return false;
            const promptRow = {
              id: `ask-card-${event.requestId}`,
              type: 'tool-use',
              toolName: 'AskUserQuestion',
              toolId: event.toolCallId || null,
              toolInput: { questions: event.questions || [] },
              askRequestId: event.requestId,
              askQuestions: event.questions || [],
              askCreatedAt: event.createdAt || null,
              askExpiresAt: event.expiresAt || null,
              agentId: identity.agentId,
              sessionId: identity.sessionId,
              vpId: identity.vpId,
              speakerVpId: identity.vpId,
              turnId: identity.turnId,
              threadId: identity.threadId || 'main',
              hasResult: false,
              isHistory: false,
              timestamp: event.createdAt || Date.now(),
            };
            const terminal = takeAskUserTerminal(this, identity);
            if (terminal) applyAskUserTerminal(promptRow, terminal);
            messages.push(promptRow);
            this.messagesMap = { ...this.messagesMap, [conversationId]: messages.slice() };
            return true;
          };
          if (!linkPrompt()) {
            let retries = 0;
            const retryInterval = setInterval(() => {
              retries += 1;
              if (linkPrompt() || retries >= 10) clearInterval(retryInterval);
            }, 200);
          }
          break;
        }

        case 'ask_user_answered':
        case 'ask_user_expired': {
          const conversationId = resolveYeaftEnvelopeConversationId(this, msg.agentId || null, msg.conversationId);
          if (!conversationId || !event.requestId) break;
          const messages = this.messagesMap[conversationId] || [];
          const identity = askUserEventIdentity(msg, event, conversationId);
          const askMsg = findAskUserRow(messages, identity, conversationId);
          if (!askMsg) {
            rememberAskUserTerminal(this, identity, event);
            break;
          }
          applyAskUserTerminal(askMsg, event);
          this.messagesMap = { ...this.messagesMap, [conversationId]: messages.slice() };
          break;
        }

        case 'session_ready': {
          const agentConvId = event.conversationId;
          const statusAgentId = msg.agentId || this.currentAgent;
          if (isRetiredYeaftConversation(this, statusAgentId, agentConvId)) break;
          const previousAgentConvId = statusAgentId && this.yeaftConversationIdsByAgent
            ? this.yeaftConversationIdsByAgent[statusAgentId]
            : null;
          const currentConvId = this.yeaftConversationId ? String(this.yeaftConversationId) : '';
          const fallbackLocalConvId = currentConvId.startsWith('yeaft-local-')
            && (!statusAgentId || currentConvId.startsWith(`yeaft-local-${statusAgentId}-`) || /^yeaft-local-\d/.test(currentConvId))
            ? this.yeaftConversationId
            : null;
          const localConvId = previousAgentConvId || fallbackLocalConvId;
          const readySessionId = event.sessionId || msg.sessionId || null;
          const readyIsVisible = isVisibleYeaftOutput(this, readySessionId, statusAgentId);
          const pendingForAgent = pendingYeaftConversationPromotion(this, statusAgentId);
          if (pendingForAgent && pendingForAgent.targetConversationId !== agentConvId) {
            retargetYeaftConversationPromotion(this, statusAgentId, agentConvId);
          } else if (!pendingForAgent && previousAgentConvId && previousAgentConvId !== agentConvId
              && !String(previousAgentConvId).startsWith('yeaft-local-')) {
            retireYeaftConversation(this, statusAgentId, previousAgentConvId, agentConvId);
          }
          reviveYeaftConversation(this, statusAgentId, agentConvId);
          const pendingPromotion = pendingYeaftConversationPromotion(this, statusAgentId, agentConvId);
          const promotionSourceId = pendingPromotion?.sourceConversationId || localConvId;
          const retainVisibleSource = !readyIsVisible && promotionSourceId === this.yeaftConversationId;

          // Migrate messages from this agent's local placeholder to this
          // agent's conversationId. Do not merge the last globally-active
          // conversation blindly: with multiple machines, B's session_ready can
          // arrive while A's cache is still the global yeaftConversationId.
          if (promotionSourceId && promotionSourceId !== agentConvId) {
            const removeSource = !retainVisibleSource;
            migrateYeaftConversationState(this, promotionSourceId, agentConvId, {
              removeSource,
            });
            if (retainVisibleSource) {
              rememberYeaftConversationPromotion(this, statusAgentId, promotionSourceId, agentConvId);
            } else if (removeSource) {
              clearYeaftConversationPromotion(this, statusAgentId, agentConvId);
            }
          } else if (!this.messagesMap[agentConvId]) {
            this.messagesMap[agentConvId] = [];
          }

          if (statusAgentId) {
            // Cache this agent's conversationId + status, but do NOT change
            // which agent the page operates on. `session_ready` is just a
            // bridge replay from `statusAgentId`; flipping the active agent
            // here is what used to clobber the pointer and misroute the next
            // send. The active agent is owned by user actions (selectAgent).
            this.yeaftConversationIdsByAgent = {
              ...(this.yeaftConversationIdsByAgent || {}),
              [statusAgentId]: agentConvId,
            };
            this.cacheYeaftAgentStatus(statusAgentId, event, { allowBootstrapCatalog: readyIsVisible });
          }
          if (readyIsVisible) {
            this.yeaftModel = event.model;
            this.yeaftModelEffort = event.modelEffort || null;
            this.yeaftSessionReady = true;
            this.yeaftBootstrapMetaLoadingKey = null;
            if (statusAgentId) this.applyCachedYeaftStatus(statusAgentId);
            else this.yeaftAvailableModels = event.availableModels || [];
          }
          const readyTasks = Array.isArray(event.tasks) ? event.tasks : [];
          const nextTasks = {};
          // session_ready is authoritative only for the Agent that emitted it.
          // Preserve other Agents' running rows while replacing this Agent's
          // stale running snapshot. Terminal rows leave the activity pane.
          for (const [sessionKey, tasksById] of Object.entries(this.yeaftActiveTasksBySession || {})) {
            const retainedTasks = Object.fromEntries(Object.entries(tasksById || {}).filter(([, task]) => (
              task?.id && task.status === 'running' && task.agentId && task.agentId !== statusAgentId
            )));
            const retained = keepRunningSessionTasks(retainedTasks);
            if (Object.keys(retained).length > 0) nextTasks[sessionKey] = retained;
          }
          for (const task of readyTasks) {
            if (!task?.id || !task.sessionId || task.status !== 'running') continue;
            const sessionKey = yeaftHistoryIdentityKey(statusAgentId, task.sessionId);
            nextTasks[sessionKey] = {
              ...(nextTasks[sessionKey] || {}),
              [task.id]: { ...task, agentId: statusAgentId },
            };
          }
          this.yeaftActiveTasksBySession = nextTasks;
          // Background Session replay only updates its own cached metadata.
          // The visible Session owns page-level runtime status and workbench root.
          if (readyIsVisible) {
            if (event.yeaftDir) this.yeaftYeaftDir = event.yeaftDir;
            this.yeaftStatus = {
              skills: event.skills,
              mcpServers: event.mcpServers,
              tools: event.tools,
              // task-334-ui-b: expose multi-VP feature flag surface so
              // MessageList can decide whether to render VP speaker headers.
              // Agent side (334c + feature-flag.js) determines the boolean;
              // web just mirrors it. Absent → falsy → legacy 1:1 UI.
              multiVp: !!event.multiVp,
            };
          }

          if (readyIsVisible || !this.yeaftConversationId) {
            this.yeaftConversationId = agentConvId;
          }
          // session_ready is also replayed for background agents. Keep their
          // metadata cached without manufacturing a visible conversation switch.
          if (readyIsVisible) {
            this.activeConversations = [agentConvId];
          }

          // ★ task-334-ui-a: subscribe to VP library snapshot.
          // Snapshot-only this slice; live diff (vp_updated/vp_removed)
          // arrives via the same channel once 334h ships.
          //
          // fix-session-restore-modal-unify: stamp `agentId` explicitly so
          // the server can route this subscribe to the right agent even
          // before `client.currentAgent` has converged. `msg.agentId` is
          // the envelope from the server (stamped at agent-output relay),
          // which identifies the agent that emitted this session_ready;
          // `currentAgent` is the fallback. Falling through `||` covers
          // single- and multi-agent deployments alike.
          const subscribeAgentId = msg.agentId || this.currentAgent || null;
          const subscribeKey = subscribeAgentId || '__current__';
          if (this._yeaftVpSubscribedAgentKey !== subscribeKey) {
            this._yeaftVpSubscribedAgentKey = subscribeKey;
            this.sendWsMessage(subscribeAgentId
              ? { type: 'yeaft_vp_subscribe', agentId: subscribeAgentId }
              : { type: 'yeaft_vp_subscribe' });
          }
          break;
        }

        case 'yeaft_status': {
          const statusAgentId = msg.agentId || this.currentAgent;
          if (statusAgentId) this.cacheYeaftAgentStatus(statusAgentId, event);
          break;
        }

        case 'context_usage':
          // Could display token usage in UI later
          break;

        case 'turn_open': {
          // feat-6af5f9f1 PR B: seed a Turn record. All loop / tool_exec /
          // memory_used / memory_adjust / reflection / turn_close events
          // for this query() will reference event.turnId.
          if (!event.turnId) break;
          const turn = {
            turnId: event.turnId,
            userPrompt: event.userPrompt || '',
            vpId: event.vpId || msg.vpId || null,
            sessionId: event.sessionId || msg.sessionId || null,
            openedAt: event.at || Date.now(),
            closedAt: null,
            totalMs: 0,
            totalTokens: 0,
            loopCount: 0,
            memoryLoaded: null,
            memoryLoadedMeta: null,
            memoryAdjust: null,
            tools: [],
            detailsLoaded: true,
          };
          this.yeaftDebugTurnsById = { ...this.yeaftDebugTurnsById, [event.turnId]: turn };
          if (!this.yeaftDebugTurnOrder.includes(event.turnId)) {
            this.yeaftDebugTurnOrder = [...this.yeaftDebugTurnOrder, event.turnId];
          }
          break;
        }

        case 'turn_close': {
          if (!event.turnId) break;
          const prev = this.yeaftDebugTurnsById[event.turnId];
          if (!prev) break;
          this.yeaftDebugTurnsById = {
            ...this.yeaftDebugTurnsById,
            [event.turnId]: {
              ...prev,
              closedAt: Date.now(),
              totalMs: event.totalMs || 0,
              totalTokens: event.totalTokens || 0,
              loopCount: event.loopCount || prev.loopCount || 0,
            },
          };
          break;
        }

        case 'memory_used': {
          if (!event.turnId) break;
          const prev = this.yeaftDebugTurnsById[event.turnId];
          if (!prev) break;
          this.yeaftDebugTurnsById = {
            ...this.yeaftDebugTurnsById,
            [event.turnId]: {
              ...prev,
              memoryLoaded: Array.isArray(event.loaded) ? event.loaded : [],
              memoryLoadedMeta: event.meta || null,
            },
          };
          break;
        }

        case 'dream_memory_loaded': {
          const resident = Array.isArray(event.resident) ? event.resident : [];
          if (event.turnId) {
            const prev = this.yeaftDebugTurnsById[event.turnId];
            if (prev) {
              this.yeaftDebugTurnsById = {
                ...this.yeaftDebugTurnsById,
                [event.turnId]: {
                  ...prev,
                  dreamMemoryLoaded: resident,
                  dreamMemoryLoadedInto: event.loadedInto || 'system_prompt.memory',
                },
              };
            }
          }
          const updates = {};
          for (const item of resident) {
            const rawScope = item && typeof item.scope === 'string' ? item.scope : null;
            const sessionScope = rawScope && /^sessions\/[^/]+$/.test(rawScope)
              ? rawScope
              : (rawScope && /^group\/[^/]+$/.test(rawScope)
                ? `sessions/${rawScope.slice('group/'.length)}`
                : null);
            if (!sessionScope) continue;
            updates[sessionScope] = {
              scope: sessionScope,
              sourceScope: rawScope,
              sessionId: sessionScope.slice('sessions/'.length),
              turnId: event.turnId || null,
              vpId: event.vpId || null,
              loadedInto: event.loadedInto || 'system_prompt.memory',
              summary: item.summary || '',
              truncated: !!item.truncated,
              receivedAt: Date.now(),
            };
          }
          if (Object.keys(updates).length > 0) {
            this.yeaftDreamPromptLoads = { ...this.yeaftDreamPromptLoads, ...updates };
          }
          break;
        }

        case 'memory_adjust': {
          if (!event.turnId) break;
          const prev = this.yeaftDebugTurnsById[event.turnId];
          if (!prev) break;
          this.yeaftDebugTurnsById = {
            ...this.yeaftDebugTurnsById,
            [event.turnId]: {
              ...prev,
              memoryAdjust: {
                sessionKey: event.sessionKey || null,
                added: event.added || 0,
                evicted: event.evicted || 0,
                skipped: event.skipped || 0,
                reason: event.reason || '',
              },
            },
          };
          break;
        }

        case 'tool_exec': {
          // feat-6af5f9f1 PR B: pin the tool execution to its turn so the
          // panel can show per-tool timing without scanning loops.messages.
          if (!event.turnId) break;
          const prev = this.yeaftDebugTurnsById[event.turnId];
          if (!prev) break;
          // Live events are only a progress index. Full tool output belongs to
          // the persisted per-Turn trace and is loaded when the debug panel is
          // opened; retaining legacy Agent payloads here can exhaust the tab.
          const tools = [...(prev.tools || []), {
            loopNumber: event.loopNumber || 0,
            callId: event.callId || null,
            name: event.name || '?',
            durationMs: event.durationMs || 0,
            isError: !!event.isError,
          }];
          this.yeaftDebugTurnsById = {
            ...this.yeaftDebugTurnsById,
            [event.turnId]: { ...prev, tools },
          };
          break;
        }

        case 'loop': {
          // feat-6af5f9f1 PR B: replaces `debug_turn`. Each entry is one
          // LLM call; the parent Turn record lives in yeaftDebugTurnsById
          // under loop.turnId.
          // Keep the always-on live cache metadata-only. Complete prompts,
          // messages, responses, tool calls, and raw exchanges are persisted in
          // DebugTrace and fetched for exactly one Turn when the user opens its
          // panel. This also protects upgraded web clients from legacy Agents
          // that still send the former multi-MiB live payload shape.
          this.yeaftDebugLoops.push({
            turnId: event.turnId || null,
            loopNumber: event.loopNumber || 0,
            model: event.model,
            usage: event.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            latencyMs: event.latencyMs,
            ttfbMs: event.ttfbMs,
            stopReason: event.stopReason,
            // feat-debug-timestamp: epoch ms when this LLM call ended
            // (stamped by the engine). Used by the panel to render
            // per-loop HH:MM:SS in the loop header row. Falls back to
            // null for legacy loops missing the field — the panel
            // computes a derived time from turn.openedAt in that case.
            at: typeof event.at === 'number' ? event.at : null,
            // Bug 3 carry-over: stamp sessionId so the panel filter narrows
            // by session. Falls back to envelope groupId if engine omitted it.
            sessionId: msg.sessionId || null,
            vpId: msg.vpId || event.vpId || null,
          });
          // fix-debug-copy-no-truncate: bound retention by count.
          // Drop oldest loop entries when the cap is exceeded, then
          // garbage-collect any turn record whose loops are all gone
          // (so yeaftDebugTurnsById / yeaftDebugTurnOrder don't grow
          // unboundedly either). This is the architectural counterpart
          // to removing per-payload truncation: payloads are kept
          // verbatim, but we keep at most MAX_YEAFT_DEBUG_LOOPS of them.
          //
          // IMPORTANT under multi-VP parallel ingest: a turn opened by
          // VP-A whose first loop hasn't arrived yet has no entry in
          // surviving loops. If VP-B's flood trips the cap right then,
          // we must NOT evict VP-A's still-open turn — its first loop
          // would arrive orphaned and silently disappear from the
          // panel, defeating the whole "verbatim debug" point. Open
          // turns (closedAt == null) are always retained.
          //
          // Logic lives in helpers/debug-retention.js so it's
          // unit-testable without Pinia/Vue globals.
          if (this.yeaftDebugLoops.length > MAX_YEAFT_DEBUG_LOOPS) {
            const next = trimDebugRetention({
              loops: this.yeaftDebugLoops,
              turnsById: this.yeaftDebugTurnsById,
              turnOrder: this.yeaftDebugTurnOrder,
              maxLoops: Math.max(MAX_YEAFT_DEBUG_LOOPS, this.yeaftDebugHistoryLimit || 0),
            });
            this.yeaftDebugLoops = next.loops;
            this.yeaftDebugTurnsById = next.turnsById;
            this.yeaftDebugTurnOrder = next.turnOrder;
          }
          break;
        }

        case 'llm_retry': {
          if (!msg.turnId) break;
          const turnKey = yeaftTurnStateKey(this, msg.agentId || null, msg.turnId);
          const active = this.activeVpTurns?.[turnKey];
          if (!active) break;
          const retryReason = event.reason === 'stream_idle_timeout'
            ? 'stream_idle_timeout'
            : 'transient_error';
          this.activeVpTurns = {
            ...this.activeVpTurns,
            [turnKey]: {
              ...active,
              retryAttempt: event.attempt || 0,
              retryMax: event.maxRetries || 0,
              retryDelayMs: event.delayMs || 0,
              retryReason,
              retryRecoveryMode: event.recoveryMode || 'restart',
            },
          };
          break;
        }

        case 'recall':
        case 'consolidate':
        case 'fallback':
        case 'thinking_delta':
          // Future: display these in UI
          break;

        // VP-block redesign (2026-05-08): the three Track-A / FeaturePill
        // intake handlers (`quick_preview`, `feature_started`,
        // `feature_completed`) have been removed alongside the FeatureArc
        // backend. The agent no longer emits these events; if any future
        // emitter needs feature attribution, it should ride directly on
        // the existing `featureId` envelope field that's already
        // propagated through `addMessageToConversation`.

        case 'reflection': {
          // PR-L: V7 tool-history reflection. Two phases per occurrence
          // (pending → ready) plus an error phase if generation fails.
          // We store the latest state keyed by conversationId + trigger
          // + loopRange so the UI can swap "thinking…" placeholder for
          // the rendered card.
          const convId = resolveYeaftEnvelopeConversationId(this, msg.agentId || null, msg.conversationId) || 'unknown';
          const range = Array.isArray(event.loopRange) ? event.loopRange : [0, 0];
          const key = `${convId}:${event.trigger}:${range[0]}-${range[1]}`;
          // Anchor the card to the current tail of the message list so
          // MessageList can render it inline (right after the last
          // message present at arrival time). Latch on first emit
          // (`pending`); preserve across `ready`/`error` transitions so
          // the card doesn't jump position when the body fills in.
          const existing = this.yeaftReflectionCards[key];
          const tailMsgs = this.messagesMap[convId] || [];
          const anchorMsgId = existing
            ? existing.anchorMsgId
            : (tailMsgs.length > 0 ? tailMsgs[tailMsgs.length - 1].id || null : null);
          const anchorOrder = existing
            ? existing.anchorOrder
            : tailMsgs.length;
          this.yeaftReflectionCards = {
            ...this.yeaftReflectionCards,
            [key]: {
              key,
              conversationId: convId,
              // feat-6af5f9f1 PR B: stamp turnId so the debug panel can
              // attach the card to its parent Turn.
              turnId: event.turnId || (existing && existing.turnId) || null,
              loopNumber: event.loopNumber || (existing && existing.loopNumber) || null,
              trigger: event.trigger,
              status: event.status,
              loopRange: range,
              toolCount: event.toolCount || 0,
              content: event.content || '',
              durationMs: event.durationMs || 0,
              error: event.error || null,
              sessionId: msg.sessionId || null,
              anchorMsgId,
              anchorOrder,
              updatedAt: Date.now(),
            },
          };
          break;
        }

        case 'model_switched':
          this.yeaftModel = event.model;
          this.yeaftModelEffort = event.modelEffort || null;
          break;

        case 'yeaft_task_event': {
          const task = event.task;
          if (!task?.id || !task.sessionId) break;
          const taskAgentId = msg.agentId || resolveAgentIdForSession(this, task.sessionId);
          const taskSessionKey = yeaftHistoryIdentityKey(taskAgentId, task.sessionId);
          const scopedTask = { ...task, agentId: taskAgentId };
          const bySession = { ...this.yeaftActiveTasksBySession };
          const current = { ...(bySession[taskSessionKey] || {}) };
          if (task.status === 'running') {
            current[task.id] = scopedTask;
          } else {
            delete current[task.id];
          }
          const retained = keepRunningSessionTasks(current);
          if (Object.keys(retained).length > 0) bySession[taskSessionKey] = retained;
          else delete bySession[taskSessionKey];
          this.yeaftActiveTasksBySession = bySession;
          if (task.status !== 'running') {
            const { [taskStopKey(taskAgentId, task.sessionId, task.id)]: _done, ...rest } = this.yeaftStoppingTasksById || {};
            this.yeaftStoppingTasksById = rest;
          }
          break;
        }

        case 'yeaft_task_cancel_result': {
          const taskId = event.taskId || event.task?.id || null;
          const sessionId = event.task?.sessionId || event.sessionId || msg.sessionId || null;
          const taskAgentId = msg.agentId || resolveAgentIdForSession(this, sessionId);
          if (taskId && sessionId && event.success === false) {
            const { [taskStopKey(taskAgentId, sessionId, taskId)]: _done, ...rest } = this.yeaftStoppingTasksById || {};
            this.yeaftStoppingTasksById = rest;
          }
          const task = event.task;
          if (task?.id && task.sessionId) {
            const taskSessionKey = yeaftHistoryIdentityKey(taskAgentId, task.sessionId);
            const bySession = { ...this.yeaftActiveTasksBySession };
            const current = { ...(bySession[taskSessionKey] || {}) };
            if (task.status === 'running') current[task.id] = { ...task, agentId: taskAgentId };
            else delete current[task.id];
            const retained = keepRunningSessionTasks(current);
            if (Object.keys(retained).length > 0) bySession[taskSessionKey] = retained;
            else delete bySession[taskSessionKey];
            this.yeaftActiveTasksBySession = bySession;
          }
          break;
        }

        case 'sub_agent_event': {
          // PR-M3: a sub-agent emitted an event. `agentId` identifies the
          // sub-agent; `payload` is the underlying engine event (text_delta,
          // tool_call, sub_agent_status, sub_agent_turn_end, etc.).
          // We accumulate per-agent state into a single card keyed by
          // ${convId}:${agentId} — anchored to the message present at the
          // first emit so MessageList can render it inline.
          const convId = resolveYeaftEnvelopeConversationId(this, msg.agentId || null, msg.conversationId) || 'unknown';
          const agentId = event.agentId;
          if (!agentId) break;
          const payload = event.payload || {};
          const key = `${convId}:${agentId}`;
          const existing = this.yeaftSubAgentCards[key];
          const tailMsgs = this.messagesMap[convId] || [];
          const anchorMsgId = existing
            ? existing.anchorMsgId
            : (tailMsgs.length > 0 ? tailMsgs[tailMsgs.length - 1].id || null : null);
          const anchorOrder = existing ? existing.anchorOrder : tailMsgs.length;

          const next = existing ? { ...existing } : {
            key,
            conversationId: convId,
            agentId,
            agentName: payload.agentName || 'sub-agent',
            status: 'running',
            text: '',
            toolCallCount: 0,
            turns: 0,
            error: null,
            expanded: false,
            anchorMsgId,
            anchorOrder,
            updatedAt: Date.now(),
            sessionId: msg.sessionId || null,
            // (2026-05-13) featureId removed along with the Feature system.
          };

          if (payload.agentName && !next.agentName) next.agentName = payload.agentName;

          switch (payload.type) {
            case 'sub_agent_status':
              next.status = payload.status || next.status;
              if (payload.error) next.error = payload.error;
              break;
            case 'text_delta':
              // Sub-agent text is intentionally delivered as one complete
              // result via sub_agent_turn_end. Older agents may still emit
              // deltas; ignore them here so the card doesn't present a
              // partial streamed answer as the final result.
              break;
            case 'tool_use':
            case 'tool_call':
              next.toolCallCount = Number(next.toolCallCount || 0) + 1;
              break;
            case 'tool_start':
              break;
            case 'tool_result':
            case 'tool_end':
              break;
            case 'sub_agent_turn_end': {
              next.turns += 1;
              const content = typeof payload.content === 'string' ? payload.content.trim() : '';
              if (content) next.text = next.text ? `${next.text}\n\n${content}` : content;
              if (next.status !== 'failed' && next.status !== 'closed') {
                next.status = payload.status || 'idle';
              }
              break;
            }
            case 'error':
              if (payload.error) {
                next.error = payload.error.message || String(payload.error);
              }
              break;
            default:
              break;
          }

          next.updatedAt = Date.now();
          this.yeaftSubAgentCards = { ...this.yeaftSubAgentCards, [key]: next };
          break;
        }

        case 'history_loaded':
          {
            const historyResponse = {
              ...event,
              agentId: msg.agentId || null,
              requestId: event.requestId || msg.requestId || null,
            };
            if (historyResponse.requestId && !this.isCurrentYeaftHistoryResponse(historyResponse)) break;
            const responseAgentId = msg.agentId || null;
            const responseSessionId = event.sessionId ?? null;
            const sessionKey = yeaftHistoryIdentityKey(responseAgentId, responseSessionId);
            const traceId = msg.perfTraceId || this.yeaftHistoryPerfTraceBySession?.[sessionKey];
            if (traceId) {
            recordPerfTrace(this, {
              traceId,
              phase: 'history.loaded_event',
              agentId: msg.agentId || null,
              sessionId: event.sessionId || null,
              messageType: event.type,
              detail: { mode: event.mode || 'recent', count: event.count || 0, hasMore: !!event.hasMore },
            });
            }
          // History messages already rendered via assistant output frame data path.
          // This event just signals completion + carries cursors:
          //   mode:'recent' (default) — full pane replay; stamp oldestSeq /
          //     hasMore for the "Load older" hint AND latestSeq so the next
          //     re-entry can ask for a delta.
          //   mode:'delta' — incremental append; only latestSeq is meaningful.
          //     Don't touch hasMore / oldestSeq (those describe the older
          //     end and don't change on a delta tail-load).
            const mode = event.mode === 'delta' ? 'delta' : 'recent';
            const prevState = this.yeaftSessionHistoryState[sessionKey] || {};
            const nextLatest = (Number.isFinite(event.latestSeq) ? event.latestSeq
              : (Number.isFinite(prevState.latestSeq) ? prevState.latestSeq : null));
            const recentFrontier = Number.isFinite(event.nextBeforeSeq)
              ? event.nextBeforeSeq
              : (Number.isFinite(event.oldestSeq)
                ? event.oldestSeq
                : (Number.isFinite(prevState.serverOldestFetchedSeq)
                  ? prevState.serverOldestFetchedSeq
                  : (Number.isFinite(prevState.oldestSeq) ? prevState.oldestSeq : null)));
            const nextState = mode === 'delta'
              ? {
                  ...prevState,
                  loaded: true,
                  loading: false,
                  latestSeq: nextLatest,
                  syncingAfterSeq: null,
                  count: (prevState.count || 0) + (event.count || 0),
                }
              : {
                  ...prevState,
                  loaded: true,
                  loading: false,
                  hasMore: !!event.hasMore,
                  serverHasMore: !!event.hasMore,
                  oldestSeq: recentFrontier,
                  serverOldestFetchedSeq: recentFrontier,
                  count: (typeof event.count === 'number') ? event.count : 0,
                  latestSeq: nextLatest,
                  syncingAfterSeq: null,
                };
            const completedState = historyResponse.requestId
              ? this.finishYeaftHistoryLoad(historyResponse, nextState, 'completion')
              : null;
            if (!completedState) {
              this.yeaftSessionHistoryState = {
                ...this.yeaftSessionHistoryState,
                [sessionKey]: nextState,
              };
            }
            const activeKey = yeaftHistoryIdentityKey(
              responseAgentId ? this.currentAgent : null,
              this.yeaftActiveSessionFilter ?? null,
            );
            if (sessionKey === activeKey) {
              if (mode === 'recent') {
                this.yeaftHasMoreHistory = nextState.hasMore;
                this.yeaftOldestLoadedSeq = nextState.serverOldestFetchedSeq;
              }
              this.yeaftLoadingMoreHistory = !!completedState?.loading;
            } else if (this.yeaftLoadingMoreHistory) {
              const activeState = this.yeaftSessionHistoryState[activeKey] || null;
              this.yeaftLoadingMoreHistory = !!activeState?.loading;
            }
          }
          break;

        // ★ task-334-ui-a + 334h: VP library snapshot + live diff.
        case 'vp_snapshot': {
          // Lazy import to avoid circular dep at module load.
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          // fix-session-restore-modal-unify: thread `msg.agentId` (server
          // stamps it on the yeaft_output envelope at agent-output relay)
          // so the store can track which agent the cached roster belongs
          // to and the modal can detect agent switches that need a
          // fresh subscribe.
          if (vp) vp.applySnapshot(event, msg.agentId || null, msg.requestId || null);
          break;
        }
        case 'vp_snapshot_error': {
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp) vp.failSnapshot(msg.agentId || null, msg.requestId || null, event.error || event.message || 'VP library request failed');
          break;
        }
        case 'vp_updated': {
          // task-334h: live diff. `event.reason` (persona.edit / traits.edit /
          // manual.reload) is surfaced through the store for 334-ui-b badge
          // refresh cues. Missing reason is tolerated (back-compat).
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp && event.vp) vp.upsert(event.vp, event.reason, msg.agentId || null);
          break;
        }
        case 'vp_removed': {
          // task-334h: live diff. Reason is always 'file.removed' on-wire.
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp && event.vpId) vp.remove(event.vpId, event.reason, msg.agentId || null);
          break;
        }

        // ★ task-334-ui-g: CRUD ack. Each pending request resolves via the
        // requestId map set up by `vpCrudRequest`.
        case 'vp_crud_result': {
          const pending = this._vpCrudPending && this._vpCrudPending.get(event.requestId);
          if (pending) {
            this._vpCrudPending.delete(event.requestId);
            pending.resolve({
              ok: !!event.ok,
              op: event.op,
              vpId: event.vpId,
              vp: event.vp,
              error: event.error || null,
            });
          }
          break;
        }

        // ★ task-334m: Group snapshot + roster delta + CRUD ack.
        case 'group_list_updated':
        case 'session_list_updated':
        case 'yeaft_session_hydrate': {
          // fix-yeaft-session-server-persistence: `yeaft_session_hydrate`
          // is the server-side replay on get_agents — payload shape
          // matches a snapshot but the message arrives before any agent
          // has gone through `session_ready`, so the unified sidebar can
          // render the user's full cross-agent yeaft session list on
          // reload before any agent connects.
          const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
          const rows = event.sessions || [];
          if (event.projectsAuthoritative === true && Array.isArray(event.projects)) {
            this.applySessionCatalogSnapshot(this.sessionCatalog, event.projects);
          } else if (Array.isArray(event.projects) && msg.agentId) {
            this.applyLegacyProjectSnapshot(event.projects, msg.agentId);
          }
          if (event.type !== 'yeaft_session_hydrate'
              && this.yeaftSessionHydrateRequestId
              && this.yeaftSessionInventoryCompleteSupported === true) {
            const slices = Array.isArray(this.yeaftSessionHydrateSlices)
              ? this.yeaftSessionHydrateSlices.filter(slice => slice.agentId !== (msg.agentId || null))
              : [];
            this.yeaftSessionHydrateSlices = [...slices, {
              agentId: msg.agentId || null,
              sessions: rows,
            }];
            break;
          }
          const prevGroupId = gs ? (gs.activeSessionId || null) : null;
          const prevAgentId = gs?.activeSessionKey
            ? gs.sessions?.[gs.activeSessionKey]?.agentId || null
            : null;
          // msg.agentId is stamped on yeaft_output envelopes by the
          // server relay (since v0.1.882). Pass it through so the
          // sessions store can keep per-agent rosters in the unified
          // sidebar. Older agents/servers omit the field — the store
          // falls back to the legacy whole-replacement path.
          if (gs) {
            gs.applySnapshot(rows, msg.agentId || null);
            this._hasHandledYeaftSessionHydrate = true;
            this.yeaftSessionHydrateError = null;
          }
          const newGroupId = gs ? (gs.activeSessionId || null) : null;
          const newAgentId = gs?.activeSessionKey
            ? gs.sessions?.[gs.activeSessionKey]?.agentId || null
            : null;
          // Bug 1: after enterYeaft the group snapshot may arrive *after*
          // initial history load (which happened with groupId:null), so
          // reload history for the correct group when activeGroupId changes.
          if (this.currentView === 'yeaft' && newGroupId) {
            const targetAgentId = newAgentId || resolveAgentIdForSession(this, newGroupId, msg.agentId || null);
            const sessionKey = yeaftHistoryIdentityKey(targetAgentId, newGroupId);
            const sessionState = this.yeaftSessionHistoryState[sessionKey] || null;
            this.setActiveSessionFilter(newGroupId, {
              agentId: targetAgentId,
              force: prevAgentId !== targetAgentId
                || msgHelpers.shouldForceHydrateActiveYeaftSession(newGroupId, prevGroupId, sessionState),
            });
          }
          break;
        }
        case 'group_roster_changed':
        case 'session_roster_changed': {
          const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
          if (gs) gs.applyRosterChange(event, msg.agentId || null);
          break;
        }
        case 'group_crud_result':
        case 'session_crud_result': {
          const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
          // applyCrudResult above receives agentId via the second argument
          // (out-of-band). The promise path below carries agentId on the
          // payload itself because callers await a single flattened object
          // and have no envelope context. Keep these two channels in sync
          // if you change the wire-stamping rule.
          if (gs) gs.applyCrudResult(event, msg.agentId || null);
          if (event.ok && event.op === 'delete' && event.sessionId && msg.agentId) {
            this.clearYeaftHistoryMemory({
              agentId: msg.agentId,
              sessionId: event.sessionId,
            });
          }
          const pending = this._sessionCrudPending && this._sessionCrudPending.get(event.requestId);
          if (pending) {
            const finish = () => {
              if (this._sessionCrudPending?.get(event.requestId) !== pending) return;
              this._sessionCrudPending.delete(event.requestId);
              // fix-yeaft-create-not-opened: the agent's session meta payload
              // does NOT carry an `agentId` field (the agent doesn't know its
              // own server-assigned id). The server stamps `msg.agentId` on
              // the envelope, but if we resolve the promise with the bare
              // `event.session`, the modal's `created.agentId` is undefined
              // and the cross-agent `selectAgent(owner)` short-circuits —
              // leaving `currentAgent` on the wrong agent so the new session
              // appears to "not open / not show up on the right side".
              // Stamp the envelope's agentId onto the resolved group payload
              // so callers see a wire-coherent shape. Agent payload wins if
              // it ever does start stamping (non-empty values only — an
              // empty-string agentId is treated as absent).
              const rawSession = event.session || event.group || null;
              const sessionWithAgent = (rawSession && msg.agentId && !rawSession.agentId)
                ? { ...rawSession, agentId: msg.agentId }
                : rawSession;
              const resolvedSessionId = event.sessionId || null;
              const resolvedSessionList = event.sessions || null;
              pending.resolve({
                ok: !!event.ok,
                op: event.op,
                session: sessionWithAgent,
                sessionId: resolvedSessionId,
                sessions: resolvedSessionList,
                config: event.config || null,
                error: event.error || null,
              });
            };
            void finish();
          }
          break;
        }

        // ★ task-301 Part 2: real-store push from agent.
        // H2.f.6: thread_list_updated never arrives anymore — bridge stopped
        // emitting. Case removed; legacy replay would silently fall through.

        // (2026-05-13) `yeaft_summary_history` / `yeaft_feature_crud_result`
        // cases removed along with the Feature system.

        // H2.f.6: thread_merged / thread_forked / *_failed cases removed —
        // bridge no longer emits them.

        // task-fix: per-VP typing indicator (group chat only).
        //   vp_typing_start → increment yeaftVpTyping[vpId]
        //   vp_typing_end   → decrement; delete when 0 so the getter lookup
        //                     returns falsy without retaining dead keys.
        // We use `{ ...obj }` reassignment to ensure Pinia/Vue picks up the
        // change (the state is declared as a plain object, not reactive
        // per-key). Cheap because it only holds entries for VPs currently
        // typing — usually 0–5.
        case 'vp_turn_start': {
          if (!event.turnId || !event.vpId) break;
          const turnKey = yeaftTurnIdentityKey(msg.agentId || null, event.turnId) || event.turnId;
          this.activeVpTurns = {
            ...this.activeVpTurns,
            [turnKey]: {
              agentId: msg.agentId || null,
              turnId: event.turnId,
              vpId: event.vpId,
              sessionId: event.sessionId || null,
              threadId: event.threadId || null,
              isStreaming: true,
              startedAt: event.ts || Date.now(),
            },
          };
          if (event.sessionId) {
            const processingKey = yeaftSessionIdentityKey(msg.agentId || null, event.sessionId);
            this.yeaftProcessingSessions = {
              ...this.yeaftProcessingSessions,
              ...(processingKey ? { [processingKey]: true } : { [event.sessionId]: true }),
            };
          }
          break;
        }
        case 'vp_turn_end': {
          if (!event.turnId) break;
          const turnKey = yeaftTurnStateKey(this, msg.agentId || null, event.turnId);
          const endedSessionId = event.sessionId || this.activeVpTurns?.[turnKey]?.sessionId || null;
          if (event.reason === 'end_turn' && endedSessionId) {
            this.markYeaftSessionUnread(endedSessionId, msg.agentId || null);
          }
          const { [turnKey]: _removed, ...rest } = this.activeVpTurns;
          this.activeVpTurns = rest;
          const { [turnKey]: _stopped, ...stoppingRest } = this.stoppingVpTurnIds;
          this.stoppingVpTurnIds = stoppingRest;
          const terminalSessionId = event.sessionId || _removed?.sessionId || null;
          const terminalAgentId = msg.agentId || _removed?.agentId || null;
          const terminalVpId = event.vpId || _removed?.vpId || null;
          const hasSiblingVpTurn = terminalSessionId && terminalVpId
            ? Object.values(this.activeVpTurns || {}).some((info) => (
                info?.vpId === terminalVpId
                && matchesYeaftRuntimeIdentity(info, terminalSessionId, terminalAgentId)
              ))
            : false;
          if (!hasSiblingVpTurn && terminalSessionId && terminalVpId) {
            const nextStatuses = { ...(this.vpStatuses || {}) };
            let statusMutated = false;
            for (const [key, status] of Object.entries(nextStatuses)) {
              if (status?.vpId !== terminalVpId) continue;
              if (!matchesYeaftRuntimeIdentity(status, terminalSessionId, terminalAgentId)) continue;
              if (!YEAFT_RUNNING_VP_STATES.has(status.state)) continue;
              nextStatuses[key] = {
                ...status,
                state: 'idle',
                turnId: null,
                since: event.ts || Date.now(),
              };
              statusMutated = true;
            }
            if (statusMutated) this.vpStatuses = nextStatuses;
          }
          this.clearYeaftSessionProcessingIfIdle(terminalSessionId, { agentId: terminalAgentId });
          // Per-message lifecycle: flip every in-flight assistant message
          // owned by this VP/turn from 'pending' to the terminal status
          // carried on `event.reason` (end_turn → completed; route_forward
          // → completed; aborted → aborted; errored → errored). VP status
          // is a separate axis — this is the source of truth for "is this
          // assistant turn done".
          const reasonToStatus = {
            end_turn: 'completed',
            route_forward: 'completed',
            aborted: 'aborted',
            errored: 'errored',
            error: 'errored',
            cancelled: 'cancelled',
            canceled: 'cancelled',
          };
          const nextStatus = reasonToStatus[event.reason] || 'completed';
          const stampedAt = Date.now();
          const conv = resolveYeaftEnvelopeConversationId(this, msg.agentId || null, msg.conversationId);
          if (conv && Array.isArray(this.messagesMap[conv])) {
            const rows = this.messagesMap[conv];
            let mutated = markTurnResponseKinds(rows, event);
            // Stamp EVERY pending assistant row owned by this turn — not
            // just the last. A turn that produced multiple assistant
            // rows (text, then tool_use, then more text) needs all of
            // them flipped, or earlier rows sit in 'pending' forever.
            // Walk forward from the user message that opened this turn
            // for determinism; reducer is idempotent so order doesn't
            // strictly matter, but forward walk keeps the per-row
            // semantics readable when debugging.
            for (let i = 0; i < rows.length; i++) {
              const m = rows[i];
              if (!m || m.type !== 'assistant') continue;
              const mSessionId = m.sessionId ?? m.groupId;
              if (event.sessionId && mSessionId && mSessionId !== event.sessionId) continue;
              if (event.vpId && m.speakerVpId && m.speakerVpId !== event.vpId) continue;
              if (event.turnId && m.turnId && m.turnId !== event.turnId) continue;
              if (m.status && m.status !== 'pending') continue;
              m.status = nextStatus;
              m.turnEndAt = stampedAt;
              m.turnEndReason = event.reason || null;
              if (event.detail) m.turnEndDetail = event.detail;
              if (Number.isFinite(event.durationMs)) m.turnDurationMs = event.durationMs;
              mutated = true;
            }
            if (mutated) this.messagesMap = { ...this.messagesMap, [conv]: rows.slice() };
            // The provider `result` normally arrives first, but metadata is the
            // guaranteed terminal boundary for every VP. Re-prune idempotently
            // here so dropped/reordered data frames cannot leave live rows
            // resident forever.
            this.pruneConversationMessageRetention(conv, terminalSessionId, terminalAgentId);
          }
          break;
        }
        case 'yeaft_turn_aborted': {
          const explicitTurnIds = Array.isArray(event.turnIds) ? event.turnIds.filter(Boolean) : [];
          if (event.turnId) explicitTurnIds.push(event.turnId);
          const targetSessionId = event.sessionId || null;
          const targetVpId = event.vpId || null;
          const removeIds = new Set();
          for (const turnId of explicitTurnIds) {
            const turnKey = yeaftTurnStateKey(this, msg.agentId || null, turnId);
            const row = this.activeVpTurns?.[turnKey] || null;
            if (!row || matchesYeaftRuntimeIdentity(row, row.sessionId, msg.agentId || null)) removeIds.add(turnKey);
          }
          if (targetVpId) {
            for (const [turnId, info] of Object.entries(this.activeVpTurns || {})) {
              if (!info || info.vpId !== targetVpId) continue;
              if (!matchesYeaftRuntimeIdentity(info, targetSessionId, msg.agentId || null)) continue;
              removeIds.add(turnId);
            }
          }
          if (removeIds.size === 0) break;
          let removedSessionId = targetSessionId;
          const activeRest = { ...(this.activeVpTurns || {}) };
          const stoppingRest = { ...(this.stoppingVpTurnIds || {}) };
          for (const turnId of removeIds) {
            const removed = activeRest[turnId];
            if (!removedSessionId && removed?.sessionId) removedSessionId = removed.sessionId;
            delete activeRest[turnId];
            delete stoppingRest[turnId];
          }
          this.activeVpTurns = activeRest;
          this.stoppingVpTurnIds = stoppingRest;
          this.clearYeaftSessionProcessingIfIdle(removedSessionId || null, { agentId: msg.agentId || null });
          break;
        }
        case 'yeaft_aborted': {
          const sessionId = event.sessionId || msg.sessionId || null;
          if (sessionId) {
            this.activeVpTurns = Object.fromEntries(
              Object.entries(this.activeVpTurns || {}).filter(([, info]) => (
                !matchesYeaftRuntimeIdentity(info, sessionId, msg.agentId || null)
              ))
            );
            this.stoppingVpTurnIds = Object.fromEntries(
              Object.entries(this.stoppingVpTurnIds || {}).filter(([turnId]) => this.activeVpTurns?.[turnId])
            );
            this.vpStatuses = Object.fromEntries(
              Object.entries(this.vpStatuses || {}).filter(([, status]) => (
                !matchesYeaftRuntimeIdentity(status, sessionId, msg.agentId || null)
              ))
            );
            this.clearYeaftSessionProcessingIfIdle(sessionId, {
              agentId: msg.agentId || null,
              ignoreStatuses: true,
            });
          } else if (event.all) {
            clearYeaftAgentRuntimeState(this, msg.agentId || null);
          }
          break;
        }
        // vp_typing_* coexists with vp_status_changed on purpose. They serve
        // two different display surfaces with different lifetimes:
        //   - `vp_typing_start` / `vp_typing_end` drive the three-dot
        //     animation next to a VP's avatar inside an *in-flight assistant
        //     bubble* (VpSpeakerHeader). It's a refcount because overlapping
        //     enqueues to the same VP should keep the dots on continuously.
        //   - `vp_status_changed` drives the *VP timeline pane* row label
        //     (typing / thinking / streaming / tool / error / offline). It's
        //     a state machine, not a refcount — exactly one state per VP.
        // Folding them into one event would force the timeline pane to
        // re-derive "is the dot animating?" from the state machine, and
        // would force the avatar dots to round-trip through a state that
        // doesn't care about overlap. Cheaper to keep them as two thin
        // streams over the same wire.
        case 'vp_typing_start': {
          if (!event.vpId) break;
          // Nest by conversationId so Yeaft typing state never leaks into
          // the Chat view (cross-mode state leak). The conversationId rides
          // on the yeaft_output envelope (msg.conversationId) — fall back to
          // the current Yeaft session id if absent.
          const convId = resolveYeaftEnvelopeConversationId(this, msg.agentId || null, msg.conversationId);
          if (!convId) break;
          this.yeaftVpTyping = incVpTyping(this.yeaftVpTyping, convId, event.vpId);
          break;
        }
        case 'vp_typing_end': {
          if (!event.vpId) break;
          const convId = resolveYeaftEnvelopeConversationId(this, msg.agentId || null, msg.conversationId);
          if (!convId) break;
          this.yeaftVpTyping = decVpTyping(this.yeaftVpTyping, convId, event.vpId);
          break;
        }

        // vp-status (2026-05-15): authoritative status from the agent
        // broker. We mirror the row into `this.vpStatuses` and let the
        // vp-timeline helper read from there. No reverse-inference from
        // `messages[].isStreaming` any more — that flag is a UI artifact
        // and was the root cause of the "stuck on streaming" bug.
        //
        // The Web adds the Agent id to the broker's Session + VP key because
        // it aggregates multiple Agent brokers in one state table.
        case 'vp_status_changed': {
          if (!event.vpId || !event.state) break;
          if (eventConversationId) {
            const owner = yeaftWatchdogOwner(phaseEvent);
            if (event.state === 'thinking' || event.state === 'retrying' || event.state === 'tool') {
              watchdogHelpers.pauseYeaftWatchdog(
                this,
                eventConversationId,
                `${event.state}:${owner}`,
              );
            } else if (event.state === 'streaming' || event.state === 'idle' || event.state === 'error') {
              for (const phase of ['thinking', 'retrying', 'tool']) {
                watchdogHelpers.resumeYeaftWatchdog(this, eventConversationId, `${phase}:${owner}`);
              }
            }
          }
          const sessionId = event.sessionId || null;
          const agentId = msg.agentId || null;
          const k = vpStatusKey(agentId, sessionId, event.vpId);
          const nextStatus = {
            agentId,
            state: event.state,
            since: event.since || Date.now(),
            turnId: event.turnId || null,
            title: event.title || '',
            sessionId,
            vpId: event.vpId,
          };
          this.vpStatuses = {
            ...this.vpStatuses,
            [k]: nextStatus,
          };
          if (sessionId && YEAFT_RUNNING_VP_STATES.has(event.state)) {
            const processingKey = yeaftSessionIdentityKey(agentId, sessionId);
            this.yeaftProcessingSessions = {
              ...this.yeaftProcessingSessions,
              ...(processingKey ? { [processingKey]: true } : { [sessionId]: true }),
            };
          } else if (sessionId) {
            this.clearYeaftSessionProcessingIfIdle(sessionId, { agentId });
          }
          this.restoreActiveYeaftSessionFromStatuses([nextStatus], agentId);
          break;
        }
        case 'vp_status_snapshot': {
          // Bulk hydrate. Snapshot scoping (see broker JSDoc):
          //   - sessionId == null → unscoped, replace the WHOLE table.
          //     This is what session_ready / reset broadcasts use, so
          //     the frontend's mirror always matches the agent's table
          //     after a reconnect.
          //   - sessionId === '<id>' → scoped, replace just that session's
          //     slice. Other sessions' entries survive.
          const statuses = Array.isArray(event.statuses) ? event.statuses : [];
          const eventSessionId = event.sessionId;
          if (eventSessionId == null) {
            const next = { ...(this.vpStatuses || {}) };
            if (msg.agentId) {
              for (const [k, row] of Object.entries(next)) {
                if (!row?.agentId || row.agentId === msg.agentId) delete next[k];
              }
            } else {
              for (const k of Object.keys(next)) delete next[k];
            }
            for (const row of statuses) {
              if (!row || !row.vpId) continue;
              const rowSessionId = row.sessionId || row.groupId || null;
              const k = vpStatusKey(msg.agentId || null, rowSessionId, row.vpId);
              next[k] = {
                agentId: msg.agentId || null,
                state: row.state,
                since: row.since || Date.now(),
                turnId: row.turnId || null,
                title: row.title || '',
                sessionId: rowSessionId,
                vpId: row.vpId,
              };
            }
            this.vpStatuses = next;
          } else {
            const merged = { ...this.vpStatuses };
            // Drop every existing row for this sessionId, regardless of
            // the map's internal key. Iterating by entry.sessionId (not
            // by key shape) means a stray null-session leak in the table
            // doesn't haunt subsequent scoped reconnects.
            for (const [k, v] of Object.entries(merged)) {
              if (v && v.sessionId === eventSessionId
                  && (!msg.agentId || !v.agentId || v.agentId === msg.agentId)) delete merged[k];
            }
            for (const row of statuses) {
              if (!row || !row.vpId) continue;
              const rowSessionId = row.sessionId || row.groupId || null;
              const k = vpStatusKey(msg.agentId || null, rowSessionId, row.vpId);
              merged[k] = {
                agentId: msg.agentId || null,
                state: row.state,
                since: row.since || Date.now(),
                turnId: row.turnId || null,
                title: row.title || '',
                sessionId: rowSessionId,
                vpId: row.vpId,
              };
            }
            this.vpStatuses = merged;
          }
          this.yeaftProcessingSessions = projectYeaftProcessingSnapshot(
            this,
            msg.agentId || null,
            statuses,
            eventSessionId == null ? null : eventSessionId,
          );
          this.restoreActiveYeaftSessionFromStatuses(statuses, msg.agentId || null);
          break;
        }

        case 'yeaft_dream_snapshot': {
          const snapshot = event && event.snapshot;
          const scope = snapshot && typeof snapshot.scope === 'string' ? snapshot.scope : null;
          if (scope) {
            this.yeaftDreamSnapshots = {
              ...this.yeaftDreamSnapshots,
              [scope]: { ...snapshot, receivedAt: Date.now() },
            };
          }
          break;
        }

        // ★ R6 G3: dream activity events. Forwarded from
        // agent/yeaft/web-bridge.js handleYeaftDreamTrigger.
        // yeaft_dream_status carries { vpId, status: 'running' } during the
        // run; yeaft_dream_result carries { vpId, success, mergedCount, ... }
        // when finished. Both flow into vpStore.dreamStatus[vpId] so inline
        // status surfaces can update without polling.
        case 'yeaft_dream_status': {
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp) vp.applyDreamStatus(event);
          break;
        }
        case 'yeaft_dream_result': {
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp) vp.applyDreamResult(event);
          if (event?.snapshot?.scope) {
            this.yeaftDreamSnapshots = {
              ...this.yeaftDreamSnapshots,
              [event.snapshot.scope]: { ...event.snapshot, receivedAt: Date.now() },
            };
          }
          // PR feat-dream-debug-panel-full: `yeaft_dream_result` is the
          // SOLE terminal projection for a scoped dream pass. We write the
          // most-recent-pass row and append a terminal record into the
          // timeline ring buffer so the debug panel doesn't end on the last
          // `phase:'apply'` event with no outcome.
          //
          // The bridge used to mirror an extra `phase:'result'`
          // dream_progress event for #2, but that mirror raced through
          // the `dream_progress` projection (which doesn't recognise
          // `phase:'result'` as terminal) and clobbered the
          // `yeaftDreamLatest` success row back to 'running'. The fix
          // is to consolidate both writes here.
          {
            const scope = typeof event?.snapshot?.scope === 'string' && event.snapshot.scope
              ? event.snapshot.scope
              : (typeof event?.sessionId === 'string' && event.sessionId ? `sessions/${event.sessionId}` : null);
            if (!scope) break;
            const prev = this.yeaftDreamLatest[scope] || null;
            // Defaults when no prior running entry exists (network
            // reorder, fresh-tab reconnect): leave nullable fields
            // null rather than synthesising `Date.now()` /
            // `manual: true`. UI consumers already handle missing
            // startedAt; misattributing an auto run as manual is worse
            // than rendering 'unknown'.
            this.yeaftDreamLatest = {
              ...this.yeaftDreamLatest,
              [scope]: {
                scope,
                phase: 'result',
                status: event.skipped ? 'skipped' : (event.success ? 'success' : 'error'),
                startedAt: prev?.startedAt ?? null,
                finishedAt: Date.now(),
                mergedCount: typeof event.entriesCreated === 'number'
                  ? event.entriesCreated
                  : (prev?.mergedCount ?? null),
                error: event.skipped || event.success ? null : (event.error || 'unknown'),
                manual: typeof event?.manual === 'boolean'
                  ? event.manual
                  : (prev?.manual ?? null),
                durationMs: typeof event.durationMs === 'number' ? event.durationMs : (prev?.durationMs ?? null),
                llmCallCount: typeof event.llmCallCount === 'number' ? event.llmCallCount : (prev?.llmCallCount ?? 0),
                inputTokens: typeof event.inputTokens === 'number' ? event.inputTokens : (prev?.inputTokens ?? 0),
                outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : (prev?.outputTokens ?? 0),
                totalTokens: typeof event.totalTokens === 'number' ? event.totalTokens : (prev?.totalTokens ?? 0),
                metrics: event.metrics || prev?.metrics || null,
                passBreakdown: event.passBreakdown || event.metrics?.passBreakdown || prev?.passBreakdown || null,
                isRunning: false,
              },
            };
            // Append a synthetic terminal record into the ring buffer
            // so the timeline shows the final outcome. We invent a
            // `phase:'result'` marker on the record only (NOT on the
            // wire — the bridge does not mirror it anymore). The
            // record uses the same shape as a dream_progress event so
            // the panel's renderer can treat it uniformly.
            this._appendDreamEvent(scope, {
              type: 'dream_progress',
              phase: 'result',
              sessionId: event.sessionId,
              status: event.skipped ? 'skipped' : (event.success ? 'success' : 'error'),
              success: !!event.success,
              entriesCreated: typeof event.entriesCreated === 'number'
                ? event.entriesCreated
                : null,
              trigger: event.trigger || null,
              error: event.skipped || event.success ? null : (event.error || null),
              skipped: !!event.skipped,
              skippedReason: event.skippedReason || null,
              durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
              llmCallCount: typeof event.llmCallCount === 'number' ? event.llmCallCount : 0,
              inputTokens: typeof event.inputTokens === 'number' ? event.inputTokens : 0,
              outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : 0,
              totalTokens: typeof event.totalTokens === 'number' ? event.totalTokens : 0,
              metrics: event.metrics || null,
              passBreakdown: event.passBreakdown || event.metrics?.passBreakdown || null,
              ts: Date.now(),
            });
          }
          break;
        }
        // 2026-05-16: `yeaft_tool_stats` is NOT a `yeaft_output` event —
        // the agent emits it as a bare top-level message via
        // `sendToServer({type:'yeaft_tool_stats', ...})`. Routing lives
        // in `helpers/messageHandler.js`. The previous case here was
        // unreachable and is intentionally removed to prevent future
        // confusion about which switch owns this protocol.
        // v0.1.755: dream_progress events emitted by both manual + auto
        // dream runs (see agent/yeaft/web-bridge.js _dreamProgressSink).
        // Per-group events carry `groupId`; per-target merge/apply events
        // carry `target` (already a scope string like 'group/...' / 'vp/...').
        // Top-level start/done/merge events carry neither — those we attach
        // to a magic '*' bucket so they show up for every focused group.
        // Schema per entry (the projection — NOT identical to the raw
        // event):
        //   { scope, status: 'running'|'success'|'error', startedAt,
        //     finishedAt?, phase, mergedCount?, error?, manual?,
        //     durationMs? }.
        // YeaftDebugPanel reads `yeaftDreamLatestForActiveSession` (getter)
        // to render a single row showing the most recent pass for the
        // active group's scope ("dream只需要看最新的一次就行").
        case 'dream_progress': {
          const phase = event?.phase || 'unknown';
          // Resolve the scope this event belongs to.
          let scope = null;
          if (typeof event?.target === 'string' && event.target.includes('/')) {
            scope = event.target;
          } else if (typeof event?.sessionId === 'string' && event.sessionId) {
            scope = `sessions/${event.sessionId}`;
          } else {
            // Top-level event (start/merge/done/error without group context).
            // Apply to all known scopes — easiest to spread across whatever
            // scopes are already tracked, OR fall back to a singleton '*'
            // bucket so the active-group getter can find it on first run.
            scope = '*';
          }
          const isDone = phase === 'done';
          const isError = phase === 'error' || (event?.status === 'error');
          const isRunning = !isDone && !isError;
          const updateScope = (key) => {
            const prev = this.yeaftDreamLatest[key] || null;
            return {
              scope: key,
              phase,
              status: isError ? 'error' : (isDone ? 'success' : 'running'),
              startedAt: prev?.startedAt && isRunning
                ? prev.startedAt
                : (event?.ts || prev?.startedAt || Date.now()),
              finishedAt: (isDone || isError) ? (event?.ts || Date.now()) : null,
              mergedCount: typeof event?.mergedCount === 'number'
                ? event.mergedCount
                : (typeof event?.targets === 'number'
                  ? event.targets
                  : (prev?.mergedCount ?? null)),
              error: isError ? (event?.error || 'unknown') : null,
              manual: typeof event?.manual === 'boolean'
                ? event.manual
                : (prev?.manual ?? false),
              durationMs: typeof event?.duration === 'number'
                ? event.duration
                : (typeof event?.durationMs === 'number'
                  ? event.durationMs
                  : (prev?.durationMs ?? null)),
              llmCallCount: typeof event?.llmCallCount === 'number' ? event.llmCallCount : (prev?.llmCallCount ?? 0),
              inputTokens: typeof event?.inputTokens === 'number' ? event.inputTokens : (prev?.inputTokens ?? 0),
              outputTokens: typeof event?.outputTokens === 'number' ? event.outputTokens : (prev?.outputTokens ?? 0),
              totalTokens: typeof event?.totalTokens === 'number' ? event.totalTokens : (prev?.totalTokens ?? 0),
              metrics: event?.metrics || prev?.metrics || null,
              passBreakdown: event?.passBreakdown || event?.metrics?.passBreakdown || prev?.passBreakdown || null,
              isRunning,
            };
          };
          if (scope === '*') {
            // Broadcast: if we already track any scopes, refresh them all
            // so the active-group panel always reflects the newest pass.
            // Also keep the '*' bucket so a first-ever start event from a
            // group with no prior entry still surfaces something.
            //
            // NOTE on invariant: a top-level `phase='done'` will mark every
            // tracked scope as success — this is intentional (the dream
            // worker emits a single global "done" after a sweep), but it
            // means a scope's last finishedAt no longer corresponds to a
            // scope-specific pass. UI consumers should treat the dream row
            // as "most recent activity touching this group", not "this
            // group's own pass".
            const next = { ...this.yeaftDreamLatest, '*': updateScope('*') };
            for (const k of Object.keys(this.yeaftDreamLatest)) {
              if (k === '*') continue;
              next[k] = updateScope(k);
            }
            this.yeaftDreamLatest = next;
          } else {
            this.yeaftDreamLatest = {
              ...this.yeaftDreamLatest,
              [scope]: updateScope(scope),
            };
          }
          // PR feat-dream-debug-panel-full: also append to the per-scope
          // ring buffer so the debug panel can render a timeline (not just
          // the latest summary line). We append to the SAME scope that the
          // latest-projection resolved — for '*' events that means the
          // broadcast bucket, which the getter merges with the active
          // group's bucket. Cap at MAX_YEAFT_DREAM_EVENTS_PER_SCOPE so the
          // buffer stays bounded.
          this._appendDreamEvent(scope, event);
          break;
        }
      }
    },
    // PR feat-dream-debug-panel-full: append a dream event to the per-scope
    // ring buffer. Caps the buffer at MAX_YEAFT_DREAM_EVENTS_PER_SCOPE so a
    // long-running session can't grow the array unboundedly. Caller
    // resolves the scope ('sessions/<id>' for scoped events; '*' for top-level
    // broadcast events that don't carry a sessionId).
    //
    // The augmented record adds an `at` timestamp (receive time, used by
    // the active-group getter to merge scoped+broadcast buckets in order)
    // and preserves the raw event fields so the UI can render whatever it
    // wants (phase, status, target, error, etc.).
    _appendDreamEvent(scope, event) {
      if (!scope || !event) return;
      const at = Date.now();
      const record = { ...event, at };
      const prev = Array.isArray(this.yeaftDreamEvents?.[scope])
        ? this.yeaftDreamEvents[scope]
        : [];
      const keyOf = (e) => [
        e?.type || '',
        e?.phase || '',
        (e?.sessionId ?? e?.groupId) || '',
        e?.target || '',
        e?.ts || e?.at || '',
      ].join('|');
      const recordKey = keyOf(record);
      if (prev.some(e => keyOf(e) === recordKey)) return;
      const next = [...prev, record];
      if (next.length > MAX_YEAFT_DREAM_EVENTS_PER_SCOPE) {
        next.splice(0, next.length - MAX_YEAFT_DREAM_EVENTS_PER_SCOPE);
      }
      this.yeaftDreamEvents = {
        ...this.yeaftDreamEvents,
        [scope]: next,
      };
    },

    fetchExpertRoleDefinitions() {
      if (this.expertRoleDefinitions) return; // Already cached
      const agentId = this.currentAgent;
      if (!agentId) return;
      this.sendWsMessage({
        type: 'get_expert_roles',
        agentId,
      });
    },
    // ★ task-341: V2 sidebar is the only sidebar. Setter kept as no-op
    // for backward compat; also sweeps the stale localStorage key once.
    setYeaftSidebarEnabled(_enabled) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('yeaft-sidebar-enabled');
        }
      } catch (_) { /* ignore storage errors */ }
    },
    // H2.f.6: thread filter / merge / fork / setActive actions removed.
    // setYeaftThreadFilter, clearYeaftThreadFilter, mergeYeaftThread,
    // forkYeaftThread, setActiveThread no longer exist.

    // ★ task-334-ui-g: VP CRUD request dispatcher.
    // Wraps `yeaft_vp_{create,update,delete,read}` in a Promise that
    // resolves when the matching `vp_crud_result` arrives (or times out
    // after 10s so the modal never hangs on a dropped WS). Returns a
    // uniform `{ok, op, vpId, vp?, error?}` shape regardless of op.
    //
    //   op      data shape
    //   create  { vpId, displayName, role, traits, modelHint, persona }
    //   update  same (vpId immutable)
    //   delete  vpId (string)
    //   read    vpId (string)
    vpCrudRequest(op, data) {
      if (!this._vpCrudPending || typeof this._vpCrudPending.get !== 'function') {
        this._vpCrudPending = new Map();
      }
      const requestId = 'vpc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const typeMap = {
        create: 'yeaft_vp_create',
        update: 'yeaft_vp_update',
        delete: 'yeaft_vp_delete',
        read: 'yeaft_vp_read',
      };
      const type = typeMap[op];
      if (!type) {
        return Promise.resolve({ ok: false, op, error: { code: 'bad_op', message: 'unknown op: ' + op } });
      }
      const msg = { type, requestId };
      if (op === 'create' || op === 'update') msg.payload = data || {};
      else msg.vpId = data;

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this._vpCrudPending && this._vpCrudPending.has(requestId)) {
            this._vpCrudPending.delete(requestId);
            resolve({ ok: false, op, error: { code: 'timeout', message: 'vp_crud timeout' } });
          }
        }, 10000);
        this._vpCrudPending.set(requestId, {
          resolve: (result) => { clearTimeout(timer); resolve(result); },
        });
        this.sendWsMessage(msg);
      });
    },
    // ★ task-334m: Session CRUD request dispatcher. Mirrors vpCrudRequest.
    // Supported ops: list / create / rename / archive / add_member /
    // remove_member / set_default_vp.
    //
    //   op                data shape
    //   list              (ignored)
    //   create            { name, roster?, defaultVpId?, workDir? }  → msg.payload
    //   rename            { sessionId, name }                → flat
    //   archive           { sessionId }                      → flat
    //   add_member        { sessionId, vpId }                → flat
    //   remove_member     { sessionId, vpId }                → flat
    //   set_default_vp    { sessionId, vpId }                → flat
    //
    // Legacy callers may still pass `groupId`; the agent web-bridge accepts
    // both fields, so we pass the payload through as-is.
    sessionCrudRequest(op, data, opts = {}) {
      if (!this._sessionCrudPending || typeof this._sessionCrudPending.get !== 'function') {
        this._sessionCrudPending = new Map();
      }
      const requestId = 'grc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const typeMap = {
        list: 'yeaft_list_sessions',
        create: 'yeaft_create_session',
        rename: 'yeaft_rename_session',
        update: 'yeaft_update_session',
        update_config: 'yeaft_update_session_config',
        archive: 'yeaft_archive_session',
        delete: 'yeaft_delete_session',
        add_member: 'yeaft_session_add_member',
        remove_member: 'yeaft_session_remove_member',
        set_default_vp: 'yeaft_session_set_default_vp',
        reorder: 'reorder_yeaft_sessions',
        // feat-yeaft-session-restore: read-only probe (lists sessions on
        // disk for a workdir) + write (register that workdir → snapshot
        // rebroadcast). Both go via the flat-merge branch below because
        // their payloads (workDir, sessionId) are top-level on `msg`.
        scan_workdir: 'yeaft_scan_workdir_sessions',
        restore: 'yeaft_restore_session',
      };
      const type = typeMap[op];
      if (!type) {
        return Promise.resolve({ ok: false, op, error: { code: 'bad_op', message: 'unknown op: ' + op } });
      }
      const msg = { type, requestId };
      if (op === 'create') msg.payload = data || {};
      else if (data && typeof data === 'object') Object.assign(msg, data);
      // Per-message agentId override — lets the create modal send the new
      // session to a chosen agent rather than the active one. Server will
      // fall back to client.currentAgent when omitted.
      const overrideAgentId = opts && opts.agentId ? opts.agentId : null;
      if (overrideAgentId) msg.agentId = overrideAgentId;

      const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
      if (gs) gs.markPending(requestId, op);

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this._sessionCrudPending && this._sessionCrudPending.has(requestId)) {
            this._sessionCrudPending.delete(requestId);
            resolve({ ok: false, op, error: { code: 'timeout', message: 'group_crud timeout' } });
          }
        }, 10000);
        this._sessionCrudPending.set(requestId, {
          resolve: (result) => { clearTimeout(timer); resolve(result); },
        });
        this.sendWsMessage(msg);
      });
    },

    // H2.f.6: setActiveThread retired (multi-thread UI gone).
    // task-fix (group-switch): clicking a group row in the sidebar narrows
    // the main pane to that group. Clears task-detail filter so exactly one
    // scope is active at a time.
    //
    // Group conversation consistency: do NOT clear the shared Yeaft stream
    // on group switch. `messages` already filters by groupId; clearing the
    // backing array caused flicker and destroyed the live state for the
    // group the user just left. Keep group-stamped rows cached, but do not
    // treat cache presence as proof that the group is hydrated. A user can
    // have stale rows for `grp_fun` in memory while newer persisted rows are
    // on disk after a refresh/re-entry; switching back to that group must
    // still ask the agent for authoritative history unless this group has
    // already completed a history load in the current UI lifecycle.
    markYeaftSessionUnread(sessionId, agentId = null) {
      if (!sessionId) return false;
      const ownerAgentId = resolveAgentIdForSession(this, sessionId, agentId);
      if (!ownerAgentId) return false;
      const catalogKey = yeaftCatalogKey(ownerAgentId, sessionId);
      const visible = this.currentView === 'yeaft'
        && this.yeaftActiveSessionFilter === sessionId
        && resolveAgentIdForSession(this, sessionId) === ownerAgentId;
      if (visible || this.yeaftUnreadSessionKeys?.[catalogKey]) return false;
      this.yeaftUnreadSessionKeys = {
        ...this.yeaftUnreadSessionKeys,
        [catalogKey]: true,
      };
      return true;
    },

    markYeaftSessionRead(sessionId, agentId = null) {
      if (!sessionId) return false;
      const ownerAgentId = resolveAgentIdForSession(this, sessionId, agentId);
      if (!ownerAgentId) return false;
      const catalogKey = yeaftCatalogKey(ownerAgentId, sessionId);
      if (!this.yeaftUnreadSessionKeys?.[catalogKey]) return false;
      const { [catalogKey]: _read, ...remainingUnread } = this.yeaftUnreadSessionKeys;
      this.yeaftUnreadSessionKeys = remainingUnread;
      return true;
    },

    restoreActiveYeaftSessionFromStatuses(statuses = [], sourceAgentId = null) {
      if (this.yeaftActiveSessionFilter) return null;
      const rows = Array.isArray(statuses) ? statuses : [];
      const running = rows
        .filter(row => row && (row.sessionId || row.groupId) && !['idle', 'offline', 'completed', 'failed', 'aborted'].includes(row.state))
        .sort((a, b) => (b.updatedAt || b.since || 0) - (a.updatedAt || a.since || 0));
      const sessionId = running[0]?.sessionId || running[0]?.groupId || null;
      if (!sessionId) return null;
      const agentId = sourceAgentId || running[0]?.agentId || uniqueYeaftSessionOwner(this, sessionId);
      if (!agentId) return null;
      this.setActiveSessionFilter(sessionId, { agentId, force: true });
      try {
        const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
        if (gs && typeof gs.setActive === 'function') gs.setActive(sessionId, agentId);
      } catch (_) {}
      return sessionId;
    },

    setActiveSessionFilter(groupId, opts = {}) {
      const prev = this.yeaftActiveSessionFilter || null;
      const next = groupId || null;
      const targetAgentId = next
        ? resolveAgentIdForSession(this, next, opts.agentId || null)
        : this.currentAgent;
      const ownerChanged = !!next && next === prev && !!targetAgentId
        && !!this.currentAgent && targetAgentId !== this.currentAgent;
      const force = !!opts.force || ownerChanged;
      this.yeaftActiveSessionFilter = next;
      // Agent selection and catalog projection are one operation. Do this
      // before every history early-return so an already-loaded Session cannot
      // keep rendering the previous Agent's model catalog.
      if (targetAgentId && next && this.currentAgent !== targetAgentId) {
        this.selectAgent(targetAgentId);
        const info = this.agents.find(a => a.id === targetAgentId);
        this.activateYeaftAgent(targetAgentId, info || null);
      } else if (targetAgentId && next) {
        this.activateYeaftAgent(targetAgentId);
      }
      if (targetAgentId && next) {
        this.markYeaftSessionRead(next, targetAgentId);
        touchYeaftHistoryCache(this, targetAgentId, next);
      }
      const repeatedSelection = !force && next === prev;

      // Session activation is atomic: commit its owning Agent conversation and
      // both visible pointers before history de-duplication can return early.
      // Otherwise selecting a Session whose request is already in flight leaves
      // the previous Agent conversation visible and the new filter projects an
      // empty pane until the user clicks again.
      if (targetAgentId && next) {
        this.yeaftSessionAgentById = {
          ...(this.yeaftSessionAgentById || {}),
          [next]: targetAgentId,
        };
        let targetConversationId = this.yeaftConversationIdsByAgent?.[targetAgentId] || null;
        if (!targetConversationId) {
          targetConversationId = `yeaft-local-${targetAgentId}-${Date.now()}`;
          this.yeaftConversationIdsByAgent = {
            ...(this.yeaftConversationIdsByAgent || {}),
            [targetAgentId]: targetConversationId,
          };
        }
        this.yeaftConversationId = targetConversationId;
        if (!this.messagesMap[targetConversationId]) this.messagesMap[targetConversationId] = [];
        if (this.currentView === 'yeaft') this.activeConversations = [targetConversationId];
      }
      try {
        const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
        if (gs && typeof gs.setActive === 'function') gs.setActive(next, targetAgentId || null);
        const activeKey = gs?.activeSessionKey || null;
        if (activeKey) localStorage.setItem('lastViewedYeaftSession', activeKey);
        else localStorage.removeItem('lastViewedYeaftSession');
      } catch (_) {}
      this.syncActiveYeaftHistoryLoad();
      if (next && targetAgentId && !repeatedSelection) {
        this.requestYeaftSessionBootstrap({
          forceSessionReady: true,
          forceHistoryReplay: true,
        });
      }

    },
    // H2.f.6: setYeaftFeatureReplyThreadId / setYeaftJumpTarget /
    // clearYeaftJumpTarget actions removed.
    async switchYeaftModel(modelId, groupId = null, modelEffort = undefined) {
      if (!modelId || !this.currentAgent) return;
      const targetSessionId = groupId || null;
      if (targetSessionId) {
        const config = { model: modelId };
        if (modelEffort !== undefined) config.modelEffort = modelEffort || null;
        const res = await this.sessionCrudRequest('update_config', {
          sessionId: targetSessionId,
          config,
        }, { agentId: resolveAgentIdForSession(this, targetSessionId) });
        // The sessions store applies the returned config. Do not mutate the
        // agent/default model here; a Session-scoped switch must not leak into
        // other Sessions that are still using the default fallback.
        return res;
      }
      this.sendWsMessage({
        type: 'yeaft_model_switch',
        model: modelId,
        modelEffort: modelEffort || null,
        agentId: this.currentAgent,
      });
      return null;
    },
    // Search query for the debug panel toolbar. The request log sends this to
    // the agent as a regex over bounded request summaries, so results are not
    // limited to the currently loaded 5-row window. Not persisted.
    setYeaftDebugSearch(query) {
      this.yeaftDebugSearch = typeof query === 'string' ? query : '';
      if (this._yeaftDebugSearchTimer) clearTimeout(this._yeaftDebugSearchTimer);
      this._yeaftDebugSearchTimer = setTimeout(() => {
        this._yeaftDebugSearchTimer = null;
        this.yeaftDebugLoops = [];
        this.yeaftDebugTurnsById = {};
        this.yeaftDebugTurnOrder = [];
        this.loadYeaftDebugHistory({
          limit: this.yeaftDebugSearch.trim() ? SEARCH_YEAFT_DEBUG_HISTORY_LIMIT : DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT,
          dreamLimit: 5,
          indexOnly: true,
          search: this.yeaftDebugSearch,
        });
      }, 250);
    },

    // feat-6af5f9f1 PR C: independent debug-panel session filter. Distinct
    // from `yeaftActiveSessionFilter` (the main pane's filter) so the user
    // can debug across all sessions even when the main pane is narrowed.
    //   - null        : fall back to main pane filter (default)
    //   - '__all__'   : force "show all" regardless of main pane
    //   - <sessionId> : pin to a specific session
    setYeaftDebugSessionFilter(sessionId) {
      if (sessionId === null || sessionId === undefined) {
        this.yeaftDebugSessionFilter = null;
      } else {
        this.yeaftDebugSessionFilter = String(sessionId);
      }
    },

    toggleSubAgentCardExpand(key) {
      const card = this.yeaftSubAgentCards?.[key];
      if (!card) return;
      this.yeaftSubAgentCards = {
        ...this.yeaftSubAgentCards,
        [key]: { ...card, expanded: !card.expanded },
      };
    },

    // ─── Telemetry settings ─────────────────────────────────────
    loadTelemetrySettings() {
      if (!this.currentAgent) {
        this.telemetrySettings = { enabled: true, retentionDays: 3, flushIntervalMs: 1000, maxQueueSize: 5000, rawExchangeMaxBytes: 524288, traceTextMaxBytes: 262144, loaded: true };
        return Promise.resolve(this.telemetrySettings);
      }
      return new Promise((resolve) => {
        if (!this._telemetryPending) this._telemetryPending = {};
        this._telemetryPending.load = resolve;
        this.sendWsMessage({ type: 'get_telemetry_settings', agentId: this.currentAgent });
      });
    },

    updateTelemetrySettings(payload) {
      if (!this.currentAgent) return Promise.resolve({ error: 'no agent' });
      return new Promise((resolve) => {
        if (!this._telemetryPending) this._telemetryPending = {};
        this._telemetryPending.update = resolve;
        this.sendWsMessage({
          type: 'update_telemetry_settings',
          agentId: this.currentAgent,
          settings: payload || {},
        });
      });
    },

    // ─── Search settings (Tavily backend + key + on-demand quota) ───
    //
    // The Search tab in YeaftSettings uses these. They use
    // request/response promises keyed off the WS reply types
    // (`search_settings`, `search_settings_updated`, `tavily_usage`).
    // Since chat.js's WS layer has no first-class request/response
    // primitive, we register one-shot resolvers on `_searchPending`
    // and the messageHandler for those types pops the matching
    // resolver. This keeps the action-shape promise-based for the
    // component (`await store.updateSearchSettings(...)`) without
    // bolting on a generic RPC layer.

    /**
     * Fetch the current search settings from the agent and store them
     * on `searchSettings`. Promise resolves with the same record (or
     * an `{ error }` shape if the agent returns one).
     */
    loadSearchSettings() {
      if (!this.currentAgent) {
        this.searchSettings = { backend: 'tavily', tavilyKeyConfigured: false, tavilyKeyMasked: null, disableHtmlFallback: false, loaded: true };
        return Promise.resolve(this.searchSettings);
      }
      return new Promise((resolve) => {
        if (!this._searchPending) this._searchPending = {};
        this._searchPending.load = resolve;
        this.sendWsMessage({ type: 'get_search_settings', agentId: this.currentAgent });
      });
    },

    /**
     * Persist a partial search-settings update. `payload` may include
     * `backend`, `tavilyApiKey`, `disableHtmlFallback`. Omit fields to
     * keep them unchanged — particularly `tavilyApiKey`, which the UI
     * passes only when the user actually edited the input.
     */
    updateSearchSettings(payload) {
      if (!this.currentAgent) return Promise.resolve({ error: 'no agent' });
      return new Promise((resolve) => {
        if (!this._searchPending) this._searchPending = {};
        this._searchPending.update = resolve;
        this.sendWsMessage({
          type: 'update_search_settings',
          agentId: this.currentAgent,
          settings: payload || {},
        });
      });
    },

    /**
     * Probe Tavily's /usage endpoint with the saved key. Triggered
     * from the UI on tab open and on the "Refresh" button click —
     * never on a timer.
     */
    loadTavilyUsage() {
      if (!this.currentAgent) return Promise.resolve(null);
      this.tavilyUsageLoading = true;
      return new Promise((resolve) => {
        if (!this._searchPending) this._searchPending = {};
        this._searchPending.usage = resolve;
        this.sendWsMessage({ type: 'get_tavily_usage', agentId: this.currentAgent });
      });
    },

    // ─── Yeaft MCP CRUD ─────────────────────────────────────
    //
    // Each action sends a wire op (`yeaft_mcp_list/add/remove/reload`)
    // and registers a one-shot resolver keyed by `requestId` so concurrent
    // calls don't clobber each other. The agent always responds with the
    // result type `yeaft_mcp_*_result`; broadcast `yeaft_mcp_updated`
    // updates the cached list/runtime without a separate fetch.
    //
    // No agent? Resolve with an empty list — the Settings tab opens
    // before any agent is registered and we don't want to throw.

    loadYeaftMcpServers() {
      if (!this.currentAgent) {
        this.yeaftMcpServers = [];
        this.yeaftMcpRuntime = { connected: false, toolCount: 0, perServer: [] };
        return Promise.resolve({ servers: [], runtime: this.yeaftMcpRuntime });
      }
      this.yeaftMcpLoading = true;
      const requestId = `mcp-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        if (!this._mcpPending) this._mcpPending = {};
        this._mcpPending[requestId] = resolve;
        this.sendWsMessage({
          type: 'yeaft_mcp_list',
          agentId: this.currentAgent,
          requestId,
        });
      });
    },

    /**
     * Add or update an MCP server. `server` must contain
     * `{ name, command, args?, env? }`. Returns the agent's full response
     * so the caller can surface connectError to the UI.
     */
    addYeaftMcpServer(server) {
      if (!this.currentAgent) return Promise.resolve({ error: 'no agent' });
      this.yeaftMcpLoading = true;
      const requestId = `mcp-add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        if (!this._mcpPending) this._mcpPending = {};
        this._mcpPending[requestId] = resolve;
        this.sendWsMessage({
          type: 'yeaft_mcp_add',
          agentId: this.currentAgent,
          requestId,
          server: server || {},
        });
      });
    },

    removeYeaftMcpServer(name) {
      if (!this.currentAgent) return Promise.resolve({ error: 'no agent' });
      this.yeaftMcpLoading = true;
      const requestId = `mcp-rem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        if (!this._mcpPending) this._mcpPending = {};
        this._mcpPending[requestId] = resolve;
        this.sendWsMessage({
          type: 'yeaft_mcp_remove',
          agentId: this.currentAgent,
          requestId,
          name,
        });
      });
    },

    /**
     * Reload a single MCP server (`name`) or every server (no name).
     * Performs disconnect+reconnect on the agent and re-flattens tools.
     */
    reloadYeaftMcpServer(name) {
      if (!this.currentAgent) return Promise.resolve({ error: 'no agent' });
      this.yeaftMcpLoading = true;
      const requestId = `mcp-rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve) => {
        if (!this._mcpPending) this._mcpPending = {};
        this._mcpPending[requestId] = resolve;
        this.sendWsMessage({
          type: 'yeaft_mcp_reload',
          agentId: this.currentAgent,
          requestId,
          name: name || null,
        });
      });
    },

    clearYeaftMessages() {
      const oldConvId = this.yeaftConversationId;
      if (oldConvId) {
        watchdogHelpers.stopProcessingWatchdog(this, oldConvId);
        delete this.messagesMap[oldConvId];
        delete this.processingConversations[oldConvId];
        delete this.executionStatusMap[oldConvId];
        delete this.refreshingSessionMap[oldConvId];
        if (this._closedAt) delete this._closedAt[oldConvId];
        this._turnCompletedConvs?.delete(oldConvId);
      }
      // Create a fresh local conversationId for the current Yeaft agent.
      this.yeaftConversationId = this.currentAgent
        ? `yeaft-local-${this.currentAgent}-${Date.now()}`
        : `yeaft-local-${Date.now()}`;
      if (this.currentAgent) {
        this.yeaftConversationIdsByAgent = {
          ...(this.yeaftConversationIdsByAgent || {}),
          [this.currentAgent]: this.yeaftConversationId,
        };
      }
      this.messagesMap[this.yeaftConversationId] = [];
      this.activeConversations = [this.yeaftConversationId];
      this.yeaftSessionReady = false;
      this.yeaftModel = null;
      this.yeaftAvailableModels = [];
      this.yeaftStatus = null;
      this._yeaftAskTerminalEvents = {};
      // feat-6af5f9f1 PR B: clear new Turn-grouped debug shape.
      this.yeaftDebugLoops = [];
      this.yeaftDebugTurnsById = {};
      this.yeaftDebugTurnOrder = [];
      // fix-vp-multi-thread (bug 4): reset hydration state — the new session
      // will start re-collecting live trace events, and the next mount of
      // the debug panel will re-issue `loadYeaftDebugHistory` to refill.
      this.yeaftDebugHistoryLoading = false;
      this.yeaftDebugHistoryError = null;
      this.yeaftDebugHistoryFetchedAt = 0;
      this.yeaftDebugHistoryProjection = null;
      // feat-6af5f9f1 PR C: clear toolbar transient state too. The group
      // filter is intentionally cleared on session reset so a stale pin
      // from a previous session doesn't hide all incoming turns.
      this.yeaftDebugSearch = '';
      this.yeaftDebugSessionFilter = null;
      // Turn-level debug panel: reset to closed on session reset so a
      // stale turnId from the previous session can never render old data.
      this.yeaftDebugPanel = {
        open: false,
        status: 'idle',
        requestId: null,
        agentId: null,
        sessionId: null,
        turnId: null,
        error: null,
      };
      if (this._yeaftDebugSearchTimer) {
        clearTimeout(this._yeaftDebugSearchTimer);
        this._yeaftDebugSearchTimer = null;
      }
      if (this._fetchYeaftDebugHistoryTimer) {
        clearTimeout(this._fetchYeaftDebugHistoryTimer);
        this._fetchYeaftDebugHistoryTimer = null;
      }
      this._yeaftDebugHistoryInFlightKey = null;
      this._yeaftDebugHistoryLatestListRequestId = null;
      this._yeaftDebugHistoryLatestDetailRequestId = null;
      this.yeaftReflectionCards = {};
      this.yeaftSubAgentCards = {};
      // VP-block redesign (2026-05-08): per-turn detail drawer retired.
      // v0.1.755: reset dream-pass projection so a previous session's
      // "latest pass" doesn't bleed into the fresh session.
      this.yeaftDreamLatest = {};
      this.yeaftDreamEvents = {};
      // vp-status: drop the cached per-VP status table on session reset.
      // The agent will re-broadcast a fresh snapshot after re-init.
      this.vpStatuses = {};
      // Tell agent to reset session so Engine gets a fresh start
      if (this.currentAgent) {
        this.sendWsMessage({
          type: 'yeaft_reset',
          agentId: this.currentAgent,
        });
      }
    },

    togglePaneRightPanel(panelType, paneId = null) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) { pane.activeRightPanel = pane.activeRightPanel === panelType ? null : panelType; return; }
      }
      this.activeRightPanel = this.activeRightPanel === panelType ? null : panelType;
      if (this.activeRightPanel) {
        this.workbenchExpanded = false;
        this.workbenchMaximized = false;
      }
    },
    getPaneRightPanel(paneId) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) return pane.activeRightPanel;
      }
      return this.activeRightPanel;
    },
    setPaneRightPanel(paneId, value) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) { pane.activeRightPanel = value; return; }
      }
      this.activeRightPanel = value;
    },

    applySessionCatalogSnapshot(rows, projects = null, hiddenRows = null) {
      const normalizeCatalogRows = (source) => {
        const seen = new Set();
        return (Array.isArray(source) ? source : []).filter(row => {
          if (!row?.catalogKey || seen.has(row.catalogKey)) return false;
          seen.add(row.catalogKey);
          return true;
        }).map(row => ({ ...row }));
      };
      this.sessionCatalog = normalizeCatalogRows(rows);
      if (Array.isArray(hiddenRows)) {
        this.hiddenSessionCatalog = normalizeCatalogRows(hiddenRows);
      }
      if (Array.isArray(projects)) {
        this.sessionProjects = projects
          .filter(project => project?.id)
          .map(project => ({
            ...project,
            members: Array.isArray(project.members)
              ? project.members.filter(member => member?.agentId && member?.sessionId)
              : (project.agentId
                  ? (project.sessionIds || []).map(sessionId => ({ agentId: project.agentId, sessionId }))
                  : []),
          }));
        const membership = new Map();
        for (const project of this.sessionProjects) {
          for (const member of project.members) {
            membership.set(`${member.agentId}\u001f${member.sessionId}`, project.id);
          }
        }
        this.sessionCatalog = this.sessionCatalog.map(row => (
          row.runtimeProvider === 'yeaft'
            ? { ...row, projectId: membership.get(`${row.routeRef?.agentId}\u001f${row.routeRef?.sessionId}`) || null }
            : row
        ));
      }
      this.sessionCatalogLoaded = true;
    },
    mutateProject(op, payload = {}, agentId = null) {
      const targetAgentId = agentId || payload.agentId || this.currentAgent || null;
      if (op === 'move_session' && !targetAgentId) {
        return Promise.resolve({ ok: false, error: { code: 'missing_agent' } });
      }
      const requestId = `project_${crypto.randomUUID()}`;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          delete this.projectMutationRequests[requestId];
          resolve({ ok: false, error: { code: 'timeout' } });
        }, 10000);
        this.projectMutationRequests[requestId] = {
          connectionGeneration: Number(this.chatHistoryConnectionGeneration || 0),
          catalogOrder: Array.isArray(payload.catalogOrder) ? payload.catalogOrder : null,
          resolve: result => { clearTimeout(timer); resolve(result); },
        };
        const sent = this.sendWsMessage({
          type: 'yeaft_project_mutation',
          ...(targetAgentId ? { agentId: targetAgentId, targetAgentId } : {}),
          requestId,
          op,
          ...payload,
        });
        if (!sent) {
          clearTimeout(timer);
          delete this.projectMutationRequests[requestId];
          resolve({ ok: false, error: { code: 'send_failed' } });
        }
      });
    },
    applyLegacyProjectSnapshot(projects, agentId) {
      if (!agentId || !Array.isArray(projects)) return;
      const otherProjects = this.sessionProjects.filter(project => project.legacyAgentId !== agentId);
      const legacyProjects = projects
        .filter(project => project?.id)
        .map(project => ({
          ...project,
          id: `${agentId}\u001f${project.id}`,
          legacyProjectId: project.id,
          legacyAgentId: agentId,
          members: (project.sessionIds || []).map(sessionId => ({ agentId, sessionId })),
        }));
      this.applySessionCatalogSnapshot(this.sessionCatalog, [...otherProjects, ...legacyProjects]);
    },
    finishLegacyProjectMutation(event, agentId) {
      if (!event?.requestId) return false;
      const pending = this.projectMutationRequests[event.requestId] || null;
      if (!pending
          || pending.connectionGeneration !== Number(this.chatHistoryConnectionGeneration || 0)) return false;
      delete this.projectMutationRequests[event.requestId];
      if (event.ok && Array.isArray(event.projects) && agentId) {
        this.applyLegacyProjectSnapshot(event.projects, agentId);
      }
      pending.resolve(event);
      return true;
    },
    finishProjectMutation(event) {
      if (!event?.requestId) return false;
      const pending = this.projectMutationRequests[event.requestId] || null;
      if (!pending
          || pending.connectionGeneration !== Number(this.chatHistoryConnectionGeneration || 0)) return false;
      delete this.projectMutationRequests[event.requestId];
      if (event.ok) {
        if (Array.isArray(pending.catalogOrder)) {
          const rowsByKey = new Map(this.sessionCatalog.map(row => [row.catalogKey, row]));
          const ordered = pending.catalogOrder
            .map((item, sortRank) => {
              const row = rowsByKey.get(item?.catalogKey);
              return row ? { ...row, sortRank } : null;
            })
            .filter(Boolean);
          if (ordered.length === this.sessionCatalog.length) {
            this.sessionCatalog = ordered;
            persistCatalogYeaftOrder(ordered);
          }
        }
        if (Array.isArray(event.projects)) {
          this.applySessionCatalogSnapshot(this.sessionCatalog, event.projects);
        }
      }
      pending.resolve(event);
      return true;
    },
    toggleCatalogSessionPin(row) {
      if (!row?.catalogKey || !row?.routeRef
        || Object.keys(this.sessionCatalogMutationRequests).length > 0) return false;
      const requestId = `session_ui_${crypto.randomUUID()}`;
      const previousCatalog = beginCatalogMutation(this, requestId);
      const nextPinned = !row.pinned;
      row.pinned = nextPinned;
      const sent = this.sendWsMessage({
        type: 'set_session_ui_metadata',
        requestId,
        catalogKey: row.catalogKey,
        routeRef: row.routeRef,
        pinned: nextPinned,
        sortRank: Number.isFinite(row.sortRank) ? row.sortRank : null,
      });
      if (!sent) {
        this.sessionCatalog = previousCatalog;
        delete this.sessionCatalogMutationRequests[requestId];
        return false;
      }
      return true;
    },
    hideCatalogSession(row) {
      if (!row?.catalogKey || !row?.routeRef
        || Object.keys(this.sessionCatalogMutationRequests).length > 0) return false;
      const requestId = `session_hide_${crypto.randomUUID()}`;
      const previousCatalog = beginCatalogMutation(this, requestId);
      this.sessionCatalog = this.sessionCatalog.filter(item => item.catalogKey !== row.catalogKey);
      this.hiddenSessionCatalog = [
        ...(this.hiddenSessionCatalog || []).filter(item => item.catalogKey !== row.catalogKey),
        { ...row, hidden: true },
      ];
      const sent = this.sendWsMessage({
        type: 'set_session_ui_metadata',
        requestId,
        catalogKey: row.catalogKey,
        routeRef: row.routeRef,
        hidden: true,
        ...(Number.isFinite(row.sortRank) ? { sortRank: row.sortRank } : {}),
      });
      if (!sent) {
        this.sessionCatalog = previousCatalog;
        this.hiddenSessionCatalog = Array.isArray(this.sessionCatalogMutationRequests[requestId]?.previousHiddenCatalog)
          ? this.sessionCatalogMutationRequests[requestId].previousHiddenCatalog
          : [];
        delete this.sessionCatalogMutationRequests[requestId];
        return false;
      }
      return true;
    },
    restoreCatalogSession(row) {
      if (!row?.catalogKey || !row?.routeRef
        || Object.keys(this.sessionCatalogMutationRequests).length > 0) return false;
      const requestId = `session_restore_${crypto.randomUUID()}`;
      const previousCatalog = beginCatalogMutation(this, requestId);
      this.hiddenSessionCatalog = (this.hiddenSessionCatalog || [])
        .filter(item => item.catalogKey !== row.catalogKey);
      this.sessionCatalog = this.sessionCatalog.some(item => item.catalogKey === row.catalogKey)
        ? this.sessionCatalog
        : [...this.sessionCatalog, { ...row, hidden: false }];
      const sent = this.sendWsMessage({
        type: 'set_session_ui_metadata',
        requestId,
        catalogKey: row.catalogKey,
        routeRef: row.routeRef,
        hidden: false,
        ...(Number.isFinite(row.sortRank) ? { sortRank: row.sortRank } : {}),
      });
      if (!sent) {
        this.sessionCatalog = previousCatalog;
        this.hiddenSessionCatalog = Array.isArray(this.sessionCatalogMutationRequests[requestId]?.previousHiddenCatalog)
          ? this.sessionCatalogMutationRequests[requestId].previousHiddenCatalog
          : [];
        delete this.sessionCatalogMutationRequests[requestId];
        return false;
      }
      return true;
    },
    renameCatalogSession({ row, title } = {}) {
      if (!row?.routeRef || !title) return false;
      const { runtimeProvider, agentId, sessionId } = row.routeRef;
      if (runtimeProvider === 'yeaft') {
        this.sessionCrudRequest('rename', { sessionId, name: title }, { agentId });
      } else if (runtimeProvider === 'claude-code' || runtimeProvider === 'copilot') {
        this.renameChatSession(sessionId, title, agentId);
      } else {
        return false;
      }
      return true;
    },
    reorderCatalogSessions(rows) {
      if (!Array.isArray(rows) || rows.length === 0
        || Object.keys(this.sessionCatalogMutationRequests).length > 0) return false;
      const requestId = `session_order_${crypto.randomUUID()}`;
      const previousCatalog = beginCatalogMutation(this, requestId);
      this.sessionCatalog = rows.map((row, index) => ({ ...row, sortRank: index }));
      const sent = this.sendWsMessage({
        type: 'reorder_session_catalog',
        requestId,
        sessions: this.sessionCatalog.map((row, index) => ({
          catalogKey: row.catalogKey,
          routeRef: row.routeRef,
          pinned: !!row.pinned,
          sortRank: index,
        })),
      });
      if (!sent) {
        this.sessionCatalog = previousCatalog;
        delete this.sessionCatalogMutationRequests[requestId];
        return false;
      }
      return true;
    },
    finishSessionCatalogMutation(msg) {
      const finished = finishCatalogMutation(this, msg);
      if (!finished) return false;
      if (msg?.ok === true && msg?.type === 'session_ui_metadata_updated') {
        const applyMetadata = (row) => {
          if (!row) return;
          row.pinned = msg.pinned === true;
          if (Object.prototype.hasOwnProperty.call(msg, 'sortRank')) {
            row.sortRank = Number.isFinite(msg.sortRank) ? msg.sortRank : null;
          }
        };
        applyMetadata(this.sessionCatalog.find(item => item.catalogKey === msg.catalogKey));
        applyMetadata(this.hiddenSessionCatalog.find(item => item.catalogKey === msg.catalogKey));
      }
      if (msg?.ok === true && msg?.type === 'session_catalog_reorder_result') {
        persistCatalogYeaftOrder(this.sessionCatalog);
      }
      return true;
    },
    openCatalogSession(descriptor) {
      if (!descriptor?.catalogKey || !descriptor.routeRef) return false;
      const { runtimeProvider, agentId, sessionId } = descriptor.routeRef;
      this.activeCatalogKey = descriptor.catalogKey;
      if (runtimeProvider === 'yeaft') {
        // A catalog click is also an explicit freshness request, including a
        // repeated click on the already-active Session. Keep the cached pane
        // visible while reloadYeaftMessages replaces its persisted window.
        const wasSyncing = this.isSessionHistorySyncing(descriptor.routeRef);
        this.enterYeaft(agentId, { deferBootstrap: true });
        this.setActiveSessionFilter(sessionId, { agentId, force: false });
        if (!wasSyncing) this.reloadYeaftMessages();
        return true;
      }
      if (runtimeProvider !== 'claude-code' && runtimeProvider !== 'copilot') return false;
      if (this.currentView === 'yeaft') this.leaveYeaft();
      this.selectConversation(sessionId, agentId, { refresh: true });
      return true;
    },
    syncChatConversationHistory(conversationId) {
      if (!conversationId) return null;
      const catalogKey = chatCatalogKey(conversationId);
      if (this.chatHistoryRequests[catalogKey]?.loading) {
        return this.chatHistoryRequests[catalogKey].requestId;
      }
      const lastSeenDbId = msgHelpers.maxDbMessageId(this.messagesMap[conversationId]);
      return this.requestChatHistory(conversationId, lastSeenDbId === null
        ? { mode: 'recent', turns: 5 }
        : { mode: 'delta', afterMessageId: lastSeenDbId });
    },
    requestChatHistory(conversationId, { mode = 'recent', turns = null, beforeId = null, afterMessageId = null } = {}) {
      if (!conversationId) return null;
      const catalogKey = chatCatalogKey(conversationId);
      if (this.chatHistoryRequestIdSupported !== true && this.chatHistoryRequests[catalogKey]?.loading) {
        return null;
      }
      const cursor = beforeId ?? afterMessageId ?? null;
      const requestId = this.beginChatHistoryRequest(conversationId, mode, cursor);
      const sent = this.sendWsMessage({
        type: 'sync_messages',
        conversationId,
        ...(turns != null ? { turns } : {}),
        ...(beforeId != null ? { beforeId } : {}),
        ...(afterMessageId != null ? { afterMessageId } : {}),
        requestId,
      });
      if (!sent) {
        cancelChatHistoryRequest(this, catalogKey, requestId, 'send_failed');
        return null;
      }
      setTimeout(() => {
        cancelChatHistoryRequest(this, catalogKey, requestId, 'history_load_timeout');
      }, 10_000);
      return requestId;
    },
    beginChatHistoryRequest(conversationId, mode = 'recent', cursor = null) {
      return beginChatHistoryRequest(this, conversationId, mode, cursor);
    },
    isCurrentChatHistoryResponse(msg) {
      if (!msg?.conversationId || !msg?.requestId || !msg?.catalogKey) return false;
      const expectedCatalogKey = chatCatalogKey(msg.conversationId);
      if (msg.catalogKey !== expectedCatalogKey) return false;
      const pending = this.chatHistoryRequests[expectedCatalogKey];
      return !!pending
        && pending.loading === true
        && pending.requestId === msg.requestId
        && Number(pending.connectionGeneration || 0) === Number(this.chatHistoryConnectionGeneration || 0);
    },
    finishChatHistoryRequest(msg) {
      if (!this.isCurrentChatHistoryResponse(msg)) return false;
      const pending = this.chatHistoryRequests[msg.catalogKey];
      this.chatHistoryRequests[msg.catalogKey] = { ...pending, loading: false };
      return true;
    },

    isRefreshingSession(convId) {
      if (convId) return !!this.refreshingSessionMap[convId];
      return this.refreshingSession;
    },
    setRefreshingSession(convId, value) {
      if (convId) { this.refreshingSessionMap[convId] = value; }
      this.refreshingSession = value;
    },

    // =====================
    // /btw mode (multi-turn side question)
    // =====================
    enterBtwMode() {
      this.btwMode = true;
      this.btwMessages = [];
      this.btwLoading = false;
      this.btwSessionId = null;
    },
    sendBtwQuestion(question) {
      if (!this.currentConversation) return;
      this.btwMessages.push({ role: 'user', content: question });
      this.btwMessages.push({ role: 'assistant', content: '' }); // placeholder for streaming
      this.btwLoading = true;
      this.sendWsMessage({
        type: 'btw_question',
        conversationId: this.currentConversation,
        question,
        btwSessionId: this.btwSessionId  // null for first question, reuse for subsequent
      });
    },
    closeBtw() {
      this.btwMode = false;
      this.btwMessages = [];
      this.btwLoading = false;
      this.btwSessionId = null;
    },
    appendBtwDelta(delta) {
      const lastMsg = this.btwMessages[this.btwMessages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content += delta;
      }
    },

    // =====================
    // Sub-Agents
    // =====================
    addSubagent(conversationId, info) {
      if (!this.subagents[conversationId]) {
        this.subagents[conversationId] = {};
      }
      this.subagents[conversationId][info.id] = {
        id: info.id,
        slug: info.slug || info.id,
        type: info.type || 'Task',
        description: info.description || '',
        parentToolUseId: info.parentToolUseId || null,
        status: 'running',
        startTime: Date.now(),
        messages: [],
        toolCallCount: 0
      };
      // Auto-open panel when first subagent starts for current conversation
      if (conversationId === this.currentConversation && this.activeRightPanel !== 'subagents') {
        this.activeRightPanel = 'subagents';
      }
    },
    appendSubagentMessage(conversationId, subagentId, message) {
      const convSubagents = this.subagents[conversationId];
      if (!convSubagents || !convSubagents[subagentId]) return;
      const agent = convSubagents[subagentId];
      if (message?.type === 'tool') {
        agent.toolCallCount = Number(agent.toolCallCount || 0) + 1;
        return;
      }
      if (message?.type === 'text') agent.messages.push(message);
    },
    completeSubagent(conversationId, subagentId) {
      const convSubagents = this.subagents[conversationId];
      if (!convSubagents || !convSubagents[subagentId]) return;
      convSubagents[subagentId].status = 'completed';
    },

    // =====================
    // WebSocket helpers
    // =====================
    sendWsMessage(msg) { return wsHelpers.sendWsMessage(this, msg); },
    parseWsMessage(data) { return wsHelpers.parseWsMessage(this, data); },
    connect() { wsHelpers.connect(this); },
    ensureConnected() { return wsHelpers.ensureConnected(this); },
    scheduleReconnect() { wsHelpers.scheduleReconnect(this); },
    manualReconnect() { wsHelpers.manualReconnect(this); },
    startHeartbeat() { wsHelpers.startHeartbeat(this); },
    stopHeartbeat() { wsHelpers.stopHeartbeat(this); },
    setupVisibilityHandler() { wsHelpers.setupVisibilityHandler(this); },

    // =====================
    // Message dispatcher
    // =====================
    handleMessage(msg) { handlerHelpers.handleMessage(this, msg); },

    // =====================
    // Assistant output processing
    // =====================
    getOrCreateExecutionStatus(conversationId) { return assistantOutputHelpers.getOrCreateExecutionStatus(this, conversationId); },
    handleAssistantOutputFrame(conversationId, data, frameAgentId = null) {
      assistantOutputHelpers.handleAssistantOutputFrame(this, conversationId, data, frameAgentId);
    },
    handleClaudeOutput(conversationId, data) { this.handleAssistantOutputFrame(conversationId, data, null); },

    // =====================
    // Message CRUD
    // =====================
    addMessageToConversation(conversationId, msg) {
      return msgHelpers.addMessageToConversation(this, conversationId, msg);
    },
    pruneConversationMessageRetention(conversationId, sessionId = null, agentId = null, limits = undefined) {
      return pruneConversationMessageRetention(this, { conversationId, sessionId, agentId, limits });
    },
    appendToAssistantMessageForConversation(conversationId, text, opts) { msgHelpers.appendToAssistantMessageForConversation(this, conversationId, text, opts); },
    finishStreamingForConversation(conversationId, options) { msgHelpers.finishStreamingForConversation(this, conversationId, options); },
    sweepStaleStreamingForConversation(conversationId) { msgHelpers.sweepStaleStreamingForConversation(this, conversationId); },
    appendToAssistantMessage(text) { this.appendToAssistantMessageForConversation(this.currentConversation, text); },
    finishStreaming() { this.finishStreamingForConversation(this.currentConversation); },
    addMessage(msg) { this.addMessageToConversation(this.currentConversation, msg); },
    loadHistoryMessages(historyMessages) { msgHelpers.loadHistoryMessages(this, historyMessages); },
    formatDbMessage(dbMsg) { return msgHelpers.formatDbMessage(dbMsg); },

    // =====================
    // Conversation lifecycle
    // =====================
    selectAgent(agentId) { return convHelpers.selectAgent(this, agentId); },
    createConversation(workDir, agentId = null, disallowedTools = null, options = undefined) { convHelpers.createConversation(this, workDir, agentId, disallowedTools, options); },
    resumeConversation(claudeSessionId, workDir, agentId = null, disallowedToolsOrOptions = null, maybeOptions = null) { convHelpers.resumeConversation(this, claudeSessionId, workDir, agentId, disallowedToolsOrOptions, maybeOptions); },
    selectConversation(conversationId, agentId, options = {}) { convHelpers.selectConversation(this, conversationId, agentId, options); },
    updateConversationSettings(conversationId, settings) { convHelpers.updateConversationSettings(this, conversationId, settings); },
    toggleConversationMcp(serverName, enabled) { convHelpers.toggleConversationMcp(this, serverName, enabled); },
    deleteConversation(conversationId, agentId) { convHelpers.deleteConversation(this, conversationId, agentId); },
    closeSession(conversationId, agentId) { convHelpers.closeSession(this, conversationId, agentId); },
    // ★ Multi-column: column management
    appendColumn(conversationId) { convHelpers.appendColumn(this, conversationId); },
    removeColumn(conversationId) { convHelpers.removeColumn(this, conversationId); },
    sendMessageToConversation(conversationId, text, attachments = [], options = {}) { convHelpers.sendMessageToConversation(this, conversationId, text, attachments, options); },
    cancelExecutionForConversation(conversationId) { convHelpers.cancelExecutionForConversation(this, conversationId); },
    // ★ Split-screen: panel management
    addPanel() {
      if (this.panels.length >= 3) return;
      const makePanelState = (id, conversationId) => ({
        id,
        conversationId,
        // Panel-local state (split mode only; non-split reads global store)
        activeRightPanel: null
      });
      if (this.panels.length === 0) {
        // Entering split mode: try to restore previous split layout
        const saved = localStorage.getItem('splitPanesSaved');
        if (saved) {
          try {
            const panels = JSON.parse(saved);
            if (Array.isArray(panels) && panels.length >= 2) {
              // Validate conversationIds still exist
              const convIds = new Set(this.conversations.map(c => c.id));
              const validPanels = panels
                .filter(p => p && typeof p.id === 'string')
                .map(p => ({
                  ...makePanelState(p.id, null),
                  conversationId: (p.conversationId && convIds.has(p.conversationId)) ? p.conversationId : null
                }));
              if (validPanels.length >= 2) {
                this.panels = validPanels;
                this.activePanelId = validPanels[0].id;
                // Ensure activeConversations includes all panel conversations
                for (const panel of validPanels) {
                  if (panel.conversationId && !this.activeConversations.includes(panel.conversationId)) {
                    this.activeConversations.push(panel.conversationId);
                  }
                  // Load messages for chat conversations that aren't cached
                  if (panel.conversationId && !this.messagesMap[panel.conversationId]) {
                    this.messagesMap[panel.conversationId] = [];
                    this.requestChatHistory(panel.conversationId, { mode: 'recent', turns: 5 });
                  }
                }
                localStorage.removeItem('splitPanesSaved');
                this.saveOpenSessions();
                return;
              }
            }
          } catch { /* ignore corrupt data */ }
          localStorage.removeItem('splitPanesSaved');
        }
        // Fallback: fresh split — first panel inherits current conversation
        this.panels = [
          makePanelState('panel-0', this.currentConversation),
          makePanelState('panel-1', null)
        ];
        this.activePanelId = 'panel-0';
        // Ensure second conv is in activeConversations if set
      } else {
        const nextId = 'panel-' + Date.now();
        this.panels.push(makePanelState(nextId, null));
      }
      this.saveOpenSessions();
    },
    removePanel(panelId) {
      const idx = this.panels.findIndex(p => p.id === panelId);
      if (idx < 0) return;
      this.panels.splice(idx, 1);
      if (this.panels.length <= 1) {
        // Exit split mode: remaining panel's conversation becomes primary
        const remaining = this.panels[0];
        if (remaining?.conversationId) {
          this.activeConversations = [remaining.conversationId];
        }
        this.panels = [];
        this.activePanelId = null;
      } else if (this.activePanelId === panelId) {
        // Active panel was removed, switch to first remaining
        this.activePanelId = this.panels[0]?.id || null;
      }
      this.saveOpenSessions();
    },
    setPanelConversation(panelId, conversationId, { refresh = false } = {}) {
      const panel = this.panels.find(p => p.id === panelId);
      if (!panel) return;
      const repeatedSelection = panel.conversationId === conversationId;
      panel.conversationId = conversationId;
      // Ensure conversation is in activeConversations
      if (conversationId && !this.activeConversations.includes(conversationId)) {
        this.activeConversations.push(conversationId);
      }
      // Ensure messagesMap entry exists
      if (conversationId && !this.messagesMap[conversationId]) {
        this.messagesMap[conversationId] = [];
        this.syncChatConversationHistory(conversationId);
      } else if (conversationId && (refresh || !repeatedSelection)) {
        this.syncChatConversationHistory(conversationId);
      }
      this.saveOpenSessions();
    },
    setActivePanel(panelId) {
      this.activePanelId = panelId;
    },
    // ★ Split to new panel: add a conversation to a new panel on the right
    splitToPanel(conversationId) {
      if (!conversationId) return;
      const makePanelState = (id, convId) => ({
        id,
        conversationId: convId,
        activeRightPanel: null
      });
      if (this.panels.length === 0) {
        // Not in split mode yet — enter split mode
        this.panels = [
          makePanelState('panel-0', this.currentConversation),
          makePanelState('panel-' + Date.now(), conversationId)
        ];
        this.activePanelId = this.panels[1].id;
      } else if (this.panels.length >= 3) {
        // Max panels reached — replace last panel
        this.panels[this.panels.length - 1].conversationId = conversationId;
        this.activePanelId = this.panels[this.panels.length - 1].id;
      } else {
        // Add new panel
        const newId = 'panel-' + Date.now();
        this.panels.push(makePanelState(newId, conversationId));
        this.activePanelId = newId;
      }
      // Ensure conversation is in activeConversations
      if (!this.activeConversations.includes(conversationId)) {
        this.activeConversations.push(conversationId);
      }
      // Ensure messagesMap entry exists
      if (!this.messagesMap[conversationId]) {
        this.messagesMap[conversationId] = [];
        this.requestChatHistory(conversationId, { mode: 'recent', turns: 5 });
      }
      this.saveOpenSessions();
    },
    // ★ Check if a conversation is in any panel
    isInAnyPanel(conversationId) {
      return this.panels.some(p => p.conversationId === conversationId);
    },
    // ★ Session Pin
    setSessionPinned(sessionId, pinned, meta = {}) {
      if (!sessionId) return;
      const agentId = meta && meta.agentId ? meta.agentId : null;
      const isPinned = agentId
        ? !!(getSessionsStore()?.sessionById?.(sessionId, agentId)?.pinned)
        : this.pinnedSessions.includes(sessionId);
      if (pinned && !isPinned) {
        this.pinnedSessions.unshift(sessionId);
      } else if (!pinned && isPinned) {
        const idx = this.pinnedSessions.indexOf(sessionId);
        if (idx >= 0) this.pinnedSessions.splice(idx, 1);
      }
      try {
        localStorage.setItem('pinned-sessions', JSON.stringify(this.pinnedSessions));
      } catch (e) {
        console.warn('[chat] failed to persist pinnedSessions:', e?.message || e);
      }
      // If this id is a Yeaft Session row, keep its metadata in sync too.
      // Chat conversations are ignored by the sessions store because they
      // don't exist in that map.
      try {
        const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
        const targetAgentId = resolveAgentIdForSession(this, sessionId, agentId);
        if (gs && typeof gs.applyPinState === 'function') gs.applyPinState(sessionId, !!pinned, targetAgentId);
      } catch (_) { /* no sessions store in some tests */ }
    },
    togglePin(sessionId, meta = {}) {
      const agentId = meta && meta.agentId ? meta.agentId : null;
      const row = agentId ? getSessionsStore()?.sessionById?.(sessionId, agentId) : null;
      const hasExplicitPinned = meta && Object.prototype.hasOwnProperty.call(meta, 'pinned');
      const isPinned = row ? !!row.pinned : (hasExplicitPinned ? !!meta.pinned : this.pinnedSessions.includes(sessionId));
      const nextPinned = !isPinned;
      // Optimistic local update; the server `session_pinned` ack reapplies
      // the authoritative state and updates Yeaft session row metadata.
      this.setSessionPinned(sessionId, nextPinned, { agentId });
      const payload = {
        type: nextPinned ? 'pin_session' : 'unpin_session',
        conversationId: sessionId,
      };
      if (meta && meta.sessionKind === 'yeaft') {
        payload.sessionKind = 'yeaft';
        if (meta.agentId) payload.agentId = meta.agentId;
        if (meta.sessionName) payload.sessionName = meta.sessionName;
        if (meta.workDir) payload.workDir = meta.workDir;
      }
      // Persist to server.
      this.sendWsMessage(payload);
    },
    isSessionPinned(sessionId) {
      return this.pinnedSessions.includes(sessionId);
    },
    /**
     * fix-yeaft-session-list-and-menu: single owner for `pinnedSessions`
     * + its localStorage cache. Called by the yeaft sessions store when a
     * server-decorated snapshot arrives so the in-memory + cached pin
     * state stays consistent with what the server says.
     *
     * Scoping rule — `pinnedSessions` is shared across chat + every
     * yeaft agent, so this call must only touch ids that belong to
     * `agentId`. Callers pass `isOwnedByAgent(id)` to identify which of
     * the currently-pinned ids are this agent's, so unpins coming from
     * agent A don't accidentally drop a pin owned by agent B (whose
     * snapshot will reconcile on its own pass) or by a chat session.
     *
     * @param {string|null} agentId
     * @param {Set<string>} pinnedInSnapshot  ids the snapshot says are pinned
     * @param {(id:string) => boolean} isOwnedByAgent  predicate for "this id is owned by `agentId`"
     */
    applyServerPinSnapshot(agentId, pinnedInSnapshot, isOwnedByAgent) {
      if (!Array.isArray(this.pinnedSessions)) return;
      // Add: snapshot pins the chat store doesn't know yet. unshift to
      // match togglePin's "newest at the front" ordering.
      const existing = new Set(this.pinnedSessions);
      const toAdd = [];
      for (const id of pinnedInSnapshot) {
        if (!existing.has(id)) toAdd.push(id);
      }
      if (toAdd.length > 0) {
        this.pinnedSessions = [...toAdd, ...this.pinnedSessions];
      }
      // Remove: pins this agent owns but the snapshot no longer marks
      // as pinned. Cross-agent / chat-owned ids are untouched.
      if (agentId) {
        const next = this.pinnedSessions.filter(id => {
          if (!isOwnedByAgent(id)) return true;       // foreign / chat / other agent
          return pinnedInSnapshot.has(id);             // this agent: obey snapshot
        });
        if (next.length !== this.pinnedSessions.length) {
          this.pinnedSessions = next;
        }
      }
      try {
        localStorage.setItem('pinned-sessions', JSON.stringify(this.pinnedSessions));
      } catch (e) {
        console.warn('[chat] failed to persist pinnedSessions:', e?.message || e);
      }
    },
    clearYeaftSessionProcessingIfIdle(sessionId, { agentId = null, ignoreStatuses = false } = {}) {
      if (!sessionId) return;
      const resolvedAgentId = agentId || resolveAgentIdForSession(this, sessionId);
      const hasActiveTurn = Object.values(this.activeVpTurns || {}).some((info) => (
        matchesYeaftRuntimeIdentity(info, sessionId, resolvedAgentId)
      ));
      if (hasActiveTurn) return;
      if (!ignoreStatuses) {
        const hasRunningStatus = Object.values(this.vpStatuses || {}).some((status) => (
          matchesYeaftRuntimeIdentity(status, sessionId, resolvedAgentId)
          && YEAFT_RUNNING_VP_STATES.has(status?.state)
        ));
        if (hasRunningStatus) return;
      }
      const processingKey = yeaftSessionIdentityKey(resolvedAgentId, sessionId);
      const next = { ...(this.yeaftProcessingSessions || {}) };
      if (processingKey) delete next[processingKey];
      if (hasUniqueLegacyYeaftSessionOwner(this, sessionId, resolvedAgentId)) delete next[sessionId];
      this.yeaftProcessingSessions = next;
    },
    sendMessage(text, attachments = [], options = {}) { convHelpers.sendMessage(this, text, attachments, options); },
    cancelExecution() { convHelpers.cancelExecution(this); },
    /**
     * Bug 5: Yeaft-mode stop. ChatInput's default cancel calls
     * cancelExecution() (Chat-mode), which sends `cancel_execution` keyed
     * to a Claude-CLI conversationId — that is a no-op for Yeaft because
     * Yeaft runs its own engine inside the agent and tracks abort
     * controllers per-thread. Send `yeaft_abort_all` instead so every
     * in-flight thread's AbortController fires. The agent emits
     * `yeaft_aborted` ack which clears `processingConversations` via the
     * standard pipeline.
     */
    cancelYeaft() {
      if (!this.currentAgent) return;
      this.sendWsMessage({
        type: 'yeaft_abort_all',
        agentId: this.currentAgent,
      });
      // Clear only this Agent's local runtime slice. The Web may be showing
      // same-id Sessions from other Agents in the unified catalog.
      const activeConversationId = this.yeaftConversationIdsByAgent?.[this.currentAgent] || this.yeaftConversationId;
      if (activeConversationId) delete this.processingConversations[activeConversationId];
      clearYeaftAgentRuntimeState(this, this.currentAgent);
    },
    cancelYeaftSession(sessionId) {
      const targetAgentId = resolveAgentIdForSession(this, sessionId);
      if (!targetAgentId || !sessionId) return;
      this.sendWsMessage({
        type: 'yeaft_abort_all',
        agentId: targetAgentId,
        sessionId,
      });
      this.activeVpTurns = Object.fromEntries(
        Object.entries(this.activeVpTurns || {}).filter(([, info]) => (
          !matchesYeaftRuntimeIdentity(info, sessionId, targetAgentId)
        ))
      );
      this.stoppingVpTurnIds = Object.fromEntries(
        Object.entries(this.stoppingVpTurnIds || {}).filter(([turnId]) => this.activeVpTurns?.[turnId])
      );
      this.vpStatuses = Object.fromEntries(
        Object.entries(this.vpStatuses || {}).filter(([, status]) => (
          !matchesYeaftRuntimeIdentity(status, sessionId, targetAgentId)
        ))
      );
      this.clearYeaftSessionProcessingIfIdle(sessionId, {
        agentId: targetAgentId,
        ignoreStatuses: true,
      });
    },
    /**
     * Per-VP stop: abort a single VP turn by turnId without affecting siblings.
     * `sessionId` / `vpId` are optional metadata for newer agents; old agents
     * still use the turnId-only path.
     */
    cancelVpTurn(turnId, { sessionId = null, vpId = null } = {}) {
      // sessionId is optional metadata from newer agents. When present we route
      // by the session's owner; the legacy turnId-only path (no sessionId)
      // resolves to currentAgent — matching the pre-refactor behavior where the
      // abort always hit the active page agent.
      const targetAgentId = resolveAgentIdForSession(this, sessionId);
      if (!targetAgentId || !turnId) return;
      const turnKey = yeaftTurnStateKey(this, targetAgentId, turnId);
      this.stoppingVpTurnIds = {
        ...this.stoppingVpTurnIds,
        [turnKey]: Date.now(),
      };
      const msg = {
        type: 'yeaft_abort_turn',
        agentId: targetAgentId,
        turnId,
      };
      if (sessionId) msg.sessionId = sessionId;
      if (vpId) msg.vpId = vpId;
      this.sendWsMessage(msg);
    },
    cancelVpTurnForSession(vpId, sessionId = null) {
      if (!vpId) return false;
      const targetSessionId = sessionId || this.yeaftActiveSessionFilter || null;
      if (!targetSessionId) return false;
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId);
      if (!targetAgentId) return false;
      const map = this.activeVpTurns || {};
      let bestTurnId = null;
      let bestStartedAt = -Infinity;
      for (const [turnKey, info] of Object.entries(map)) {
        if (!info || info.vpId !== vpId) continue;
        if (!matchesYeaftRuntimeIdentity(info, targetSessionId, targetAgentId)) continue;
        const ts = (typeof info.startedAt === 'number') ? info.startedAt : 0;
        if (ts >= bestStartedAt) {
          bestStartedAt = ts;
          bestTurnId = turnKey;
        }
      }
      if (!bestTurnId) {
        const status = this.vpStatuses?.[vpStatusKey(targetAgentId, targetSessionId, vpId)] || null;
        if (status?.turnId && !['idle', 'offline'].includes(status.state)) {
          bestTurnId = status.turnId;
        }
      }
      if (bestTurnId) {
        const rawTurnId = map[bestTurnId]?.turnId || bestTurnId;
        this.cancelVpTurn(rawTurnId, { sessionId: targetSessionId, vpId });
        return true;
      }
      this.sendWsMessage({
        type: 'yeaft_abort_turn',
        agentId: targetAgentId,
        sessionId: targetSessionId,
        vpId,
      });
      return true;
    },
    answerUserQuestion(requestId, answers, conversationId) { convHelpers.answerUserQuestion(this, requestId, answers, conversationId); },
    refreshAgents() { convHelpers.refreshAgents(this); },
    refreshConversation() { convHelpers.refreshConversation(this); },
    restartAgent(agentId) { convHelpers.restartAgent(this, agentId); },
    upgradeAgent(agentId) { convHelpers.upgradeAgent(this, agentId); },

    // ★ Phase 6.1: 分页加载（基于 turn，统一走 DB）
    loadMoreMessages() {
      // task-fix-yeaft-load-more-empty: action-level guard. The hint and
      // scroll-trigger in MessageList both gate on currentView, but this
      // is the authoritative stop — Yeaft history doesn't live in the
      // SQLite messageDb that `sync_messages` queries, so dispatching
      // here from Yeaft always returns empty. Any future caller (hotkey,
      // devtools, programmatic) is covered by this single line.
      if (this.currentView === 'yeaft') return;
      if (this.loadingMoreMessages || !this.hasMoreMessages || !this.currentConversation) return;
      this.loadingMoreMessages = true;
      // feat-chat-load-perf: per-call generation so a stale timer from an
      // earlier load-more can't clobber an in-flight second request's
      // spinner. Incremented before the WS dispatch; the setTimeout
      // closure compares against its captured value and bails if a newer
      // call has taken over.
      const generation = (this._loadMoreGeneration = (this._loadMoreGeneration || 0) + 1);

      const msgs = this.messagesMap[this.currentConversation] || [];
      const firstMsgWithId = msgs.find(m => m.dbMessageId);
      const targetConvId = this.currentConversation;
      const cursor = firstMsgWithId?.dbMessageId ?? null;
      this.requestChatHistory(targetConvId, {
        mode: 'older',
        turns: 5,
        beforeId: cursor,
      });

      // feat-chat-load-perf: client-side timeout so the spinner can't get
      // stuck forever. Pre-fix, `loadingMoreMessages` was only cleared by
      // `handleSyncMessagesResult` — any dropped WS message (reconnect mid-
      // flight, server timeout, agent crash) left the user with an
      // indefinite spinner and "history load doesn't work" UX. The 10s
      // budget is generous (a healthy sync round-trip is < 200ms); after
      // it expires we just clear the spinner so the user can scroll and
      // retry. The generation guard above prevents a stale timer from
      // clearing a fresh in-flight request, and the targetConvId match
      // prevents touching an unrelated conversation's UI state if the
      // user switches mid-flight. No clearTimeout by design — guards make
      // stale timers harmless and avoid plumbing a handle through the WS
      // reply path.
      setTimeout(() => {
        if (this._loadMoreGeneration !== generation) return;
        if (this.loadingMoreMessages && this.currentConversation === targetConvId) {
          console.warn('[loadMoreMessages] WS response timeout (10s); clearing spinner');
          this.loadingMoreMessages = false;
        }
      }, 10000);
    },

    /**
     * Yeaft-side counterpart to loadMoreMessages. Requests one more page of
     * older history (20 turns by default) for the active group, using the
     * cursor stamped by the latest `history_loaded` / `yeaft_history_chunk`
     * event. The agent reads from the persisted hot+cold conversation and
     * replies with a `yeaft_history_chunk` envelope; the chunk handler
     * prepends the messages to messagesMap and updates the cursor.
     *
     * Idempotent: re-entering while a page is in flight is a no-op
     * (`yeaftLoadingMoreHistory` gates), and we don't fire if the agent
     * already told us there's nothing more to load.
     */

    reloadYeaftMessages() {
      if (this.currentView !== 'yeaft') return false;
      const sessionId = resolveActiveYeaftSessionId(this);
      const targetAgentId = resolveAgentIdForSession(this, sessionId);
      if (!targetAgentId) return false;
      const sessionKey = yeaftHistoryIdentityKey(targetAgentId, sessionId);
      const convId = this.yeaftConversationId;

      // Manual reload means "show me the persisted pane again", not a delta.
      // Do not blank the pane before the reply arrives: load-history also
      // replays metadata (session_ready/status/VP snapshots), and those can be
      // slower than the disk read. The `recent` history chunk atomically
      // replaces this session's persisted rows when it lands, preserving any
      // live streaming row and preventing the refresh button from showing an
      // empty conversation during the round trip.

      const activeRequest = this.yeaftSessionHistoryState?.[sessionKey];
      if (activeRequest?.loading) {
        if (!activeRequest.requestId) return false;
        this._yeaftManualHistoryRefresh = {
          agentId: targetAgentId,
          sessionId,
          requestId: activeRequest.requestId,
        };
        return activeRequest.requestId;
      }
      const historyRequest = this.beginYeaftHistoryLoad({
        agentId: targetAgentId,
        sessionId,
        mode: 'recent',
        preserveLoaded: false,
      });
      if (!historyRequest) return false;
      this._yeaftManualHistoryRefresh = {
        agentId: targetAgentId,
        sessionId,
        requestId: historyRequest.requestId,
      };

      const perfTraceId = createPerfTraceId();
      this.yeaftHistoryPerfTraceBySession = {
        ...(this.yeaftHistoryPerfTraceBySession || {}),
        [sessionKey]: perfTraceId,
      };
      const payload = {
        type: 'yeaft_load_history',
        agentId: targetAgentId,
        limit: YEAFT_RECENT_TURNS,
        sessionId,
        requestId: historyRequest.requestId,
        perfTraceId,
      };
      recordPerfTrace(this, {
        traceId: perfTraceId,
        phase: 'history.request_send',
        agentId: targetAgentId,
        sessionId,
        messageType: payload.type,
        bytes: JSON.stringify(payload).length,
        detail: { mode: 'manual-reload', limit: YEAFT_RECENT_TURNS },
      });
      if (!this.sendWsMessage(payload)) {
        failYeaftHistoryLoad(this, {
          agentId: targetAgentId,
          sessionId,
          requestId: historyRequest.requestId,
          error: 'history_load_send_failed',
        });
        return false;
      }
      return true;
    },

    loadMoreYeaftHistory(turns = getYeaftWindowLoadStepTurns(), {
      sessionId = null,
      agentId = null,
      background = false,
    } = {}) {
      if (this.currentView !== 'yeaft') return false;
      const targetSessionId = sessionId || resolveActiveYeaftSessionId(this);
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId, agentId);
      if (!targetAgentId || !targetSessionId) return false;
      const sessionKey = yeaftHistoryIdentityKey(targetAgentId, targetSessionId);
      const previousState = this.yeaftSessionHistoryState?.[sessionKey] || {};
      if (previousState.loading || !previousState.hasMore) return false;
      const requestedTurns = Math.min(
        50,
        Math.max(1, Number.isFinite(turns) ? Math.floor(turns) : getYeaftWindowLoadStepTurns()),
      );

      const cacheRanges = this.yeaftHistoryCacheState?.[sessionKey]?.ranges || [];
      const cacheEpoch = Number(this.yeaftHistoryCacheState?.[sessionKey]?.rangeEpoch) || 0;
      const planned = planNextYeaftHistoryPage(previousState, cacheRanges, cacheEpoch);
      this.yeaftSessionHistoryState = {
        ...(this.yeaftSessionHistoryState || {}),
        [sessionKey]: planned.state,
      };
      if (!planned.request) {
        this.syncActiveYeaftHistoryLoad();
        return false;
      }
      const historyRequest = this.beginYeaftHistoryLoad({
        agentId: targetAgentId,
        sessionId: targetSessionId,
        mode: background ? 'prefetch' : 'older',
        preserveLoaded: true,
        latestSeq: this.yeaftSessionHistoryState[sessionKey]?.latestSeq ?? null,
      });
      if (!historyRequest) return false;
      const perfTraceId = createPerfTraceId();
      this.yeaftHistoryPerfTraceBySession = {
        ...(this.yeaftHistoryPerfTraceBySession || {}),
        [sessionKey]: perfTraceId,
      };
      const payload = {
        type: 'yeaft_load_more_history',
        agentId: targetAgentId,
        sessionId: targetSessionId,
        requestId: historyRequest.requestId,
        beforeSeq: planned.request.beforeSeq,
        pageKind: planned.request.kind,
        gapStopAtSeq: planned.request.stopAtSeq,
        cacheEpoch: planned.request.cacheEpoch,
        turns: requestedTurns,
        perfTraceId,
      };
      recordPerfTrace(this, {
        traceId: perfTraceId,
        phase: 'history_more.request_send',
        agentId: targetAgentId,
        sessionId: targetSessionId,
        messageType: payload.type,
        bytes: JSON.stringify(payload).length,
        detail: {
          beforeSeq: payload.beforeSeq,
          turns: payload.turns,
          pageKind: planned.request.kind,
          gapStopAtSeq: planned.request.stopAtSeq,
          background,
        },
      });
      if (!this.sendWsMessage(payload)) {
        failYeaftHistoryLoad(this, {
          agentId: targetAgentId,
          sessionId: targetSessionId,
          requestId: historyRequest.requestId,
          error: 'history_load_send_failed',
        });
        return false;
      }
      return true;
    },


    // =====================
    // Session persistence
    // =====================
    checkPendingRecovery() { sessionHelpers.checkPendingRecovery(this); },
    performRecovery() { sessionHelpers.performRecovery(this); },
    dismissRecovery() { sessionHelpers.dismissRecovery(this); },
    autoRestoreConversation(conversationId) { sessionHelpers.autoRestoreConversation(this, conversationId); },
    saveOpenSessions() { sessionHelpers.saveOpenSessions(this); },
    getLastSession() { return sessionHelpers.getLastSession(this); },
    clearLastSession() { sessionHelpers.clearLastSession(this); },
    listHistorySessions(workDir) { sessionHelpers.listHistorySessions(this, workDir); },
    listFolders() { return sessionHelpers.listFolders(this); },
    listFoldersForAgent(agentId, provider) { return sessionHelpers.listFoldersForAgent(this, agentId, provider); },
    listModelsForAgent(agentId, provider) { return sessionHelpers.listModelsForAgent(this, agentId, provider); },
    listHistorySessionsForAgent(agentId, workDir, provider) { sessionHelpers.listHistorySessionsForAgent(this, agentId, workDir, provider); },
    async loadGlobalSessions(limit = 20) { return sessionHelpers.loadGlobalSessions(this, limit); },
    async deleteGlobalSession(sessionId) { return sessionHelpers.deleteGlobalSession(this, sessionId); },
    findAgentForSession(session) { return sessionHelpers.findAgentForSession(this, session); },
    isSessionResumable(session) { return sessionHelpers.isSessionResumable(this, session); },

    // =====================
    // Watchdog
    // =====================
    _isRecentlyClosed(conversationId) { return watchdogHelpers.isRecentlyClosed(this, conversationId); },
    _startProcessingWatchdog(conversationId) { watchdogHelpers.startProcessingWatchdog(this, conversationId); },
    _resetProcessingWatchdog(conversationId) { watchdogHelpers.resetProcessingWatchdog(this, conversationId); },
    _stopProcessingWatchdog(conversationId) { watchdogHelpers.stopProcessingWatchdog(this, conversationId); },

    startRefreshTimeout(convId) {
      const target = convId || this.currentConversation;
      if (!target) return;
      if (!this._refreshTimeouts) this._refreshTimeouts = {};
      if (this._refreshTimeouts[target]) clearTimeout(this._refreshTimeouts[target]);
      this._refreshTimeouts[target] = setTimeout(() => {
        this.setRefreshingSession(target, false);
        delete this._refreshTimeouts[target];
      }, 10000);
    },

    // =====================
    // UI helpers
    // =====================
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      // User made an explicit choice — stop following the system from now on.
      this.themeFollowSystem = false;
      localStorage.setItem('theme', this.theme);
      document.documentElement.setAttribute('data-theme', this.theme);
      document.documentElement.classList.toggle('light', this.theme === 'light');
    },


    initTheme() {
      document.documentElement.setAttribute('data-theme', this.theme);
      document.documentElement.classList.toggle('light', this.theme === 'light');
      // If the user has never explicitly picked a theme, follow the OS.
      if (this.themeFollowSystem && typeof window !== 'undefined' && window.matchMedia) {
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const apply = (e) => {
          if (!this.themeFollowSystem) return;
          this.theme = e.matches ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', this.theme);
          document.documentElement.classList.toggle('light', this.theme === 'light');
        };
        if (mql.addEventListener) mql.addEventListener('change', apply);
        else if (mql.addListener) mql.addListener(apply);
      }
    },

    // models.dev registry loader. Returns the cached snapshot when fresh
    // (<1h) unless forceRefresh is true. Coalesces concurrent requests so
    // multiple LlmTab mounts don't fan out to N WebSocket requests.
    loadModelsDevRegistry({ forceRefresh = false } = {}) {
      const fresh = this.modelsDevRegistry.loaded
        && !this.modelsDevRegistry.error
        && (Date.now() - this.modelsDevRegistry.fetchedAt) < 60 * 60 * 1000;
      if (!forceRefresh && fresh) {
        return Promise.resolve(this.modelsDevRegistry);
      }
      const agentId = this.currentAgent;
      if (!agentId) {
        return Promise.resolve(this.modelsDevRegistry);
      }
      // Piggyback only when the in-flight request is at least as strong.
      // A pending non-force batch can't satisfy a forceRefresh caller —
      // otherwise the refresh button is a no-op during the 20s window.
      if (this._modelsDevPending && (!forceRefresh || this._modelsDevPending.force)) {
        return new Promise(resolve => this._modelsDevPending.resolvers.push(resolve));
      }
      // Pre-empt a weaker in-flight batch (resolve its waiters with the
      // current snapshot so they don't hang) before launching a stronger
      // one.
      if (this._modelsDevPending) {
        const old = this._modelsDevPending;
        this._modelsDevPending = null;
        if (old.timer) clearTimeout(old.timer);
        for (const r of old.resolvers) r(this.modelsDevRegistry);
      }
      return new Promise(resolve => {
        const batch = { resolvers: [resolve], force: forceRefresh, timer: null };
        this._modelsDevPending = batch;
        try {
          this.sendWsMessage({
            type: 'get_models_dev_registry',
            agentId,
            forceRefresh,
          });
        } catch (e) {
          if (this._modelsDevPending === batch) this._modelsDevPending = null;
          resolve(this.modelsDevRegistry);
          return;
        }
        // Safety timeout: clear pending after 20s so a dropped reply
        // doesn't permanently wedge the picker. Guarded so a later batch
        // (or a delivered reply that already cleared _modelsDevPending)
        // is not double-resolved.
        batch.timer = setTimeout(() => {
          if (this._modelsDevPending === batch) {
            this._modelsDevPending = null;
            for (const r of batch.resolvers) r(this.modelsDevRegistry);
          }
        }, 20000);
      });
    },

    changeLocale(locale) {
      this.locale = locale;
      setLocale(locale);
      // task-708: live-locale propagation. Push the new language to the
      // agent so the per-VP Engine pool (and 1:1-chat session.engine)
      // re-renders the system prompt in the chosen language on the very
      // next turn — no session reload required. Skipped when no Yeaft
      // agent is bound (Chat-only or pre-connect state).
      if (this.currentAgent) {
        try {
          this.sendWsMessage({
            type: 'update_llm_config',
            agentId: this.currentAgent,
            config: { language: locale },
          });
        } catch { /* best-effort; locale already applied to UI */ }
      }
    },

    // =====================
    // Custom expert roles CRUD
    // =====================
    async fetchCustomExpertRoles() {
      const authStore = useAuthStore();
      try {
        const headers = {};
        if (authStore.token) headers['Authorization'] = `Bearer ${authStore.token}`;
        const response = await fetch('/api/expert-roles/custom', { headers });
        if (response.ok) {
          const data = await response.json();
          this.customExpertRoles = data.roles || [];
        }
      } catch (err) {
        console.error('Failed to fetch custom expert roles:', err);
      }
    },

    async createCustomExpertRole(role) {
      const authStore = useAuthStore();
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (authStore.token) headers['Authorization'] = `Bearer ${authStore.token}`;
        const response = await fetch('/api/expert-roles/custom', {
          method: 'POST',
          headers,
          body: JSON.stringify(role)
        });
        if (response.ok) {
          const data = await response.json();
          this.customExpertRoles.push(data.role);
          return data.role;
        } else {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to create custom expert role');
        }
      } catch (err) {
        console.error('Failed to create custom expert role:', err);
        throw err;
      }
    },

    async updateCustomExpertRole(roleId, role) {
      const authStore = useAuthStore();
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (authStore.token) headers['Authorization'] = `Bearer ${authStore.token}`;
        const response = await fetch(`/api/expert-roles/custom/${roleId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(role)
        });
        if (response.ok) {
          const data = await response.json();
          const idx = this.customExpertRoles.findIndex(r => r.id === roleId);
          if (idx !== -1) {
            this.customExpertRoles[idx] = data.role;
          }
          return data.role;
        } else {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to update custom expert role');
        }
      } catch (err) {
        console.error('Failed to update custom expert role:', err);
        throw err;
      }
    },

    async deleteCustomExpertRole(roleId) {
      const authStore = useAuthStore();
      try {
        const headers = {};
        if (authStore.token) headers['Authorization'] = `Bearer ${authStore.token}`;
        const response = await fetch(`/api/expert-roles/custom/${roleId}`, {
          method: 'DELETE',
          headers
        });
        if (response.ok) {
          this.customExpertRoles = this.customExpertRoles.filter(r => r.id !== roleId);
          return true;
        } else {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to delete custom expert role');
        }
      } catch (err) {
        console.error('Failed to delete custom expert role:', err);
        throw err;
      }
    },

    openWorkbench() {
      this.workbenchExpanded = true;
      this.activeRightPanel = null;
      this.closeYeaftDebugPanel();
    },

    toggleWorkbench() {
      if (this.workbenchExpanded) {
        this.workbenchExpanded = false;
        this.workbenchMaximized = false;
        return;
      }
      this.openWorkbench();
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },

    toggleSessionSidebar() {
      this.sessionSidebarOpen = !this.sessionSidebarOpen;
    },

    closeSessionSidebar() {
      this.sessionSidebarOpen = false;
    },

    toggleWorkbenchMaximized() {
      this.workbenchMaximized = !this.workbenchMaximized;
    },

    renameChatSession(convId, title, agentId = null) {
      const trimmed = title && title.trim() ? title.trim() : '';
      if (trimmed) this.customConversationTitles[convId] = trimmed;
      else delete this.customConversationTitles[convId];
      this.sendWsMessage({
        type: 'update_conversation_settings',
        conversationId: convId,
        ...(agentId ? { agentId } : {}),
        title: trimmed,
      });
    },

    openFileInExplorer(filePath, { hideTree = false, line = null } = {}) {
      const route = this.activeSessionRoute;
      const agentId = route?.agentId || this.currentAgent || null;
      const conversationId = route?.runtimeProvider === 'yeaft'
        ? resolveYeaftConversationIdForSession(this, route.sessionId, agentId)
        : this.currentConversation;
      const canOpenFiles = this.workbenchRouteProtocolSupported === true
        && (agentId === this.currentAgent
          ? this.hasCapability('file_editor') && this.hasCapability('workbench_session_routes')
          : agentHasCapability(this, agentId, 'file_editor')
            && agentHasCapability(this, agentId, 'workbench_session_routes'));
      if (!agentId || !conversationId || !canOpenFiles) return false;
      const path = typeof filePath === 'string' ? filePath.trim() : '';
      if (!path) return false;
      const wasExpanded = this.workbenchExpanded;
      this.openWorkbench();
      this.workbenchMaximized = false;
      const dispatchOpen = () => window.dispatchEvent(new CustomEvent('open-file-in-explorer', {
        detail: {
          filePath: path,
          agentId,
          conversationId,
          workDir: this.effectiveWorkDir || '',
          workbenchRoute: route ? {
            runtimeProvider: route.runtimeProvider,
            agentId: route.agentId,
            sessionId: route.sessionId,
          } : null,
          hideTree: !!hideTree,
          line: Number.isFinite(line) && line > 0 ? line : null,
        }
      }));
      if (wasExpanded) dispatchOpen();
      else Vue.nextTick(dispatchOpen);
      return true;
    },

    logout() {
      const authStore = useAuthStore();
      authStore.logout();
      this.authenticated = false;
      this.sessionKey = null;
      this.agents = [];
      this.currentAgent = null;
      this.currentAgentInfo = null;
      this.yeaftStatusByAgent = {};
      this._yeaftRetiredCatalogEpochsByAgent = {};
      this.conversations = [];
      this.activeConversations = [];
      this.messagesMap = {};
      this.conversationTitles = {};
      this.customConversationTitles = {};
      this.processingConversations = {};
      this.executionStatusMap = {};
      this.workbenchExpanded = false;
      this.subagents = {};
      this.activeSubagentId = null;
      this.activeRightPanel = null;
      this.pinnedSessions = [];
      this.clearWorkCenterBrowserState();
      if (this.ws) {
        this.ws.close();
      }
    }
  }
});
