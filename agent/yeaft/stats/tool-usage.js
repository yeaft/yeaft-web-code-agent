/**
 * tool-usage.js — ToolUsageStats: per-tool call/error/latency counters
 * with throttled persistence to ~/.yeaft/stats/tool-usage.json.
 *
 * Purpose: answer "which tools are defined but never called?" and
 * "which tools dominate latency / error rate?" without dragging a
 * full APM stack in. The engine emits `tool_exec` events containing
 * `{name, durationMs, isError}` after every tool call — `record()` is
 * the hook point.
 *
 * Storage shape (JSON file):
 * ```
 * {
 *   schema: 1,
 *   tools: {
 *     "<name>": {
 *       callCount: number,
 *       errorCount: number,
 *       totalDurationMs: number,
 *       durations: number[],   // ring of last N durations for p50/p95
 *       lastCalledAt: ISO8601 string,
 *       lastError: string | null,
 *       recentOutcomes: (null | string)[] // last 100: null=success, safe reason=error
 *     }
 *   }
 * }
 * ```
 *
 * Persistence policy: write to a `.tmp` sibling then `rename()` so we
 * never leave a half-written JSON on disk. Throttled — flush after
 * every `flushEveryNRecords` records OR if `flushIntervalMs` has
 * passed since the last write, whichever comes first. `flush()` is
 * exposed for shutdown paths.
 *
 * Latency math: p50/p95 from a sorted copy of the durations ring.
 * Small samples (< 100 per tool) are good enough for a "noticed this
 * tool is slow" signal — not a billing-grade SLO.
 */

import { promises as fsp, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_RING_SIZE = 100;
const DEFAULT_FLUSH_EVERY_N = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const SCHEMA_VERSION = 1;
const RECENT_WINDOW_SIZE = 100;

// Fixed vocabulary: never persist arbitrary messages, paths, URLs or provider
// strings as category keys. Unknown structured codes fall back to a category.
const ERROR_REASONS = new Set([
  'invalid_arguments', 'git_cwd_outside_repository', 'git_exit_unconfirmed',
  'git_timeout', 'git_output_limit', 'git_failed', 'git_filter_inspection_failed',
  'git_execution_error', 'bash_exit_nonzero', 'exit_nonzero',
  'timeout', 'cancelled', 'permission', 'not_found', 'network', 'rate_limit', 'conflict', 'http_error', 'other',
]);

function safeReason(value) {
  return typeof value === 'string' && ERROR_REASONS.has(value) ? value : null;
}

function errorReason(errorMessage, errorCode) {
  const explicit = safeReason(errorCode);
  if (explicit) return explicit;
  const text = typeof errorMessage === 'string' ? errorMessage.slice(0, 500) : '';
  let code;
  try {
    const parsed = JSON.parse(text);
    code = parsed?.code ?? parsed?.errorCode ?? parsed?.failureType ?? parsed?.error?.code;
  } catch {
    // Engine output may end mid-JSON. Only accept a complete allowlisted code
    // value; do not turn a truncated/free-form value into a category key.
    code = text.match(/"(?:code|errorCode|failureType)"\s*:\s*"([A-Za-z0-9_-]{1,64})"/)?.[1];
  }
  const structured = safeReason(code);
  if (structured) return structured;
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/abort|cancelled|canceled/i.test(text)) return 'cancelled';
  if (/rate.?limit|too many requests|\b429\b/i.test(text)) return 'rate_limit';
  if (/EACCES|EPERM|permission denied|access denied|forbidden|unauthorized|\b40[13]\b/i.test(text)) return 'permission';
  if (/ENOENT|not found|does not exist|\b404\b/i.test(text)) return 'not_found';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket/i.test(text)) return 'network';
  if (/already exists|uncommitted changes|conflict/i.test(text)) return 'conflict';
  if (/HTTP\s*(?:error[: ]*)?[45]\d\d/i.test(text)) return 'http_error';
  return 'other';
}

function readToolRecord(rec, ringSize) {
  return {
    callCount: Number(rec.callCount) || 0,
    errorCount: Number(rec.errorCount) || 0,
    totalDurationMs: Number(rec.totalDurationMs) || 0,
    durations: Array.isArray(rec.durations) ? rec.durations.slice(-ringSize) : [],
    lastCalledAt: typeof rec.lastCalledAt === 'string' ? rec.lastCalledAt : null,
    lastError: typeof rec.lastError === 'string' ? rec.lastError : null,
    // Old durations/lastError cannot tell us which calls failed. Never infer
    // recent outcomes from lifetime counters on legacy files.
    recentOutcomes: Array.isArray(rec.recentOutcomes)
      ? rec.recentOutcomes.slice(-RECENT_WINDOW_SIZE).map(value => value === null ? null : safeReason(value) || 'other')
      : [],
  };
}

