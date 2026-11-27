/**
 * Yeaft Cosmos — Real-Time Agent & Session State Projection
 *
 * Projects live Pinia `chatStore` + `sessionsStore` data into per-Agent planetary telemetry:
 * - Online / Running / Waiting (AskUser) / Idle / Offline status
 * - Ordered session list with compact 2~3 line preview snippets from loaded transcripts
 * - Relative timestamps for orbit micro-lists and hover cards
 */
import { shortenPath } from '../utils/path-display.js';
import { buildProjectTree } from '../stores/helpers/project-tree.js';
import { legacySidebarCatalogReady } from '../stores/helpers/sidebar-session-catalog.js';
import { stripMarkdownPreview } from '../stores/helpers/yeaft-reply-preview.js';
import { LIVE_SESSION_TURN_STATES } from '../stores/helpers/yeaft-session-turns.js';
import { YEAFT_RUNNING_VP_STATES } from '../stores/helpers/yeaft-runtime-state.js';
import { yeaftSessionIdentityKey } from '../stores/helpers/yeaft-session-identity.js';

const TERMINAL_ASSISTANT_STATUSES = new Set(['completed', 'aborted', 'errored', 'cancelled']);
const INLINE_TOOL_NAMES = new Set(['AskUser', 'AskUserQuestion', 'TodoWrite', 'RouteForward']);
const RUNNING_STATE_PRIORITY = ['cancelling', 'retrying', 'tool', 'background_task', 'streaming', 'typing', 'thinking', 'provider', 'routing', 'queued', 'preparing'];

function translateSignal(t, isEn, key, params, fallbackEn, fallbackZh) {
  if (typeof t === 'function') {
    const out = params ? t(key, params) : t(key);
    if (out && out !== key) return out;
  }
  let raw = isEn ? fallbackEn : fallbackZh;
  if (params && typeof raw === 'string') {
    for (const [k, v] of Object.entries(params)) {
      raw = raw.replaceAll(`{${k}}`, String(v ?? ''));
    }
  }
  return raw;
}

function matchesScopedRuntimeRow(row, agentId, sessionId) {
  if (!row) return false;
  const rowSessionId = row.sessionId ?? row.groupId ?? '';
  if (rowSessionId !== sessionId) return false;
  return agentId ? (!row.agentId || row.agentId === agentId) : true;
}

function collectActiveYeaftTurnIds(chatStore, agentId, sessionId) {
  const turnIds = new Set();
  if (!chatStore || !sessionId) return turnIds;
  for (const info of Object.values(chatStore.activeVpTurns || {})) {
    if (info?.turnId && matchesScopedRuntimeRow(info, agentId, sessionId)) {
      turnIds.add(info.turnId);
    }
  }
  const sessionKey = yeaftSessionIdentityKey(agentId, sessionId);
  const turns = sessionKey ? (chatStore.yeaftSessionTurnsBySession?.[sessionKey]?.turns || []) : [];
  for (const turn of turns) {
    if (!LIVE_SESSION_TURN_STATES.has(turn?.state)) continue;
    for (const exec of (turn.executions || [])) {
      if (exec?.turnId && LIVE_SESSION_TURN_STATES.has(exec.state)) {
        turnIds.add(exec.turnId);
      }
    }
  }
  for (const status of Object.values(chatStore.vpStatuses || {})) {
    if (!matchesScopedRuntimeRow(status, agentId, sessionId)) continue;
    if (Array.isArray(status.threads)) {
      for (const thread of status.threads) {
        const st = thread?.state || thread?.status;
        if (thread?.turnId && YEAFT_RUNNING_VP_STATES.has(st)) turnIds.add(thread.turnId);
      }
    } else if (status.turnId && YEAFT_RUNNING_VP_STATES.has(status.state)) {
      turnIds.add(status.turnId);
    }
  }
  return turnIds;
}

function hasAuthoritativeYeaftRuntime(chatStore, agentId, sessionId) {
  if (!chatStore || !sessionId) return false;
  const sessionKey = yeaftSessionIdentityKey(agentId, sessionId);
  if (sessionKey && chatStore.yeaftSessionTurnsBySession?.[sessionKey]) return true;
  for (const status of Object.values(chatStore.vpStatuses || {})) {
    if (matchesScopedRuntimeRow(status, agentId, sessionId)) return true;
  }
  return false;
}

function findRunningModelReentryTask(chatStore, agentId, sessionId) {
  if (!chatStore || !agentId || !sessionId) return null;
  const tasksById = chatStore.yeaftActiveTasksBySession?.[`${agentId}\u001f${sessionId}`];
  if (!tasksById || typeof tasksById !== 'object') return null;
  for (const task of Object.values(tasksById)) {
    if (task?.status === 'running' && (task.resultDelivery === 'model_reentry' || task.kind === 'sub_agent')) {
      return task;
    }
  }
  return null;
}

