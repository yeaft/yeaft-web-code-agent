/**
 * task-334e — system prompt dynamic segment extension tests.
 *
 * E-a: buildTaskCtx returns null when taskId missing.
 * E-b: buildTaskCtx assembles memories + relatedTasks + summaryReminder.
 * E-c: renderTaskCtxBlock in system-prompt.js renders task_ctx header.
 * E-d: renderTaskCtxBlock renders task_memories section.
 * E-e: renderTaskCtxBlock renders related_tasks section.
 * E-f: renderTaskCtxBlock renders summary reminder line.
 * E-g: resolveTaskMemoryDir returns correct path.
 * E-h: buildSystemPrompt includes task_ctx when taskCtx passed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildTaskCtx, resolveTaskMemoryDir } from '../../agent/unify/vp/task-ctx-builder.js';
import { buildSystemPrompt } from '../../agent/unify/vp/system-prompt.js';
import { createGroup } from '../../agent/unify/groups/group-store.js';
import { TaskStore } from '../../agent/unify/tasks/store.js';
import { postSummary } from '../../agent/unify/tasks/summary.js';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'task-334e-'));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

function setupTask({
  groupId = 'g-demo',
  taskId = 'task-t1',
  members = ['vp-a', 'vp-b'],
} = {}) {
  const groupsRoot = join(tmp, 'groups');
  mkdirSync(groupsRoot, { recursive: true });
  const group = createGroup(groupsRoot, {
    id: groupId,
    roster: members,
    defaultVpId: members[0],
  });
  const taskStore = new TaskStore(tmp);
  taskStore.create({
    id: taskId,
    title: 'demo task',
    status: 'in_progress',
    priority: 'high',
    initiator: members[0],
    members: members.slice(),
    groupId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const memoryDir = join(groupsRoot, groupId, 'tasks', taskId, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  return { groupsRoot, group, taskStore, memoryDir, taskId, groupId };
}

function fakeRi(vpId = 'vp-a', groupId = 'g-demo') {
  return {
    vpId,
    groupId,
    vp: {
      id: vpId,
      name: vpId,
      persona: 'Test persona.',
      personaHash: 'abc123',
      mtimeMs: 1,
    },
    systemPrompt: null,
    _promptBuiltForMtime: null,
    memoryStore: null,
  };
}

// ─── E-a ─────────────────────────────────────────────────────

describe('task-334e E-a — buildTaskCtx returns null on missing input', () => {
  it('returns null when taskId is missing', () => {
    expect(buildTaskCtx({ currentVpId: 'vp-a' })).toBeNull();
  });

  it('returns null when currentVpId is missing', () => {
    expect(buildTaskCtx({ taskId: 'task-1' })).toBeNull();
  });
});

// ─── E-b ─────────────────────────────────────────────────────

describe('task-334e E-b — buildTaskCtx assembles full shape', () => {
  it('returns memories from postSummary-written task memory', () => {
    const { group, taskStore, memoryDir, taskId, groupsRoot, groupId } = setupTask();
    postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- decide: use postgres\n- progress: schema drafted',
      memoryDir,
    });
    const ctx = buildTaskCtx({
      taskStore, taskId, currentVpId: 'vp-a',
      groupId, groupsRoot, memoryDir,
    });
    expect(ctx).not.toBeNull();
    expect(ctx.taskId).toBe(taskId);
    expect(ctx.memories.length).toBeGreaterThan(0);
  });

  it('includes summaryReminder when conditions met', () => {
    const { taskStore, taskId, groupsRoot, groupId } = setupTask();
    const ctx = buildTaskCtx({
      taskStore, taskId, currentVpId: 'vp-a',
      groupId, groupsRoot,
      now: 10_000_000_000,
      lastSummaryAt: 0,
      nonSummaryTurns: 15,
    });
    expect(ctx.summaryReminder).toBeTruthy();
    expect(ctx.summaryReminder.nonSummaryCount).toBe(15);
  });

  it('omits summaryReminder for solo tasks', () => {
    const { taskStore, taskId, groupsRoot, groupId } = setupTask({
      members: ['vp-a'],
    });
    const ctx = buildTaskCtx({
      taskStore, taskId, currentVpId: 'vp-a',
      groupId, groupsRoot,
      now: 10_000_000_000,
      lastSummaryAt: 0,
      nonSummaryTurns: 15,
    });
    expect(ctx.summaryReminder).toBeUndefined();
  });
});

// ─── E-c/d/e/f ──────────────────────────────────────────────

describe('task-334e E-c..f — buildSystemPrompt renders task_ctx', () => {
  it('renders task_ctx header with memories', async () => {
    const ri = fakeRi();
    const prompt = await buildSystemPrompt(ri, {
      taskCtx: {
        taskId: 'task-t1',
        currentVpId: 'vp-a',
        initiatorVpId: 'vp-a',
        memories: [
          { kind: 'decision', body: 'use postgres' },
          { kind: 'progress', body: 'schema drafted' },
        ],
      },
    });
    expect(prompt).toMatch(/## task_ctx/);
    expect(prompt).toMatch(/task_memories/);
    expect(prompt).toMatch(/\[decision\] use postgres/);
    expect(prompt).toMatch(/\[progress\] schema drafted/);
  });

  it('renders related_tasks section', async () => {
    const ri = fakeRi();
    const prompt = await buildSystemPrompt(ri, {
      taskCtx: {
        taskId: 'task-t1',
        currentVpId: 'vp-a',
        relatedTasks: [
          { id: 'task-t2', title: 'sibling task', status: 'in_progress' },
        ],
      },
    });
    expect(prompt).toMatch(/related_tasks/);
    expect(prompt).toMatch(/task-t2: sibling task \[in_progress\]/);
  });

  it('renders summary reminder', async () => {
    const ri = fakeRi();
    const now = 10_000_000_000;
    const prompt = await buildSystemPrompt(ri, {
      taskCtx: {
        taskId: 'task-t1',
        currentVpId: 'vp-a',
        initiatorVpId: 'vp-a',
        summaryReminder: {
          members: ['vp-a', 'vp-b'],
          nonSummaryCount: 12,
          lastSummaryAt: now - 30 * 60 * 1000,
          now,
        },
      },
    });
    expect(prompt).toMatch(/task_summary_post/);
  });

  it('skips task_ctx when not provided', async () => {
    const ri = fakeRi();
    const prompt = await buildSystemPrompt(ri, {});
    expect(prompt).not.toMatch(/## task_ctx/);
  });
});

// ─── E-g ─────────────────────────────────────────────────────

describe('task-334e E-g — resolveTaskMemoryDir', () => {
  it('returns correct path', () => {
    const dir = resolveTaskMemoryDir({
      groupsRoot: '/root/groups',
      groupId: 'g-1',
      taskId: 'task-x',
    });
    expect(dir).toBe('/root/groups/g-1/tasks/task-x/memory');
  });

  it('returns null when inputs missing', () => {
    expect(resolveTaskMemoryDir({})).toBeNull();
    expect(resolveTaskMemoryDir({ groupsRoot: '/x' })).toBeNull();
  });
});
