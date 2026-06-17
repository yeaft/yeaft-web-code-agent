/**
 * ask-user.js — Ask the user a question and wait for their response.
 *
 * In Yeaft mode this tool sends a question through the web-bridge
 * and blocks (via Promise) until the user answers. The answer is
 * returned as the tool result.
 *
 * Reference: yeaft-yeaft-design.md §8
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';

export default defineTool({
  name: 'AskUser',
  description: {
    en: `Ask the user a question and wait for their response.

Use this tool when you need additional information or clarification from the user.
The user will see your question in the chat interface and can type a response.

Guidelines:
- Ask specific, focused questions
- Provide context about why you need the information
- If presenting options, list them clearly
- Don't use this for rhetorical questions — only when you genuinely need user input`,
    zh: `向用户提问并等待回复。

当你需要用户提供更多信息或澄清时使用此工具。用户会在聊天界面中看到你的问题并输入回复。

使用指南：
- 提出具体、聚焦的问题
- 说明你为什么需要这些信息
- 如果提供选项，请清晰列出
- 不要用于反问句——只有真正需要用户输入时才使用`
  },
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of choices for the user to pick from',
      },
    },
    required: ['question'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { question, options } = input;
    if (!question) return JSON.stringify({ error: 'question is required' });

    // Generate a unique request ID for this ask
    const requestId = `ask_${randomUUID().slice(0, 8)}`;

    // In a full web-bridge integration, this would send an ask_user event
    // and await the answer. For now, return a formatted prompt that the
    // LLM can see — the web-bridge handles the ask flow externally.
    return JSON.stringify({
      type: 'ask_user',
      requestId,
      question,
      ...(options ? { options } : {}),
      message: `Question sent to user: "${question}"${options ? ` [Options: ${options.join(', ')}]` : ''}`,
    });
  },
});
