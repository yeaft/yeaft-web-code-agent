/**
 * Task management tools — persistent task tracking for work mode.
 *
 * Tasks are persisted to ~/.yeaft/tasks/ via TaskStore (one folder per task).
 * Call initTaskStore(yeaftDir) during session init before tools are used.
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';
import { TaskStore } from '../tasks/store.js';

/** @type {TaskStore|null} */
let taskStore = null;

/**
 * Initialize the task store with the yeaft directory.
 * Must be called during session startup before any task tools are used.
 * @param {string} yeaftDir — Base ~/.yeaft directory
 * @param {{ readOnly?: boolean }} [opts]
 */
export function initTaskStore(yeaftDir, opts) {
  taskStore = new TaskStore(yeaftDir, opts);
}

/** Get the task store instance (for other tools/tests). */
export function getTaskStore() {
  return taskStore;
}

/** Get current plan text. */
export function getPlan() {
  return taskStore ? taskStore.getPlan() : '';
}

/** Internal helper — ensure store is initialized. */
function requireStore() {
  if (!taskStore) {
    return '{"error":"Task store not initialized. Session may still be loading."}';
  }
  return null;
}

// ─── TaskCreate ─────────────────────────────────────────

export const taskCreate = defineTool({
  name: 'TaskCreate',
  description: `Create a new task for tracking work progress.

Tasks have a title, description, priority, and status.
Each task gets its own folder with task.md, progress.md, and memory.md.
Use this to break down complex work into trackable items.

Pass \`parent_id\` to create a subtask under an existing task.`,
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short task title',
      },
      description: {
        type: 'string',
        description: 'Detailed task description',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Task priority (default: "medium")',
      },
      parent_id: {
        type: 'string',
        description: 'Parent task ID for subtasks',
      },
      // Note (task-333b): `parent_task_id` is accepted by execute() as a
      // soft-compat alias for `parent_id` (absorbed from the former
      // SpawnTask tool) but intentionally NOT advertised in the schema to
      // avoid giving the LLM two live params for one field.
    },
    required: ['title'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { title, description, priority = 'medium', parent_id, parent_task_id } = input;
    if (!title) return JSON.stringify({ error: 'title is required' });

    // task-333b: accept either `parent_id` (original TaskCreate field) or
    // `parent_task_id` (the former SpawnTask field). When both are present,
    // parent_id wins.
    const parentId = parent_id || parent_task_id || null;
    if (parentId && !taskStore.get(parentId)) {
      return JSON.stringify({ error: `Parent task not found: ${parentId}` });
    }

    const id = `task-${randomUUID().slice(0, 8)}`;
    const task = {
      id,
      title,
      description: description || '',
      priority,
      status: 'pending',
      parentId,
      parentTaskId: parentId, // design §5 canonical field
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    taskStore.create(task);

    return JSON.stringify({
      success: true,
      task: { id, title, priority, status: 'pending', parentTaskId: parentId },
      message: parentId
        ? `Subtask created: ${title} (${id}) under ${parentId}`
        : `Task created: ${title} (${id})`,
    });
  },
});

// ─── TaskUpdate ─────────────────────────────────────────

export const taskUpdate = defineTool({
  name: 'TaskUpdate',
  description: `Update a task's status, priority, or details.

Status values: pending, in_progress, completed, blocked, cancelled`,
  parameters: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to update',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
        description: 'New task status',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'New priority',
      },
      title: {
        type: 'string',
        description: 'Updated title',
      },
      description: {
        type: 'string',
        description: 'Updated description',
      },
      result: {
        type: 'string',
        description: 'Task result or completion notes',
      },
    },
    required: ['task_id'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { task_id, status, priority, title, description, result } = input;
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const updates = {};
    if (status) updates.status = status;
    if (priority) updates.priority = priority;
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (result) updates.result = result;

    const task = taskStore.update(task_id, updates);
    if (!task) return JSON.stringify({ error: `Task not found: ${task_id}` });

    return JSON.stringify({
      success: true,
      task: { id: task.id, title: task.title, status: task.status, priority: task.priority },
      message: `Task "${task.title}" updated`,
    });
  },
});

// ─── TaskList ───────────────────────────────────────────

export const taskList = defineTool({
  name: 'TaskList',
  description: `List all tracked tasks with their status.

Shows task IDs, titles, status, and priority. Filter by status if needed.`,
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
        description: 'Filter by status (optional)',
      },
      include_completed: {
        type: 'boolean',
        description: 'Include completed tasks (default: true)',
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { status, include_completed = true } = input;

    let results = taskStore.list(status ? { status } : undefined);
    if (!include_completed) {
      results = results.filter(t => t.status !== 'completed');
    }

    const taskItems = results.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      parentId: t.parentId,
      hasResult: !!t.result,
    }));

    // Sort: in_progress first, then pending, then others
    const ORDER = { in_progress: 0, pending: 1, blocked: 2, completed: 3, cancelled: 4 };
    taskItems.sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5));

    return JSON.stringify({
      tasks: taskItems,
      totalCount: taskItems.length,
      summary: {
        pending: taskItems.filter(t => t.status === 'pending').length,
        in_progress: taskItems.filter(t => t.status === 'in_progress').length,
        completed: taskItems.filter(t => t.status === 'completed').length,
        blocked: taskItems.filter(t => t.status === 'blocked').length,
      },
    }, null, 2);
  },
});

// ─── TaskGet ────────────────────────────────────────────

