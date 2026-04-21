/**
 * shard-store.js — task-334f R6 semantic-shard memory store (VP/task/user).
 *
 * This sits ON TOP OF 334o's `storage/shard-store.js` primitive. It adds:
 *   - R6 entry schema (shard / sourceRef / supersedes / supersededBy / authoredBy)
 *   - Frontmatter body serialisation (markdown-friendly, grep-able on disk)
 *   - Supersede chain management (Δ26.2 Phase B)
 *   - Atomic re-compression handoff (`memory-<shard>.md.compacting`)
 *   - Migration stub from legacy R5 `memory-NNN.md` → semantic shards (334i)
 *
 * Hard boundaries (task-334f guardrails):
 *   - does NOT touch 334o's jsonl-log layer
 *   - does NOT run dream extract / re-compression decisions (334g)
 *   - does NOT implement user-memory business logic (334l reuses this lib)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { openShardStore, writeAtomic } from '../storage/index.js';
import {
  rebuildShardIndexFromDisk,
  saveShardIndex,
} from '../storage/shard-index.js';
import {
  buildShardSchema,
  softCapFor,
  PROJECT_DERIVE_THRESHOLD,
  MAX_VP_SHARDS,
  validateR6Entry,
  AUTHORED_BY,
} from './schema.js';

const COMPACTING_SUFFIX = '.compacting';

/**
 * Open (or create) an R6 memory shard store rooted at `dir`.
 *
 * @param {string} dir   filesystem directory (e.g. `~/.yeaft/memory/vp/<vpId>`)
 * @param {'vp'|'task'|'user'} kind
 * @param {{ extraShards?: string[] }} [opts]
 * @returns {object} handle with put/get/query/remove/compact/...
 */
