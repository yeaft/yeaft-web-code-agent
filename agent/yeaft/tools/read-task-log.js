/**
 * read-task-log.js — Read a background task log.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'ReadTaskLog',
  description: {
    en: 'Read a background task log by taskId. Supports tail reads and byte offsets.',
    zh: '按 taskId 读取后台任务日志。支持 tail 和字节 offset。',
  },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: { en: 'Task id', zh: '任务 ID' } },
      sessionId: { type: 'string', description: { en: 'Session id (defaults to current Session)', zh: 'Session ID（默认当前 Session）' } },
      offset: { type: 'number', description: { en: 'Byte offset to start reading from', zh: '开始读取的字节 offset' } },
      maxBytes: { type: 'number', description: { en: 'Maximum bytes to read (max 1 MiB)', zh: '最多读取字节数（最大 1 MiB）' } },
      tail: { type: 'boolean', description: { en: 'Read the last maxBytes bytes', zh: '读取最后 maxBytes 字节' } },
    },
    required: ['taskId'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input = {}, ctx = {}) {
    if (!ctx.taskManager) return JSON.stringify({ error: 'task manager unavailable' });
    const taskId = input.taskId;
    if (!taskId) return JSON.stringify({ error: 'taskId is required' });
    const sessionId = input.sessionId || ctx.sessionId || 'default';
    const result = ctx.taskManager.readTaskLog(sessionId, taskId, {
      offset: input.offset,
      maxBytes: input.maxBytes,
      tail: input.tail !== false,
    });
    return JSON.stringify(result, null, 2);
  },
});
