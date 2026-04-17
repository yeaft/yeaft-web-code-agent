/**
 * memory-search.js — Load memory classification files by path.
 *
 * New-layout tool (task-287 memory refactor).
 *
 * The system prompt injects `index.md` every turn, which lists all available
 * classification files under `~/.yeaft/memory/` (single files + by-project /
 * by-topic / timeline categories). When the LLM sees a path it wants,
 * it calls this tool with `paths: [...]` to load one or more of those files
 * in full.
 *
 * This is NOT a fuzzy search. It is a precise file loader. Use `memory_query`
 * for fuzzy search over atomic entries.
 *
 * Only paths under `memory/` are accepted. `..` segments are rejected.
 */

import { defineTool } from './types.js';
import { readMemoryFile, listClassificationFiles } from '../memory/layout.js';

const MAX_FILES_PER_CALL = 5;
const MAX_BYTES_PER_FILE = 32000;

export default defineTool({
  name: 'memory_search',
  description: `Load one or more memory classification files in full.

Paths are relative to ~/.yeaft/memory/. Allowed targets:
  - user-preferences.md           — merged user preferences
  - by-project/<slug>.md          — per-project narrative summary
  - by-topic/<slug>.md            — per-topic narrative summary
  - timeline/<YYYY-MM>.md         — monthly narrative digest

See the "Memory Index" section of the system prompt for the current list
of available files. Use this tool when the index suggests a file is relevant
to the user's current request. For fuzzy search over atomic memory entries
(facts, lessons, preferences), use the memory_query tool instead.

Up to ${MAX_FILES_PER_CALL} files per call. Each file is capped at ${MAX_BYTES_PER_FILE} bytes.`,
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relative paths under memory/. Example: ["by-project/claude-web-chat.md", "user-preferences.md"]',
      },
    },
    required: ['paths'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const yeaftDir = ctx?.yeaftDir;
    if (!yeaftDir) {
      return JSON.stringify({ error: 'Memory system not initialized (no yeaftDir in context)' });
    }

    const paths = Array.isArray(input?.paths) ? input.paths : [];
    if (paths.length === 0) {
      return JSON.stringify({
        error: 'paths is required and must be a non-empty string array',
        availablePaths: listClassificationFiles(yeaftDir).map(f => f.path),
      });
    }

    const results = [];
    const errors = [];

    for (const rel of paths.slice(0, MAX_FILES_PER_CALL)) {
      if (typeof rel !== 'string' || !rel.trim()) {
        errors.push({ path: rel, error: 'not a non-empty string' });
        continue;
      }
      if (rel.includes('..') || rel.startsWith('/')) {
        errors.push({ path: rel, error: 'path must be relative and must not contain ..' });
        continue;
      }
      if (!rel.endsWith('.md')) {
        errors.push({ path: rel, error: 'only .md files are supported' });
        continue;
      }

      const text = readMemoryFile(yeaftDir, rel);
      if (!text) {
        errors.push({ path: rel, error: 'file not found or empty' });
        continue;
      }

      const truncated = text.length > MAX_BYTES_PER_FILE;
      results.push({
        path: rel,
        content: truncated ? text.slice(0, MAX_BYTES_PER_FILE) : text,
        truncated,
        size: text.length,
      });
    }

    return JSON.stringify({ results, errors }, null, 2);
  },
});
