/**
 * history-search.js — Search conversation history.
 *
 * Searches through persisted conversation messages for keywords.
 * Uses the ConversationStore's search functionality.
 */

import { defineTool } from './types.js';
import { searchMessages } from '../conversation/search.js';

export default defineTool({
  name: 'HistorySearch',
  description: {
    en: `Search through past conversation history.

Searches for keywords in previously persisted conversation messages.
Useful for finding previous discussions, decisions, or code snippets.

Results are returned newest-first with message role and content.`,
    zh: `搜索历史对话记录。

在已持久化的对话消息中按关键词搜索。用于查找之前的讨论、决策或代码片段。

结果按最新优先返回，包含消息角色和内容。`
  },
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: {
          en: 'Search keyword (case-insensitive)',
          zh: '搜索关键词（不区分大小写）',
        },
      },
      limit: {
        type: 'number',
        description: {
          en: 'Maximum number of results (default: 20)',
          zh: '最多返回结果数（默认 20）',
        },
      },
    },
    required: ['keyword'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { keyword, limit = 20 } = input;
    if (!keyword) return JSON.stringify({ error: 'keyword is required' });

    const yeaftDir = ctx?.yeaftDir;
    if (!yeaftDir) {
      return JSON.stringify({ error: 'Yeaft directory not configured — no conversation history available' });
    }

    try {
      const results = searchMessages(yeaftDir, keyword, limit);

      if (results.length === 0) {
        return JSON.stringify({
          results: [],
          message: `No matches found for "${keyword}"`,
        });
      }

      return JSON.stringify({
        results: results.map(msg => ({
          role: msg.role,
          content: msg.content?.slice(0, 2000) + (msg.content?.length > 2000 ? '...' : ''),
          mode: msg.mode,
          timestamp: msg.timestamp,
        })),
        totalResults: results.length,
        keyword,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({ error: `History search failed: ${err.message}` });
    }
  },
});
