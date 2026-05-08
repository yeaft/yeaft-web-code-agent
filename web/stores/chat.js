import { useAuthStore } from './auth.js';
import { setLocale, getLocale } from '../utils/i18n.js';

// Helper modules
import * as wsHelpers from './helpers/websocket.js';
import * as msgHelpers from './helpers/messages.js';
import * as claudeHelpers from './helpers/claudeOutput.js';
import * as handlerHelpers from './helpers/messageHandler.js';
import * as convHelpers from './helpers/conversation.js';
import * as sessionHelpers from './helpers/session.js';
import * as watchdogHelpers from './helpers/watchdog.js';
import * as crewHelpers from './helpers/crew.js';
import * as unifyViewHelpers from './helpers/unify-view.js';
import { incVpTyping, decVpTyping } from './helpers/vp-typing.js';
import { selectActiveConversationId } from './helpers/active-conv.js';
import { turnMatchesSearch } from './helpers/debug-search.js';
import { trimDebugRetention } from './helpers/debug-retention.js';

const { defineStore } = Pinia;

// Stable empty array for getters — avoids creating new [] on every call,
// which prevents Vue computed from treating each call as a new value.
const EMPTY_ARRAY = Object.freeze([]);

// feat-6af5f9f1 PR C: turnMatchesSearch lives in helpers/debug-search.js
// so it can be unit-tested without the Pinia browser globals.

// fix-debug-copy-no-truncate: bound debug retention by COUNT, not by
// per-payload truncation. The adapter / engine pass through verbatim
// what was sent to the LLM (so "copy request" matches reality); we cap
// growth here by dropping the oldest loop entries — and the orphaned
// turn records that no surviving loop references — once we exceed
// MAX_UNIFY_DEBUG_LOOPS. This replaces the old per-payload mutilation
// path that lied about what the model actually saw.
//
// Why 50, not 200 / 1000:
//   • per-loop worst case ≈ 1 MiB raw SSE body (large tool output)
//   • 50 loops ≈ 50 MiB per tab — survivable, won't surprise the GC
//   • covers ~10 user turns at ~5 loops each, which is ~95% of debug
//     workflows (you almost never scroll back further than that)
// Memory cost is roughly linear in this number — bump cautiously.
// NOTE: this is a count-based bound, not a byte-based one. A pathological
// single loop (e.g. a 100 MiB tool dump kept verbatim) is *not* protected
// by this cap; the design accepts that trade-off because the alternative
// (silently truncating payloads) is what this PR is removing.
const MAX_UNIFY_DEBUG_LOOPS = 50;

