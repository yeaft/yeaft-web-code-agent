/**
 * Stable Session list ordering helpers.
 *
 * Selection is UI state. It must not affect list order. The only grouping
 * rule is pinned first, then normal sessions, with each group sorted by the
 * latest real session timestamp descending.
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
export function sessionTimeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * @param {object} session
 * @returns {number}
 */
export function sessionActivityTime(session) {
  if (!session || typeof session !== 'object') return 0;
  return sessionTimeValue(session.lastMessageAt)
    || sessionTimeValue(session.updatedAt)
    || sessionTimeValue(session.createdAt)
    || 0;
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareSessionsByActivity(a, b) {
  const delta = sessionActivityTime(b) - sessionActivityTime(a);
  if (delta !== 0) return delta;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/**
 * @param {Array<object>} sessions
 * @returns {Array<object>}
 */
export function sortSessionsByActivity(sessions) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort(compareSessionsByActivity);
}
