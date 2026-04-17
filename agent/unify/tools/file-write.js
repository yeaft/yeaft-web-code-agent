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
  description: `Write content to a file, creating it if it doesn't exist.

Creates parent directories automatically. Overwrites existing files.

Guidelines:
- Use absolute paths when possible
- For modifying existing files, prefer FileEdit (surgical edits) over FileWrite (full overwrite)
- Parent directories are created automatically
- Content should be the complete file content`,
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to write (absolute or relative to cwd)',
      },
      content: {
        type: 'string',
        description: 'The complete file content to write',
      },
    },
    required: ['file_path', 'content'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  async execute(input, ctx) {
    const { file_path, content } = input;
    if (!file_path) return JSON.stringify({ error: 'file_path is required' });
    if (content === undefined || content === null) {
      return JSON.stringify({ error: 'content is required' });
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
