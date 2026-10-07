/**
 * attachments.js — Yeaft (group/feature) attachment handling.
 *
 * Mirrors the Chat-mode pipeline implemented in `agent/workbench/transfer.js`,
 * adapted to the Yeaft architecture:
 *
 *   - Chat mode has a per-conversation `state.workDir` and a single
 *     in-flight Claude SDK query — `transfer.js` enqueues a constructed
 *     user message into that query's `inputStream`.
 *   - Yeaft mode has many VPs taking turns inside a group, no per-VP
 *     workDir, and the Engine accepts the user message via `query()`
 *     args. Session uploads belong to the instance's
 *     `sessions/<sessionId>/attachments` directory, independent of workDir.
 *     Non-Session callers retain the legacy CWD-relative folder.
 *     We hand back the persisted-form
 *     metadata AND a `promptParts` content array (image blocks +
 *     synthesized [Uploaded files] suffix) for the LLM call.
 *
 * Inputs (`files`) come from the server-side resolver in
 * `client-conversation.js`: each entry is
 * `{ name, mimeType, data: <base64>, isImage }` — the `pendingFiles`
 * `fileId` was already consumed by the server before `forwardToAgent`.
 *
 * Output (single bundle, all named for the role each piece plays in
 * the LLM call):
 *   - `promptAttachments`: persisted metadata `{ name, path, mimeType,
 *     isImage }` suitable for the group jsonl-log (NO base64 — must
 *     stay small).
 *   - `promptSuffix`: text to append to the user's prompt so the model
 *     sees the file list in the same form Chat mode uses.
 *   - `promptParts`: an array of `{ type:'image', source:{ data, media_type } }`
 *     blocks for images, ready to be combined with a text block for
 *     `engine.query({ promptParts })`. Empty when no images are present.
 *     Field name is `media_type` (snake_case) to match the Anthropic
 *     Messages API spec — Anthropic adapter forwards user-content blocks
 *     verbatim, so the on-the-wire form must already be correct here.
 *     `workbench/transfer.js` emits the same shape.
 *   - `failed`: list of `{ name, error }` for entries that could not
 *     be persisted (disk full, bad base64, ...). The caller surfaces
 *     this so the UI can tell the user *which* file blew up rather
 *     than swallowing it in a console.warn.
 */

