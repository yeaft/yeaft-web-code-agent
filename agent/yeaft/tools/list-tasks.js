/**
 * list-tasks.js — List active Session background tasks.
 */

import { defineTool } from './types.js';

/** Model-facing projection only; TaskManager snapshots remain the UI/API source. */
export function compactTaskSnapshot(task) {
  if (!task || typeof task !== 'object') return null;
  const runtime = task.runtime && typeof task.runtime === 'object' ? task.runtime : {};
  const log = task.log && typeof task.log === 'object' ? task.log : {};
  return {
    id: task.id,
    kind: task.kind,
    title: typeof task.title === 'string' ? task.title.slice(0, 200) : task.title,
    status: task.status,
    resultDelivery: task.resultDelivery,
    updatedAt: task.updatedAt,
    ...(runtime.subAgentId ? { agentId: runtime.subAgentId } : {}),
    ...(log.path ? { logPath: log.path } : {}),
    ...(runtime.cancelRequestedAt ? { cancelPending: true } : {}),
    ...(runtime.cancelEscalatedAt ? { cancelEscalated: true } : {}),
    ...(runtime.cancelEscalationFailed ? { cancelEscalationFailed: true } : {}),
  };
}

export default defineTool({
  name: 'ListTasks',
  description: {
    en: 'List currently running Session background tasks as compact status references. Use ReadTaskLog for task output.',
    zh: '以紧凑状态引用列出当前运行的 Session 后台任务；任务输出请用 ReadTaskLog。',
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
  cacheWithinQuery: false,
  async execute(input = {}, ctx = {}) {
    if (!ctx.taskManager) return JSON.stringify({ error: 'task manager unavailable' });
    const sessionId = input.sessionId || ctx.sessionId || null;
    const tasks = ctx.taskManager.listActiveTasks(sessionId)
      .map(compactTaskSnapshot)
      .filter(Boolean);
    return JSON.stringify({
      tasks,
      next_steps: tasks.length > 0
        ? 'ReadTaskLog reads output by task id. For sub_agent tasks use WaitAgent/CloseAgent with agentId to collect/cancel; for shell tasks use CancelTask only when cancellation is intended. cancelPending is not proof the process has stopped.'
        : 'No active tasks require follow-up.',
    });
  },
});
