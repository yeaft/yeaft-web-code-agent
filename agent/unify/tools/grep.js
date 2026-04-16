/**
 * grep.js — Search file contents for patterns.
 *
 * Searches for regex patterns in files. Tries to use ripgrep (rg) if
 * available for performance, falls back to a Node.js implementation.
 */

import { defineTool } from './types.js';
import { spawn } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative, extname } from 'path';

/** Max output lines. */
const MAX_LINES = 250;

/** Binary extensions to skip. */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.woff', '.woff2', '.ttf', '.otf',
  '.sqlite', '.db',
]);

/**
 * Check if ripgrep is available.
 */
function hasRipgrep() {
  return new Promise((resolve) => {
    const proc = spawn('rg', ['--version'], { stdio: 'pipe' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Run ripgrep and return results.
 */
function runRipgrep(pattern, searchPath, options) {
  return new Promise((resolve, reject) => {
    const args = [
      pattern,
      searchPath,
      '--no-heading',
      '--line-number',
      '--color', 'never',
    ];

    if (options.caseInsensitive) args.push('-i');
    if (options.glob) args.push('--glob', options.glob);
    if (options.type) args.push('--type', options.type);
    if (options.filesOnly) args.push('-l');
    if (options.count) args.push('-c');
    if (options.context) args.push('-C', String(options.context));
    if (options.before) args.push('-B', String(options.before));
    if (options.after) args.push('-A', String(options.after));
    if (options.multiline) args.push('-U', '--multiline-dotall');
    args.push('--max-count', String(options.maxResults || 500));

    const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // Truncate early if way too large
      if (stdout.length > 512 * 1024) {
        try { proc.kill(); } catch {}
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0 || code === 1) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `rg exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Fallback: Node.js grep implementation.
 */
async function nodeGrep(pattern, searchPath, options) {
  const regex = new RegExp(pattern, options.caseInsensitive ? 'gi' : 'g');
  const results = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache']);

  async function searchDir(dir) {
    if (results.length >= (options.maxResults || 500)) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= (options.maxResults || 500)) return;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        await searchDir(fullPath);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > 1024 * 1024) continue; // skip files > 1MB

          const content = await readFile(fullPath, 'utf-8');
          const relPath = relative(searchPath, fullPath);

          if (options.filesOnly) {
            if (regex.test(content)) results.push(relPath);
            regex.lastIndex = 0;
          } else if (options.count) {
            const matches = content.match(regex);
            if (matches) results.push(`${relPath}:${matches.length}`);
          } else {
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${relPath}:${i + 1}:${lines[i]}`);
              }
              regex.lastIndex = 0;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await searchDir(searchPath);
  return results.join('\n');
}

export default defineTool({
  name: 'Grep',
  description: `Search file contents for a regex pattern.

Uses ripgrep (rg) when available for fast searching, with a Node.js fallback.

Output modes:
- "content" — show matching lines with file path and line numbers
- "files_with_matches" — show only file paths that match (default)
- "count" — show match count per file

Guidelines:
- Uses regex syntax (escape special chars: \\., \\{, etc.)
- Use glob or type filters to narrow the search
- Skips binary files and common large directories (node_modules, .git)
- Results are limited to 500 matches by default`,
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search (default: cwd)',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output format (default: "files_with_matches")',
      },
      glob: {
        type: 'string',
        description: 'Glob filter for file names (e.g. "*.js", "*.{ts,tsx}")',
      },
      type: {
        type: 'string',
        description: 'File type filter (e.g. "js", "py", "rust")',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case-insensitive search (default: false)',
      },
      context: {
        type: 'number',
        description: 'Lines of context around matches (for "content" mode)',
      },
      before: {
        type: 'number',
        description: 'Lines before each match',
      },
      after: {
        type: 'number',
        description: 'Lines after each match',
      },
      multiline: {
        type: 'boolean',
        description: 'Enable multiline matching',
      },
      head_limit: {
        type: 'number',
        description: 'Limit output to first N results (default: 250)',
      },
    },
    required: ['pattern'],
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const {
      pattern, path: searchPath, output_mode = 'files_with_matches',
      glob: globFilter, type, case_insensitive = false,
      context, before, after, multiline = false,
      head_limit = MAX_LINES,
    } = input;

    if (!pattern) return JSON.stringify({ error: 'pattern is required' });

    const cwd = ctx?.cwd || process.cwd();
    const absPath = searchPath ? resolve(cwd, searchPath) : cwd;

    if (!existsSync(absPath)) {
      return JSON.stringify({ error: `Path not found: ${absPath}` });
    }

    const options = {
      caseInsensitive: case_insensitive,
      glob: globFilter,
      type,
      filesOnly: output_mode === 'files_with_matches',
      count: output_mode === 'count',
      context,
      before,
      after,
      multiline,
      maxResults: head_limit * 2,
    };

    try {
      let result;
      const rgAvailable = await hasRipgrep();

      if (rgAvailable) {
        result = await runRipgrep(pattern, absPath, options);
      } else {
        result = await nodeGrep(pattern, absPath, options);
      }

      if (!result || !result.trim()) {
        return '(no matches)';
      }

      // Limit output lines
      const lines = result.trim().split('\n');
      if (lines.length > head_limit) {
        return lines.slice(0, head_limit).join('\n') + `\n\n... (${lines.length - head_limit} more results)`;
      }

      return result.trim();
    } catch (err) {
      return JSON.stringify({ error: `Grep failed: ${err.message}` });
    }
  },
});
