const SESSION_IDENTITY_SEPARATOR = '\u001f';
export const LAST_VIEWED_YEAFT_SESSION_KEY = 'lastViewedYeaftSession';

/**
 * Build the strict runtime identity for a Yeaft Session owned by an Agent.
 * Missing fields are rejected so callers cannot silently fall back to a bare
 * sessionId in cross-Agent state.
 */
export function yeaftSessionIdentityKey(agentId, sessionId) {
  if (!agentId || !sessionId) return '';
  return `${agentId}${SESSION_IDENTITY_SEPARATOR}${sessionId}`;
}

/**
 * Read a persisted Session identity. Values without the separator are legacy
 * bare Session ids and intentionally retain no Agent authority.
 */
export function parseYeaftSessionIdentity(value) {
  const normalized = typeof value === 'string' ? value : String(value || '');
  if (!normalized) return { agentId: null, sessionId: null };
  const separatorIndex = normalized.indexOf(SESSION_IDENTITY_SEPARATOR);
  if (separatorIndex < 0) return { agentId: null, sessionId: normalized };
  const agentId = normalized.slice(0, separatorIndex) || null;
  const sessionId = normalized.slice(separatorIndex + SESSION_IDENTITY_SEPARATOR.length) || null;
  return { agentId, sessionId };
}

export function readLastViewedYeaftSession() {
  try { return parseYeaftSessionIdentity(localStorage.getItem(LAST_VIEWED_YEAFT_SESSION_KEY)); }
  catch { return parseYeaftSessionIdentity(null); }
}

export function yeaftAgentSessionIdentityPrefix(agentId) {
  return agentId ? `${agentId}${SESSION_IDENTITY_SEPARATOR}` : '';
}

export function yeaftTurnIdentityKey(agentId, turnId) {
  if (!agentId || !turnId) return '';
  return `${agentId}${SESSION_IDENTITY_SEPARATOR}${turnId}`;
}

export const sessionExecutionKey = (row) => JSON.stringify([row.speakerVpId || row.vpId, row.turnId || null, row.threadId || 'main']);
