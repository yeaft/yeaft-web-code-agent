/**
 * turn-compact.js — pure helper for the per-VP turn collapse view.
 *
 * Given the full assistant text content of a turn, produce the "last N
 * lines" excerpt that VpTurnBlock renders in the collapsed state. We
 * also surface a flag indicating whether content was truncated so the
 * caller can render a "…" hint or grey-out the top edge.
 *
 * Pure: no Vue / Pinia dependency, no Date.now(), no DOM. The same
 * testability story as feature-fold.js (now removed) and vp-timeline.js.
 *
 * Default tail length:
 *   The brainstorm decision was "last 6 lines of text + last 1 tool".
 *   The "last 1 tool" half lives in the component because it just
 *   reads `turn.toolMsgs[length-1]` directly — no helper needed.
 *
 * What counts as a "line":
 *   We split on '\n' literally. Markdown rendering may visually wrap
 *   any single source line into many; the brainstorm requirement was
 *   "last 6 lines from the source text", and that's the simplest
 *   stable definition. Empty trailing lines (from a final '\n' in the
 *   stream) are stripped before counting so a turn that ends with a
 *   linebreak doesn't show a blank top row.
 *
 * @typedef {Object} CompactBody
 * @property {string} text          // joined "last N lines" (no trailing \n)
 * @property {boolean} truncated    // true when source had more than N lines
 * @property {number} totalLines    // total source line count (post-strip)
 */

/**
 * Produce a compact view of the assistant text body.
 *
 * @param {string|null|undefined} text
 * @param {number} [maxLines=6]
 * @returns {CompactBody}
 */
export function compactBody(text, maxLines = 6) {
  if (text == null || text === '') {
    return { text: '', truncated: false, totalLines: 0 };
  }
  const s = typeof text === 'string' ? text : String(text);
  // Split on \n then strip trailing empty lines so the trailing
  // newline at the end of a streaming chunk doesn't waste a slot.
  const lines = s.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const total = lines.length;
  if (total === 0) {
    return { text: '', truncated: false, totalLines: 0 };
  }
  const limit = typeof maxLines === 'number' && maxLines > 0 ? maxLines : 6;
  if (total <= limit) {
    return { text: lines.join('\n'), truncated: false, totalLines: total };
  }
  return {
    text: lines.slice(total - limit).join('\n'),
    truncated: true,
    totalLines: total,
  };
}

/**
 * Decide the visual "expanded" state from the explicit state machine and the
 * turn's live streaming flag. Pure helper so the component template
 * stays a one-line ternary.
 *
 *   'streaming'        → expanded (always show full body while streaming)
 *   'auto-expanded'    → expanded (default after streaming ends)
 *   'user-expanded'    → expanded (user clicked open; sticks)
 *   'user-collapsed'   → collapsed (user clicked close; sticks)
 *   'auto-collapsed'   → collapsed (legacy default; still understood)
 *
 * Why explicit states (not just a boolean): the user's manual toggle must
 * survive a re-render where the turn's `isStreaming` flips back and
 * forth (e.g. another delta lands after the user clicked collapse).
 * A boolean would be overwritten by every "auto" pass; the state machine
 * lets the component remember whether the current value was USER intent
 * or AUTO intent.
 *
 * @param {'streaming'|'auto-expanded'|'auto-collapsed'|'user-expanded'|'user-collapsed'} state
 * @returns {boolean}
 */
export function isExpanded(state) {
  return state === 'streaming' || state === 'auto-expanded' || state === 'user-expanded';
}

/**
 * Compute the next state after a user click on the toggle button.
 * Mirrors the state machine in the docstring above.
 *
 * @param {'streaming'|'auto-expanded'|'auto-collapsed'|'user-expanded'|'user-collapsed'} state
 * @returns {'user-expanded'|'user-collapsed'}
 */
export function toggleState(state) {
  return isExpanded(state) ? 'user-collapsed' : 'user-expanded';
}

/**
 * Compute the next state when the upstream `turn.isStreaming` flag
 * changes. Streaming entry forces 'streaming' unless the user has already
 * manually toggled; streaming exit expands to 'auto-expanded' UNLESS the
 * user has already manually toggled (in which case we preserve their
 * intent).
 *
 *   was 'streaming', now NOT streaming → 'auto-expanded'
 *   was NOT streaming, now streaming   → 'streaming'
 *   user-* states                       → unchanged (user wins)
 *   anything else                       → unchanged
 *
 * @param {'streaming'|'auto-expanded'|'auto-collapsed'|'user-expanded'|'user-collapsed'} state
 * @param {boolean} isStreaming
 * @returns {'streaming'|'auto-expanded'|'auto-collapsed'|'user-expanded'|'user-collapsed'}
 */
export function reconcileStreamingState(state, isStreaming) {
  if (isStreaming) {
    if (state === 'user-expanded' || state === 'user-collapsed') return state;
    return 'streaming';
  }
  // Streaming has stopped.
  if (state === 'streaming') return 'auto-expanded';
  return state;
}

/**
 * Format an elapsed-millis duration as "Ns" / "M:SS" / "Hh M:SS".
 * Shown next to the start time in VpTurnBlock's compact header while
 * the turn is streaming. Pure so we can unit-test boundary cases
 * without faking Date.now().
 *
 * Style:
 *   < 60s      → "5s"
 *   < 60min    → "2:07"
 *   ≥ 60min    → "1h 2:07"
 *
 * Negative or non-finite input collapses to "0s" (defensive — happens
 * if the turn's startedAt is in the future due to clock skew).
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const ss = String(seconds).padStart(2, '0');
  if (minutes < 60) return `${minutes}:${ss}`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${hours}h ${mm}:${ss}`;
}
