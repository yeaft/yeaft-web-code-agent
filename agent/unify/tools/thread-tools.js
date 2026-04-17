/**
 * thread-tools.js — Thread-spawning tools for Unify Engine (Phase 1).
 *
 * Phase 1 scope (task-299):
 *   - SpawnThread        — create a new thread
 *   - SwitchThread       — set the engine's currentThreadId marker
 *   - ListThreads        — list threads + current marker
 *   - AttachThreadToTask — bind a thread to an existing task
 *
 * Phase 1 uses the in-memory ThreadStore (agent/unify/threads/store.js)
 * so these tools can ship and be tested before task-298's file-backed
 * data layer merges. The tool surface is designed to remain stable when
 * the store is replaced.
 */

import { defineTool } from './types.js';
import { getThreadStore } from '../threads/store.js';
import { getTaskStore } from './task-tools.js';

// ─── SpawnThread ─────────────────────────────────────────

export const spawnThread = defineTool({
  name: 'SpawnThread',
  description: `Create a new thread (conversation track) for parallel work.

A thread is a named conversation track that groups related messages and
tool calls under a single goal. Use when the work needs a fresh focus
track separate from the current conversation.

Returns the new threadId (format: "thr-xxxxxxxx"). Does NOT switch the
engine to the new thread — call SwitchThread to activate it.`,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short human-readable name' },
      goal: { type: 'string', description: 'Optional one-sentence goal' },
      parent_thread_id: {
        type: 'string',
        description: 'Optional parent threadId for hierarchy',
      },
    },
    required: ['name'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input) {
    const { name, goal, parent_thread_id } = input || {};
    if (!name) return JSON.stringify({ error: 'name is required' });
    try {
      const store = getThreadStore();
      const t = store.create({ name, goal, parentThreadId: parent_thread_id || null });
      return JSON.stringify({
        success: true,
        thread: {
          id: t.id,
          name: t.name,
          goal: t.goal,
          parentThreadId: t.parentThreadId,
        },
        message: `Thread created: ${t.name} (${t.id})`,
      });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  },
});

// ─── SwitchThread ────────────────────────────────────────

export const switchThread = defineTool({
  name: 'SwitchThread',
  description: `Switch the engine's active thread marker.

All messages and tool calls persisted after this call will carry the new
threadId (Phase 1: marker only — the Engine reads it when persisting and
the web-bridge forwards it to the UI). Use 'main' to return to the root
thread.`,
  parameters: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: 'Thread id to switch to' },
    },
    required: ['thread_id'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input) {
    const { thread_id } = input || {};
    if (!thread_id) return JSON.stringify({ error: 'thread_id is required' });
    try {
      const store = getThreadStore();
      store.switch(thread_id);
      return JSON.stringify({
        success: true,
        currentThreadId: store.currentId,
        message: `Switched to thread ${thread_id}`,
      });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  },
});

// ─── ListThreads ─────────────────────────────────────────

export const listThreads = defineTool({
  name: 'ListThreads',
  description: `List all threads and the engine's current thread marker.`,
  parameters: { type: 'object', properties: {} },
  modes: ['work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute() {
    const store = getThreadStore();
    const threads = store.list().map(t => ({
      id: t.id,
      name: t.name,
      goal: t.goal,
      parentThreadId: t.parentThreadId,
      attachedTaskId: store.attachedTask(t.id),
    }));
    return JSON.stringify(
      {
        currentThreadId: store.currentId,
        threads,
        totalCount: threads.length,
      },
      null,
      2,
    );
  },
});

// ─── AttachThreadToTask ──────────────────────────────────

export const attachThreadToTask = defineTool({
  name: 'AttachThreadToTask',
  description: `Link an existing thread to an existing task.

Use to record which thread is responsible for which task. The thread and
the task must both already exist. Overwrites any previous attachment for
the same thread.`,
  parameters: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      task_id: { type: 'string' },
    },
    required: ['thread_id', 'task_id'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input) {
    const { thread_id, task_id } = input || {};
    if (!thread_id) return JSON.stringify({ error: 'thread_id is required' });
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const taskStore = getTaskStore();
    // If the task store is initialized, validate the task exists; if not
    // initialized (e.g. Phase 1 unit tests running before session bootstrap),
    // skip the task existence check — we still enforce thread existence.
    if (taskStore) {
      const task = taskStore.get(task_id);
      if (!task) return JSON.stringify({ error: `Task not found: ${task_id}` });
    }

    try {
      const store = getThreadStore();
      store.attachTask(thread_id, task_id);
      return JSON.stringify({
        success: true,
        threadId: thread_id,
        taskId: task_id,
        message: `Thread ${thread_id} attached to task ${task_id}`,
      });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  },
});