function resolveRunningStatusText(chatStore, {
  agentId,
  sessionId,
  isYeaft,
  convId,
  activeTurnIds,
  msgInfo,
  runningTask,
  isEn,
  t,
}) {
  // 1. Live executing tool name (highest precision)
  let runningToolName = '';
  if (isYeaft) {
    let newestToolTs = -1;
    for (const entry of Object.values(chatStore?.yeaftLiveToolExecutions || {})) {
      if (!entry || entry.agentId !== agentId || entry.sessionId !== sessionId) continue;
      if (convId && entry.conversationId && entry.conversationId !== convId) continue;
      if (activeTurnIds?.size > 0 && entry.turnId && !activeTurnIds.has(entry.turnId)) continue;
      for (const tool of (entry.tools || [])) {
        if (!tool || tool.hasResult || !tool.toolName || INLINE_TOOL_NAMES.has(tool.toolName)) continue;
        const ts = parseMs(tool.startTime);
        if (ts >= newestToolTs) {
          newestToolTs = ts;
          runningToolName = tool.toolName;
        }
      }
    }
  } else if (convId) {
    runningToolName = chatStore?.executionStatusMap?.[convId]?.currentTool?.name || '';
  }
  if (!runningToolName && msgInfo?.latestRunningToolName) {
    runningToolName = msgInfo.latestRunningToolName;
  }
  if (runningToolName) {
    return translateSignal(t, isEn, 'cosmos.signals.stageToolNamed', { tool: runningToolName }, 'Running {tool}…', '正在调用 {tool}…');
  }

  // 2. Live execution phase from queryProgress / vpStatuses / session_turns
  if (isYeaft) {
    const observedStates = new Set();
    for (const row of Object.values(chatStore?.yeaftQueryProgressByTurn || {})) {
      const progress = row?.progress;
      if (!progress || row.agentId !== agentId || progress.sessionId !== sessionId) continue;
      if (activeTurnIds?.size > 0 && progress.turnId && !activeTurnIds.has(progress.turnId)) continue;
      if (progress.waitingStage) observedStates.add(progress.waitingStage);
    }
    for (const status of Object.values(chatStore?.vpStatuses || {})) {
      if (!matchesScopedRuntimeRow(status, agentId, sessionId)) continue;
      if (Array.isArray(status.threads)) {
        for (const thread of status.threads) {
          const st = thread?.state || thread?.status;
          if (YEAFT_RUNNING_VP_STATES.has(st)) observedStates.add(st);
        }
      } else if (YEAFT_RUNNING_VP_STATES.has(status.state)) {
        observedStates.add(status.state);
      }
    }
    const sessionKey = yeaftSessionIdentityKey(agentId, sessionId);
    const turns = sessionKey ? (chatStore?.yeaftSessionTurnsBySession?.[sessionKey]?.turns || []) : [];
    for (const turn of turns) {
      if (!LIVE_SESSION_TURN_STATES.has(turn?.state)) continue;
      observedStates.add(turn.state);
      for (const exec of (turn.executions || [])) {
        if (LIVE_SESSION_TURN_STATES.has(exec?.state)) observedStates.add(exec.state);
      }
    }

    const best = RUNNING_STATE_PRIORITY.find((candidate) => observedStates.has(candidate)) || '';
    if (best === 'cancelling') return translateSignal(t, isEn, 'cosmos.signals.stageStopping', null, 'Stopping…', '正在停止…');
    if (best === 'retrying') return translateSignal(t, isEn, 'cosmos.signals.stageRetrying', null, 'Retrying…', '重试连接中…');
    if (best === 'tool') return translateSignal(t, isEn, 'cosmos.signals.stageTool', null, 'Running tools…', '正在执行工具…');
    if (best === 'background_task') return translateSignal(t, isEn, 'cosmos.signals.stageWaitingTask', null, 'Waiting for background task…', '等待后台任务…');
    if (best === 'streaming' || best === 'typing') return translateSignal(t, isEn, 'cosmos.signals.stageStreaming', null, 'Responding…', '正在生成回复…');
    if (best === 'thinking' || best === 'provider') return translateSignal(t, isEn, 'cosmos.signals.stageThinking', null, 'Thinking…', '正在思考…');
    if (best === 'routing' || best === 'queued' || best === 'preparing') return translateSignal(t, isEn, 'cosmos.signals.stageQueued', null, 'Queued…', '排队处理中…');
  }

  // 3. Running background sub-agent / model_reentry task
  if (runningTask) {
    const taskTitle = typeof runningTask.title === 'string' ? runningTask.title.trim() : '';
    if (taskTitle) {
      return translateSignal(t, isEn, 'cosmos.signals.stageSubAgentNamed', { name: taskTitle }, 'Sub-agent "{name}" running…', '子任务「{name}」执行中…');
    }
    return translateSignal(t, isEn, 'cosmos.signals.stageSubAgent', null, 'Sub-agent running…', '子任务执行中…');
  }

  return translateSignal(t, isEn, 'cosmos.panel.runningFallback', null, 'Working…', '执行中…');
}

