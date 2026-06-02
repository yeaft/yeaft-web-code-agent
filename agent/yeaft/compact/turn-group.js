/**
 * compact/turn-group.js — DESIGN.md §9.2.
 *
 * Group messages into turns whose unit of archiving is "atomic": each
 * group is either kept entirely live or archived entirely. Archiving
 * an assistant message that contained `toolCalls` while leaving the
 * tool results live (or vice versa) breaks the OpenAI invariant that
 * `tool_call_id`s must be paired.
 *
 * A "turn group" starts on a `user` message and extends through every
 * subsequent assistant + tool message until the next user message. The
 * grouping function returns an array of `{ start, end, indices }` pairs
 * where `[start, end)` is a half-open range over the input array.
 *
 * Edge cases:
 *   - Leading non-user messages (e.g. a system or tool prelude written
 *     by an init hook) form a group of their own at index 0.
 *   - Trailing assistant/tool messages (incomplete turn) form the final
 *     group — same rule.
 *   - Empty input → empty result.
 */

/**
 * @param {object[]} messages
 * @returns {Array<{ start: number, end: number, role: string }>}
 *   `role` reflects the group's anchor (the `user` message, if any;
 *   otherwise the first message in the group).
 */
export function groupTurns(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const groups = [];
  let cur = { start: 0, end: 0, role: messages[0]?.role || 'unknown' };
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      // Treat as belonging to the current group (don't break pairing).
      cur.end = i + 1;
      continue;
    }
    if (m.role === 'user' && cur.end > cur.start) {
      groups.push(cur);
      cur = { start: i, end: i + 1, role: 'user' };
    } else {
      cur.end = i + 1;
      if (m.role === 'user') cur.role = 'user';
    }
  }
  if (cur.end > cur.start) groups.push(cur);
  return groups;
}

/**
 * Pick the cut point: keep `keepHot` newest groups live, return the
 * rest as "cooling" candidates for archive.
 *
 * Returns: `{ hot: groups[], cooling: groups[] }`. Both arrays use the
 * same `{start, end, role}` shape from `groupTurns`.
 *
 * @param {Array<{start: number, end: number, role: string}>} groups
 * @param {number} keepHot
 */
export function pickCoolingGroups(groups, keepHot = 10) {
  if (!Array.isArray(groups)) return { hot: [], cooling: [] };
  const k = Math.max(0, Math.floor(keepHot));
  if (groups.length <= k) return { hot: groups.slice(), cooling: [] };
  const cut = groups.length - k;
  return {
    hot: groups.slice(cut),
    cooling: groups.slice(0, cut),
  };
}

/**
 * Flatten a list of groups back into the underlying message indices.
 *
 * @param {Array<{start: number, end: number}>} groups
 * @returns {number[]}
 */
export function indicesFromGroups(groups) {
  const out = [];
  for (const g of groups) {
    for (let i = g.start; i < g.end; i += 1) out.push(i);
  }
  return out;
}
