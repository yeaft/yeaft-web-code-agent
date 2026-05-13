/**
 * vp-timeline.js — PR-3 of the feature-pill double-track redesign.
 *
 * Pure helpers consumed by the right-side VpTimelinePane. Given the
 * already-collected store snapshots (vp roster, feature meta map, active
 * feature pointer, typing set, message list), produces an ordered array
 * of TimelineRow objects that the pane renders one-to-one.
 *
 * Why pure: the same testability story as PR-2's feature-fold.js — no
 * Vue / Pinia dependency means we can unit-test the row computation
 * without spinning up a DOM. The component stays a thin presentational
 * shell (props down, emit up).
 *
 * Sort policy:
 *   Rows are emitted in the order vpList provides (i.e. vpStore.vpOrder).
 *   Status is a tag, not a sort key — keeping the visual stable as VPs
 *   churn between idle / typing / streaming / in-feature. A VP referenced
 *   by activeFeatureByVp / typingVpIds / messages.speakerVpId but absent
 *   from vpList is appended at the tail in first-seen order so a transient
 *   VP (e.g. one that emitted a message before its vp_snapshot landed)
 *   doesn't disappear.
 *
 * Status precedence (highest first):
 *   1. activeFeatureByVp[vpId] truthy AND meta exists  → 'in-feature'
 *   2. typingVpIds.includes(vpId)                       → 'typing'
 *   3. some message has isStreaming===true and matches  → 'streaming'
 *   4. else                                             → 'idle'
 *
 * If activeFeatureByVp[vpId] points at a featureId NOT present in
 * unifyFeatureMeta (race between the pointer set and the meta map),
 * the row falls through to 'streaming' with featureId=null — see test
 * case "race: missing meta".
 */

/**
 * @typedef {Object} TimelineRow
 * @property {string} vpId
 * @property {string} displayName
 * @property {'idle'|'typing'|'streaming'|'in-feature'} status
 * @property {string|null} featureId
 * @property {string|null} featureTitle
 * @property {string|null} featureTrigger        // 'quick' | 'turns' | 'tool' | null
 * @property {string|null} featureToolName       // when trigger === 'tool'
 * @property {'active'|'completed'|'aborted'|'error'|null} featureStatus
 * @property {number|null} featureStartedAt
 * @property {number|null} featureEndedAt
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
 * @param {Record<string, string|null>} ctx.activeFeatureByVp
 * @param {Record<string, object>} ctx.unifyFeatureMeta
 * @param {Set<string>} ctx.typingSet
 * @param {Set<string>} ctx.streamingSet
 * @returns {'idle'|'typing'|'streaming'|'in-feature'}
 */
export function statusFor(vpId, ctx) {
  const fid = ctx.activeFeatureByVp && ctx.activeFeatureByVp[vpId];
  if (fid && ctx.unifyFeatureMeta && ctx.unifyFeatureMeta[fid]) return 'in-feature';
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
 * @param {Record<string, object>} args.unifyFeatureMeta
 * @param {Record<string, string|null>} args.activeFeatureByVp
 * @param {string[]} args.typingVpIds
 * @param {Array<object>} args.messages
 * @param {(vpId: string) => string} [args.vpLabelOf]   // optional locale-aware labeler
 * @returns {TimelineRow[]}
 */
export function buildTimelineRows(args) {
  const {
    vpList,
    unifyFeatureMeta,
    activeFeatureByVp,
    typingVpIds,
    messages,
    vpLabelOf,
  } = args || {};

  const meta = unifyFeatureMeta || {};
  const active = activeFeatureByVp || {};
  const typingSet = new Set(Array.isArray(typingVpIds) ? typingVpIds : []);

  // Streaming attribution: a VP is "streaming" if any message in the
  // current (group-filtered) view has isStreaming===true and matches.
  // Computed once per call so the per-VP statusFor() is O(1) inside the
  // main loop.
  // (feat-vp-list-ui-polish: the previous snippet-derived `lastActivityAt`
  // is gone — the VP list no longer renders snippets, and no caller reads
  // the field. See PR #763 review.)
  const streamingSet = new Set();
  const speakerVps = new Set();
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m) continue;
      const vp = m.speakerVpId || m.vpId;
      if (m.isStreaming && vp) streamingSet.add(vp);
      // Track every assistant-speaker so the tail pass still surfaces
      // VPs that emitted a message but never appeared in roster/typing/
      // streaming sets (previously this fell out of `snippetMap.keys()`).
      if (m.type === 'assistant' && vp) speakerVps.add(vp);
    }
  }

  const ctx = { activeFeatureByVp: active, unifyFeatureMeta: meta, typingSet, streamingSet };

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
  for (const vpId of Object.keys(active)) {
    if (active[vpId]) addTail(vpId);
  }
  for (const vpId of typingSet) addTail(vpId);
  for (const vpId of speakerVps) addTail(vpId);
  for (const vpId of streamingSet) addTail(vpId);

  return rows;
}

/**
 * Compose a single TimelineRow from the resolved context.
 * Internal — exported only for re-export convenience if a future helper
 * needs it; not part of the public API.
 *
 * @param {string} vpId
 * @param {string} displayName
 * @param {object} ctx
 * @returns {TimelineRow}
 */
function makeRow(vpId, displayName, ctx) {
  const status = statusFor(vpId, ctx);
  const fid = ctx.activeFeatureByVp[vpId] || null;
  const m = (fid && ctx.unifyFeatureMeta[fid]) || null;
  const featureStartedAt = m && typeof m.startedAt === 'number' ? m.startedAt : null;

  // status === 'in-feature' is the only branch that exposes feature
  // metadata. The race case (active pointer but missing meta) collapsed
  // to 'streaming' above already; statusFor returned 'streaming' in
  // that branch, so m === null here and feature fields stay null.
  const isInFeature = status === 'in-feature' && m;

  // Pre-trim the title once so we don't pay String#trim twice for the
  // same field (review fix — Torvalds M2). Empty/whitespace titles
  // collapse to null so the consumer can fall back to "untitled feature".
  const trimmedTitle = isInFeature && typeof m.title === 'string'
    ? m.title.trim()
    : '';

  return {
    vpId,
    displayName: displayName || vpId,
    status,
    featureId: isInFeature ? fid : null,
    featureTitle: trimmedTitle ? trimmedTitle : null,
    featureTrigger: isInFeature && m.trigger ? m.trigger : null,
    featureToolName: isInFeature && m.toolName ? m.toolName : null,
    featureStatus: isInFeature ? (m.status || 'active') : null,
    featureStartedAt: isInFeature ? featureStartedAt : null,
    featureEndedAt: isInFeature && typeof m.endedAt === 'number' ? m.endedAt : null,
  };
}