function buildSessionProjectLookup(projects) {
  const rows = Array.isArray(projects) ? projects : [];
  const tree = buildProjectTree(rows);
  const bySessionKey = new Map();
  for (const project of rows) {
    if (!project?.id) continue;
    const pathLabel = tree.pathOf(project.id).map((item) => item.name).filter(Boolean).join(' / ') || project.name || '';
    const members = Array.isArray(project.members)
      ? project.members
      : (project.agentId
          ? (project.sessionIds || []).map((sessionId) => ({ agentId: project.agentId, sessionId }))
          : []);
    for (const member of members) {
      if (member?.agentId && member?.sessionId) {
        bySessionKey.set(`${member.agentId}\u001f${member.sessionId}`, {
          project,
          pathLabel,
        });
      }
    }
  }
  return { tree, bySessionKey };
}

/**
 * Flatten a planet's sessions into a collapsible Project folder tree + ungrouped sessions.
 */
export function buildCosmosProjectSessionTree(projects, sessions, collapsedIds = new Set()) {
  const list = Array.isArray(sessions) ? sessions : [];
  const { tree, bySessionKey } = buildSessionProjectLookup(projects);
  const rowsByProject = new Map();
  const ungrouped = [];

  for (const session of list) {
    const entry = session?.runtimeProvider === 'yeaft'
      ? bySessionKey.get(`${session.agentId}\u001f${session.id}`)
      : null;
    if (entry?.project?.id) {
      const pid = entry.project.id;
      if (!rowsByProject.has(pid)) rowsByProject.set(pid, []);
      rowsByProject.get(pid).push(session);
    } else {
      ungrouped.push(session);
    }
  }

  const subtreeStats = new Map();
  const computeStats = (projectId) => {
    const direct = rowsByProject.get(projectId) || [];
    let count = direct.length;
    let hasWaiting = direct.some((s) => s.status === 'waiting');
    let hasRunning = direct.some((s) => s.status === 'running');
    for (const child of tree.childrenOf(projectId)) {
      const cs = computeStats(child.id);
      count += cs.count;
      hasWaiting = hasWaiting || cs.hasWaiting;
      hasRunning = hasRunning || cs.hasRunning;
    }
    const stat = { count, hasWaiting, hasRunning };
    subtreeStats.set(projectId, stat);
    return stat;
  };
  for (const root of tree.childrenOf(null)) computeStats(root.id);

  const items = [];
  const visit = (parentId, depth) => {
    for (const project of tree.childrenOf(parentId)) {
      const stats = subtreeStats.get(project.id);
      if (!stats || stats.count === 0) continue;
      const collapsed = collapsedIds.has(project.id);
      items.push({
        kind: 'folder',
        key: `folder:${project.id}`,
        project,
        pathLabel: tree.pathOf(project.id).map((p) => p.name).filter(Boolean).join(' / ') || project.name,
        depth,
        collapsed,
        count: stats.count,
        status: stats.hasWaiting ? 'waiting' : (stats.hasRunning ? 'running' : 'done'),
      });
      if (collapsed) continue;
      visit(project.id, depth + 1);
      for (const session of (rowsByProject.get(project.id) || [])) {
        items.push({
          kind: 'session',
          key: session.catalogKey || `${session.agentId}:${session.id}`,
          session,
          project,
          depth: depth + 1,
        });
      }
    }
  };
  visit(null, 0);

  const hasFolders = items.length > 0;
  ungrouped.forEach((session, idx) => {
    items.push({
      kind: 'session',
      key: session.catalogKey || `${session.agentId}:${session.id}`,
      session,
      project: null,
      depth: 0,
      groupStart: hasFolders && idx === 0,
    });
  });

  return { items, hasFolders, tree };
}

/**
 * Instant multi-token local filter across all Agents' sessions by title, Project path, Agent name, or snippet.
 */
