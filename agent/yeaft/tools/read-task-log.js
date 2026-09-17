/**
 * read-task-log.js — Read a background task log.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'ReadTaskLog',
  description: {
    en: 'Read a background task log by taskId. The first read defaults to the tail. For later reads, pass the previous nextOffset as offset to receive only new bytes; an explicit offset defaults tail to false.',
    zh: '按 taskId 读取后台任务日志。首次读取默认返回末尾；后续把上次返回的 nextOffset 作为 offset 传入即可只读取新增字节，显式传 offset 时 tail 默认 false。',
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
  cacheWithinQuery: false,
  duplicateCallPolicy: () => 'allow',
  async execute(input = {}, ctx = {}) {
    if (!ctx.taskManager) return JSON.stringify({ error: 'task manager unavailable' });
    if (ctx.sessionId && input.sessionId && input.sessionId !== ctx.sessionId) {
      return JSON.stringify({ error: 'Task access is limited to the current Session', errorEffect: 'none' });
    }
    const taskId = input.taskId;
    if (!taskId) return JSON.stringify({ error: 'taskId is required' });
    const sessionId = input.sessionId || ctx.sessionId || 'default';
    const hasOffset = Number.isFinite(input.offset);
    const result = ctx.taskManager.readTaskLog(sessionId, taskId, {
      offset: input.offset,
      maxBytes: input.maxBytes,
      tail: typeof input.tail === 'boolean' ? input.tail : !hasOffset,
    }, ctx.currentVpId || null);
    return JSON.stringify(result || { error: `Unknown task: ${taskId}` }, null, 2);
  },
});
