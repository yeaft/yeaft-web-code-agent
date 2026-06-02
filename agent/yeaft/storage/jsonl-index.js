/**
 * jsonl-index.js — Manifest for a jsonl-log directory.
 *
 * The index file tracks which segment files cover which ID/timestamp ranges
 * so `jsonl-log.readRange` can do O(1) segment selection without scanning
 * the whole log. It's rewritten atomically on every rotation.
 *
 * Schema (index.json):
 *   {
 *     version:  1,
 *     nextId:   <number | null>,     // optional — caller-managed id counter
 *     segments: [
 *       { file:"000001.jsonl", firstId, lastId, firstTs, lastTs, count, bytes }
 *     ]
 *   }
 *
 * This module owns ONLY the manifest — it does not read or write the jsonl
 * segments themselves. jsonl-log.js drives rotation and hands us updated
 * segment metadata.
 *
 * No business semantics. "id" and "ts" are opaque; we don't care if they're
 * msg_xxx, mem_xxx, numeric, or empty.
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { writeAtomic } from './atomic.js';

export const INDEX_FILE = 'index.json';
export const INDEX_VERSION = 1;

/** Build an empty manifest. */
export function emptyIndex() {
  return { version: INDEX_VERSION, nextId: null, segments: [] };
}

/**
 * Load the index from `dir/index.json`. Returns `null` if the file is missing,
 * unreadable, or corrupt (caller should rebuild). Does NOT auto-rebuild —
 * the caller decides whether a missing / corrupt index is fatal.
 */
export function loadIndex(dir) {
  const path = join(dir, INDEX_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.segments)) return null;
    return {
      version: parsed.version || INDEX_VERSION,
      nextId: parsed.nextId ?? null,
      segments: parsed.segments,
    };
  } catch {
    return null;
  }
}

/** Atomically persist an index. Creates `dir` if missing. */
export function saveIndex(dir, index) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({
    version: INDEX_VERSION,
    nextId: index.nextId ?? null,
    segments: index.segments,
  }, null, 2);
  writeAtomic(join(dir, INDEX_FILE), payload);
}

/**
 * List *.jsonl segment files in `dir`, sorted lexicographically.
 * Returns names only, not full paths.
 */
export function listSegmentFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^\d+\.jsonl$/.test(n))
    .sort();
}

/**
 * Produce an index entry by reading a segment file off disk. Used when
 * recovering from a missing/corrupt index.json.
 *
 * Caller provides `parseLine(line) -> { id, ts }` so we can populate the
 * firstId/lastId/firstTs/lastTs fields without this module knowing the schema.
 * Malformed lines are skipped (best-effort rebuild).
 */
export function statSegmentFromDisk(dir, fileName, parseLine) {
  const path = join(dir, fileName);
  const bytes = statSync(path).size;
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  let firstId = null, lastId = null, firstTs = null, lastTs = null;
  let count = 0;
  for (const line of lines) {
    let parsed;
    try {
      parsed = parseLine(line);
    } catch {
      continue;
    }
    if (!parsed) continue;
    count++;
    if (firstId === null) firstId = parsed.id ?? null;
    lastId = parsed.id ?? lastId;
    if (firstTs === null) firstTs = parsed.ts ?? null;
    lastTs = parsed.ts ?? lastTs;
  }
  return { file: fileName, firstId, lastId, firstTs, lastTs, count, bytes };
}

/** Pick the highest segment number in `segments` (caller decides next filename). */
export function nextSegmentName(segments) {
  let max = 0;
  for (const seg of segments) {
    const m = /^(\d+)\.jsonl$/.exec(seg.file);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(6, '0') + '.jsonl';
}