import { mkdirSync, writeFileSync, lstatSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { basename, extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

// Same dir name Chat mode uses, so ".gitignore" rules and tool-side
// expectations stay identical.
const TEMP_UPLOAD_DIR = '.claude-tmp-attachments';

// Caps. Any ingestion path without caps is a denial-of-service waiting
// to be discovered. Cheap insurance.
//   - MAX_FILES_PER_TURN: matches the UI's per-message attachment cap.
//   - MAX_TOTAL_BYTES:    50 MiB across all files in one turn.
export const MAX_FILES_PER_TURN = 16;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

/**
 * Sanitize a user-supplied filename's basename for use as an on-disk
 * path component. We KEEP Unicode (CJK, emoji, accented letters) —
 * the disk path is opaque, the UI uses `promptAttachments[].name` for
 * display, and tool consumers (file-read, bash) handle UTF-8 paths
 * fine on Linux/macOS. We only strip what is structurally dangerous:
 *   - path separators (`/`, `\`)
 *   - NUL bytes
 *   - leading dots (so a user can't write `.bashrc` into the temp dir)
 *   - leading `-` (so the path can't be mistaken for a CLI flag)
 *   - control characters
 */
function sanitizeBaseName(base) {
  let s = String(base ?? '')
    .replace(/[\/\\\0]/g, '_')
    // Strip C0 controls (\u0000–\u001F) and DEL (\u007F).
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    // Trim runs of leading dots/dashes that would create dotfiles or
    // CLI-flag-looking paths.
    .replace(/^[.\-]+/, '');
  if (!s) s = 'file';
  // Hard cap on length — most filesystems are fine with 255 bytes per
  // name, and the random suffix + extension still need to fit.
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

/**
 * Persist resolved files to disk and build the LLM-side payload pieces.
 *
 * @param {Array<{name:string, mimeType:string, data:string, isImage?:boolean}>} files
 *        Resolved files from server (pendingFiles → base64).
 * @param {Object} [opts]
 * @param {string} [opts.yeaftDir] Instance data root for Session uploads.
 * @param {string} [opts.sessionId] Session owner (required with yeaftDir).
 * @param {string} [opts.subdir]   Sub-folder under TEMP_UPLOAD_DIR
 *        (e.g. sessionId). Lets multiple groups co-exist without clobbering.
 * @param {string} [opts.cwd]      Override base dir; defaults to process.cwd()
 *        which is what yeaft tools (file-read, bash, ...) resolve relative
 *        paths against.
 * @returns {{
 *   promptAttachments: Array<{name:string, path:string, mimeType:string, isImage:boolean}>,
 *   promptSuffix: string,
 *   promptParts: Array<{type:'image', source:{type:'base64', media_type:string, data:string}}>,
 *   failed: Array<{name:string, error:string}>
 * }}
 */
export function persistYeaftAttachments(files, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  // Subdir is OURS — it must remain ASCII-safe because we generate it
  // from sessionId. Keep the existing strict policy here; this is NOT
  // user-visible.
  const subdir = opts.subdir ? String(opts.subdir).replace(/[^a-zA-Z0-9._-]/g, '_') : '';
  const sessionUpload = opts.yeaftDir != null || opts.sessionId != null;
  const uploadDir = sessionUpload
    ? sessionAttachmentRoot(opts)
    : (subdir && subdir !== '.' && subdir !== '..'
      ? resolve(cwd, TEMP_UPLOAD_DIR, subdir) : resolve(cwd, TEMP_UPLOAD_DIR));

  if (!Array.isArray(files) || files.length === 0) {
    return { promptAttachments: [], promptSuffix: '', promptParts: [], failed: [] };
  }

  // Enforce per-turn file count cap. Excess entries are surfaced as
  // failures so the UI can tell the user what got dropped.
  const accepted = files.slice(0, MAX_FILES_PER_TURN);
  const rejectedByCount = files.slice(MAX_FILES_PER_TURN);

  try {
    if (!uploadDir) throw new Error('invalid Session attachment owner');
    const root = sessionUpload ? resolve(opts.yeaftDir) : resolve(cwd);
    assertNoSymlinks(root, uploadDir, true);
    mkdirSync(uploadDir, { recursive: true });
    assertNoSymlinks(root, uploadDir);
  } catch (error) {
    return {
      promptAttachments: [], promptSuffix: '', promptParts: [],
      failed: files.map(file => ({ name: file?.name || '<unknown>', error: error.message })),
    };
  }

  const promptAttachments = [];
  const promptParts = [];
  const failed = rejectedByCount.map((f) => ({
    name: f?.name || '<unknown>',
    error: `too many files (cap=${MAX_FILES_PER_TURN})`,
  }));

  let totalBytes = 0;

  for (const file of accepted) {
    if (!file || !file.name || !file.data) {
      // Silently skip null/empty entries — these are caller bugs, not
      // user errors, and the existing test suite asserts they don't
      // appear in `failed`. (Backwards compatible.)
      continue;
    }
    try {
      const rawExt = extname(file.name);
      const ext = rawExt.replace(/[\\\/\0-\x1f\x7f]/g, '_');
      const base = basename(file.name, rawExt);
      const safeBase = sanitizeBaseName(base);
      // Identity comes from random bytes — a clock is not an identity.
      // 4 bytes (2^32) is plenty for a 16-file cap.
      const suffix = randomBytes(4).toString('hex');
      const uniqueName = `${safeBase}_${suffix}${ext || ''}`;
      const absPath = join(uploadDir, uniqueName);
      // Absolute Session references keep file tools independent of workDir;
      // readers still require this instance and Session's exact asset root.
      const persistedPath = sessionUpload ? absPath : relative(resolve(cwd), absPath);

      const buffer = Buffer.from(file.data, 'base64');

      // Total-bytes cap. Check BEFORE write so we don't half-fill the
      // disk and then bail.
      if (totalBytes + buffer.length > MAX_TOTAL_BYTES) {
        failed.push({
          name: file.name,
          error: `total upload exceeds ${MAX_TOTAL_BYTES} bytes`,
        });
        continue;
      }
      totalBytes += buffer.length;

      writeFileSync(absPath, buffer, { flag: 'wx', mode: 0o600 });

      const isImage = !!file.isImage || (file.mimeType || '').startsWith('image/');
      promptAttachments.push({
        name: file.name,
        path: persistedPath,
        mimeType: file.mimeType || 'application/octet-stream',
        isImage,
      });

      if (isImage) {
        promptParts.push({
          type: 'image',
          source: {
            type: 'base64',
            // Field name MUST be `media_type` (snake_case) — the Anthropic
            // Messages API rejects camelCase here with `400 Failed to
            // read request body`, and the Anthropic adapter forwards
            // user-content blocks verbatim (no field rename). The OpenAI
            // Responses adapter accepts both forms (see
            // `openai-responses.js#translateUserContent`).
            media_type: file.mimeType || 'image/png',
            data: file.data,
          },
        });
      }
    } catch (err) {
      failed.push({
        name: file?.name || '<unknown>',
        error: err?.message || String(err),
      });
    }
  }

  let promptSuffix = '';
  if (promptAttachments.length > 0) {
    const lines = promptAttachments.map((f) =>
      `- ${f.path} (${f.isImage ? 'image' : f.mimeType})`
    );
    promptSuffix = `\n\n[Uploaded files]\n${lines.join('\n')}`;
  }

  return { promptAttachments, promptSuffix, promptParts, failed };
}

/**
 * Strip base64 data from a resolved-files array so it can be safely
 * persisted (e.g. into a group jsonl-log or memory entry). Keeps name,
 * mimeType, isImage, and the on-disk path returned by
 * `persistYeaftAttachments`.
 *
 * @param {Array<{name:string, path:string, mimeType:string, isImage:boolean}>} promptAttachments
 * @returns {Array<{name:string, path:string, mimeType:string, isImage:boolean}>}
 */
export function attachmentsForPersistence(promptAttachments) {
  if (!Array.isArray(promptAttachments)) return [];
  return promptAttachments.map((f) => ({
    name: f.name,
    path: f.path,
    mimeType: f.mimeType,
    isImage: !!f.isImage,
  }));
}

/** Session IDs are identities, never sanitized into another Session's directory. */
function validSessionId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(value);
}

function sessionAttachmentRoot({ yeaftDir, sessionId }) {
  return typeof yeaftDir === 'string' && yeaftDir && validSessionId(sessionId)
    ? resolve(yeaftDir, 'sessions', sessionId, 'attachments') : null;
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Check the trusted base itself and every descendant, including intermediate
// directories. O_NOFOLLOW below also guards replacement of the final file.
// This is not a sandbox against concurrently replaced ancestor directories.
function assertNoSymlinks(root, path, allowMissing = false) {
  if (path !== root && !isWithin(root, path)) throw new Error('attachment path outside owner root');
  let current = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('attachment symlink is not allowed');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

/**
 * Resolve only this Session's assets, or its CWD-relative legacy uploads.
 * Absolute paths are allowed ONLY in <yeaftDir>/sessions/<sessionId>/attachments.
 * No workDir search/fallback: legacy Web uploads were written under Agent CWD.
 * Non-Session callers retain their original CWD-relative upload root.
 * @param {string} attachmentPath
 * @param {{cwd?:string, yeaftDir?:string, sessionId?:string}} [opts]
 * @returns {string|null}
 */
export function resolvePersistedAttachmentPath(attachmentPath, opts = {}) {
  if (!attachmentPath || typeof attachmentPath !== 'string' || attachmentPath.includes('\0')) return null;
  const cwd = resolve(opts.cwd || process.cwd());
  const scoped = opts.sessionId != null || opts.yeaftDir != null;
  const sessionRoot = sessionAttachmentRoot(opts);
  if (scoped && !sessionRoot) return null;
  const absPath = resolve(cwd, attachmentPath);
  let root;
  if (isAbsolute(attachmentPath)) {
    if (!sessionRoot || !isWithin(sessionRoot, absPath)) return null;
    root = resolve(opts.yeaftDir);
  } else {
    const legacyRoot = scoped
      ? resolve(cwd, TEMP_UPLOAD_DIR, opts.sessionId) : resolve(cwd, TEMP_UPLOAD_DIR);
    if (!isWithin(legacyRoot, absPath)) return null;
    root = cwd;
  }
  try {
    assertNoSymlinks(root, absPath);
    return absPath;
  } catch {
    return null;
  }
}

/** Shared bounded read for model history and browser preview. Never follows symlinks. */
function readPersistedImage(att, opts, maxBytes) {
  const absPath = resolvePersistedAttachmentPath(att?.path, opts);
  if (!absPath) throw new Error('file missing or outside this Session / 文件缺失或不属于本会话');
  const fd = openSync(absPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > maxBytes) throw new Error('image exceeds attachment size limit');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!read) throw new Error('image changed while reading');
      offset += read;
    }
    return {
      data: buffer.toString('base64'),
      mimeType: att.mimeType || 'image/png',
      filename: att.name || basename(absPath),
      bytes: buffer.length,
    };
  } finally {
    closeSync(fd);
  }
}

/** Short-lived web preview; missing/denied/oversized images have no preview. */
export function persistedAttachmentPreviewPayload(att, opts = {}) {
  if (!att?.isImage || !att.path) return null;
  try {
    const { bytes, ...payload } = readPersistedImage(att, opts, MAX_PREVIEW_BYTES);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Provider-only projection. Canonical rows keep text + lightweight references;
 * neither hydrated base64 nor unavailable-image notices are persisted.
 * Ownership comes from the requested Session, not an attachment's metadata.
 */
export function hydratePersistedAttachmentHistory(messages, opts = {}) {
  return messages.map(row => {
    if (row?.role !== 'user' || row.sessionId !== opts.sessionId || !validSessionId(opts.sessionId)) return row;
    const images = Array.isArray(row.attachments) ? row.attachments.filter(att => att?.isImage) : [];
    if (!images.length) return row;
    const content = Array.isArray(row.content) ? [...row.content]
      : (row.content ? [{ type: 'text', text: String(row.content) }] : []);
    let totalBytes = 0;
    for (const att of images.slice(0, MAX_FILES_PER_TURN)) {
      try {
        const payload = readPersistedImage(att, opts, MAX_TOTAL_BYTES - totalBytes);
        totalBytes += payload.bytes;
        content.push({ type: 'image', source: { type: 'base64', media_type: payload.mimeType, data: payload.data } });
      } catch (error) {
        content.push({ type: 'text', text: `[Uploaded image unavailable / 上传图片不可用: ${att.name || 'image'} — ${error.message}. Ask the user to upload it again / 请用户重新上传。]` });
      }
    }
    if (images.length > MAX_FILES_PER_TURN) content.push({ type: 'text', text: '[Uploaded image unavailable: attachment count limit exceeded.]' });
    return { ...row, content };
  });
}
