/**
 * file-edit.js — Surgical string-replacement edits to files.
 *
 * Performs exact string matching and replacement within files,
 * similar to Claude Code's Edit tool. Supports replace_all for
 * bulk replacements across the file.
 */

import { defineTool } from './types.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

export default defineTool({
  name: 'FileEdit',
  description: {
  en: `Make surgical text replacements in an existing file.

Replaces exact occurrences of old_string with new_string.
The old_string must be unique in the file unless replace_all is true.

Guidelines:
- old_string must match EXACTLY (including whitespace and indentation)
- The edit fails if old_string is not found or is not unique
- Use replace_all: true to replace ALL occurrences
- For creating new files or full rewrites, use FileWrite instead
- Always read the file first to understand its current content`,
  zh: `在已有文件中做精确文本替换。

用 new_string 替换 old_string 的精确出现。old_string 在文件中必须唯一，除非设置 replace_all 为 true。

使用指南：
- old_string 必须完全匹配（包括空白和缩进）
- 若 old_string 找不到或不唯一，编辑失败
- 使用 replace_all: true 替换所有出现位置
- 创建新文件或全量重写请用 FileWrite
- 始终先读文件了解其当前内容`
},
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to edit (absolute or relative to cwd)',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find and replace',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false — fails if not unique)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  async execute(input, ctx) {
    const { file_path, old_string, new_string, replace_all = false } = input;
    if (!file_path) return JSON.stringify({ error: 'file_path is required' });
    if (old_string === undefined) return JSON.stringify({ error: 'old_string is required' });
    if (new_string === undefined) return JSON.stringify({ error: 'new_string is required' });
    if (old_string === new_string) return JSON.stringify({ error: 'old_string and new_string are identical' });

    const cwd = ctx?.cwd || process.cwd();
    const absPath = resolve(cwd, file_path);

    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `File not found: ${absPath}` });
    }

    try {
      const content = await readFile(absPath, 'utf-8');

      // Count occurrences
      let count = 0;
      let idx = 0;
      while (true) {
        idx = content.indexOf(old_string, idx);
        if (idx === -1) break;
        count++;
        idx += old_string.length;
      }

      if (count === 0) {
        // Provide context for debugging
        const preview = old_string.length > 100
          ? old_string.slice(0, 100) + '...'
          : old_string;
        return JSON.stringify({
          error: `old_string not found in file`,
          hint: `The exact text "${preview}" was not found in ${absPath}. Check whitespace and indentation.`,
        });
      }

      if (count > 1 && !replace_all) {
        return JSON.stringify({
          error: `old_string found ${count} times — not unique. Use replace_all: true to replace all occurrences, or provide more context to make it unique.`,
          occurrences: count,
        });
      }

      // Perform replacement
      let newContent;
      if (replace_all) {
        newContent = content.split(old_string).join(new_string);
      } else {
        // Replace only the first occurrence (which is guaranteed unique)
        const replaceIdx = content.indexOf(old_string);
        newContent = content.slice(0, replaceIdx) + new_string + content.slice(replaceIdx + old_string.length);
      }

      await writeFile(absPath, newContent, 'utf-8');

      return JSON.stringify({
        success: true,
        path: absPath,
        replacements: replace_all ? count : 1,
        message: `Replaced ${replace_all ? count : 1} occurrence(s) in ${absPath}`,
      });
    } catch (err) {
      return JSON.stringify({ error: `Failed to edit file: ${err.message}` });
    }
  },
});
