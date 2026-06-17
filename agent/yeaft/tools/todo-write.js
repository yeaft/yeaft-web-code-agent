/**
 * todo-write.js — TodoWrite tool: per-VP multi-step task tracking.
 *
 * Mirrors Claude Code's `TodoWrite` tool 1:1 in shape (name + `todos[]`
 * with `content` / `status` / `activeForm`) so the existing frontend
 * rendering pipeline (`MessageList.js:691` → `AssistantTurn.js:53-63`
 * → `ToolLine.js:150`) renders a checkmark-style list automatically
 * without any new UI code. The frontend reads the *input* of the
 * `tool_use` event — not the result — so this tool's persistence story
 * is "stamp into the LLM event stream and cache on ctx for replay."
 *
 * Per-thread isolation: each running VP thread keeps its own current todo
 * list. The web-bridge injects `ctx.getCurrentTodos()` /
 * `ctx.setCurrentTodos()` pointing at a per-(sessionId,vpId,threadId) slot so
 * two concurrent threads for the same VP cannot overwrite each other's
 * progress.
 *
 * Reference: plan §2 (2026-05-13 — Feature system retired, TodoWrite
 * added as the actual progress-tracking surface for the LLM).
 */

import { defineTool } from './types.js';

const VALID_STATUS = new Set(['pending', 'in_progress', 'completed']);

export default defineTool({
  name: 'TodoWrite',
  description: {
  en: `Track multi-step task progress with a checklist that the user can see ticked off in real time.

WHEN TO USE:
- The task has 3+ meaningful steps, or
- The user gave you a list of things to do (numbered/comma-separated), or
- You're about to start a non-trivial, multi-file change.

HOW TO USE:
- First call: enumerate all the todos with status "pending", set exactly one to "in_progress".
- Each subsequent call: rewrite the FULL list — mark the just-finished item "completed", mark the next item "in_progress".
- AT MOST one item may be "in_progress" at any time.
- content is the imperative form ("Run tests"); activeForm is the present-continuous shown during execution ("Running tests").

WHEN NOT TO USE:
- Single trivial change, single command run, pure conversation/question.`,
  zh: `用 checklist 跟踪多步骤任务进度，用户可以实时看到勾选。

何时使用：
- 任务有 3 步或以上有意义步骤，或
- 用户给了你一份待办列表（编号/逗号分隔），或
- 你即将开始一个非平凡的多文件改动。

如何使用：
- 首次调用：枚举所有 todo，状态为 "pending"，将其中恰好一个设为 "in_progress"。
- 每次后续调用：重写完整列表——将刚完成的项标记为 "completed"，将下一项标记为 "in_progress"。
- 任何时候最多只能有一个 "in_progress"。
- content 是祈使形式（如 "Run tests"）；activeForm 是执行时显示的进行时态（如 "Running tests"）。

何时不使用：
- 单个琐碎改动、单个命令执行、纯对话/提问。`
},
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full current todo list. Always send the entire list, not a diff.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Imperative description of the step (e.g. "Run tests").',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current state. At most one item may be "in_progress".',
            },
            activeForm: {
              type: 'string',
              description: 'Present-continuous form shown while executing (e.g. "Running tests").',
            },
          },
          required: ['content', 'status', 'activeForm'],
        },
      },
    },
    required: ['todos'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const todos = input && Array.isArray(input.todos) ? input.todos : null;
    if (!todos || todos.length === 0) {
      return JSON.stringify({ error: 'todos must be a non-empty array' });
    }

    let inProgressCount = 0;
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      if (!t || typeof t !== 'object') {
        return JSON.stringify({ error: `todos[${i}] must be an object` });
      }
      if (typeof t.content !== 'string' || !t.content.trim()) {
        return JSON.stringify({ error: `todos[${i}].content must be a non-empty string` });
      }
      if (typeof t.activeForm !== 'string' || !t.activeForm.trim()) {
        return JSON.stringify({ error: `todos[${i}].activeForm must be a non-empty string` });
      }
      if (!VALID_STATUS.has(t.status)) {
        return JSON.stringify({
          error: `todos[${i}].status must be one of: pending, in_progress, completed`,
        });
      }
      if (t.status === 'in_progress') inProgressCount += 1;
    }

    if (inProgressCount > 1) {
      return JSON.stringify({
        error: `at most one todo may be in_progress at a time (found ${inProgressCount})`,
      });
    }

    // Cache the current todo list onto the per-VP slot if the web-bridge
    // provided one. Best-effort: this is the cache the frontend may pull
    // on reconnect / VP-switch. Tools should not crash if the slot is
    // missing — sub-agent ctx or test ctx may lack it.
    if (ctx && typeof ctx.setCurrentTodos === 'function') {
      try { ctx.setCurrentTodos(todos.slice()); } catch { /* swallow */ }
    }

    const counts = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of todos) counts[t.status] += 1;

    return JSON.stringify({
      success: true,
      count: todos.length,
      pending: counts.pending,
      in_progress: counts.in_progress,
      completed: counts.completed,
    });
  },
});
