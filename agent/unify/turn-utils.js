/**
 * turn-utils.js — Turn-based slicing primitives for the Unify history.
 *
 * "Turn" = one user-side round-trip, NOT one user-role message.
 * Multi-VP fan-out emits N user messages (each `@vp-<id> <text>`) for
 * the SAME underlying prompt. They collapse into ONE turn here.
 *
 * Two concerns this module unifies:
 *
 *   1. `compact/turn-group.js` already does atomicity grouping —
 *      `[user, assistant, tool…]` triples that must move as a unit
 *      so we don't split tool_use/tool_result pairs. That's storage-
 *      invariant work.
 *
 *   2. THIS module does turn IDENTITY — "is the next user-role message
 *      the start of a new conversational turn, or is it just another
 *      `@vp-X` variant of the previous one?" That's a higher-level
 *      semantic concern.
 *
 * Both are needed. `sliceLastNTurns` cuts at a turn boundary AND walks
 * forward to include all `@vp-X` variants of that turn so the result
 * is always a pair-safe, semantically-aligned slice.
 */

/**
 * Strip a leading `@vp-<id> ` mention prefix from a user prompt. The
 * web bridge prefixes each VP's per-turn prompt with `@vp-<id> ` so
 * the engine knows which VP is replying. When asking "are these the
 * same turn?" we want the user-facing notion of a turn (one prompt
 * fanned out to multiple VPs is one turn) — so we strip the prefix
 * before comparing.
 *
 * Format mirrors `web-bridge.js#runVpTurn` (`@vp-${vpId} ${text}`)
 * and the canonical vpId charset from `groups/ids.js#VP_ID_RE`
 * (`[A-Za-z0-9_-]`). The regex here is intentionally constrained to
 * that charset so a literal `@vp-` substring in a *user-typed* message
 * (e.g. `"@vp-, fooled you"`, `"@vp-😀 hi"`) is NOT mistaken for a
 * fan-out prefix and over-stripped.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripVpMentionPrefix(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/^@vp-[A-Za-z0-9_-]+\s+/, '');
}

/**
 * Count "turns" — distinct user prompts after `@vp-X` collapsing.
 *
 * A turn is opened when we hit a user-role message whose canonical
 * text differs from the previous user-role message. Two consecutive
 * user-role messages with the same canonical text (i.e. `@vp-a foo`
 * followed by `@vp-b foo`) count as ONE turn.
 *
 * @param {Array<object>} messages
 * @returns {number}
 */
export function countTurns(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  let prev = null;
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    const canonical = stripVpMentionPrefix(m.content || '');
    if (canonical !== prev) {
      n++;
      prev = canonical;
    }
  }
  return n;
}

/**
 * Find the index of the message that opens the (n)-th-from-end turn.
 * Returns -1 if there aren't n turns in the history.
 *
 * Algorithm (mirrors `history-compact.js#findCutIndex`):
 *   - Walk user-role messages from END backwards, counting DISTINCT
 *     turns by canonical text.
 *   - When `turnsFromEnd === n`, record the index. Keep walking — the
 *     same turn might extend further back through earlier `@vp-X`
 *     variants. Stop on the FIRST user-role message whose canonical
 *     text differs (i.e. the (n+1)-th-from-end turn).
 *
 * The returned index always points at a user-role message — the
 * natural turn boundary — which means messages[idx..] is a clean
 * `[user, ..., user, ...]` slice with no orphan tool_use / tool_result
 * pairs (provided the input was clean).
 *
 * @param {Array<object>} messages
 * @param {number} n  — 1 = "open the most recent turn"
 * @returns {number}
 */
export function indexOfNthTurnFromEnd(messages, n) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  if (n <= 0) return messages.length; // "0 turns from end" = past everything

  let turnsFromEnd = 0;
  let openCanonical = null;
  let candidate = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i] || messages[i].role !== 'user') continue;
    const canonical = stripVpMentionPrefix(messages[i].content || '');
    if (canonical !== openCanonical) {
      // Boundary: a new (older) turn starts here.
      turnsFromEnd++;
      openCanonical = canonical;
      if (turnsFromEnd === n) {
        candidate = i;
        // Don't break — earlier `@vp-X` variants of THIS turn may
        // extend the boundary further back. We'll catch them via the
        // `else if` branch below until we hit a different canonical.
        continue;
      }
      if (turnsFromEnd > n) {
        // We've stepped one turn past the kept window — done.
        break;
      }
    } else if (turnsFromEnd === n) {
      // Same canonical text as the kept boundary — this is an earlier
      // `@vp-X` variant of the same turn. Pull `candidate` back to it.
      candidate = i;
    }
  }
  return candidate;
}

/**
 * Return the suffix of `messages` containing the last `n` turns.
 *
 * Always cuts at a user-message boundary (the start of the (n)-th-from-
 * end turn), so the returned slice is pair-safe with respect to
 * `[assistant(toolCalls), tool…]` arcs that LIVE inside one of the
 * kept turns. Anything before the boundary — including any leading
 * non-user messages from a prior turn — is dropped.
 *
 * If the history has fewer than `n` turns, returns the whole array
 * (caller can decide whether that's a no-op).
 *
 * @param {Array<object>} messages
 * @param {number} n
 * @returns {Array<object>}
 */
export function sliceLastNTurns(messages, n) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  if (n <= 0) return [];
  const idx = indexOfNthTurnFromEnd(messages, n);
  if (idx === -1) {
    // Fewer than n turns — keep everything.
    return messages.slice();
  }
  return messages.slice(idx);
}
