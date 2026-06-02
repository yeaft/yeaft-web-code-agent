/**
 * loop-guard.js — Routing loop protection for task-334d.
 *
 * Prevents two classes of runaway fan-out:
 *
 *   1. Chain depth — a message's `causedBy` chain (A → @B → @C → @A …) must
 *      not exceed a max depth. Each route_forward call stamps the outbound
 *      envelope's `meta.causedBy` with a chain of msgIds, and the guard
 *      rejects when the chain length would exceed MAX_CHAIN_DEPTH (10).
 *
 *   2. Rate throttle — within a sliding window (WINDOW_MS = 5000, default
 *      MAX_HITS_PER_WINDOW = 8), a single (groupId, vpId) target may be
 *      @-forwarded at most N times. On overflow, the forward returns a
 *      `throttled` error and does NOT dispatch. The counter uses a simple
 *      ring (timestamps array) so expired hits are collected on insert.
 *
 * Both limits are per-group-per-target; chains are tracked per msgId root.
 * The guard is a pure in-memory helper — no persistence — because the
 * threat model is one runaway turn storm within a single process tick.
 *
 * Long-running process hygiene (N1, task-334d-followup):
 *   The `hits` Map is keyed by "groupId::vpId" and would otherwise grow
 *   unboundedly over a long session. Two complementary bounds:
 *     - TTL sweep: on each NEW key insert, drop entries whose most
 *       recent hit is older than `ttlMultiplier × windowMs` (default 2×).
 *       Those entries can never throttle anyone regardless — their rate
 *       window is already fully expired. Amortised O(n) but only on new
 *       keys, so normal hot-path cost stays O(1).
 *     - LRU cap: after the TTL sweep, if size > maxKeys (default 1000)
 *       the Map's insertion-order head (oldest-used key) is evicted until
 *       back under the cap. `check()` and `record()` both `touch()` a key
 *       (delete+re-set) so recency is refreshed on every access.
 *   Behavior invariants preserved: the `'all'` broadcast sentinel, the
 *   `now()` injection seam, and the chain-depth check are untouched — only
 *   the eviction path is new.
 *
 * Integration contract (routing/router.js):
 *   - router stamps envelope.meta.causedBy = [...prevChain, currentMsgId]
 *   - router calls `guard.check({ groupId, targetVpId, chain })` BEFORE
 *     calling coordinator.deliver; on `{ ok: false, reason }` returns a
 *     tool-level error.
 *   - on ok=true, router calls `guard.record({ groupId, targetVpId })` to
 *     advance the rate counter.
 */

export const MAX_CHAIN_DEPTH = 10;
export const DEFAULT_WINDOW_MS = 5_000;
export const DEFAULT_MAX_HITS_PER_WINDOW = 8;
export const DEFAULT_MAX_KEYS = 1_000;
export const DEFAULT_TTL_MULTIPLIER = 2;

/**
 * Build a new loop guard. Safe to share across a single web-bridge process.
 *
 * @param {{
 *   maxChainDepth?: number,
 *   windowMs?: number,
 *   maxHitsPerWindow?: number,
 *   maxKeys?: number,                  // N1: LRU cap (default 1000)
 *   ttlMultiplier?: number,            // N1: evict keys idle > ttlMultiplier*windowMs
 *   now?: () => number,                // injectable for tests
 * }} [options]
 */
