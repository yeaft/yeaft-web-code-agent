import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../storage/atomic.js';

const CUTOVER_FILE = 'session-turn-deletion-cutover.json';

/** A local operator acknowledgement for this data root, not a feature flag from the wire. */
export function isSessionTurnDeletionCutoverConfirmed(ownerRoot) {
  if (!ownerRoot) return false;
  try {
    const root = realpathSync(ownerRoot);
    const path = join(root, CUTOVER_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return false;
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    return marker?.version === 1 && marker.root === root && marker.minimumReader === 'session-turn-deletion-journal';
  } catch { return false; }
}

/**
 * Run offline, only after replacing/stopping all older readers of this root.
 * Old binaries cannot be fenced by a marker they do not understand. The caller
 * (local operator) must ensure they never reopen this root after the cutover.
 */
export function confirmSessionTurnDeletionCutover(ownerRoot, { oldReadersStopped = false } = {}) {
  if (!oldReadersStopped) throw new Error('Confirm all legacy readers of this data root have been stopped and will not reopen it.');
  const root = realpathSync(ownerRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('Yeaft data root must be a directory.');
  if (isSessionTurnDeletionCutoverConfirmed(root)) return;
  writeAtomic(join(root, CUTOVER_FILE), JSON.stringify({
    version: 1,
    root,
    minimumReader: 'session-turn-deletion-journal',
  }) + '\n', { mode: 0o600 });
}
