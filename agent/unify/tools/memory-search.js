/**
 * memory-search.js → memory_load (task-333b rename).
 *
 * This tool loads memory classification files by path (it is NOT a search).
 * task-333b renamed it from `memory_search` → `memory_load` so the name
 * actually reflects behaviour; `memory_query` remains the fuzzy search tool.
 *
 * Backwards compatibility: a thin alias tool named `memory_search` is also
 * exported (see bottom of file) so older transcripts/prompts still resolve.
 *
 * The system prompt injects `index.md` every turn, which lists all available
 * classification files under `~/.yeaft/memory/` (single files + by-project /
 * by-topic / timeline categories). When the LLM sees a path it wants,
 * it calls this tool with `paths: [...]` to load one or more of those files
 * in full.
 *
 * Only paths under `memory/` are accepted. `..` segments are rejected.
 */

import { defineTool } from './types.js';
import { readMemoryFile, listClassificationFiles } from '../memory/layout.js';

const MAX_FILES_PER_CALL = 5;
const MAX_BYTES_PER_FILE = 32000;

const DESCRIPTION = `Load one or more memory classification files in full.

Paths are relative to ~/.yeaft/memory/. Allowed targets:
  - user-preferences.md           — merged user preferences
  - by-project/<slug>.md          — per-project narrative summary
  - by-topic/<slug>.md            — per-topic narrative summary
  - timeline/<YYYY-MM>.md         — monthly narrative digest

See the "Memory Index" section of the system prompt for the current list
of available files. Use this tool when the index suggests a file is relevant
to the user's current request. For fuzzy search over atomic memory entries
(facts, lessons, preferences), use the memory_query tool instead.

Up to ${MAX_FILES_PER_CALL} files per call. Each file is capped at ${MAX_BYTES_PER_FILE} bytes.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Relative paths under memory/. Example: ["by-project/claude-web-chat.md", "user-preferences.md"]',
    },
  },
  required: ['paths'],
};

async function executeLoad(input, ctx) {
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
}

/**
 * Canonical tool — `memory_load`. This is the default export so existing
 * import sites (`import memorySearch from './memory-search.js'`) keep
 * working; the renamed identity is expressed via the tool's `name`.
 */
const memoryLoad = defineTool({
  name: 'memory_load',
  description: DESCRIPTION,
  parameters: PARAMETERS,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  execute: executeLoad,
});

/**
 * Deprecated alias — `memory_search`. Kept so older prompts / saved tool
 * calls still resolve. Delegates to the same executor. Do not use for new
 * call sites. Emits a one-time console.warn on first invocation.
 */
const _memSearchWarned = { v: false };
async function executeLoadWithWarn(input, ctx) {
  if (!_memSearchWarned.v) {
    _memSearchWarned.v = true;
    // eslint-disable-next-line no-console
    console.warn('[deprecated] memory_search → memory_load. Use memory_load for path-based file loading; use memory_query for fuzzy keyword search.');
  }
  return executeLoad(input, ctx);
}

export const memorySearchAlias = defineTool({
  name: 'memory_search',
  description: `DEPRECATED alias of memory_load (renamed in task-333b). ${DESCRIPTION}`,
  parameters: PARAMETERS,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  execute: executeLoadWithWarn,
});

export default memoryLoad;
