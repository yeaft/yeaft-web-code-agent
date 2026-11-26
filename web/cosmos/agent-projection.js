/**
 * Yeaft Cosmos — Real-Time Agent & Session State Projection
 *
 * Projects live Pinia `chatStore` + `sessionsStore` data into per-Agent planetary telemetry:
 * - Online / Running / Waiting (AskUser) / Idle / Offline status
 * - Ordered session list with compact 2~3 line preview snippets from loaded transcripts
 * - Relative timestamps for orbit micro-lists and hover cards
 */
import { shortenPath } from '../utils/path-display.js';

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
  const catalog = Array.isArray(chatStore?.sessionCatalog) ? chatStore.sessionCatalog : [];
  const yeaftSessions = Array.isArray(sessionsStore?.sessionList)
    ? sessionsStore.sessionList
    : Object.values(sessionsStore?.sessions || {});
  const convIdByAgent = chatStore?.yeaftConversationIdsByAgent || {};
  const messagesMap = chatStore?.messagesMap || {};

  const runningFallback = t ? t('cosmos.panel.runningFallback') : 'Working…';
  const waitingFallback = t ? t('cosmos.panel.waitingFallback') : 'Waiting for input';

  // Index sessionsStore details by `${agentId}\u001f${sessionId}`
  const detailByKey = new Map();
  for (const s of yeaftSessions) {
    if (!s?.id) continue;
    const aid = s.agentId || chatStore?.currentAgent || '';
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

    // 1. Pull catalog rows owned by this Agent (Yeaft + CLI)
    for (const row of catalog) {
      const ref = row?.routeRef;
      if (!ref || ref.agentId !== agentId || !ref.sessionId) continue;
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

    // 2. Merge live sessionsStore details for native Yeaft sessions
    for (const s of yeaftSessions) {
      if (!s?.id || (s.agentId && s.agentId !== agentId)) continue;
      if (!s.agentId && agentId !== chatStore?.currentAgent) continue;
      const key = `yeaft:${s.id}`;
      const existing = mergedMap.get(key);
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

      return {
        ...item,
        status,
        unread: isUnread,
        updatedAt: updatedMs,
        updatedLabel: formatRelativeTime(updatedMs, nowMs, isEn),
        summary: snippet,
        sceneId: detail?.sceneId || null,
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
