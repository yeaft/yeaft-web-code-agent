/**
 * Shared clocks for waiting animations. Views that show the same wait — the
 * strip under a transcript and the screen in its status pane — read the clock
 * by the same key and so agree on when it started. No view owns it.
 *
 * A clock lives for as long as something keeps reading it. Left unread for a
 * few seconds it is forgotten and the next reader starts a fresh one. A short
 * gap (text streaming between two tool calls) therefore resumes the play in
 * progress, while a new wait opens from the first beat.
 */
const GRACE_MS = 4000;
const MAX_CLOCKS = 32;
const clocks = new Map();

/** Key for a Yeaft Session's wait. Its transcript and its status pane both build it. */
export const sessionWaitKey = (agentId, sessionId) => `session\u001f${agentId || ''}\u001f${sessionId || ''}`;

/** Key for a CLI chat conversation's wait. */
export const conversationWaitKey = conversationId => `chat\u001f${conversationId || ''}`;

/**
 * @param {string} key Identity of the wait, e.g. agent + session.
 * @param {number} [now] Current time in ms.
 * @returns {number} Start time of the wait in ms.
 */
export function readWaitClock(key, now = Date.now()) {
  let clock = clocks.get(key);
  if (!clock || now - clock.readAt > GRACE_MS) {
    clock = { startedAt: now, readAt: now };
    clocks.delete(key);
    clocks.set(key, clock);
    if (clocks.size > MAX_CLOCKS) clocks.delete(clocks.keys().next().value);
  }
  clock.readAt = now;
  return clock.startedAt;
}