export function openMemoryShardStore(dir, kind = 'vp', opts = {}) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Hydrate any pre-existing project-* shards from disk so the schema
  // allow-list recognises them on this open.
  const extraShards = new Set(opts.extraShards || []);
  for (const name of discoverOnDiskShards(dir)) {
    if (!extraShards.has(name)) extraShards.add(name);
  }
  const schema = buildShardSchema(kind, { extraShards: [...extraShards] });
  const inner = openShardStore(dir, schema);

  /**
   * Put an R6 entry. Merges the rich entry schema into `body` (frontmatter)
   * and surfaces the 5 filter-worthy fields through `meta`.
   */
  function put(entry) {
    validateR6Entry(entry);
    const body = serialiseR6Body(entry);
    const meta = pickMeta(entry);
    const res = inner.put({
      id: entry.id,
      shard: entry.shard,
      body,
      meta,
    });
    return res;
  }

  /** Retrieve an R6 entry (returns the parsed frontmatter + body). */
  function get(id) {
    const raw = inner.get(id);
    if (!raw) return null;
    const parsed = parseR6Body(raw.body);
    return {
      ...parsed,
      id: raw.id,
      shard: raw.shard,
      _meta: raw.meta || {},
    };
  }

  /** Query. See storage/shard-store.js for the filter shape. */
  function query(filter = {}) {
    const res = inner.query(filter);
    return {
      results: res.results.map(mapRecordToThinEntry),
      needsRecompression: res.needsRecompression.slice(),
    };
  }

  /** Remove an entry; underlying shard compacts immediately. */
  function remove(id) { return inner.remove(id); }

  /**
   * Supersede: create a new entry N that replaces olds M[...].
   * Writes N with supersedes=M[...], then marks each M.supersededBy=N.
   * Old entries are NOT removed — they stay for audit / memory_trace.
   */
  function supersede({ newEntry, oldIds }) {
    validateR6Entry(newEntry);
    if (!Array.isArray(oldIds) || oldIds.length === 0) {
      throw new Error('supersede: oldIds required (non-empty)');
    }
    const supersedes = oldIds.slice();
    const write = { ...newEntry, supersedes };
    const r = put(write);

    for (const oldId of oldIds) {
      const existing = get(oldId);
      if (!existing) continue;
      const updated = { ...existing, supersededBy: newEntry.id };
      put(updated);
    }
    return r;
  }

  /**
   * Atomic re-compression handoff:
   * caller writes the new shard body to `memory-<shard>.md.compacting`,
   * then calls `commitRecompression(shard)` which atomically renames it
   * over the live file. Readers always see either the old or the new file.
   *
   * Consumers (334g dream) build the new body themselves; we just manage
   * the rename + stats recomputation.
   */
  function stageRecompression(shardName, newBody) {
    const tmpPath = join(dir, `memory-${shardName}.md${COMPACTING_SUFFIX}`);
    writeAtomic(tmpPath, newBody);
    return tmpPath;
  }

  function commitRecompression(shardName) {
    const livePath = join(dir, `memory-${shardName}.md`);
    const tmpPath = join(dir, `memory-${shardName}.md${COMPACTING_SUFFIX}`);
    if (!existsSync(tmpPath)) {
      throw new Error(`commitRecompression: no tmp file at ${tmpPath}`);
    }
    renameSync(tmpPath, livePath);
    // The caller-supplied body replaced the whole shard. The old index rows
    // for this shard are stale (new ids / offsets). Rebuild that shard's
    // index rows from disk by delegating to the storage primitive — it walks
    // START/END markers and recomputes offsets. We keep other shards intact.
    const schema = buildShardSchema(kind, { extraShards: [...extraShards] });
    const rebuilt = rebuildShardIndexFromDisk(dir, schema);
    const innerIndex = inner.getIndex();
    // Swap this shard's rows + bucket.
    innerIndex.entries = innerIndex.entries.filter(e => e.shard !== shardName)
      .concat(rebuilt.entries.filter(e => e.shard === shardName));
    if (rebuilt.shards[shardName]) {
      innerIndex.shards[shardName] = rebuilt.shards[shardName];
    }
    saveShardIndex(dir, innerIndex);
  }

  function abortRecompression(shardName) {
    const tmpPath = join(dir, `memory-${shardName}.md${COMPACTING_SUFFIX}`);
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }

  /** Return shard-level stats (byte count, entry count, soft cap). */
  function stats() {
    const raw = inner.stats();
    const shards = {};
    for (const [name, bucket] of Object.entries(raw.shards)) {
      shards[name] = { ...bucket, softCap: softCapFor(name) };
    }
    return { shards, count: raw.count };
  }

  /**
   * Hint for the dream layer — returns `project-<slug>` candidate when
   * ≥ PROJECT_DERIVE_THRESHOLD entries share a groupId and no project
   * shard exists for that slug yet. Returns `null` otherwise.
   *
   * The actual derive (creating the shard file + re-compressing entries
   * into it) is 334g dream work; this slice only advertises the hint so
   * dream can schedule.
   */
  function projectDeriveHint() {
    const groupCounts = new Map();
    const { results } = inner.query({});
    for (const rec of results) {
      const gid = rec.meta?.groupId;
      if (!gid) continue;
      groupCounts.set(gid, (groupCounts.get(gid) || 0) + 1);
    }
    for (const [gid, count] of groupCounts) {
      if (count < PROJECT_DERIVE_THRESHOLD) continue;
      const slug = slugify(gid);
      const shardName = `project-${slug}`;
      const shardNames = Object.keys(inner.stats().shards);
      if (shardNames.includes(shardName)) continue;
      if (shardNames.length >= MAX_VP_SHARDS) continue;
      return { groupId: gid, shard: shardName, count };
    }
    return null;
  }

  function close() { /* underlying store is stateless (index saved on every op) */ }

  return {
    put,
    get,
    query,
    remove,
    supersede,
    stageRecompression,
    commitRecompression,
    abortRecompression,
    stats,
    projectDeriveHint,
    close,
    _innerForTest: inner,
  };
}

// ─── Serialisation ──────────────────────────────────────────────

function serialiseR6Body(entry) {
  const fm = ['---'];
  fm.push(`id: ${entry.id}`);
  if (entry.vp) fm.push(`vp: ${entry.vp}`);
  if (entry.taskId) fm.push(`taskId: ${entry.taskId}`);
  fm.push(`kind: ${entry.kind}`);
  fm.push(`shard: ${entry.shard}`);
  if (entry.sourceRef) {
    fm.push('sourceRef:');
    if (entry.sourceRef.groupId)     fm.push(`  groupId: ${entry.sourceRef.groupId}`);
    if (entry.sourceRef.taskId)      fm.push(`  taskId: ${entry.sourceRef.taskId}`);
    if (Array.isArray(entry.sourceRef.msgIds) && entry.sourceRef.msgIds.length) {
      fm.push(`  msgIds: [${entry.sourceRef.msgIds.join(', ')}]`);
    }
    if (entry.sourceRef.timeWindow)  fm.push(`  timeWindow: ${entry.sourceRef.timeWindow}`);
    if (entry.sourceRef.hint)        fm.push(`  hint: ${JSON.stringify(entry.sourceRef.hint)}`);
  }
  if (Array.isArray(entry.supersedes) && entry.supersedes.length) {
    fm.push(`supersedes: [${entry.supersedes.join(', ')}]`);
  }
  if (entry.supersededBy) fm.push(`supersededBy: ${entry.supersededBy}`);
  if (entry.pinned != null) fm.push(`pinned: ${entry.pinned ? 'true' : 'false'}`);
  if (Array.isArray(entry.tags) && entry.tags.length) {
    fm.push(`tags: [${entry.tags.join(', ')}]`);
  }
  if (entry.authoredBy) fm.push(`authoredBy: ${entry.authoredBy}`);
  const now = new Date().toISOString();
  fm.push(`createdAt: ${entry.createdAt || now}`);
  fm.push(`updatedAt: ${now}`);
  fm.push('---');
  fm.push('');
  fm.push(entry.body || entry.content || '');
  return fm.join('\n');
}

