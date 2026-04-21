/**
 * schema.js — task-334f R6 Memory schema constants.
 *
 * References:
 *   §Δ22 Memory 本质定性 (6 公理)
 *   §Δ23 Memory Entry Schema 扩字段
 *   §Δ25 Shard 语义初始分类
 *   §Δ26.3 Shard 软上限
 *
 * This module is **data only** — no I/O, no LLM calls. It is safe to import
 * from any layer (store, recall, tools) without circular hazards.
 */

// ─── §Δ25.1 VP-memory default shard set ─────────────────────────
export const VP_DEFAULT_SHARDS = Object.freeze([
  'skill',
  'relations',
  'lessons',
  'preferences',
]);

// ─── §Δ25.2 Task-memory fixed 5 shards ──────────────────────────
export const TASK_SHARDS = Object.freeze([
  'decision',
  'progress',
  'context',
  'blocker',
  'artifact',
]);

// ─── §Δ25.3 User-memory default shard set ───────────────────────
export const USER_SHARDS = Object.freeze([
  'profile',
  'preferences',
  'projects',
  'goals',
  'relations',
]);

/**
 * §Δ26.3 soft-cap table. `project-<slug>` is matched via the dedicated
 * helper `softCapFor()` below because its key is dynamic.
 *
 * Shape: { entries: number, bytes: number }
 */
export const SOFT_CAPS = Object.freeze({
  // VP
  skill:       { entries: 80,  bytes: 64 * 1024 },
  lessons:     { entries: 80,  bytes: 64 * 1024 },
  preferences: { entries: 80,  bytes: 64 * 1024 },
  relations:   { entries: 50,  bytes: 32 * 1024 },
  // Task (Δ26.3 task-memory row)
  decision: { entries: 40, bytes: 24 * 1024 },
  progress: { entries: 40, bytes: 24 * 1024 },
  context:  { entries: 40, bytes: 24 * 1024 },
  blocker:  { entries: 40, bytes: 24 * 1024 },
  artifact: { entries: 40, bytes: 24 * 1024 },
  // User (Δ26.3 user-memory row — 60 entries / 48 KiB per shard)
  profile:  { entries: 60, bytes: 48 * 1024 },
  projects: { entries: 60, bytes: 48 * 1024 },
  goals:    { entries: 60, bytes: 48 * 1024 },
});

/** Project shards are dynamic: `project-<slug>` → 150 entries / 128 KiB. */
export const PROJECT_SHARD_SOFT_CAP = Object.freeze({
  entries: 150,
  bytes: 128 * 1024,
});

/** Default cap if callers ask for a shard not in the canonical set. */
export const DEFAULT_SOFT_CAP = Object.freeze({
  entries: 80,
  bytes: 64 * 1024,
});

/**
 * Trigger threshold: when a dream sweep finds ≥ PROJECT_DERIVE_THRESHOLD
 * memory entries tagged with the same groupId, it may derive a
 * `project-<slug>` shard. (§Δ25.1)
 */
export const PROJECT_DERIVE_THRESHOLD = 30;

/**
 * Max number of VP-memory shards — re-compression kicks in when exceeded
 * (§Δ25.1: "最大 shard 数软上限 12").
 */
export const MAX_VP_SHARDS = 12;

/**
 * Return the soft cap for a given shard name.
 * Handles the dynamic `project-<slug>` case.
 */
export function softCapFor(shardName) {
  if (typeof shardName !== 'string' || !shardName) return DEFAULT_SOFT_CAP;
  if (shardName.startsWith('project-')) return PROJECT_SHARD_SOFT_CAP;
  return SOFT_CAPS[shardName] || DEFAULT_SOFT_CAP;
}

/**
 * Build a schema object suitable for `openShardStore(dir, schema)` (334o).
 *
 * @param {'vp'|'task'|'user'} kind
 * @param {{ extraShards?: string[] }} [opts]  e.g. existing project shards
 * @returns {{ shards: string[], softCap: Record<string,{entries:number,bytes:number}>, defaultSoftCap: object }}
 */
export function buildShardSchema(kind, opts = {}) {
  let shards;
  switch (kind) {
    case 'vp':   shards = [...VP_DEFAULT_SHARDS]; break;
    case 'task': shards = [...TASK_SHARDS]; break;
    case 'user': shards = [...USER_SHARDS]; break;
    default: throw new Error(`buildShardSchema: unknown kind "${kind}"`);
  }
  if (Array.isArray(opts.extraShards)) {
    for (const s of opts.extraShards) {
      if (typeof s === 'string' && s && !shards.includes(s)) shards.push(s);
    }
  }
  const softCap = {};
  for (const s of shards) softCap[s] = softCapFor(s);
  return {
    shards,
    softCap,
    defaultSoftCap: DEFAULT_SOFT_CAP,
  };
}

/**
 * R6 memory-entry authored-by enum (§Δ23).
 * Free-form strings are allowed; these are canonical examples.
 */
export const AUTHORED_BY = Object.freeze({
  VP:             (vpId) => `vp:${vpId}`,
  USER:           (uid)  => `user:${uid}`,
  SUMMARY:        'system:summary-extractor',
  DREAM:          'system:dream',
});

/**
 * Validate an R6 entry shape (schema-level, no I/O).
 * Throws on structural violation. Callers that want soft warnings should
 * wrap in try/catch.
 */
export function validateR6Entry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('entry must be an object');
  if (!entry.id || typeof entry.id !== 'string') throw new Error('entry.id required');
  if (!entry.shard || typeof entry.shard !== 'string') throw new Error('entry.shard required');
  if (!entry.kind || typeof entry.kind !== 'string') throw new Error('entry.kind required');
  // sourceRef is required except for identity/preference pure-declaration entries.
  const needsSourceRef = !(entry.kind === 'identity' || entry.kind === 'preference');
  if (needsSourceRef) {
    if (!entry.sourceRef || typeof entry.sourceRef !== 'object') {
      throw new Error('entry.sourceRef required for kind=' + entry.kind);
    }
    if (!Array.isArray(entry.sourceRef.msgIds) || entry.sourceRef.msgIds.length === 0) {
      throw new Error('entry.sourceRef.msgIds required (non-empty array)');
    }
  }
  if (entry.supersedes != null && !Array.isArray(entry.supersedes)) {
    throw new Error('entry.supersedes must be an array when present');
  }
  if (entry.supersededBy != null && typeof entry.supersededBy !== 'string') {
    throw new Error('entry.supersededBy must be a string when present');
  }
  return true;
}
