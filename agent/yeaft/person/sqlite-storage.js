import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, fail } from './contracts.js';

/** Preserve existing instance bindings without silently creating a new authority.
 * SQLite is the only supported storage; this marker is not a backend selector.
 */
export async function ensurePersonStorage(yeaftDir, namespace) {
  const directory = join(yeaftDir, 'person');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `storage-${digest(namespace)}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, storage: 'sqlite' }), { flag: 'wx', mode: 0o600 });
  try {
    // A fully written inode is linked atomically; competing openers never read partial JSON.
    await link(temporary, path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let binding;
    try { binding = JSON.parse(await readFile(path, 'utf8')); } catch { fail('STORAGE_MISMATCH'); }
    if (!binding || binding.version !== 1 || binding.storage !== 'sqlite') fail('STORAGE_MISMATCH');
  } finally { await unlink(temporary).catch(() => {}); }
}
