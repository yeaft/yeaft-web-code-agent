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
 * @property {string|null} lastSnippet           // last assistant text, ≤ snippetMaxLen + '…'
 * @property {number|null} lastActivityAt        // max(featureStartedAt, lastMsg.ts) | null
 */

/**
 * Truncate a string to `max` chars, appending '…' when shortened.
 * Returns null for null/undefined/empty input so the consumer can render
 * "no snippet yet" with a single null-check.
 *
 * @param {string|null|undefined} text
 * @param {number} max
 * @returns {string|null}
 */
export function truncateSnippet(text, max) {
  if (text == null) return null;
  const s = typeof text === 'string' ? text : String(text);
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + '…';
}

/**
 * Project a group's roster (array of vpIds) into the ordered
 * { vpId, displayName, ... } list that `buildTimelineRows` expects.
 *
 * The middle "VP 列表" column is roster-scoped — it must show ONLY
 * the active group's declared members, in roster order, hydrated
 * from the global VP library for display fields. A roster id missing
 * from the library is silently skipped (rare race when a roster
 * delta lands before vp_snapshot has hydrated the new VP).
 *
 * @param {string[]|null|undefined} roster   array of vpIds for the group
 * @param {Array<{vpId:string,displayName?:string,displayNameZh?:string}>|null|undefined} library
 *     full VP library, e.g. vpStore.vpList
 * @returns {Array<object>}  filtered + roster-ordered VPs
 */
export function selectGroupRosterVpList(roster, library) {
  if (!Array.isArray(roster) || roster.length === 0) return [];
  if (!Array.isArray(library) || library.length === 0) return [];
  const byId = new Map();
  for (const vp of library) {
    if (vp && vp.vpId) byId.set(vp.vpId, vp);
  }
  // De-duplicate roster ids — a malformed agent payload or a UI race
  // that double-adds the same VP must not produce duplicate rows
  // (Vue v-for keying would warn or recycle DOM weirdly).
  const seen = new Set();
  const out = [];
  for (const id of roster) {
    if (seen.has(id)) continue;
    const vp = byId.get(id);
    if (!vp) continue;
    seen.add(id);
    out.push(vp);
  }
  return out;
}

/**
 * Walk messages right-to-left and collect, for each vpId that has at
 * least one assistant message, the most-recent { text, ts } pair.
 * Single-pass O(N); short-circuit is unnecessary because the helper is
 * called once per render and the caller may need every VP's snippet.
 *
 * Attribution prefers `speakerVpId` (the canonical PR-2 stamp) and
 * falls back to `vpId`. Messages without either are skipped.
 *
 * @param {Array<object>} messages
 * @param {number} snippetMaxLen
 * @returns {Map<string, { text: string|null, ts: number }>}
 */
export function lastAssistantInfoByVp(messages, snippetMaxLen) {
  const out = new Map();
  if (!Array.isArray(messages)) return out;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.type !== 'assistant') continue;
    const vpId = m.speakerVpId || m.vpId;
    if (!vpId) continue;
    if (out.has(vpId)) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    // Prefer m.content (canonical); fall back to m.textContent (used by
    // some VP-aggregated turn shapes — see VpDetailView for the same
    // fallback pattern).
    const raw = (typeof m.content === 'string' && m.content)
      || (typeof m.textContent === 'string' && m.textContent)
      || '';
    out.set(vpId, { text: truncateSnippet(raw, snippetMaxLen), ts });
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
 * @param {number} [args.snippetMaxLen=80]
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
    snippetMaxLen = 80,
  } = args || {};

  const meta = unifyFeatureMeta || {};
  const active = activeFeatureByVp || {};
  const typingSet = new Set(Array.isArray(typingVpIds) ? typingVpIds : []);
  const snippetMap = lastAssistantInfoByVp(messages, snippetMaxLen);

  // Streaming attribution: a VP is "streaming" if any message in the
  // current (group-filtered) view has isStreaming===true and matches.
  // Computed once per call so the per-VP statusFor() is O(1) inside the
  // main loop.
  const streamingSet = new Set();
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || !m.isStreaming) continue;
      const vp = m.speakerVpId || m.vpId;
      if (vp) streamingSet.add(vp);
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
      rows.push(makeRow(vp.vpId, labelOf(vp.vpId, vp), ctx, snippetMap));
    }
  }

  // Tail pass: VPs referenced anywhere in the live state but absent
  // from vpList. First-seen order across the three sources keeps the
  // tail deterministic across renders.
  const seen = new Set();
  const addTail = (vpId) => {
    if (!vpId || rosterIds.has(vpId) || seen.has(vpId)) return;
    seen.add(vpId);
    rows.push(makeRow(vpId, labelOf(vpId, null), ctx, snippetMap));
  };
  for (const vpId of Object.keys(active)) {
    if (active[vpId]) addTail(vpId);
  }
  for (const vpId of typingSet) addTail(vpId);
  for (const vpId of snippetMap.keys()) addTail(vpId);
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
 * @param {Map<string, {text:string|null, ts:number}>} snippetMap
 * @returns {TimelineRow}
 */
function makeRow(vpId, displayName, ctx, snippetMap) {
  const status = statusFor(vpId, ctx);
  const fid = ctx.activeFeatureByVp[vpId] || null;
  const m = (fid && ctx.unifyFeatureMeta[fid]) || null;
  const snip = snippetMap.get(vpId) || null;
  const featureStartedAt = m && typeof m.startedAt === 'number' ? m.startedAt : null;
  const lastTs = snip ? snip.ts : 0;
  const lastActivityAt = Math.max(featureStartedAt || 0, lastTs || 0) || null;

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
    lastSnippet: snip ? snip.text : null,
    lastActivityAt,
  };
}
