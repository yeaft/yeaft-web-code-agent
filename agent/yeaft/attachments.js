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
 *     args. So we (a) save attachments to a shared per-group folder
 *     under the agent's CWD (so file-tools using `ctx.cwd` can read
 *     them with relative paths) and (b) hand back the persisted-form
 *     metadata AND a `promptParts` content array (image blocks +
 *     synthesized [Uploaded files] suffix) for the LLM call.
 *
 * Inputs (`files`) come from the server-side resolver in
 * `client-conversation.js` / `client-crew.js`: each entry is
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
 *     `crew/routing.js` / `workbench/transfer.js` emit the same shape.
 *   - `failed`: list of `{ name, error }` for entries that could not
 *     be persisted (disk full, bad base64, ...). The caller surfaces
 *     this so the UI can tell the user *which* file blew up rather
 *     than swallowing it in a console.warn.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, relative, isAbsolute } from 'node:path';
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
  const uploadDir = subdir
    ? join(cwd, TEMP_UPLOAD_DIR, subdir)
    : join(cwd, TEMP_UPLOAD_DIR);

  if (!Array.isArray(files) || files.length === 0) {
    return { promptAttachments: [], promptSuffix: '', promptParts: [], failed: [] };
  }

  // Enforce per-turn file count cap. Excess entries are surfaced as
  // failures so the UI can tell the user what got dropped.
  const accepted = files.slice(0, MAX_FILES_PER_TURN);
  const rejectedByCount = files.slice(MAX_FILES_PER_TURN);

  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
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
      const ext = extname(file.name);
      const base = basename(file.name, ext);
      const safeBase = sanitizeBaseName(base);
      // Identity comes from random bytes — a clock is not an identity.
      // 4 bytes (2^32) is plenty for a 16-file cap.
      const suffix = randomBytes(4).toString('hex');
      const uniqueName = `${safeBase}_${suffix}${ext || ''}`;
      const absPath = join(uploadDir, uniqueName);
      const relPath = subdir
        ? join(TEMP_UPLOAD_DIR, subdir, uniqueName)
        : join(TEMP_UPLOAD_DIR, uniqueName);

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

      writeFileSync(absPath, buffer);

      const isImage = !!file.isImage || (file.mimeType || '').startsWith('image/');
      promptAttachments.push({
        name: file.name,
        path: relPath,
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

/**
 * Resolve a persisted Yeaft attachment path to an on-disk file. The persisted
 * path is intentionally relative (for tool use), so preview hydration must
 * keep it inside the upload root instead of serving arbitrary files.
 *
 * @param {string} attachmentPath
 * @param {{ cwd?: string }} [opts]
 * @returns {string|null}
 */
export function resolvePersistedAttachmentPath(attachmentPath, opts = {}) {
  if (!attachmentPath || typeof attachmentPath !== 'string') return null;
  if (isAbsolute(attachmentPath)) return null;
  const cwd = resolve(opts.cwd || process.cwd());
  const uploadRoot = resolve(cwd, TEMP_UPLOAD_DIR);
  const absPath = resolve(cwd, attachmentPath);
  const rel = relative(uploadRoot, absPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return absPath;
}

/**
 * Read a persisted image attachment into a short-lived preview payload for the
 * web server. Returns null for non-images, bad paths, missing files, or files
 * too large to cache as previews.
 *
 * @param {{name?:string, path?:string, mimeType?:string, isImage?:boolean}} att
 * @param {{ cwd?: string }} [opts]
 * @returns {{data:string,mimeType:string,filename:string}|null}
 */
export function persistedAttachmentPreviewPayload(att, opts = {}) {
  if (!att || !att.isImage || !att.path) return null;
  const absPath = resolvePersistedAttachmentPath(att.path, opts);
  if (!absPath) return null;
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > MAX_PREVIEW_BYTES) return null;
    return {
      data: readFileSync(absPath).toString('base64'),
      mimeType: att.mimeType || 'application/octet-stream',
      filename: att.name || basename(absPath),
    };
  } catch {
    return null;
  }
}
