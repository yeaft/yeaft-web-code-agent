/**
 * apply-patch.js — Apply a unified diff patch to files.
 *
 * Parses unified diff format and applies changes to the target files.
 * Supports multiple files in a single patch.
 */

import { defineTool } from './types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

/**
 * Parse a unified diff into hunks.
 * @param {string} patch
 * @returns {Array<{ file: string, hunks: Array }>}
 */
function parsePatch(patch) {
  const files = [];
  const lines = patch.split('\n');
  let currentFile = null;
  let currentHunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: --- a/path or +++ b/path
    if (line.startsWith('--- ')) {
      // Next line should be +++
      continue;
    }
    if (line.startsWith('+++ ')) {
      let filePath = line.slice(4).trim();
      // Strip a/ or b/ prefix
      if (filePath.startsWith('b/')) filePath = filePath.slice(2);
      if (filePath === '/dev/null') continue;

      currentFile = { file: filePath, hunks: [] };
      files.push(currentFile);
      continue;
    }

    // Hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (!currentFile) continue;
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    // Diff content lines
    if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
      currentHunk.lines.push(line);
    }
  }

  return files;
}

/**
 * Apply hunks to file content.
 */
function applyHunks(content, hunks) {
  const lines = content.split('\n');
  let offset = 0; // tracks line number shifts from previous hunks

  for (const hunk of hunks) {
    const startLine = hunk.oldStart - 1 + offset; // 0-based
    const newLines = [];
    let removedCount = 0;

    for (const diffLine of hunk.lines) {
      if (diffLine.startsWith('+')) {
        newLines.push(diffLine.slice(1));
      } else if (diffLine.startsWith('-')) {
        removedCount++;
      } else if (diffLine.startsWith(' ') || diffLine === '') {
        newLines.push(diffLine.startsWith(' ') ? diffLine.slice(1) : diffLine);
      }
    }

    // Replace the old lines with new lines
    lines.splice(startLine, removedCount + (hunk.oldCount - removedCount > 0 ? hunk.oldCount - removedCount : 0), ...newLines);
    offset += newLines.length - hunk.oldCount;
  }

  return lines.join('\n');
}

export default defineTool({
  name: 'ApplyPatch',
  description: `Apply a unified diff patch to files.

Parses unified diff format (like git diff output) and applies changes.
Supports patching multiple files in a single diff.

Guidelines:
- Provide standard unified diff format (--- a/file, +++ b/file, @@ hunks)
- Ensure the diff matches the current file content exactly
- New files are created automatically with parent directories`,
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'The unified diff patch content',
      },
    },
    required: ['patch'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  async execute(input, ctx) {
    const { patch } = input;
    if (!patch) return JSON.stringify({ error: 'patch is required' });

    const cwd = ctx?.cwd || process.cwd();

    try {
      const fileDiffs = parsePatch(patch);

      if (fileDiffs.length === 0) {
        return JSON.stringify({ error: 'No valid file diffs found in patch' });
      }

      const results = [];

      for (const fileDiff of fileDiffs) {
        const absPath = resolve(cwd, fileDiff.file);

        try {
          let content;
          if (existsSync(absPath)) {
            content = await readFile(absPath, 'utf-8');
          } else {
            // New file
            await mkdir(dirname(absPath), { recursive: true });
            content = '';
          }

          const newContent = applyHunks(content, fileDiff.hunks);
          await writeFile(absPath, newContent, 'utf-8');

          results.push({
            file: fileDiff.file,
            success: true,
            hunks: fileDiff.hunks.length,
          });
        } catch (err) {
          results.push({
            file: fileDiff.file,
            success: false,
            error: err.message,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      return JSON.stringify({
        results,
        summary: `Applied patch to ${successCount}/${results.length} files`,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: `Failed to apply patch: ${err.message}` });
    }
  },
});
