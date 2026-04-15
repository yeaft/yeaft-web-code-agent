/**
 * view-image.js — Read and describe an image file.
 *
 * Returns image metadata (dimensions, format, size).
 * In a full multimodal integration, would pass the image to the LLM.
 */

import { defineTool } from './types.js';
import { stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, extname } from 'path';

/** Supported image formats. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico']);

/**
 * Parse basic image dimensions from headers.
 */
function parseImageDimensions(buffer, ext) {
  try {
    if (ext === '.png') {
      // PNG: width at offset 16, height at 20 (big-endian 32-bit)
      if (buffer.length >= 24) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      }
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      // JPEG: scan for SOF0 marker (0xFF 0xC0)
      for (let i = 0; i < buffer.length - 9; i++) {
        if (buffer[i] === 0xFF && (buffer[i + 1] === 0xC0 || buffer[i + 1] === 0xC2)) {
          return {
            height: buffer.readUInt16BE(i + 5),
            width: buffer.readUInt16BE(i + 7),
          };
        }
      }
    }
    if (ext === '.gif') {
      // GIF: width at offset 6, height at 8 (little-endian 16-bit)
      if (buffer.length >= 10) {
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
      }
    }
  } catch {
    // Dimension parsing is best-effort
  }
  return null;
}

export default defineTool({
  name: 'ViewImage',
  description: `View an image file and get its metadata.

Returns image format, dimensions, and file size.
Supports PNG, JPEG, GIF, BMP, WebP, SVG, and ICO.`,
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the image file',
      },
    },
    required: ['file_path'],
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { file_path } = input;
    if (!file_path) return JSON.stringify({ error: 'file_path is required' });

    const cwd = ctx?.cwd || process.cwd();
    const absPath = resolve(cwd, file_path);

    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `Image not found: ${absPath}` });
    }

    const ext = extname(absPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      return JSON.stringify({ error: `Not a recognized image format: ${ext}` });
    }

    try {
      const fileStat = await stat(absPath);
      const buffer = await readFile(absPath);

      const dimensions = parseImageDimensions(buffer, ext);

      const result = {
        path: absPath,
        format: ext.slice(1).toUpperCase(),
        size: fileStat.size,
        sizeFormatted: fileStat.size < 1024 ? `${fileStat.size}B`
          : fileStat.size < 1024 * 1024 ? `${(fileStat.size / 1024).toFixed(1)}KB`
          : `${(fileStat.size / 1024 / 1024).toFixed(1)}MB`,
        modified: fileStat.mtime.toISOString(),
      };

      if (dimensions) {
        result.width = dimensions.width;
        result.height = dimensions.height;
      }

      // For SVG, include a text preview
      if (ext === '.svg') {
        const svgText = buffer.toString('utf-8');
        result.preview = svgText.slice(0, 500);
      }

      return JSON.stringify(result, null, 2);
    } catch (err) {
      return JSON.stringify({ error: `Failed to read image: ${err.message}` });
    }
  },
});