export function filterCosmosSessions(allAgents, query, { planetLabelByAgentId = {} } = {}) {
  const trimmed = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!trimmed) return [];
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const agent of (Array.isArray(allAgents) ? allAgents : [])) {
    const agentName = String(agent?.name || agent?.id || '').toLowerCase();
    const planetName = String(planetLabelByAgentId[agent?.id] || '').toLowerCase();
    for (const session of (agent?.sessions || [])) {
      const title = String(session?.title || '').toLowerCase();
      const projectPath = String(session?.projectPath || session?.projectName || '').toLowerCase();
      const summary = String(session?.summary || '').toLowerCase();
      const workDir = String(session?.workDir || '').toLowerCase();
      const haystack = `${title}\n${projectPath}\n${agentName}\n${planetName}\n${workDir}\n${summary}`;
      if (!tokens.every((tok) => haystack.includes(tok))) continue;

      let rank = 4;
      if (title === trimmed) rank = 0;
      else if (title.startsWith(trimmed)) rank = 1;
      else if (tokens.every((tok) => title.includes(tok))) rank = 2;
      else if (projectPath && tokens.every((tok) => projectPath.includes(tok) || title.includes(tok))) rank = 3;

      scored.push({
        agent,
        session,
        rank,
        statusRank: session.status === 'waiting' ? 0 : (session.status === 'running' ? 1 : 2),
        updatedAt: session.updatedAt || 0,
      });
    }
  }

  scored.sort((a, b) => (
    a.rank - b.rank
    || a.statusRank - b.statusRank
    || b.updatedAt - a.updatedAt
    || String(a.session.catalogKey || '').localeCompare(String(b.session.catalogKey || ''))
  ));

  return scored.map(({ agent, session }) => ({ agent, session, snippet: '' }));
}

function parseMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val) {
    const ms = Date.parse(val);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

export function formatRelativeTime(ts, nowMs = Date.now(), isEn = false) {
  const ms = parseMs(ts);
  if (!ms) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (diffSec < 45) return isEn ? 'now' : '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return isEn ? `${diffMin}m` : `${diffMin}m前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return isEn ? `${diffHr}h` : `${diffHr}h前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return isEn ? '1d' : '昨天';
  return isEn ? `${diffDay}d` : `${diffDay}天前`;
}

function inspectLoadedMessages(messages, sessionId, { activeTurnIds = null, isProcessing = false } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      hasPendingAsk: false,
      askQuestion: '',
      askRequestId: '',
      askTurnId: '',
      askAt: 0,
      seenUserMessage: false,
      latestRunningToolName: '',
      currentTurnAssistantSnippet: '',
      currentTurnAssistantAt: 0,
      currentTurnAssistantTurnId: '',
      liveTurnAssistantSnippet: '',
      liveTurnAssistantAt: 0,
      liveTurnAssistantTurnId: '',
      liveTurnAssistantStreaming: false,
      latestAssistantSnippet: '',
      latestAssistantAt: 0,
      latestAssistantTurnId: '',
      latestUserSnippet: '',
      latestUserAt: 0,
      latestSnippet: '',
      latestAt: 0,
    };
  }
  let hasPendingAsk = false;
  let askQuestion = '';
  let askRequestId = '';
  let askTurnId = '';
  let askAt = 0;
  let seenUserMessage = false;
  let latestRunningToolName = '';
  let currentTurnAssistantSnippet = '';
  let currentTurnAssistantAt = 0;
  let currentTurnAssistantTurnId = '';
  let liveTurnAssistantSnippet = '';
  let liveTurnAssistantAt = 0;
  let liveTurnAssistantTurnId = '';
  let liveTurnAssistantStreaming = false;
  let latestAssistantSnippet = '';
  let latestAssistantAt = 0;
  let latestAssistantTurnId = '';
  let latestUserSnippet = '';
  let latestUserAt = 0;
  const hasActiveTurnFilter = Boolean(activeTurnIds && activeTurnIds.size > 0);

  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (!row) continue;
    const rowSessionId = row.sessionId ?? row.groupId ?? '';
    if (sessionId && rowSessionId !== sessionId) continue;

    if (!hasPendingAsk && row.type === 'tool-use'
      && (row.toolName === 'AskUser' || row.toolName === 'AskUserQuestion')
      && !row.askAnswered && !row.askExpired) {
      hasPendingAsk = true;
      const qs = row.toolInput?.questions || row.askQuestions;
      const firstQ = Array.isArray(qs) && qs[0]?.question ? qs[0].question : (row.toolInput?.question || '');
      askQuestion = stripMarkdownPreview(firstQ);
      askRequestId = row.askRequestId || row.toolId || row.id || '';
      askTurnId = row.turnId || '';
      askAt = parseMs(row.askCreatedAt || row.timestamp || row.createdAt);
    }

    if (isProcessing && !latestRunningToolName && !seenUserMessage
      && row.type === 'tool-use' && !row.hasResult && !row.isHistory
      && row.toolName && !INLINE_TOOL_NAMES.has(row.toolName)) {
      if (!hasActiveTurnFilter || !row.turnId || activeTurnIds.has(row.turnId)) {
        latestRunningToolName = row.toolName;
      }
    }

    if (row.type === 'user') {
      const text = row.content || row.text || '';
      const cleaned = stripMarkdownPreview(text);
      const hasAttachments = Array.isArray(row.attachments) && row.attachments.length > 0;
      if (cleaned || hasAttachments) {
        seenUserMessage = true;
        if (!latestUserSnippet) {
          latestUserSnippet = cleaned || '(attached files)';
          latestUserAt = parseMs(row.timestamp || row.createdAt);
        }
      }
    }

    if (row.type === 'assistant') {
      const text = row.presentation?.summary || row.content || row.text || '';
      const cleaned = stripMarkdownPreview(text);
      if (cleaned) {
        const rowAt = parseMs(row.turnEndAt || row.timestamp || row.createdAt);
        const rowTurnId = row.turnId || '';
        if (!latestAssistantSnippet) {
          latestAssistantSnippet = cleaned;
          latestAssistantAt = rowAt;
          latestAssistantTurnId = rowTurnId;
        }
        // Only assistant rows AFTER the latest user message can be the response to the current turn.
        if (!seenUserMessage && !currentTurnAssistantSnippet) {
          currentTurnAssistantSnippet = cleaned;
          currentTurnAssistantAt = rowAt;
          currentTurnAssistantTurnId = rowTurnId;
        }
        // While processing, only accept assistant rows that actually belong to an active turn.
        if (isProcessing && !liveTurnAssistantSnippet) {
          const isTerminalOrHistory = row.isHistory === true || TERMINAL_ASSISTANT_STATUSES.has(row.status);
          const belongsToActiveTurn = hasActiveTurnFilter
            ? (rowTurnId ? activeTurnIds.has(rowTurnId) : (!seenUserMessage && !isTerminalOrHistory))
            : (!seenUserMessage && !isTerminalOrHistory);
          if (belongsToActiveTurn) {
            liveTurnAssistantSnippet = cleaned;
            liveTurnAssistantAt = rowAt;
            liveTurnAssistantTurnId = rowTurnId;
            liveTurnAssistantStreaming = row.isStreaming === true;
          }
        }
      }
    }

    if (hasPendingAsk && latestAssistantSnippet && latestUserSnippet
      && (!isProcessing || liveTurnAssistantSnippet || !hasActiveTurnFilter)) break;
  }

  const latestSnippet = currentTurnAssistantSnippet || latestAssistantSnippet || latestUserSnippet;
  const latestAt = Math.max(latestAssistantAt, latestUserAt, askAt);
  return {
    hasPendingAsk,
    askQuestion,
    askRequestId,
    askTurnId,
    askAt,
    seenUserMessage,
    latestRunningToolName,
    currentTurnAssistantSnippet,
    currentTurnAssistantAt,
    currentTurnAssistantTurnId,
    liveTurnAssistantSnippet,
    liveTurnAssistantAt,
    liveTurnAssistantTurnId,
    liveTurnAssistantStreaming,
    latestAssistantSnippet,
    latestAssistantAt,
    latestAssistantTurnId,
    latestUserSnippet,
    latestUserAt,
    latestSnippet,
    latestAt,
  };
}

