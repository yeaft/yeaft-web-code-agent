/**
 * dream-shard.js — task-334g Shard-based dream memory maintenance.
 *
 * Replaces the old entries-based dream scanner with shard-aware streaming:
 *   1. Shard scanner: iterate shards → stream entries → build orient/merge/prune inputs
 *   2. Compact job: rewrite shards with utilization < 50% to reclaim tombstones
 *   3. Feature-memory guard: dream NEVER writes to feature-memory shards (avoids double-write)
 *
 * References:
 *   - R5 delta §Δ17.5: compact job spec
 *   - R5 delta §Δ16.4.3: "auto-dream 不写 feature-memory"
 *   - 334f shard-store API: stageRecompression / commitRecompression / abortRecompression
 *   - schema.js: FEATURE_SHARDS, softCapFor
 */

import { FEATURE_SHARDS, softCapFor } from './schema.js';
import { AUTHORED_BY } from './shard-store.js';
import { pickEffort } from '../effort.js';

// ─── Constants ──────────────────────────────────────────────

/** Utilization threshold below which a compact is triggered. */
const COMPACT_UTILIZATION_THRESHOLD = 0.5;

/** Maximum shards to compact in a single dream run (budget control). */
const MAX_COMPACTS_PER_DREAM = 4;

/** Maximum LLM calls for shard-based dream phases. */
const MAX_SHARD_DREAM_LLM_CALLS = 5;

/** Feature-memory shard names — dream must never write to these. */
const FEATURE_SHARD_SET = new Set(FEATURE_SHARDS);

// ─── Feature-Memory Guard ─────────────────────────────────────

/**
 * Returns true if the shard name belongs to feature-memory.
 * Dream must NOT write entries to these shards.
 *
 * @param {string} shardName
 * @returns {boolean}
 */
export function isFeatureMemoryShard(shardName) {
  return FEATURE_SHARD_SET.has(shardName);
}

/**
 * Filter out feature-memory shards from a list of shard names.
 *
 * @param {string[]} shardNames
 * @returns {string[]}
 */
export function filterDreamableShards(shardNames) {
  return shardNames.filter(s => !isFeatureMemoryShard(s));
}

// ─── Shard Scanner ─────────────────────────────────────────

/**
 * Streaming scan of all VP-memory shards via the R6 shard store.
 * Returns a structured summary suitable for dream Orient/Merge/Prune phases.
 *
 * This replaces the old `scanEntries(memoryStore)` which read individual files.
 * Now we go through the shard store's query() API which reads from indexed
 * shard files — much fewer file opens.
 *
 * @param {object} shardStore — opened via openMemoryShardStore()
 * @returns {ShardScanResult}
 */
export function scanShards(shardStore) {
  const st = shardStore.stats();
  const shardNames = Object.keys(st.shards);
  const dreamableShards = filterDreamableShards(shardNames);

  const result = {
    shards: {},
    totalEntries: 0,
    totalBytes: 0,
    supersededCount: 0,
    byKind: {},
    byTags: {},
    needsCompaction: [],
    entries: [],  // thin entries for merge/prune analysis
  };

  for (const shardName of dreamableShards) {
    const bucket = st.shards[shardName];
    if (!bucket) continue;

    const cap = softCapFor(shardName);
    const utilization = computeUtilization(bucket, cap);

    result.shards[shardName] = {
      entries: bucket.entries,
      bytes: bucket.bytes,
      softCap: cap,
      utilization,
    };

    result.totalEntries += bucket.entries;
    result.totalBytes += bucket.bytes;

    // Flag for compaction
    if (utilization < COMPACT_UTILIZATION_THRESHOLD && bucket.entries > 0) {
      result.needsCompaction.push(shardName);
    }
  }

  // Query all entries from dreamable shards to build thin index
  for (const shardName of dreamableShards) {
    const { results } = shardStore.query({ shard: shardName });
    for (const rec of results) {
      const thin = {
        id: rec.id,
        shard: rec.shard,
        kind: rec.kind,
        tags: rec.tags || [],
        pinned: rec.pinned,
        supersededBy: rec.supersededBy || null,
      };

      if (thin.supersededBy) result.supersededCount++;

      // Kind stats
      const k = thin.kind || 'unknown';
      result.byKind[k] = (result.byKind[k] || 0) + 1;

      // Tag stats
      for (const tag of thin.tags) {
        result.byTags[tag] = (result.byTags[tag] || 0) + 1;
      }

      result.entries.push(thin);
    }
  }

  return result;
}

