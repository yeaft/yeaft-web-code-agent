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

/**
 * Build a new loop guard. Safe to share across a single web-bridge process.
 *
 * @param {{
 *   maxChainDepth?: number,
 *   windowMs?: number,
 *   maxHitsPerWindow?: number,
 *   now?: () => number,   // injectable for tests
 * }} [options]
 */
export function createLoopGuard(options = {}) {
  const maxChainDepth = options.maxChainDepth ?? MAX_CHAIN_DEPTH;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxHits = options.maxHitsPerWindow ?? DEFAULT_MAX_HITS_PER_WINDOW;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /** Map<"groupId::vpId", number[]> — sorted ascending timestamps. */
  const hits = new Map();

  function key(groupId, vpId) { return `${groupId}::${vpId}`; }

  function trim(arr, cutoff) {
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i += 1;
    if (i > 0) arr.splice(0, i);
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
      if (!arr) {
        arr = [];
        hits.set(k, arr);
      }
      const cutoff = now() - windowMs;
      trim(arr, cutoff);
      arr.push(now());
    },

    /** Snapshot for tests / debug. */
    snapshot() {
      const out = {};
      for (const [k, arr] of hits) out[k] = arr.slice();
      return { hits: out, maxChainDepth, windowMs, maxHits };
    },

    /** Wipe all counters (tests). */
    reset() { hits.clear(); },
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
