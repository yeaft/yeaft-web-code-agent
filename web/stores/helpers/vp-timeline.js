/**
 * vp-timeline.js — left-of-conversation VP list helpers.
 *
 * History:
 *   - PR-3 of feature-pill redesign introduced this file with a
 *     feature-aware status branch.
 *   - PR #767 deleted the Feature system; v0.1.767 restored the helper
 *     without the feature branch — status was then derived in the
 *     browser as `idle | typing | streaming` from `typingVpIds` plus
 *     reverse-inference over `messages[].isStreaming`.
 *   - feat-vp-status-from-agent (2026-05-15): the reverse-inference is
 *     gone. The agent is now the single authoritative source of VP
 *     status via the `vp-status-broker` wire events (see
 *     docs/notes/2026-05-15-vp-status-from-agent.md). This helper now
 *     reads `ctx.vpStatuses[vpId].state` and overlays an `offline`
 *     state when the WebSocket is not `connected`.
 *
 * Pure helpers consumed by VpTimelinePane. Given the already-collected
 * store snapshots (vp roster, vpStatuses map, connectionState), produces
 * an ordered array of TimelineRow objects that the pane renders 1:1.
 *
 * Why pure: same testability story as before — no Vue / Pinia
 * dependency means we can unit-test the row computation without
 * spinning up a DOM. The component stays a thin presentational shell
 * (props down, emit up).
 *
 * Sort policy:
 *   Rows emitted in roster order. Status is a tag, not a sort key —
 *   stable visual as VPs churn. A VP referenced in `vpStatuses` but
 *   absent from `vpList` is appended at the tail in first-seen order
 *   (so a transient VP whose vp_snapshot hasn't landed yet doesn't
 *   disappear).
 *
 * Status precedence (highest first):
 *   1. connectionState !== 'connected'              → 'offline'
 *   2. vpStatuses[vpId].state                       → that state
 *   3. else                                         → 'idle'
 */

/**
 * @typedef {'idle'|'typing'|'thinking'|'streaming'|'tool'|'error'|'offline'} VpStatus
 */

/**
 * @typedef {Object} TimelineRow
 * @property {string} vpId
 * @property {string} displayName
 * @property {VpStatus} status
 * @property {number} runningThreadCount
 * @property {Array<object>} threads
 */

/**
 * Project a group's roster (array of vpIds) into the ordered
 * { vpId, displayName, ... } list that `buildTimelineRows` expects.
 *
 * Unchanged from the previous version — roster is the source of truth;
 * the VP library only supplies display fields. A roster id missing
 * from the library is stubbed as `{ vpId: id }` so the column still
 * renders a row for every roster member while vp_snapshot hydrates.
 *
 * @param {string[]|null|undefined} roster   array of vpIds for the group
 * @param {Array<{vpId:string,displayName?:string,displayNameZh?:string}>|null|undefined} library
 *     full VP library, e.g. vpStore.vpList
 * @returns {Array<object>}  roster-ordered VPs (hydrated where possible, stubbed otherwise)
 */
export function selectGroupRosterVpList(roster, library) {
  if (!Array.isArray(roster) || roster.length === 0) return [];
  const byId = new Map();
  if (Array.isArray(library)) {
    for (const vp of library) {
      if (vp && vp.vpId) byId.set(vp.vpId, vp);
    }
  }
  const seen = new Set();
  const out = [];
  for (const id of roster) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id) || { vpId: id });
  }
  return out;
}

/**
 * Resolve a Session row for roster display from the Sessions store.
 *
 * Multi-agent sidebars key sessions by `agentId + sessionId`, not by the bare
 * session id. Call the store resolver instead of indexing `sessions[sessionId]`
 * directly, otherwise the Session status pane renders "no VP" for perfectly
 * valid Sessions owned by an agent-stamped row.
 *
 * @param {object|null|undefined} sessionsStore
 * @param {string|null|undefined} sessionId
 * @param {string|null|undefined} agentId
 * @returns {object|null}
 */
export function resolveTimelineSession(sessionsStore, sessionId, agentId = null) {
  if (!sessionId || !sessionsStore) return null;
  if (typeof sessionsStore.sessionById === 'function') {
    return sessionsStore.sessionById(sessionId, agentId || null) || null;
  }
  return sessionsStore.sessions?.[sessionId] || null;
}

