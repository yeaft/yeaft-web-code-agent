import { CONFIG } from './config.js';
import { pendingFiles } from './context.js';

export const MAX_CREATION_ATTACHMENTS = 10;
export const MAX_CREATION_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CREATION_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

export const MAX_CREATION_IN_FLIGHT_BYTES_PER_USER = 50 * 1024 * 1024;
export const MAX_CREATION_IN_FLIGHT_BYTES = 128 * 1024 * 1024;

const invalid = (error, errorCode = 'invalid_request') => ({ ok: false, files: [], error, errorCode });

/** Resolve only server-stored uploads; keep entries reusable until their original TTL. */
export function validateCreationAttachments(client, payload, {
  uploads = pendingFiles, skipAuth = CONFIG.skipAuth,
  uploadTtlMs = CONFIG.fileCleanupInterval ?? 600_000, now = Date.now,
} = {}) {
  if (Object.hasOwn(payload, 'files')) return invalid('Upload files first; only attachment fileId references are accepted');
  const refs = payload.attachments ?? [];
  if (!Array.isArray(refs)) return invalid('Invalid Creation attachments');
  if (refs.length > MAX_CREATION_ATTACHMENTS) return invalid('Creations support at most 10 attachments per request', 'attachment_limit');

  const seen = new Set();
  const entries = [];
  const timestamp = now();
  let total = 0;
  for (const ref of refs) {
    const id = ref?.fileId;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
        || typeof id !== 'string' || !id || id.length > 128 || seen.has(id)) {
      return invalid('Invalid Creation attachment reference');
    }
    seen.add(id);
    const entry = uploads.get(id);
    if (entry && !skipAuth && (!client.userId || entry.userId !== client.userId)) {
      return invalid('Creation attachment access denied', 'forbidden');
    }
    if (!entry || !Number.isFinite(entry.uploadedAt)
        || entry.uploadedAt > timestamp || timestamp - entry.uploadedAt >= uploadTtlMs) {
      return invalid('Creation attachment expired; upload it again', 'attachment_expired');
    }
    if (!Buffer.isBuffer(entry.buffer) || typeof entry.name !== 'string' || typeof entry.mimeType !== 'string') {
      return invalid('Invalid Creation upload');
    }
    total += entry.buffer.length;
    if (entry.buffer.length > MAX_CREATION_ATTACHMENT_BYTES || total > MAX_CREATION_ATTACHMENT_TOTAL_BYTES) {
      return invalid('Creation attachments exceed 25 MiB per file or 50 MiB total', 'attachment_limit');
    }
    entries.push(entry);
  }
  return { ok: true, entries, totalBytes: total };
}