function defaultStatsPath() {
  return join(homedir(), '.yeaft', 'stats', 'tool-usage.json');
}

function emptyToolRecord() {
  return {
    callCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
    durations: [],
    lastCalledAt: null,
    lastError: null,
    recentOutcomes: [],
  };
}

function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedAsc.length))
  );
  return sortedAsc[idx];
}

export class ToolUsageStats {
  /** @type {string} */
  #path;
  /** @type {Record<string, ReturnType<typeof emptyToolRecord>>} */
  #tools;
  /** @type {number} */
  #ringSize;
  /** @type {number} */
  #flushEveryN;
  /** @type {number} */
  #flushIntervalMs;
  /** @type {number} */
  #recordsSinceFlush;
  /** @type {number} */
  #lastFlushAt;
  /** @type {Promise<void> | null} */
  #flushInFlight;

  constructor({
    path = defaultStatsPath(),
    ringSize = DEFAULT_RING_SIZE,
    flushEveryN = DEFAULT_FLUSH_EVERY_N,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  } = {}) {
    this.#path = path;
    this.#tools = Object.create(null);
    this.#ringSize = ringSize;
    this.#flushEveryN = flushEveryN;
    this.#flushIntervalMs = flushIntervalMs;
    this.#recordsSinceFlush = 0;
    this.#lastFlushAt = 0;
    this.#flushInFlight = null;
  }