export const useChatStore = defineStore('chat', {
  state: () => ({
    ws: null,
    authenticated: false,
    sessionKey: null, // Uint8Array for encryption
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
    // ★ Split-screen: panel state (unified single/multi-panel)
    panels: [],  // [{ id: 'panel-0', conversationId: convId }, ...] — empty = single-screen mode
    activePanelId: null,  // Currently focused panel ID (for multi-panel click routing)
    _pendingPaneId: null,  // Tracks which panel requested a new session (split mode only)
    // 会话标题缓存：conversationId -> title (最新用户消息，使用对象而非 Map 以确保响应式)
    conversationTitles: {},
    customConversationTitles: {},
    // Per-conversation 处理状态：conversationId -> true (使用对象而非 Set 以确保响应式)
    processingConversations: {},
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

    // task-318: per-agent Unify runtime settings cache. Keyed by agentId.
    // Shape: { maxConcurrentThreads, autoArchiveIdleDays, error, loaded, at }
    unifySettings: {},

    // Search settings cache (web-search backend + Tavily key state).
    // Single record (not per-agent) — config.json is one file per agent's
    // ~/.yeaft, so the active unifyAgentId determines which agent we
    // talked to last. Shape:
    //   { backend, tavilyKeyConfigured, tavilyKeyMasked, disableHtmlFallback,
    //     loaded, error, at }
    searchSettings: null,
    // Last live Tavily /usage probe.
    //   { plan, used, limit, paygoUsed, paygoLimit } | { error }
    tavilyUsage: null,
    tavilyUsageLoading: false,

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
    // Unify 独立页面状态
    // =====================
    currentView: 'chat',           // 'chat' | 'unify' — 顶级页面切换
    unifyConversationId: null,     // 虚拟 conversationId（从 agent session_ready 获取）
    unifyModel: null,              // 当前 Unify 模型名
    unifyAgentId: null,            // 绑定的 agent ID
    unifySessionReady: false,     // Session 是否已初始化
    unifyStatus: null,            // { skills, mcpServers, tools } 从 session_ready 获取
    unifyAvailableModels: [],     // 可用模型列表 [{ id, provider, label }]
    // feat-6af5f9f1 PR B: debug panel data refactor.
    //
    //   Turn = one user prompt + all AI responses (top level)
    //   Loop = one LLM call inside a Turn
    //   Tool = one tool execution inside a Loop
    //
    // `unifyDebugLoops` is a flat list (per-LLM-call). `unifyDebugTurnsById`
    // is a {turnId -> turn record} map carrying turn-level data (user
    // prompt, vp, group, memory_used, memory_adjust, totals).
    // `unifyDebugTurnOrder` preserves insertion order so the panel can
    // render newest-first.
    unifyDebugLoops: [],
    unifyDebugTurnsById: {},
    unifyDebugTurnOrder: [],
    // feat-6af5f9f1 PR C: debug-panel toolbar state.
    //   - `unifyDebugSearch` is a substring filter applied to user prompt,
    //     vpId, tool name, tool input/output, system prompt, raw url.
    //   - `unifyDebugGroupFilter` is INDEPENDENT of the main pane's group
    //     filter (per user spec): debug can show all groups while the
    //     main pane is scoped to one. Default null = "All".
    unifyDebugSearch: '',
    unifyDebugGroupFilter: null,
    // PR-L: V7 tool-history reflection cards. Keyed by `${conversationId}:${trigger}:${loopRange[0]}-${loopRange[1]}`.
    // Each entry: { trigger, status, loopRange, toolCount, content, durationMs, error,
    // anchorMsgId, anchorOrder }. Rendered inline by MessageList — anchored
    // after the message present at first emit (`pending`).
    unifyReflectionCards: {},
    // PR-M3: sub-agent cards. Keyed by `${conversationId}:${agentId}`.
    // Each entry: { agentId, agentName, status, text, toolCalls[], turns,
    // error, anchorMsgId, anchorOrder, expanded, updatedAt }.
    // Populated by `sub_agent_event` handler — fed by Engine
    // sub-agent event sink → web-bridge.js → unify_output.
    unifySubAgentCards: {},
    // task-344: global toggle for detail (full raw API payload) vs concise
    // debug view. Default concise. Persisted via localStorage.
    unifyDebugDetailMode: (() => {
      try { return localStorage.getItem('unifyDebugDetailMode') === '1'; }
      catch { return false; }
    })(),

    // ★ task-341: Sidebar V2 is now the only sidebar. Flag kept as a
    // constant `true` for backward-compat with any lingering reads.
    // Legacy <aside class="unify-sidebar"> deleted in UnifyPage.
    unifySidebarV2Enabled: true,

    // ★ task-fix (group-switch): active group filter for the Unify stream.
    // When a user clicks a group row in the sidebar, the main pane narrows
    // to messages tagged with that groupId (both inbound agent messages
    // and outbound user messages sent via the group-chat action). null =
    // no group filter. Mutually exclusive with unifyActiveThreadFilter —
    // setting one clears the other so the view has a single predicate.
    unifyActiveGroupFilter: null,

    // (PR #693 review I4 + Fowler M2: removed `pendingGroupSettingsRequest`
    // store-as-event-bus field — replaced by a normal emit chain since
    // MessageList is mounted directly inside UnifyPage.)

    // Bug 1: in-flight SEND-context group, set transiently by
    // handleUnifyOutput before dispatching streaming chunks. Read by
    // addMessageToConversation so arriving messages get stamped with the
    // ORIGINATING group (carried in the unify_output envelope) rather than
    // the user's CURRENT filter (which can change while a reply streams).
    _currentUnifyGroupId: null,

    // Per-VP turn routing: set transiently by handleUnifyOutput so that
    // addMessageToConversation / appendToAssistant can route by turnId.
    _currentUnifyVpId: null,
    _currentUnifyTurnId: null,
    // PR-1 (feature-pill double-track): the in-flight envelope's featureId.
    // Stamped onto streaming chunks the same way _currentUnifyVpId/turnId
    // are, so the rendering layer can group messages by feature without
    // every component reaching back into a parallel map. Null when the
    // arriving event is not part of any feature (lightweight Q&A).
    _currentUnifyFeatureId: null,

    // PR-1 (feature-pill double-track): per-feature lifecycle metadata.
    // Keyed by featureId. Records:
    //   { featureId, vpId, groupId, turnId, title, trigger,
    //     status: 'active' | 'completed' | 'aborted' | 'error',
    //     summary?: string, startedAt, endedAt? }
    // Used by the (PR-2) MessageList to fold all messages tagged with a
    // given featureId into a single pill. PR-1 only stores the data —
    // the UI surface is added in the next PR.
    unifyFeatureMeta: {},

    // PR-1 (feature-pill double-track): per-VP active feature index.
    // Keyed by vpId, value is the most recent active featureId for that
    // VP (or null when no feature is open). Lets the timeline / detail
    // panel show "VP-A is doing X" badges without scanning the meta map.
    unifyActiveFeatureByVp: {},

    // PR-1 (feature-pill double-track): pending Track-A previews keyed
    // by `${vpId}:${turnId}`. Each entry is `{ vpId, turnId, intent,
    // preview, ts }`. Rendered as an instant bubble under the user
    // message in the (PR-2) UI; cleared when the matching feature
    // completes (or after a TTL — handled in PR-2).
    unifyQuickPreviews: {},

    // Active VP turns — keyed by turnId. Cleared on result or abort ack.
    activeVpTurns: {},

    // H2.f.6: thread state retired. unifyThreads / unifyActiveThreadId /
    // unifyFeatureReplyThreadId / unifyJumpTarget / merge+fork results all
    // removed. Single conversation owns the message stream.

    // task-fix: per-VP typing indicator for Unify group chat.
    //   Shape: { [conversationId]: { [vpId]: refCount } }
    //   Nesting by conversationId is what isolates Unify typing state from
    //   the Chat view — so a VP that's still streaming when the user
    //   switches to a Chat tab does NOT bleed its avatar / typing dots
    //   into the Chat view (cross-mode state leak).
    // Populated by `vp_typing_start` / `vp_typing_end` events emitted from
    // the agent's handleUnifyGroupChat fan-out loop. Consumed by
    // VpSpeakerHeader to render a three-dot animation next to the VP's
    // avatar — replaces the old global "running cat" which was ambiguous
    // when N VPs were speaking concurrently.
    // The refCount (not a boolean) is so overlapping sends to the same VP
    // degrade gracefully — the dot stays on until the last concurrent
    // dispatch ends.
    unifyVpTyping: {},

    // ★ task-334-ui-g: VP CRUD pending-request map.
    // Each `vpCrudRequest()` stashes its resolver here keyed by requestId;
    // the `vp_crud_result` event looks it up and resolves the caller. Using
    // a Map (not a plain object) because request IDs are ephemeral and we
    // want O(1) delete on resolve. Guarded with lazy-init in the action so
    // hydration from SSR / rehydration doesn't trip on a non-Map value.
    _vpCrudPending: null,

    // ★ task-334-ui-c: VP detail view. When non-null, UnifyPage switches
    // the center pane to the VpDetailView component (mirrors the
    // task-315 pattern). Esc / breadcrumb back clears. Stays null in
    // legacy 1:1 mode — only entered by clicking a VpAvatar/VpBadge in
    // a VP-speaker-headed turn or a VP library row.
    unifyActiveVpDetailId: null,

    // Right-side detail drawer target — populated when the user clicks a
    // VpQuickCard in the main feed; cleared on close. Coexists with
    // `unifyActiveVpDetailId` (the older center-column persona view) —
    // the two are different dimensions (turn-scoped vs vp-scoped).
    unifyOpenVpTurnDetail: null,  // { vpId, turnId } | null

    // R6 G4: transient toast/hint queue for off-roster @-mention attempts.
    // ChatInput.flashInviteHint(vpId) pushes here; a toast component pops
    // them after a few seconds. Per D4 the user — not the LLM — is the one
    // who must invite the cross-group VP, so the hint nudges them rather
    // than auto-inviting.
    unifyMentionInviteHints: [],
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
      // task-fix (group-switch): group filter narrows the stream to one group.
      // Every Unify message is stamped with a groupId at creation time
      // (addMessageToConversation defaults to grp_default), so strict
      // equality is safe — no message can slip through "untagged".
      if (state.currentView === 'unify' && state.unifyActiveGroupFilter) {
        const target = state.unifyActiveGroupFilter;
        return raw.filter(m => m && m.groupId === target);
      }
      return raw;
    },
    // ★ Unify: the raw message list for the active Unify conversation (no thread filter applied).
    unifyAllMessages: (state) => {
      const convId = state.unifyConversationId;
      return convId ? (state.messagesMap[convId] || EMPTY_ARRAY) : EMPTY_ARRAY;
    },
    // task-fix: per-VP typing-indicator getters scoped to the CURRENT
    // conversation. Components read these instead of the underlying
    // `unifyVpTyping` shape so the nested data layout stays an internal
    // detail of the store. The cross-mode isolation invariant is then
    // a property of the getter contract, not something each consumer has
    // to remember to enforce.
    //
    // Routes through `activeConversationId` so chat-mode handlers that
    // clobber `activeConversations` while the user is in Unify cannot
    // make typing badges silently disappear.
    vpsTypingInCurrentConv(state) {
      const convId = this.activeConversationId;
      if (!convId) return EMPTY_ARRAY;
      const inner = (state.unifyVpTyping || {})[convId];
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
        const inner = (state.unifyVpTyping || {})[convId];
        if (!inner) return false;
        return (inner[vpId] || 0) > 0;
      };
    },
    // feat-6af5f9f1 PR B: Turn-grouped debug records for the redesigned
    // panel. Returns `[{ turnId, userPrompt, vpId, groupId, openedAt,
    //                    loops: Loop[], reflections: Card[], memoryLoaded,
    //                    memoryAdjust, totalMs, totalTokens, loopCount }, ...]`
    // sorted newest-first.
    //
    // PR C: filter precedence is now:
    //   1. `unifyDebugGroupFilter` (independent debug-side filter; user's spec)
    //   2. fall back to `unifyActiveGroupFilter` (main pane filter) ONLY if
    //      the debug filter is null AND the user has selected a main group.
    //   3. otherwise show all turns.
    //
    // The independent filter wins: setting it to a value (even one that
    // doesn't match the main pane) shows just that group. Setting it to
    // the empty-string sentinel `'__all__'` forces "show all" even when
    // the main pane is filtered.
    unifyDebugTurnsForActiveGroup: (state) => {
      const order = state.unifyDebugTurnOrder || EMPTY_ARRAY;
      const byId = state.unifyDebugTurnsById || {};
      const allLoops = state.unifyDebugLoops || EMPTY_ARRAY;
      const reflections = state.unifyReflectionCards || {};

      const debugFilter = state.unifyDebugGroupFilter;
      const mainFilter = state.unifyActiveGroupFilter || null;
      let target;
      if (debugFilter === '__all__') {
        target = null;
      } else if (debugFilter) {
        target = debugFilter;
      } else {
        target = mainFilter;
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

      const search = (state.unifyDebugSearch || '').trim().toLowerCase();

      const out = [];
      for (let i = order.length - 1; i >= 0; i--) {
        const turnId = order[i];
        const turn = byId[turnId];
        if (!turn) continue;
        if (target && turn.groupId && turn.groupId !== target) continue;

        const loops = loopsByTurn[turnId] || EMPTY_ARRAY;
        const refls = reflectionsByTurn[turnId] || EMPTY_ARRAY;

        if (search) {
          if (!turnMatchesSearch(turn, loops, refls, search)) continue;
        }

        out.push({ ...turn, loops, reflections: refls });
      }
      return out;
    },
    // PR C: distinct groupIds present in the current debug history,
    // for the toolbar group-filter dropdown.
    unifyDebugAvailableGroups: (state) => {
      const seen = new Set();
      for (const turnId of state.unifyDebugTurnOrder || EMPTY_ARRAY) {
        const turn = state.unifyDebugTurnsById[turnId];
        if (turn && turn.groupId) seen.add(turn.groupId);
      }
      return Array.from(seen).sort();
    },
    // PR C: total turns ignoring filters — used to render "showing M of N"
    // in the toolbar so the user knows when they have unsearched data.
    unifyDebugTurnTotal: (state) => {
      return (state.unifyDebugTurnOrder || EMPTY_ARRAY).length;
    },
    // ★ Unify: the currently visible messages (H2.f.3: thread filter dropped).
    unifyVisibleMessages: (state) => {
      const convId = state.unifyConversationId;
      const raw = convId ? (state.messagesMap[convId] || EMPTY_ARRAY) : EMPTY_ARRAY;
      if (state.unifyActiveGroupFilter) {
        const target = state.unifyActiveGroupFilter;
        return raw.filter(m => m && m.groupId === target);
      }
      return raw;
    },
    // ★ Multi-column: compatibility shim — alias for messagesMap
    messagesCache: (state) => state.messagesMap,
    // ★ Multi-column: whether multiple columns are active
    isMultiColumn: (state) => state.activeConversations.length > 1,
    // ★ Split-screen: whether in split-screen mode (2+ panels)
    isSplitMode: (state) => state.panels.length > 1,
    // 当前会话是否在处理中
    isProcessing: (state) => {
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
      return agent?.messages || EMPTY_ARRAY;
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
    // Unify 页面
    // =====================
    enterUnify(agentId = null) {
      // Capture the chat-side activeConversations snapshot BEFORE flipping
      // currentView. The transition helper is idempotent: if we're
      // already in Unify (e.g. switching agents, programmatic re-entry,
      // a redundant call), it will NOT overwrite the existing snapshot
      // with the unify-only array — which would otherwise cause
      // leaveUnify to "restore" the unify conversationId back into Chat
      // and leak unify messages into the Chat view.
      if (agentId) this.unifyAgentId = agentId;
      else if (!this.unifyAgentId) {
        const online = this.agents.find(a => a.online);
        if (online) this.unifyAgentId = online.id;
      }
      // Create a local conversationId immediately so MessageList has something to render
      if (!this.unifyConversationId) {
        this.unifyConversationId = `unify-local-${Date.now()}`;
      }
      if (!this.messagesMap[this.unifyConversationId]) {
        this.messagesMap[this.unifyConversationId] = [];
      }
      // Snapshot (only on the Chat → Unify edge) and swap activeConversations.
      // Reads `this.currentView` to decide; must run BEFORE the flip below.
      unifyViewHelpers.applyEnterUnifyTransition(this);
      this.currentView = 'unify';
      // task-fix-unify-load-more-empty: clear leaked Chat-mode pagination
      // flags. `hasMoreMessages` is set true by Chat's `db_messages_loaded`
      // / `sync_messages_result` handlers and would otherwise survive the
      // Chat → Unify transition, surfacing a "加载更多消息" hint that does
      // nothing in Unify (Unify history doesn't live in messageDb).
      this.hasMoreMessages = false;
      this.loadingMoreMessages = false;

      // Always request a session_ready replay so model + status + groups
      // snapshot are repopulated on every Unify entry. Backend's
      // handleUnifyLoadHistory is idempotent: the session_ready handler
      // either migrates the local convId (first time) or just refreshes
      // model/status fields (re-entry). When messages already exist we
      // only need the metadata replay, not the message stream — pass
      // limit:0 so the agent skips re-emitting messages and just re-fires
      // session_ready / thread_list_updated / group snapshot events.
      //
      // Group-history-isolation (Bug 7): pass `groupId` so the agent only
      // replays messages stamped with the active group. The active group
      // is owned by the groups Pinia store; we read it lazily here so
      // chat.js doesn't depend on groups.js at module load.
      if (this.unifyAgentId) {
        const existing = this.messagesMap[this.unifyConversationId];
        const needMessages = !existing || existing.length === 0;
        let groupId = null;
        try {
          const gs = window.Pinia?.useGroupsStore?.() || (window.__useGroupsStore && window.__useGroupsStore());
          groupId = (gs && gs.activeGroupId) || null;
        } catch { /* groups store not registered yet — fall back to no filter */ }
        this.sendWsMessage({
          type: 'unify_load_history',
          agentId: this.unifyAgentId,
          limit: needMessages ? 50 : 0,
          groupId,
        });
      }
    },
    leaveUnify() {
      this.currentView = 'chat';
      // Drop any open VP-turn detail drawer too; it's pinned to a
      // specific (vpId, turnId) of the previous Unify session and would
      // otherwise re-open with stale data on the next entry.
      this.unifyOpenVpTurnDetail = null;
      // Restore the original activeConversations snapshot taken on the
      // last real Chat → Unify transition (idempotent — no-op if cold).
      unifyViewHelpers.applyLeaveUnifyTransition(this);
    },
    /**
     * Send a group-scoped Unify chat message. Routes through the agent-side
     * GroupCoordinator which fans out to the target VP(s) or falls back to
     * the group's defaultVpId. This is the SOLE Unify send path —
     * `sendUnifyChat` (legacy 1:1) was removed; callers without a real
     * groupId should pass `'grp_default'`.
     *
     * @param {{groupId:string, text:string, mentions?:string[],
     *           attachments?:Array<{fileId:string,name:string,preview?:string,
     *                               isImage?:boolean,mimeType?:string}>}} payload
     */
    sendUnifyGroupChat({ groupId, text, mentions, attachments }) {
      if (!groupId || !this.unifyAgentId) return;
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
      if (this.unifyConversationId) {
        const localMsg = {
          type: 'user',
          content: effectiveText,
          groupId,
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
        this.addMessageToConversation(this.unifyConversationId, localMsg);
        this.processingConversations[this.unifyConversationId] = true;
        this._turnCompletedConvs?.delete(this.unifyConversationId);
        if (this._closedAt?.[this.unifyConversationId]) {
          delete this._closedAt[this.unifyConversationId];
        }
        this.getOrCreateExecutionStatus(this.unifyConversationId);
        watchdogHelpers.startUnifyWatchdog(this, this.unifyConversationId);
      }
      const wsMsg = {
        type: 'unify_group_chat',
        agentId: this.unifyAgentId,
        groupId,
        text: effectiveText,
        mentions: Array.isArray(mentions) ? mentions : [],
      };
      if (safeAttachments.length > 0) {
        // Wire-side: only the fields the server resolver needs. The
        // server (`client-conversation.js` unify_* relay) consumes
        // `attachments[].fileId` against pendingFiles and forwards
        // `files: [{name,mimeType,data:base64,isImage}]` to the agent.
        wsMsg.attachments = safeAttachments.map((a) => ({
          fileId: a.fileId,
          isImage: !!a.isImage,
        }));
      }
      this.sendWsMessage(wsMsg);
    },
    handleUnifyOutput(msg) {
      if (!msg) return;

      // ── claude_output-format data: dispatch through standard pipeline ──
      if (msg.data) {
        const conversationId = msg.conversationId || this.unifyConversationId;
        if (conversationId) {
          // Ensure messagesMap exists for this conversation
          if (!this.messagesMap[conversationId]) {
            this.messagesMap[conversationId] = [];
          }
          // Store the conversationId if we didn't have it yet
          if (!this.unifyConversationId) {
            this.unifyConversationId = conversationId;
          }
          // Bug 1: stamp the in-flight SEND-context group so messages land
          // in the originating group regardless of the user's current filter.
          const prevGroup = this._currentUnifyGroupId;
          const prevVpId = this._currentUnifyVpId;
          const prevTurnId = this._currentUnifyTurnId;
          const prevFeatureId = this._currentUnifyFeatureId;
          if (msg.groupId) this._currentUnifyGroupId = msg.groupId;
          if (msg.vpId) this._currentUnifyVpId = msg.vpId;
          if (msg.turnId) this._currentUnifyTurnId = msg.turnId;
          // PR-1: stamp featureId from the wire envelope so any code
          // path that reads `_currentUnifyFeatureId` while addMessage
          // is running sees the right value. Reset to null (not just
          // "unchanged") when the inbound msg has no featureId — this
          // matters because emits switch back to non-feature traffic
          // mid-turn (e.g. typing indicators after the feature closes).
          this._currentUnifyFeatureId = msg.featureId || null;
          try {
            this.handleClaudeOutput(conversationId, msg.data);
          } finally {
            this._currentUnifyGroupId = prevGroup;
            this._currentUnifyVpId = prevVpId;
            this._currentUnifyTurnId = prevTurnId;
            this._currentUnifyFeatureId = prevFeatureId;
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
          const localConvId = this.unifyConversationId;

          // Migrate messages from local placeholder to agent's conversationId
          if (localConvId && localConvId !== agentConvId) {
            const existingMsgs = this.messagesMap[localConvId] || [];
            this.messagesMap[agentConvId] = existingMsgs;
            delete this.messagesMap[localConvId];
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

          this.unifyConversationId = agentConvId;
          this.unifyModel = event.model;
          this.unifySessionReady = true;
          this.unifyAvailableModels = event.availableModels || [];
          this.unifyStatus = {
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
          if (this.currentView === 'unify') {
            this.activeConversations = [agentConvId];
          }

          // ★ task-334-ui-a: subscribe to VP library snapshot.
          // Snapshot-only this slice; live diff (vp_updated/vp_removed)
          // arrives via the same channel once 334h ships.
          this.sendWsMessage({ type: 'unify_vp_subscribe' });
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
            vpId: event.vpId || null,
            groupId: event.groupId || msg.groupId || null,
            openedAt: event.at || Date.now(),
            closedAt: null,
            totalMs: 0,
            totalTokens: 0,
            loopCount: 0,
            memoryLoaded: null,
            memoryAdjust: null,
            tools: [],
          };
          this.unifyDebugTurnsById = { ...this.unifyDebugTurnsById, [event.turnId]: turn };
          if (!this.unifyDebugTurnOrder.includes(event.turnId)) {
            this.unifyDebugTurnOrder = [...this.unifyDebugTurnOrder, event.turnId];
          }
          break;
        }

        case 'turn_close': {
          if (!event.turnId) break;
          const prev = this.unifyDebugTurnsById[event.turnId];
          if (!prev) break;
          this.unifyDebugTurnsById = {
            ...this.unifyDebugTurnsById,
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
          const prev = this.unifyDebugTurnsById[event.turnId];
          if (!prev) break;
          this.unifyDebugTurnsById = {
            ...this.unifyDebugTurnsById,
            [event.turnId]: {
              ...prev,
              memoryLoaded: Array.isArray(event.loaded) ? event.loaded : [],
            },
          };
          break;
        }

        case 'memory_adjust': {
          if (!event.turnId) break;
          const prev = this.unifyDebugTurnsById[event.turnId];
          if (!prev) break;
          this.unifyDebugTurnsById = {
            ...this.unifyDebugTurnsById,
            [event.turnId]: {
              ...prev,
              memoryAdjust: {
                groupKey: event.groupKey || null,
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
          const prev = this.unifyDebugTurnsById[event.turnId];
          if (!prev) break;
          const tools = [...(prev.tools || []), {
            loopNumber: event.loopNumber || 0,
            callId: event.callId || null,
            name: event.name || '?',
            durationMs: event.durationMs || 0,
            isError: !!event.isError,
          }];
          this.unifyDebugTurnsById = {
            ...this.unifyDebugTurnsById,
            [event.turnId]: { ...prev, tools },
          };
          break;
        }

        case 'loop': {
          // feat-6af5f9f1 PR B: replaces `debug_turn`. Each entry is one
          // LLM call; the parent Turn record lives in unifyDebugTurnsById
          // under loop.turnId.
          this.unifyDebugLoops.push({
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
            // task-344: raw API request / response payload (redacted server-side).
            rawRequest: event.rawRequest || null,
            rawResponse: event.rawResponse || null,
            // Bug 3 carry-over: stamp groupId so the panel filter narrows
            // by group. Falls back to envelope groupId if engine omitted it.
            groupId: msg.groupId || null,
          });
          // fix-debug-copy-no-truncate: bound retention by count.
          // Drop oldest loop entries when the cap is exceeded, then
          // garbage-collect any turn record whose loops are all gone
          // (so unifyDebugTurnsById / unifyDebugTurnOrder don't grow
          // unboundedly either). This is the architectural counterpart
          // to removing per-payload truncation: payloads are kept
          // verbatim, but we keep at most MAX_UNIFY_DEBUG_LOOPS of them.
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
          if (this.unifyDebugLoops.length > MAX_UNIFY_DEBUG_LOOPS) {
            const next = trimDebugRetention({
              loops: this.unifyDebugLoops,
              turnsById: this.unifyDebugTurnsById,
              turnOrder: this.unifyDebugTurnOrder,
              maxLoops: MAX_UNIFY_DEBUG_LOOPS,
            });
            this.unifyDebugLoops = next.loops;
            this.unifyDebugTurnsById = next.turnsById;
            this.unifyDebugTurnOrder = next.turnOrder;
          }
          break;
        }

        case 'recall':
        case 'consolidate':
        case 'fallback':
        case 'thinking_delta':
          // Future: display these in UI
          break;

        // PR-1 (feature-pill double-track) — protocol-only intake.
        // The agent emits these three events to drive the pill UI in
        // PR-2. PR-1 just stashes the data into store state and wires
        // no rendering — that arrives with the MessageList changes in
        // the next PR. We deliberately accept the events even when no
        // UI consumes them so PR-1 is shippable in isolation.
        case 'quick_preview': {
          // Track A came back with `{intent, preview}`. Key the entry
          // by `vpId:turnId` so a re-run of the same VP on a fresh
          // turn doesn't clobber the previous preview while it's still
          // on screen.
          const vpId = event.vpId || msg.vpId;
          const turnId = event.turnId || msg.turnId;
          if (vpId && turnId) {
            const key = `${vpId}:${turnId}`;
            this.unifyQuickPreviews = {
              ...this.unifyQuickPreviews,
              [key]: {
                vpId,
                turnId,
                intent: event.intent === 'feature' ? 'feature' : 'quick',
                preview: typeof event.preview === 'string' ? event.preview : '',
                ts: Date.now(),
              },
            };
          }
          break;
        }

        case 'feature_started': {
          // One of the three signals fired (quick / turns / tool); the
          // arc just published a featureId. Record it and mark this VP
          // as "actively in a feature" so PR-2's MessageList can fold
          // subsequent messages tagged with the same featureId.
          const featureId = event.featureId;
          const vpId = event.vpId || msg.vpId;
          const turnId = event.turnId || msg.turnId;
          const groupId = event.groupId || msg.groupId || null;
          if (featureId) {
            this.unifyFeatureMeta = {
              ...this.unifyFeatureMeta,
              [featureId]: {
                featureId,
                vpId,
                groupId,
                turnId,
                title: typeof event.title === 'string' ? event.title : '',
                trigger: event.trigger || 'unknown',
                toolName: event.toolName || null,
                status: 'active',
                startedAt: Date.now(),
              },
            };
            if (vpId) {
              this.unifyActiveFeatureByVp = {
                ...this.unifyActiveFeatureByVp,
                [vpId]: featureId,
              };
            }
          }
          break;
        }

        case 'feature_completed': {
          // Arc.finalize() fired. Move the meta entry to a terminal
          // state and clear the per-VP active pointer if it still
          // points at this feature.
          const featureId = event.featureId;
          const vpId = event.vpId || msg.vpId;
          if (featureId && this.unifyFeatureMeta[featureId]) {
            const prev = this.unifyFeatureMeta[featureId];
            this.unifyFeatureMeta = {
              ...this.unifyFeatureMeta,
              [featureId]: {
                ...prev,
                status: event.status || 'completed',
                summary: typeof event.summary === 'string' ? event.summary : '',
                endedAt: Date.now(),
              },
            };
          }
          if (vpId && this.unifyActiveFeatureByVp[vpId] === featureId) {
            const next = { ...this.unifyActiveFeatureByVp };
            next[vpId] = null;
            this.unifyActiveFeatureByVp = next;
          }
          break;
        }

        case 'reflection': {
          // PR-L: V7 tool-history reflection. Two phases per occurrence
          // (pending → ready) plus an error phase if generation fails.
          // We store the latest state keyed by conversationId + trigger
          // + loopRange so the UI can swap "thinking…" placeholder for
          // the rendered card.
          const convId = msg.conversationId || this.unifyConversationId || 'unknown';
          const range = Array.isArray(event.loopRange) ? event.loopRange : [0, 0];
          const key = `${convId}:${event.trigger}:${range[0]}-${range[1]}`;
          // Anchor the card to the current tail of the message list so
          // MessageList can render it inline (right after the last
          // message present at arrival time). Latch on first emit
          // (`pending`); preserve across `ready`/`error` transitions so
          // the card doesn't jump position when the body fills in.
          const existing = this.unifyReflectionCards[key];
          const tailMsgs = this.messagesMap[convId] || [];
          const anchorMsgId = existing
            ? existing.anchorMsgId
            : (tailMsgs.length > 0 ? tailMsgs[tailMsgs.length - 1].id || null : null);
          const anchorOrder = existing
            ? existing.anchorOrder
            : tailMsgs.length;
          this.unifyReflectionCards = {
            ...this.unifyReflectionCards,
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
              groupId: msg.groupId || null,
              anchorMsgId,
              anchorOrder,
              updatedAt: Date.now(),
            },
          };
          break;
        }

        case 'model_switched':
          this.unifyModel = event.model;
          break;

        case 'sub_agent_event': {
          // PR-M3: a sub-agent emitted an event. `agentId` identifies the
          // sub-agent; `payload` is the underlying engine event (text_delta,
          // tool_call, sub_agent_status, sub_agent_turn_end, etc.).
          // We accumulate per-agent state into a single card keyed by
          // ${convId}:${agentId} — anchored to the message present at the
          // first emit so MessageList can render it inline.
          const convId = msg.conversationId || this.unifyConversationId || 'unknown';
          const agentId = event.agentId;
          if (!agentId) break;
          const payload = event.payload || {};
          const key = `${convId}:${agentId}`;
          const existing = this.unifySubAgentCards[key];
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
            toolCalls: [],
            turns: 0,
            error: null,
            expanded: false,
            anchorMsgId,
            anchorOrder,
            updatedAt: Date.now(),
            groupId: msg.groupId || null,
            // PR-4: parent feature inheritance. Stamped by the sub-agent
            // runner (see agent/unify/sub-agent/runner.js wrapEvt) when
            // the parent VP is mid-feature. Latch-once: see below.
            featureId: null,
          };

          if (payload.agentName && !next.agentName) next.agentName = payload.agentName;
          // PR-4: latch featureId on first sighting; once set, never
          // overwrite — keeps fold-by-featureId stable across later
          // events (e.g. closing status) that may not carry it.
          next.featureId = next.featureId || payload.featureId || null;

          switch (payload.type) {
            case 'sub_agent_status':
              next.status = payload.status || next.status;
              if (payload.error) next.error = payload.error;
              break;
            case 'text_delta':
              if (typeof payload.text === 'string') next.text += payload.text;
              break;
            case 'tool_start':
            case 'tool_use':
            case 'tool_call':
              next.toolCalls = [
                ...next.toolCalls,
                {
                  id: payload.id || `${agentId}-${next.toolCalls.length}`,
                  name: payload.name || payload.toolName || 'tool',
                  status: 'running',
                },
              ];
              break;
            case 'tool_result':
            case 'tool_end': {
              const idx = next.toolCalls.findIndex(
                (t) => t.id === (payload.id || payload.toolUseId),
              );
              if (idx >= 0) {
                const arr = next.toolCalls.slice();
                arr[idx] = { ...arr[idx], status: payload.isError || payload.error ? 'error' : 'done' };
                next.toolCalls = arr;
              }
              break;
            }
            case 'sub_agent_turn_end':
              next.turns += 1;
              if (typeof payload.content === 'string') next.text = payload.content;
              if (next.status !== 'failed' && next.status !== 'closed') {
                next.status = 'idle';
              }
              break;
            case 'error':
              if (payload.error) {
                next.error = payload.error.message || String(payload.error);
              }
              break;
            default:
              break;
          }

          next.updatedAt = Date.now();
          this.unifySubAgentCards = { ...this.unifySubAgentCards, [key]: next };
          break;
        }

        case 'history_loaded':
          // History messages already rendered via sendUnifyOutput (data path).
          // This event just signals completion — no additional action needed.
          break;

        // ★ task-334-ui-a + 334h: VP library snapshot + live diff.
        case 'vp_snapshot': {
          // Lazy import to avoid circular dep at module load.
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp) vp.applySnapshot(event);
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
        case 'group_list_updated': {
          const gs = window.Pinia?.useGroupsStore?.() || (window.__useGroupsStore && window.__useGroupsStore());
          if (gs) gs.applySnapshot(event.groups);
          break;
        }
        case 'group_roster_changed': {
          const gs = window.Pinia?.useGroupsStore?.() || (window.__useGroupsStore && window.__useGroupsStore());
          if (gs) gs.applyRosterChange(event);
          break;
        }
        case 'group_crud_result': {
          const gs = window.Pinia?.useGroupsStore?.() || (window.__useGroupsStore && window.__useGroupsStore());
          if (gs) gs.applyCrudResult(event);
          const pending = this._groupCrudPending && this._groupCrudPending.get(event.requestId);
          if (pending) {
            this._groupCrudPending.delete(event.requestId);
            pending.resolve({
              ok: !!event.ok,
              op: event.op,
              group: event.group || null,
              groupId: event.groupId || null,
              groups: event.groups || null,
              error: event.error || null,
            });
          }
          break;
        }

        // ★ task-301 Part 2: real-store push from agent.
        // H2.f.6: thread_list_updated never arrives anymore — bridge stopped
        // emitting. Case removed; legacy replay would silently fall through.

        // R6 G1a — task summary history (revisions + optional archived).
        case 'unify_summary_history': {
          const ts = (window.Pinia && window.Pinia.useFeaturesStore)
            ? window.Pinia.useFeaturesStore() : null;
          if (ts && typeof ts.applySummaryHistory === 'function') {
            ts.applySummaryHistory(event);
          }
          break;
        }

        // R6 G1a — task affiliation CRUD result (relate / unrelate / kick / abort).
        case 'unify_feature_crud_result': {
          const ts = (window.Pinia && window.Pinia.useFeaturesStore)
            ? window.Pinia.useFeaturesStore() : null;
          if (ts && typeof ts.applyCrudResult === 'function') {
            ts.applyCrudResult(event);
          }
          break;
        }

        // H2.f.6: thread_merged / thread_forked / *_failed cases removed —
        // bridge no longer emits them.

        // task-fix: per-VP typing indicator (group chat only).
        //   vp_typing_start → increment unifyVpTyping[vpId]
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
            [event.turnId]: { vpId: event.vpId, isStreaming: true },
          };
          break;
        }
        case 'unify_turn_aborted': {
          if (!event.turnId) break;
          const { [event.turnId]: _removed, ...rest } = this.activeVpTurns;
          this.activeVpTurns = rest;
          break;
        }
        case 'vp_typing_start': {
          if (!event.vpId) break;
          // Nest by conversationId so Unify typing state never leaks into
          // the Chat view (cross-mode state leak). The conversationId rides
          // on the unify_output envelope (msg.conversationId) — fall back to
          // the current Unify session id if absent.
          const convId = msg.conversationId || this.unifyConversationId;
          if (!convId) break;
          this.unifyVpTyping = incVpTyping(this.unifyVpTyping, convId, event.vpId);
          break;
        }
        case 'vp_typing_end': {
          if (!event.vpId) break;
          const convId = msg.conversationId || this.unifyConversationId;
          if (!convId) break;
          this.unifyVpTyping = decVpTyping(this.unifyVpTyping, convId, event.vpId);
          break;
        }

        // task-707: route_forward hand-off hint. The agent emits this when
        // the originating VP's `route_forward` tool succeeds and the
        // engine breaks the tool-loop with stopReason='tool_handoff'. We
        // stamp the hint onto the originating VP's most-recent assistant
        // message (matched by turnId+vpId) so the bubble can render
        // "↪ 已转交给 @vp-b、@vp-c" beneath the message body. Target VPs
        // already have `vp_typing_start` from the bridge's enqueueForVp,
        // so their typing dots are already lit by the time this fires.
        case 'group_handoff': {
          const fromVpId = event.fromVpId;
          const toVpIds = Array.isArray(event.toVpIds) ? event.toVpIds : [];
          if (!fromVpId || toVpIds.length === 0) break;
          const convId = msg.conversationId || this.unifyConversationId;
          if (!convId) break;
          const turnId = msg.turnId || null;
          const list = this.messagesMap[convId];
          if (!Array.isArray(list)) break;
          // Find the most-recent assistant message belonging to this
          // VP/turn — that's the bubble the hand-off hint belongs to.
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            if (m.type !== 'assistant') continue;
            if (turnId && m.turnId !== turnId) continue;
            if (!turnId && m.vpId !== fromVpId) continue;
            // Append (don't overwrite) so multiple hand-offs in a single
            // turn — e.g. a VP that calls route_forward twice — all show.
            const existing = Array.isArray(m.handoffHints) ? m.handoffHints : [];
            m.handoffHints = [
              ...existing,
              {
                kind: event.kind || 'route_forward',
                toVpIds: toVpIds.slice(),
                broadcast: Boolean(event.broadcast),
                text: typeof event.text === 'string' ? event.text : '',
                reason: event.reason || null,
                ts: event.ts || Date.now(),
              },
            ];
            break;
          }
          break;
        }

        // ★ R6 G3: dream activity events. Forwarded from
        // agent/unify/web-bridge.js handleUnifyDreamTrigger.
        // unify_dream_status carries { vpId, status: 'running' } during the
        // run; unify_dream_result carries { vpId, success, mergedCount, ... }
        // when finished. Both flow into vpStore.dreamStatus[vpId] so the
        // VpDetailView status bar can update without polling.
        case 'unify_dream_status': {
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp) vp.applyDreamStatus(event);
          break;
        }
        case 'unify_dream_result': {
          const vp = window.Pinia?.useVpStore?.() || (window.__useVpStore && window.__useVpStore());
          if (vp) vp.applyDreamResult(event);
          break;
        }
      }
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
    setUnifySidebarEnabled(_enabled) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('unify-sidebar-enabled');
        }
      } catch (_) { /* ignore storage errors */ }
    },
    // H2.f.6: thread filter / merge / fork / setActive actions removed.
    // setUnifyThreadFilter, clearUnifyThreadFilter, mergeUnifyThread,
    // forkUnifyThread, setActiveThread no longer exist.

    // ★ task-334-ui-g: VP CRUD request dispatcher.
    // Wraps `unify_vp_{create,update,delete,read}` in a Promise that
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
        create: 'unify_vp_create',
        update: 'unify_vp_update',
        delete: 'unify_vp_delete',
        read: 'unify_vp_read',
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
    // ★ task-334m: Group CRUD request dispatcher. Mirrors vpCrudRequest.
    // Supported ops: list / create / rename / archive / add_member /
    // remove_member / set_default_vp.
    //
    //   op                data shape
    //   list              (ignored)
    //   create            { name, roster?, defaultVpId? }  → msg.payload
    //   rename            { groupId, name }                → flat
    //   archive           { groupId }                      → flat
    //   add_member        { groupId, vpId }                → flat
    //   remove_member     { groupId, vpId }                → flat
    //   set_default_vp    { groupId, vpId }                → flat
    groupCrudRequest(op, data) {
      if (!this._groupCrudPending || typeof this._groupCrudPending.get !== 'function') {
        this._groupCrudPending = new Map();
      }
      const requestId = 'grc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const typeMap = {
        list: 'unify_list_groups',
        create: 'unify_create_group',
        rename: 'unify_rename_group',
        update: 'unify_update_group',
        archive: 'unify_archive_group',
        delete: 'unify_delete_group',
        add_member: 'unify_add_member',
        remove_member: 'unify_remove_member',
        set_default_vp: 'unify_set_default_vp',
      };
      const type = typeMap[op];
      if (!type) {
        return Promise.resolve({ ok: false, op, error: { code: 'bad_op', message: 'unknown op: ' + op } });
      }
      const msg = { type, requestId };
      if (op === 'create') msg.payload = data || {};
      else if (data && typeof data === 'object') Object.assign(msg, data);

      const gs = window.Pinia?.useGroupsStore?.() || (window.__useGroupsStore && window.__useGroupsStore());
      if (gs) gs.markPending(requestId, op);

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this._groupCrudPending && this._groupCrudPending.has(requestId)) {
            this._groupCrudPending.delete(requestId);
            resolve({ ok: false, op, error: { code: 'timeout', message: 'group_crud timeout' } });
          }
        }, 10000);
        this._groupCrudPending.set(requestId, {
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
    // Group-history-isolation (Bug 7): also clear the message stream and
    // re-request history from the agent scoped to this group. Without this,
    // re-entering a group would either show the previous group's messages
    // or — worse — show the legacy `grp_default` orphans plus pre-grouping
    // messages because the cached stream was loaded with no group filter.
    setActiveGroupFilter(groupId) {
      const prev = this.unifyActiveGroupFilter || null;
      this.unifyActiveGroupFilter = groupId || null;
      // Only force a reload when the filter actually changed AND we have
      // an active Unify session to ask. The local-only path (no agent yet)
      // is harmless: the next sendUnifyEnter will plumb the groupId.
      if ((groupId || null) === prev) return;
      const convId = this.unifyConversationId;
      if (convId && this.messagesMap[convId]) {
        this.messagesMap[convId] = [];
      }
      if (this.unifyAgentId) {
        this.sendWsMessage({
          type: 'unify_load_history',
          agentId: this.unifyAgentId,
          limit: 50,
          groupId: groupId || null,
        });
      }
    },
    // ★ task-334-ui-c: VP detail view entry / exit.
    enterVpDetailView(vpId) {
      if (!vpId) return;
      this.unifyActiveVpDetailId = String(vpId);
    },
    leaveVpDetailView() {
      this.unifyActiveVpDetailId = null;
    },
    /**
     * Open the right-side VP-turn detail drawer for a single VP turn.
     * Idempotent: switching to a different vpId+turnId replaces the
     * descriptor; the drawer keeps its DOM instance.
     * No-op if vpId or turnId is missing.
     */
    openVpTurnDetail(payload) {
      if (!payload || !payload.vpId || !payload.turnId) return;
      this.unifyOpenVpTurnDetail = { vpId: payload.vpId, turnId: payload.turnId };
    },

    closeVpTurnDetail() {
      this.unifyOpenVpTurnDetail = null;
    },
    // H2.f.6: setUnifyFeatureReplyThreadId / setUnifyJumpTarget /
    // clearUnifyJumpTarget actions removed.
    switchUnifyModel(modelId) {
      if (!modelId || !this.unifyAgentId) return;
      this.sendWsMessage({
        type: 'unify_model_switch',
        model: modelId,
        agentId: this.unifyAgentId,
      });
    },
    // task-344: toggle the Unify debug panel "detail" mode (shows full raw
     // API request + response payload). Persisted to localStorage.
    setUnifyDebugDetailMode(enabled) {
      this.unifyDebugDetailMode = !!enabled;
      try { localStorage.setItem('unifyDebugDetailMode', enabled ? '1' : '0'); }
      catch { /* ignore */ }
    },

    // feat-6af5f9f1 PR C: search query for the debug panel toolbar.
    // Substring filter (case-insensitive) applied to the per-turn fields
    // listed in turnMatchesSearch(). Not persisted — search is a transient
    // exploration tool, not a session preference.
    setUnifyDebugSearch(query) {
      this.unifyDebugSearch = typeof query === 'string' ? query : '';
    },

    // feat-6af5f9f1 PR C: independent debug-panel group filter. Distinct
    // from `unifyActiveGroupFilter` (the main pane's filter) so the user
    // can debug across all groups even when the main pane is narrowed.
    //   - null      : fall back to main pane filter (default)
    //   - '__all__' : force "show all" regardless of main pane
    //   - <groupId> : pin to a specific group
    setUnifyDebugGroupFilter(groupId) {
      if (groupId === null || groupId === undefined) {
        this.unifyDebugGroupFilter = null;
      } else {
        this.unifyDebugGroupFilter = String(groupId);
      }
    },

    toggleSubAgentCardExpand(key) {
      const card = this.unifySubAgentCards?.[key];
      if (!card) return;
      this.unifySubAgentCards = {
        ...this.unifySubAgentCards,
        [key]: { ...card, expanded: !card.expanded },
      };
    },

    // ─── Search settings (Tavily backend + key + on-demand quota) ───
    //
    // The Search tab in UnifySettings uses these. They use
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
      if (!this.unifyAgentId) {
        this.searchSettings = { backend: 'tavily', tavilyKeyConfigured: false, tavilyKeyMasked: null, disableHtmlFallback: false, loaded: true };
        return Promise.resolve(this.searchSettings);
      }
      return new Promise((resolve) => {
        if (!this._searchPending) this._searchPending = {};
        this._searchPending.load = resolve;
        this.sendWsMessage({ type: 'get_search_settings', agentId: this.unifyAgentId });
      });
    },

    /**
     * Persist a partial search-settings update. `payload` may include
     * `backend`, `tavilyApiKey`, `disableHtmlFallback`. Omit fields to
     * keep them unchanged — particularly `tavilyApiKey`, which the UI
     * passes only when the user actually edited the input.
     */
    updateSearchSettings(payload) {
      if (!this.unifyAgentId) return Promise.resolve({ error: 'no agent' });
      return new Promise((resolve) => {
        if (!this._searchPending) this._searchPending = {};
        this._searchPending.update = resolve;
        this.sendWsMessage({
          type: 'update_search_settings',
          agentId: this.unifyAgentId,
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
      if (!this.unifyAgentId) return Promise.resolve(null);
      this.tavilyUsageLoading = true;
      return new Promise((resolve) => {
        if (!this._searchPending) this._searchPending = {};
        this._searchPending.usage = resolve;
        this.sendWsMessage({ type: 'get_tavily_usage', agentId: this.unifyAgentId });
      });
    },

    clearUnifyMessages() {
      const oldConvId = this.unifyConversationId;
      if (oldConvId) {
        delete this.messagesMap[oldConvId];
        delete this.processingConversations[oldConvId];
        delete this.executionStatusMap[oldConvId];
      }
      // Create a fresh local conversationId
      this.unifyConversationId = `unify-local-${Date.now()}`;
      this.messagesMap[this.unifyConversationId] = [];
      this.activeConversations = [this.unifyConversationId];
      this.unifySessionReady = false;
      this.unifyModel = null;
      this.unifyAvailableModels = [];
      this.unifyStatus = null;
      // feat-6af5f9f1 PR B: clear new Turn-grouped debug shape.
      this.unifyDebugLoops = [];
      this.unifyDebugTurnsById = {};
      this.unifyDebugTurnOrder = [];
      // feat-6af5f9f1 PR C: clear toolbar transient state too. The group
      // filter is intentionally cleared on session reset so a stale pin
      // from a previous session doesn't hide all incoming turns.
      this.unifyDebugSearch = '';
      this.unifyDebugGroupFilter = null;
      this.unifyReflectionCards = {};
      this.unifySubAgentCards = {};
      // Same reasoning as leaveUnify: a stale (vpId, turnId) descriptor
      // from the previous session would re-open the drawer with no
      // matching messages once the messagesMap is wiped.
      this.unifyOpenVpTurnDetail = null;
      // Tell agent to reset session so Engine gets a fresh start
      if (this.unifyAgentId) {
        this.sendWsMessage({
          type: 'unify_reset',
          agentId: this.unifyAgentId,
        });
      }
    },

    // R6 G4: surface a non-blocking hint when the user @-mentions a VP that
    // isn't on the active group's roster. We do NOT auto-invite (D4 — the
    // user owns roster changes); we just queue a toast asking them to add
    // the VP via the group editor. ChatInput's selectVpMention() calls this.
    flashInviteHint(vpId) {
      if (!vpId) return;
      const id = 'imh_' + Date.now().toString(36) + '_' +
        Math.random().toString(36).slice(2, 8);
      this.unifyMentionInviteHints = [
        ...this.unifyMentionInviteHints,
        { id, vpId, at: Date.now() },
      ];
    },

    dismissInviteHint(id) {
      if (!id) return;
      this.unifyMentionInviteHints = this.unifyMentionInviteHints.filter(h => h.id !== id);
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
        messages: []
      };
      // Auto-open panel when first subagent starts for current conversation
      if (conversationId === this.currentConversation && this.activeRightPanel !== 'subagents') {
        this.activeRightPanel = 'subagents';
      }
    },
    appendSubagentMessage(conversationId, subagentId, message) {
      const convSubagents = this.subagents[conversationId];
      if (!convSubagents || !convSubagents[subagentId]) return;
      convSubagents[subagentId].messages.push(message);
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
    // Claude output processing
    // =====================
    getOrCreateExecutionStatus(conversationId) { return claudeHelpers.getOrCreateExecutionStatus(this, conversationId); },
    handleClaudeOutput(conversationId, data) { claudeHelpers.handleClaudeOutput(this, conversationId, data); },

    // =====================
    // Message CRUD
    // =====================
    addMessageToConversation(conversationId, msg) { msgHelpers.addMessageToConversation(this, conversationId, msg); },
    appendToAssistantMessageForConversation(conversationId, text) { msgHelpers.appendToAssistantMessageForConversation(this, conversationId, text); },
    finishStreamingForConversation(conversationId) { msgHelpers.finishStreamingForConversation(this, conversationId); },
    appendToAssistantMessage(text) { this.appendToAssistantMessageForConversation(this.currentConversation, text); },
    finishStreaming() { this.finishStreamingForConversation(this.currentConversation); },
    addMessage(msg) { this.addMessageToConversation(this.currentConversation, msg); },
    loadHistoryMessages(historyMessages) { msgHelpers.loadHistoryMessages(this, historyMessages); },
    formatDbMessage(dbMsg) { return msgHelpers.formatDbMessage(dbMsg); },

    // =====================
    // Conversation lifecycle
    // =====================
    selectAgent(agentId) { convHelpers.selectAgent(this, agentId); },
    createConversation(workDir, agentId = null, disallowedTools = null) { convHelpers.createConversation(this, workDir, agentId, disallowedTools); },
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
    togglePin(sessionId) {
      const isPinned = this.pinnedSessions.includes(sessionId);
      if (isPinned) {
        const idx = this.pinnedSessions.indexOf(sessionId);
        if (idx >= 0) this.pinnedSessions.splice(idx, 1);
      } else {
        this.pinnedSessions.unshift(sessionId);
      }
      // Persist to localStorage as fallback
      localStorage.setItem('pinned-sessions', JSON.stringify(this.pinnedSessions));
      // Persist to server
      this.sendWsMessage({
        type: isPinned ? 'unpin_session' : 'pin_session',
        conversationId: sessionId
      });
    },
    isSessionPinned(sessionId) {
      return this.pinnedSessions.includes(sessionId);
    },
    sendMessage(text, attachments = [], options = {}) { convHelpers.sendMessage(this, text, attachments, options); },
    cancelExecution() { convHelpers.cancelExecution(this); },
    /**
     * Bug 5: Unify-mode stop. ChatInput's default cancel calls
     * cancelExecution() (Chat-mode), which sends `cancel_execution` keyed
     * to a Claude-CLI conversationId — that is a no-op for Unify because
     * Unify runs its own engine inside the agent and tracks abort
     * controllers per-thread. Send `unify_abort_all` instead so every
     * in-flight thread's AbortController fires. The agent emits
     * `unify_aborted` ack which clears `processingConversations` via the
     * standard pipeline.
     */
    cancelUnify() {
      if (!this.unifyAgentId) return;
      this.sendWsMessage({
        type: 'unify_abort_all',
        agentId: this.unifyAgentId,
      });
      // Optimistic UX: clear the local processing flag immediately so the
      // stop button hides without waiting for the round-trip. The agent's
      // unify_aborted event is idempotent.
      if (this.unifyConversationId) {
        this.processingConversations[this.unifyConversationId] = false;
      }
      this.activeVpTurns = {};
    },
    /**
     * Per-VP stop: abort a single VP turn by turnId without affecting siblings.
     */
    cancelVpTurn(turnId) {
      if (!this.unifyAgentId || !turnId) return;
      this.sendWsMessage({
        type: 'unify_abort_turn',
        agentId: this.unifyAgentId,
        turnId,
      });
      // Optimistic: remove from activeVpTurns immediately.
      const { [turnId]: _removed, ...rest } = this.activeVpTurns;
      this.activeVpTurns = rest;
    },
    answerUserQuestion(requestId, answers, conversationId) { convHelpers.answerUserQuestion(this, requestId, answers, conversationId); },
    refreshAgents() { convHelpers.refreshAgents(this); },
    refreshConversation() { convHelpers.refreshConversation(this); },
    restartAgent(agentId) { convHelpers.restartAgent(this, agentId); },
    upgradeAgent(agentId) { convHelpers.upgradeAgent(this, agentId); },

    // ★ Phase 6.1: 分页加载（基于 turn，统一走 DB）
    loadMoreMessages() {
      if (this.loadingMoreMessages || !this.hasMoreMessages || !this.currentConversation) return;
      this.loadingMoreMessages = true;

      const msgs = this.messagesMap[this.currentConversation] || [];
      const firstMsgWithId = msgs.find(m => m.dbMessageId);
      this.sendWsMessage({
        type: 'sync_messages',
        conversationId: this.currentConversation,
        turns: 5,
        ...(firstMsgWithId ? { beforeId: firstMsgWithId.dbMessageId } : {})
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
    listFoldersForAgent(agentId) { return sessionHelpers.listFoldersForAgent(this, agentId); },
    listHistorySessionsForAgent(agentId, workDir) { sessionHelpers.listHistorySessionsForAgent(this, agentId, workDir); },
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

    changeLocale(locale) {
      this.locale = locale;
      setLocale(locale);
      // task-708: live-locale propagation. Push the new language to the
      // agent so the per-VP Engine pool (and 1:1-chat session.engine)
      // re-renders the system prompt in the chosen language on the very
      // next turn — no session reload required. Skipped when no Unify
      // agent is bound (Chat-only or pre-connect state).
      if (this.unifyAgentId) {
        try {
          this.sendWsMessage({
            type: 'update_llm_config',
            agentId: this.unifyAgentId,
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
