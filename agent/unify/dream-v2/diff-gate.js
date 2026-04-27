/**
 * dream-v2/diff-gate.js — DESIGN.md §9.14.
 *
 * Hourly dream tick is cheap by default: read a per-scope cursor, check
 * whether anything has changed since last pass, skip everything if not.
 *
 * The cursor is a tiny JSON file `<scopeDir>/.dream-cursor.json`:
 *
 *   { "lastTickAt": "<ISO>", "lastSeenSig": "<opaque>" }
 *
 * `lastSeenSig` is whatever the caller wants to put there — typically a
 * hash of the entries dir mtime + index.md mtime. The diff-gate doesn't
 * compute the signature; it just compares the supplied "current" against
 * the stored "last". That keeps signatures pluggable (mtime today, content
 * hash later, ETag on a remote scope etc.).
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';

const FILE = '.dream-cursor.json';

/**
 * @param {string} root
 * @param {string} scopeDir
 * @returns {string}
 */
export function cursorPath(root, scopeDir) {
  if (!root || !scopeDir) throw new Error('cursorPath: root + scopeDir required');
  return join(root, scopeDir, FILE);
}

/**
 * @param {{ root: string, scopeDir: string }} args
 * @returns {Promise<{ lastTickAt: string|null, lastSeenSig: string|null }>}
 */
export async function readCursor({ root, scopeDir }) {
  const path = cursorPath(root, scopeDir);
  try {
    const content = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(content);
    return {
      lastTickAt: typeof parsed?.lastTickAt === 'string' ? parsed.lastTickAt : null,
      lastSeenSig: typeof parsed?.lastSeenSig === 'string' ? parsed.lastSeenSig : null,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { lastTickAt: null, lastSeenSig: null };
    if (err instanceof SyntaxError) return { lastTickAt: null, lastSeenSig: null };
    throw err;
  }
}

/**
 * @param {{
 *   root: string,
 *   scopeDir: string,
 *   sig: string,
 *   tickAt?: string,
 * }} args
 */
export async function writeCursor({ root, scopeDir, sig, tickAt }) {
  if (typeof sig !== 'string') throw new Error('writeCursor: sig must be string');
  const path = cursorPath(root, scopeDir);
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify({
    lastTickAt: tickAt || new Date().toISOString(),
    lastSeenSig: sig,
  }), 'utf8');
  await fs.rename(tmp, path);
}

/**
 * Diff-gate decision. Pure: takes (last, current) and returns whether
 * dream should run. Caller decides what `currentSig` means.
 *
 * @param {{ lastSeenSig: string|null }} last
 * @param {string} currentSig
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldRunDream(last, currentSig) {
  if (!last || last.lastSeenSig == null) {
    return { skip: false, reason: 'no_cursor' };
  }
  if (last.lastSeenSig !== currentSig) {
    return { skip: false, reason: 'diff' };
  }
  return { skip: true, reason: 'no_diff' };
}
