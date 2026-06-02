/**
 * shard-index.js — Manifest for shard-store.
 *
 * shard-store keeps N shard files (one per schema.shard value) and one
 * `index.json` that maps entry ids → their shard + byte range. This module
 * owns only the manifest; shard-store.js drives writes.
 *
 * Schema (index.json):
 *   {
 *     version: 1,
 *     entries: [{
 *       id, shard,
 *       byteOffset, byteLen,         // byte range inside shard file
 *       meta: { kind?, tags?, pinned?, ...caller-chosen }
 *     }],
 *     shards: {
 *       <name>: { entries: <count>, bytes: <size>, softCap: { entries, bytes } }
 *     }
 *   }
 *
 * entries[] is append-style but we rewrite it atomically on every mutation.
 * At ~thousands of entries this is still cheap (<10 KB JSON) and keeps the
 * read path O(1) — the full index loads into memory on open.
 *
 * If index.json is lost or corrupt, shard-store rebuilds it by scanning the
 * shard markdown files for <!--entry:<id>:START/END--> delimiters.
 */

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { writeAtomic } from './atomic.js';

export const SHARD_INDEX_FILE = 'index.json';
export const SHARD_INDEX_VERSION = 1;

export const START_MARK = (id) => `<!--entry:${id}:START-->`;
export const END_MARK = (id) => `<!--entry:${id}:END-->`;

/** Regex that matches any start or end delimiter. */
const ENTRY_MARK_RE = /<!--entry:([A-Za-z0-9_\-]+):(START|END)-->/g;

export function emptyShardIndex() {
  return { version: SHARD_INDEX_VERSION, entries: [], shards: {} };
}

export function loadShardIndex(dir) {
  const path = join(dir, SHARD_INDEX_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.entries)) return null;
    if (!parsed.shards || typeof parsed.shards !== 'object') return null;
    return {
      version: parsed.version || SHARD_INDEX_VERSION,
      entries: parsed.entries,
      shards: parsed.shards,
    };
  } catch {
    return null;
  }
}

export function saveShardIndex(dir, index) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({
    version: SHARD_INDEX_VERSION,
    entries: index.entries,
    shards: index.shards,
  }, null, 2);
  writeAtomic(join(dir, SHARD_INDEX_FILE), payload);
}

/** Compose the on-disk filename for a shard (schema may customise). */
export function shardFileName(shardName) {
  return `memory-${shardName}.md`;
}

/**
 * Scan shard files in `dir` and rebuild the index entirely from disk.
 * Relies only on the <!--entry:<id>:START/END--> delimiters. Returns a
 * fresh index object. Caller is responsible for populating `meta` again
 * by reading each entry's frontmatter if they need it — this module does
 * not parse the entry body (keeping the store schema-agnostic).
 */
export function rebuildShardIndexFromDisk(dir, schema) {
  const index = emptyShardIndex();
  if (!existsSync(dir)) return index;

  // Preseed shard buckets from the schema so even empty shards show up.
  for (const shardName of schema.shards || []) {
    index.shards[shardName] = {
      entries: 0,
      bytes: 0,
      softCap: schema.softCap?.[shardName] || schema.defaultSoftCap || null,
    };
  }

  for (const name of readdirSync(dir)) {
    if (!name.startsWith('memory-') || !name.endsWith('.md')) continue;
    const shardName = name.slice('memory-'.length, -'.md'.length);
    const path = join(dir, name);
    const body = readFileSync(path, 'utf8');
    const bytes = statSync(path).size;

    // Ensure bucket exists even if schema didn't preseed this shard.
    if (!index.shards[shardName]) {
      index.shards[shardName] = {
        entries: 0,
        bytes,
        softCap: schema.defaultSoftCap || null,
      };
    } else {
      index.shards[shardName].bytes = bytes;
    }

    // Walk START/END pairs. Tolerate out-of-order markers by matching by id.
    const starts = new Map();
    ENTRY_MARK_RE.lastIndex = 0;
    let m;
    while ((m = ENTRY_MARK_RE.exec(body))) {
      const id = m[1];
      const kind = m[2];
      if (kind === 'START') {
        starts.set(id, m.index);
      } else if (kind === 'END' && starts.has(id)) {
        const startIdx = starts.get(id);
        const endIdx = m.index + m[0].length;
        index.entries.push({
          id,
          shard: shardName,
          byteOffset: startIdx,
          byteLen: endIdx - startIdx,
          meta: {},
        });
        index.shards[shardName].entries += 1;
        starts.delete(id);
      }
    }
  }
  return index;
}

/** Upsert (or insert) a single entry record. Mutates `index` in place. */
export function putEntryRecord(index, record) {
  const i = index.entries.findIndex((e) => e.id === record.id);
  if (i >= 0) index.entries[i] = record;
  else index.entries.push(record);
}

/** Remove an entry record by id. Returns the removed record or null. */
export function removeEntryRecord(index, id) {
  const i = index.entries.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const [removed] = index.entries.splice(i, 1);
  return removed;
}