/**
 * Format a shard scan result as a human-readable summary string
 * (used in Orient phase prompt).
 *
 * @param {ShardScanResult} scan
 * @returns {string}
 */
export function formatScanSummary(scan) {
  const lines = [
    `Total entries: ${scan.totalEntries} (${(scan.totalBytes / 1024).toFixed(1)} KiB)`,
    `Superseded: ${scan.supersededCount}`,
    '',
    '### Shards',
  ];

  for (const [name, info] of Object.entries(scan.shards)) {
    const pct = (info.utilization * 100).toFixed(0);
    const flag = info.utilization < COMPACT_UTILIZATION_THRESHOLD ? ' ⚠ needs compact' : '';
    lines.push(`- **${name}**: ${info.entries} entries, ${(info.bytes / 1024).toFixed(1)} KiB, ${pct}% utilization${flag}`);
  }

  lines.push('', '### By Kind');
  for (const [kind, count] of Object.entries(scan.byKind)) {
    lines.push(`- ${kind}: ${count}`);
  }

  if (Object.keys(scan.byTags).length > 0) {
    lines.push('', '### Top Tags');
    const sorted = Object.entries(scan.byTags).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [tag, count] of sorted) {
      lines.push(`- ${tag}: ${count}`);
    }
  }

  if (scan.needsCompaction.length > 0) {
    lines.push('', `### Compaction needed: ${scan.needsCompaction.join(', ')}`);
  }

  return lines.join('\n');
}

// ─── Compact Job ───────────────────────────────────────────

/**
 * Run compaction on shards with low utilization.
 *
 * Compact rewrites a shard file to reclaim space from:
 *   - Superseded entries (entries with supersededBy set)
 *   - Tombstone gaps left by removed entries
 *
 * Uses the 334f stageRecompression/commitRecompression atomic handoff:
 *   1. Read all live entries from the shard
 *   2. Write them to a .compacting temp file via stageRecompression()
 *   3. Atomically rename via commitRecompression()
 *   4. On error, abort via abortRecompression()
 *
 * @param {{
 *   shardStore: object,
 *   shardNames?: string[],
 *   onCompact?: (shard: string, result: CompactResult) => void,
 * }} params
 * @returns {CompactJobResult}
 */
export function runCompactJob({ shardStore, shardNames, onCompact }) {
  const st = shardStore.stats();
  const allShards = Object.keys(st.shards);
  const dreamableShards = filterDreamableShards(allShards);

  // Determine which shards to compact
  const candidates = shardNames
    ? shardNames.filter(s => dreamableShards.includes(s))
    : dreamableShards.filter(s => {
        const bucket = st.shards[s];
        if (!bucket || bucket.entries === 0) return false;
        const cap = softCapFor(s);
        return computeUtilization(bucket, cap) < COMPACT_UTILIZATION_THRESHOLD;
      });

  const result = {
    compacted: [],
    skipped: [],
    errors: [],
  };

  let compactCount = 0;

  for (const shardName of candidates) {
    if (compactCount >= MAX_COMPACTS_PER_DREAM) {
      result.skipped.push(shardName);
      continue;
    }

    try {
      const compactResult = compactShard(shardStore, shardName);
      result.compacted.push({ shard: shardName, ...compactResult });
      onCompact?.(shardName, compactResult);
      compactCount++;
    } catch (err) {
      result.errors.push({ shard: shardName, error: err.message });
      // Ensure we abort any staged compaction
      try { shardStore.abortRecompression(shardName); } catch { /* ignore */ }
    }
  }

  return result;
}

/**
 * Compact a single shard: filter out superseded entries, rebuild the shard file.
 *
 * @param {object} shardStore
 * @param {string} shardName
 * @returns {CompactResult}
 */
