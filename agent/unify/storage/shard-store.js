/**
 * shard-store.js — Schema-aware shard storage on top of shard-index.
 *
 * Stores opaque "entries" across a small number of shard files. Each entry
 * is a chunk of text (typically the serialised body the caller supplies),
 * bracketed by `<!--entry:<id>:START-->` / `<!--entry:<id>:END-->` delimiters.
 *
 * Caller provides a `schema` describing:
 *   - shards      : allowed shard names (open set if undefined)
 *   - softCap     : per-shard { entries, bytes } soft limit
 *   - defaultSoftCap : fallback for shards not explicitly listed
 *
 * API surface (§10 acceptance):
 *   put(entry)            → { id, shard, needsRecompression }
 *   get(id)               → { id, shard, body, meta } | null
 *   query(filter)         → { results: [...], needsRecompression: [shard names] }
 *   remove(id)            → boolean
 *   compact(shardName?)   → rewrites shard(s) to strip tombstone gaps
 *
 * What this module does NOT know:
 *   - What an entry body means (kind, sourceRef, superseded chains...).
 *     It only reads meta fields the caller surfaces through `entry.meta`
 *     for query filtering.
 *   - What a VP, task, group, or message is.
 *   - When to compact. Compaction is a separate primitive called by 334g
 *     (dream). This module only surfaces `needsRecompression` advisory.
 *
 * Soft-cap semantics (acceptance #4):
 *   When a shard exceeds its softCap, operations succeed normally but the
 *   return value carries `needsRecompression: true` (put) or the shard
 *   name is listed in `result.needsRecompression` (query). The store never
 *   auto-compacts in response.
 */

import {
  existsSync,
  readFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { writeAtomic } from './atomic.js';
import {
  loadShardIndex,
  saveShardIndex,
  rebuildShardIndexFromDisk,
  putEntryRecord,
  removeEntryRecord,
  shardFileName,
  START_MARK,
  END_MARK,
  emptyShardIndex,
} from './shard-index.js';

/**
 * Open (or create) a shard store rooted at `dir`.
 * `schema` example:
 *   {
 *     shards: ['skill', 'lessons', 'preferences', 'relations'],
 *     softCap: {
 *       skill:       { entries: 80, bytes: 64 * 1024 },
 *       lessons:     { entries: 80, bytes: 64 * 1024 },
 *     },
 *     defaultSoftCap: { entries: 150, bytes: 128 * 1024 },
 *   }
 */
export function openShardStore(dir, schema = {}) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const shardSchema = normaliseSchema(schema);

  let index = loadShardIndex(dir);
  if (!index || !indexLooksConsistent(dir, index)) {
    index = rebuildShardIndexFromDisk(dir, shardSchema);
    // Preserve meta from the old index if rebuild lost it and we have a
    // readable on-disk frontmatter strategy — out of scope for 334o; callers
    // re-hydrate meta through `refreshMeta()` below if they care.
    saveShardIndex(dir, index);
  }

  /** Write a fresh entry to a shard file, append-style. */
  function put(entry) {
    validateEntry(entry, shardSchema);

    // Remove old copy if same id exists (keeps "put" upsert-like).
    const existing = index.entries.find((e) => e.id === entry.id);
    if (existing) {
      compactShard(existing.shard, [entry.id]);
    }

    const shard = entry.shard;
    const path = join(dir, shardFileName(shard));
    const payload = formatEntry(entry);

    // byteOffset is the size of the file BEFORE we append.
    const byteOffset = existsSync(path) ? statSync(path).size : 0;
    appendFileSync(path, payload);
    const byteLen = Buffer.byteLength(payload, 'utf8');

    putEntryRecord(index, {
      id: entry.id,
      shard,
      byteOffset,
      byteLen,
      meta: sanitiseMeta(entry.meta),
    });
    updateShardStats(index, shard, path);
    saveShardIndex(dir, index);

    return {
      id: entry.id,
      shard,
      needsRecompression: isOverSoftCap(index, shard, shardSchema),
    };
  }

  /** Read one entry by id. Returns null if absent. */
  function get(id) {
    const rec = index.entries.find((e) => e.id === id);
    if (!rec) return null;
    const path = join(dir, shardFileName(rec.shard));
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    // Slice by byte range is approximate for multi-byte UTF-8 — we use the
    // delimiter as the authoritative boundary to stay safe on emoji etc.
    const body = extractBody(raw, id);
    if (body === null) return null;
    return { id, shard: rec.shard, body, meta: rec.meta || {} };
  }

  /**
   * Filter entries in-memory. Filter fields:
   *   shard : string | string[]     exact shard match
   *   kind  : string | string[]     matches meta.kind
   *   tags  : string[]              entry must contain ALL listed tags
   *   pinned: boolean               exact match on meta.pinned
   *   where : (rec) => boolean      escape hatch
   */
  function query(filter = {}) {
    const { shard, kind, tags, pinned, where } = filter;
    const results = [];
    for (const rec of index.entries) {
      if (shard && !matchesOneOf(rec.shard, shard)) continue;
      if (kind && !matchesOneOf(rec.meta?.kind, kind)) continue;
      if (pinned !== undefined && Boolean(rec.meta?.pinned) !== Boolean(pinned)) continue;
      if (tags && tags.length > 0) {
        const recTags = rec.meta?.tags || [];
        if (!tags.every((t) => recTags.includes(t))) continue;
      }
      if (where && !where(rec)) continue;
      results.push(rec);
    }
    // Surface which shards need re-compression so dream can schedule work.
    const over = [];
    for (const name of Object.keys(index.shards)) {
      if (isOverSoftCap(index, name, shardSchema)) over.push(name);
    }
    return { results, needsRecompression: over };
  }

  /** Delete one entry; compacts the shard to reclaim space immediately. */
  function remove(id) {
    const rec = index.entries.find((e) => e.id === id);
    if (!rec) return false;
    compactShard(rec.shard, [id]);
    return true;
  }

  /**
   * Rewrite a shard file, omitting the entries listed in `deleteIds`.
   * Exposed as both the implementation of `remove` and the public compact
   * primitive used by `compact()` (no deletions, just defrag).
   */
  function compactShard(shardName, deleteIds = []) {
    const path = join(dir, shardFileName(shardName));
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    const keepIds = index.entries
      .filter((e) => e.shard === shardName && !deleteIds.includes(e.id))
      .map((e) => e.id);
    const parts = [];
    for (const id of keepIds) {
      const body = extractBody(raw, id);
      if (body === null) continue;
      parts.push(formatEntry({ id, shard: shardName, body, meta: null }));
    }
    writeAtomic(path, parts.join(''));

    // Update in-memory records with their new byte offsets.
    let cursor = 0;
    for (let i = 0; i < keepIds.length; i++) {
      const id = keepIds[i];
      const rec = index.entries.find((e) => e.id === id);
      const part = parts[i];
      const len = Buffer.byteLength(part, 'utf8');
      rec.byteOffset = cursor;
      rec.byteLen = len;
      cursor += len;
    }

    // Drop removed ids from the index entirely.
    for (const id of deleteIds) removeEntryRecord(index, id);

    updateShardStats(index, shardName, path);
    saveShardIndex(dir, index);
  }

  /** Public compact: rewrite one shard (or all) with no deletions. */
  function compact(shardName) {
    if (shardName) return compactShard(shardName, []);
    for (const name of Object.keys(index.shards)) compactShard(name, []);
  }

  /** Allow caller (memory-family) to re-hydrate meta after bulk rebuild. */
  function setMeta(id, meta) {
    const rec = index.entries.find((e) => e.id === id);
    if (!rec) return false;
    rec.meta = sanitiseMeta(meta);
    saveShardIndex(dir, index);
    return true;
  }

  function stats() {
    return structuredClone({ shards: index.shards, count: index.entries.length });
  }

  function getIndex() { return index; }

  return { put, get, query, remove, compact, setMeta, stats, getIndex };
}

