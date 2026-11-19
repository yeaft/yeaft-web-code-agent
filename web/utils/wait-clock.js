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
  let clock = clocks.get(key);
  // A clock from the future means the system time stepped back; start over
  // rather than hold the first frame until time catches up.
  if (!clock || now - clock.readAt > GRACE_MS || now < clock.startedAt) {
    clock = { startedAt: now, readAt: now };
  }
  clock.readAt = now;
  // Re-insert so the map stays ordered by last read, and drop the stalest.
  clocks.delete(key);
  clocks.set(key, clock);
  if (clocks.size > MAX_CLOCKS) clocks.delete(clocks.keys().next().value);
  return clock.startedAt;
}
