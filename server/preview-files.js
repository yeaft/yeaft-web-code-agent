import { previewFiles } from './context.js';

export const MAX_PREVIEW_FILE_BYTES = 20 * 1024 * 1024;
export const PREVIEW_FILE_TTL_MS = 10 * 60 * 1000;
export const MAX_PREVIEW_CACHE_BYTES = 128 * 1024 * 1024;
export const MAX_PREVIEW_CACHE_FILES = 256;

function entryBytes(entry) {
  return Buffer.isBuffer(entry?.buffer) ? entry.buffer.length : 0;
}

export function prunePreviewFiles(now = Date.now()) {
  const cutoff = now - PREVIEW_FILE_TTL_MS;
  for (const [id, file] of previewFiles) {
    if (!file || file.createdAt < cutoff) previewFiles.delete(id);
  }
}

export function cachePreviewFile(fileId, file) {
  if (!fileId || !Buffer.isBuffer(file?.buffer)) return false;
  if (file.buffer.length > MAX_PREVIEW_FILE_BYTES) return false;
  prunePreviewFiles();
  let totalBytes = 0;
  for (const value of previewFiles.values()) totalBytes += entryBytes(value);
  const existingBytes = entryBytes(previewFiles.get(fileId));
  const isNewEntry = !previewFiles.has(fileId);
  if ((isNewEntry && previewFiles.size >= MAX_PREVIEW_CACHE_FILES)
      || totalBytes - existingBytes + file.buffer.length > MAX_PREVIEW_CACHE_BYTES) {
    return false;
  }
  previewFiles.set(fileId, { ...file, createdAt: file.createdAt || Date.now() });
  return true;
}
