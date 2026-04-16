/**
 * file-read.js — Read file contents with line numbers.
 *
 * Reads text files with `cat -n` style line numbering, supports
 * offset/limit for large files, and handles binary file detection.
 *
 * Modeled after Claude Code's Read tool.
 */

import { defineTool } from './types.js';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, extname } from 'path';

/** Binary file extensions that shouldn't be read as text. */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db',
]);

/** Max file size to read (10 MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Default number of lines to read. */
const DEFAULT_LIMIT = 2000;

export default defineTool({
  name: 'FileRead',
  description: `Read a file from the filesystem with line numbers.

Returns file contents with line numbers (like \`cat -n\`).
Supports offset and limit for reading specific portions of large files.

Guidelines:
- Use absolute paths when possible
- For large files, use offset and limit to read specific sections
- Binary files are detected by extension and rejected
- Maximum file size: 10MB
- Default limit: 2000 lines`,
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to read (absolute or relative to cwd)',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based, default: 0)',
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines to read (default: ${DEFAULT_LIMIT})`,
      },
    },
    required: ['file_path'],
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { file_path, offset = 0, limit = DEFAULT_LIMIT } = input;
    if (!file_path) return JSON.stringify({ error: 'file_path is required' });

    const cwd = ctx?.cwd || process.cwd();
    const absPath = resolve(cwd, file_path);

    // Check existence
    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `File not found: ${absPath}` });
    }

    // Check binary
    const ext = extname(absPath).toLowerCase();
    if (BINARY_EXTS.has(ext)) {
      return JSON.stringify({
        error: `Cannot read binary file: ${absPath}`,
        hint: 'Use a specialized tool for binary files',
      });
    }

    try {
      // Check file size
      const fileStat = await stat(absPath);
      if (fileStat.isDirectory()) {
        return JSON.stringify({ error: `Path is a directory: ${absPath}. Use ListDir instead.` });
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        return JSON.stringify({
          error: `File too large: ${(fileStat.size / 1024 / 1024).toFixed(1)}MB (max: ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
          hint: 'Use offset and limit to read specific sections',
        });
      }

      const content = await readFile(absPath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      // Apply offset and limit
      const startLine = Math.max(0, Math.min(offset, totalLines));
      const endLine = Math.min(startLine + limit, totalLines);
      const lines = allLines.slice(startLine, endLine);

      // Format with line numbers (1-based like cat -n)
      const numbered = lines.map((line, i) => {
        const lineNum = startLine + i + 1;
        return `${lineNum}\t${line}`;
      }).join('\n');

      // Add metadata if partial
      if (startLine > 0 || endLine < totalLines) {
        return `${numbered}\n\n[Showing lines ${startLine + 1}-${endLine} of ${totalLines} total]`;
      }

      return numbered;
    } catch (err) {
      return JSON.stringify({ error: `Failed to read file: ${err.message}` });
    }
  },
});
