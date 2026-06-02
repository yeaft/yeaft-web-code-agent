/**
 * project-doc.js — Read CLAUDE.md / AGENTS.md from a group's workDir.
 *
 * Per-group, the user may park a project-level instructions file in the
 * group's configured `workDir`. This module is the stateless reader for
 * those files. The Engine owns the cache (per session, per VP) so that
 * mtime-driven invalidation can happen without a singleton cache.
 *
 * File-selection rule (matches user spec):
 *   • If both `CLAUDE.md` and `AGENTS.md` exist, the one with the newer
 *     mtime wins. Tie → CLAUDE.md (deterministic; this is the project's
 *     own convention).
 *   • If only one exists, pick it.
 *   • If neither exists, return null. Caller skips the prompt block.
 *
 * Why two filenames? CLAUDE.md is this project's convention; AGENTS.md
 * is the cross-tool convention adopted by Codex / OpenAI Codex CLI. Both
 * carry the same kind of payload — long-form project instructions — and
 * we want users coming from either ecosystem to "just work".
 *
 * Size cap. We read up to `maxBytes` and truncate larger files with a
 * console warning. Default cap is 32 KB (`DEFAULT_PROJECT_DOC_MAX_BYTES`),
 * mirroring Codex's `project_doc_max_bytes`. Setting the cap to 0 in the
 * engine config disables the feature entirely (the caller short-circuits
 * before reaching this module).
 *
 * NO module-level cache. The engine holds the cache so a mtime change
 * between sessions doesn't ride along into a fresh engine instance, and
 * tests can construct two engines without interfering with each other.
 */

import { statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';

/** Filenames probed in `workDir`, in tie-break order (first wins on tie). */
export const PROJECT_DOC_FILENAMES = ['CLAUDE.md', 'AGENTS.md'];

/** Default max bytes pulled into the prompt block. Matches Codex. */
export const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;

/**
 * Stat both candidate filenames in `workDir` and return whichever has the
 * newer mtime, or null when neither exists / workDir is unusable.
 *
 * Pure stat — does NOT read file contents. Returns a lightweight stat
 * record so the caller can compare against a cached `mtimeMs` before
 * deciding to re-read.
 *
 * @param {string} workDir
 * @returns {{ path: string, mtimeMs: number } | null}
 */
export function pickProjectDocFile(workDir) {
  if (typeof workDir !== 'string' || !workDir.trim()) return null;
  try {
    const dirStat = statSync(workDir);
    if (!dirStat.isDirectory()) return null;
  } catch {
    // Non-existent / permission-denied / not a path we can stat.
    return null;
  }

  let best = null;
  for (const name of PROJECT_DOC_FILENAMES) {
    const path = join(workDir, name);
    let s;
    try {
      s = statSync(path);
    } catch {
      // Missing or unreadable; try the next candidate.
      continue;
    }
    if (!s.isFile()) continue;
    // Strict-greater so ties favor the order in PROJECT_DOC_FILENAMES.
    if (!best || s.mtimeMs > best.mtimeMs) {
      best = { path, mtimeMs: s.mtimeMs };
    }
  }
  return best;
}

/**
 * Read the picked project-doc file. Returns null when nothing is
 * eligible (no workDir, no file, empty contents after trim).
 *
 * Bounded I/O. We allocate `maxBytes + 1` bytes and `readSync` once —
 * never letting a runaway file balloon the agent's heap. The extra
 * byte tells us whether the file was actually larger (so we know to
 * warn about truncation).
 *
 * Codepoint-safe truncation. When we cut mid-byte inside a multi-byte
 * UTF-8 sequence (very likely for `zh-CN` docs), we walk back to the
 * last codepoint boundary before decoding, so the model sees clean
 * text instead of a trailing `U+FFFD` replacement character.
 *
 * @param {string} workDir
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ path: string, mtimeMs: number, text: string } | null}
 */
export function readProjectDoc(workDir, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes >= 0
    ? opts.maxBytes
    : DEFAULT_PROJECT_DOC_MAX_BYTES;
  if (maxBytes === 0) return null;

  const picked = pickProjectDocFile(workDir);
  if (!picked) return null;

  // Allocate one extra byte so a `bytesRead === maxBytes + 1` tells us
  // there's more content beyond the cap — i.e. the file was truncated.
  const cap = maxBytes + 1;
  const buffer = Buffer.allocUnsafe(cap);
  let fd;
  let bytesRead = 0;
  try {
    fd = openSync(picked.path, 'r');
    bytesRead = readSync(fd, buffer, 0, cap, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  let useBytes = bytesRead;
  const truncated = bytesRead > maxBytes;
  if (truncated) {
    useBytes = maxBytes;
    // Walk back into the buffer until the cut isn't sitting in the
    // middle of a multi-byte UTF-8 sequence. Each continuation byte
    // matches the pattern `10xxxxxx` (0x80–0xBF). We scan back at most
    // 3 bytes — UTF-8 codepoints are ≤ 4 bytes total.
    let scan = 0;
    while (scan < 3 && useBytes > 0 && (buffer[useBytes] & 0xC0) === 0x80) {
      useBytes -= 1;
      scan += 1;
    }
  }

  const text = buffer.toString('utf8', 0, useBytes).trim();
  if (truncated) {
    console.warn(
      `[yeaft/project-doc] ${picked.path} exceeds ${maxBytes} bytes — truncated.`,
    );
  }
  if (!text) return null;
  return { path: picked.path, mtimeMs: picked.mtimeMs, text };
}