function parseR6Body(raw) {
  if (!raw || !raw.startsWith('---')) return { body: raw || '' };
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return { body: raw };
  const fm = raw.slice(4, endIdx).trim();
  const body = raw.slice(endIdx + 4).replace(/^\n+/, '');
  const out = { body };
  let inSourceRef = false;
  const sourceRef = {};
  for (const line of fm.split('\n')) {
    if (/^sourceRef:\s*$/.test(line)) { inSourceRef = true; continue; }
    if (inSourceRef && /^\s+/.test(line)) {
      const m = line.match(/^\s+(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (k === 'msgIds') {
        sourceRef.msgIds = v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
      } else if (k === 'hint') {
        try { sourceRef.hint = JSON.parse(v); } catch { sourceRef.hint = v; }
      } else {
        sourceRef[k] = v;
      }
      continue;
    }
    inSourceRef = false;
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case 'id':            out.id = v; break;
      case 'vp':            out.vp = v; break;
      case 'taskId':        out.taskId = v; break;
      case 'kind':          out.kind = v; break;
      case 'shard':         out.shard = v; break;
      case 'supersededBy':  out.supersededBy = v; break;
      case 'pinned':        out.pinned = v === 'true'; break;
      case 'authoredBy':    out.authoredBy = v; break;
      case 'createdAt':     out.createdAt = v; break;
      case 'updatedAt':     out.updatedAt = v; break;
      case 'supersedes':
        out.supersedes = v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'tags':
        out.tags = v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
        break;
      default: break;
    }
  }
  if (Object.keys(sourceRef).length > 0) out.sourceRef = sourceRef;
  return out;
}

function pickMeta(entry) {
  // Meta is only the fields the 334o query() layer filters on.
  const meta = {};
  if (entry.kind)   meta.kind = entry.kind;
  if (entry.tags)   meta.tags = entry.tags.slice();
  if (entry.pinned) meta.pinned = true;
  if (entry.sourceRef?.groupId) meta.groupId = entry.sourceRef.groupId;
  if (entry.sourceRef?.taskId)  meta.taskId  = entry.sourceRef.taskId;
  if (entry.supersededBy) meta.supersededBy = entry.supersededBy;
  return meta;
}

function mapRecordToThinEntry(rec) {
  return {
    id: rec.id,
    shard: rec.shard,
    kind: rec.meta?.kind,
    tags: rec.meta?.tags || [],
    pinned: Boolean(rec.meta?.pinned),
    groupId: rec.meta?.groupId,
    taskId: rec.meta?.taskId,
    supersededBy: rec.meta?.supersededBy || null,
  };
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function discoverOnDiskShards(dir) {
  try {
    return readdirSync(dir)
      .filter(f => /^memory-[A-Za-z0-9_-]+\.md$/.test(f))
      .map(f => f.replace(/^memory-/, '').replace(/\.md$/, ''));
  } catch { return []; }
}

// ─── Migration stub (§Δ23 / 334i) ───────────────────────────────

/**
 * Migration stub: map a legacy R5 `memory-NNN.md` shard file path into a
 * semantic shard assignment. Actual batch migration runs in 334i; this
 * slice only defines the classifier API so dependent code can stub it.
 *
 * @param {object} legacyEntry  parsed legacy entry { kind, scope, tags, ... }
 * @returns {string}            semantic shard name ("skill" / "lessons" / ...)
 */
export function classifyLegacyEntryToShard(legacyEntry) {
  if (!legacyEntry || typeof legacyEntry !== 'object') return 'skill';
  const kind = legacyEntry.kind || 'fact';
  switch (kind) {
    case 'lesson':     return 'lessons';
    case 'preference': return 'preferences';
    case 'identity':   return 'preferences';
    case 'relation':   return 'relations';
    case 'skill':      return 'skill';
    default:           return 'skill';
  }
}

export { AUTHORED_BY };
