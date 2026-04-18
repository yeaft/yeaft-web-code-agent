/**
 * task-330b — Routing metrics counter (Final Spec §B).
 *
 * Centralised observability for crew routing fallbacks. Five canonical
 * reasons that any fallback path MUST pass to `recordRoutingEvent`:
 *
 *   - missing-route     : turn ended with no parseable ROUTE block
 *   - parse-fail        : ROUTE block found but parse returned null/invalid
 *   - self-route        : route.to resolves to the sender (rejected by §A)
 *   - state-stopped     : message arrived while session was stopped/paused
 *                         and was diverted/dropped
 *   - fallback-forward  : auto-forward path engaged (non-PM → PM safety net)
 *
 * Counters are kept in-memory keyed by `${sessionId}::${reason}` and flushed
 * to `${sharedDir}/context/routing-metrics.json` periodically (default 30s)
 * AND on demand via `flushRoutingMetricsNow(session)`. The on-disk format:
 *
 *   {
 *     "schemaVersion": 1,
 *     "lastFlushedAt": <ms>,
 *     "counts": {
 *       "missing-route": 4,
 *       "parse-fail": 1,
 *       "self-route": 0,
 *       "state-stopped": 2,
 *       "fallback-forward": 4
 *     },
 *     "recent": [
 *       { ts, reason, fromRole, toRole?, taskId?, note? },
 *       ...                                  // bounded ring buffer (50)
 *     ]
 *   }
 *
 * Red lines (§330b):
 *   - Pure observer; never mutates routing decisions.
 *   - Never throws; failures degrade to console.warn so callers can rely on
 *     `recordRoutingEvent()` being safe inside hot paths.
 *
 * Red lines (§330a — shared with this PR):
 *   - No engine state-machine touch.
 *   - PM-self-loop is the responsibility of §A; §B only records the metric
 *     when §A rejects.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

export const ROUTING_REASONS = Object.freeze([
  'missing-route',
  'parse-fail',
  'self-route',
  'state-stopped',
  'fallback-forward',
]);

const REASON_SET = new Set(ROUTING_REASONS);
const RECENT_RING_SIZE = 50;
const FLUSH_INTERVAL_MS = 30_000;

/**
 * In-process state — ONE bag per process. Keyed by sessionId so multiple
 * crew sessions running in the same agent each keep their own counts.
 *
 * Shape: Map<sessionId, {
 *   sharedDir: string,
 *   counts: Record<reason, number>,
 *   recent: Array<{ ts, reason, fromRole, toRole?, taskId?, note? }>,
 *   dirty: boolean,
 *   flushTimer: NodeJS.Timeout | null,
 * }>
 */
const _state = new Map();

function _zeroCounts() {
  const c = {};
  for (const r of ROUTING_REASONS) c[r] = 0;
  return c;
}

function _getOrInit(session) {
  const sid = session?.id;
  if (!sid) return null;
  let bag = _state.get(sid);
  if (!bag) {
    bag = {
      sharedDir: session.sharedDir || null,
      counts: _zeroCounts(),
      recent: [],
      dirty: false,
      flushTimer: null,
    };
    _state.set(sid, bag);
  }
  // sharedDir may not be available at session creation — keep latest.
  if (session.sharedDir) bag.sharedDir = session.sharedDir;
  return bag;
}

/**
 * Record a routing fallback event.
 *
 * @param {object} session — crew session (must have .id; .sharedDir for flush)
 * @param {string} reason — one of ROUTING_REASONS
 * @param {object} [meta]
 * @param {string} [meta.fromRole]
 * @param {string} [meta.toRole]
 * @param {string} [meta.taskId]
 * @param {string} [meta.note]
 * @returns {boolean} true if recorded; false if invalid input
 */
export function recordRoutingEvent(session, reason, meta = {}) {
  if (!session || !session.id) return false;
  if (!REASON_SET.has(reason)) {
    console.warn(`[routing-metrics] Unknown reason: ${reason} (allowed: ${ROUTING_REASONS.join(', ')})`);
    return false;
  }
  const bag = _getOrInit(session);
  if (!bag) return false;

  bag.counts[reason] = (bag.counts[reason] || 0) + 1;
  bag.recent.push({
    ts: Date.now(),
    reason,
    fromRole: meta.fromRole || null,
    toRole: meta.toRole || null,
    taskId: meta.taskId || null,
    note: meta.note || null,
  });
  // Bound the ring.
  if (bag.recent.length > RECENT_RING_SIZE) {
    bag.recent.splice(0, bag.recent.length - RECENT_RING_SIZE);
  }
  bag.dirty = true;
  _ensureTimer(session.id, bag);
  return true;
}

function _ensureTimer(sessionId, bag) {
  if (bag.flushTimer) return;
  bag.flushTimer = setTimeout(() => {
    bag.flushTimer = null;
    _flush(sessionId, bag).catch((e) =>
      console.warn(`[routing-metrics] periodic flush failed for ${sessionId}: ${e.message}`),
    );
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive solely for metrics flush.
  if (typeof bag.flushTimer.unref === 'function') bag.flushTimer.unref();
}

async function _flush(sessionId, bag) {
  if (!bag.dirty) return;
  if (!bag.sharedDir) return; // can't flush without target dir
  const dir = join(bag.sharedDir, 'context');
  const file = join(dir, 'routing-metrics.json');
  const payload = {
    schemaVersion: 1,
    lastFlushedAt: Date.now(),
    counts: { ...bag.counts },
    recent: bag.recent.slice(),
  };
  try {
    await fs.mkdir(dir, { recursive: true });
    // Write-then-rename for atomicity (single-line file is small; tolerate
    // platform quirks).
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, file);
    bag.dirty = false;
  } catch (e) {
    console.warn(`[routing-metrics] flush write failed: ${e.message}`);
  }
}

/**
 * Force a synchronous-ish flush (still returns a Promise). Useful from
 * shutdown paths or tests.
 */
export async function flushRoutingMetricsNow(session) {
  const bag = _state.get(session?.id);
  if (!bag) return;
  if (bag.flushTimer) {
    clearTimeout(bag.flushTimer);
    bag.flushTimer = null;
  }
  await _flush(session.id, bag);
}

/**
 * Read current counts (test/inspection only; non-mutating snapshot).
 * @returns {{ counts: Record<string, number>, recent: Array<object> } | null}
 */
export function getRoutingMetricsSnapshot(session) {
  const bag = _state.get(session?.id);
  if (!bag) return null;
  return {
    counts: { ...bag.counts },
    recent: bag.recent.slice(),
  };
}

/**
 * Reset (test-only).
 */
export function _resetRoutingMetricsForTest(sessionId) {
  if (sessionId) {
    const bag = _state.get(sessionId);
    if (bag?.flushTimer) clearTimeout(bag.flushTimer);
    _state.delete(sessionId);
    return;
  }
  for (const [, bag] of _state) {
    if (bag.flushTimer) clearTimeout(bag.flushTimer);
  }
  _state.clear();
}