/**
 * Decide the status tag for a single vpId given the active store state.
 * Pure: no closures over module state, no Date.now().
 *
 * Connection state is the top priority: when the WS is anything other
 * than `connected`, every row renders as `offline` so the user sees a
 * single unambiguous signal that "the agent is gone" — not a stale
 * `thinking` left over from before the disconnect.
 *
 * @param {string} vpId
 * @param {object} ctx
 * @param {Object<string, {state: VpStatus, since?:number, turnId?:string|null}>} [ctx.vpStatuses]
 * @param {string} [ctx.connectionState]    one of: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'updating'
 * @returns {VpStatus}
 */
export function statusFor(vpId, ctx) {
  if (!ctx) return 'idle';
  if (ctx.connectionState && ctx.connectionState !== 'connected') {
    return 'offline';
  }
  const entry = ctx.vpStatuses && ctx.vpStatuses[vpId];
  if (entry && entry.state) return entry.state;
  return 'idle';
}

/**
 * Build the ordered timeline-row list for the active conversation.
 *
 * The caller passes already-resolved snapshots — this helper does NOT
 * read from the store.
 *
 * @param {object} args
 * @param {Array<{vpId:string, displayName?:string, displayNameZh?:string}>} args.vpList
 * @param {Object<string, {state: VpStatus, since?:number, turnId?:string|null, sessionId?:string|null, runningThreadCount?:number, threads?:Array<object>}>} [args.vpStatuses]
 * @param {string} [args.connectionState]
 * @param {(vpId: string) => string} [args.vpLabelOf]   // optional locale-aware labeler
 * @returns {TimelineRow[]}
 */
export function buildTimelineRows(args) {
  const {
    vpList,
    vpStatuses,
    stoppingVpTurnIds,
    connectionState,
    vpLabelOf,
  } = args || {};

  const ctx = {
    vpStatuses: vpStatuses || {},
    stoppingVpTurnIds: stoppingVpTurnIds || {},
    connectionState: connectionState || null,
  };

  const labelOf = (id, fallbackVp) => {
    if (typeof vpLabelOf === 'function') {
      const v = vpLabelOf(id);
      if (v) return v;
    }
    if (fallbackVp) {
      return fallbackVp.displayName || fallbackVp.displayNameZh || id;
    }
    return id;
  };

  // Roster pass — primary source. Emit rows for every vpId in vpList in
  // declared order.
  const rosterIds = new Set();
  const rows = [];

  if (Array.isArray(vpList)) {
    for (const vp of vpList) {
      if (!vp || !vp.vpId) continue;
      rosterIds.add(vp.vpId);
      rows.push(makeRow(vp.vpId, labelOf(vp.vpId, vp), ctx));
    }
  }

  // Tail pass: VPs present in `vpStatuses` but absent from the roster.
  // Without this, a VP that emitted a status event before its
  // vp_snapshot arrived would silently disappear. First-seen order keeps
  // tail rendering deterministic across renders. We do NOT walk the
  // message history any more — `vp_status_changed` is authoritative.
  if (vpStatuses) {
    for (const vpId of Object.keys(vpStatuses)) {
      if (!vpId || rosterIds.has(vpId)) continue;
      rosterIds.add(vpId);
      rows.push(makeRow(vpId, labelOf(vpId, null), ctx));
    }
  }

  return rows;
}

/**
 * Compose a single TimelineRow from the resolved context.
 *
 * @param {string} vpId
 * @param {string} displayName
 * @param {object} ctx
 * @returns {TimelineRow}
 */
function makeRow(vpId, displayName, ctx) {
  const entry = ctx && ctx.vpStatuses && ctx.vpStatuses[vpId];
  return {
    vpId,
    displayName: displayName || vpId,
    status: statusFor(vpId, ctx),
    turnId: entry?.turnId || null,
    isStopping: !!(entry?.turnId && ctx?.stoppingVpTurnIds?.[entry.turnId]),
    runningThreadCount: entry && Number.isFinite(entry.runningThreadCount)
      ? entry.runningThreadCount
      : 0,
    threads: entry && Array.isArray(entry.threads) ? entry.threads : [],
  };
}
