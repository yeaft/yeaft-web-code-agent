/**
 * spawn-task-tools.js — Thin semantic-sugar wrappers over TaskCreate.
 *
 * Phase 1 of task-299: expose `SpawnTask` and `SpawnSubtask` as first-class
 * tool names so the LLM can "spawn" work items in the same vocabulary it
 * uses to spawn threads. Both delegate to the existing TaskStore (shared
 * with TaskCreate), so there is a single source of truth for task data.
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';
import { getTaskStore } from './task-tools.js';

function requireStore() {
  const store = getTaskStore();
  if (!store) return { error: 'Task store not initialized. Session may still be loading.' };
  return { store };
}

function newTaskId() {
  return `task-${randomUUID().slice(0, 8)}`;
}

// ─── SpawnTask ──────────────────────────────────────────

export const spawnTask = defineTool({
  name: 'SpawnTask',
  description: `Spawn a new top-level task.

Equivalent to TaskCreate without a parent. Provided as a first-class
name so tasks and threads can be "spawned" with a uniform vocabulary.`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
      },
    },
    required: ['title'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input) {
    const got = requireStore();
    if (got.error) return JSON.stringify({ error: got.error });
    const { title, description = '', priority = 'medium' } = input || {};
    if (!title) return JSON.stringify({ error: 'title is required' });

    const id = newTaskId();
    const now = Date.now();
    got.store.create({
      id,
      title,
      description,
      priority,
      status: 'pending',
      parentId: null,
      createdAt: now,
      updatedAt: now,
    });
    return JSON.stringify({
      success: true,
      task: { id, title, priority, status: 'pending' },
      message: `Task spawned: ${title} (${id})`,
    });
  },
});

// ─── SpawnSubtask ───────────────────────────────────────

export const spawnSubtask = defineTool({
  name: 'SpawnSubtask',
  description: `Spawn a subtask under an existing parent task.

Requires parent_task_id. The parent must exist. Use for breaking a
larger task into executable pieces.`,
  parameters: {
    type: 'object',
    properties: {
      parent_task_id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
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
  async execute(input) {
    const got = requireStore();
    if (got.error) return JSON.stringify({ error: got.error });
    const { parent_task_id, title, description = '', priority = 'medium' } = input || {};
    if (!parent_task_id) return JSON.stringify({ error: 'parent_task_id is required' });
    if (!title) return JSON.stringify({ error: 'title is required' });

    const parent = got.store.get(parent_task_id);
    if (!parent) return JSON.stringify({ error: `Parent task not found: ${parent_task_id}` });

    const id = newTaskId();
    const now = Date.now();
    got.store.create({
      id,
      title,
      description: description || `Subtask of: ${parent.title}`,
      priority,
      status: 'pending',
      parentId: parent_task_id,
      createdAt: now,
      updatedAt: now,
    });
    return JSON.stringify({
      success: true,
      task: { id, title, priority, status: 'pending', parentId: parent_task_id },
      message: `Subtask spawned: ${title} (${id}) under ${parent_task_id}`,
    });
  },
});
