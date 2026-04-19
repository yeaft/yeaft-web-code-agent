/**
 * thread-tools.js — Thread-spawning tools for Unify Engine (Phase 1).
 *
 * Phase 1 scope (task-299 rework):
 *   - SpawnThread         — create a new thread
 *   - SwitchThread        — set the engine's currentThreadId marker
 *   - ListThreads         — list threads + current marker + cached stats
 *   - AttachThreadToTask  — bind a thread to an existing task
 *   - SpawnTask           — create a task or subtask (parent_task_id optional)
 *   - ReadThreadSummary   — cross-reference: summary of a thread (id/name/
 *                           status/messageCount/lastMessageAt/task)
 *   - ReadThreadRecent    — cross-reference: last N messages of a thread
 *
 * Phase 1 uses the in-memory ThreadStore (agent/unify/threads/store.js)
 * and the existing ConversationStore for messages. When task-298 merges,
 * ThreadStore becomes file-backed with the SAME API, so these tools
 * continue to work unchanged.
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';
import { getThreadStore, MAIN_THREAD_ID } from '../threads/store.js';
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
          status: t.status,
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
  description: `List all threads with cached status / messageCount / lastMessageAt.

Returns the data needed by the Phase 2 sidebar (task-300): each entry
exposes id, name, goal, parentThreadId, status ('active'|'idle'|'archived'),
messageCount, lastMessageAt, archived, attachedTaskId. Reads only cached
fields — does not scan messages.`,
  parameters: { type: 'object', properties: {} },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute() {
    const store = getThreadStore();
    const threads = store.list().map(t => ({
      id: t.id,
      name: t.name,
      goal: t.goal,
      parentThreadId: t.parentThreadId,
      status: t.status,
      messageCount: t.messageCount,
      lastMessageAt: t.lastMessageAt,
      lastActivityAt: t.lastActivityAt ?? t.lastMessageAt,
      archived: t.archived,
      unread: t.unread || 0,
      preview: t.preview || '',
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
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input) {
    const { thread_id, task_id } = input || {};
    if (!thread_id) return JSON.stringify({ error: 'thread_id is required' });
    if (!task_id) return JSON.stringify({ error: 'task_id is required' });

    const taskStore = getTaskStore();
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

// ─── SpawnTask (deprecated alias — task-333b) ──────────────
//
// task-333b folded SpawnTask into TaskCreate (see task-tools.js). Kept
// registered for one release as a deprecated alias per PM constraint:
// LLM calls still resolve, but a one-time console.warn nudges migration.
// Prefer TaskCreate with `parent_task_id` for all new call sites.

const _spawnTaskWarned = { v: false };
function warnSpawnTaskDeprecated() {
  if (_spawnTaskWarned.v) return;
  _spawnTaskWarned.v = true;
  // eslint-disable-next-line no-console
  console.warn('[deprecated] SpawnTask → TaskCreate. Pass parent_task_id to TaskCreate for subtasks.');
}

export const spawnTask = defineTool({
  name: 'SpawnTask',
  description: `DEPRECATED — use TaskCreate with parent_id instead. Retained as a thin alias for backwards compatibility; delegates to the same task store. When parent_task_id is omitted this behaves like TaskCreate; when provided it creates a subtask under that parent (parent must exist). Removal target: v0.2.0.`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
      },
      parent_task_id: {
        type: 'string',
        description: 'Optional parent task id; when present, a subtask is created',
      },
    },
    required: ['title'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input) {
    warnSpawnTaskDeprecated();
    const store = getTaskStore();
    if (!store) {
      return JSON.stringify({ error: 'Task store not initialized. Session may still be loading.' });
    }
    const { title, description = '', priority = 'medium', parent_task_id } = input || {};
    if (!title) return JSON.stringify({ error: 'title is required' });

    if (parent_task_id) {
      const parent = store.get(parent_task_id);
      if (!parent) return JSON.stringify({ error: `Parent task not found: ${parent_task_id}` });
    }

    const id = `task-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    store.create({
      id,
      title,
      description,
      priority,
      status: 'pending',
      parentId: parent_task_id || null,
      parentTaskId: parent_task_id || null, // design §5 canonical field; kept in sync with parentId
      createdAt: now,
      updatedAt: now,
    });
    return JSON.stringify({
      success: true,
      task: {
        id,
        title,
        priority,
        status: 'pending',
        parentTaskId: parent_task_id || null,
      },
      message: parent_task_id
        ? `Subtask spawned: ${title} (${id}) under ${parent_task_id}`
        : `Task spawned: ${title} (${id})`,
    });
  },
});

// ─── ReadThreadSummary (cross-reference, design §6 Q5) ──

export const readThreadSummary = defineTool({
  name: 'ReadThreadSummary',
  description: `Return a one-shot summary of a thread: id, name, goal, status,
messageCount, lastMessageAt, parentThreadId, attachedTaskId.

Use this to cross-reference work on another thread without switching.`,
  parameters: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
    },
    required: ['thread_id'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input) {
    const { thread_id } = input || {};
    if (!thread_id) return JSON.stringify({ error: 'thread_id is required' });
    const store = getThreadStore();
    const t = store.get(thread_id);
    if (!t) return JSON.stringify({ error: `Thread not found: ${thread_id}` });
    return JSON.stringify(
      {
        id: t.id,
        name: t.name,
        goal: t.goal,
        status: t.status,
        archived: t.archived,
        messageCount: t.messageCount,
        lastMessageAt: t.lastMessageAt,
        parentThreadId: t.parentThreadId,
        attachedTaskId: store.attachedTask(t.id),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      },
      null,
      2,
    );
  },
});

// ─── ReadThreadRecent (cross-reference, design §6 Q5) ───

export const readThreadRecent = defineTool({
  name: 'ReadThreadRecent',
  description: `Return the last N messages on a specific thread.

Requires an engine ConversationStore in context (ctx.conversationStore).
Reads conversation history and filters by threadId. Default N=20, max 200.
Use this to review another thread's recent activity without switching.`,
  parameters: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      limit: { type: 'number', description: 'Max messages to return (default 20, max 200)' },
    },
    required: ['thread_id'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { thread_id, limit } = input || {};
    if (!thread_id) return JSON.stringify({ error: 'thread_id is required' });
    const store = getThreadStore();
    if (!store.has(thread_id)) {
      return JSON.stringify({ error: `Thread not found: ${thread_id}` });
    }
    const conv = ctx?.conversationStore;
    if (!conv || typeof conv.loadRecent !== 'function') {
      return JSON.stringify({
        error: 'conversation store unavailable in tool context',
      });
    }
    const cap = Math.max(1, Math.min(Number(limit) || 20, 200));
    // Over-fetch then filter by thread, so N still applies post-filter.
    const raw = conv.loadRecent(cap * 4);
    const filtered = raw
      .filter(m => (m.threadId || MAIN_THREAD_ID) === thread_id)
      .slice(-cap)
      .map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        createdAt: m.createdAt || null,
        threadId: m.threadId || MAIN_THREAD_ID,
      }));
    return JSON.stringify(
      { threadId: thread_id, count: filtered.length, messages: filtered },
      null,
      2,
    );
  },
});
