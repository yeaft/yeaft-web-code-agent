/**
 * memory-query.js — Search atomic memory entries by keywords/tags/scope.
 *
 * New-layout tool (task-287 memory refactor).
 *
 * Delegates to MemoryStore.findByFilter + MemoryStore.search for the actual
 * heavy lifting; this is a tool-exposed wrapper that:
 *   1. Accepts flat `keywords[]` (used as tags AND as content keyword scan)
 *   2. Optional tags[], scope, limit
 *   3. Returns a compact list suitable for LLM consumption
 *
 * Use this for fuzzy discovery over atomic entries. For loading a known
 * classification file in full, use `memory_search` instead.
 */

import { defineTool } from './types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const SNIPPET_CHARS = 400;

export default defineTool({
  name: 'memory_query',
  description: `Search Yeaft's atomic memory entries by keywords, tags, and scope.

Scoring:
  - Exact scope match: +3
  - Ancestor/descendant scope: +2
  - "global" scope (fallback): +1
  - Each tag overlap: +1
  - Keyword hit in entry content/name/tags: retained

Use this when the system-prompt Memory Index suggests the info is in atomic
entries (entries/) rather than in a classification file. Returns up to 'limit'
results sorted by score descending.`,
  parameters: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Words to search in entry content/name/tags. Required.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact-tag filter (scored separately from keywords).',
      },
      scope: {
        type: 'string',
        description: 'Memory scope to prefer (e.g. "work/my-project").',
      },
      limit: {
        type: 'number',
        description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
      },
    },
    required: ['keywords'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const memoryStore = ctx?.memoryStore;
    if (!memoryStore) {
      return JSON.stringify({ error: 'Memory system not initialized' });
    }

    const keywords = Array.isArray(input?.keywords)
      ? input.keywords.filter(k => typeof k === 'string' && k.trim())
      : [];
    if (keywords.length === 0) {
      return JSON.stringify({ error: 'keywords is required and must be a non-empty string array' });
    }

    const tags = Array.isArray(input?.tags)
      ? input.tags.filter(t => typeof t === 'string' && t.trim())
      : [];
    const scope = typeof input?.scope === 'string' ? input.scope : undefined;
    const rawLimit = Number.isFinite(input?.limit) ? input.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));

    try {
      // Union tags: explicit tags[] + keywords (keywords double as tag hints)
      const tagUnion = [...new Set([...tags, ...keywords])];

      // Phase 1: scored filter by scope + tags
      let results = memoryStore.findByFilter({
        scope,
        tags: tagUnion,
        limit: limit * 3, // over-fetch for phase 2
      });

      // Phase 2: if any entries lack tag overlap, augment with keyword full-text
      // scan so rare-word queries still surface entries with matching content.
      const seen = new Set(results.map(e => e.name));
      for (const kw of keywords) {
        if (results.length >= limit * 3) break;
        const extra = memoryStore.search(kw, limit);
        for (const e of extra) {
          if (!seen.has(e.name)) {
            seen.add(e.name);
            results.push({ ...e, _score: (e._score || 0) + 0.5 });
          }
        }
      }

      // Final sort + trim
      results.sort((a, b) => (b._score || 0) - (a._score || 0));
      results = results.slice(0, limit);

      return JSON.stringify({
        totalResults: results.length,
        results: results.map(e => ({
          name: e.name,
          kind: e.kind,
          scope: e.scope,
          tags: e.tags || [],
          importance: e.importance,
          score: e._score,
          snippet: e.content
            ? (e.content.length > SNIPPET_CHARS
                ? e.content.slice(0, SNIPPET_CHARS) + '…'
                : e.content)
            : '',
          updated_at: e.updated_at,
        })),
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: `memory_query failed: ${err.message}` });
    }
  },
});
