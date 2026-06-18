/**
 * list-tasks.js — List active Session background tasks.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'ListTasks',
  description: {
    en: 'List currently running Session background tasks.',
    zh: '列出当前正在运行的 Session 后台任务。',
  },
  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: { en: 'Session id (defaults to current Session)', zh: 'Session ID（默认当前 Session）' },
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input = {}, ctx = {}) {
    if (!ctx.taskManager) return JSON.stringify({ error: 'task manager unavailable' });
    const sessionId = input.sessionId || ctx.sessionId || null;
    return JSON.stringify({ tasks: ctx.taskManager.listActiveTasks(sessionId) }, null, 2);
  },
});
