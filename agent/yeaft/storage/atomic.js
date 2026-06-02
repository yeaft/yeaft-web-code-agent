/**
 * atomic.js — Crash-safe single-file writes.
 *
 * task-334o §Δ15 / §Δ22 §Δ23 shard-store foundation.
 *
 * Contract: writeAtomic(path, data) never leaves a half-written file at `path`.
 * If the process crashes at any point, `path` is either the pre-existing content
 * or the new content — never a torn mix. Leftover `*.tmp.<pid>.<n>` files are
 * the only debris; they are safe to delete on boot (see sweepTmp()).
 *
 * Implementation:
 *   1. Write bytes to `path.tmp.<pid>.<counter>` via writeFileSync.
 *   2. fsync the tmp file (force bytes to disk before rename).
 *   3. rename(tmp, path) — POSIX-atomic on same filesystem.
 *   4. fsync the parent dir (persist the rename itself).
 *
 * Step 4 is what most naive "atomic write" implementations skip. Without it,
 * a crash after the rename call returns can still lose the rename on ext4
 * with data=ordered. We do the dir fsync on Linux/macOS; on Windows we skip
 * (fsync on a directory is an error there) and accept the minor risk window.
 *
 * This module has no knowledge of VP/task/message — it's a pure primitive.
 */

import {
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from 'fs';
import { dirname, basename, join } from 'path';

let tmpCounter = 0;

/**
 * Atomically write `data` (string | Buffer) to `path`.
 * Throws on failure; never leaves `path` in a half-written state.
 */
export function writeAtomic(path, data) {
  const dir = dirname(path);
  const tmpPath = `${path}.tmp.${process.pid}.${++tmpCounter}`;

  writeFileSync(tmpPath, data);

  // fsync the tmp file so the bytes hit disk before we swap.
  try {
    const fd = openSync(tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best-effort; some filesystems / platforms don't support fsync on a file
    // opened r+. The rename below is still the atomic boundary.
  }

  renameSync(tmpPath, path);

  // fsync the parent directory so the rename is durable.
  // Windows: cannot fsync a directory; skip.
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(dir, 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Directory fsync is best-effort. A failure here does not invalidate
      // the rename itself; it only weakens durability on power loss.
    }
  }
}

/**
 * Remove any leftover `*.tmp.*` files in `dir` from a previous crashed write.
 * Safe to call on boot. Returns the count removed.
 *
 * Only matches the specific `<basename>.tmp.<pid>.<counter>` shape — won't
 * touch user files that happen to end in `.tmp`.
 */
export function sweepTmp(dir) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (/\.tmp\.\d+\.\d+$/.test(name)) {
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {
        // Ignore — another process may have beaten us to it.
      }
    }
  }
  return removed;
}

/** Check whether a given file path looks like our tmp sidecar. Test helper. */
export function isTmpPath(path) {
  return /\.tmp\.\d+\.\d+$/.test(basename(path));
}
