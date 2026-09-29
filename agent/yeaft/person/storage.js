import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, fail } from './contracts.js';

/** Deployment-only selection. Never fall back from an unavailable authority to another one. */
export function selectPersonStorage({ storage, uri, yeaftDir }) {
  if (storage != null && !['sqlite', 'mongodb'].includes(storage)) fail('INVALID_REQUEST');
  if (uri != null && typeof uri !== 'string') fail('INVALID_REQUEST');
  const hasMongo = Boolean(uri?.trim());
  const selected = storage ?? (hasMongo ? 'mongodb' : 'sqlite');
  if (selected === 'sqlite' && hasMongo) fail('STORAGE_MISMATCH');
  return { storage: selected, configured: selected === 'mongodb' ? hasMongo : typeof yeaftDir === 'string' && Boolean(yeaftDir.trim()) };
}

/** This marker is deployment metadata, not memory. Changing backend requires an explicit migration.
 * The first configured access binds a namespace; removing Mongo credentials cannot create a new Person.
 * Legacy Mongo deployments are bound on their first access after upgrade, not retroactively discovered.
 */
export async function bindPersonStorage(yeaftDir, namespace, storage) {
  if (!yeaftDir) return; // Direct Mongo integrations may have no local instance directory.
  const directory = join(yeaftDir, 'person');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `storage-${digest(namespace)}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, storage }), { flag: 'wx', mode: 0o600 });
  try {
    // A fully written inode is linked atomically; a competing opener never reads partial JSON.
    await link(temporary, path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let binding;
    try { binding = JSON.parse(await readFile(path, 'utf8')); } catch { fail('STORAGE_MISMATCH'); }
    if (binding.version !== 1 || binding.storage !== storage) fail('STORAGE_MISMATCH');
  } finally { await unlink(temporary).catch(() => {}); }
}
