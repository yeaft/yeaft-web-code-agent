/**
 * view-image.js — Load a local image file into the LLM's context.
 *
 * task-333b PR-B: upgraded from metadata-only stub to a real multimodal
 * loader. Returns a tool result that includes:
 *   - `image`: a base64-encoded data URI suitable for embedding into an
 *     LLM image content block (OpenAI / Anthropic style)
 *   - `media_type`: the canonical MIME (image/png, image/jpeg, ...)
 *   - `format`, `width`, `height`, `size`, `sizeFormatted`, `path`
 *
 * Safety rules (per PM 乔布斯 PR-B spec):
 *   - Path safety: no `..`, no absolute paths escaping cwd unless the
 *     resolved path lives under ctx.imageAllowlist[] (absolute dirs
 *     provided by the host).
 *   - Size cap: MAX_IMAGE_BYTES = 10 MiB. Larger files are rejected.
 *   - MIME whitelist: png / jpeg / gif / webp. SVG / BMP / ICO are
 *     intentionally excluded — they either aren't multimodal-LLM-safe
 *     (SVG = embedded script surface) or aren't supported by the
 *     mainstream vision endpoints.
 */

import { defineTool } from './types.js';
import { stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, extname, isAbsolute, relative } from 'path';

/** Max allowed image size in bytes (10 MiB). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Extension → canonical MIME type.
 * The keys are the whitelist; anything else is rejected.
 */
const EXT_TO_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
});

const ALLOWED_EXTS = Object.keys(EXT_TO_MIME);

/**
 * Parse basic image dimensions from header bytes. Best-effort — returns
 * null if the file is too short or the format isn't one we parse.
 *
 * @param {Buffer} buffer
 * @param {string} ext — lowercase extension including the dot
 */
function parseImageDimensions(buffer, ext) {
  try {
    if (ext === '.png' && buffer.length >= 24) {
      // PNG: width at offset 16, height at 20 (big-endian 32-bit)
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((ext === '.jpg' || ext === '.jpeg') && buffer.length > 10) {
      // JPEG: scan for SOF0 (0xFFC0) / SOF2 (0xFFC2) marker
      for (let i = 0; i < buffer.length - 9; i++) {
        if (buffer[i] === 0xFF && (buffer[i + 1] === 0xC0 || buffer[i + 1] === 0xC2)) {
          return {
            height: buffer.readUInt16BE(i + 5),
            width: buffer.readUInt16BE(i + 7),
          };
        }
      }
    }
    if (ext === '.gif' && buffer.length >= 10) {
      // GIF: width at offset 6, height at 8 (little-endian 16-bit)
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (ext === '.webp' && buffer.length >= 30) {
      // WEBP: RIFF...WEBP...VP8(L|X| ). Three common sub-chunks.
      if (buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
          buffer.slice(8, 12).toString('ascii') === 'WEBP') {
        const fourcc = buffer.slice(12, 16).toString('ascii');
        if (fourcc === 'VP8 ' && buffer.length >= 30) {
          // Lossy: width/height at 26/28 as 14-bit LE (mask 0x3FFF)
          return {
            width: buffer.readUInt16LE(26) & 0x3FFF,
            height: buffer.readUInt16LE(28) & 0x3FFF,
          };
        }
        if (fourcc === 'VP8L' && buffer.length >= 25) {
          // Lossless: packed 14+14 bits at offset 21
          const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24];
          const width = 1 + (((b1 & 0x3F) << 8) | b0);
          const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8X' && buffer.length >= 30) {
          // Extended: 24-bit LE widths/heights at 24/27, stored as (n-1)
          const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
          const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
          return { width, height };
        }
      }
    }
  } catch {
    // Dimension parsing is best-effort only.
  }
  return null;
}

/**
 * Check whether `absPath` is allowed given a project `cwd` and an optional
 * allowlist of absolute directories. Returns null on success, or a string
 * error message.
 */
function checkPathAllowed(absPath, cwd, allowlist) {
  // Reject if the resolved path lives inside the project (good).
  const relToCwd = relative(cwd, absPath);
  const insideCwd = relToCwd && !relToCwd.startsWith('..') && !isAbsolute(relToCwd);
  if (insideCwd) return null;

  // Otherwise must match an allowlist entry.
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    for (const dir of allowlist) {
      if (typeof dir !== 'string' || !isAbsolute(dir)) continue;
      const rel = relative(dir, absPath);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return null;
    }
  }

  return 'Path is outside the project directory and not on the image allowlist';
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export default defineTool({
  name: 'ViewImage',
  description: `Load a local image file and attach it to the conversation so the LLM can see it.

Returns a base64 data URI (\`image\` field) plus metadata (format, dimensions,
size). The caller/bridge is responsible for turning the data URI into the
provider-specific image content block.

Supported formats: PNG, JPEG, GIF, WebP.
Max size: 10 MiB.
Path must live under the project directory (or an explicit host allowlist).`,
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the image file. Relative paths are resolved against the project cwd.',
      },
    },
    required: ['file_path'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { file_path } = input || {};
    if (!file_path || typeof file_path !== 'string') {
      return JSON.stringify({ error: 'file_path is required and must be a string' });
    }

    // Reject `..` segments explicitly before path resolution — catches the
    // cases where resolve() might still land inside cwd by accident.
    if (file_path.split(/[/\\]/).some(seg => seg === '..')) {
      return JSON.stringify({ error: 'file_path must not contain `..` segments' });
    }

    const cwd = ctx?.cwd || process.cwd();
    const allowlist = Array.isArray(ctx?.imageAllowlist) ? ctx.imageAllowlist : [];
    const absPath = resolve(cwd, file_path);

    const pathErr = checkPathAllowed(absPath, cwd, allowlist);
    if (pathErr) return JSON.stringify({ error: pathErr, path: absPath });

    const ext = extname(absPath).toLowerCase();
    if (!(ext in EXT_TO_MIME)) {
      return JSON.stringify({
        error: `Unsupported image format: ${ext || '(none)'}`,
        supported: ALLOWED_EXTS,
      });
    }

    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `Image not found: ${absPath}` });
    }

    let fileStat;
    try {
      fileStat = await stat(absPath);
    } catch (err) {
      return JSON.stringify({ error: `Failed to stat image: ${err.message}` });
    }

    if (!fileStat.isFile()) {
      return JSON.stringify({ error: 'file_path does not point to a regular file' });
    }

    if (fileStat.size > MAX_IMAGE_BYTES) {
      return JSON.stringify({
        error: `Image too large: ${formatBytes(fileStat.size)} (max ${formatBytes(MAX_IMAGE_BYTES)})`,
        size: fileStat.size,
        maxSize: MAX_IMAGE_BYTES,
      });
    }

    let buffer;
    try {
      buffer = await readFile(absPath);
    } catch (err) {
      return JSON.stringify({ error: `Failed to read image: ${err.message}` });
    }

    const mediaType = EXT_TO_MIME[ext];
    const base64 = buffer.toString('base64');
    const dataUri = `data:${mediaType};base64,${base64}`;
    const dimensions = parseImageDimensions(buffer, ext);

    const result = {
      path: absPath,
      format: ext.slice(1).toUpperCase() === 'JPG' ? 'JPEG' : ext.slice(1).toUpperCase(),
      media_type: mediaType,
      size: fileStat.size,
      sizeFormatted: formatBytes(fileStat.size),
      modified: fileStat.mtime.toISOString(),
      image: dataUri,
    };
    if (dimensions) {
      result.width = dimensions.width;
      result.height = dimensions.height;
    }

    return JSON.stringify(result, null, 2);
  },
});