function compactShard(shardStore, shardName) {
  const { results } = shardStore.query({ shard: shardName });

  // Partition: live (not superseded) vs superseded
  const live = [];
  const superseded = [];

  for (const rec of results) {
    if (rec.supersededBy) {
      superseded.push(rec.id);
    } else {
      live.push(rec);
    }
  }

  const beforeCount = results.length;
  const afterCount = live.length;
  const removedCount = superseded.length;

  if (removedCount === 0) {
    return { beforeCount, afterCount, removedCount, reclaimedBytes: 0 };
  }

  // Rebuild shard body from live entries only
  const bodyParts = [];
  for (const rec of live) {
    const full = shardStore.get(rec.id);
    if (!full) continue;
    // Re-serialize: the shard-store.js get() returns the parsed entry;
    // we need to call put() to write back. But the atomic recompression
    // approach is: build new body, stage, commit.
    // The body from get() includes the full frontmatter+content serialisation.
    bodyParts.push(full.body || '');
  }

  // Build the new shard body using the same delimiter format
  const newBody = bodyParts.map((body, i) => {
    const id = live[i].id;
    return `\n<!--entry:${id}:START-->\n${body.replace(/\n+$/, '')}\n<!--entry:${id}:END-->\n`;
  }).join('');

  // Use atomic recompression handoff
  const statsBefore = shardStore.stats();
  const bytesBefore = statsBefore.shards[shardName]?.bytes || 0;

  shardStore.stageRecompression(shardName, newBody);
  shardStore.commitRecompression(shardName);

  const statsAfter = shardStore.stats();
  const bytesAfter = statsAfter.shards[shardName]?.bytes || 0;
  const reclaimedBytes = Math.max(0, bytesBefore - bytesAfter);

  return { beforeCount, afterCount, removedCount, reclaimedBytes };
}

// ─── Shard-Based Dream Pipeline ────────────────────────────

/**
 * Run a shard-based dream cycle. This is the 334g replacement for the
 * old `dream()` function's scan/merge/prune phases, using shard-store
 * streaming instead of per-file entry scanning.
 *
 * Phases:
 *   1. Scan — streaming scan of all VP-memory shards
 *   2. Compact — rewrite low-utilization shards
 *   3. Merge — LLM-driven merge of duplicate/superseded entries
 *   4. Prune — LLM-driven removal of stale entries
 *
 * Feature-memory guard: all phases skip FEATURE_SHARDS entirely.
 *
 * @param {{
 *   shardStore: object,
 *   adapter: object,
 *   config: object,
 *   onPhase?: (phase: string, data: any) => void,
 * }} params
 * @returns {Promise<ShardDreamResult>}
 */
export async function dreamShard({ shardStore, adapter, config, onPhase }) {
  const result = {
    scan: null,
    compact: null,
    merge: null,
    prune: null,
    entriesMerged: 0,
    entriesPruned: 0,
    bytesReclaimed: 0,
    errors: [],
  };

  let llmCallsLeft = MAX_SHARD_DREAM_LLM_CALLS;

  try {
    // ── Phase 1: Scan ──────────────────────────────────────
    onPhase?.('scan', 'starting');
    const scan = scanShards(shardStore);
    result.scan = {
      totalEntries: scan.totalEntries,
      totalBytes: scan.totalBytes,
      supersededCount: scan.supersededCount,
      shardCount: Object.keys(scan.shards).length,
      needsCompaction: scan.needsCompaction.slice(),
    };
    onPhase?.('scan', result.scan);

    // ── Phase 2: Compact ───────────────────────────────────
    onPhase?.('compact', 'starting');
    const compactResult = runCompactJob({
      shardStore,
      shardNames: scan.needsCompaction,
      onCompact: (shard, r) => onPhase?.('compact', { shard, ...r }),
    });
    result.compact = compactResult;
    result.bytesReclaimed = compactResult.compacted.reduce(
      (sum, c) => sum + (c.reclaimedBytes || 0), 0
    );
    if (compactResult.errors.length > 0) {
      for (const e of compactResult.errors) {
        result.errors.push(`compact(${e.shard}): ${e.error}`);
      }
    }
    onPhase?.('compact', compactResult);

    // ── Phase 3: Merge (LLM) ──────────────────────────────
    if (llmCallsLeft > 0 && scan.entries.length > 0) {
      onPhase?.('merge', 'starting');
      const mergeResult = await runMergePhase({
        shardStore, scan, adapter, config,
      });
      result.merge = mergeResult;
      result.entriesMerged = mergeResult.mergedCount;
      llmCallsLeft -= mergeResult.llmCalls;
      onPhase?.('merge', mergeResult);
    }

    // ── Phase 4: Prune (LLM) ──────────────────────────────
    if (llmCallsLeft > 0 && scan.entries.length > 0) {
      onPhase?.('prune', 'starting');
      const pruneResult = await runPrunePhase({
        shardStore, scan, adapter, config,
      });
      result.prune = pruneResult;
      result.entriesPruned = pruneResult.prunedCount;
      llmCallsLeft -= pruneResult.llmCalls;
      onPhase?.('prune', pruneResult);
    }

  } catch (err) {
    result.errors.push(err.message);
  }

  return result;
}

// ─── Merge Phase ───────────────────────────────────────────

/**
 * LLM-driven merge: find entries with high overlap and ask LLM to merge.
 *
 * @returns {Promise<{ mergedCount: number, llmCalls: number, merges: object[] }>}
 */
