/**
 * dream-v2/schedule.js — DESIGN-v2 §10.2.
 *
 * Two trigger paths:
 *
 *   1. 12-hour interval timer.
 *   2. Manual trigger (UI button or `/dream` command), routed in via
 *      `triggerNow()` — sets `manual: true` so the per-group threshold
 *      is bypassed.
 *
 * The scheduler is a thin wrapper around `runDream()` that prevents
 * concurrent passes (a second tick while the previous is still running
 * is dropped, not queued — DESIGN-v2 §10.1: "slow is OK, doesn't
 * compete with user latency").
 */

import { DREAM_INTERVAL_HOURS } from './limits.js';

export const DEFAULT_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;

/**
 * Build a scheduler around `runDream()`. The runner closure captures
 * everything `runDream` needs (memory root, llm, message-store hooks,
 * onProgress sink); the scheduler only knows how to call it.
 *
 * @param {{
 *   run: (opts: { manual: boolean, scopeFilter?: string[] }) => Promise<object>,
 *   intervalMs?: number,
 *   logger?: { info?: (...a:any) => void, warn?: (...a:any) => void, error?: (...a:any) => void },
 * }} args
 */
export function createDreamScheduler({ run, intervalMs = DEFAULT_INTERVAL_MS, logger }) {
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
      // Don't keep the event loop alive solely for the dream ticker.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    triggerNow(scopeFilter) {
      return fire({ manual: true, scopeFilter });
    },
    isRunning() { return !!inflight; },
    /** Test hook: fires once without scheduling a timer. */
    _fire: fire,
  };
}