  /**
   * Synchronous load — best-effort. If the file doesn't exist or is
   * corrupt, start fresh. Caller decides when to call this (usually
   * once at session boot).
   */
  loadSync() {
    try {
      if (!existsSync(this.#path)) return;
      const raw = readFileSync(this.#path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.tools && typeof parsed.tools === 'object') {
        for (const [name, rec] of Object.entries(parsed.tools)) {
          if (!rec || typeof rec !== 'object') continue;
          this.#tools[name] = readToolRecord(rec, this.#ringSize);
        }
      }
    } catch {
      // Best-effort: a corrupt file shouldn't crash the agent. Start fresh.
    }
  }

  /**
   * Async load — alternative to loadSync for code paths that prefer
   * async I/O. Same best-effort semantics.
   */
  async load() {
    try {
      if (!existsSync(this.#path)) return;
      const raw = await fsp.readFile(this.#path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.tools && typeof parsed.tools === 'object') {
        for (const [name, rec] of Object.entries(parsed.tools)) {
          if (!rec || typeof rec !== 'object') continue;
          this.#tools[name] = readToolRecord(rec, this.#ringSize);
        }
      }
    } catch {
      // Best-effort.
    }
  }

  /**
   * Record a single tool execution. Updates in-memory counters and
   * may trigger a throttled persist.
   *
   * `errorCode` is optional structured metadata; `isError` alone controls
   * failure accounting. Category extraction never changes that outcome.
   *
   * @param {{ name: string, durationMs?: number, isError?: boolean, errorMessage?: string|null, errorCode?: string|null }} args
   */
  record({ name, durationMs = 0, isError = false, errorMessage = null, errorCode = null } = {}) {
    if (typeof name !== 'string' || !name) return;
    const dur = Math.max(0, Number(durationMs) || 0);
    let rec = this.#tools[name];
    if (!rec) {
      rec = emptyToolRecord();
      this.#tools[name] = rec;
    }
    rec.callCount += 1;
    rec.totalDurationMs += dur;
    rec.durations.push(dur);
    if (rec.durations.length > this.#ringSize) {
      rec.durations.splice(0, rec.durations.length - this.#ringSize);
    }
    rec.lastCalledAt = new Date().toISOString();
    rec.recentOutcomes.push(isError ? errorReason(errorMessage, errorCode) : null);
    if (rec.recentOutcomes.length > RECENT_WINDOW_SIZE) {
      rec.recentOutcomes.splice(0, rec.recentOutcomes.length - RECENT_WINDOW_SIZE);
    }
    if (isError) {
      rec.errorCount += 1;
      if (typeof errorMessage === 'string' && errorMessage) {
        rec.lastError = errorMessage.slice(0, 500);
      }
    }
    this.#recordsSinceFlush += 1;
    this.#maybeFlush();
  }

  #maybeFlush() {
    const now = Date.now();
    const stale = now - this.#lastFlushAt >= this.#flushIntervalMs;
    const overflow = this.#recordsSinceFlush >= this.#flushEveryN;
    if (!stale && !overflow) return;
    // If a write is already in flight, skip — the in-memory state is
    // ahead of disk, but #recordsSinceFlush will trigger the next overflow.
    if (this.#flushInFlight) return;
    this.#startFlush();
  }

  /**
   * Persist current state. Writes atomically via .tmp + rename.
   *
   * Coalesces with any in-flight throttled flush — first awaits it (the
   * in-flight write captured a *snapshot* taken before this call, so it
   * may not include the latest record), then schedules a fresh singleton
   * flush so the on-disk state matches the in-memory state at the moment
   * this method resolves. `#flushInFlight` is the only path that ever
   * opens a writer on `${path}.tmp`, so two writers never race.
   */
  async flush() {
    if (this.#flushInFlight) {
      try { await this.#flushInFlight; } catch { /* swallow */ }
    }
    this.#startFlush();
    try { await this.#flushInFlight; } catch { /* swallow */ }
  }

  #startFlush() {
    this.#flushInFlight = this.#doFlush().catch(() => {
      // Persisted-write failures are non-fatal: in-memory state is the
      // source of truth for the current session.
    }).finally(() => {
      this.#flushInFlight = null;
    });
  }

  async #doFlush() {
    const payload = {
      schema: SCHEMA_VERSION,
      writtenAt: new Date().toISOString(),
      tools: this.#tools,
    };
    const json = JSON.stringify(payload, null, 2);
    // Capture the records-since-flush count at write-start. Any records
    // that land during the async write must still count toward the next
    // overflow trigger, so we subtract only what we actually persisted —
    // not whatever value `#recordsSinceFlush` happens to be when rename
    // returns.
    const flushedCount = this.#recordsSinceFlush;
    const dir = dirname(this.#path);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      // mkdir failure (perm denied, etc.) — abort silently.
      return;
    }
    const tmpPath = `${this.#path}.tmp`;
    try {
      await fsp.writeFile(tmpPath, json, 'utf8');
      await fsp.rename(tmpPath, this.#path);
      this.#lastFlushAt = Date.now();
      this.#recordsSinceFlush = Math.max(0, this.#recordsSinceFlush - flushedCount);
    } catch {
      // Try to clean the tmp file if it dangling.
      try { await fsp.unlink(tmpPath); } catch { /* swallow */ }
    }
  }

  /**
   * Snapshot for CLI/UI rendering. Existing counters/errorRate remain lifetime
   * values; recent is based only on recorded outcomes, never historical totals.
   * Its reason counters sum to recent.errorCount and its rate is null when
   * there are no samples (including legacy files with no recentOutcomes).
   *
   * @returns {Record<string, {callCount: number, errorCount: number, errorRate: number, avgMs: number, p50Ms: number, p95Ms: number, lastCalledAt: string|null, lastError: string|null, recent: {windowSize: number, callCount: number, errorCount: number, errorRate: number|null, errorReasons: Record<string, number>}}> }
   */
  snapshot() {
    /** @type {Record<string, any>} */
    const out = Object.create(null);
    for (const [name, rec] of Object.entries(this.#tools)) {
      const sorted = rec.durations.slice().sort((a, b) => a - b);
      const avg = rec.callCount > 0 ? rec.totalDurationMs / rec.callCount : 0;
      const errorReasons = Object.create(null);
      let recentErrors = 0;
      for (const reason of rec.recentOutcomes) {
        if (reason === null) continue;
        recentErrors += 1;
        errorReasons[reason] = (errorReasons[reason] || 0) + 1;
      }
      const recentCalls = rec.recentOutcomes.length;
      out[name] = {
        callCount: rec.callCount,
        errorCount: rec.errorCount,
        errorRate: rec.callCount > 0 ? rec.errorCount / rec.callCount : 0,
        avgMs: Math.round(avg),
        p50Ms: Math.round(percentile(sorted, 50)),
        p95Ms: Math.round(percentile(sorted, 95)),
        lastCalledAt: rec.lastCalledAt,
        lastError: rec.lastError,
        recent: {
          windowSize: RECENT_WINDOW_SIZE,
          callCount: recentCalls,
          errorCount: recentErrors,
          errorRate: recentCalls > 0 ? recentErrors / recentCalls : null,
          errorReasons,
        },
      };
    }
    return out;
  }

  /**
   * From a list of registered tool names, return the ones that have
   * NEVER been recorded (call count == 0 or absent). Useful for the
   * `yeaft-stats --unused` CLI mode — surfaces dead/defined-but-unused
   * tools.
   *
   * @param {string[]} registeredNames
   * @returns {string[]}
   */
  getRegisteredButUncalled(registeredNames) {
    if (!Array.isArray(registeredNames)) return [];
    const out = [];
    for (const name of registeredNames) {
      const rec = this.#tools[name];
      if (!rec || rec.callCount === 0) out.push(name);
    }
    return out.sort();
  }

  /** Path used for persistence — for tests / CLI display. */
  get path() {
    return this.#path;
  }

  /**
   * Reset everything — clears in-memory counters and removes the file.
   * Used by the `yeaft-stats --reset` CLI mode.
   */
  async reset() {
    this.#tools = Object.create(null);
    this.#recordsSinceFlush = 0;
    this.#lastFlushAt = 0;
    try { await fsp.unlink(this.#path); } catch { /* swallow */ }
  }
}

export default ToolUsageStats;
