/**
 * task-ctx-builder.js — assemble taskCtx shape for VP system prompt §334e.
 *
 * Bridges task stores (334n summary.js) and group stores into the shape
 * consumed by system-prompt.js's renderTaskCtx block. When 334f's
 * task-memory read API lands, this module will call it; for now it
 * duck-types the interface via placeholder adapters.
 *
 * Usage (from run-turn.js):
 *   const taskCtx = await buildTaskCtx({ taskStore, groupsRoot, ... });
 *   const prompt = await buildSystemPrompt(ri, { ..., taskCtx });
 *
 * Shape returned:
 *   {
 *     taskId: string,
 *     currentVpId: string,
 *     initiatorVpId: string,
 *     groupId?: string,
 *     memories: Array<{body, kind?, shard?, authoredBy?}>,   // top-5
 *     relatedTasks: Array<{id, title, status, memories?}>,   // top-3
 *     summaryReminder: { triggered, text? } | null,
 *   }
 */

import { join } from 'node:path';
import { buildTaskCtxMemories, buildSummaryReminder, getRelatedTaskCtx } from '../tasks/summary.js';

const DEFAULT_MEMORY_TOP = 5;
const DEFAULT_RELATED_TOP = 3;

/**
 * Build the complete taskCtx object for prompt injection.
 *
 * @param {{
 *   taskStore: import('../tasks/store.js').TaskStore | null,
 *   taskId: string,
 *   currentVpId: string,
 *   groupId?: string,
 *   groupsRoot?: string,
 *   memoryDir?: string | null,
 *   now?: number,
 *   lastSummaryAt?: number,
 *   nonSummaryTurns?: number,
 * }} opts
 * @returns {object|null}  taskCtx shape or null if no task context
 */
export function buildTaskCtx(opts = {}) {
  const {
    taskStore, taskId, currentVpId, groupId,
    groupsRoot, memoryDir,
    now, lastSummaryAt, nonSummaryTurns,
  } = opts;

  if (!taskId || !currentVpId) return null;

  // ── 1. Task metadata ────────────────────────────────────────
  const task = taskStore?.get?.(taskId);
  const initiatorVpId = task?.initiator || currentVpId;
  const members = task?.members || [currentVpId];

  // ── 2. Task-memory top-5 ────────────────────────────────────
  let memories = [];
  if (memoryDir) {
    try {
      memories = buildTaskCtxMemories(memoryDir, {
        top: DEFAULT_MEMORY_TOP,
        now: now || Date.now(),
      });
    } catch {
      // 334f not wired yet or dir missing — degrade gracefully.
      memories = [];
    }
  }

  // ── 3. Related tasks top-3 ──────────────────────────────────
  const relatedTasks = [];
  if (taskStore && groupsRoot) {
    try {
      const allTasks = taskStore.list?.() || [];
      let count = 0;
      for (const t of allTasks) {
        if (t.id === taskId) continue;
        if (count >= DEFAULT_RELATED_TOP) break;
        const ctx = getRelatedTaskCtx({
          taskStore,
          currentTaskId: taskId,
          otherTaskId: t.id,
          vpId: currentVpId,
          groupsRoot,
        });
        if (ctx) {
          relatedTasks.push(ctx);
          count++;
        }
      }
    } catch {
      // Degrade gracefully.
    }
  }

  // ── 4. Summary reminder ─────────────────────────────────────
  let summaryReminder = null;
  if (members.length > 1) {
    const r = buildSummaryReminder({
      task: { initiator: initiatorVpId, members },
      currentVpId,
      now: now || Date.now(),
      lastSummaryAt: lastSummaryAt || 0,
      nonSummaryTurns: nonSummaryTurns || 0,
    });
    if (r.triggered) {
      summaryReminder = {
        members,
        nonSummaryCount: nonSummaryTurns || 0,
        lastSummaryAt: lastSummaryAt || 0,
        now: now || Date.now(),
      };
    }
  }

  return {
    taskId,
    currentVpId,
    initiatorVpId,
    groupId: groupId || task?.groupId || null,
    memories,
    relatedTasks: relatedTasks.length > 0 ? relatedTasks : undefined,
    summaryReminder: summaryReminder || undefined,
  };
}

/**
 * Resolve the task memory directory for a given task.
 * Placeholder — 334f will provide the canonical path resolver.
 *
 * @param {{ groupsRoot: string, groupId: string, taskId: string }} opts
 * @returns {string|null}
 */
export function resolveTaskMemoryDir({ groupsRoot, groupId, taskId }) {
  if (!groupsRoot || !groupId || !taskId) return null;
  return join(groupsRoot, groupId, 'tasks', taskId, 'memory');
}
