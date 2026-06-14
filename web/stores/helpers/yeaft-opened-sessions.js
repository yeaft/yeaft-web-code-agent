export const OPENED_YEAFT_SESSIONS_STORAGE_KEY = 'opened-yeaft-sessions';
const MAX_OPENED_YEAFT_SESSIONS = 30;

export function normalizeOpenedYeaftSessionIds(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_OPENED_YEAFT_SESSIONS) break;
  }
  return out;
}

export function readOpenedYeaftSessionIds(storage = globalThis.localStorage) {
  try {
    return normalizeOpenedYeaftSessionIds(storage?.getItem?.(OPENED_YEAFT_SESSIONS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function persistOpenedYeaftSessionIds(ids, storage = globalThis.localStorage) {
  const normalized = normalizeOpenedYeaftSessionIds(ids);
  try {
    storage?.setItem?.(OPENED_YEAFT_SESSIONS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // localStorage can be unavailable in private/SSR contexts; in-memory state still works.
  }
  return normalized;
}

export function addOpenedYeaftSessionId(ids, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return normalizeOpenedYeaftSessionIds(ids);
  const id = sessionId.trim();
  if (!id) return normalizeOpenedYeaftSessionIds(ids);
  return normalizeOpenedYeaftSessionIds([id, ...normalizeOpenedYeaftSessionIds(ids).filter(existing => existing !== id)]);
}

export function removeOpenedYeaftSessionId(ids, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return normalizeOpenedYeaftSessionIds(ids);
  return normalizeOpenedYeaftSessionIds(ids).filter(id => id !== sessionId);
}

export function resolveOpenedYeaftSessionIds({
  openedSessionIds = [],
  activeSessionId = null,
  sessionById = null,
  agentId = null,
} = {}) {
  const candidates = normalizeOpenedYeaftSessionIds([
    ...(activeSessionId ? [activeSessionId] : []),
    ...normalizeOpenedYeaftSessionIds(openedSessionIds),
  ]);
  const out = [];
  for (const id of candidates) {
    const row = typeof sessionById === 'function' ? sessionById(id) : null;
    if (!row) continue;
    if (agentId && row.agentId && row.agentId !== agentId) continue;
    out.push(id);
  }
  return out;
}
