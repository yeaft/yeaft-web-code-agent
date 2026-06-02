/**
 * jsonl-log.js — Append-only JSONL log with size-based rotation.
 *
 * task-334o acceptance criterion 1:
 *   - append single-line write < 2ms on local SSD
 *   - rotate at maxSegmentBytes=1 MiB OR maxSegmentLines=5000 (first to hit)
 *   - index.json is atomically updated on every rotation
 *
 * Layout (managed here):
 *   <dir>/000001.jsonl
 *   <dir>/000002.jsonl
 *   <dir>/index.json
 *
 * API:
 *   const log = openLog(dir, { maxSegmentBytes, maxSegmentLines, parseLine });
 *   log.append(obj)              // writes JSON.stringify(obj) + '\n'
 *   log.readRange(firstId, lastId)  // iterable of records in [firstId, lastId]
 *   log.streamAll()              // iterable of all records, oldest -> newest
 *   log.rotate()                 // force rotate (test hook)
 *   log.close()                  // close fd, flush index
 *
 * No business semantics: the log does not know what an id means; it only
 * needs the caller to provide a `parseLine(line) -> {id, ts}` so the index
 * metadata can be rebuilt from disk if index.json is lost or corrupt.
 */

import {
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'fs';
import { join } from 'path';
import {
  loadIndex,
  saveIndex,
  listSegmentFiles,
  statSegmentFromDisk,
  nextSegmentName,
  emptyIndex,
} from './jsonl-index.js';

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB
const DEFAULT_MAX_LINES = 5000;

const defaultParseLine = (line) => {
  const obj = JSON.parse(line);
  return { id: obj.id ?? null, ts: obj.ts ?? null };
};

/**
 * Open (or create) an append-only JSONL log rooted at `dir`.
 * On startup, verifies / rebuilds index.json against files on disk.
 */
export function openLog(dir, opts = {}) {
  const maxSegmentBytes = opts.maxSegmentBytes ?? DEFAULT_MAX_BYTES;
  const maxSegmentLines = opts.maxSegmentLines ?? DEFAULT_MAX_LINES;
  const parseLine = opts.parseLine ?? defaultParseLine;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let index = loadIndex(dir);
  const filesOnDisk = listSegmentFiles(dir);

  // Rebuild index if missing, corrupt, or out-of-sync with actual segment files.
  if (!index || !indexMatchesDisk(index, filesOnDisk)) {
    index = rebuildIndexFromDisk(dir, filesOnDisk, parseLine);
    saveIndex(dir, index);
  }

  // Current segment = last one in the index; create 000001.jsonl if empty.
  let current = index.segments[index.segments.length - 1];
  if (!current) {
    current = {
      file: '000001.jsonl',
      firstId: null, lastId: null,
      firstTs: null, lastTs: null,
      count: 0, bytes: 0,
    };
    index.segments.push(current);
    // Touch the file so the fd is openable.
    const path = join(dir, current.file);
    if (!existsSync(path)) closeSync(openSync(path, 'a'));
  }

  let fd = openSync(join(dir, current.file), 'a');

  /** Detect & perform rotation when current segment is full. */
  function maybeRotate() {
    if (current.bytes >= maxSegmentBytes || current.count >= maxSegmentLines) {
      rotate();
    }
  }

  function rotate() {
    // Close current fd.
    closeSync(fd);
    // Open new segment.
    const newFile = nextSegmentName(index.segments);
    const newSeg = {
      file: newFile,
      firstId: null, lastId: null,
      firstTs: null, lastTs: null,
      count: 0, bytes: 0,
    };
    index.segments.push(newSeg);
    current = newSeg;
    // Persist the rotation atomically before we start writing to the new file
    // so a crash mid-rotation doesn't lose the boundary.
    saveIndex(dir, index);
    fd = openSync(join(dir, current.file), 'a');
  }

  function append(obj) {
    const line = JSON.stringify(obj) + '\n';
    const buf = Buffer.from(line, 'utf8');
    writeSync(fd, buf, 0, buf.length);
    current.count += 1;
    current.bytes += buf.length;
    const id = obj.id ?? null;
    const ts = obj.ts ?? null;
    if (current.firstId === null) current.firstId = id;
    current.lastId = id;
    if (current.firstTs === null) current.firstTs = ts;
    current.lastTs = ts;
    maybeRotate();
  }

  function* streamAll() {
    for (const seg of index.segments) {
      const path = join(dir, seg.file);
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // Skip malformed line — don't crash the read pipeline.
        }
      }
    }
  }

  /** Read records whose id falls in `[firstId, lastId]` inclusive (string or number). */
  function* readRange(firstId, lastId) {
    for (const seg of index.segments) {
      if (!segmentOverlaps(seg, firstId, lastId)) continue;
      const path = join(dir, seg.file);
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const id = obj.id ?? null;
        if (id === null) continue;
        if (idBetween(id, firstId, lastId)) yield obj;
      }
    }
  }

  function setNextId(n) { index.nextId = n; saveIndex(dir, index); }
  function getNextId() { return index.nextId; }
  function getIndex() { return index; }
  function flushIndex() { saveIndex(dir, index); }

  function close() {
    try { closeSync(fd); } catch { /* already closed */ }
    saveIndex(dir, index);
  }

  return {
    append, readRange, streamAll, rotate, close,
    setNextId, getNextId, getIndex, flushIndex,
  };
}

/** True when index's segment list matches exactly the files on disk. */
function indexMatchesDisk(index, filesOnDisk) {
  const indexFiles = index.segments.map((s) => s.file);
  if (indexFiles.length !== filesOnDisk.length) return false;
  for (let i = 0; i < indexFiles.length; i++) {
    if (indexFiles[i] !== filesOnDisk[i]) return false;
  }
  return true;
}

/**
 * Rebuild the index by scanning every segment file on disk. Expensive but
 * only happens on first open or after index.json loss.
 */
function rebuildIndexFromDisk(dir, files, parseLine) {
  const idx = emptyIndex();
  for (const file of files) {
    idx.segments.push(statSegmentFromDisk(dir, file, parseLine));
  }
  return idx;
}

/**
 * Cheap overlap test. If a segment's firstId/lastId are null (empty segment),
 * we treat it as non-overlapping.
 */
function segmentOverlaps(seg, first, last) {
  if (seg.firstId == null || seg.lastId == null) return false;
  // Ordering on strings is lexicographic which matches ULID-style ids used
  // by the product (msg_01HW...). For numeric ids, JS > / < works too.
  return !(compareId(seg.lastId, first) < 0 || compareId(seg.firstId, last) > 0);
}

function idBetween(id, first, last) {
  return compareId(id, first) >= 0 && compareId(id, last) <= 0;
}

function compareId(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