// ─── Helpers ────────────────────────────────────────────────────

function normaliseSchema(schema) {
  return {
    shards: Array.isArray(schema.shards) ? schema.shards.slice() : [],
    softCap: schema.softCap || {},
    defaultSoftCap: schema.defaultSoftCap || { entries: 1000, bytes: 10 * 1024 * 1024 },
  };
}

function validateEntry(entry, schema) {
  if (!entry || typeof entry !== 'object') throw new Error('entry must be an object');
  if (!entry.id || typeof entry.id !== 'string') throw new Error('entry.id required (string)');
  if (!/^[A-Za-z0-9_\-]+$/.test(entry.id)) throw new Error('entry.id must be [A-Za-z0-9_-]+');
  if (!entry.shard || typeof entry.shard !== 'string') throw new Error('entry.shard required');
  if (schema.shards.length > 0 && !schema.shards.includes(entry.shard)) {
    // Open shard extension allowed by returning a warning? Spec says shards
    // are fixed — so reject unknown ones. Caller can extend schema.shards[].
    throw new Error(`entry.shard "${entry.shard}" not in schema.shards`);
  }
  if (typeof entry.body !== 'string') throw new Error('entry.body required (string)');
}

function formatEntry({ id, body }) {
  // Leading \n so successive appends stay visually separated even if the
  // previous entry's body didn't end in a newline.
  return `\n${START_MARK(id)}\n${body.replace(/\n+$/, '')}\n${END_MARK(id)}\n`;
}

function extractBody(raw, id) {
  const start = raw.indexOf(START_MARK(id));
  const end = raw.indexOf(END_MARK(id));
  if (start < 0 || end < 0 || end < start) return null;
  const bodyStart = start + START_MARK(id).length;
  return raw.slice(bodyStart, end).replace(/^\n+/, '').replace(/\n+$/, '');
}

function updateShardStats(index, shardName, path) {
  const bucket = index.shards[shardName] || (index.shards[shardName] = {
    entries: 0, bytes: 0, softCap: null,
  });
  bucket.bytes = existsSync(path) ? statSync(path).size : 0;
  bucket.entries = index.entries.filter((e) => e.shard === shardName).length;
}

function isOverSoftCap(index, shardName, schema) {
  const bucket = index.shards[shardName];
  if (!bucket) return false;
  const cap = schema.softCap?.[shardName] || schema.defaultSoftCap;
  if (!cap) return false;
  if (cap.entries != null && bucket.entries > cap.entries) return true;
  if (cap.bytes != null && bucket.bytes > cap.bytes) return true;
  return false;
}

function matchesOneOf(value, needle) {
  if (Array.isArray(needle)) return needle.includes(value);
  return value === needle;
}

function sanitiseMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  // Only allow JSON-safe fields (number/string/boolean/array of those).
  // Anything weird silently dropped so a bad call can't corrupt the index.
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      out[k] = v.slice();
    }
  }
  return out;
}

function indexLooksConsistent(dir, index) {
  if (!index || !Array.isArray(index.entries)) return false;
  // Cheap sanity: each shard listed in index has a file on disk, OR the shard
  // is empty (no entries yet). Caller recomputes sizes next op.
  for (const name of Object.keys(index.shards)) {
    const path = join(dir, shardFileName(name));
    const bucket = index.shards[name];
    if (bucket.entries > 0 && !existsSync(path)) return false;
  }
  return true;
}
