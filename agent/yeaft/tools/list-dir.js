/**
 * list-dir.js — List directory contents.
 *
 * Lists files and directories with type, size, and modification time.
 * Skips common large directories (node_modules, .git, etc.).
 */

import { defineTool } from './types.js';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';

/** Directories to skip in listings. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', '.nuxt', '.cache',
]);

export default defineTool({
  name: 'ListDir',
  description: {
  en: `List the contents of a directory.

Shows files and subdirectories with their types and sizes.
Directories are listed first, then files, both sorted alphabetically.
Common large directories (node_modules, .git) are skipped.

This is better than using Bash with 'ls' because it provides structured output.`,
  zh: `列出目录内容。

显示文件和子目录，含类型和大小。目录优先列出，文件次之，均按字母排序。常见大目录（node_modules、.git）被跳过。

比用 Bash 执行 ls 更好，因为它提供结构化输出。`
},
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list (default: cwd)',
      },
      show_hidden: {
        type: 'boolean',
        description: 'Include hidden files (starting with dot, default: true)',
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { path: dirPath, show_hidden = true } = input;

    const cwd = ctx?.cwd || process.cwd();
    const absPath = dirPath ? resolve(cwd, dirPath) : cwd;

    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `Directory not found: ${absPath}` });
    }

    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      const results = [];

      for (const entry of entries) {
        // Skip hidden files if not requested
        if (!show_hidden && entry.name.startsWith('.')) continue;

        // Skip large directories
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

        try {
          const fullPath = join(absPath, entry.name);
          const fileStat = await stat(fullPath);
          results.push({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: fileStat.size,
            modified: fileStat.mtime.toISOString(),
          });
        } catch {
          results.push({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: 0,
          });
        }
      }

      // Sort: directories first, then files, alphabetically
      results.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // Format as text
      const lines = results.map(r => {
        const typeChar = r.type === 'dir' ? '📁' : '📄';
        const sizeStr = r.type === 'dir' ? '' : ` (${formatSize(r.size)})`;
        return `${typeChar} ${r.name}${sizeStr}`;
      });

      return `${absPath}/\n\n${lines.join('\n')}` || `${absPath}/ (empty directory)`;
    } catch (err) {
      return JSON.stringify({ error: `Failed to list directory: ${err.message}` });
    }
  },
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
