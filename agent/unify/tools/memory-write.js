/**
 * memory-write.js — Write memory entries to the Yeaft memory store.
 *
 * Creates, updates, or deletes memory entries. Also supports
 * appending lines to MEMORY.md sections and overwriting the profile.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'MemoryWrite',
  description: `Write to Yeaft's persistent memory system.

Actions:
- "write_entry" — create or update a memory entry (entries/*.md)
- "delete_entry" — delete a memory entry by name
- "write_profile" — overwrite the full MEMORY.md profile
- "add_to_section" — append a line to a section in MEMORY.md

Memory kinds: fact, preference, skill, lesson, context, relation
Importance levels: low, normal, high, critical`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['write_entry', 'delete_entry', 'write_profile', 'add_to_section'],
        description: 'What memory operation to perform',
      },
      entry: {
        type: 'object',
        description: 'Memory entry data (for "write_entry")',
        properties: {
          name: { type: 'string', description: 'Entry name (will be slugified for filename)' },
          kind: { type: 'string', enum: ['fact', 'preference', 'skill', 'lesson', 'context', 'relation'] },
          scope: { type: 'string', description: 'Scope path, e.g. "global", "work/my-project"' },
          tags: { type: 'array', items: { type: 'string' } },
          importance: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
          content: { type: 'string', description: 'The memory content (markdown body)' },
        },
        required: ['name', 'content'],
      },
      name: {
        type: 'string',
        description: 'Entry name slug (for "delete_entry") or section name (for "add_to_section")',
      },
      content: {
        type: 'string',
        description: 'Content for "write_profile" or line to add for "add_to_section"',
      },
    },
    required: ['action'],
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const memoryStore = ctx?.memoryStore;
    if (!memoryStore) {
      return JSON.stringify({ error: 'Memory system not initialized' });
    }

    try {
      switch (input.action) {
        case 'write_entry': {
          if (!input.entry) return JSON.stringify({ error: 'entry is required for "write_entry"' });
          if (!input.entry.name) return JSON.stringify({ error: 'entry.name is required' });
          if (!input.entry.content) return JSON.stringify({ error: 'entry.content is required' });

          const slug = memoryStore.writeEntry(input.entry);
          return JSON.stringify({
            success: true,
            slug,
            message: `Memory entry "${input.entry.name}" saved as ${slug}.md`,
          });
        }

        case 'delete_entry': {
          if (!input.name) return JSON.stringify({ error: 'name is required for "delete_entry"' });
          const deleted = memoryStore.deleteEntry(input.name);
          return JSON.stringify({
            success: deleted,
            message: deleted
              ? `Deleted memory entry "${input.name}"`
              : `Entry "${input.name}" not found`,
          });
        }

        case 'write_profile': {
          if (!input.content && input.content !== '') {
            return JSON.stringify({ error: 'content is required for "write_profile"' });
          }
          memoryStore.writeProfile(input.content);
          return JSON.stringify({ success: true, message: 'MEMORY.md updated' });
        }

        case 'add_to_section': {
          if (!input.name) return JSON.stringify({ error: 'name (section) is required for "add_to_section"' });
          if (!input.content) return JSON.stringify({ error: 'content (line) is required for "add_to_section"' });
          memoryStore.addToSection(input.name, input.content);
          return JSON.stringify({
            success: true,
            message: `Added to section "${input.name}" in MEMORY.md`,
          });
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${input.action}` });
      }
    } catch (err) {
      return JSON.stringify({ error: `Memory write failed: ${err.message}` });
    }
  },
});