/**
 * Project every Agent in `chatStore.agents` with its real sessions, live status and snippets.
 */
export function projectAgentsForCosmos({ chatStore, sessionsStore, nowMs = Date.now(), isEn = false, t = null }) {
  const agents = Array.isArray(chatStore?.agents) ? chatStore.agents : [];
  const hasSidebarCatalog = Array.isArray(chatStore?.sidebarSessionCatalog);
  const catalog = hasSidebarCatalog
    ? chatStore.sidebarSessionCatalog
    : (Array.isArray(chatStore?.sessionCatalog) ? chatStore.sessionCatalog : []);
  const hiddenCatalog = Array.isArray(chatStore?.hiddenSessionCatalog) ? chatStore.hiddenSessionCatalog : [];
  const hiddenNativeKeys = new Set();
  for (const row of hiddenCatalog) {
    const ref = row?.routeRef;
    if (ref?.runtimeProvider === 'yeaft' && ref.agentId && ref.sessionId) {
      hiddenNativeKeys.add(`${ref.agentId}\u001f${ref.sessionId}`);
    }
  }
  const isLegacyCatalogMode = chatStore?.sessionCatalogProtocolSupported === false;
  const legacyInventoryAccepted = isLegacyCatalogMode
    && legacySidebarCatalogReady(chatStore)
    && chatStore?.sidebarSessionCatalogLoading !== true;
  const catalogAuthoritative = hasSidebarCatalog
    || chatStore?.sessionCatalogProtocolSupported === true
    || (isLegacyCatalogMode && !legacyInventoryAccepted)
    || chatStore?.sessionCatalogLoaded === true
    || hiddenCatalog.length > 0;
  const singleLegacyAgentId = legacyInventoryAccepted
    && agents.length === 1
    && agents[0]?.id
    && (!chatStore?.currentAgent || chatStore.currentAgent === agents[0].id)
    ? agents[0].id
    : '';
  const yeaftSessions = Array.isArray(sessionsStore?.sessionList)
    ? sessionsStore.sessionList
    : Object.values(sessionsStore?.sessions || {});
  const convIdByAgent = chatStore?.yeaftConversationIdsByAgent || {};
  const messagesMap = chatStore?.messagesMap || {};
  const replyPreviewByKey = chatStore?.yeaftSessionReplyPreviewByKey || {};
  const scheduledTaskNoticesBySession = new Map();
  for (const notice of (Array.isArray(chatStore?.scheduledTaskNotifications) ? chatStore.scheduledTaskNotifications : [])) {
    if (!notice?.agentId || !notice?.sessionId) continue;
    const sk = `${notice.agentId}\u001f${notice.sessionId}`;
    const prev = scheduledTaskNoticesBySession.get(sk);
    if (!prev || parseMs(notice.createdAt) >= parseMs(prev.createdAt)) {
      scheduledTaskNoticesBySession.set(sk, notice);
    }
  }

  const runningFallback = t ? t('cosmos.panel.runningFallback') : 'Working…';
  const waitingFallback = t ? t('cosmos.panel.waitingFallback') : 'Waiting for input';
  const { bySessionKey: projectBySessionKey } = buildSessionProjectLookup(chatStore?.sessionProjects || []);

  // Index sessionsStore details by `${agentId}\u001f${sessionId}`
  const detailByKey = new Map();
  for (const s of yeaftSessions) {
    if (!s?.id) continue;
    const aid = s.agentId || singleLegacyAgentId;
    if (aid) detailByKey.set(`${aid}\u001f${s.id}`, s);
  }

  const byAgentId = {};

  for (const agent of agents) {
    if (!agent?.id) continue;
    const agentId = agent.id;
    const online = agent.online === true;
    const convId = convIdByAgent[agentId] || null;
    const loadedMsgs = convId ? messagesMap[convId] : null;

    const mergedMap = new Map();

    // 1. Pull visible catalog rows owned by this Agent (Yeaft + CLI)
    for (const row of catalog) {
      if (row?.hidden === true) continue;
      const ref = row?.routeRef;
      if (!ref || ref.agentId !== agentId || !ref.sessionId) continue;
      if (ref.runtimeProvider === 'yeaft' && hiddenNativeKeys.has(`${agentId}\u001f${ref.sessionId}`)) continue;
      const key = `${ref.runtimeProvider}:${ref.sessionId}`;
      mergedMap.set(key, {
        id: ref.sessionId,
        agentId,
        runtimeProvider: ref.runtimeProvider,
        catalogKey: row.catalogKey,
        routeRef: ref,
        title: row.title || ref.sessionId,
        workDir: row.workDir || agent.workDir || '',
        updatedAt: parseMs(row.metadataUpdatedAt || row.createdAt),
        descriptor: row,
      });
    }

    // 2. Enrich visible native Yeaft rows from live sessionsStore.
    //    Keep sidebar/server catalog membership authoritative; only admit omitted
    //    ownerless rows (agentId == null) for an unambiguous single Agent once
    //    legacy inventory readiness and identity checks pass.
    for (const s of yeaftSessions) {
      if (!s?.id || s.hidden === true) continue;
      const isOwnerlessLegacyRow = !s.agentId && Boolean(singleLegacyAgentId);
      const ownerAgentId = s.agentId || singleLegacyAgentId;
      if (!ownerAgentId || ownerAgentId !== agentId) continue;
      if (hiddenNativeKeys.has(`${agentId}\u001f${s.id}`)) continue;
      const key = `yeaft:${s.id}`;
      const existing = mergedMap.get(key);
      if (catalogAuthoritative && !existing && !isOwnerlessLegacyRow) continue;
      const updatedMs = Math.max(
        existing?.updatedAt || 0,
        parseMs(s.latestActivityAt),
        parseMs(s.lastMessageAt),
        parseMs(s.updatedAt),
        parseMs(s.createdAt),
      );
      mergedMap.set(key, {
        id: s.id,
        agentId,
        runtimeProvider: 'yeaft',
        catalogKey: existing?.catalogKey || `yeaft:${agentId}:${s.id}`,
        routeRef: existing?.routeRef || { runtimeProvider: 'yeaft', agentId, sessionId: s.id },
        title: s.name || existing?.title || s.id,
        workDir: s.workDir || existing?.workDir || agent.workDir || '',
        updatedAt: updatedMs,
        descriptor: existing?.descriptor || {
          catalogKey: `yeaft:${agentId}:${s.id}`,
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: s.id },
          title: s.name || s.id,
          workDir: s.workDir || agent.workDir || '',
        },
        sessionDetail: s,
      });
    }

    const sessions = Array.from(mergedMap.values()).map((item) => {
      const detail = item.sessionDetail || detailByKey.get(`${agentId}\u001f${item.id}`) || null;
      const isYeaft = item.runtimeProvider === 'yeaft';
      const scheduledNotice = isYeaft
        ? (scheduledTaskNoticesBySession.get(`${agentId}\u001f${item.id}`) || null)
        : null;
      const isUnread = isYeaft
        ? Boolean(chatStore?.isYeaftSessionUnread?.(item.id, agentId) || scheduledNotice)
        : false;
      const hasRuntimeTruth = isYeaft && hasAuthoritativeYeaftRuntime(chatStore, agentId, item.id);
      const runningModelReentryTask = isYeaft ? findRunningModelReentryTask(chatStore, agentId, item.id) : null;
      const isVpProcessing = isYeaft
        ? Boolean(
          chatStore?.isYeaftSessionProcessing?.(item.id, agentId)
          || (!hasRuntimeTruth && (detail?.running || detail?.runningVpCount > 0)),
        )
        : Boolean(chatStore?.processingConversations?.[item.id]);
      const isProcessing = isVpProcessing || Boolean(runningModelReentryTask && !isUnread);
      const activeTurnIds = isYeaft && isProcessing
        ? collectActiveYeaftTurnIds(chatStore, agentId, item.id)
        : new Set();

      const msgInfo = isYeaft
        ? inspectLoadedMessages(loadedMsgs, item.id, { activeTurnIds, isProcessing })
        : inspectLoadedMessages(messagesMap[item.id], null, { isProcessing });
      const cachedPreview = isYeaft ? (replyPreviewByKey[item.catalogKey] || null) : null;

      const cachedAskExpiresAt = parseMs(cachedPreview?.askExpiresAt);
      const cachedAskValid = Boolean(cachedPreview?.askQuestion)
        && !(cachedAskExpiresAt > 0 && nowMs >= cachedAskExpiresAt);
      const hasPendingAsk = msgInfo.hasPendingAsk || cachedAskValid;
      const askQuestion = msgInfo.askQuestion || (cachedAskValid ? cachedPreview.askQuestion : '');
      const askRequestId = msgInfo.askRequestId || (cachedAskValid ? (cachedPreview.askRequestId || '') : '');
      const askTurnId = msgInfo.askTurnId || (cachedAskValid ? (cachedPreview.askTurnId || '') : '');

      // Live preview strictly for the currently executing turn (never bleeds prior-turn responses).
      let liveReplyPreview = '';
      let liveReplyAt = 0;
      if (isProcessing) {
        const cachedLiveText = isYeaft ? (cachedPreview?.liveText || '') : '';
        const cachedLiveMatchesTurn = !cachedPreview?.liveTurnId
          || activeTurnIds.size === 0
          || activeTurnIds.has(cachedPreview.liveTurnId);
        const validCachedLive = cachedLiveText && cachedLiveMatchesTurn ? cachedLiveText : '';
        const cachedLiveAt = validCachedLive ? parseMs(cachedPreview?.liveAt || cachedPreview?.updatedAt) : 0;
        const msgLiveStaleUntagged = Boolean(
          isYeaft
          && cachedPreview?.inFlight
          && !validCachedLive
          && !msgInfo.liveTurnAssistantTurnId
          && !msgInfo.liveTurnAssistantStreaming,
        );
        const validMsgLive = msgLiveStaleUntagged ? '' : msgInfo.liveTurnAssistantSnippet;
        const msgLiveAt = validMsgLive ? msgInfo.liveTurnAssistantAt : 0;
        const useCachedLive = Boolean(validCachedLive) && (!validMsgLive || cachedLiveAt >= msgLiveAt);
        liveReplyPreview = useCachedLive ? validCachedLive : validMsgLive;
        liveReplyAt = useCachedLive ? cachedLiveAt : msgLiveAt;
      }

      // Finished/unread reply preview (strictly for the latest turn, never showing a pre-user older turn).
      let replyPreview = '';
      let replyAt = 0;
      const emptyTurnBlocksMsg = Boolean(
        isYeaft
        && cachedPreview?.finalizedEmptyTurnId
        && (
          !msgInfo.currentTurnAssistantSnippet
          || (msgInfo.currentTurnAssistantTurnId && msgInfo.currentTurnAssistantTurnId !== cachedPreview.finalizedEmptyTurnId)
          || (!msgInfo.currentTurnAssistantTurnId && parseMs(cachedPreview?.at) >= msgInfo.currentTurnAssistantAt)
        ),
      );
      if (isProcessing) {
        replyPreview = liveReplyPreview;
        replyAt = liveReplyAt;
      } else if (emptyTurnBlocksMsg) {
        replyPreview = '';
        replyAt = parseMs(cachedPreview?.at);
      } else {
        const cachedReplyText = cachedPreview?.text || '';
        const cachedReplyAt = parseMs(cachedPreview?.at);
        const cachedBelongsToPriorTurn = Boolean(
          msgInfo.seenUserMessage
          && !msgInfo.currentTurnAssistantSnippet
          && (
            (cachedPreview?.turnId && msgInfo.latestAssistantTurnId && cachedPreview.turnId === msgInfo.latestAssistantTurnId)
            || (cachedPreview?.inFlight && !cachedPreview?.liveText)
            || (msgInfo.latestUserAt > 0 && cachedReplyAt > 0 && cachedReplyAt < msgInfo.latestUserAt)
          ),
        );
        const validCachedReply = cachedReplyText && !cachedBelongsToPriorTurn ? cachedReplyText : '';
        const msgReply = msgInfo.currentTurnAssistantSnippet;
        const useCachedReply = Boolean(validCachedReply)
          && (!msgReply || cachedReplyAt >= msgInfo.currentTurnAssistantAt);
        replyPreview = useCachedReply ? validCachedReply : msgReply;
        replyAt = useCachedReply ? cachedReplyAt : msgInfo.currentTurnAssistantAt;
      }

      const runningStatusText = isProcessing
        ? resolveRunningStatusText(chatStore, {
          agentId,
          sessionId: item.id,
          isYeaft,
          convId: isYeaft ? convId : item.id,
          activeTurnIds,
          msgInfo,
          runningTask: runningModelReentryTask,
          isEn,
          t,
        })
        : '';

      const status = hasPendingAsk ? 'waiting' : (isProcessing ? 'running' : 'done');
      const updatedMs = Math.max(
        item.updatedAt,
        msgInfo.latestAt,
        replyAt,
        parseMs(cachedPreview?.askAt),
        parseMs(scheduledNotice?.createdAt),
      );
      const snippet = hasPendingAsk
        ? (askQuestion || waitingFallback)
        : (isProcessing
          ? (liveReplyPreview || runningStatusText || runningFallback)
          : (replyPreview
            || msgInfo.latestSnippet
            || (shortenPath(item.workDir || '') || item.title)));

      const projectEntry = isYeaft
        ? projectBySessionKey.get(`${agentId}\u001f${item.id}`) || null
        : null;

      return {
        ...item,
        status,
        unread: isUnread,
        updatedAt: updatedMs,
        updatedLabel: formatRelativeTime(updatedMs, nowMs, isEn),
        summary: snippet,
        replyPreview,
        replyAt,
        liveReplyPreview,
        runningStatusText,
        askQuestion,
        askRequestId,
        askTurnId,
        scheduledNotice,
        sceneId: detail?.sceneId || null,
        projectId: projectEntry?.project?.id || null,
        projectName: projectEntry?.project?.name || '',
        projectPath: projectEntry?.pathLabel || '',
      };
    });

    const rank = { waiting: 0, running: 1, done: 2 };
    sessions.sort((a, b) => {
      const ra = rank[a.status] ?? 2;
      const rb = rank[b.status] ?? 2;
      if (ra !== rb) return ra - rb;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const liveSessions = sessions.filter((s) => s.status === 'waiting' || s.status === 'running');
    const unreadSessions = sessions.filter((s) => s.unread && s.status !== 'waiting' && s.status !== 'running');
    const attentionCount = sessions.filter((s) => s.status === 'waiting' || (s.unread && s.status !== 'running')).length;
    const hasWaiting = liveSessions.some((s) => s.status === 'waiting');
    const hasRunning = liveSessions.some((s) => s.status === 'running');
    const status = !online ? 'offline' : (hasWaiting ? 'waiting' : (hasRunning ? 'running' : 'idle'));

    byAgentId[agentId] = {
      id: agentId,
      name: agent.name || agentId,
      online,
      status,
      workDir: agent.workDir || '',
      folder: shortenPath(agent.workDir || ''),
      capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
      supportsAutoRoute: Array.isArray(agent.capabilities) && agent.capabilities.includes('session_auto_route'),
      sessions,
      liveSessions,
      unreadSessions,
      unreadCount: unreadSessions.length,
      attentionCount,
      hasUnread: unreadSessions.length > 0,
      raw: agent,
    };
  }

  return byAgentId;
}