export function createLoopGuard(options = {}) {
  const maxChainDepth = options.maxChainDepth ?? MAX_CHAIN_DEPTH;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxHits = options.maxHitsPerWindow ?? DEFAULT_MAX_HITS_PER_WINDOW;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const ttlMultiplier = options.ttlMultiplier ?? DEFAULT_TTL_MULTIPLIER;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /** Map<"groupId::vpId", number[]> — sorted ascending timestamps.
   * Map insertion order doubles as LRU recency: touching (delete+set) on
   * every access keeps the oldest-used entry at the front for eviction. */
  const hits = new Map();
  let evictions = 0;

  function key(groupId, vpId) { return `${groupId}::${vpId}`; }

  function trim(arr, cutoff) {
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i += 1;
    if (i > 0) arr.splice(0, i);
  }

  /**
   * Touch a key → move to the Map's insertion tail (most-recently-used).
   * Used on BOTH check() and record() paths so a blocked-but-checked
   * target is kept warm as long as something keeps referencing it.
   */
  function touch(k, arr) {
    hits.delete(k);
    hits.set(k, arr);
  }

  /**
   * Opportunistic TTL sweep: drop keys whose last hit is older than
   * ttlMultiplier × windowMs (i.e. their rate window is fully expired and
   * stale). Called on insert to amortise cleanup across normal traffic,
   * so we never scan on the hot read path.
   */
  function sweepExpired() {
    const ttlCutoff = now() - ttlMultiplier * windowMs;
    for (const [k, arr] of hits) {
      // arr is sorted ascending; the tail is the most-recent hit.
      const last = arr.length > 0 ? arr[arr.length - 1] : -Infinity;
      if (last < ttlCutoff) {
        hits.delete(k);
        evictions += 1;
      }
    }
  }

  /**
   * Enforce the hard LRU cap. Called on insert AFTER sweepExpired so
   * only genuinely hot but stale-enough entries get evicted.
   */
  function enforceCap() {
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
      evictions += 1;
    }
  }

  return {
    /**
     * Check whether a forward to (groupId, vpId) with the supplied causedBy
     * chain is permitted. Does NOT record — call record() after the caller
     * decides to proceed (keeps dry-run / simulation honest).
     *
     * @param {{ groupId:string, targetVpId:string, chain?:string[] }} args
     * @returns {{ ok:true } | { ok:false, reason:'chain_depth_exceeded'|'throttled', detail?:any }}
     */
    check({ groupId, targetVpId, chain = [] }) {
      if (!groupId || !targetVpId) {
        return { ok: false, reason: 'chain_depth_exceeded', detail: { missing: true } };
      }
      if (Array.isArray(chain) && chain.length >= maxChainDepth) {
        return {
          ok: false,
          reason: 'chain_depth_exceeded',
          detail: { depth: chain.length, limit: maxChainDepth },
        };
      }
      const k = key(groupId, targetVpId);
      const arr = hits.get(k);
      if (arr) {
        const cutoff = now() - windowMs;
        trim(arr, cutoff);
        // Refresh LRU recency — a repeatedly-probed hot target should not
        // be evicted just because it never crosses into record().
        touch(k, arr);
        if (arr.length >= maxHits) {
          return {
            ok: false,
            reason: 'throttled',
            detail: { hits: arr.length, limit: maxHits, windowMs },
          };
        }
      }
      return { ok: true };
    },

    /** Record a successful forward — advances the rate counter. */
    record({ groupId, targetVpId }) {
      if (!groupId || !targetVpId) return;
      const k = key(groupId, targetVpId);
      let arr = hits.get(k);
      const creating = !arr;
      if (!arr) {
        arr = [];
        hits.set(k, arr);
      }
      const cutoff = now() - windowMs;
      trim(arr, cutoff);
      arr.push(now());
      // Refresh LRU recency for both existing and new keys.
      touch(k, arr);
      // On *new* key creation, opportunistically clean up: first drop
      // fully-expired entries (cheap, bounds unbounded growth), then
      // enforce the hard cap. Skip on the update path to keep hot-loop
      // cost O(1).
      if (creating) {
        sweepExpired();
        enforceCap();
      }
    },

    /** Snapshot for tests / debug. */
    snapshot() {
      const out = {};
      for (const [k, arr] of hits) out[k] = arr.slice();
      return {
        hits: out,
        maxChainDepth,
        windowMs,
        maxHits,
        maxKeys,
        ttlMultiplier,
        size: hits.size,
        evictions,
      };
    },

    /** Wipe all counters (tests). */
    reset() { hits.clear(); evictions = 0; },
  };
}

/**
 * Build a causedBy chain array from the inbound envelope + the current msgId.
 * Returns a fresh array (no mutation of envelope).
 *
 * @param {any} inboundEnvelope  — envelope that the VP is currently handling
 * @param {string} currentMsgId  — the NEW outbound msg about to be emitted
 */
export function extendCausedBy(inboundEnvelope, currentMsgId) {
  const prev = inboundEnvelope?.msg?.meta?.causedBy;
  const chain = Array.isArray(prev) ? prev.slice() : [];
  // Also include the inbound msgId as the direct cause, if present and not
  // already in the chain.
  const inboundId = inboundEnvelope?.msg?.id;
  if (inboundId && !chain.includes(inboundId)) chain.push(inboundId);
  if (currentMsgId && !chain.includes(currentMsgId)) chain.push(currentMsgId);
  return chain;
}
