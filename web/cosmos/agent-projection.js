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

function stripMarkdownPreview(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
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

function inspectLoadedMessages(messages, sessionId) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { hasPendingAsk: false, askQuestion: '', latestSnippet: '', latestAt: 0 };
  }
  let hasPendingAsk = false;
  let askQuestion = '';
  let latestSnippet = '';
  let latestAt = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (!row) continue;
    if (sessionId && row.sessionId && row.sessionId !== sessionId) continue;

    if (!hasPendingAsk && row.type === 'tool-use'
      && (row.toolName === 'AskUser' || row.toolName === 'AskUserQuestion')
      && !row.askAnswered && !row.askExpired) {
      hasPendingAsk = true;
      const qs = row.toolInput?.questions;
      const firstQ = Array.isArray(qs) && qs[0]?.question ? qs[0].question : (row.toolInput?.question || '');
      askQuestion = stripMarkdownPreview(firstQ);
    }

    if (!latestSnippet) {
      if (row.type === 'assistant' || row.type === 'user') {
        const text = row.presentation?.summary || row.content || row.text || '';
        const cleaned = stripMarkdownPreview(text);
        if (cleaned) {
          latestSnippet = cleaned;
          latestAt = parseMs(row.timestamp || row.createdAt);
        }
      }
    }

    if (hasPendingAsk && latestSnippet) break;
  }

  return { hasPendingAsk, askQuestion, latestSnippet, latestAt };
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
  const catalogAuthoritative = !isLegacyCatalogMode && (
    hasSidebarCatalog
    || chatStore?.sessionCatalogProtocolSupported === true
    || chatStore?.sessionCatalogLoaded === true
    || hiddenCatalog.length > 0
  );
  const singleLegacyAgentId = !catalogAuthoritative
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

    // 2. Enrich visible native Yeaft rows from live sessionsStore;
    //    never resurrect hidden/absent sessions when the visible catalog is authoritative.
    //    On the legacy single-Agent path, ownerless rows (agentId == null) still project
    //    unambiguously onto that single Agent.
    for (const s of yeaftSessions) {
      if (!s?.id || s.hidden === true) continue;
      const ownerAgentId = s.agentId || singleLegacyAgentId;
      if (!ownerAgentId || ownerAgentId !== agentId) continue;
      if (hiddenNativeKeys.has(`${agentId}\u001f${s.id}`)) continue;
      const key = `yeaft:${s.id}`;
      const existing = mergedMap.get(key);
      if (catalogAuthoritative && !existing) continue;
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
      const isProcessing = isYeaft
        ? Boolean(chatStore?.isYeaftSessionProcessing?.(item.id, agentId) || detail?.running || detail?.runningVpCount > 0)
        : Boolean(chatStore?.processingConversations?.[item.id]);
      const isUnread = isYeaft ? Boolean(chatStore?.isYeaftSessionUnread?.(item.id, agentId)) : false;

      const msgInfo = isYeaft
        ? inspectLoadedMessages(loadedMsgs, item.id)
        : inspectLoadedMessages(messagesMap[item.id], null);

      const status = msgInfo.hasPendingAsk ? 'waiting' : (isProcessing ? 'running' : 'done');
      const updatedMs = Math.max(item.updatedAt, msgInfo.latestAt);
      const snippet = msgInfo.hasPendingAsk
        ? (msgInfo.askQuestion || waitingFallback)
        : (msgInfo.latestSnippet || (isProcessing ? runningFallback : (shortenPath(item.workDir || '') || item.title)));

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
      raw: agent,
    };
  }

  return byAgentId;
}
