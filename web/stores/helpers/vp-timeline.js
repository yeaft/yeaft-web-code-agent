/**
 * vp-timeline.js — left-of-conversation VP list helpers.
 *
 * Originally introduced in PR-3 of the feature-pill double-track
 * redesign. PR #767 removed the Feature system (along with this file);
 * v0.1.767 then restored the VP list pane WITHOUT the feature-aware
 * status branch — `status` is now `idle | typing | streaming` only.
 *
 * Pure helpers consumed by VpTimelinePane. Given the already-collected
 * store snapshots (vp roster, typing set, message list), produces an
 * ordered array of TimelineRow objects that the pane renders 1:1.
 *
 * Why pure: same testability story — no Vue / Pinia dependency means
 * we can unit-test the row computation without spinning up a DOM. The
 * component stays a thin presentational shell (props down, emit up).
 *
 * Sort policy:
 *   Rows are emitted in roster order (i.e. the order vpList provides).
 *   Status is a tag, not a sort key — keeping the visual stable as VPs
 *   churn between idle / typing / streaming. A VP referenced by
 *   typingVpIds / messages.speakerVpId but absent from vpList is
 *   appended at the tail in first-seen order so a transient VP (e.g.
 *   one that emitted a message before its vp_snapshot landed) doesn't
 *   disappear.
 *
 * Status precedence (highest first):
 *   1. typingVpIds.includes(vpId)                       → 'typing'
 *   2. some message has isStreaming===true and matches  → 'streaming'
 *   3. else                                             → 'idle'
 */

/**
 * @typedef {Object} TimelineRow
 * @property {string} vpId
 * @property {string} displayName
 * @property {'idle'|'typing'|'streaming'} status
 */

/**
 * Project a group's roster (array of vpIds) into the ordered
 * { vpId, displayName, ... } list that `buildTimelineRows` expects.
 *
 * The middle "VP 列表" column is roster-scoped — it must show ONLY
 * the active group's declared members, in roster order. Roster is the
 * source of truth; the library only supplies display fields. A roster
 * id missing from the library is stubbed as `{ vpId: id }` so the
 * column still renders a row for every roster member while
 * vp_snapshot hydrates (the consumer's label callback falls back to
 * the raw id until then).
 *
 * @param {string[]|null|undefined} roster   array of vpIds for the group
 * @param {Array<{vpId:string,displayName?:string,displayNameZh?:string}>|null|undefined} library
 *     full VP library, e.g. vpStore.vpList
 * @returns {Array<object>}  roster-ordered VPs (hydrated where possible, stubbed otherwise)
 */
export function selectGroupRosterVpList(roster, library) {
  if (!Array.isArray(roster) || roster.length === 0) return [];
  // Roster is the source of truth — never gate on library presence.
  // If the VP library hasn't hydrated yet (vp_snapshot race), we still
  // emit a row per roster id with a stub `{ vpId: id }`. The consumer
  // (UnifyPage / VpTimelinePane) falls back to the raw vpId for display
  // and re-renders cleanly once the library catches up.
  const byId = new Map();
  if (Array.isArray(library)) {
    for (const vp of library) {
      if (vp && vp.vpId) byId.set(vp.vpId, vp);
    }
  }
  // De-duplicate roster ids — a malformed agent payload or a UI race
  // that double-adds the same VP must not produce duplicate rows
  // (Vue v-for keying would warn or recycle DOM weirdly).
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
 * Decide the status tag for a single vpId given the active store state.
 * Pure: no closures over module state, no Date.now().
 *
 * @param {string} vpId
 * @param {object} ctx
 * @param {Set<string>} ctx.typingSet
 * @param {Set<string>} ctx.streamingSet
 * @returns {'idle'|'typing'|'streaming'}
 */
export function statusFor(vpId, ctx) {
  if (ctx.typingSet && ctx.typingSet.has(vpId)) return 'typing';
  if (ctx.streamingSet && ctx.streamingSet.has(vpId)) return 'streaming';
  return 'idle';
}

/**
 * Build the ordered timeline-row list for the active conversation.
 *
 * The caller passes already-resolved snapshots — this helper does NOT
 * read from the store. The `messages` array is also assumed to be
 * already group-filtered (when a unifyActiveGroupFilter is set, the
 * caller filters before passing in, mirroring unifyVisibleMessages).
 *
 * @param {object} args
 * @param {Array<{vpId:string, displayName?:string, displayNameZh?:string}>} args.vpList
 * @param {string[]} args.typingVpIds
 * @param {Array<object>} args.messages
 * @param {(vpId: string) => string} [args.vpLabelOf]   // optional locale-aware labeler
 * @returns {TimelineRow[]}
 */
export function buildTimelineRows(args) {
  const {
    vpList,
    typingVpIds,
    messages,
    vpLabelOf,
  } = args || {};

  const typingSet = new Set(Array.isArray(typingVpIds) ? typingVpIds : []);

  // Streaming attribution: a VP is "streaming" if any message in the
  // current (group-filtered) view has isStreaming===true and matches.
  // Computed once per call so the per-VP statusFor() is O(1) inside the
  // main loop.
  const streamingSet = new Set();
  const speakerVps = new Set();
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m) continue;
      const vp = m.speakerVpId || m.vpId;
      if (m.isStreaming && vp) streamingSet.add(vp);
      // Track every assistant-speaker so the tail pass still surfaces
      // VPs that emitted a message but never appeared in roster/typing/
      // streaming sets.
      if (m.type === 'assistant' && vp) speakerVps.add(vp);
    }
  }

  const ctx = { typingSet, streamingSet };

  // Roster pass: emit rows for every vpId in vpList in order.
  const rosterIds = new Set();
  const rows = [];
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

  if (Array.isArray(vpList)) {
    for (const vp of vpList) {
      if (!vp || !vp.vpId) continue;
      rosterIds.add(vp.vpId);
      rows.push(makeRow(vp.vpId, labelOf(vp.vpId, vp), ctx));
    }
  }

  // Tail pass: VPs referenced anywhere in the live state but absent
  // from vpList. First-seen order across the sources keeps the
  // tail deterministic across renders.
  const seen = new Set();
  const addTail = (vpId) => {
    if (!vpId || rosterIds.has(vpId) || seen.has(vpId)) return;
    seen.add(vpId);
    rows.push(makeRow(vpId, labelOf(vpId, null), ctx));
  };
  // Order matters: typing first (most active), then streaming (mid-flight),
  // then plain speakers (already-finished). This keeps an actively-emitting
  // VP visually closer to the typing row than to a stale speaker.
  for (const vpId of typingSet) addTail(vpId);
  for (const vpId of streamingSet) addTail(vpId);
  for (const vpId of speakerVps) addTail(vpId);

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
  return {
    vpId,
    displayName: displayName || vpId,
    status: statusFor(vpId, ctx),
  };
}
