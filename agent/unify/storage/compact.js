/**
 * compact.js — External compaction entry point for 334g (dream).
 *
 * `runCompact({ dir, threshold, schema })` opens a shard store at `dir`,
 * inspects each shard for softCap breach, and rewrites shard files that
 * need it. Unlike the internal `compactShard` used by `remove()`, this is
 * the call dream uses to periodically reclaim space across the whole store.
 *
 * This module does NOT:
 *   - decide what's stale enough to delete (that's dream's job, using
 *     `supersededBy` chains)
 *   - re-score or re-rank entries
 *   - touch memory files belonging to other stores (it only touches `dir`)
 *
 * Parameters:
 *   dir       : shard-store directory
 *   schema    : shard schema (shards[], softCap)
 *   threshold : optional override — compact any shard where
 *               entries >= threshold.entries || bytes >= threshold.bytes
 *               (if omitted, uses the schema's softCap)
 *   deleteIds : optional array of ids that dream has decided to purge
 *               (lets dream do "compact + delete" in one pass)
 *
 * Returns:
 *   { compacted: [shardName, ...], deleted: [id, ...], stillOver: [shardName, ...] }
 */

import { openShardStore } from './shard-store.js';

export async function runCompact({ dir, schema = {}, threshold, deleteIds = [] } = {}) {
  if (!dir) throw new Error('runCompact: dir required');
  const store = openShardStore(dir, schema);
  const stats = store.stats();
  const compacted = [];
  const deleted = [];
  const stillOver = [];

  // First pass: honour explicit deletions (dream hands us a hitlist).
  const byShard = new Map();
  for (const id of deleteIds) {
    const entry = store.getIndex().entries.find((e) => e.id === id);
    if (!entry) continue;
    const list = byShard.get(entry.shard) || [];
    list.push(id);
    byShard.set(entry.shard, list);
  }

  for (const [shardName] of byShard) {
    // Use public remove() which already calls the internal compacter.
    for (const id of byShard.get(shardName)) {
      if (store.remove(id)) deleted.push(id);
    }
    compacted.push(shardName);
  }

  // Second pass: defrag shards whose size still exceeds the threshold.
  const thr = threshold || {};
  for (const shardName of Object.keys(stats.shards)) {
    if (compacted.includes(shardName)) continue;
    const bucket = store.stats().shards[shardName];
    if (!bucket) continue;
    const cap = thr.entries != null || thr.bytes != null
      ? thr
      : (schema.softCap?.[shardName] || schema.defaultSoftCap);
    if (!cap) continue;
    const overEntries = cap.entries != null && bucket.entries > cap.entries;
    const overBytes = cap.bytes != null && bucket.bytes > cap.bytes;
    if (overEntries || overBytes) {
      store.compact(shardName);
      compacted.push(shardName);
      // Re-read stats after compaction; if still over, surface to caller.
      const newBucket = store.stats().shards[shardName];
      if (newBucket.entries > (cap.entries ?? Infinity) || newBucket.bytes > (cap.bytes ?? Infinity)) {
        stillOver.push(shardName);
      }
    }
  }

  return { compacted, deleted, stillOver };
}
