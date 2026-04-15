/**
 * Task management tools — in-memory task tracking for work mode.
 *
 * Tasks are organized in a simple flat list with status tracking.
 * Persisted only in memory for the session duration.
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';

/** In-memory task store. */
const tasks = new Map();

/** Plan text (free-form markdown). */
let currentPlan = '';

/** Get task store for other tools. */
export function getTaskStore() {
  return tasks;
}

export function getPlan() {
  return currentPlan;
}

// ─── TaskCreate ─────────────────────────────────────────

export const taskCreate = defineTool({
  name: 'TaskCreate',
  description: `Create a new task for tracking work progress.

Tasks have a title, description, priority, and status.
Use this to break down complex work into trackable items.`,
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
    },
    required: ['title'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { title, description, priority = 'medium', parent_id } = input;
    if (!title) return JSON.stringify({ error: 'title is required' });

    const id = `task-${randomUUID().slice(0, 8)}`;
    const task = {
      id,
      title,
      description: description || '',
      priority,
      status: 'pending',
      parentId: parent_id || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    tasks.set(id, task);

    return JSON.stringify({
      success: true,
      task: { id, title, priority, status: 'pending' },
      message: `Task created: ${title} (${id})`,
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
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { task_id, status, priority, title, description, result } = input;
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const task = tasks.get(task_id);
    if (!task) return JSON.stringify({ error: `Task not found: ${task_id}` });

    if (status) task.status = status;
    if (priority) task.priority = priority;
    if (title) task.title = title;
    if (description !== undefined) task.description = description;
    if (result) task.result = result;
    task.updatedAt = Date.now();

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
  modes: ['work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { status, include_completed = true } = input;

    const taskList = [];
    for (const [, task] of tasks) {
      if (status && task.status !== status) continue;
      if (!include_completed && task.status === 'completed') continue;
      taskList.push({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        parentId: task.parentId,
        hasResult: !!task.result,
      });
    }

    // Sort: in_progress first, then pending, then others
    const ORDER = { in_progress: 0, pending: 1, blocked: 2, completed: 3, cancelled: 4 };
    taskList.sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5));

    return JSON.stringify({
      tasks: taskList,
      totalCount: taskList.length,
      summary: {
        pending: taskList.filter(t => t.status === 'pending').length,
        in_progress: taskList.filter(t => t.status === 'in_progress').length,
        completed: taskList.filter(t => t.status === 'completed').length,
        blocked: taskList.filter(t => t.status === 'blocked').length,
      },
    }, null, 2);
  },
});

// ─── TaskGet ────────────────────────────────────────────

export const taskGet = defineTool({
  name: 'TaskGet',
  description: `Get detailed information about a specific task.`,
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
  modes: ['work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { task_id } = input;
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const task = tasks.get(task_id);
    if (!task) return JSON.stringify({ error: `Task not found: ${task_id}` });

    // Find subtasks
    const subtasks = [];
    for (const [, t] of tasks) {
      if (t.parentId === task_id) {
        subtasks.push({ id: t.id, title: t.title, status: t.status });
      }
    }

    return JSON.stringify({
      ...task,
      subtasks,
    }, null, 2);
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
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { parent_task_id, title, description, priority = 'medium' } = input;
    if (!parent_task_id) return JSON.stringify({ error: 'parent_task_id is required' });
    if (!title) return JSON.stringify({ error: 'title is required' });

    const parent = tasks.get(parent_task_id);
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

    tasks.set(id, task);

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
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: (input) => input?.action === 'view',
  async execute(input, ctx) {
    const { action, content } = input;

    switch (action) {
      case 'view':
        return currentPlan || '(No plan set yet)';

      case 'update':
        if (!content) return JSON.stringify({ error: 'content is required for "update"' });
        currentPlan = content;
        return JSON.stringify({ success: true, message: 'Plan updated', length: content.length });

      case 'append':
        if (!content) return JSON.stringify({ error: 'content is required for "append"' });
        currentPlan = currentPlan ? `${currentPlan}\n\n${content}` : content;
        return JSON.stringify({ success: true, message: 'Plan updated (appended)', length: currentPlan.length });

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
});
