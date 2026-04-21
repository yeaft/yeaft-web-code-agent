/**
 * recompression.js — task-334f Re-compression hook.
 *
 * Provides `checkRecompression(memoryShardStore)` which inspects each shard's
 * utilization (live entry bytes vs total shard file bytes). When utilization
 * drops below 50% (configurable), the shard is compacted in-place.
 *
 * This is designed to be called:
 *   - After `remove()` calls (which leave tombstone gaps)
 *   - After `supersede()` chains (old entries inflate shard size)
 *   - By dream (334g) on its periodic sweep
 *
 * The hook does NOT make deletion decisions — it only reclaims dead space.
 * Dream owns the "what to delete" logic; this module owns "when to defrag".
 *
 * Reference: §Δ17.5 Compact job / §Δ26.3 soft-cap semantics.
 */

/** Default utilization threshold below which a shard gets compacted. */
export const DEFAULT_UTILIZATION_THRESHOLD = 0.5;

/**
 * Inspect all shards in a memory shard store and compact any whose
 * utilization ratio (live entry bytes / total shard bytes) is below
 * the threshold.
 *
 * @param {object} store — opened via `openMemoryShardStore()`
 * @param {{ threshold?: number }} [opts]
 * @returns {{ compacted: string[], skipped: string[], stats: Record<string, { entries: number, bytes: number, liveBytes: number, utilization: number }> }}
 */
export function checkRecompression(store, opts = {}) {
  if (!store || typeof store.stats !== 'function') {
    return { compacted: [], skipped: [], stats: {} };
  }

  const threshold = opts.threshold ?? DEFAULT_UTILIZATION_THRESHOLD;
  const { shards, count } = store.stats();
  const compacted = [];
  const skipped = [];
  const shardStats = {};

  for (const [name, bucket] of Object.entries(shards)) {
    const totalBytes = bucket.bytes || 0;
    const entryCount = bucket.entries || 0;

    // Estimate live bytes from the index: sum of all entry byteLen for this shard.
    // The inner store's query returns records with meta but not byteLen directly.
    // Use the stats bucket which tracks entry count and total file bytes.
    // A shard with 0 entries but >0 bytes is 0% utilization → compact.
    // A shard with entries but totalBytes=0 is fine (no file yet).
    if (totalBytes === 0) {
      shardStats[name] = { entries: entryCount, bytes: 0, liveBytes: 0, utilization: 1.0 };
      skipped.push(name);
      continue;
    }

    // For utilization, we use inner store's index to sum live entry byte lengths.
    const inner = store._innerForTest;
    let liveBytes = 0;
    if (inner && typeof inner.getIndex === 'function') {
      const index = inner.getIndex();
      for (const rec of index.entries) {
        if (rec.shard === name) liveBytes += (rec.byteLen || 0);
      }
    } else {
      // Fallback: assume fully utilized if we can't inspect
      liveBytes = totalBytes;
    }

    const utilization = liveBytes / totalBytes;
    shardStats[name] = { entries: entryCount, bytes: totalBytes, liveBytes, utilization };

    if (utilization < threshold && entryCount > 0) {
      // Compact via the underlying shard store
      if (inner && typeof inner.compact === 'function') {
        inner.compact(name);
        compacted.push(name);
      }
    } else {
      skipped.push(name);
    }
  }

  return { compacted, skipped, stats: shardStats };
}

/**
 * Check if any shard needs recompression without actually doing it.
 * Returns the list of shard names that would be compacted.
 *
 * @param {object} store
 * @param {{ threshold?: number }} [opts]
 * @returns {string[]} — shard names below utilization threshold
 */
export function needsRecompression(store, opts = {}) {
  if (!store || typeof store.stats !== 'function') return [];

  const threshold = opts.threshold ?? DEFAULT_UTILIZATION_THRESHOLD;
  const { shards } = store.stats();
  const result = [];

  const inner = store._innerForTest;
  if (!inner || typeof inner.getIndex !== 'function') return [];

  const index = inner.getIndex();

  for (const [name, bucket] of Object.entries(shards)) {
    const totalBytes = bucket.bytes || 0;
    if (totalBytes === 0 || (bucket.entries || 0) === 0) continue;

    let liveBytes = 0;
    for (const rec of index.entries) {
      if (rec.shard === name) liveBytes += (rec.byteLen || 0);
    }

    if (liveBytes / totalBytes < threshold) {
      result.push(name);
    }
  }

  return result;
}
