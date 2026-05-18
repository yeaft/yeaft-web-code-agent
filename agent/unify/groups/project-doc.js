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

import { existsSync, statSync, readFileSync } from 'fs';
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
  if (!existsSync(workDir)) return null;
  try {
    const dirStat = statSync(workDir);
    if (!dirStat.isDirectory()) return null;
  } catch {
    return null;
  }

  let best = null;
  for (const name of PROJECT_DOC_FILENAMES) {
    const path = join(workDir, name);
    if (!existsSync(path)) continue;
    try {
      const s = statSync(path);
      if (!s.isFile()) continue;
      // Strict-greater so ties favor the order in PROJECT_DOC_FILENAMES.
      if (!best || s.mtimeMs > best.mtimeMs) {
        best = { path, mtimeMs: s.mtimeMs };
      }
    } catch {
      // Skip unreadable file; we'll try the next candidate.
    }
  }
  return best;
}

/**
 * Read the picked project-doc file. Returns null when nothing is
 * eligible (no workDir, no file, empty contents after trim).
 *
 * Truncates to `maxBytes` and emits a console.warn — same trade-off as
 * Codex's read path: we'd rather inject a partial doc than swallow the
 * caller's context budget on a runaway file.
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

  let buf;
  try {
    buf = readFileSync(picked.path);
  } catch {
    return null;
  }
  let truncated = false;
  if (buf.length > maxBytes) {
    buf = buf.subarray(0, maxBytes);
    truncated = true;
  }
  const text = buf.toString('utf8').trim();
  if (truncated) {
    console.warn(
      `[unify/project-doc] ${picked.path} exceeds ${maxBytes} bytes — truncated.`,
    );
  }
  if (!text) return null;
  return { path: picked.path, mtimeMs: picked.mtimeMs, text };
}
