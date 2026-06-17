/**
 * glob.js — Find files by pattern matching.
 *
 * Uses Node.js glob patterns to find files matching a pattern.
 * Results are sorted by modification time (newest first).
 */

import { defineTool } from './types.js';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative } from 'path';

/**
 * Simple glob pattern matcher (supports * and **).
 * @param {string} pattern
 * @param {string} str
 * @returns {boolean}
 */
function matchGlob(pattern, str) {
  // Convert glob pattern to regex
  // IMPORTANT: escape dots FIRST before replacing glob chars to avoid
  // corrupting regex tokens like [^/]* and .*
  let regex = pattern
    .replace(/\\/g, '/')
    .replace(/\./g, '\\.')     // Escape dots first (before glob replacements)
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/\?/g, '[^/]');
  regex = '^' + regex + '$';
  return new RegExp(regex).test(str.replace(/\\/g, '/'));
}

/**
 * Recursively walk a directory, yielding relative paths.
 */
async function* walkDir(dir, baseDir, maxDepth = 10, depth = 0) {
  if (depth > maxDepth) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Skip common large/irrelevant directories
  const SKIP = new Set([
    'node_modules', '.git', '__pycache__', '.next', '.nuxt',
    'dist', 'build', '.cache', '.venv', 'venv', '.tox',
    'vendor', 'target', '.gradle', '.idea', '.vscode',
  ]);

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      yield { path: relPath, isDir: true };
      yield* walkDir(fullPath, baseDir, maxDepth, depth + 1);
    } else {
      yield { path: relPath, isDir: false };
    }
  }
}

export default defineTool({
  name: 'Glob',
  description: {
  en: `Find files matching a glob pattern.

Supports glob patterns like "**/*.js", "src/**/*.ts", "*.md".
Results are sorted by modification time (newest first).

Guidelines:
- Use "**/" for recursive directory matching
- Common directories (node_modules, .git, etc.) are skipped
- Returns file paths relative to the search directory
- Limited to 500 results by default`,
  zh: `查找匹配 glob 模式的文件。

支持如 "**/*.js"、"src/**/*.ts"、"*.md" 等 glob 模式。结果按修改时间排序（最新优先）。

使用指南：
- 用 "**/" 进行递归目录匹配
- 常见目录（node_modules、.git 等）被跳过
- 返回相对于搜索目录的文件路径
- 默认限制 500 条结果`
},
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g. "**/*.js")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (default: cwd)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 500)',
      },
    },
    required: ['pattern'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { pattern, path: searchPath, limit = 500 } = input;
    if (!pattern) return JSON.stringify({ error: 'pattern is required' });

    const cwd = ctx?.cwd || process.cwd();
    const baseDir = searchPath ? resolve(cwd, searchPath) : cwd;

    if (!existsSync(baseDir)) {
      return JSON.stringify({ error: `Directory not found: ${baseDir}` });
    }

    try {
      const matches = [];

      for await (const entry of walkDir(baseDir, baseDir)) {
        if (matches.length >= limit * 2) break; // over-fetch for sorting

        if (!entry.isDir && matchGlob(pattern, entry.path)) {
          // Get mtime for sorting
          try {
            const fileStat = await stat(join(baseDir, entry.path));
            matches.push({
              path: entry.path,
              mtime: fileStat.mtimeMs,
            });
          } catch {
            matches.push({ path: entry.path, mtime: 0 });
          }
        }
      }

      // Sort by mtime (newest first)
      matches.sort((a, b) => b.mtime - a.mtime);

      // Trim to limit
      const trimmed = matches.slice(0, limit);

      return trimmed.map(m => m.path).join('\n') || '(no matches)';
    } catch (err) {
      return JSON.stringify({ error: `Glob search failed: ${err.message}` });
    }
  },
});
