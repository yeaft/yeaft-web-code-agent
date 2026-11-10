/**
 * wait-task.js — Bounded wait for one Session background task.
 */

import { defineTool } from './types.js';
import { isTerminalTaskStatus } from '../tasks/store.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
// Leave room for JSON escaping and status metadata inside the 32 KiB tool
// projection. Larger logs remain available through ReadTaskLog.
const MAX_LOG_BYTES = 4096;

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
    en: 'Wait for one background task by taskId, up to a bounded timeout. Set include_log to receive status and a bounded log excerpt in one call; otherwise returns status and a log reference only. Use offset for unread output or omit it for the tail. This does not cancel or retry the task; child outcomes still require WaitAgent.',
    zh: '按 taskId 有界等待一个后台任务。include_log 可一次取得状态和有界日志片段；否则只返回状态和日志引用。用 offset 读取未读输出，省略则取末尾；不会取消或重试任务，子 Agent 结果仍须用 WaitAgent 收集。',
  },
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: { en: 'Task id', zh: '任务 ID' } },
      sessionId: { type: 'string', description: { en: 'Session id (defaults to current Session)', zh: 'Session ID（默认当前 Session）' } },
      timeout_ms: { type: 'number', description: { en: `Wait timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`, zh: `等待超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}）` } },
      include_log: { type: 'boolean', description: { en: 'Return a bounded log excerpt after waiting (default false)', zh: '等待后附带有界日志片段（默认 false）' } },
      offset: { type: 'integer', minimum: 0, description: { en: 'Last read nextOffset; omit for the log tail', zh: '上次已读的 nextOffset；省略则取日志末尾' } },
      maxBytes: { type: 'integer', minimum: 1, maximum: MAX_LOG_BYTES, description: { en: `Maximum excerpt bytes (default and max ${MAX_LOG_BYTES}); use ReadTaskLog for more`, zh: `日志片段字节上限（默认及最大 ${MAX_LOG_BYTES}）；更多内容用 ReadTaskLog` } },
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
    const response = taskWaitResult(result);
    if (input.include_log === true && result?.ok && result.task && !ctx.signal?.aborted) {
      try {
        const hasOffset = Number.isFinite(input.offset);
        const excerpt = ctx.taskManager.readTaskLog(sessionId, input.taskId, {
          offset: input.offset,
          maxBytes: Math.min(MAX_LOG_BYTES, Math.max(1, Number.isFinite(input.maxBytes) ? input.maxBytes : MAX_LOG_BYTES)),
          tail: !hasOffset,
        }, ctx.currentVpId || null);
        if (excerpt) {
          response.log = {
            ...excerpt,
            endOffset: excerpt.bytes,
            // Store.truncated describes an unread suffix, not an omitted head.
            omittedBefore: excerpt.offset > (hasOffset ? input.offset : 0),
          };
          response.next_steps = 'Only log.offset..log.nextOffset was read; log.endOffset is NOT an already-read cursor. Inspect this evidence and status; use ReadTaskLog for omitted or remaining output, or WaitTask with include_log and offset=log.nextOffset for new output. A timeout does not stop the task; child outcomes still require WaitAgent.';
        } else {
          response.logReadError = 'Task log unavailable';
        }
      } catch (error) {
        // A log read failure must not discard the known execution outcome.
        response.logReadError = error.message || 'Unable to read task log';
      }
    }
    return JSON.stringify(response, null, 2);
  },
});
