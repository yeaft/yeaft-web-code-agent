/**
 * skill.js — Skill invocation tool
 *
 * Allows the LLM to load and activate skills from the skill library.
 * Skills are specialized behaviors defined in ~/.yeaft/skills/*.md.
 *
 * Reference: yeaft-unify-design.md §8
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'Skill',
  description: `Load and activate a skill from the Yeaft skill library.

Skills are specialized behaviors or workflows defined in ~/.yeaft/skills/.
Use this tool to:
- List available skills
- Load a specific skill's instructions
- Find relevant skills for the current context

Skills provide domain-specific guidance and workflows that enhance your capabilities.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'load', 'search'],
        description: '"list" lists all skills, "load" loads a specific skill, "search" finds relevant skills',
      },
      name: {
        type: 'string',
        description: 'Skill name (for "load" action)',
      },
      query: {
        type: 'string',
        description: 'Search query (for "search" action)',
      },
    },
    required: ['action'],
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const skillManager = ctx?.skillManager;

    if (!skillManager) {
      return JSON.stringify({
        error: 'Skill system not initialized. Skills directory: ~/.yeaft/skills/',
      });
    }

    switch (input.action) {
      case 'list': {
        const skills = skillManager.list();
        if (skills.length === 0) {
          return JSON.stringify({
            skills: [],
            message: 'No skills found. Add .md files to ~/.yeaft/skills/ to create skills.',
          });
        }
        return JSON.stringify({
          skills: skills.map(s => ({
            name: s.name,
            description: s.description || '',
            trigger: s.trigger || '',
            mode: s.mode || 'both',
          })),
          totalCount: skills.length,
        }, null, 2);
      }

      case 'load': {
        if (!input.name) {
          return JSON.stringify({ error: 'Skill name is required for "load" action' });
        }
        const content = skillManager.getPromptContent(input.name);
        if (!content) {
          return JSON.stringify({
            error: `Skill "${input.name}" not found`,
            available: skillManager.list().map(s => s.name),
          });
        }
        return content;
      }

      case 'search': {
        if (!input.query) {
          return JSON.stringify({ error: 'Query is required for "search" action' });
        }
        const results = skillManager.findRelevant(input.query);
        return JSON.stringify({
          results: results.map(s => ({
            name: s.name,
            description: s.description || '',
            trigger: s.trigger || '',
          })),
          totalResults: results.length,
        }, null, 2);
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${input.action}. Use "list", "load", or "search".` });
    }
  },
});
