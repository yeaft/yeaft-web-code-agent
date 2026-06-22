import { useAuthStore } from './auth.js';
import { setLocale, getLocale } from '../utils/i18n.js';

// Helper modules
import * as wsHelpers from './helpers/websocket.js';
import * as msgHelpers from './helpers/messages.js';
import * as assistantOutputHelpers from './helpers/assistantOutput.js';
import * as handlerHelpers from './helpers/messageHandler.js';
import * as convHelpers from './helpers/conversation.js';
import * as sessionHelpers from './helpers/session.js';
import * as watchdogHelpers from './helpers/watchdog.js';
import * as crewHelpers from './helpers/crew.js';
import * as yeaftViewHelpers from './helpers/yeaft-view.js';
import { incVpTyping, decVpTyping } from './helpers/vp-typing.js';
import { selectActiveConversationId } from './helpers/active-conv.js';
import { trimDebugRetention } from './helpers/debug-retention.js';
import {
  getDefaultYeaftVisibleTurns,
  getYeaftWindowLoadStepTurns,
  hasHiddenScopedYeaftMessageTurns,
  sliceScopedYeaftMessagesByRecentTurns,
} from './helpers/yeaft-message-window.js';

const { defineStore } = Pinia;

// Stable empty array for getters — avoids creating new [] on every call,
// which prevents Vue computed from treating each call as a new value.
const EMPTY_ARRAY = Object.freeze([]);

// vp-status (2026-05-15): composite key used by the `vpStatuses` map.
// Mirrors the agent broker's `keyOf` (see vp-status-broker.js): the
// same vpId can appear in multiple groups, so keying by vpId alone
// would conflate concurrent VP turns across groups. Null/undefined
// groupId is normalized to empty string so cross-group lookups stay
// deterministic.
const vpStatusKey = (groupId, vpId) => `${groupId || ''}::${vpId}`;

// Bootstrap pane window when no delta cursor is known yet (cold start, or
// a session the UI has never seen). User-confirmed: 5 turns is the sweet
// spot — small enough to paint instantly, large enough to give context.
const YEAFT_RECENT_TURNS = 5;
const YEAFT_RECENT_TERMINAL_TASK_LIMIT = 8;
const YEAFT_TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'orphaned']);

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

