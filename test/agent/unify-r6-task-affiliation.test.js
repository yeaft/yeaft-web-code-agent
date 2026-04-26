/**
 * task-334-r6-closing-gap-G1b — task affiliation hint + TaskCreate roster validation.
 *
 * Covers:
 *   A. buildSystemPrompt(ri, { taskCtx }) emits a `## task_ctx` block when
 *      active tasks are present; emits an affiliation_hint when NOT inside
 *      a task; flips to "stay focused" hint when inside one.
 *   B. The active_tasks_in_group section is suppressed when the list is
 *      empty (and the whole block when there's nothing to say).
 *   C. Cap of 8 tasks rendered (the rest are pruned to keep the prompt
 *      from ballooning if a group has dozens of open tasks).
 *   D. R6 TaskCreate gates on `group_id`:
 *        - members ⊆ roster (else not_in_roster, never auto-invites)
 *        - caller is auto-included in members
 *        - missing roster ⇒ group_not_found
 *        - legacy single-tenant call (no group_id) still works
 *   E. The affiliation hint is the load-bearing mechanism for R6 §6 trigger
 *      #6 (tasks "auto-emerge" from chat). Without a non-empty hint string,
 *      the LLM has no nudge to call TaskCreate.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSystemPrompt,
} from '../../agent/unify/vp/system-prompt.js';
import { RoleInstance } from '../../agent/unify/vp/role-instance.js';
import { taskCreate, initTaskStore, getTaskStore } from '../../agent/unify/tools/task-tools.js';

function makeVp(overrides = {}) {
  return {
    id: 'alice',
    name: 'Alice',
    role: 'PM',
    traits: [],
    persona: 'I am Alice.',
    personaHash: 'a1',
    mtimeMs: 1,
    ...overrides,
  };
}

function makeRi() {
  return new RoleInstance({
    vp: makeVp(),
    groupId: 'grp_x',
  });
}

describe('R6 G1b — task_ctx block in system prompt', () => {
  it('renders ## task_ctx with active tasks when provided', async () => {
    const ri = makeRi();
    const out = await buildSystemPrompt(ri, {
      taskCtx: {
        activeTasks: [
          { id: 'task-1', title: 'Login flow', status: 'in_progress', members: ['alice', 'bob'] },
          { id: 'task-2', title: 'Schema review', status: 'pending', members: ['alice'] },
        ],
      },
    });
    expect(out).toMatch(/## task_ctx/);
    expect(out).toMatch(/active_tasks_in_group \(2\)/);
    expect(out).toMatch(/task-1.*Login flow.*in_progress/);
    expect(out).toMatch(/members=\[alice,bob\]/);
  });

  it('emits affiliation_hint guiding TaskCreate / task_message / group reply', async () => {
    const ri = makeRi();
    const out = await buildSystemPrompt(ri, {
      taskCtx: {
        activeTasks: [{ id: 'task-1', title: 'A', members: ['alice'] }],
      },
    });
    expect(out).toMatch(/### affiliation_hint/);
    // Three explicit branches the LLM must choose between:
    expect(out).toMatch(/task_message/);
    expect(out).toMatch(/TaskCreate/);
    expect(out).toMatch(/reply at group level/);
    expect(out).toMatch(/Do NOT create a task for trivial/);
  });

  it('switches to "stay focused" hint when already inside a task', async () => {
    const ri = makeRi();
    const out = await buildSystemPrompt(ri, {
      runtimeCtx: { taskId: 'task-1' },
      taskCtx: {
        currentTask: { id: 'task-1', title: 'Login flow', members: ['alice', 'bob'] },
        activeTasks: [{ id: 'task-2', title: 'Other', members: ['carol'] }],
      },
    });
    expect(out).toMatch(/### current_task/);
    expect(out).toMatch(/Stay focused on its scope/);
    expect(out).toMatch(/task_summary_post/);
    // The "decide BEFORE replying" hint should NOT appear inside a task —
    // the LLM has already picked, no decision left.
    expect(out).not.toMatch(/Decide BEFORE replying/);
  });

  it('omits the whole block when taskCtx is null/undefined (legacy path)', async () => {
    const ri = makeRi();
    const out = await buildSystemPrompt(ri, {});
    expect(out).not.toMatch(/## task_ctx/);
    expect(out).not.toMatch(/affiliation_hint/);
  });

  it('omits the block when activeTasks is empty and no currentTask', async () => {
    const ri = makeRi();
    const out = await buildSystemPrompt(ri, { taskCtx: { activeTasks: [] } });
    expect(out).not.toMatch(/## task_ctx/);
  });

  it('caps active_tasks_in_group rendering at 8 (prevents prompt bloat)', async () => {
    const ri = makeRi();
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `task-${i}`,
      title: `T${i}`,
      members: ['alice'],
    }));
    const out = await buildSystemPrompt(ri, { taskCtx: { activeTasks: many } });
    expect(out).toMatch(/active_tasks_in_group \(8\)/);
    // task-9 should be in (within cap), task-9... task-19 mostly out.
    expect(out).toMatch(/- task-0\b/);
    expect(out).not.toMatch(/- task-15\b/);
  });

  it('renders related_tasks block (cross-group flagged with grp prefix)', async () => {
    const ri = makeRi();
    const out = await buildSystemPrompt(ri, {
      taskCtx: {
        activeTasks: [],
        currentTask: { id: 'task-cur', members: ['alice'] },
        relatedTasks: [
          { id: 'task-r1', title: 'Related A', groupId: 'grp_x' },
          { id: 'task-r2', title: 'Related B', groupId: 'grp_other' },
        ],
      },
    });
    expect(out).toMatch(/### related_tasks \(2\)/);
    expect(out).toMatch(/task-r2.*\(grp:grp_other\)/);
    // Same-group related tasks omit the grp: tag.
    expect(out).not.toMatch(/task-r1.*\(grp:grp_x\)/);
  });
});

describe('R6 G1b — TaskCreate roster validation', () => {
  let tmpDir;
  let roster = ['alice', 'bob', 'carol'];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'r6-task-'));
    initTaskStore(tmpDir);
  });

  function makeCtx(overrides = {}) {
    return {
      currentVpId: 'alice',
      getGroupRoster: (gid) => (gid === 'grp_x' ? roster.slice() : null),
      ...overrides,
    };
  }

  it('legacy call without group_id still works (no R6 fields populated)', async () => {
    const out = JSON.parse(await taskCreate.execute({ title: 'legacy task' }));
    expect(out.success).toBe(true);
    expect(out.task.groupId).toBeUndefined();
    expect(out.task.members).toBeUndefined();
  });

  it('with group_id: caller becomes initiator and is auto-included in members', async () => {
    const out = JSON.parse(await taskCreate.execute(
      { title: 'multi-vp', group_id: 'grp_x', members: ['bob'] },
      makeCtx(),
    ));
    expect(out.success).toBe(true);
    expect(out.task.groupId).toBe('grp_x');
    expect(out.task.initiator).toBe('alice');
    // alice prepended even though caller only listed bob.
    expect(out.task.members).toContain('alice');
    expect(out.task.members).toContain('bob');
  });

  it('rejects with not_in_roster when a member is off-roster (no auto-invite)', async () => {
    const out = JSON.parse(await taskCreate.execute(
      { title: 'cross-group', group_id: 'grp_x', members: ['stranger'] },
      makeCtx(),
    ));
    expect(out.error).toBe('not_in_roster');
    expect(out.offRoster).toEqual(['stranger']);
    // Hint must explicitly tell the LLM not to auto-invite.
    expect(out.hint).toMatch(/Ask the user to invite/);
    expect(out.hint).toMatch(/do not auto-invite/);
  });

  it('rejects with group_not_found when roster lookup returns null', async () => {
    const out = JSON.parse(await taskCreate.execute(
      { title: 't', group_id: 'grp_unknown', members: ['alice'] },
      makeCtx({ getGroupRoster: () => null }),
    ));
    expect(out.error).toBe('group_not_found');
  });

  it('defaults members to [caller] when omitted and group_id present', async () => {
    const out = JSON.parse(await taskCreate.execute(
      { title: 'solo', group_id: 'grp_x' },
      makeCtx(),
    ));
    expect(out.success).toBe(true);
    expect(out.task.members).toEqual(['alice']);
    expect(out.task.initiator).toBe('alice');
  });

  it('persists relatedTaskIds on the task record', async () => {
    const out = JSON.parse(await taskCreate.execute(
      {
        title: 'with-rel',
        group_id: 'grp_x',
        members: ['alice'],
        related_task_ids: ['task-r1', 'task-r2'],
      },
      makeCtx(),
    ));
    expect(out.success).toBe(true);
    const persisted = getTaskStore().get(out.task.id);
    expect(persisted.relatedTaskIds).toEqual(['task-r1', 'task-r2']);
  });

  it('returns no_members error when no caller and empty members', async () => {
    const out = JSON.parse(await taskCreate.execute(
      { title: 't', group_id: 'grp_x', members: [] },
      makeCtx({ currentVpId: null }),
    ));
    expect(out.error).toBe('no_members');
  });

  // Cleanup
  it('teardown', () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
