import { sessionActivityTime } from './session-order.js';

/**
 * Helpers for the Yeaft Session sidebar list.
 *
 * Selection is only marked as metadata. It never affects order, otherwise
 * switching sessions makes the list jump. Pinned sessions stay above normal
 * sessions. Manual sort order wins when present; otherwise rows fall back to
 * real session activity time descending.
 */

/**
 * Build the Yeaft sidebar rows with pinned-first stable ordering.
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
      processing: !!session.running || !!session.active || !!session.isRunning || !!session.isActive,
      _manualOrder: Number.isFinite(session.sortOrder) ? session.sortOrder : Number.MAX_SAFE_INTEGER,
      _activityTime: sessionActivityTime(session),
    });
  }

  rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a._manualOrder !== b._manualOrder) return a._manualOrder - b._manualOrder;
    if (a._activityTime !== b._activityTime) return b._activityTime - a._activityTime;

    const aIndex = pinnedIndex.has(a.id) ? pinnedIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = pinnedIndex.has(b.id) ? pinnedIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.id.localeCompare(b.id);
  });

  return rows.map(({ _manualOrder, _activityTime, ...row }) => row);
}
