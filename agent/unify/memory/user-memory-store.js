/**
 * user-memory-store.js — R6 §Δ29 User-memory store + dream + profile builder.
 *
 * Wraps the R6 shard-store (task-334f) with user-specific semantics:
 *   - 5 shards: profile / preferences / projects / goals / relations
 *   - Storage path: ~/.yeaft/user/memory/
 *   - UserDreamJob: reuses dream-shard.js compact framework
 *   - buildUserProfile(): top-N recall for SEMI-DYNAMIC injection
 *
 * Hard constraints:
 *   - No VP/task memory imports (user memory is orthogonal)
 *   - Never throws from public API — best-effort with console.warn fallback
 */

import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { openMemoryShardStore } from './shard-store.js';
import { USER_SHARDS } from './schema.js';
import { scanShards, runCompactJob } from './dream-shard.js';

/** Default storage root for user memory. */
export const USER_MEMORY_DIR = join(homedir(), '.yeaft', 'user', 'memory');

/** Maximum entries to include in the user_profile prompt segment. */
const PROFILE_TOP_N = 5;

/** Shard priority for profile builder recall (most → least relevant). */
const PROFILE_RECALL_SHARDS = ['profile', 'preferences', 'goals'];

// ─── Lazy singleton ───────────────────────────────────────────

/** @type {ReturnType<typeof openMemoryShardStore> | null} */
let _store = null;

/**
 * Get (or lazily create) the process-singleton user-memory shard store.
 * Returns null on failure (missing dir, permissions, etc.) — caller must
 * handle null gracefully.
 *
 * @param {{ dir?: string }} [opts]
 * @returns {ReturnType<typeof openMemoryShardStore> | null}
 */
export function getUserMemoryStore(opts = {}) {
  if (_store) return _store;
  try {
    const dir = opts.dir || USER_MEMORY_DIR;
    _store = openMemoryShardStore(dir, 'user');
    return _store;
  } catch (err) {
    console.warn('[user-memory-store] failed to open store:', err.message);
    return null;
  }
}

/**
 * Close and reset the singleton. Used by tests.
 */
export function _resetUserMemoryStoreForTest() {
  if (_store) {
    try { _store.close(); } catch { /* ignore */ }
  }
  _store = null;
}

/**
 * Open a fresh (non-singleton) user-memory store at an arbitrary dir.
 * Useful for tests that want isolation.
 */
export function openUserMemoryStore(dir) {
  return openMemoryShardStore(dir, 'user');
}

// ─── Write / Remove ──────────────────────────────────────────

/**
 * Classify user-memory text into a shard based on simple heuristics.
 * Falls back to 'profile' when uncertain.
 *
 * @param {string} text
 * @param {string[]} [tags]
 * @returns {string}
 */
export function classifyUserMemoryShard(text, tags) {
  const lower = (text || '').toLowerCase();
  const tagSet = new Set((tags || []).map(t => t.toLowerCase()));

  // Explicit tag hints
  if (tagSet.has('goal') || tagSet.has('goals')) return 'goals';
  if (tagSet.has('project') || tagSet.has('projects')) return 'projects';
  if (tagSet.has('preference') || tagSet.has('preferences')) return 'preferences';
  if (tagSet.has('relation') || tagSet.has('relations')) return 'relations';
  if (tagSet.has('profile')) return 'profile';

  // Keyword heuristics
  if (/\b(goal|objective|target|aim|aspir|want to|plan to|hope to)\b/i.test(lower)) return 'goals';
  if (/\b(project|repo|codebase|app|application|product)\b/i.test(lower)) return 'projects';
  if (/\b(prefer|like|dislike|style|format|tone|language|dark mode|theme)\b/i.test(lower)) return 'preferences';
  if (/\b(colleague|friend|team|manager|report|partner|contact|person)\b/i.test(lower)) return 'relations';

  return 'profile';
}

/**
 * Ingest a user-memory write. Returns the entryId on success, null on failure.
 *
 * @param {object} store — user-memory shard store
 * @param {{ text: string, tags?: string[], sourceRef?: object }} params
 * @returns {string|null} entryId
 */
export function writeUserMemory(store, { text, tags, sourceRef }) {
  if (!store || !text || typeof text !== 'string' || !text.trim()) return null;
  try {
    const shard = classifyUserMemoryShard(text, tags);
    const id = `um-${randomUUID().slice(0, 12)}`;
    const entry = {
      id,
      shard,
      kind: 'preference', // user-memory entries are preference-kind (no sourceRef required)
      body: text.trim(),
      tags: Array.isArray(tags) ? tags.slice() : [],
      authoredBy: 'user:self',
    };
    store.put(entry);
    return id;
  } catch (err) {
    console.warn('[user-memory-store] write failed:', err.message);
    return null;
  }
}

/**
 * Remove a user-memory entry by id. Returns true on success.
 *
 * @param {object} store
 * @param {string} entryId
 * @returns {boolean}
 */
export function removeUserMemory(store, entryId) {
  if (!store || !entryId) return false;
  try {
    store.remove(entryId);
    return true;
  } catch (err) {
    console.warn('[user-memory-store] remove failed:', err.message);
    return false;
  }
}

// ─── Profile Builder ─────────────────────────────────────────

/**
 * Build the `user_profile` text segment for SEMI-DYNAMIC prompt injection.
 * Reads top-N entries from profile/preferences/goals shards and formats
 * them as a compact bullet list.
 *
 * @param {object} [store] — user-memory shard store (uses singleton if omitted)
 * @param {{ maxEntries?: number }} [opts]
 * @returns {string} — empty string if no user-memory exists
 */
export function buildUserProfile(store, opts = {}) {
  const s = store || getUserMemoryStore();
  if (!s) return '';

  const max = opts.maxEntries || PROFILE_TOP_N;
  const lines = [];

  try {
    for (const shardName of PROFILE_RECALL_SHARDS) {
      if (lines.length >= max) break;
      const { results } = s.query({ shard: shardName });
      // Filter out superseded entries
      const live = results.filter(r => !r.supersededBy);
      // Take most recent first (results are already ordered by storage)
      for (const rec of live) {
        if (lines.length >= max) break;
        const full = s.get(rec.id);
        if (!full || !full.body) continue;
        const body = full.body.trim();
        if (!body) continue;
        lines.push(`- ${body}`);
      }
    }
  } catch (err) {
    console.warn('[user-memory-store] buildUserProfile failed:', err.message);
    return '';
  }

  return lines.join('\n');
}

// ─── Dream Job ───────────────────────────────────────────────

/**
 * Run user-memory dream maintenance (compact low-utilization shards).
 * Reuses dream-shard.js compact framework — no LLM calls needed for
 * user-memory (user-authored entries don't need merge/prune by an LLM;
 * we only compact to reclaim superseded/removed tombstones).
 *
 * @param {{ store?: object, onPhase?: (phase:string, data:any) => void }} [opts]
 * @returns {{ scan: object, compact: object } | null}
 */
export function runUserDreamJob(opts = {}) {
  const store = 'store' in opts ? opts.store : getUserMemoryStore();
  if (!store) return null;

  try {
    const scan = scanShards(store);
    const compact = runCompactJob({
      shardStore: store,
      shardNames: scan.needsCompaction,
      onCompact: opts.onPhase
        ? (shard, r) => opts.onPhase('compact', { shard, ...r })
        : undefined,
    });
    return { scan: { totalEntries: scan.totalEntries, totalBytes: scan.totalBytes }, compact };
  } catch (err) {
    console.warn('[user-memory-store] dream job failed:', err.message);
    return null;
  }
}
