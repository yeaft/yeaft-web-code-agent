/**
 * attachments.js — Unify (group/feature) attachment handling.
 *
 * Mirrors the Chat-mode pipeline implemented in `agent/workbench/transfer.js`,
 * adapted to the Unify architecture:
 *
 *   - Chat mode has a per-conversation `state.workDir` and a single
 *     in-flight Claude SDK query — `transfer.js` enqueues a constructed
 *     user message into that query's `inputStream`.
 *   - Unify mode has many VPs taking turns inside a group, no per-VP
 *     workDir, and the Engine accepts the user message via `query()`
 *     args. So we (a) save attachments to a shared per-group folder
 *     under the agent's CWD (so file-tools using `ctx.cwd` can read
 *     them with relative paths) and (b) hand back BOTH a synthesized
 *     prompt suffix listing the saved paths AND a `promptParts` array
 *     containing real `image` content blocks for the LLM call.
 *
 * Inputs (`files`) come from the server-side resolver in
 * `client-conversation.js` / `client-crew.js`: each entry is
 * `{ name, mimeType, data: <base64>, isImage }` — the `pendingFiles`
 * `fileId` was already consumed by the server before `forwardToAgent`.
 *
 * Output:
 *   - `savedFiles`: persisted metadata `{ name, path, mimeType, isImage }`
 *     suitable for the group jsonl-log (NO base64 — must stay small).
 *   - `promptSuffix`: text to append to the user's prompt so the model
 *     sees the file list in the same form Chat mode uses.
 *   - `promptParts`: an array of `{ type:'image', source:{ data, mediaType } }`
 *     blocks for images, ready to be combined with a text block for
 *     `engine.query({ promptParts })`. Empty when no images are present.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

// Same dir name Chat mode uses, so ".gitignore" rules and tool-side
// expectations stay identical.
const TEMP_UPLOAD_DIR = '.claude-tmp-attachments';

/**
 * Persist resolved files to disk and build the LLM-side payload pieces.
 *
 * @param {Array<{name:string, mimeType:string, data:string, isImage?:boolean}>} files
 *        Resolved files from server (pendingFiles → base64).
 * @param {Object} [opts]
 * @param {string} [opts.subdir]   Sub-folder under TEMP_UPLOAD_DIR
 *        (e.g. groupId). Lets multiple groups co-exist without clobbering.
 * @param {string} [opts.cwd]      Override base dir; defaults to process.cwd()
 *        which is what unify tools (file-read, bash, ...) resolve relative
 *        paths against.
 * @returns {{
 *   savedFiles: Array<{name:string, path:string, mimeType:string, isImage:boolean}>,
 *   promptSuffix: string,
 *   promptParts: Array<{type:'image', source:{type:'base64', mediaType:string, data:string}}>
 * }}
 */
export function persistUnifyAttachments(files, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const subdir = opts.subdir ? String(opts.subdir).replace(/[^a-zA-Z0-9._-]/g, '_') : '';
  const uploadDir = subdir
    ? join(cwd, TEMP_UPLOAD_DIR, subdir)
    : join(cwd, TEMP_UPLOAD_DIR);

  if (!Array.isArray(files) || files.length === 0) {
    return { savedFiles: [], promptSuffix: '', promptParts: [] };
  }

  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const savedFiles = [];
  const promptParts = [];

  for (const file of files) {
    if (!file || !file.name || !file.data) continue;
    try {
      const ts = Date.now();
      const ext = extname(file.name);
      const base = basename(file.name, ext);
      // Sanitize the base name so weird user filenames (spaces, slashes)
      // don't blow up downstream tool calls. The original name is kept
      // in `savedFiles[].name` for display.
      const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'file';
      const uniqueName = `${safeBase}_${ts}${ext || ''}`;
      const absPath = join(uploadDir, uniqueName);
      const relPath = subdir
        ? join(TEMP_UPLOAD_DIR, subdir, uniqueName)
        : join(TEMP_UPLOAD_DIR, uniqueName);

      const buffer = Buffer.from(file.data, 'base64');
      writeFileSync(absPath, buffer);

      const isImage = !!file.isImage || (file.mimeType || '').startsWith('image/');
      savedFiles.push({
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
            // Both adapters accept either `mediaType` or `media_type`
            // (see openai-responses.js:#translateUserContent and the
            // Anthropic upstream contract). Use the camelCase form to
            // match `openai-responses.js` exactly.
            mediaType: file.mimeType || 'image/png',
            data: file.data,
          },
        });
      }
    } catch (err) {
      console.warn('[Unify attachments] save failed for', file?.name, err?.message || err);
    }
  }

  let promptSuffix = '';
  if (savedFiles.length > 0) {
    const lines = savedFiles.map((f) =>
      `- ${f.path} (${f.isImage ? 'image' : f.mimeType})`
    );
    promptSuffix = `\n\n[Uploaded files]\n${lines.join('\n')}`;
  }

  return { savedFiles, promptSuffix, promptParts };
}

/**
 * Strip base64 data from a resolved-files array so it can be safely
 * persisted (e.g. into a group jsonl-log or memory entry). Keeps name,
 * mimeType, isImage, and the on-disk path returned by
 * `persistUnifyAttachments`.
 *
 * @param {Array<{name:string, path:string, mimeType:string, isImage:boolean}>} savedFiles
 * @returns {Array<{name:string, path:string, mimeType:string, isImage:boolean}>}
 */
export function attachmentsForPersistence(savedFiles) {
  if (!Array.isArray(savedFiles)) return [];
  return savedFiles.map((f) => ({
    name: f.name,
    path: f.path,
    mimeType: f.mimeType,
    isImage: !!f.isImage,
  }));
}
