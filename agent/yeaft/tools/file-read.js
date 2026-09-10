/**
 * file-read.js — Read file contents with line numbers.
 *
 * Reads text files with `cat -n` style line numbering, supports
 * `offset`/`limit` for >3000-line files, and handles binary file
 * detection.
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

/** Default number of lines to read. Aligned with the FileRead tool schema's
 *  "large file = >3000 lines" rule so a ≤3000-line file is returned in one
 *  call (no silent truncation that would trigger a follow-up `offset:3000`
 *  call — exactly the round-trip the tool guidance avoids). */
const DEFAULT_LIMIT = 3000;

/** Keep raw output close to the model-facing 32 KiB budget while leaving
 * room for line metadata and the Registry's localized truncation marker. */
const DEFAULT_OUTPUT_BYTES = 30 * 1024;

function takeUtf8(text, maxBytes) {
  const chars = [];
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    chars.push(char);
    bytes += size;
  }
  return { text: chars.join(''), charCount: chars.length, bytes };
}

function formatLinesWithinBudget(allLines, startLine, endLine, startColumn = 0, maxBytes = DEFAULT_OUTPUT_BYTES) {
  const parts = [];
  let usedBytes = 0;
  let nextLine = startLine;
  let nextColumn = startColumn;
  for (let i = startLine; i < endLine; i += 1) {
    const prefix = parts.length > 0 ? '\n' : '';
    const lineChars = Array.from(allLines[i]);
    const column = i === startLine ? Math.min(startColumn, lineChars.length) : 0;
    const linePrefix = `${i + 1}\t${column > 0 ? `[column ${column}] ` : ''}`;
    const formatted = linePrefix + lineChars.slice(column).join('');
    const remaining = maxBytes - usedBytes - Buffer.byteLength(prefix, 'utf8');
    if (remaining <= 0) break;
    const bounded = takeUtf8(formatted, remaining);
    if (!bounded.text) break;
    parts.push(prefix + bounded.text);
    usedBytes += Buffer.byteLength(prefix, 'utf8') + bounded.bytes;
    if (bounded.text !== formatted) {
      nextLine = i;
      nextColumn = column + Math.max(0, bounded.charCount - Array.from(linePrefix).length);
      break;
    }
    nextLine = i + 1;
    nextColumn = 0;
  }
  return { text: parts.join(''), nextLine, nextColumn };
}

export default defineTool({
  name: 'FileRead',
  description: {
    en: `Read a file from the filesystem with line numbers.

Returns file contents with line numbers (like \`cat -n\`).
Supports offset and limit for reading specific portions of large files.

Guidelines:
- Use absolute paths when possible
- Read only the smallest range that answers the current question. A whole-file read is reasonable only when the file is at most 3000 lines and its full contents are actually needed.
- Do not repeat a successful read with the same range. Continue only when the truncation marker or inspected content shows that another range is necessary.
- Binary files are detected by extension and rejected
- Maximum file size: 10MB
- Default limit: 3000 lines (matches the "large file = >3000 lines" threshold)`,
    zh: `读取文件系统中的文件内容，带行号。

返回带行号的文件内容（类似 cat -n）。支持 offset/limit 读取大文件的特定部分。

使用指南：
- 尽量使用绝对路径
- 只读取能回答当前问题的最小范围。只有文件不超过 3000 行且确实需要全部内容时，才适合整文件读取
- 不要用相同范围重复成功的读取。只有截断标记或已检查的内容表明仍需其他范围时才继续
- 二进制文件通过扩展名识别并拒绝
- 最大文件大小：10MB
- 默认行数限制：3000 行`
  },
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: {
          en: 'Path to the file to read (absolute or relative to cwd)',
          zh: '要读取的文件路径（绝对路径或相对于当前工作目录）',
        },
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: {
          en: 'Line number to start reading from (0-based, default: 0)',
          zh: '起始行号（从 0 开始计数，默认 0）',
        },
      },
      column_offset: {
        type: 'integer',
        minimum: 0,
        description: { en: 'Unicode character offset within the first requested line (0-based, default: 0)', zh: '首个待读行内的 Unicode 字符偏移量（从 0 开始，默认 0）' },
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: {
          en: `Maximum number of lines to read (default: ${DEFAULT_LIMIT})`,
          zh: `最多读取行数（默认 ${DEFAULT_LIMIT} 行）`,
        },
      },
    },
    required: ['file_path'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  cacheWithinQuery: true,
  async execute(input, ctx) {
    const { file_path, offset = 0, column_offset = 0, limit = DEFAULT_LIMIT } = input;
    if (!file_path) return JSON.stringify({ error: 'file_path is required' });
    if (!Number.isInteger(offset) || offset < 0) {
      return JSON.stringify({ error: 'offset must be a non-negative integer' });
    }
    if (!Number.isInteger(column_offset) || column_offset < 0) {
      return JSON.stringify({ error: 'column_offset must be a non-negative integer' });
    }
    if (!Number.isInteger(limit) || limit < 1) {
      return JSON.stringify({ error: 'limit must be a positive integer' });
    }

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

      if (offset > totalLines) {
        return JSON.stringify({ error: `offset ${offset} exceeds file length (${totalLines} lines)` });
      }
      if (offset === totalLines) {
        return `[Offset ${offset} is at end of file (${totalLines} lines total).]`;
      }

      // Apply offset and limit
      const startLine = offset;
      const endLine = Math.min(startLine + limit, totalLines);
      const startColumn = column_offset;
      const { text: numbered, nextLine, nextColumn } = formatLinesWithinBudget(allLines, startLine, endLine, startColumn);

      const hasMoreContent = nextColumn > 0 || nextLine < totalLines;
      if (startLine > 0 || startColumn > 0 || hasMoreContent) {
        const continuation = hasMoreContent
          ? nextColumn > 0
            ? ` Continue with offset=${nextLine}, column_offset=${nextColumn}.`
            : ` Continue with offset=${nextLine}.`
          : '';
        const shownEnd = nextColumn > 0 ? nextLine + 1 : nextLine;
        return `${numbered}\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${totalLines} total.${continuation}]`;
      }

      return numbered;
    } catch (err) {
      return JSON.stringify({ error: `Failed to read file: ${err.message}` });
    }
  },
});
