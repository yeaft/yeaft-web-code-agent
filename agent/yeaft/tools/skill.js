/**
 * skill.js — Skill invocation tool (progressive disclosure)
 *
 * Actions:
 *   list   → metadata only (name, description, category, source)
 *   view   → full skill content + linked files listing
 *   search → find relevant skills for a query
 *   load   → alias for view (backward compat)
 *
 * Directory-based skills (SKILL.md + references/ + templates/) support
 * reading linked files via the view action's filePath parameter.
 *
 * Reference: yeaft-yeaft-design.md §8
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'Skill',
  description: {
    en: `Load and query skills from the Yeaft skill library.

Skills are specialized behaviors or workflows in ~/.yeaft/skills/.
Two formats supported:
- Single file: skills/my-skill.md
- Directory: skills/my-skill/SKILL.md + references/ + templates/

Actions:
- "list" — list all skills (metadata only: name, description, category)
- "view" — view a skill's full content. For directory skills, also lists linked files. Pass filePath to read a specific reference/template.
- "search" — find relevant skills for a query string
- "load" — alias for "view" (backward compatible)`,
    zh: `从 Yeaft 技能库加载和查询技能。

技能是 ~/.yeaft/skills/ 中的专业化行为或工作流。支持两种格式：
- 单文件：skills/my-skill.md
- 目录：skills/my-skill/SKILL.md + references/ + templates/

操作：
- "list" — 列出所有技能（仅元数据：名称、描述、分类）
- "view" — 查看技能的完整内容。对目录型技能同时列出关联文件。传 filePath 可读取特定引用/模板。
- "search" — 为查询字符串查找相关技能
- "load" — "view" 的别名（向后兼容）`
  },
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'view', 'load', 'search'],
        description: '"list" lists all skills, "view"/"load" loads a specific skill, "search" finds relevant skills',
      },
      name: {
        type: 'string',
        description: 'Skill name (for "view"/"load" action)',
      },
      query: {
        type: 'string',
        description: 'Search query (for "search" action)',
      },
      filePath: {
        type: 'string',
        description: 'Read a linked file from a directory skill (e.g. "references/style-guide.md")',
      },
      category: {
        type: 'string',
        description: 'Filter by category (for "list" action)',
      },
    },
    required: ['action'],
  },
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
        let skills = skillManager.list();
        if (skills.length === 0) {
          return JSON.stringify({
            skills: [],
            categories: [],
            message: 'No skills found. Add .md files or directories with SKILL.md to ~/.yeaft/skills/',
          });
        }
        // Filter by category if specified
        if (input.category) {
          skills = skills.filter(s => s.category === input.category || (s.category && s.category.startsWith(input.category + '/')));
        }
        return JSON.stringify({
          skills,
          categories: skillManager.listCategories(),
          totalCount: skills.length,
        }, null, 2);
      }

      case 'view':
      case 'load': {
        if (!input.name) {
          return JSON.stringify({ error: 'Skill name is required for "view" action' });
        }
        const result = skillManager.view(input.name, input.filePath);
        if (!result) {
          return JSON.stringify({
            error: `Skill "${input.name}" not found`,
            available: skillManager.list().map(s => s.name),
          });
        }

        // If reading a specific linked file, return just that content
        if (input.filePath && result.linkedContent !== undefined) {
          return result.linkedContent;
        }

        // Return full skill content + linked file listing
        const output = {
          name: result.skill.name,
          description: result.skill.description || '',
          mode: result.skill.mode,
          category: result.skill.category || null,
          source: result.skill._source,
          content: result.skill.content,
        };

        if (result.references.length > 0) {
          output.references = result.references;
        }
        if (result.templates.length > 0) {
          output.templates = result.templates;
        }

        return JSON.stringify(output, null, 2);
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
            category: s.category || null,
            source: s._source,
          })),
          totalResults: results.length,
        }, null, 2);
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${input.action}. Use "list", "view", or "search".` });
    }
  },
});
