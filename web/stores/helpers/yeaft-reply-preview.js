/**
 * Lightweight per-Session reply & AskUser preview cache for Yeaft Cosmos Signal Stream
 * and background Session telemetry.
 *
 * Scoped strictly by canonical catalog key (`yeaft:<agentId>:<sessionId>`), bounded
 * to prevent unbounded memory growth, and cleared on turn deletion or logout.
 */

export const MAX_YEAFT_REPLY_PREVIEWS = 160;
const MAX_PREVIEW_CHARS = 280;

export function stripMarkdownPreview(raw, maxLen = MAX_PREVIEW_CHARS) {
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
    .slice(0, maxLen);
}

export function extractLatestAssistantPreview(messages, sessionId, turnId = null) {
  if (!Array.isArray(messages) || messages.length === 0) return { text: '', at: 0 };
  let fallback = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (!row || row.type !== 'assistant') continue;
    const rowSessionId = row.sessionId ?? row.groupId;
    if (sessionId && rowSessionId && rowSessionId !== sessionId) continue;
    const raw = row.presentation?.summary || row.content || row.text || '';
    const cleaned = stripMarkdownPreview(raw);
    if (!cleaned) continue;
    const rawTs = row.turnEndAt || row.timestamp || row.createdAt || 0;
    const at = typeof rawTs === 'number' && Number.isFinite(rawTs)
      ? rawTs
      : (typeof rawTs === 'string' && rawTs ? (Date.parse(rawTs) || 0) : 0);
    if (!turnId || row.turnId === turnId) return { text: cleaned, at };
    if (!fallback) fallback = { text: cleaned, at };
  }
  return fallback || { text: '', at: 0 };
}

export function recordYeaftSessionReplyPreview(store, {
  catalogKey,
  text,
  at = Date.now(),
  kind = 'assistant',
  askQuestion,
  askRequestId = null,
  clearAsk = false,
} = {}) {
  if (!store || !catalogKey) return false;
  const map = store.yeaftSessionReplyPreviewByKey || {};
  const prev = map[catalogKey] || null;
  const cleanedText = typeof text === 'string' ? stripMarkdownPreview(text) : '';
  const cleanedAsk = typeof askQuestion === 'string' ? stripMarkdownPreview(askQuestion) : '';

  if (clearAsk) {
    if (!prev || (!prev.askQuestion && !prev.askRequestId)) return false;
    if (askRequestId && prev.askRequestId && prev.askRequestId !== askRequestId) return false;
    const nextEntry = {
      ...prev,
      askQuestion: '',
      askRequestId: null,
      updatedAt: Date.now(),
    };
    if (!nextEntry.text) {
      const { [catalogKey]: _drop, ...rest } = map;
      store.yeaftSessionReplyPreviewByKey = rest;
      return true;
    }
    store.yeaftSessionReplyPreviewByKey = { ...map, [catalogKey]: nextEntry };
    return true;
  }

  if (!cleanedText && !cleanedAsk) return false;

  const ts = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : Date.now();
  const nextEntry = {
    text: cleanedText || prev?.text || '',
    kind: cleanedText ? kind : (prev?.kind || kind),
    at: cleanedText ? Math.max(ts, prev?.at || 0) : (prev?.at || ts),
    askQuestion: cleanedAsk || prev?.askQuestion || '',
    askRequestId: cleanedAsk ? (askRequestId || prev?.askRequestId || null) : (prev?.askRequestId || null),
    askAt: cleanedAsk ? Math.max(ts, prev?.askAt || 0) : (prev?.askAt || 0),
    updatedAt: Date.now(),
  };

  const nextMap = { ...map, [catalogKey]: nextEntry };
  const keys = Object.keys(nextMap);
  if (keys.length > MAX_YEAFT_REPLY_PREVIEWS) {
    keys.sort((a, b) => (nextMap[a]?.updatedAt || 0) - (nextMap[b]?.updatedAt || 0));
    const excess = keys.length - MAX_YEAFT_REPLY_PREVIEWS;
    for (let i = 0; i < excess; i++) {
      if (keys[i] !== catalogKey) delete nextMap[keys[i]];
    }
  }
  store.yeaftSessionReplyPreviewByKey = nextMap;
  return true;
}

export function clearYeaftSessionReplyPreview(store, catalogKey = null) {
  if (!store) return false;
  if (!catalogKey) {
    if (!store.yeaftSessionReplyPreviewByKey || Object.keys(store.yeaftSessionReplyPreviewByKey).length === 0) {
      return false;
    }
    store.yeaftSessionReplyPreviewByKey = {};
    return true;
  }
  const map = store.yeaftSessionReplyPreviewByKey;
  if (!map || !map[catalogKey]) return false;
  const { [catalogKey]: _removed, ...rest } = map;
  store.yeaftSessionReplyPreviewByKey = rest;
  return true;
}
