/**
 * thread-tools.js — Thread-spawning tools for Unify Engine (Phase 1).
 *
 * Phase 1 scope (task-299 rework):
 *   - SpawnThread             — create a new thread
 *   - SwitchThread            — set the engine's currentThreadId marker
 *   - ListThreads             — list threads + current marker + cached stats
 *   - AttachThreadToFeature   — bind a thread to an existing feature
 *   - ReadThreadSummary       — cross-reference: summary of a thread (id/name/
 *                               status/messageCount/lastMessageAt/feature)
 *   - ReadThreadRecent        — cross-reference: last N messages of a thread
 *
 * Phase 1 uses the in-memory ThreadStore (agent/unify/threads/store.js)
 * and the existing ConversationStore for messages. When task-298 merges,
 * ThreadStore becomes file-backed with the SAME API, so these tools
 * continue to work unchanged.
 */

import { defineTool } from './types.js';
import { getThreadStore, MAIN_THREAD_ID } from '../threads/store.js';
import { getFeatureStore } from './feature-tools.js';

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
      attachedFeatureId: store.attachedFeature(t.id),
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

// ─── AttachThreadToFeature ──────────────────────────────────

export const attachThreadToFeature = defineTool({
  name: 'AttachThreadToFeature',
  description: `Link an existing thread to an existing feature.

Use to record which thread is responsible for which feature. The thread and
the feature must both already exist. Overwrites any previous attachment for
the same thread.`,
  parameters: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      feature_id: { type: 'string' },
    },
    required: ['thread_id', 'feature_id'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input) {
    const { thread_id, feature_id } = input || {};
    if (!thread_id) return JSON.stringify({ error: 'thread_id is required' });
    if (!feature_id) return JSON.stringify({ error: 'feature_id is required' });

    const featureStore = getFeatureStore();
    if (featureStore) {
      const feature = featureStore.get(feature_id);
      if (!feature) return JSON.stringify({ error: `Feature not found: ${feature_id}` });
    }

    try {
      const store = getThreadStore();
      store.attachFeature(thread_id, feature_id);
      return JSON.stringify({
        success: true,
        threadId: thread_id,
        featureId: feature_id,
        message: `Thread ${thread_id} attached to feature ${feature_id}`,
      });
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  },
});

// ─── SpawnTask removed (task-333b) — use FeatureCreate with parent_feature_id

// ─── ReadThreadSummary (cross-reference, design §6 Q5) ──

export const readThreadSummary = defineTool({
  name: 'ReadThreadSummary',
  description: `Return a one-shot summary of a thread: id, name, goal, status,
messageCount, lastMessageAt, parentThreadId, attachedFeatureId.

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
        attachedFeatureId: store.attachedFeature(t.id),
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
