/**
 * unify-thread-tools.test.js — task-299 (rework)
 *
 * Covers:
 *   - ThreadStore cached fields (messageCount / lastMessageAt / archived / status)
 *     + noteMessage increment + rebuildFromMessages idempotency
 *   - SpawnThread / SwitchThread / ListThreads (new fields)
 *   - AttachThreadToTask
 *   - SpawnTask with parent_task_id (subtask merged in)
 *   - ReadThreadSummary / ReadThreadRecent
 *   - Engine.currentThreadId getter defaults to 'main'
 *   - createFullRegistry wiring (7 tools, no SpawnSubtask)
 *   - TaskStore Q3 migration parentId→parentTaskId (idempotent, tree() repair)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, writeFileSync as syncWrite, mkdirSync as syncMkdir, existsSync as syncExists } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ThreadStore,
  MAIN_THREAD_ID,
  getThreadStore,
  initThreadStore,
  _resetThreadStoreForTests,
} from '../../agent/unify/threads/store.js';
import {
  spawnThread,
  switchThread,
  listThreads,
  attachThreadToTask,
  spawnTask,
  readThreadSummary,
  readThreadRecent,
} from '../../agent/unify/tools/thread-tools.js';
import { initTaskStore } from '../../agent/unify/tools/task-tools.js';
import { TaskStore } from '../../agent/unify/tasks/store.js';

function parse(r) { return JSON.parse(r); }

describe('ThreadStore — basics', () => {
  it('seeds a default "main" thread with default cached fields', () => {
    const s = new ThreadStore();
    const main = s.get(MAIN_THREAD_ID);
    expect(main.status).toBe('active');
    expect(main.messageCount).toBe(0);
    expect(main.lastMessageAt).toBeNull();
    expect(main.archived).toBe(false);
  });

  it('create() returns a thread with status=active, messageCount=0', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'x' });
    expect(t.status).toBe('active');
    expect(t.messageCount).toBe(0);
    expect(t.lastMessageAt).toBeNull();
  });

  it('create() rejects empty name / unknown parent', () => {
    const s = new ThreadStore();
    expect(() => s.create({ name: '' })).toThrow(/name is required/);
    expect(() => s.create({ name: 'a', parentThreadId: 'thr-miss' })).toThrow(/parent thread not found/);
  });

  it('switch() updates currentId / errors on unknown', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'a' });
    s.switch(t.id);
    expect(s.currentId).toBe(t.id);
    expect(() => s.switch('thr-missing')).toThrow(/thread not found/);
  });
});

describe('ThreadStore — cached fields (prev-2)', () => {
  it('noteMessage increments count and bumps lastMessageAt', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'c' });
    expect(t.messageCount).toBe(0);
    s.noteMessage(t.id, 1000);
    s.noteMessage(t.id, 2000);
    const cur = s.get(t.id);
    expect(cur.messageCount).toBe(2);
    expect(cur.lastMessageAt).toBe(2000);
  });

  it('noteMessage on unknown thread is a silent no-op (never throws)', () => {
    const s = new ThreadStore();
    expect(() => s.noteMessage('thr-missing', 1)).not.toThrow();
  });

  it('noteMessage un-archives an archived thread', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'a' });
    s.archive(t.id);
    expect(s.get(t.id).status).toBe('archived');
    s.noteMessage(t.id, 42);
    expect(s.get(t.id).status).toBe('active');
    expect(s.get(t.id).archived).toBe(false);
  });

  it('archive() marks non-main archived + mirror flag; main rejected', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'z' });
    s.archive(t.id);
    expect(s.get(t.id).status).toBe('archived');
    expect(s.get(t.id).archived).toBe(true);
    expect(() => s.archive(MAIN_THREAD_ID)).toThrow(/cannot archive main/);
  });

  it('setStatus accepts active/idle/archived and rejects invalid', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'a' });
    s.setStatus(t.id, 'idle');
    expect(s.get(t.id).status).toBe('idle');
    expect(() => s.setStatus(t.id, 'bogus')).toThrow(/invalid status/);
  });

  it('rebuildFromMessages resets counters; idempotent across runs', () => {
    const s = new ThreadStore();
    const a = s.create({ name: 'a' });
    // Seed via noteMessage then rebuild from a different truth
    s.noteMessage(a.id, 100);
    s.noteMessage(a.id, 200);
    expect(s.get(a.id).messageCount).toBe(2);

    const msgs = [
      { threadId: a.id, createdAt: 10 },
      { threadId: a.id, createdAt: 20 },
      { threadId: a.id, createdAt: 30 },
      { threadId: MAIN_THREAD_ID, createdAt: 15 },
    ];
    s.rebuildFromMessages(msgs);
    expect(s.get(a.id).messageCount).toBe(3);
    expect(s.get(a.id).lastMessageAt).toBe(30);
    expect(s.get(MAIN_THREAD_ID).messageCount).toBe(1);
    // Second run from same input produces same state — idempotent.
    s.rebuildFromMessages(msgs);
    expect(s.get(a.id).messageCount).toBe(3);
    expect(s.get(a.id).lastMessageAt).toBe(30);
    expect(s.get(MAIN_THREAD_ID).messageCount).toBe(1);
  });
});

describe('thread-tools', () => {
  beforeEach(() => {
    _resetThreadStoreForTests();
    initThreadStore({ force: true });
  });

  it('SpawnThread success + missing name + bad parent', async () => {
    const ok = parse(await spawnThread.execute({ name: 'test' }));
    expect(ok.success).toBe(true);
    expect(ok.thread.id).toMatch(/^thr-/);
    expect(ok.thread.status).toBe('active');

    const err = parse(await spawnThread.execute({}));
    expect(err.error).toMatch(/name is required/);

    const bad = parse(await spawnThread.execute({ name: 'x', parent_thread_id: 'thr-nope' }));
    expect(bad.error).toMatch(/parent thread not found/);
  });

  it('SwitchThread success + unknown + missing id', async () => {
    const s = parse(await spawnThread.execute({ name: 'a' }));
    const ok = parse(await switchThread.execute({ thread_id: s.thread.id }));
    expect(ok.currentThreadId).toBe(s.thread.id);
    expect(parse(await switchThread.execute({ thread_id: 'thr-nope' })).error).toMatch(/thread not found/);
    expect(parse(await switchThread.execute({})).error).toMatch(/thread_id is required/);
  });

  it('ListThreads exposes cached fields needed by sidebar (task-300)', async () => {
    const spawned = parse(await spawnThread.execute({ name: 'alpha' }));
    // bump counters via store directly
    getThreadStore().noteMessage(spawned.thread.id, 5555);
    const listed = parse(await listThreads.execute({}));
    expect(listed.currentThreadId).toBe(MAIN_THREAD_ID);
    expect(listed.totalCount).toBe(2);
    const alpha = listed.threads.find(t => t.id === spawned.thread.id);
    for (const key of ['id', 'name', 'status', 'messageCount', 'lastMessageAt', 'archived', 'attachedTaskId']) {
      expect(alpha).toHaveProperty(key);
    }
    expect(alpha.status).toBe('active');
    expect(alpha.messageCount).toBe(1);
    expect(alpha.lastMessageAt).toBe(5555);
    expect(alpha.archived).toBe(false);
  });

  it('AttachThreadToTask: error paths', async () => {
    expect(parse(await attachThreadToTask.execute({ task_id: 'task-1' })).error).toMatch(/thread_id is required/);
    expect(parse(await attachThreadToTask.execute({ thread_id: MAIN_THREAD_ID })).error).toMatch(/task_id is required/);
  });
});

describe('SpawnTask (merged — subtask via parent_task_id)', () => {
  let tmp;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'yeaft-sp-'));
    initTaskStore(tmp, { readOnly: false });
    _resetThreadStoreForTests();
    initThreadStore({ force: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates a top-level task when parent_task_id omitted', async () => {
    const r = parse(await spawnTask.execute({ title: 'top' }));
    expect(r.success).toBe(true);
    expect(r.task.parentTaskId).toBeNull();
    expect(r.task.id).toMatch(/^task-[0-9a-f]{8}$/);
  });

  it('creates a subtask when parent_task_id provided (parent must exist)', async () => {
    const bad = parse(await spawnTask.execute({ title: 'x', parent_task_id: 'task-missing' }));
    expect(bad.error).toMatch(/Parent task not found/);

    const parent = parse(await spawnTask.execute({ title: 'parent' }));
    const child = parse(await spawnTask.execute({
      title: 'child',
      parent_task_id: parent.task.id,
    }));
    expect(child.success).toBe(true);
    expect(child.task.parentTaskId).toBe(parent.task.id);
  });

  it('missing title rejected; missing store rejected (before init)', async () => {
    const err = parse(await spawnTask.execute({}));
    expect(err.error).toMatch(/title is required/);
  });
});

describe('Cross-reference tools (design §6 Q5)', () => {
  beforeEach(() => {
    _resetThreadStoreForTests();
    initThreadStore({ force: true });
  });

  it('ReadThreadSummary returns full record; errors on unknown', async () => {
    const s = parse(await spawnThread.execute({ name: 'xref' }));
    getThreadStore().noteMessage(s.thread.id, 777);
    const sum = parse(await readThreadSummary.execute({ thread_id: s.thread.id }));
    expect(sum.id).toBe(s.thread.id);
    expect(sum.name).toBe('xref');
    expect(sum.messageCount).toBe(1);
    expect(sum.lastMessageAt).toBe(777);
    expect(sum.status).toBe('active');

    expect(parse(await readThreadSummary.execute({ thread_id: 'thr-nope' })).error).toMatch(/Thread not found/);
    expect(parse(await readThreadSummary.execute({})).error).toMatch(/thread_id is required/);
  });

  it('ReadThreadRecent filters by thread, honours limit, errors w/o conv store', async () => {
    const s = parse(await spawnThread.execute({ name: 'r' }));
    // no conv store in ctx
    const noCtx = parse(await readThreadRecent.execute({ thread_id: s.thread.id }));
    expect(noCtx.error).toMatch(/conversation store unavailable/);

    const fakeMessages = [
      { role: 'user', content: 'hi-main', threadId: MAIN_THREAD_ID, createdAt: 10 },
      { role: 'assistant', content: 'r-1', threadId: s.thread.id, createdAt: 20 },
      { role: 'user', content: 'r-2', threadId: s.thread.id, createdAt: 30 },
      { role: 'assistant', content: 'r-3', threadId: s.thread.id, createdAt: 40 },
    ];
    const fakeConv = { loadRecent: (_n) => fakeMessages };
    const all = parse(await readThreadRecent.execute({ thread_id: s.thread.id, limit: 10 }, { conversationStore: fakeConv }));
    expect(all.count).toBe(3);
    expect(all.messages.every(m => m.threadId === s.thread.id)).toBe(true);

    const capped = parse(await readThreadRecent.execute({ thread_id: s.thread.id, limit: 2 }, { conversationStore: fakeConv }));
    expect(capped.count).toBe(2);
    expect(capped.messages[0].content).toBe('r-2');
    expect(capped.messages[1].content).toBe('r-3');

    expect(parse(await readThreadRecent.execute({ thread_id: 'thr-nope' }, { conversationStore: fakeConv })).error).toMatch(/Thread not found/);
  });
});

describe('Engine.currentThreadId + registry wiring', () => {
  beforeEach(() => {
    _resetThreadStoreForTests();
    initThreadStore({ force: true });
  });

  it('Engine.currentThreadId defaults to main and reflects SwitchThread', async () => {
    const { Engine } = await import('../../agent/unify/engine.js');
    const eng = new Engine({
      adapter: { async *stream() {} },
      trace: { logTool() {}, logTurn() {}, close() {} },
      config: { model: 'x' },
    });
    expect(eng.currentThreadId).toBe(MAIN_THREAD_ID);

    const spawned = parse(await spawnThread.execute({ name: 'side' }));
    await switchThread.execute({ thread_id: spawned.thread.id });
    expect(eng.currentThreadId).toBe(spawned.thread.id);
  });

  it('createFullRegistry registers 7 thread tools (SpawnSubtask REMOVED)', async () => {
    const { createFullRegistry } = await import('../../agent/unify/tools/index.js');
    const r = createFullRegistry();
    const names = r.names;
    for (const n of [
      'SpawnThread',
      'SwitchThread',
      'ListThreads',
      'AttachThreadToTask',
      'SpawnTask',
      'ReadThreadSummary',
      'ReadThreadRecent',
    ]) {
      expect(names).toContain(n);
    }
    // Sanity: the merged-away tool is gone.
    expect(names).not.toContain('SpawnSubtask');
  });
});

describe('TaskStore Q3 migration (parentId → parentTaskId)', () => {
  let tmp;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'yeaft-mig-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Seed a legacy task.md that only has parentId (no parentTaskId). */
  function seedLegacyTask(dir, id, title, parentId) {
    const taskDir = join(dir, 'tasks', id);
    syncMkdir(taskDir, { recursive: true });
    const fm = ['---', `id: ${id}`, `title: ${title}`, 'status: pending', 'priority: medium'];
    if (parentId) fm.push(`parentId: ${parentId}`);
    fm.push('---', '', 'legacy body');
    syncWrite(join(taskDir, 'task.md'), fm.join('\n'), 'utf8');
    syncWrite(join(taskDir, 'progress.md'), '# Progress Log\n\n', 'utf8');
    syncWrite(join(taskDir, 'memory.md'), '# Task Memory\n', 'utf8');
  }

  it('(a) old legacy tasks: after construction, tree() is NOT all-roots', () => {
    // Seed a root + two children using only parentId
    syncMkdir(join(tmp, 'tasks'), { recursive: true });
    seedLegacyTask(tmp, 'task-root1111', 'R', null);
    seedLegacyTask(tmp, 'task-child1111', 'C1', 'task-root1111');
    seedLegacyTask(tmp, 'task-child2222', 'C2', 'task-root1111');

    const store = new TaskStore(tmp, { readOnly: false });
    const { roots } = store.tree();
    // Without migration, all three would be roots. With migration, only 1.
    expect(roots.map(t => t.id).sort()).toEqual(['task-root1111']);
    // Canonical field populated in memory.
    expect(store.get('task-child1111').parentTaskId).toBe('task-root1111');
    expect(store.get('task-child2222').parentTaskId).toBe('task-root1111');

    // Meta marker file created.
    const marker = join(tmp, 'tasks', '.migrations', 'parentTaskId');
    expect(syncExists(marker)).toBe(true);
  });

  it('(b) migration is idempotent — second construction is a no-op', () => {
    syncMkdir(join(tmp, 'tasks'), { recursive: true });
    seedLegacyTask(tmp, 'task-rootaaaa', 'R', null);
    seedLegacyTask(tmp, 'task-chldaaaa', 'C', 'task-rootaaaa');

    // First boot migrates
    const first = new TaskStore(tmp, { readOnly: false });
    const r1 = first.migrateParentTaskId();
    // Called from constructor already; explicit re-call must be no-op (marker present).
    expect(r1.ran).toBe(false);

    // Second boot — new TaskStore, same dir. Must not touch anything.
    const second = new TaskStore(tmp, { readOnly: false });
    const r2 = second.migrateParentTaskId();
    expect(r2.ran).toBe(false);
    expect(second.get('task-chldaaaa').parentTaskId).toBe('task-rootaaaa');
  });
});
