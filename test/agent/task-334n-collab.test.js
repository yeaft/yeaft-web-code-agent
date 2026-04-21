/**
 * task-334n tests — multi-VP collaboration + summary + extractor + ACL.
 *
 * N-a: task_summary_post writes type=summary jsonl record.
 * N-b: summary-extractor emits 2..5 task-memory entries.
 * N-c: supersede chain — rev2 references rev1's msgId via supersedes[].
 * N-d: §Δ31.4 soft reminder — 3-AND trigger only when ALL conditions hold.
 * N-e: related-task ACL fail-closed on cross-group, no members overlap.
 * N-f: task-memory top-5 feeds buildTaskCtxMemories (E).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createGroup, openGroup } from '../../agent/unify/groups/group-store.js';
import {
  postSummary,
  defaultExtractor,
  buildSummaryReminder,
  buildTaskCtxMemories,
  getRelatedTaskCtx,
  EXTRACT_MIN_ENTRIES,
  EXTRACT_MAX_ENTRIES,
  PROGRESS_ANCHORS,
} from '../../agent/unify/tasks/summary.js';
import { TaskStore } from '../../agent/unify/tasks/store.js';
import { buildSystemPrompt } from '../../agent/unify/prompts.js';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'task-334n-'));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

function setupGroupAndTask({
  groupId = 'g-demo',
  taskId = 'task-t1',
  initiator = 'vp-a',
  members = ['vp-a', 'vp-b'],
} = {}) {
  const groupsRoot = join(tmp, 'groups');
  mkdirSync(groupsRoot, { recursive: true });
  const group = createGroup(groupsRoot, {
    id: groupId,
    roster: ['vp-a', 'vp-b'],
    defaultVpId: 'vp-a',
  });
  const tasksRoot = join(tmp, 'tasks-fs');
  mkdirSync(tasksRoot, { recursive: true });
  const taskStore = new TaskStore(tmp);
  taskStore.create({
    id: taskId,
    title: 'demo task',
    status: 'in_progress',
    priority: 'high',
    initiator,
    members: members.slice(),
    groupId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const memoryDir = join(groupsRoot, groupId, 'tasks', taskId, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  return { groupsRoot, group, taskStore, memoryDir, taskId, groupId };
}

// ─── N-a ─────────────────────────────────────────────────────────

describe('task-334n N-a — task_summary_post writes type=summary to jsonl', () => {
  it('appends a summary message with meta.type=summary and returns the stored id', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    const res = postSummary({
      group,
      taskId,
      fromVpId: 'vp-a',
      body: '- decide: use postgres\n- progress: schema drafted',
      progress: 30,
      memoryDir,
    });
    expect(res.message.id).toBeTruthy();
    expect(res.message.taskId).toBe(taskId);
    expect(res.message.meta.type).toBe('summary');
    expect(res.message.meta.progress).toBe(30);

    // Read it back from the log.
    const recs = Array.from(group.streamMessages());
    const summary = recs.find((r) => r.id === res.message.id);
    expect(summary).toBeTruthy();
    expect(summary.meta.type).toBe('summary');
  });
});

// ─── N-b ─────────────────────────────────────────────────────────

describe('task-334n N-b — summary-extractor writes 2..5 task-memory entries', () => {
  it('defaultExtractor emits progress + decision rows', () => {
    const out = defaultExtractor([
      '- decide: use postgres',
      '- chose: k8s for deployment',
      '- progress: schema drafted',
      '- blocker: migration plan TBD',
      '- todo: wire CI',
      '- extra sixth line should be trimmed',
    ].join('\n'));
    expect(out.length).toBeLessThanOrEqual(EXTRACT_MAX_ENTRIES);
    expect(out.length).toBeGreaterThanOrEqual(EXTRACT_MIN_ENTRIES);
    expect(out.some((x) => x.kind === 'decision')).toBe(true);
    expect(out.some((x) => x.kind === 'progress')).toBe(true);
  });

  it('postSummary writes task-memory entries under the task memory dir', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    const res = postSummary({
      group,
      taskId,
      fromVpId: 'vp-a',
      body: '- decide: use postgres\n- progress: schema drafted\n- progress: seeded fixtures',
      memoryDir,
    });
    expect(res.memoryIds.length).toBeGreaterThanOrEqual(EXTRACT_MIN_ENTRIES);
    expect(res.memoryIds.length).toBeLessThanOrEqual(EXTRACT_MAX_ENTRIES);
    // The memory dir should exist with shard files.
    expect(existsSync(memoryDir)).toBe(true);
  });
});

// ─── N-c ─────────────────────────────────────────────────────────

describe('task-334n N-c — supersede chain rev2 → rev1', () => {
  it('rev2.meta.supersedes contains rev1.id', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    const rev1 = postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: step 1 done',
      memoryDir,
    });
    const rev2 = postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: step 1 done\n- progress: step 2 done',
      supersedes: [rev1.message.id],
      memoryDir,
    });
    expect(rev2.supersededSummaryIds).toEqual([rev1.message.id]);
    expect(rev2.message.meta.supersedes).toEqual([rev1.message.id]);
    // Both summaries are still on disk (audit rule).
    const recs = Array.from(group.streamMessages());
    expect(recs.some((r) => r.id === rev1.message.id)).toBe(true);
    expect(recs.some((r) => r.id === rev2.message.id)).toBe(true);
  });
});

// ─── N-d ─────────────────────────────────────────────────────────

describe('task-334n N-d — §Δ31.4 soft reminder 3-AND gate', () => {
  const base = {
    task: { initiator: 'vp-a', members: ['vp-a', 'vp-b'] },
    currentVpId: 'vp-a',
    now: 10_000_000_000,
  };

  it('triggers when initiator + multi-VP + turns≥10', () => {
    const r = buildSummaryReminder({ ...base, lastSummaryAt: 0, nonSummaryTurns: 10 });
    expect(r.triggered).toBe(true);
  });

  it('triggers when initiator + multi-VP + age≥20min', () => {
    const r = buildSummaryReminder({
      ...base, lastSummaryAt: base.now - 25 * 60 * 1000, nonSummaryTurns: 2,
    });
    expect(r.triggered).toBe(true);
  });

  it('suppresses when not initiator', () => {
    const r = buildSummaryReminder({ ...base, currentVpId: 'vp-b', lastSummaryAt: 0, nonSummaryTurns: 20 });
    expect(r.triggered).toBe(false);
    expect(r.reasons).toContain('not-initiator');
  });

  it('suppresses when solo task (members=1)', () => {
    const r = buildSummaryReminder({
      ...base,
      task: { initiator: 'vp-a', members: ['vp-a'] },
      lastSummaryAt: 0, nonSummaryTurns: 20,
    });
    expect(r.triggered).toBe(false);
    expect(r.reasons).toContain('solo-task');
  });

  it('suppresses when too-soon (under both thresholds)', () => {
    const r = buildSummaryReminder({
      ...base, lastSummaryAt: base.now - 5 * 60 * 1000, nonSummaryTurns: 3,
    });
    expect(r.triggered).toBe(false);
    expect(r.reasons).toContain('too-soon');
  });

  it('prompt actually emits the reminder line when members gate is satisfied', () => {
    const now = 10_000_000_000;
    const out = buildSystemPrompt({
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
    expect(out).toMatch(/task_summary_post/);
  });
});

// ─── N-e ─────────────────────────────────────────────────────────

describe('task-334n N-e — related-task ACL fail-closed', () => {
  it('denies cross-group + no members overlap (returns null)', () => {
    const a = setupGroupAndTask({
      groupId: 'g-1', taskId: 'task-x', members: ['vp-a'],
    });
    // Second task in a different group with no member overlap.
    a.taskStore.create({
      id: 'task-y',
      title: 'other',
      status: 'in_progress',
      initiator: 'vp-c',
      members: ['vp-c', 'vp-d'],
      groupId: 'g-2',
    });
    const res = getRelatedTaskCtx({
      taskStore: a.taskStore,
      currentTaskId: 'task-x',
      otherTaskId: 'task-y',
      vpId: 'vp-a',
      groupsRoot: a.groupsRoot,
    });
    expect(res).toBeNull();
  });

  it('grants when members intersection ≥ 1', () => {
    const a = setupGroupAndTask({
      groupId: 'g-1', taskId: 'task-x', members: ['vp-a', 'vp-b'],
    });
    a.taskStore.create({
      id: 'task-y', title: 'other', status: 'in_progress',
      initiator: 'vp-b', members: ['vp-b', 'vp-z'], groupId: 'g-2',
    });
    const res = getRelatedTaskCtx({
      taskStore: a.taskStore,
      currentTaskId: 'task-x',
      otherTaskId: 'task-y',
      vpId: 'vp-a',
      groupsRoot: a.groupsRoot,
    });
    expect(res).not.toBeNull();
    expect(res.id).toBe('task-y');
  });

  it('grants when same groupId (even if no members overlap)', () => {
    const a = setupGroupAndTask({
      groupId: 'g-1', taskId: 'task-x', members: ['vp-a'],
    });
    a.taskStore.create({
      id: 'task-y', title: 'sibling', status: 'in_progress',
      initiator: 'vp-b', members: ['vp-b'], groupId: 'g-1',
    });
    expect(a.taskStore.canAccessRelated('task-x', 'task-y', 'vp-a')).toBe(true);
  });
});

// ─── N-f ─────────────────────────────────────────────────────────

describe('task-334n N-f — task-memory top-5 injects into task_ctx', () => {
  it('buildTaskCtxMemories returns up to 5 entries and prompt renders them', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- decide: use redis\n- progress: cache layer drafted\n- progress: write benchmarks',
      memoryDir,
    });
    const mems = buildTaskCtxMemories(memoryDir, { top: 5 });
    expect(mems.length).toBeGreaterThan(0);
    expect(mems.length).toBeLessThanOrEqual(5);

    const prompt = buildSystemPrompt({
      taskCtx: {
        taskId,
        currentVpId: 'vp-a',
        initiatorVpId: 'vp-a',
        memories: mems,
      },
    });
    expect(prompt).toMatch(/## task_ctx/);
    expect(prompt).toMatch(/\[(progress|decision)\]/);
  });
});

// ─── Bonus — TaskStore mutation events ───────────────────────────

describe('task-334n — TaskStore addMember / removeMember events', () => {
  it('emits task_member_added and task_member_removed', () => {
    const store = new TaskStore(tmp);
    store.create({
      id: 'task-e1', title: 't', status: 'pending', priority: 'low',
      initiator: 'vp-a', members: ['vp-a'], groupId: 'g-1',
    });
    const events = [];
    store.onEvent((e) => events.push(e));

    const r1 = store.addMember('task-e1', 'vp-b');
    expect(r1.added).toBe(true);
    const r1b = store.addMember('task-e1', 'vp-b'); // idempotent
    expect(r1b.added).toBe(false);

    const r2 = store.removeMember('task-e1', 'vp-b');
    expect(r2.removed).toBe(true);

    expect(events.map((e) => e.type)).toEqual([
      'task_member_added',
      'task_member_removed',
    ]);
    expect(events[0].vpId).toBe('vp-b');
    expect(events[0].members).toContain('vp-b');
    expect(events[1].members).not.toContain('vp-b');
  });
});

// ─── F1 — progress semantic anchors ─────────────────────────────

describe('task-334n F1 — progress accepts string semantic anchors', () => {
  it('accepts "shipped" as a progress anchor', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    const res = postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: all done',
      progress: 'shipped',
      memoryDir,
    });
    expect(res.message.meta.progress).toBe('shipped');
  });

  it('rejects unknown string anchors', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    expect(() => postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: something',
      progress: 'yolo',
      memoryDir,
    })).toThrow(/progress string must be one of/);
  });

  it('still accepts numeric progress 0-100', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    const res = postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: halfway',
      progress: 50,
      memoryDir,
    });
    expect(res.message.meta.progress).toBe(50);
  });
});

// ─── F2 — recency decay ─────────────────────────────────────────

describe('task-334n F2 — recency decay in buildTaskCtxMemories', () => {
  it('recent entries score higher than old entries (all else equal)', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    const now = Date.now();
    // Post two summaries with different timestamps via extractor override.
    postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: old work',
      memoryDir,
      now: () => now - 48 * 60 * 60 * 1000, // 48h ago
    });
    postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: new work',
      memoryDir,
      now: () => now, // now
    });
    const mems = buildTaskCtxMemories(memoryDir, { top: 5, now });
    expect(mems.length).toBeGreaterThanOrEqual(2);
    // The first result should be "new work" (higher recency score).
    expect(mems[0].body).toMatch(/new work/);
  });
});

// ─── F3 — addedBy field ─────────────────────────────────────────

describe('task-334n F3 — addMember addedBy provenance', () => {
  it('emits addedBy in the task_member_added event', () => {
    const store = new TaskStore(tmp);
    store.create({
      id: 'task-f3', title: 't', status: 'pending', priority: 'low',
      initiator: 'vp-a', members: ['vp-a'], groupId: 'g-1',
    });
    const events = [];
    store.onEvent((e) => events.push(e));
    store.addMember('task-f3', 'vp-c', { addedBy: 'vp-a' });
    expect(events[0].addedBy).toBe('vp-a');
  });

  it('addedBy defaults to null when not provided', () => {
    const store = new TaskStore(tmp);
    store.create({
      id: 'task-f3b', title: 't', status: 'pending', priority: 'low',
      initiator: 'vp-a', members: ['vp-a'], groupId: 'g-1',
    });
    const events = [];
    store.onEvent((e) => events.push(e));
    store.addMember('task-f3b', 'vp-d');
    expect(events[0].addedBy).toBeNull();
  });
});

// ─── F4 — authoredBy in buildTaskCtxMemories ─────────────────────

describe('task-334n F4 — authoredBy exposed in task_ctx memories', () => {
  it('buildTaskCtxMemories includes authoredBy when present', () => {
    const { group, memoryDir, taskId } = setupGroupAndTask();
    postSummary({
      group, taskId, fromVpId: 'vp-a',
      body: '- progress: wired up\n- progress: tested',
      memoryDir,
    });
    const mems = buildTaskCtxMemories(memoryDir, { top: 5 });
    expect(mems.length).toBeGreaterThan(0);
    // postSummary writes authoredBy: AUTHORED_BY.SUMMARY
    expect(mems.some((m) => m.authoredBy)).toBe(true);
  });
});

// ─── F5 — extractor extreme fallback ─────────────────────────────

describe('task-334n F5 — defaultExtractor extreme fallback', () => {
  it('pads to EXTRACT_MIN_ENTRIES when body yields only 1 line', () => {
    const out = defaultExtractor('single line body');
    expect(out.length).toBeGreaterThanOrEqual(EXTRACT_MIN_ENTRIES);
  });

  it('returns [] for empty string', () => {
    expect(defaultExtractor('')).toEqual([]);
  });

  it('returns [] for whitespace-only', () => {
    expect(defaultExtractor('   \n   ')).toEqual([]);
  });
});
