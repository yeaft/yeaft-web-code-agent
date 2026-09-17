/**
 * wait-task.js — Bounded wait for one Session background task.
 */

import { defineTool } from './types.js';
import { isTerminalTaskStatus } from '../tasks/store.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export function taskWaitResult(result) {
  if (!result?.ok) return { error: result?.error || 'Unable to wait for task' };
  const task = result.task;
  if (!task) return { error: 'Task state unavailable' };
  const log = task.log && typeof task.log === 'object' ? task.log : {};
  const taskResult = task.result && typeof task.result === 'object' ? task.result : {};
  return {
    taskId: task.id,
    status: task.status,
    terminal: isTerminalTaskStatus(task.status),
    timedOut: result.timedOut === true,
    exitCode: Number.isInteger(taskResult.exitCode) ? taskResult.exitCode : null,
    signal: taskResult.signal || null,
    resultDelivery: task.resultDelivery,
    resultConsumed: false,
    ...(task.runtime?.subAgentId ? { agentId: task.runtime.subAgentId } : {}),
    ...(task.runtime?.cancelRequestedAt ? { cancelPending: !isTerminalTaskStatus(task.status) } : {}),
    next_steps: 'Status only; no output was consumed. ReadTaskLog with your last read offset (or tail) for evidence; use WaitAgent for a child result. Do not use log.endOffset as an already-read cursor.',
    error: taskResult.error || null,
    log: {
      ...(log.path ? { path: log.path } : {}),
      bytes: Number.isFinite(log.bytes) ? log.bytes : 0,
      endOffset: Number.isFinite(log.bytes) ? log.bytes : 0,
    },
  };
}

export default defineTool({
  name: 'WaitTask',
  description: {
    en: 'Wait for one background task by taskId, up to a bounded timeout. Returns terminal status and a log cursor/reference, never the whole log. This does not cancel or retry the task.',
    zh: '按 taskId 有界等待一个后台任务。仅返回终态和日志游标/引用，不返回完整日志；不会取消或重试任务。',
  },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: { en: 'Task id', zh: '任务 ID' } },
      sessionId: { type: 'string', description: { en: 'Session id (defaults to current Session)', zh: 'Session ID（默认当前 Session）' } },
      timeout_ms: { type: 'number', description: { en: `Wait timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`, zh: `等待超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}）` } },
    },
    required: ['taskId'],
  },
  timeoutMs: 0,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  cacheWithinQuery: false,
  duplicateCallPolicy: () => 'allow',
  async execute(input = {}, ctx = {}) {
    if (!ctx.taskManager) return JSON.stringify({ error: 'task manager unavailable' });
    if (ctx.sessionId && input.sessionId && input.sessionId !== ctx.sessionId) {
      return JSON.stringify({ error: 'Task access is limited to the current Session', errorEffect: 'none' });
    }
    if (!input.taskId) return JSON.stringify({ error: 'taskId is required' });
    const sessionId = input.sessionId || ctx.sessionId || 'default';
    const timeoutMs = Math.min(Math.max(Number.isFinite(input.timeout_ms) ? input.timeout_ms : DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS);
    const result = await ctx.taskManager.waitForTask(sessionId, input.taskId, {
      timeoutMs,
      signal: ctx.signal || null,
      ownerVpId: ctx.currentVpId || null,
    });
    return JSON.stringify(taskWaitResult(result), null, 2);
  },
});
