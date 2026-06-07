/**
 * snapshot-filter.js — VP-isolated view of the in-memory group history.
 *
 * Mirrors the disk-replay rules in
 * `agent/yeaft/conversation/persist.js#loadSessionHistoryForVp`:
 *
 *   - User rows (no `speakerVpId`): KEEP — every VP sees the prompt.
 *   - This VP's own assistant rows + their paired tool rows: KEEP.
 *   - OTHER VPs' assistant rows: KEEP TEXT ONLY (strip `toolCalls` AND
 *     `thinkingBlocks` — thinking is VP-private per Anthropic's signed-
 *     block contract; tool_use ids belong to that VP's own tool arc).
 *   - OTHER VPs' tool result rows (role:'tool'): DROP — they pair with
 *     stripped tool_use ids and would orphan on the LLM request.
 *   - Rows with `_reflection` / `internal` / `systemOnly`: DROP — engine-
 *     private; never enter another VP's context.
 *
 * Why this exists separately from the disk replay path:
 *   `web-bridge.js` builds an in-memory `baseSnapshot` for every running
 *   VP turn. Before this filter the snapshot was only `threadId`-scoped
 *   and leaked other VPs' tool calls + thinking blocks into the next
 *   turn's messages, producing orphan `tool_use` ids and Anthropic 422s.
 *   The disk path uses `ConversationStore.loadSessionHistoryForVp` —
 *   the same rules implemented here, but reading from `messages/*.md`
 *   instead of the in-memory tape. We intentionally duplicate the rule
 *   set rather than calling into persist.js so both call sites stay
 *   independently audit-able.
 *
 * Pure function; does not mutate inputs.
 *
 * @param {object[]} snapshot — entries from getOrCreateSessionHistory(sessionId)
 *                              (already threadId-filtered by the caller)
 * @param {string} vpId — the VP we're about to send a turn for
 * @returns {object[]}
 */
export function filterSnapshotForVp(snapshot, vpId) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];
  const out = [];
  for (const m of snapshot) {
    if (!m || typeof m !== 'object') continue;
    // Reflection / engine-private rows are dropped regardless of vpId.
    // Even the "no vpId, give me everything" code path must not leak
    // these into a snapshot the caller will hand to an LLM — they were
    // never meant to enter another VP's context, nor any VP's.
    if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) continue;
    if (!vpId) {
      // No VP scope known: treat every row as "own". This is the
      // fallback used by callers that don't (yet) have a vpId; the
      // reflection filter above still applies.
      out.push(m);
      continue;
    }
    if (m.role === 'user') {
      out.push(m);
      continue;
    }
    if (m.role === 'assistant') {
      if (!m.speakerVpId || m.speakerVpId === vpId) {
        // Own assistant turn OR un-attributed (pre-rename) row — keep
        // intact so this VP's tool arcs survive untouched.
        out.push(m);
      } else {
        // Other VP's assistant turn — keep the visible text only.
        // Stripping toolCalls is what makes the paired 'tool' rows
        // below safe to drop without leaving orphan tool_use ids in
        // the LLM payload. Stripping thinkingBlocks is required by
        // Anthropic — signatures are VP-private and would fail
        // server-side verification if echoed by a different VP.
        const copy = { ...m };
        delete copy.toolCalls;
        delete copy.thinkingBlocks;
        out.push(copy);
      }
      continue;
    }
    if (m.role === 'tool') {
      // Tool results belong to the assistant turn that emitted the
      // tool_use. We only keep ours; the other VPs' results paired
      // with `toolCalls` we just stripped above, so they'd be
      // orphans now anyway.
      if (!m.speakerVpId || m.speakerVpId === vpId) out.push(m);
      continue;
    }
    // Unknown role — keep as-is so future schema additions don't get
    // silently dropped.
    out.push(m);
  }
  return out;
}
