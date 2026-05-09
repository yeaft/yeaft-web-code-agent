/**
 * dream-ui-constants.js — fix/dream-cadence-and-ui-trigger.
 *
 * Centralised magic numbers for the manual dream-trigger button. Kept
 * out of UnifyPage.js so the button's behaviour is tunable and visible
 * in one place; also makes the constants importable by tests if we
 * grow any.
 *
 * Each export documents intent, not just value, so future edits don't
 * require git-archaeology to understand why the number is what it is.
 */

/**
 * How long after a successful dream run we keep the "✓ +N entries"
 * bubble visible on the button. After this elapses the button returns
 * to its idle/stale render. Spec: "3 seconds".
 */
export const DREAM_JUST_FINISHED_MS = 3000;

/**
 * How old `lastDreamAt` must be before we paint the subtle red-dot
 * staleness badge. Spec: "if now - last_dream_at > 24h". The red dot
 * is a visual nudge, not a blocker — clicking the button still works
 * exactly the same when the dot is showing.
 */
export const DREAM_REDDOT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * How often we re-evaluate the relative-time tooltip and the staleness
 * check. Cheap (a single Vue ref bump) but not free, so a 30 s cadence
 * is the visibility/perf tradeoff. Tooltip phrases granularity is
 * minutes, so 30 s is more than fast enough; the staleness check only
 * flips at the 24-hour boundary and that is well-resolved at 30 s.
 */
export const DREAM_RELATIVE_TIME_REFRESH_MS = 30_000;
