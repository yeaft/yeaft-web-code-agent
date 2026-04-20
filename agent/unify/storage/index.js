/**
 * storage/ — task-334o Storage Layer v1.
 *
 * Business-semantics-free primitives shared by 334b (group messages),
 * 334f (VP memory), 334l (user memory), 334i (migration), 334n (summaries).
 *
 * Modules:
 *   - atomic      : writeAtomic (tmp → rename + fsync)
 *   - jsonl-log   : append-only log with size/line rotation
 *   - jsonl-index : segment manifest for jsonl-log
 *   - shard-store : schema-aware shard storage (get/put/query/remove/compact)
 *   - shard-index : manifest for shard-store
 *   - compact     : external compaction entry point for dream
 *
 * API stability: 334o freezes its public API. Downstream slices must not
 * request new fields — extensions go through `shard-schema.js` versioning
 * (see slice spec §framework §2).
 */

export { writeAtomic, sweepTmp, isTmpPath } from './atomic.js';
export { openLog } from './jsonl-log.js';
export {
  emptyIndex,
  loadIndex,
  saveIndex,
  listSegmentFiles,
  statSegmentFromDisk,
  nextSegmentName,
  INDEX_FILE,
  INDEX_VERSION,
} from './jsonl-index.js';
export { openShardStore } from './shard-store.js';
export {
  emptyShardIndex,
  loadShardIndex,
  saveShardIndex,
  rebuildShardIndexFromDisk,
  shardFileName,
  START_MARK,
  END_MARK,
  SHARD_INDEX_FILE,
  SHARD_INDEX_VERSION,
} from './shard-index.js';
export { runCompact } from './compact.js';
