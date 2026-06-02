/**
 * helpers/debug-search.js — feat-6af5f9f1 PR C.
 *
 * Pure substring matcher for the Yeaft debug panel toolbar. Extracted from
 * chat.js so it can be unit-tested without pulling in the full Pinia store
 * (which depends on browser globals).
 *
 * Searched fields:
 *   - turn.userPrompt
 *   - turn.vpId
 *   - turn.groupId
 *   - loops[0].systemPrompt   (constant within a turn — checked once)
 *   - per-loop loop.response  (assistant text)
 *   - per-loop loop.rawRequest.url
 *   - per-tool tc.name
 *   - per-tool tc.input       (JSON-serialized)
 *   - per-tool message.content where role === 'tool' (= tool output)
 *   - per-reflection r.content / r.error
 *
 * Match is case-insensitive substring.
 */

/**
 * @param {object}   turn         turn record from yeaftDebugTurnsById
 * @param {object[]} loops        loop records belonging to this turn
 * @param {object[]} reflections  reflection cards for this turn
 * @param {string}   qLower       already-lowercased query string;
 *                                empty / falsy → match everything
 * @returns {boolean}
 */
export function turnMatchesSearch(turn, loops, reflections, qLower) {
  if (!qLower) return true;
  const hit = (s) => typeof s === 'string' && s.toLowerCase().includes(qLower);
  const hitJSON = (v) => {
    if (v == null) return false;
    if (typeof v === 'string') return hit(v);
    try { return hit(JSON.stringify(v)); } catch { return false; }
  };
  if (hit(turn && turn.userPrompt)) return true;
  if (hit(turn && turn.vpId)) return true;
  if (hit(turn && turn.groupId)) return true;
  // System prompt is identical across loops within a turn — check once.
  if (loops && loops.length > 0 && hit(loops[0].systemPrompt)) return true;
  for (const loop of loops || []) {
    if (hit(loop.response)) return true;
    if (loop.rawRequest && hit(loop.rawRequest.url)) return true;
    for (const tc of loop.toolCalls || []) {
      if (hit(tc.name)) return true;
      if (hitJSON(tc.input)) return true;
    }
    for (const m of loop.messages || []) {
      if (m && m.role === 'tool' && hit(m.content)) return true;
    }
  }
  for (const r of reflections || []) {
    if (hit(r.content)) return true;
    if (hit(r.error)) return true;
  }
  return false;
}
