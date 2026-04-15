/**
 * memory-search.js — Search memory entries by scope, tags, and keywords.
 *
 * Uses the MemoryStore's findByFilter for structured search.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'MemorySearch',
  description: `Search Yeaft's persistent memory for relevant entries.

Searches by scope, tags, kind, or keyword. Results are scored by relevance:
- Exact scope match: highest score
- Ancestor/descendant scope: medium score
- Tag overlap: additional score per matching tag
- Keyword in content: found via full-text scan

Use this to find previously learned information before asking the user again.`,
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        description: 'Memory scope to search in (e.g. "global", "work/my-project")',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to filter by',
      },
      kind: {
        type: 'string',
        enum: ['fact', 'preference', 'skill', 'lesson', 'context', 'relation'],
        description: 'Filter by memory kind',
      },
      keyword: {
        type: 'string',
        description: 'Keyword to search in entry content',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 15)',
      },
    },
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const memoryStore = ctx?.memoryStore;
    if (!memoryStore) {
      return JSON.stringify({ error: 'Memory system not initialized' });
    }

    try {
      const limit = input.limit || 15;

      // Use findByFilter for scope + tag search
      let results = memoryStore.findByFilter({
        scope: input.scope,
        tags: input.tags || [],
        limit: limit * 2, // over-fetch for post-filtering
      });

      // Filter by kind if specified
      if (input.kind) {
        results = results.filter(e => e.kind === input.kind);
      }

      // Filter by keyword if specified
      if (input.keyword) {
        const kw = input.keyword.toLowerCase();
        results = results.filter(e =>
          (e.content && e.content.toLowerCase().includes(kw)) ||
          (e.name && e.name.toLowerCase().includes(kw)) ||
          (e.tags && e.tags.some(t => t.toLowerCase().includes(kw)))
        );
      }

      // Trim to limit
      results = results.slice(0, limit);

      return JSON.stringify({
        results: results.map(e => ({
          name: e.name,
          kind: e.kind,
          scope: e.scope,
          tags: e.tags,
          importance: e.importance,
          content: e.content?.slice(0, 500) + (e.content?.length > 500 ? '...' : ''),
          updated_at: e.updated_at,
          score: e._score,
        })),
        totalResults: results.length,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: `Memory search failed: ${err.message}` });
    }
  },
});
