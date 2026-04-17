/**
 * memory-read.js — Read memory entries from the Yeaft memory store.
 *
 * Reads the user profile (MEMORY.md), specific sections, or individual
 * memory entries by name.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'MemoryRead',
  description: `Read from Yeaft's persistent memory system.

Actions:
- "profile" — read the full MEMORY.md user profile
- "section" — read a specific section from MEMORY.md (e.g. "Facts", "Preferences")
- "entry" — read a specific memory entry by name
- "list" — list all memory entries (frontmatter only, no body)
- "scopes" — list all memory scopes and their entry counts`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['profile', 'section', 'entry', 'list', 'scopes'],
        description: 'What to read from memory',
      },
      name: {
        type: 'string',
        description: 'Entry name slug (for "entry" action) or section name (for "section" action)',
      },
    },
    required: ['action'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const memoryStore = ctx?.memoryStore;
    if (!memoryStore) {
      return JSON.stringify({ error: 'Memory system not initialized' });
    }

    try {
      switch (input.action) {
        case 'profile': {
          const profile = memoryStore.readProfile();
          return profile || '(No profile found — MEMORY.md is empty)';
        }

        case 'section': {
          if (!input.name) return JSON.stringify({ error: 'name is required for "section" action' });
          const section = memoryStore.readSection(input.name);
          return section || `(Section "${input.name}" not found in MEMORY.md)`;
        }

        case 'entry': {
          if (!input.name) return JSON.stringify({ error: 'name is required for "entry" action' });
          const entry = memoryStore.readEntry(input.name);
          if (!entry) return JSON.stringify({ error: `Entry "${input.name}" not found` });
          return JSON.stringify(entry, null, 2);
        }

        case 'list': {
          const entries = memoryStore.listEntries();
          return JSON.stringify({
            entries: entries.map(e => ({
              name: e.name,
              kind: e.kind,
              scope: e.scope,
              tags: e.tags,
              importance: e.importance,
              updated_at: e.updated_at,
            })),
            totalCount: entries.length,
          }, null, 2);
        }

        case 'scopes': {
          const scopes = memoryStore.readScopes();
          return JSON.stringify({ scopes }, null, 2);
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${input.action}` });
      }
    } catch (err) {
      return JSON.stringify({ error: `Memory read failed: ${err.message}` });
    }
  },
});
