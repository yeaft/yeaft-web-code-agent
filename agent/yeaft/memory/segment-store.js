/**
 * memory/segment-store.js — disk I/O for segment-formatted memory.md.
 *
 * Bridges between the on-disk format (memory.md per scope, multiple
 * segment blocks) and the SQLite segment index. This layer handles
 * scope <-> file path mapping; the index layer is scope-agnostic.
 *
 * Path conventions:
 *   ~/.yeaft/memory/user/memory.md
 *   ~/.yeaft/memory/vp/<id>/memory.md
 *  *   ~/.yeaft/memory/feature/<id>/memory.md
 *   ~/.yeaft/memory/topic/<l1>/memory.md
 *   ~/.yeaft/memory/topic/<l1>/<l2>/memory.md
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, statSync, renameSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { parseSegments, serializeSegments } from './segment.js';

/**
 * Read all segments for a given scope from disk.
 *
 * @param {string} memoryRoot   e.g. ~/.yeaft/memory
 * @param {string} scope
 * @returns {import('./segment.js').Segment[]}
 */
export function readScope(memoryRoot, scope) {
  const path = scopeFilePath(memoryRoot, scope);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return parseSegments(text, { defaultScope: scope });
}

/**
 * Atomically write segments for a scope. Creates the directory if
 * needed. Empty array → empties the file (we keep the file so absence
 * means "scope never existed").
 *
 * @param {string} memoryRoot
 * @param {string} scope
 * @param {import('./segment.js').Segment[]} segments
 */
export function writeScope(memoryRoot, scope, segments) {
  const path = scopeFilePath(memoryRoot, scope);
  mkdirSync(dirname(path), { recursive: true });
  const text = serializeSegments(segments);
  // atomic-ish write: tmp file + rename
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/**
 * Walk the memory root and return all scopes that have a memory.md.
 *
 * @param {string} memoryRoot
 * @returns {string[]}
 */
export function listScopes(memoryRoot) {
  if (!existsSync(memoryRoot)) return [];
  const out = [];
  walk(memoryRoot, memoryRoot, out);
  return out;
}

function walk(root, dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(root, full, out);
    } else if (entry === 'memory.md') {
      const rel = relative(root, dir).split(sep).join('/');
      if (rel) out.push(rel);
    }
  }
}

/**
 * @param {string} memoryRoot
 * @param {string} scope
 * @returns {string}
 */
export function scopeFilePath(memoryRoot, scope) {
  return join(memoryRoot, scope, 'memory.md');
}
