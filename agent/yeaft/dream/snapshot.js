/**
 * dream/snapshot.js.
 *
 * Pre-Apply backup of memory.md + summary.md to
 * `~/.yeaft/memory/.dream-bak/<ts>/<scope-path>/`. The runner takes a
 * snapshot once per merged target before Apply mutates it; that snapshot
 * is the unit of rollback in case of LLM error or write failure.
 *
 * `pruneOldSnapshots()` keeps the most recent DREAM_BACKUP_KEEP
 * timestamp directories under `.dream-bak/` and rm-rf's the rest.
 *
 * Pure I/O. No LLM. No control-flow.
 */

import { promises as fsp, existsSync } from 'fs';
import { join, dirname } from 'path';

import { DREAM_BACKUP_KEEP } from './limits.js';

/** Folder name where snapshots live, relative to memory root. */
export const BACKUP_DIRNAME = '.dream-bak';

/**
 * Build a stable filesystem-safe ISO timestamp string. Same shape that
 * the migration script uses (`migrate-r6-to-v2.js`).
 */
export function tsForBackup(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Snapshot a single scope's memory.md + summary.md into
 * `<root>/.dream-bak/<ts>/<scopeRelDir>/`. Missing source files are
 * skipped silently; the destination dir is always created so that an
 * absent snapshot is still distinguishable from "didn't run".
 *
 * @param {string} root — memory root
 * @param {string} ts   — timestamp folder name (re-use across all
 *                        scopes in one dream pass)
 * @param {string} scopeRelDir — e.g. 'user', 'group/g-eng', 'topic/sci/phys'
 * @returns {Promise<{ backupDir: string, copied: string[] }>}
 */
export async function snapshotScope(root, ts, scopeRelDir) {
  const srcDir = join(root, scopeRelDir);
  const dstDir = join(root, BACKUP_DIRNAME, ts, scopeRelDir);
  await fsp.mkdir(dstDir, { recursive: true });
  const copied = [];
  for (const name of ['memory.md', 'summary.md']) {
    const s = join(srcDir, name);
    if (!existsSync(s)) continue;
    const d = join(dstDir, name);
    await fsp.copyFile(s, d);
    copied.push(name);
  }
  return { backupDir: dstDir, copied };
}

/**
 * Keep the `keep` newest snapshot timestamps, rm-rf the rest.
 *
 * @param {string} root
 * @param {number} [keep=DREAM_BACKUP_KEEP]
 * @returns {Promise<{ kept: string[], removed: string[] }>}
 */
export async function pruneOldSnapshots(root, keep = DREAM_BACKUP_KEEP) {
  const baseDir = join(root, BACKUP_DIRNAME);
  if (!existsSync(baseDir)) return { kept: [], removed: [] };
  let entries;
  try { entries = await fsp.readdir(baseDir, { withFileTypes: true }); }
  catch (err) { if (err && err.code === 'ENOENT') return { kept: [], removed: [] }; throw err; }
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  // sort() of ISO-with-dashes timestamps is chronological.
  const cutoff = Math.max(0, dirs.length - keep);
  const removed = dirs.slice(0, cutoff);
  const kept = dirs.slice(cutoff);
  for (const name of removed) {
    await fsp.rm(join(baseDir, name), { recursive: true, force: true }).catch(() => {});
  }
  return { kept, removed };
}