function taskUpdatedTime(task) {
  const raw = task?.updatedAt || task?.endedAt || task?.createdAt;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function taskStopKey(sessionId, taskId) {
  return `${sessionId || ''}::${taskId || ''}`;
}

function keepRecentSessionTasks(tasksById) {
  const entries = Object.entries(tasksById || {});
  const running = entries.filter(([, task]) => task?.status === 'running');
  const terminal = entries
    .filter(([, task]) => task && task.status !== 'running' && YEAFT_TERMINAL_TASK_STATUSES.has(task.status))
    .sort((a, b) => taskUpdatedTime(b[1]) - taskUpdatedTime(a[1]))
    .slice(0, YEAFT_RECENT_TERMINAL_TASK_LIMIT);
  return Object.fromEntries([...running, ...terminal]);
}

function getSessionsStore() {
  try {
    if (typeof window === 'undefined') return null;
    return window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore()) || null;
  } catch {
    return null;
  }
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
function resolveAgentIdForSession(state, sessionId) {
  if (sessionId) {
    const gs = getSessionsStore();
    const sess = gs && typeof gs.sessionById === 'function' ? gs.sessionById(sessionId) : null;
    if (sess && sess.agentId) return sess.agentId;
    const mapped = state?.yeaftSessionAgentById ? state.yeaftSessionAgentById[sessionId] : null;
    if (mapped) return mapped;
  }
  return state?.currentAgent || null;
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

function resolveYeaftConversationIdForSession(state, sessionId = null) {
  const targetSessionId = sessionId || state?.yeaftActiveSessionFilter || null;
  // Reuse the single owner-resolver so this stays in lock-step with how
  // sends / history / aborts pick the agent. (sessions store → per-session
  // cache → currentAgent.)
  const agentId = resolveAgentIdForSession(state, targetSessionId);
  const agentConversationId = agentId && state?.yeaftConversationIdsByAgent
    ? state.yeaftConversationIdsByAgent[agentId]
    : null;
  return agentConversationId || state?.yeaftConversationId || null;
}

// Debug history is request-bounded on disk. The panel loads the newest
// 5 requests globally by default and search results are clamped to the same
// window so the debug channel cannot flood the WebSocket while the agent is
// busy. A single request can legitimately run 100-200 loops, so the live
// in-memory loop cap must not be smaller than that or the panel will miss loops
// while the request is still streaming. 1000 covers the expected 5-request
// window while staying finite.
const MAX_YEAFT_DEBUG_LOOPS = 1000;
const DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT = 5;

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
    // Per-Yeaft-session processing state: sessionId -> true. Chat uses the
    // virtual conversation id for active dots; Yeaft needs session scope so a
    // running turn in session A does not light up every session row.
    yeaftProcessingSessions: {},
    theme: localStorage.getItem('theme') || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    themeFollowSystem: !localStorage.getItem('theme'),
    locale: localStorage.getItem('locale') || 'zh-CN',
    // Crew mode is opt-in via Settings → General. When disabled, the
    // sidebar collapses to a single full-width Chat tab, matching the
    // visual structure of the Yeaft sidebar. Default: disabled.
    crewModeEnabled: localStorage.getItem('crewModeEnabled') === 'true',
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
    // 临时保存恢复会话时的标题
    _pendingSessionTitle: null,
    // Workbench 面板是否展开（替代 backgroundPanelExpanded）
    workbenchExpanded: false,
    // Workbench 面板是否最大化（隐藏 conversation）
    workbenchMaximized: false,
    // 左侧侧边栏是否收起
    sidebarCollapsed: false,
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
    // Group-scoped Yeaft history cursors/cache metadata. The legacy three
    // flags above mirror the currently active group for component
    // compatibility; this map is the source of truth across group switches.
    // Shape: { [groupId || '__all__']: { loaded, hasMore, loading, oldestSeq, count } }
    yeaftSessionHistoryState: {},
    // Yeaft render window: keep full history in messagesMap, but expose only
    // the newest N turn groups to MessageList until the user scrolls up. Keyed
    // by sessionId (or '__all__' when no filter is active) so switching sessions
    // does not leak another session's expanded window.
    yeaftMessageWindowState: {},
    // De-dupe metadata-only Yeaft bootstrap requests while waiting for the
    // session_ready replay. Group history requests are de-duped separately by
    // yeaftSessionHistoryState[groupId].loading.
    yeaftBootstrapMetaLoadingKey: null,
    // One-shot marker: set true by the websocket onclose handler on a real
    // disconnect, consumed by handleAgentList to run a single Yeaft history
    // catch-up after the socket comes back. Without this gate the catch-up
    // would re-fire on every routine agent_list broadcast (status flips,
    // turn_completed, latency pings) and spin yeaft_load_history /
    // yeaft_vp_subscribe into an unbounded loop.
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
    // Last live Tavily /usage probe.
    //   { plan, used, limit, paygoUsed, paygoLimit } | { error }
    tavilyUsage: null,
    tavilyUsageLoading: false,

    // Yeaft MCP servers UI state — populated from `yeaft_mcp_list_result`
    // (initial load) and refreshed on every `yeaft_mcp_updated` broadcast
    // (after add/remove/reload on any client). Shape:
    //   yeaftMcpServers: [{ name, command, args, env }, ...]
    //   yeaftMcpRuntime: { connected, toolCount, perServer: [{ name, ready, toolCount }] }
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
    // Crew (multi-agent) 状态 — 按 sessionId 存储，融入 conversation 体系
    // =====================
    crewSessions: {},             // { [sessionId]: { id, projectDir, sharedDir, roles, decisionMaker } }
    crewSessionListIdsByAgent: {}, // { [agentId]: sessionId[] } latest explicit Crew list snapshot
    crewMessagesMap: {},          // { [sessionId]: messages[] }
    crewOlderMessages: {},       // { [sessionId]: { hasMore, nextShard, loading } }
    crewStatuses: {},             // { [sessionId]: { status, currentRole, round, costUsd, activeRoles } }
    crewNotifications: [],        // [{ id, fromRole, fromIcon, fromName, toRole, toIcon, toName, taskId, taskTitle, timestamp }]
    crewExistsResult: null,       // check_crew_exists 结果: { exists, projectDir, sessionInfo }
    splitConvModalOpen: false,    // 分屏模式下新建会话 modal 是否打开
    crewConfigOpen: false,        // crew 配置面板是否打开
    crewConfigMode: 'create',    // 'create' | 'edit'
    crewMobilePanel: null,       // null | 'roles' | 'features' — 移动端 Drawer 状态
    crewPanelVisible: { roles: false, features: true }, // 桌面端面板可见性
    crewInProgressCount: 0,      // legacy global fallback for non-split mode
    crewInProgressCountMap: {},   // per-conversation: { [convId]: number }

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
    currentView: 'chat',           // 'chat' | 'yeaft' — 顶级页面切换
    yeaftConversationId: null,     // 当前 Yeaft agent 的虚拟 conversationId（从 agent session_ready 获取）
    yeaftConversationIdsByAgent: {}, // { [agentId]: conversationId } 跨机器 agent 的 Yeaft message cache 隔离
    yeaftSessionAgentById: {},      // { [sessionId]: agentId } 用 active session 反查所属 agent 的 conversationId
    yeaftModel: null,              // agent/default Yeaft 模型名；Session override lives in sessions[].config.model
    yeaftModelEffort: null,        // agent/default effort；Session override lives in sessions[].config.modelEffort
    yeaftSessionReady: false,     // Session 是否已初始化
    yeaftStatus: null,            // { skills, mcpServers, tools } 从 session_ready 获取
    yeaftAvailableModels: [],     // 可用模型列表 [{ id, provider, label }]
    yeaftStatusByAgent: {},       // { [agentId]: cached yeaft_status/session_ready payload }
    yeaftModelsRefreshing: false, // 当前 agent 的 model/status 后台刷新状态
    yeaftModelRefreshError: null, // 当前 agent 最近一次 refresh 错误（保留旧模型列表）
    yeaftYeaftDir: null,          // agent 的 ~/.yeaft 绝对路径（session_ready 携带）— Yeaft workbench 的默认 workDir
    yeaftActiveTasksBySession: {}, // { [sessionId]: { [taskId]: running or recent terminal task snapshot } }
    yeaftStoppingTasksById: {}, // { [`${sessionId}::${taskId}`]: true } UI-side pending stop requests
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
    yeaftDebugHistoryLimit: DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT,
    yeaftDebugHistoryHasMore: false,
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

    // ★ task-334-ui-c: VP detail view. When non-null, YeaftPage switches
    // the center pane to the VpDetailView component (mirrors the
    // task-315 pattern). Esc / breadcrumb back clears. Stays null in
    // legacy 1:1 mode — only entered by clicking a VpAvatar/VpBadge in
    // a VP-speaker-headed turn or a VP library row.
    yeaftActiveVpDetailId: null,

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
        const sessionKey = state.yeaftActiveSessionFilter || '__all__';
        const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
          || getDefaultYeaftVisibleTurns();
        return sliceScopedYeaftMessagesByRecentTurns(raw, state.yeaftActiveSessionFilter || null, visibleTurns);
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
      const sessionKey = state.yeaftActiveSessionFilter || '__all__';
      const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
        || getDefaultYeaftVisibleTurns();
      return sliceScopedYeaftMessagesByRecentTurns(raw, state.yeaftActiveSessionFilter || null, visibleTurns);
    },
    hasHiddenYeaftMessages(state) {
      if (state.currentView !== 'yeaft') return false;
      const convId = resolveYeaftConversationIdForSession(state);
      const raw = convId ? (state.messagesMap[convId] || EMPTY_ARRAY) : EMPTY_ARRAY;
      const sessionKey = state.yeaftActiveSessionFilter || '__all__';
      const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
        || getDefaultYeaftVisibleTurns();
      return hasHiddenScopedYeaftMessageTurns(raw, state.yeaftActiveSessionFilter || null, visibleTurns);
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
    // Chat/Crew use the active conversation id; Yeaft must be scoped to the
    // selected Session because one virtual Yeaft conversation contains many
    // Sessions and VP turns can overlap across them.
    isProcessing: (state) => {
      if (state.currentView === 'yeaft') {
        const sessionId = resolveActiveYeaftSessionId(state);
        if (!sessionId) return false;
        if (state.yeaftProcessingSessions?.[sessionId]) return true;
        for (const info of Object.values(state.activeVpTurns || {})) {
          if (info?.sessionId === sessionId) return true;
        }
        return false;
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
    isConversationCompacting: (state) => (conversationId) => {
      if (!conversationId) return false;
      return state.compactStatus?.conversationId === conversationId
        && state.compactStatus?.status === 'compacting';
    },
    isYeaftSessionProcessing: (state) => (sessionId) => {
      if (!sessionId) return false;
      if (state.yeaftProcessingSessions?.[sessionId]) return true;
      for (const info of Object.values(state.activeVpTurns || {})) {
        if (info?.sessionId === sessionId) return true;
      }
      return false;
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
    // 当前 conversation 是否是 Crew
    currentConversationIsCrew: (state) => {
      if (!state.currentConversation) return false;
      const conv = state.conversations.find(c => c.id === state.currentConversation);
      return conv?.type === 'crew';
    },
    // 当前 conversation 的 MCP servers 列表
    currentMcpServers: (state) => {
      if (!state.currentConversation) return EMPTY_ARRAY;
      return state.conversationMcpServers[state.currentConversation] || EMPTY_ARRAY;
    },
    // 当前 Crew session 信息
    currentCrewSession: (state) => {
      if (!state.currentConversation) return null;
      return state.crewSessions[state.currentConversation] || null;
    },
    // 当前 Crew 状态
    currentCrewStatus: (state) => {
      if (!state.currentConversation) return null;
      return state.crewStatuses[state.currentConversation] || null;
    },
    // 当前 Crew 消息列表
    currentCrewMessages: (state) => {
      if (!state.currentConversation) return EMPTY_ARRAY;
      return state.crewMessagesMap[state.currentConversation] || EMPTY_ARRAY;
    }
  },

  actions: {
    // =====================
    // Yeaft 页面
    // =====================
    cacheYeaftAgentStatus(agentId, status) {
      if (!agentId || !status) return;
      const previous = this.yeaftStatusByAgent[agentId] || {};
      const availableModels = Array.isArray(status.availableModels)
        ? status.availableModels
        : (previous.availableModels || []);
      const next = {
        ...previous,
        ...status,
        availableModels,
      };
      this.yeaftStatusByAgent = { ...this.yeaftStatusByAgent, [agentId]: next };
      if (this.currentAgent === agentId) {
        this.applyCachedYeaftStatus(agentId);
      }
    },
    applyCachedYeaftStatus(agentId = this.currentAgent) {
      const cached = agentId ? this.yeaftStatusByAgent[agentId] : null;
      if (!cached) return false;
      if (cached.model) this.yeaftModel = cached.model;
      if (Array.isArray(cached.availableModels)) this.yeaftAvailableModels = cached.availableModels;
      this.yeaftModelsRefreshing = !!cached.refreshing;
      this.yeaftModelRefreshError = cached.refreshError || null;
      if (cached.yeaftDir) this.yeaftYeaftDir = cached.yeaftDir;
      this.yeaftStatus = {
        skills: cached.skills,
        mcpServers: cached.mcpServers,
        tools: cached.tools,
        multiVp: !!cached.multiVp,
      };
      return true;
    },
    enterYeaft(agentId = null) {
      const previousAgentId = this.currentAgent;
      // Capture the chat-side activeConversations snapshot BEFORE flipping
      // currentView. The transition helper is idempotent: if we're
      // already in Yeaft (e.g. switching agents, programmatic re-entry,
      // a redundant call), it will NOT overwrite the existing snapshot
      // with the yeaft-only array — which would otherwise cause
      // leaveYeaft to "restore" the yeaft conversationId back into Chat
      // and leak yeaft messages into the Chat view.
      //
      // The agent the Yeaft page operates on is `currentAgent` — the single
      // client/server-synced pointer. Pick an explicit agent, else keep the
      // current one, else fall back to the first online agent.
      let targetAgentId = agentId || this.currentAgent || null;
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
      this.requestYeaftSessionBootstrap({ forceSessionReady: true, catchUpHistory: true });
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

    requestYeaftSessionBootstrap({ forceSessionReady = false, catchUpHistory = false } = {}) {
      if (!this.currentAgent) return;
      const activeSessionId = resolveActiveYeaftSessionId(this);
      const sessionState = activeSessionId
        ? this.yeaftSessionHistoryState[activeSessionId]
        : null;
      const needSessionReady = forceSessionReady || !this.yeaftSessionReady || !this.yeaftModel || !this.yeaftStatus;
      const latestSeq = Number.isFinite(sessionState?.latestSeq) ? sessionState.latestSeq : null;
      const needHistoryReplay = !!activeSessionId && !sessionState?.loaded && !sessionState?.loading;
      const needHistoryCatchUp = !!activeSessionId
        && msgHelpers.shouldCatchUpLoadedYeaftSession(sessionState, catchUpHistory);
      if (!needSessionReady && !needHistoryReplay && !needHistoryCatchUp) return false;
      // Route session-scoped history through the single resolver (sessions
      // store → per-session cache → currentAgent), same as every other
      // session-scoped emitter. The old inline `cache || currentAgent` skipped
      // the authoritative sessionById lookup, so in the cold/cross-agent window
      // it could ship yeaft_load_history to an agent that doesn't own the
      // session — the exact misroute this refactor removes.
      const targetAgentId = activeSessionId
        ? resolveAgentIdForSession(this, activeSessionId)
        : this.currentAgent;
      const metaKey = `${targetAgentId}:${activeSessionId || '__none__'}`;
      const metadataOnly = needSessionReady && !needHistoryReplay && !needHistoryCatchUp;
      if (metadataOnly && this.yeaftBootstrapMetaLoadingKey === metaKey) return false;
      if (metadataOnly) this.yeaftBootstrapMetaLoadingKey = metaKey;
      if (activeSessionId && needHistoryReplay) {
        this.yeaftSessionHistoryState = {
          ...this.yeaftSessionHistoryState,
          [activeSessionId]: { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
        };
        this.yeaftLoadingMoreHistory = true;
      } else if (activeSessionId && needHistoryCatchUp) {
        this.yeaftSessionHistoryState = {
          ...this.yeaftSessionHistoryState,
          [activeSessionId]: { ...sessionState, loaded: true, loading: true, latestSeq },
        };
        this.yeaftLoadingMoreHistory = true;
      }
      const payload = {
        type: 'yeaft_load_history',
        agentId: targetAgentId,
        sessionId: activeSessionId,
      };
      if (needHistoryCatchUp) payload.afterSeq = latestSeq;
      else payload.limit = needHistoryReplay ? YEAFT_RECENT_TURNS : 0;
      this.sendWsMessage(payload);
      return true;
    },
    leaveYeaft() {
      this.currentView = 'chat';
      // VP-block redesign (2026-05-08): the per-turn detail drawer was
      // retired; nothing to clear here.
      // Restore the original activeConversations snapshot taken on the
      // last real Chat → Yeaft transition (idempotent — no-op if cold).
      yeaftViewHelpers.applyLeaveYeaftTransition(this);
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
      if (!this.currentAgent) return;
      const rawLimit = Number.isFinite(limit) && limit > 0 ? limit : this.yeaftDebugHistoryLimit || DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT;
      const requestedLimit = Math.max(1, Math.min(DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT, rawLimit));
      const searchPattern = typeof search === 'string' ? search.trim() : (this.yeaftDebugSearch || '').trim();
      const isDetailRequest = typeof detailTurnId === 'string' && detailTurnId;
      const requestKind = isDetailRequest ? 'detail' : 'list';
      const requestId = `dbg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const requestKey = JSON.stringify({
        agentId: this.currentAgent,
        groupId: groupId || null,
        limit: requestedLimit,
        dreamLimit: Number.isFinite(dreamLimit) && dreamLimit > 0 ? dreamLimit : 5,
        indexOnly: !!indexOnly,
        detailTurnId: detailTurnId || null,
        search: isDetailRequest ? '' : searchPattern,
      });
      if (this._yeaftDebugHistoryInFlightKey === requestKey) return;
      this._yeaftDebugHistoryInFlightKey = requestKey;
      if (!isDetailRequest) this._yeaftDebugHistoryLatestListRequestId = requestId;
      this.yeaftDebugHistoryLimit = requestedLimit;
      this.yeaftDebugHistoryLoading = true;
      this.yeaftDebugHistoryError = null;
      const payload = {
        type: 'yeaft_fetch_debug_history',
        agentId: this.currentAgent,
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
      this._fetchYeaftDebugHistoryTimer = setTimeout(() => {
        if (this.yeaftDebugHistoryLoading) {
          this.yeaftDebugHistoryLoading = false;
          this.yeaftDebugHistoryError = 'Debug history is unavailable right now. Try again after the agent reconnects.';
        }
        this._yeaftDebugHistoryInFlightKey = null;
        this._fetchYeaftDebugHistoryTimer = null;
      }, 10_000);
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
     *                               isImage?:boolean,mimeType?:string}>}} payload
     */
    sendYeaftSessionMessage({ groupId, text, mentions, attachments }) {
      // Route by the session's owning agent, not a page-level pointer. A
      // cross-agent click or a late session_ready replay used to leave the
      // old `yeaftAgentId` pointing at a different agent, so the send hit an
      // agent that has no such session on disk → "Session not found".
      const targetAgentId = resolveAgentIdForSession(this, groupId);
      if (!groupId || !targetAgentId) return;
      const safeAttachments = Array.isArray(attachments)
        ? attachments.filter((a) => a && a.fileId)
        : [];
      // PR #721: image-only send guard. The previous early-return on
      // `!text?.trim()` silently dropped sends where the user attached
      // a file with no text. When attachments are present we synthesize
      // a placeholder so the agent path runs end-to-end; the LLM still
      // sees the image content blocks via `_promptParts`.
      const hasAttachments = safeAttachments.length > 0;
      if (!text?.trim() && !hasAttachments) return;
      const effectiveText = text?.trim() ? text : '(attached files)';
      const clientMessageId = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const activeYeaftConvId = resolveYeaftConversationIdForSession(this, groupId);
      if (activeYeaftConvId) {
        const localMsg = {
          id: clientMessageId,
          messageId: clientMessageId,
          type: 'user',
          content: effectiveText,
          sessionId: groupId,
          // Use the client message id as the optimistic local turn id so
          // the row has a stable message-block key until server frames arrive.
          turnId: clientMessageId,
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
        this.addMessageToConversation(activeYeaftConvId, localMsg);
        this.processingConversations[activeYeaftConvId] = true;
        if (groupId) {
          this.yeaftProcessingSessions = {
            ...this.yeaftProcessingSessions,
            [groupId]: true,
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
      this.sendWsMessage(wsMsg);
    },

    cancelYeaftTask({ sessionId, taskId }) {
      const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      const targetTaskId = typeof taskId === 'string' ? taskId.trim() : '';
      const targetAgentId = resolveAgentIdForSession(this, targetSessionId);
      if (!targetAgentId || !targetSessionId || !targetTaskId) return false;
      this.yeaftStoppingTasksById = {
        ...this.yeaftStoppingTasksById,
        [taskStopKey(targetSessionId, targetTaskId)]: true,
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

    getYeaftMessageWindowKey(sessionId = null) {
      return sessionId || this.yeaftActiveSessionFilter || '__all__';
    },

    pruneYeaftMessageWindow(sessionId = null) {
      if (this.currentView !== 'yeaft') return;
      const sessionKey = this.getYeaftMessageWindowKey(sessionId);
      this.yeaftMessageWindowState = {
        ...this.yeaftMessageWindowState,
        [sessionKey]: { visibleTurns: getDefaultYeaftVisibleTurns() },
      };
    },

    expandYeaftMessageWindow(sessionId = null, turns = getYeaftWindowLoadStepTurns()) {
      if (this.currentView !== 'yeaft') return;
      const sessionKey = this.getYeaftMessageWindowKey(sessionId);
      const current = this.yeaftMessageWindowState[sessionKey]?.visibleTurns
        || getDefaultYeaftVisibleTurns();
      const next = current + Math.max(1, Number.isFinite(turns) ? Math.floor(turns) : getYeaftWindowLoadStepTurns());
      this.yeaftMessageWindowState = {
        ...this.yeaftMessageWindowState,
        [sessionKey]: { visibleTurns: next },
      };
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

      // ── Assistant output frame data: dispatch through the shared pipeline ──
      if (msg.data) {
        const conversationId = msg.conversationId || this.yeaftConversationId;
        if (conversationId) {
          const frameAgentId = msg.agentId || this.yeaftAgentId || this.currentAgent || null;
          const previousAgentConvId = frameAgentId && this.yeaftConversationIdsByAgent
            ? this.yeaftConversationIdsByAgent[frameAgentId]
            : null;
          if (this.currentView === 'yeaft' && frameAgentId && previousAgentConvId && previousAgentConvId !== conversationId) {
            const existingMsgs = this.messagesMap[previousAgentConvId] || [];
            const targetMsgs = this.messagesMap[conversationId] || [];
            this.messagesMap[conversationId] = msgHelpers
              .mergeMessagesByStableId(targetMsgs, existingMsgs)
              .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            if (String(previousAgentConvId).startsWith('yeaft-local-')) delete this.messagesMap[previousAgentConvId];
          }
          if (frameAgentId) {
            this.yeaftConversationIdsByAgent = {
              ...(this.yeaftConversationIdsByAgent || {}),
              [frameAgentId]: conversationId,
            };
          }
          this.yeaftConversationId = conversationId;
          if (this.currentView === 'yeaft') this.activeConversations = [conversationId];
          // Ensure messagesMap exists for this conversation
          if (!this.messagesMap[conversationId]) {
            this.messagesMap[conversationId] = [];
          }
          if (this.currentView === 'yeaft' && (msg.data?.type === 'user' || msg.data?.type === 'text_delta')) {
            this.pruneYeaftMessageWindow(this.yeaftActiveSessionFilter ? (msg.sessionId || null) : null);
          }
          // Stamp the in-flight SEND-context session so messages land in the
          // originating session regardless of the user's current filter.
          // Inbound envelopes now carry `sessionId` (legacy `groupId` is
          // accepted as a fallback for older agents that haven't been
          // upgraded yet — drop after the next major version).
          const msgSessionId = msg.sessionId;
          const prevGroup = this._currentYeaftSessionId;
          const prevVpId = this._currentYeaftVpId;
          const prevTurnId = this._currentYeaftTurnId;
          if (msgSessionId != null) this._currentYeaftSessionId = msgSessionId;
          if (msg.vpId) this._currentYeaftVpId = msg.vpId;
          if (msg.turnId) this._currentYeaftTurnId = msg.turnId;
          // (2026-05-13) featureId stamping removed along with the Feature system.
          try {
            const shouldPruneWindow = this.currentView === 'yeaft'
              && msgSessionId
              && (!this.yeaftActiveSessionFilter || msgSessionId === this.yeaftActiveSessionFilter);
            if (shouldPruneWindow) this.pruneYeaftMessageWindow(this.yeaftActiveSessionFilter ? msgSessionId : null);
            this.handleAssistantOutputFrame(conversationId, msg.data);
            // Advance the delta cursor on every live user/assistant
            // message arrival so the next re-entry of this session can
            // request afterSeq instead of replaying the recent window.
            // Cheap: only inspects the id and the prev cursor.
            const data = msg.data;
            const liveId = data?.message?.id || data?.id || null;
            const seq = parseYeaftMessageSeq(liveId);
            if (seq !== null && msgSessionId) {
              const sessionKey = msgSessionId;
              const prevState = this.yeaftSessionHistoryState[sessionKey] || {};
              const prevLatest = Number.isFinite(prevState.latestSeq) ? prevState.latestSeq : -1;
              if (seq > prevLatest) {
                this.yeaftSessionHistoryState = {
                  ...this.yeaftSessionHistoryState,
                  [sessionKey]: { ...prevState, latestSeq: seq },
                };
              }
            }
          } finally {
            this._currentYeaftSessionId = prevGroup;
            this._currentYeaftVpId = prevVpId;
            this._currentYeaftTurnId = prevTurnId;
          }
        }
        return;
      }

      // ── Metadata events ──
      const event = msg.event;
      if (!event) return;

      switch (event.type) {
        case 'session_ready': {
          const agentConvId = event.conversationId;
          const statusAgentId = msg.agentId || this.currentAgent;
          const previousAgentConvId = statusAgentId && this.yeaftConversationIdsByAgent
            ? this.yeaftConversationIdsByAgent[statusAgentId]
            : null;
          const currentConvId = this.yeaftConversationId ? String(this.yeaftConversationId) : '';
          const fallbackLocalConvId = currentConvId.startsWith('yeaft-local-')
            && (!statusAgentId || currentConvId.startsWith(`yeaft-local-${statusAgentId}-`) || /^yeaft-local-\d/.test(currentConvId))
            ? this.yeaftConversationId
            : null;
          const localConvId = previousAgentConvId || fallbackLocalConvId;

          // Migrate messages from this agent's local placeholder to this
          // agent's conversationId. Do not merge the last globally-active
          // conversation blindly: with multiple machines, B's session_ready can
          // arrive while A's cache is still the global yeaftConversationId.
          if (localConvId && localConvId !== agentConvId) {
            const existingMsgs = this.messagesMap[localConvId] || [];
            const targetMsgs = this.messagesMap[agentConvId] || [];
            this.messagesMap[agentConvId] = msgHelpers
              .mergeMessagesByStableId(targetMsgs, existingMsgs)
              .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            if (localConvId.startsWith('yeaft-local-')) delete this.messagesMap[localConvId];
            // Migrate processing state
            if (this.processingConversations[localConvId]) {
              this.processingConversations[agentConvId] = true;
              delete this.processingConversations[localConvId];
            }
            // Migrate execution status
            if (this.executionStatusMap[localConvId]) {
              this.executionStatusMap[agentConvId] = this.executionStatusMap[localConvId];
              delete this.executionStatusMap[localConvId];
            }
          } else if (!this.messagesMap[agentConvId]) {
            this.messagesMap[agentConvId] = [];
          }

          this.yeaftConversationId = agentConvId;
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
            this.cacheYeaftAgentStatus(statusAgentId, event);
          }
          this.yeaftModel = event.model;
          this.yeaftModelEffort = event.modelEffort || null;
          this.yeaftSessionReady = true;
          this.yeaftBootstrapMetaLoadingKey = null;
          this.yeaftAvailableModels = event.availableModels || [];
          const readyTasks = Array.isArray(event.tasks) ? event.tasks : [];
          const nextTasks = {};
          for (const task of readyTasks) {
            if (!task?.id || !task.sessionId || task.status !== 'running') continue;
            nextTasks[task.sessionId] = { ...(nextTasks[task.sessionId] || {}), [task.id]: task };
          }
          this.yeaftActiveTasksBySession = nextTasks;
          // Surface agent's yeaft home dir so Yeaft workbench (Files/Git tabs)
          // can default to a sensible folder instead of leaking through
          // currentAgentInfo.workDir (which is Chat's cwd, not the group's).
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

          // Update activeConversations to point to the agent's conversationId
          if (this.currentView === 'yeaft') {
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
          this.sendWsMessage(subscribeAgentId
            ? { type: 'yeaft_vp_subscribe', agentId: subscribeAgentId }
            : { type: 'yeaft_vp_subscribe' });
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
          const tools = [...(prev.tools || []), {
            loopNumber: event.loopNumber || 0,
            callId: event.callId || null,
            name: event.name || '?',
            durationMs: event.durationMs || 0,
            isError: !!event.isError,
            toolOutput: event.toolOutput == null ? null : String(event.toolOutput),
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
          this.yeaftDebugLoops.push({
            turnId: event.turnId || null,
            loopNumber: event.loopNumber || 0,
            model: event.model,
            systemPrompt: event.systemPrompt,
            messages: event.messages,
            response: event.response,
            toolCalls: event.toolCalls,
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
            // task-344: raw API request / response payload (redacted server-side).
            rawRequest: event.rawRequest || null,
            rawResponse: event.rawResponse || null,
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
          const convId = msg.conversationId || this.yeaftConversationId || 'unknown';
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
          const bySession = { ...this.yeaftActiveTasksBySession };
          const current = { ...(bySession[task.sessionId] || {}) };
          if (task.status === 'running' || YEAFT_TERMINAL_TASK_STATUSES.has(task.status)) {
            current[task.id] = task;
          } else {
            delete current[task.id];
          }
          const retained = keepRecentSessionTasks(current);
          if (Object.keys(retained).length > 0) bySession[task.sessionId] = retained;
          else delete bySession[task.sessionId];
          this.yeaftActiveTasksBySession = bySession;
          if (task.status !== 'running') {
            const { [taskStopKey(task.sessionId, task.id)]: _done, ...rest } = this.yeaftStoppingTasksById || {};
            this.yeaftStoppingTasksById = rest;
          }
          break;
        }

        case 'yeaft_task_cancel_result': {
          const taskId = event.taskId || event.task?.id || null;
          const sessionId = event.task?.sessionId || event.sessionId || msg.sessionId || null;
          if (taskId && sessionId && event.success === false) {
            const { [taskStopKey(sessionId, taskId)]: _done, ...rest } = this.yeaftStoppingTasksById || {};
            this.yeaftStoppingTasksById = rest;
          }
          const task = event.task;
          if (task?.id && task.sessionId) {
            const bySession = { ...this.yeaftActiveTasksBySession };
            const current = { ...(bySession[task.sessionId] || {}) };
            current[task.id] = task;
            const retained = keepRecentSessionTasks(current);
            if (Object.keys(retained).length > 0) bySession[task.sessionId] = retained;
            else delete bySession[task.sessionId];
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
          const convId = msg.conversationId || this.yeaftConversationId || 'unknown';
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
          // History messages already rendered via assistant output frame data path.
          // This event just signals completion + carries cursors:
          //   mode:'recent' (default) — full pane replay; stamp oldestSeq /
          //     hasMore for the "Load older" hint AND latestSeq so the next
          //     re-entry can ask for a delta.
          //   mode:'delta' — incremental append; only latestSeq is meaningful.
          //     Don't touch hasMore / oldestSeq (those describe the older
          //     end and don't change on a delta tail-load).
          {
            const sessionKey = event.sessionId || '__all__';
            const mode = event.mode === 'delta' ? 'delta' : 'recent';
            const prevState = this.yeaftSessionHistoryState[sessionKey] || {};
            const nextLatest = (Number.isFinite(event.latestSeq) ? event.latestSeq
              : (Number.isFinite(prevState.latestSeq) ? prevState.latestSeq : null));
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
                  loaded: true,
                  loading: false,
                  hasMore: !!event.hasMore,
                  oldestSeq: (typeof event.oldestSeq === 'number') ? event.oldestSeq : null,
                  count: (typeof event.count === 'number') ? event.count : 0,
                  latestSeq: nextLatest,
                  syncingAfterSeq: null,
                };
            this.yeaftSessionHistoryState = {
              ...this.yeaftSessionHistoryState,
              [sessionKey]: nextState,
            };
            const activeKey = this.yeaftActiveSessionFilter || '__all__';
            if (sessionKey === activeKey) {
              if (mode === 'recent') {
                this.yeaftHasMoreHistory = nextState.hasMore;
                this.yeaftOldestLoadedSeq = nextState.oldestSeq;
              }
              this.yeaftLoadingMoreHistory = false;
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
          if (vp) vp.applySnapshot(event, msg.agentId || null);
          break;
        }
        case 'vp_updated': {
          // task-334h: live diff. `event.reason` (persona.edit / traits.edit /
          // manual.reload) is surfaced through the store for 334-ui-b badge
          // refresh cues. Missing reason is tolerated (back-compat).
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp && event.vp) vp.upsert(event.vp, event.reason);
          break;
        }
        case 'vp_removed': {
          // task-334h: live diff. Reason is always 'file.removed' on-wire.
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp && event.vpId) vp.remove(event.vpId, event.reason);
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
          const prevGroupId = gs ? (gs.activeSessionId || null) : null;
          const rows = event.sessions || [];
          // msg.agentId is stamped on yeaft_output envelopes by the
          // server relay (since v0.1.882). Pass it through so the
          // sessions store can keep per-agent rosters in the unified
          // sidebar. Older agents/servers omit the field — the store
          // falls back to the legacy whole-replacement path.
          if (gs) gs.applySnapshot(rows, msg.agentId || null);
          const newGroupId = gs ? (gs.activeSessionId || null) : null;
          // Bug 1: after enterYeaft the group snapshot may arrive *after*
          // initial history load (which happened with groupId:null), so
          // reload history for the correct group when activeGroupId changes.
          if (this.currentView === 'yeaft' && newGroupId) {
            const sessionState = this.yeaftSessionHistoryState[newGroupId] || null;
            this.setActiveSessionFilter(newGroupId, {
              force: msgHelpers.shouldForceHydrateActiveYeaftSession(newGroupId, prevGroupId, sessionState),
            });
          }
          break;
        }
        case 'group_roster_changed':
        case 'session_roster_changed': {
          const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
          if (gs) gs.applyRosterChange(event);
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
          const pending = this._sessionCrudPending && this._sessionCrudPending.get(event.requestId);
          if (pending) {
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
          this.activeVpTurns = {
            ...this.activeVpTurns,
            [event.turnId]: {
              vpId: event.vpId,
              sessionId: event.sessionId || null,
              threadId: event.threadId || null,
              isStreaming: true,
              startedAt: event.ts || Date.now(),
            },
          };
          if (event.sessionId) {
            this.yeaftProcessingSessions = {
              ...this.yeaftProcessingSessions,
              [event.sessionId]: true,
            };
          }
          break;
        }
        case 'vp_turn_end': {
          if (!event.turnId) break;
          const { [event.turnId]: _removed, ...rest } = this.activeVpTurns;
          this.activeVpTurns = rest;
          const { [event.turnId]: _stopped, ...stoppingRest } = this.stoppingVpTurnIds;
          this.stoppingVpTurnIds = stoppingRest;
          this.clearYeaftSessionProcessingIfIdle(event.sessionId || _removed?.sessionId || null);
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
          };
          const nextStatus = reasonToStatus[event.reason] || 'completed';
          const stampedAt = Date.now();
          const conv = this.yeaftConversationId;
          if (conv && Array.isArray(this.messagesMap[conv])) {
            const rows = this.messagesMap[conv];
            let mutated = false;
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
          }
          break;
        }
        case 'yeaft_turn_aborted': {
          const explicitTurnIds = Array.isArray(event.turnIds) ? event.turnIds.filter(Boolean) : [];
          if (event.turnId) explicitTurnIds.push(event.turnId);
          const targetSessionId = event.sessionId || null;
          const targetVpId = event.vpId || null;
          const removeIds = new Set(explicitTurnIds);
          if (targetVpId) {
            for (const [turnId, info] of Object.entries(this.activeVpTurns || {})) {
              if (!info || info.vpId !== targetVpId) continue;
              if (targetSessionId && info.sessionId !== targetSessionId) continue;
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
          this.clearYeaftSessionProcessingIfIdle(removedSessionId || null);
          break;
        }
        case 'yeaft_aborted': {
          const sessionId = event.sessionId || msg.sessionId || null;
          if (sessionId) {
            this.activeVpTurns = Object.fromEntries(
              Object.entries(this.activeVpTurns || {}).filter(([, info]) => info?.sessionId !== sessionId)
            );
            this.stoppingVpTurnIds = Object.fromEntries(
              Object.entries(this.stoppingVpTurnIds || {}).filter(([turnId]) => this.activeVpTurns?.[turnId])
            );
            this.clearYeaftSessionProcessingIfIdle(sessionId);
          } else if (event.all) {
            this.activeVpTurns = {};
            this.stoppingVpTurnIds = {};
            this.yeaftProcessingSessions = {};
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
          const convId = msg.conversationId || this.yeaftConversationId;
          if (!convId) break;
          this.yeaftVpTyping = incVpTyping(this.yeaftVpTyping, convId, event.vpId);
          break;
        }
        case 'vp_typing_end': {
          if (!event.vpId) break;
          const convId = msg.conversationId || this.yeaftConversationId;
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
        // Key format mirrors the broker's: `${groupId}::${vpId}`. Keying
        // by vpId alone would corrupt the table when the same VP sits
        // in two groups (last-write-wins between the two transitions).
        // See vp-status-broker.js `keyOf` for the canonical form.
        case 'vp_status_changed': {
          if (!event.vpId || !event.state) break;
          const sessionId = event.sessionId || null;
          const k = vpStatusKey(sessionId, event.vpId);
          const nextStatus = {
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
          this.restoreActiveYeaftSessionFromStatuses([nextStatus]);
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
            const next = {};
            for (const row of statuses) {
              if (!row || !row.vpId) continue;
              const rowSessionId = row.sessionId || row.groupId || null;
              const k = vpStatusKey(rowSessionId, row.vpId);
              next[k] = {
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
              if (v && v.sessionId === eventSessionId) delete merged[k];
            }
            for (const row of statuses) {
              if (!row || !row.vpId) continue;
              const rowSessionId = row.sessionId || row.groupId || null;
              const k = vpStatusKey(rowSessionId, row.vpId);
              merged[k] = {
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
          this.restoreActiveYeaftSessionFromStatuses(statuses);
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
        // when finished. Both flow into vpStore.dreamStatus[vpId] so the
        // VpDetailView status bar can update without polling.
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
    restoreActiveYeaftSessionFromStatuses(statuses = []) {
      if (this.yeaftActiveSessionFilter) return null;
      const rows = Array.isArray(statuses) ? statuses : [];
      const running = rows
        .filter(row => row && (row.sessionId || row.groupId) && !['idle', 'offline', 'completed', 'failed', 'aborted'].includes(row.state))
        .sort((a, b) => (b.updatedAt || b.since || 0) - (a.updatedAt || a.since || 0));
      const sessionId = running[0]?.sessionId || running[0]?.groupId || null;
      if (!sessionId) return null;
      this.setActiveSessionFilter(sessionId, { force: true });
      try {
        const gs = window.Pinia?.useSessionsStore?.() || (window.__useSessionsStore && window.__useSessionsStore());
        if (gs && typeof gs.setActive === 'function') gs.setActive(sessionId);
      } catch (_) {}
      return sessionId;
    },

    setActiveSessionFilter(groupId, opts = {}) {
      const prev = this.yeaftActiveSessionFilter || null;
      const next = groupId || null;
      const force = !!opts.force;
      this.yeaftActiveSessionFilter = next;
      // fix-yeaft-session-server-persistence: remember the
      // last-viewed yeaft session so reload + cross-agent switch
      // restore it instead of arbitrarily landing on sessionOrder[0]
      // (which manufactures the "phantom default group" bug the user
      // reported). localStorage-only — mirrors how chat does
      // `lastViewedConversation`.
      try {
        if (next) localStorage.setItem('lastViewedYeaftSession', next);
        else localStorage.removeItem('lastViewedYeaftSession');
      } catch (_) {}
      if (!force && next === prev) return;

      const sessionKey = next || '__all__';
      const savedState = this.yeaftSessionHistoryState[sessionKey] || null;
      this.yeaftHasMoreHistory = !!savedState?.hasMore;
      this.yeaftLoadingMoreHistory = !!savedState?.loading;
      this.yeaftOldestLoadedSeq = (typeof savedState?.oldestSeq === 'number') ? savedState.oldestSeq : null;
      this.pruneYeaftMessageWindow(next);

      // If a restore/snapshot path forces the current session while an initial
      // history request is already in flight, keep the UI flags in sync but do
      // not enqueue a duplicate `yeaft_load_history` for the same session.
      if (savedState?.loading) return;

      // Always ask the agent — same rationale as enterYeaft. If we have a
      // cursor for this session, request only what's new since; otherwise
      // request the initial recent-N window.
      //
      // fix-yeaft-session-per-agent: the session may belong to an agent
      // other than the current one (cross-agent click from the unified
      // sidebar or from the resume list in SessionCreateModal). Resolve the
      // session's owning agent (sessions store first, then the per-session
      // cache, then currentAgent). Without this, `yeaft_load_history` gets
      // routed to the wrong agent — which has no such session on disk — and
      // the main pane stays empty while the previously-loaded snapshot for
      // that other agent silently goes stale.
      //
      // The cross-agent callers (YeaftSidebar.onSelectGroup,
      // SessionCreateModal resume) already `selectAgent(owner)` before calling
      // here. But other callers reach this seam WITHOUT a preceding
      // selectAgent (restoreActiveYeaftSessionFromStatuses, the
      // group_list_updated snapshot handler, YeaftPage.onSelectGroupV2). Since
      // agent-level ops (global cancelYeaft, MCP / search settings, reset) now
      // route by `currentAgent`, a stale currentAgent would silently target
      // the wrong agent after a cross-agent session switch. Make the seam
      // self-healing: when the resolved owner differs, sync currentAgent the
      // same synchronous way enterYeaft does (selectAgent kicks off the
      // round-trip while currentAgent is still old so its same-agent guard
      // doesn't swallow the frame; the assignment then makes same-tick reads
      // see the new owner).
      const targetAgentId = next ? resolveAgentIdForSession(this, next) : this.currentAgent;
      if (targetAgentId && next && this.currentAgent !== targetAgentId) {
        this.selectAgent(targetAgentId);
        this.currentAgent = targetAgentId;
        const info = this.agents.find(a => a.id === targetAgentId);
        if (info) this.currentAgentInfo = info;
      }
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

        const latestSeq = Number.isFinite(savedState?.latestSeq) ? savedState.latestSeq : null;
        const payload = {
          type: 'yeaft_load_history',
          agentId: targetAgentId,
          sessionId: next,
        };
        const hasLoadedWindow = !!savedState?.loaded;
        if (latestSeq !== null) {
          payload.afterSeq = latestSeq;
        } else {
          payload.limit = YEAFT_RECENT_TURNS;
        }
        if (hasLoadedWindow && latestSeq === null) {
          this.yeaftSessionHistoryState = {
            ...this.yeaftSessionHistoryState,
            [sessionKey]: {
              ...(savedState || { hasMore: false, oldestSeq: null, count: 0 }),
              loaded: true,
              loading: false,
              syncingAfterSeq: null,
            },
          };
          this.yeaftLoadingMoreHistory = false;
          return;
        }
        if (hasLoadedWindow) {
          if (savedState?.syncingAfterSeq === latestSeq) return;
          this.yeaftSessionHistoryState = {
            ...this.yeaftSessionHistoryState,
            [sessionKey]: {
              ...(savedState || { hasMore: false, oldestSeq: null, count: 0 }),
              loaded: true,
              loading: false,
              syncingAfterSeq: latestSeq,
              latestSeq,
            },
          };
          this.yeaftLoadingMoreHistory = false;
        } else {
          this.yeaftSessionHistoryState = {
            ...this.yeaftSessionHistoryState,
            [sessionKey]: {
              ...(savedState || { hasMore: false, oldestSeq: null, count: 0 }),
              loaded: false,
              loading: true,
              syncingAfterSeq: null,
              latestSeq,
            },
          };
          this.yeaftLoadingMoreHistory = true;
        }
        this.sendWsMessage(payload);
      }
    },
    // ★ task-334-ui-c: VP detail view entry / exit.
    enterVpDetailView(vpId) {
      if (!vpId) return;
      this.yeaftActiveVpDetailId = String(vpId);
    },
    leaveVpDetailView() {
      this.yeaftActiveVpDetailId = null;
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
          limit: DEFAULT_YEAFT_DEBUG_HISTORY_LIMIT,
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
        delete this.messagesMap[oldConvId];
        delete this.processingConversations[oldConvId];
        delete this.executionStatusMap[oldConvId];
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
      // feat-6af5f9f1 PR C: clear toolbar transient state too. The group
      // filter is intentionally cleared on session reset so a stale pin
      // from a previous session doesn't hide all incoming turns.
      this.yeaftDebugSearch = '';
      this.yeaftDebugSessionFilter = null;
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

    // =====================
    // Crew panel toggle
    // =====================
    toggleCrewMobilePanel(panel, paneId = null) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) { pane.crewMobilePanel = pane.crewMobilePanel === panel ? null : panel; return; }
      }
      this.crewMobilePanel = this.crewMobilePanel === panel ? null : panel;
    },
    toggleCrewPanel(panel, paneId = null) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) { pane.crewPanelVisible[panel] = !pane.crewPanelVisible[panel]; return; }
      }
      this.crewPanelVisible[panel] = !this.crewPanelVisible[panel];
    },
    togglePaneRightPanel(panelType, paneId = null) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) { pane.activeRightPanel = pane.activeRightPanel === panelType ? null : panelType; return; }
      }
      this.activeRightPanel = this.activeRightPanel === panelType ? null : panelType;
    },
    getPanelVisible(paneId) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) return pane.crewPanelVisible;
      }
      return this.crewPanelVisible;
    },
    getPaneMobilePanel(paneId) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) return pane.crewMobilePanel;
      }
      return this.crewMobilePanel;
    },
    getPaneRightPanel(paneId) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) return pane.activeRightPanel;
      }
      return this.activeRightPanel;
    },
    setPaneMobilePanel(paneId, value) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) { pane.crewMobilePanel = value; return; }
      }
      this.crewMobilePanel = value;
    },
    setPaneRightPanel(paneId, value) {
      if (paneId && this.isSplitMode) {
        const pane = this.panels.find(p => p.id === paneId);
        if (pane) { pane.activeRightPanel = value; return; }
      }
      this.activeRightPanel = value;
    },

    // =====================
    // Per-conversation crew state (split-pane safe)
    // =====================
    getCrewInProgressCount(convId) {
      if (convId) return this.crewInProgressCountMap[convId] || 0;
      return this.crewInProgressCount;
    },
    setCrewInProgressCount(convId, value) {
      if (convId) { this.crewInProgressCountMap[convId] = value; }
      this.crewInProgressCount = value;
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
    handleAssistantOutputFrame(conversationId, data) { assistantOutputHelpers.handleAssistantOutputFrame(this, conversationId, data); },
    handleClaudeOutput(conversationId, data) { this.handleAssistantOutputFrame(conversationId, data); },

    // =====================
    // Message CRUD
    // =====================
    addMessageToConversation(conversationId, msg) { msgHelpers.addMessageToConversation(this, conversationId, msg); },
    appendToAssistantMessageForConversation(conversationId, text, opts) { msgHelpers.appendToAssistantMessageForConversation(this, conversationId, text, opts); },
    finishStreamingForConversation(conversationId) { msgHelpers.finishStreamingForConversation(this, conversationId); },
    sweepStaleStreamingForConversation(conversationId) { msgHelpers.sweepStaleStreamingForConversation(this, conversationId); },
    appendToAssistantMessage(text) { this.appendToAssistantMessageForConversation(this.currentConversation, text); },
    finishStreaming() { this.finishStreamingForConversation(this.currentConversation); },
    addMessage(msg) { this.addMessageToConversation(this.currentConversation, msg); },
    loadHistoryMessages(historyMessages) { msgHelpers.loadHistoryMessages(this, historyMessages); },
    formatDbMessage(dbMsg) { return msgHelpers.formatDbMessage(dbMsg); },
    formatDbMessageForHistoryHydration(dbMsg) { return msgHelpers.formatDbMessageForHistoryHydration(dbMsg); },

    // =====================
    // Conversation lifecycle
    // =====================
    selectAgent(agentId) { convHelpers.selectAgent(this, agentId); },
    createConversation(workDir, agentId = null, disallowedTools = null, options = undefined) { convHelpers.createConversation(this, workDir, agentId, disallowedTools, options); },
    resumeConversation(claudeSessionId, workDir, agentId = null, disallowedTools = null) { convHelpers.resumeConversation(this, claudeSessionId, workDir, agentId, disallowedTools); },
    selectConversation(conversationId, agentId) { convHelpers.selectConversation(this, conversationId, agentId); },
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
        crewPanelVisible: { roles: false, features: true },
        activeRightPanel: null,
        crewMobilePanel: null
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
                  // Load messages for crew/chat conversations that aren't cached
                  if (panel.conversationId && !this.messagesMap[panel.conversationId]) {
                    this.messagesMap[panel.conversationId] = [];
                    const conv = this.conversations.find(c => c.id === panel.conversationId);
                    if (conv?.type === 'crew') {
                      if (!this.crewMessagesMap[panel.conversationId]) {
                        this.crewMessagesMap[panel.conversationId] = [];
                      }
                    } else {
                      this.sendWsMessage({ type: 'sync_messages', conversationId: panel.conversationId, turns: 5 });
                    }
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
    setPanelConversation(panelId, conversationId) {
      const panel = this.panels.find(p => p.id === panelId);
      if (!panel) return;
      panel.conversationId = conversationId;
      // Ensure conversation is in activeConversations
      if (conversationId && !this.activeConversations.includes(conversationId)) {
        this.activeConversations.push(conversationId);
      }
      // Ensure messagesMap entry exists
      if (conversationId && !this.messagesMap[conversationId]) {
        this.messagesMap[conversationId] = [];
        this.sendWsMessage({ type: 'sync_messages', conversationId, turns: 5 });
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
        crewPanelVisible: { roles: false, features: true },
        activeRightPanel: null,
        crewMobilePanel: null
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
        const conv = this.conversations.find(c => c.id === conversationId);
        if (conv?.type === 'crew') {
          if (!this.crewMessagesMap[conversationId]) {
            this.crewMessagesMap[conversationId] = [];
          }
        } else {
          this.sendWsMessage({ type: 'sync_messages', conversationId, turns: 5 });
        }
      }
      this.saveOpenSessions();
    },
    // ★ Check if a conversation is in any panel
    isInAnyPanel(conversationId) {
      return this.panels.some(p => p.conversationId === conversationId);
    },
    // ★ Session Pin
    setSessionPinned(sessionId, pinned) {
      if (!sessionId) return;
      const isPinned = this.pinnedSessions.includes(sessionId);
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
        if (gs && typeof gs.applyPinState === 'function') gs.applyPinState(sessionId, !!pinned);
      } catch (_) { /* no sessions store in some tests */ }
    },
    togglePin(sessionId, meta = {}) {
      const isPinned = this.pinnedSessions.includes(sessionId);
      const nextPinned = !isPinned;
      // Optimistic local update; the server `session_pinned` ack reapplies
      // the authoritative state and updates Yeaft session row metadata.
      this.setSessionPinned(sessionId, nextPinned);
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
    clearYeaftSessionProcessingIfIdle(sessionId) {
      if (!sessionId) return;
      const hasActiveTurn = Object.values(this.activeVpTurns || {}).some((info) => info?.sessionId === sessionId);
      if (hasActiveTurn) return;
      const { [sessionId]: _removed, ...rest } = this.yeaftProcessingSessions || {};
      this.yeaftProcessingSessions = rest;
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
      // Legacy/global stop path: clear every local Yeaft running flag.
      if (this.yeaftConversationId) {
        delete this.processingConversations[this.yeaftConversationId];
      }
      this.activeVpTurns = {};
      this.stoppingVpTurnIds = {};
      this.yeaftProcessingSessions = {};
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
        Object.entries(this.activeVpTurns || {}).filter(([, info]) => info?.sessionId !== sessionId)
      );
      this.stoppingVpTurnIds = Object.fromEntries(
        Object.entries(this.stoppingVpTurnIds || {}).filter(([turnId]) => this.activeVpTurns?.[turnId])
      );
      this.clearYeaftSessionProcessingIfIdle(sessionId);
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
      this.stoppingVpTurnIds = {
        ...this.stoppingVpTurnIds,
        [turnId]: Date.now(),
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
      for (const [turnId, info] of Object.entries(map)) {
        if (!info || info.vpId !== vpId) continue;
        if (targetSessionId && info.sessionId && info.sessionId !== targetSessionId) continue;
        const ts = (typeof info.startedAt === 'number') ? info.startedAt : 0;
        if (ts >= bestStartedAt) {
          bestStartedAt = ts;
          bestTurnId = turnId;
        }
      }
      if (!bestTurnId) {
        const status = this.vpStatuses?.[vpStatusKey(targetSessionId, vpId)] || null;
        if (status?.turnId && !['idle', 'offline'].includes(status.state)) {
          bestTurnId = status.turnId;
        }
      }
      if (bestTurnId) {
        this.cancelVpTurn(bestTurnId, { sessionId: targetSessionId, vpId });
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
      this.sendWsMessage({
        type: 'sync_messages',
        conversationId: targetConvId,
        turns: 5,
        ...(firstMsgWithId ? { beforeId: firstMsgWithId.dbMessageId } : {})
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
      const sessionKey = sessionId || '__all__';
      const convId = this.yeaftConversationId;

      // Manual reload means "show me the persisted pane again", not a delta.
      // Drop only the active Yeaft session rows from the shared conversation
      // map; other sessions stay cached so switching remains instant.
      if (convId && Array.isArray(this.messagesMap[convId])) {
        if (sessionId) {
          this.messagesMap[convId] = this.messagesMap[convId].filter(m => (m?.sessionId ?? m?.groupId) !== sessionId);
        } else {
          this.messagesMap[convId] = [];
        }
      }

      const { [sessionKey]: _oldState, ...rest } = this.yeaftSessionHistoryState || {};
      this.yeaftSessionHistoryState = {
        ...rest,
        [sessionKey]: { loaded: false, loading: true, hasMore: false, oldestSeq: null, latestSeq: null, count: 0 },
      };
      this.yeaftHasMoreHistory = false;
      this.yeaftOldestLoadedSeq = null;
      this.yeaftLoadingMoreHistory = true;

      this.sendWsMessage({
        type: 'yeaft_load_history',
        agentId: targetAgentId,
        limit: YEAFT_RECENT_TURNS,
        sessionId,
      });
      return true;
    },

    loadMoreYeaftHistory() {
      if (this.currentView !== 'yeaft') return;
      if (this.yeaftLoadingMoreHistory || !this.yeaftHasMoreHistory) return;
      if (this.yeaftOldestLoadedSeq == null) return;

      const sessionId = resolveActiveYeaftSessionId(this);
      const targetAgentId = resolveAgentIdForSession(this, sessionId);
      if (!targetAgentId) return;

      this.yeaftLoadingMoreHistory = true;
      const sessionKey = sessionId || '__all__';
      this.yeaftSessionHistoryState = {
        ...this.yeaftSessionHistoryState,
        [sessionKey]: {
          ...(this.yeaftSessionHistoryState[sessionKey] || {}),
          loading: true,
        },
      };
      this.sendWsMessage({
        type: 'yeaft_load_more_history',
        agentId: targetAgentId,
        sessionId,
        beforeSeq: this.yeaftOldestLoadedSeq,
        turns: 10,
      });
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

    setCrewModeEnabled(enabled) {
      this.crewModeEnabled = !!enabled;
      localStorage.setItem('crewModeEnabled', this.crewModeEnabled ? 'true' : 'false');
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

    toggleWorkbench() {
      this.workbenchExpanded = !this.workbenchExpanded;
      if (!this.workbenchExpanded) {
        this.workbenchMaximized = false;
      }
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },

    toggleWorkbenchMaximized() {
      this.workbenchMaximized = !this.workbenchMaximized;
    },

    // =====================
    // Crew (multi-agent) actions
    // =====================
    enterCrewMode() { crewHelpers.enterCrewMode(this); },
    listCrewSessions() { crewHelpers.listCrewSessions(this); },
    checkCrewExists(projectDir, agentId) { crewHelpers.checkCrewExists(this, projectDir, agentId); },
    deleteCrewDir(projectDir, agentId) { crewHelpers.deleteCrewDir(this, projectDir, agentId); },
    openCrewConfig() { crewHelpers.openCrewConfig(this); },
    createCrewSession(config) { crewHelpers.createCrewSession(this, config); },
    resumeCrewSession(sessionId, agentId) { crewHelpers.resumeCrewSession(this, sessionId, agentId); },
    loadCrewHistory(sessionId) { return crewHelpers.loadCrewHistory(this, sessionId); },
    sendCrewMessage(content, targetRole = null, attachments = undefined, conversationId = undefined) { crewHelpers.sendCrewMessage(this, content, targetRole, attachments, conversationId); },
    sendCrewControl(action, targetRole = null, conversationId = undefined) { crewHelpers.sendCrewControl(this, action, targetRole, conversationId); },
    addCrewRole(role, conversationId = undefined) { crewHelpers.addCrewRole(this, role, conversationId); },
    removeCrewRole(roleName, conversationId = undefined) { crewHelpers.removeCrewRole(this, roleName, conversationId); },
    renameCrewSession(sessionId, name) { crewHelpers.renameCrewSession(this, sessionId, name); },
    renameChatSession(convId, title) {
      if (title && title.trim()) {
        this.customConversationTitles[convId] = title.trim();
        this.sendWsMessage({
          type: 'update_conversation_settings',
          conversationId: convId,
          title: title.trim()
        });
      } else {
        delete this.customConversationTitles[convId];
        this.sendWsMessage({
          type: 'update_conversation_settings',
          conversationId: convId,
          title: ''
        });
      }
    },
    handleCrewOutput(msg) { crewHelpers.handleCrewOutput(this, msg); },
    startRefreshTimeout(convId) { crewHelpers.startRefreshTimeout(this, convId); },

    openFileInExplorer(filePath) {
      if (!this.currentConversation) return;
      this.workbenchExpanded = true;
      window.dispatchEvent(new CustomEvent('open-file-in-explorer', {
        detail: { filePath, conversationId: this.currentConversation }
      }));
    },

    logout() {
      const authStore = useAuthStore();
      authStore.logout();
      this.authenticated = false;
      this.sessionKey = null;
      this.agents = [];
      this.currentAgent = null;
      this.currentAgentInfo = null;
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
      if (this.ws) {
        this.ws.close();
      }
    }
  }
});