async function runMergePhase({ shardStore, scan, adapter, config }) {
  const result = { mergedCount: 0, llmCalls: 0, merges: [] };

  // Find candidate groups: entries in the same shard with same kind
  const groups = groupByShardAndKind(scan.entries);
  const candidates = [];

  for (const [key, entries] of Object.entries(groups)) {
    if (entries.length < 2) continue;
    // Look for entries with overlapping tags
    const tagOverlaps = findTagOverlaps(entries);
    if (tagOverlaps.length > 0) {
      candidates.push(...tagOverlaps);
    }
  }

  if (candidates.length === 0) return result;

  // Load full bodies for the top candidates (max 5 pairs)
  const toMerge = candidates.slice(0, 5);
  const pairsWithBodies = [];
  for (const pair of toMerge) {
    const a = shardStore.get(pair[0]);
    const b = shardStore.get(pair[1]);
    if (a && b) {
      pairsWithBodies.push({ a, b });
    }
  }

  if (pairsWithBodies.length === 0) return result;

  // Single LLM call to merge all candidates
  const prompt = buildShardMergePrompt(pairsWithBodies);
  const llmResult = await shardDreamLlmCall(adapter, config,
    'You are a memory maintenance assistant. Merge duplicate memory entries. Return JSON.',
    prompt,
  );
  result.llmCalls = 1;

  if (!llmResult?.merges || !Array.isArray(llmResult.merges)) return result;

  for (const merge of llmResult.merges) {
    if (!merge.mergedBody || !merge.keepId || !merge.removeId) continue;
    try {
      // Supersede: keep the winner entry with merged body
      const keeper = shardStore.get(merge.keepId);
      if (!keeper) continue;

      shardStore.supersede({
        newEntry: {
          id: `${merge.keepId}-m${Date.now().toString(36)}`,
          shard: keeper.shard,
          kind: keeper.kind || keeper._meta?.kind || 'skill',
          body: merge.mergedBody,
          tags: keeper.tags || keeper._meta?.tags || [],
          sourceRef: keeper.sourceRef || { msgIds: ['dream-merge'] },
          authoredBy: AUTHORED_BY.DREAM,
        },
        oldIds: [merge.keepId, merge.removeId],
      });

      result.mergedCount++;
      result.merges.push({ keepId: merge.keepId, removeId: merge.removeId });
    } catch (err) {
      // Skip failed merges silently
    }
  }

  return result;
}

// ─── Prune Phase ───────────────────────────────────────────

/**
 * LLM-driven prune: find superseded/stale entries and remove.
 *
 * @returns {Promise<{ prunedCount: number, llmCalls: number, pruned: string[] }>}
 */
async function runPrunePhase({ shardStore, scan, adapter, config }) {
  const result = { prunedCount: 0, llmCalls: 0, pruned: [] };

  // Candidates: superseded entries + entries in over-soft-cap shards
  const superseded = scan.entries.filter(e => e.supersededBy);

  // Auto-prune superseded entries (no LLM needed)
  for (const entry of superseded) {
    try {
      shardStore.remove(entry.id);
      result.prunedCount++;
      result.pruned.push(entry.id);
    } catch { /* skip */ }
  }

  // For non-superseded entries, ask LLM which are stale
  const st = shardStore.stats();
  const overCapShards = [];
  for (const [name, bucket] of Object.entries(st.shards)) {
    if (isFeatureMemoryShard(name)) continue;
    const cap = softCapFor(name);
    if (bucket.entries > cap.entries || bucket.bytes > cap.bytes) {
      overCapShards.push(name);
    }
  }

  if (overCapShards.length === 0) return result;

  // Load entries from over-cap shards for LLM analysis
  const entriesForReview = [];
  for (const shardName of overCapShards) {
    const { results } = shardStore.query({ shard: shardName });
    for (const rec of results) {
      if (rec.pinned) continue; // never prune pinned
      const full = shardStore.get(rec.id);
      if (!full) continue;
      entriesForReview.push({
        id: rec.id,
        shard: rec.shard,
        kind: rec.kind,
        tags: rec.tags,
        body: (full.body || '').slice(0, 300),
      });
    }
  }

  if (entriesForReview.length === 0) return result;

  const prompt = buildShardPrunePrompt(entriesForReview, overCapShards);
  const llmResult = await shardDreamLlmCall(adapter, config,
    'You are a memory pruning assistant. Identify low-value entries to remove. Return JSON.',
    prompt,
  );
  result.llmCalls = 1;

  if (!llmResult?.toRemove || !Array.isArray(llmResult.toRemove)) return result;

  for (const id of llmResult.toRemove) {
    if (typeof id !== 'string') continue;
    // Double-check it's not in a task shard
    const entry = scan.entries.find(e => e.id === id);
    if (entry && isFeatureMemoryShard(entry.shard)) continue;
    try {
      shardStore.remove(id);
      result.prunedCount++;
      result.pruned.push(id);
    } catch { /* skip */ }
  }

  return result;
}

