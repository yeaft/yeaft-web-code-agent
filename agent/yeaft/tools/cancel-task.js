/**
 * cancel-task.js — Cancel a running background task.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'CancelTask',
  description: {
    en: 'Cancel a running Session background task.',
    zh: '取消正在运行的 Session 后台任务。',
  },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: { en: 'Task id', zh: '任务 ID' } },
      sessionId: { type: 'string', description: { en: 'Session id (defaults to current Session)', zh: 'Session ID（默认当前 Session）' } },
    },
    required: ['taskId'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input = {}, ctx = {}) {
    if (!ctx.taskManager) return JSON.stringify({ error: 'task manager unavailable' });
    const taskId = input.taskId;
    if (!taskId) return JSON.stringify({ error: 'taskId is required' });
    const sessionId = input.sessionId || ctx.sessionId || 'default';
    return JSON.stringify(ctx.taskManager.cancelTask(sessionId, taskId), null, 2);
  },
});