export const taskGet = defineTool({
  name: 'TaskGet',
  description: `Get detailed information about a specific task, including its progress log and memory.`,
  parameters: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID to retrieve',
      },
    },
    required: ['task_id'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { task_id } = input;
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const task = taskStore.get(task_id);
    if (!task) return JSON.stringify({ error: `Task not found: ${task_id}` });

    // Find subtasks
    const allTasks = taskStore.list();
    const subtasks = allTasks
      .filter(t => t.parentId === task_id)
      .map(t => ({ id: t.id, title: t.title, status: t.status }));

    return JSON.stringify({
      ...task,
      subtasks,
      hasProgress: !!taskStore.getProgress(task_id),
      hasMemory: !!taskStore.getMemory(task_id),
    }, null, 2);
  },
});

// ─── TaskProgress ───────────────────────────────────────

export const taskProgress = defineTool({
  name: 'TaskProgress',
  description: `View or append to a task's progress log.

The progress log is an append-only timeline of what happened during task execution.
Use "view" to see the full log, or "append" to add a new entry.`,
  parameters: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID',
      },
      action: {
        type: 'string',
        enum: ['view', 'append'],
        description: '"view" shows progress log, "append" adds an entry',
      },
      note: {
        type: 'string',
        description: 'Progress note to append (required for "append")',
      },
    },
    required: ['task_id', 'action'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'view',
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { task_id, action, note } = input;
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const task = taskStore.get(task_id);
    if (!task) return JSON.stringify({ error: `Task not found: ${task_id}` });

    switch (action) {
      case 'view':
        return taskStore.getProgress(task_id) || '(No progress entries yet)';

      case 'append':
        if (!note) return JSON.stringify({ error: 'note is required for "append"' });
        taskStore.appendProgress(task_id, note, { status: task.status });
        return JSON.stringify({ success: true, message: `Progress noted for "${task.title}"` });

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
});

// ─── TaskMemory ─────────────────────────────────────────

export const taskMemory = defineTool({
  name: 'TaskMemory',
  description: `View or update a task's memory (context notes, key decisions, references).

Task memory stores persistent context relevant to the task — key decisions,
references to files, architectural notes, etc. Unlike progress (append-only),
memory can be rewritten to keep it current.`,
  parameters: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Task ID',
      },
      action: {
        type: 'string',
        enum: ['view', 'update'],
        description: '"view" shows memory, "update" replaces it',
      },
      content: {
        type: 'string',
        description: 'New memory content (required for "update")',
      },
    },
    required: ['task_id', 'action'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'view',
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { task_id, action, content } = input;
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const task = taskStore.get(task_id);
    if (!task) return JSON.stringify({ error: `Task not found: ${task_id}` });

    switch (action) {
      case 'view':
        return taskStore.getMemory(task_id) || '(No memory entries yet)';

      case 'update':
        if (!content) return JSON.stringify({ error: 'content is required for "update"' });
        taskStore.updateMemory(task_id, content);
        return JSON.stringify({ success: true, message: `Memory updated for "${task.title}"` });

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
});

// ─── FollowupTask ───────────────────────────────────────

export const followupTask = defineTool({
  name: 'FollowupTask',
  description: `Create a follow-up task linked to an existing task.

Use when a completed task reveals additional work needed.
The new task is linked as a child of the original.`,
  parameters: {
    type: 'object',
    properties: {
      parent_task_id: {
        type: 'string',
        description: 'ID of the original task',
      },
      title: {
        type: 'string',
        description: 'Follow-up task title',
      },
      description: {
        type: 'string',
        description: 'Why this follow-up is needed',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
      },
    },
    required: ['parent_task_id', 'title'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { parent_task_id, title, description, priority = 'medium' } = input;
    if (!parent_task_id) return JSON.stringify({ error: 'parent_task_id is required' });
    if (!title) return JSON.stringify({ error: 'title is required' });

    const parent = taskStore.get(parent_task_id);
    if (!parent) return JSON.stringify({ error: `Parent task not found: ${parent_task_id}` });

    const id = `task-${randomUUID().slice(0, 8)}`;
    const task = {
      id,
      title,
      description: description || `Follow-up to: ${parent.title}`,
      priority,
      status: 'pending',
      parentId: parent_task_id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    taskStore.create(task);

    return JSON.stringify({
      success: true,
      task: { id, title, priority, status: 'pending', parentId: parent_task_id },
      message: `Follow-up task created: ${title} (linked to ${parent.title})`,
    });
  },
});

// ─── UpdatePlan ─────────────────────────────────────────

export const updatePlan = defineTool({
  name: 'UpdatePlan',
  description: `Update or view the current execution plan.

The plan is a free-form markdown document that describes the overall
approach, steps, and status of the current work.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'update', 'append'],
        description: '"view" shows current plan, "update" replaces it, "append" adds to it',
      },
      content: {
        type: 'string',
        description: 'Plan content (for "update" and "append" actions)',
      },
    },
    required: ['action'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'view',
  async execute(input, ctx) {
    const err = requireStore();
    if (err) return err;

    const { action, content } = input;

    switch (action) {
      case 'view':
        return taskStore.getPlan() || '(No plan set yet)';

      case 'update':
        if (!content) return JSON.stringify({ error: 'content is required for "update"' });
        taskStore.setPlan(content);
        return JSON.stringify({ success: true, message: 'Plan updated', length: content.length });

      case 'append': {
        if (!content) return JSON.stringify({ error: 'content is required for "append"' });
        const existing = taskStore.getPlan();
        const newPlan = existing ? `${existing}\n\n${content}` : content;
        taskStore.setPlan(newPlan);
        return JSON.stringify({ success: true, message: 'Plan updated (appended)', length: newPlan.length });
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
});
