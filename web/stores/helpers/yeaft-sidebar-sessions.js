import { sessionActivityTime } from './session-order.js';

/**
 * Helpers for the Yeaft Session sidebar list.
 *
 * Selection is only marked as metadata. It never affects order, otherwise
 * switching sessions makes the list jump. Pinned sessions stay above normal
 * sessions; both groups are sorted by real session activity time descending.
 *
 * @param {object} params
 * @param {Array<object>} params.sessions
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
      _activityTime: sessionActivityTime(session),
    });
  }

  rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a._activityTime !== b._activityTime) return b._activityTime - a._activityTime;

    const aIndex = pinnedIndex.has(a.id) ? pinnedIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bIndex = pinnedIndex.has(b.id) ? pinnedIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.id.localeCompare(b.id);
  });

  return rows.map(({ _activityTime, ...row }) => row);

  });

  return rows.map(({ _activityTime, ...row }) => row);
}
