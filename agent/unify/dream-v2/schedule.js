/**
 * dream-v2/schedule.js.
 *
 * Three trigger paths:
 *
 *   1. Interval timer (default 1 hour, see DREAM_INTERVAL_HOURS in limits.js).
 *   2. Manual trigger (UI button or `/dream` command), routed in via
 *      `triggerNow()` — sets `manual: true` so the per-group threshold
 *      is bypassed.
 *   3. Nudge (task-710), routed in via `nudge()` — non-manual, so
 *      MIN_NEW_PER_GROUP still applies. Used by session-wiring when
 *      user-message traffic crosses DREAM_NUDGE_AFTER_MESSAGES.
 *
 * The scheduler is a thin wrapper around `runDream()` that prevents
 * concurrent passes (a second tick while the previous is still running
 * is dropped, not queued: "slow is OK, doesn't
 * compete with user latency").
 */

import { DREAM_INTERVAL_HOURS } from './limits.js';

export const DEFAULT_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;

/**
 * Build a scheduler around `runDream()`. The runner closure captures
 * everything `runDream` needs (memory root, llm, message-store hooks,
 * onProgress sink); the scheduler only knows how to call it.
 *
 * `keepAlive` controls whether the interval timer holds the event loop
 * open. Default `false` preserves the original behaviour (CLI / one-shot
 * invocations should not be kept alive solely by the dream ticker). The
 * web server passes `true` because (a) the HTTP listener already pins
 * the loop, so unref'ing buys nothing, and (b) on Node 22 some platforms
 * never schedule unref'd timers when nothing else wakes them — meaning
 * the server saw zero ticks in production. See PR fix/dream-cadence.
 *
 * @param {{
 *   run: (opts: { manual: boolean, scopeFilter?: string[] }) => Promise<object>,
 *   intervalMs?: number,
 *   keepAlive?: boolean,
 *   logger?: { info?: (...a:any) => void, warn?: (...a:any) => void, error?: (...a:any) => void },
 * }} args
 */
export function createDreamScheduler({ run, intervalMs = DEFAULT_INTERVAL_MS, keepAlive = false, logger }) {
  if (typeof run !== 'function') throw new Error('createDreamScheduler: run callable required');
  const log = logger || {};
  let timer = null;
  let inflight = null;

  async function fire(opts) {
    if (inflight) {
      log.warn?.('[dream] tick dropped — previous run still in progress');
      return inflight;
    }
    inflight = (async () => {
      try {
        return await run(opts);
      } catch (err) {
        log.error?.('[dream] run failed:', err && err.message ? err.message : err);
        return { error: err && err.message ? err.message : String(err) };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { fire({ manual: false }).catch(() => {}); }, intervalMs);
      // Server / long-lived hosts pass keepAlive=true so the interval
      // participates in the loop normally. Short-lived hosts (CLI, tests)
      // leave keepAlive=false to avoid pinning the loop open with the
      // ticker alone.
      if (!keepAlive && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    triggerNow(scopeFilter) {
      return fire({ manual: true, scopeFilter });
    },
    /**
     * task-710: non-manual fire driven by user-message traffic. Unlike
     * `triggerNow`, MIN_NEW_PER_GROUP still applies — groups below
     * threshold are skipped exactly as on the timer path.
     */
    nudge() {
      return fire({ manual: false });
    },
    isRunning() { return !!inflight; },
    /** Test hook: fires once without scheduling a timer. */
    _fire: fire,
  };
}
