/**
 * Helpers for the Yeaft Session sidebar list.
 *
 * The sessions store preserves click/activity order. This helper only adds
 * the visual grouping metadata the sidebar needs: pinned rows first, active
 * rows marked in-place, and non-pinned active rows never crossing above the
 * pinned block.
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function timeValue(value) {
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
function activityTime(session) {
  if (!session || typeof session !== 'object') return 0;
  return timeValue(session.lastMessageAt)
    || timeValue(session.updatedAt)
    || timeValue(session.createdAt)
    || 0;
}

/**
 * Build the Yeaft sidebar rows with Chat-like pinned-first ordering.
 *
 * @param {object} params
 * @param {Array<object>} params.sessions
 * @param {string|null|undefined} params.activeSessionId
 * @param {Array<string>} params.pinnedSessionIds
 * @returns {Array<{kind:string,id:string,raw:object,pinned:boolean,active:boolean}>}
 */
export function buildYeaftSidebarSessionList({ sessions, activeSessionId, pinnedSessionIds } = {}) {
  const activeId = activeSessionId || null;
  const pinnedOrder = Array.isArray(pinnedSessionIds) ? pinnedSessionIds : [];
  const pinnedIndex = new Map();
  pinnedOrder.forEach((id, index) => {
    if (typeof id === 'string' && id && !pinnedIndex.has(id)) pinnedIndex.set(id, index);
  });

  const rows = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || !session.id) continue;
    const id = String(session.id);
    rows.push({
      kind: 'session',
      id,
      raw: session,
      pinned: pinnedIndex.has(id) || !!session.pinned,
      active: id === activeId,
      _activityTime: activityTime(session),
    });
  }

  rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const aIndex = pinnedIndex.has(a.id) ? pinnedIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bIndex = pinnedIndex.has(b.id) ? pinnedIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    if (!a.pinned && !b.pinned) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a._activityTime !== b._activityTime) return b._activityTime - a._activityTime;
    }
    return 0;
  });

  return rows.map(({ _activityTime, ...row }) => row);
}
