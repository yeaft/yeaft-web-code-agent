/**
 * Wait clocks: when the wait a typing indicator is showing began.
 *
 * The indicator is removed and re-created whenever text streams between two
 * tool calls, so the animation inside it cannot own its own start time. A
 * clock is read by key (the conversation being waited on) instead and lives
 * for as long as something keeps reading it. Left unread for a few seconds it
 * is forgotten, and the next reader starts a fresh one. A short gap therefore
 * resumes the play in progress, a new wait opens from the first beat, and any
 * other view of the same wait would show the same moment.
 *
 * An animation that is on the page but not drawing — scrolled out of view, in
 * a background tab, held on one frame — does not read its clock. It holds it
 * instead, so the wait is still the same wait when it draws again.
 */
const GRACE_MS = 4000;
const MAX_CLOCKS = 32;
const clocks = new Map();

/**
 * @param {string} key Identity of the wait, e.g. the conversation it belongs to.
 * @param {number} [now] Current time in ms.
 * @returns {number} Start time of the wait in ms.
 */
export function readWaitClock(key, now = Date.now()) {
  const known = clocks.get(key);
  // A clock from the future means the system time stepped back; start over
  // rather than hold the first frame until time catches up.
  const lapsed = !known || (known.holders === 0 && now - known.readAt > GRACE_MS) || now < known.startedAt;
  const clock = lapsed ? { startedAt: now, readAt: now, holders: known ? known.holders : 0 } : known;
  clock.readAt = now;
  // Re-insert so the map stays ordered by last read, and drop the stalest
  // clock nobody is holding.
  clocks.delete(key);
  clocks.set(key, clock);
  if (clocks.size > MAX_CLOCKS) {
    for (const [stale, other] of clocks) {
      if (other.holders > 0 || stale === key) continue;
      clocks.delete(stale);
      break;
    }
  }
  return clock.startedAt;
}

/**
 * Keep a wait's clock from being forgotten while something shows that wait
 * without reading it.
 * @param {string} key Identity of the wait.
 * @param {number} [now] Current time in ms.
 * @returns {(now?: number) => void} Lets go. The clock is then forgotten once
 *   it has gone unread for the usual few seconds.
 */
export function holdWaitClock(key, now = Date.now()) {
  readWaitClock(key, now);
  clocks.get(key).holders += 1;
  let holding = true;
  return (at = Date.now()) => {
    if (!holding) return;
    holding = false;
    const clock = clocks.get(key);
    if (!clock) return;
    clock.holders = Math.max(0, clock.holders - 1);
    clock.readAt = Math.max(clock.readAt, at);
  };
}
