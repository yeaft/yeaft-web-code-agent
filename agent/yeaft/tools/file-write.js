/**
 * file-write.js — Write or create files.
 *
 * Creates new files or overwrites existing ones. Creates parent
 * directories as needed.
 */

import { defineTool } from './types.js';
import { writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';

export default defineTool({
  name: 'FileWrite',
  description: {
    en: `Write content to a file, creating it if it doesn't exist.

Creates parent directories automatically and overwrites the entire file on disk.

Guidelines:
- Use absolute paths when possible
- Use FileWrite only for creating new files or rewriting a short file in full; for modifying existing files — especially large ones — use FileEdit incrementally by section instead of overwriting the whole file
- Prefer modular files split by responsibility over an oversized monolith; when a new file must be large, write a focused skeleton with FileWrite first and fill in sections incrementally with FileEdit
- Because FileWrite replaces the whole file, content must be the complete file content (never a partial snippet)`,
    zh: `将内容写入文件，若文件不存在则创建。

自动创建父目录，并覆盖磁盘上的整个文件。

使用指南：
- 尽量使用绝对路径
- 仅在创建新文件或整份重写简短文件时使用 FileWrite；修改已有文件（尤其是较大文件）时，请按区块分批使用 FileEdit，不要整文件覆盖
- 优先按职责拆分为适中的模块文件，避免单次写入超长单体文件；确需新建较大文件时，先用 FileWrite 写清晰骨架，再用 FileEdit 分段补充
- 由于 FileWrite 会替换整个文件，content 必须为完整文件内容（不要只传片段）`
  },
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: {
          en: 'Path to the file to write (absolute or relative to cwd)',
          zh: '要写入的文件路径（绝对路径或相对于工作目录）',
        },
      },
      content: {
        type: 'string',
        description: {
          en: 'The complete file content to write',
          zh: '要写入的完整文件内容',
        },
      },
    },
    required: ['file_path', 'content'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  async execute(input, ctx) {
    const { file_path, content } = input;
    if (!file_path) return JSON.stringify({ errorEffect: 'none', error: 'file_path is required' });
    if (content === undefined || content === null) {
      return JSON.stringify({ errorEffect: 'none', error: 'content is required' });
    }

    const cwd = ctx?.cwd || process.cwd();
    const absPath = resolve(cwd, file_path);

    try {
      // Ensure parent directory exists
      const dir = dirname(absPath);
      await mkdir(dir, { recursive: true });

      // Write the file
      await writeFile(absPath, content, 'utf-8');

      const lines = content.split('\n').length;
      const bytes = Buffer.byteLength(content, 'utf-8');

      return JSON.stringify({
        success: true,
        path: absPath,
        lines,
        bytes,
        message: `Wrote ${lines} lines (${bytes} bytes) to ${absPath}`,
      });
    } catch (err) {
      return JSON.stringify({ error: `Failed to write file: ${err.message}` });
    }
  },
});
