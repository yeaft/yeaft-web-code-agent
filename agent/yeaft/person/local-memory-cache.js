import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

async function isComplete(file, { size, sha256 }) {
  try {
    if ((await stat(file)).size !== size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(dir) {
  // Windows does not support opening directories for fsync. A lost directory
  // entry after power failure is still a cache miss, never an accepted partial file.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publish(file, url, expected) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.partial`;
  let handle;
  try {
    const response = await fetch(url);
    if (response.status !== 200 || !response.body) throw new Error('model_download_failed');
    handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    // Backpressure keeps memory bounded to stream chunks, including the ONNX file.
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > expected.size) throw new Error('model_integrity_failed');
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('model_integrity_failed');
    await handle.sync();
    await handle.close();
    handle = null;
    // Concurrent publishers have the same pinned digest. Never unlink the final
    // path: an invalid reader or failed writer must not remove another one's repair.
    await rename(temporary, file);
    await syncDirectory(dir);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/**
 * Prepare an instance-owned, immutable model snapshot before Transformers sees it.
 * `artifacts` is a trusted manifest of filename -> { size, sha256 }, pinned with
 * `model` and its commit `revision`. The hashes are the completion markers: legacy
 * complete files work offline, partial/corrupt files are misses, and SIGKILL leaves
 * only ignored unique .partial files. No lock or mutable sidecar can become stale.
 * Returns a local directory; inference must use it with remote access disabled.
 */
export async function prepareModelCache({ yeaftDir, model, revision, artifacts, allowDownload = true }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(model) || model.split('/').some(p => p === '.' || p === '..') || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('invalid_model_identity');
  }
  const dir = path.resolve(yeaftDir, 'person', 'models', model, revision);
  for (const [name, expected] of Object.entries(artifacts)) {
    if (!name.split('/').every(p => /^[\w.-]+$/.test(p) && p !== '.' && p !== '..') ||
        !Number.isSafeInteger(expected.size) || expected.size <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error('invalid_model_artifact');
    }
    const file = path.join(dir, name);
    if (await isComplete(file, expected)) continue;
    if (!allowDownload) throw new Error('model_cache_incomplete');
    await publish(file, `https://huggingface.co/${model}/resolve/${revision}/${name}`, expected);
  }
  return dir;
}
