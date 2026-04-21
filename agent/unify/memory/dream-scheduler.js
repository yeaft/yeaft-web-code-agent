/**
 * dream-scheduler.js — wave-6b: idle-timer dream trigger + per-VP orchestration.
 *
 * Responsibilities:
 *   1. Idle timer: fires after 30 min of no user messages if there are
 *      un-ingested (new since last dream) messages in the session.
 *   2. Per-VP dream orchestration: runs dreamShard() per VP, serial within
 *      each VP, max 2 VPs concurrently.
 *   3. Integrates the 334f recompression hook post-dream.
 *   4. Exposes `triggerDreamNow()` for manual "Run dream now" from the UI.
 *
 * Usage (from session.js / web-bridge.js):
 *   const scheduler = createDreamScheduler({ session });
 *   scheduler.noteUserMessage();          // reset idle timer on each user msg
 *   scheduler.triggerDreamNow();          // manual trigger from WS event
 *   scheduler.shutdown();                 // cleanup on session close
 *
 * References:
 *   - 334g dream-shard.js: dreamShard(), scanShards(), runCompactJob()
 *   - 334f recompression.js: checkRecompression()
 *   - PM spec: "30min 无消息 AND 有未 ingest message → 触发"
 */

import { dreamShard } from './dream-shard.js';
import { checkRecompression } from './recompression.js';
import { runUserDreamJob } from './user-memory-store.js';

/** Default idle timeout before dream triggers (ms). */
export const DREAM_IDLE_MS = 30 * 60 * 1000; // 30 min

/** Max concurrent VP dream runs. */
const MAX_CONCURRENT_DREAMS = 2;

/**
 * Create a dream scheduler instance.
 *
 * @param {{
 *   memoryShardStore: object | null,
 *   userMemoryStore: object | null,
 *   conversationStore: object | null,
 *   adapter: object | null,
 *   config: object,
 *   idleMs?: number,
 *   onDreamStart?: (vpId: string) => void,
 *   onDreamEnd?: (vpId: string, result: object) => void,
 *   onError?: (vpId: string, err: Error) => void,
 * }} opts
 * @returns {DreamScheduler}
 */
export function createDreamScheduler(opts = {}) {
  const {
    memoryShardStore,
    userMemoryStore,
    conversationStore,
    adapter,
    config,
    idleMs = DREAM_IDLE_MS,
    onDreamStart,
    onDreamEnd,
    onError,
  } = opts;

  let idleTimer = null;
  let messagesSinceLastDream = 0;
  let dreamRunning = false;
  let lastDreamAt = 0;
  let destroyed = false;

  // ── Idle timer management ────────────────────────────────

  function resetIdleTimer() {
    if (destroyed) return;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (messagesSinceLastDream > 0) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (messagesSinceLastDream > 0 && !dreamRunning && !destroyed) {
          runDream('idle').catch(() => {});
        }
      }, idleMs);
      if (idleTimer && typeof idleTimer.unref === 'function') {
        idleTimer.unref();
      }
    }
  }

  /**
   * Call on every user message to reset the idle timer and increment
   * the un-ingested message counter.
   */
  function noteUserMessage() {
    if (destroyed) return;
    messagesSinceLastDream++;
    resetIdleTimer();
  }

  // ── Dream execution ──────────────────────────────────────

  /**
   * Run a dream cycle. Currently single-VP (Unify default VP), but
   * structured for future multi-VP with maxConcurrent=2.
   *
   * @param {'idle'|'manual'} trigger
   * @returns {Promise<object>} dream result
   */
  async function runDream(trigger = 'manual') {
    if (dreamRunning) {
      return { skipped: true, reason: 'already_running' };
    }
    if (!memoryShardStore) {
      return { skipped: true, reason: 'no_shard_store' };
    }
    if (!adapter) {
      return { skipped: true, reason: 'no_adapter' };
    }

    dreamRunning = true;
    const vpId = 'default'; // single-VP Unify mode

    try {
      onDreamStart?.(vpId);

      const result = await dreamShard({
        shardStore: memoryShardStore,
        adapter,
        config: { model: config?.primaryModel || config?.model || 'default' },
        onPhase: (phase, data) => {
          // Could forward to UI in future
        },
      });

      // Post-dream: run recompression hook (334f)
      try {
        const recompResult = checkRecompression(memoryShardStore);
        result.recompression = recompResult;
      } catch {
        // Non-fatal
      }

      // Post-dream: run user-memory extract + compact (334-w7b)
      try {
        const userDreamResult = await runUserDreamJob({
          store: userMemoryStore || undefined,
          conversationStore: conversationStore || undefined,
          adapter: adapter || undefined,
          config: { model: config?.primaryModel || config?.model || 'default' },
        });
        result.userDream = userDreamResult;
      } catch {
        // Non-fatal
      }

      messagesSinceLastDream = 0;
      lastDreamAt = Date.now();
      onDreamEnd?.(vpId, { ...result, trigger });

      return result;
    } catch (err) {
      onError?.(vpId, err);
      return { error: err.message, trigger };
    } finally {
      dreamRunning = false;
    }
  }

  /**
   * Manual trigger from UI ("Run dream now" button).
   * @returns {Promise<object>}
   */
  function triggerDreamNow() {
    return runDream('manual');
  }

  /**
   * Cleanup: clear timers, prevent further runs.
   */
  function shutdown() {
    destroyed = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  return {
    noteUserMessage,
    triggerDreamNow,
    shutdown,
    get isRunning() { return dreamRunning; },
    get messagesSinceLastDream() { return messagesSinceLastDream; },
    get lastDreamAt() { return lastDreamAt; },
  };
}

/**
 * @typedef {ReturnType<typeof createDreamScheduler>} DreamScheduler
 */