// ─── Helpers ───────────────────────────────────────────────

function computeUtilization(bucket, cap) {
  if (!cap || !bucket) return 1;
  const entryRatio = cap.entries > 0 ? bucket.entries / cap.entries : 0;
  const byteRatio = cap.bytes > 0 ? bucket.bytes / cap.bytes : 0;
  return Math.max(entryRatio, byteRatio);
}

function groupByShardAndKind(entries) {
  const groups = {};
  for (const e of entries) {
    const key = `${e.shard}:${e.kind || 'unknown'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  return groups;
}

function findTagOverlaps(entries) {
  const pairs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (!a.tags.length || !b.tags.length) continue;
      const overlap = a.tags.filter(t => b.tags.includes(t));
      if (overlap.length >= 1) {
        pairs.push([a.id, b.id]);
      }
    }
  }
  return pairs;
}

function buildShardMergePrompt(pairs) {
  const sections = pairs.map((p, i) => {
    return `### Pair ${i + 1}
Entry A (id: ${p.a.id}, shard: ${p.a.shard}):
${(p.a.body || '').slice(0, 500)}

Entry B (id: ${p.b.id}, shard: ${p.b.shard}):
${(p.b.body || '').slice(0, 500)}`;
  }).join('\n\n');

  return `Review these potentially duplicate memory entry pairs and merge where appropriate.

${sections}

For each pair that should be merged, return:
- keepId: the id of the entry to keep (the "better" one)
- removeId: the id of the entry to remove
- mergedBody: the combined content (keep all unique information)

Return JSON:
{
  "merges": [
    { "keepId": "...", "removeId": "...", "mergedBody": "..." }
  ]
}

If entries are NOT duplicates, return empty merges array. Return ONLY valid JSON.`;
}

function buildShardPrunePrompt(entries, overCapShards) {
  const entryLines = entries.map(e =>
    `- id: ${e.id} | shard: ${e.shard} | kind: ${e.kind} | tags: [${(e.tags || []).join(', ')}]\n  ${e.body}`
  ).join('\n');

  return `The following shards are over their soft capacity: ${overCapShards.join(', ')}

Review these entries and identify the LEAST valuable ones to remove (target: reduce each shard to ~80% capacity).

${entryLines}

Criteria for removal:
- Stale or outdated information
- Very low specificity (too generic to be useful)
- Subsumed by other, better entries
- NOT pinned entries (those are protected)

Return JSON:
{
  "toRemove": ["entry-id-1", "entry-id-2", ...],
  "reasoning": "brief explanation"
}

Return ONLY valid JSON.`;
}

async function shardDreamLlmCall(adapter, config, system, prompt) {
  try {
    const result = await adapter.call({
      model: config.model,
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4096,
      effort: pickEffort({ scenario: 'dream' }),
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Types ─────────────────────────────────────────────────

/**
 * @typedef {Object} ShardScanResult
 * @property {Object<string, ShardInfo>} shards
 * @property {number} totalEntries
 * @property {number} totalBytes
 * @property {number} supersededCount
 * @property {Object<string, number>} byKind
 * @property {Object<string, number>} byTags
 * @property {string[]} needsCompaction
 * @property {object[]} entries — thin entry records
 */

/**
 * @typedef {Object} ShardInfo
 * @property {number} entries
 * @property {number} bytes
 * @property {object} softCap
 * @property {number} utilization
 */

/**
 * @typedef {Object} CompactResult
 * @property {number} beforeCount
 * @property {number} afterCount
 * @property {number} removedCount
 * @property {number} reclaimedBytes
 */

/**
 * @typedef {Object} CompactJobResult
 * @property {Array<{shard: string} & CompactResult>} compacted
 * @property {string[]} skipped
 * @property {Array<{shard: string, error: string}>} errors
 */

/**
 * @typedef {Object} ShardDreamResult
 * @property {object} scan
 * @property {CompactJobResult} compact
 * @property {object} merge
 * @property {object} prune
 * @property {number} entriesMerged
 * @property {number} entriesPruned
 * @property {number} bytesReclaimed
 * @property {string[]} errors
 */
