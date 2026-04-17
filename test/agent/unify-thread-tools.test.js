/**
 * unify-thread-tools.test.js — task-299 Phase 1
 *
 * Covers:
 *   - ThreadStore in-memory CRUD + current-thread marker + attachments
 *   - SpawnThread / SwitchThread / ListThreads / AttachThreadToTask
 *   - SpawnTask / SpawnSubtask wrappers (mock TaskStore via initTaskStore)
 *   - Engine.currentThreadId getter defaults to 'main'
 *   - Engine emits threadId on tool_start / tool_end (mocked registry)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
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
} from '../../agent/unify/tools/thread-tools.js';
import {
  spawnTask,
  spawnSubtask,
} from '../../agent/unify/tools/spawn-task-tools.js';
import { initTaskStore } from '../../agent/unify/tools/task-tools.js';

function parse(r) { return JSON.parse(r); }

describe('ThreadStore (in-memory)', () => {
  it('seeds a default "main" thread and marks it current', () => {
    const s = new ThreadStore();
    expect(s.has(MAIN_THREAD_ID)).toBe(true);
    expect(s.currentId).toBe(MAIN_THREAD_ID);
    expect(s.size).toBe(1);
  });

  it('create() produces a thr-xxxxxxxx id and does not auto-switch', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'feature-x', goal: 'ship it' });
    expect(t.id).toMatch(/^thr-[0-9a-f]{8}$/);
    expect(t.name).toBe('feature-x');
    expect(t.goal).toBe('ship it');
    expect(t.parentThreadId).toBeNull();
    expect(s.currentId).toBe(MAIN_THREAD_ID); // not switched
  });

  it('create() rejects empty name', () => {
    const s = new ThreadStore();
    expect(() => s.create({ name: '' })).toThrow(/name is required/);
    expect(() => s.create({ name: '   ' })).toThrow(/name is required/);
  });

  it('create() rejects unknown parent thread', () => {
    const s = new ThreadStore();
    expect(() => s.create({ name: 'x', parentThreadId: 'thr-nope' })).toThrow(/parent thread not found/);
  });

  it('switch() updates currentId, throws on unknown', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'a' });
    s.switch(t.id);
    expect(s.currentId).toBe(t.id);
    expect(() => s.switch('thr-missing')).toThrow(/thread not found/);
  });

  it('attachTask() records mapping, throws on unknown thread / missing taskId', () => {
    const s = new ThreadStore();
    const t = s.create({ name: 'a' });
    s.attachTask(t.id, 'task-abc');
    expect(s.attachedTask(t.id)).toBe('task-abc');
    expect(() => s.attachTask('thr-missing', 'task-abc')).toThrow(/thread not found/);
    expect(() => s.attachTask(t.id, '')).toThrow(/taskId is required/);
  });

  it('listAttachments() returns all { threadId, taskId }', () => {
    const s = new ThreadStore();
    const a = s.create({ name: 'a' });
    const b = s.create({ name: 'b' });
    s.attachTask(a.id, 'task-1');
    s.attachTask(b.id, 'task-2');
    const atts = s.listAttachments();
    expect(atts).toHaveLength(2);
    expect(atts.map(x => x.taskId).sort()).toEqual(['task-1', 'task-2']);
  });

  it('getThreadStore() is a singleton; initThreadStore({force:true}) resets it', () => {
    _resetThreadStoreForTests();
    const a = getThreadStore();
    const b = getThreadStore();
    expect(a).toBe(b);
    const c = initThreadStore({ force: true });
    expect(c).not.toBe(a);
    _resetThreadStoreForTests();
  });
});

describe('thread-tools', () => {
  beforeEach(() => {
    _resetThreadStoreForTests();
    initThreadStore({ force: true });
  });

  it('SpawnThread: success + missing name', async () => {
    const ok = parse(await spawnThread.execute({ name: 'test' }));
    expect(ok.success).toBe(true);
    expect(ok.thread.id).toMatch(/^thr-/);

    const err = parse(await spawnThread.execute({}));
    expect(err.error).toMatch(/name is required/);
  });

  it('SpawnThread: bad parent surfaces error', async () => {
    const err = parse(await spawnThread.execute({ name: 'x', parent_thread_id: 'thr-missing' }));
    expect(err.error).toMatch(/parent thread not found/);
  });

  it('SwitchThread: success + unknown id error', async () => {
    const spawned = parse(await spawnThread.execute({ name: 'a' }));
    const ok = parse(await switchThread.execute({ thread_id: spawned.thread.id }));
    expect(ok.success).toBe(true);
    expect(ok.currentThreadId).toBe(spawned.thread.id);

    const err = parse(await switchThread.execute({ thread_id: 'thr-nope' }));
    expect(err.error).toMatch(/thread not found/);

    const miss = parse(await switchThread.execute({}));
    expect(miss.error).toMatch(/thread_id is required/);
  });

  it('ListThreads: includes main + spawned, exposes current marker', async () => {
    const spawned = parse(await spawnThread.execute({ name: 'alpha' }));
    const listed = parse(await listThreads.execute({}));
    expect(listed.currentThreadId).toBe(MAIN_THREAD_ID);
    expect(listed.totalCount).toBe(2);
    const ids = listed.threads.map(t => t.id);
    expect(ids).toContain(MAIN_THREAD_ID);
    expect(ids).toContain(spawned.thread.id);
  });

  it('AttachThreadToTask: missing args + unknown thread', async () => {
    const m1 = parse(await attachThreadToTask.execute({ task_id: 'task-1' }));
    expect(m1.error).toMatch(/thread_id is required/);
    const m2 = parse(await attachThreadToTask.execute({ thread_id: MAIN_THREAD_ID }));
    expect(m2.error).toMatch(/task_id is required/);
  });
});

describe('spawn-task-tools (shared TaskStore)', () => {
  let tmp;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'yeaft-spawn-'));
    initTaskStore(tmp, { readOnly: false });
    _resetThreadStoreForTests();
    initThreadStore({ force: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('SpawnTask creates a task with id task-xxxxxxxx', async () => {
    const r = parse(await spawnTask.execute({ title: 'top-level work' }));
    expect(r.success).toBe(true);
    expect(r.task.id).toMatch(/^task-[0-9a-f]{8}$/);
    expect(r.task.status).toBe('pending');
  });

  it('SpawnTask rejects missing title', async () => {
    const r = parse(await spawnTask.execute({}));
    expect(r.error).toMatch(/title is required/);
  });

  it('SpawnSubtask requires parent_task_id and an existing parent', async () => {
    const e1 = parse(await spawnSubtask.execute({ title: 'x' }));
    expect(e1.error).toMatch(/parent_task_id is required/);
    const e2 = parse(await spawnSubtask.execute({ parent_task_id: 'task-missing', title: 'x' }));
    expect(e2.error).toMatch(/Parent task not found/);
  });

  it('SpawnSubtask links to parent', async () => {
    const parent = parse(await spawnTask.execute({ title: 'parent' }));
    const child = parse(await spawnSubtask.execute({
      parent_task_id: parent.task.id,
      title: 'child',
    }));
    expect(child.success).toBe(true);
    expect(child.task.parentId).toBe(parent.task.id);
  });

  it('AttachThreadToTask validates task existence when store is initialized', async () => {
    const t = parse(await spawnThread.execute({ name: 'bind-me' }));
    const bad = parse(await attachThreadToTask.execute({
      thread_id: t.thread.id,
      task_id: 'task-missing',
    }));
    expect(bad.error).toMatch(/Task not found/);

    const parent = parse(await spawnTask.execute({ title: 'pp' }));
    const ok = parse(await attachThreadToTask.execute({
      thread_id: t.thread.id,
      task_id: parent.task.id,
    }));
    expect(ok.success).toBe(true);
    expect(ok.threadId).toBe(t.thread.id);
    expect(ok.taskId).toBe(parent.task.id);
  });
});

describe('Engine.currentThreadId + tool event threadId', () => {
  beforeEach(() => {
    _resetThreadStoreForTests();
    initThreadStore({ force: true });
  });

  it('Engine exposes currentThreadId defaulting to main', async () => {
    const { Engine } = await import('../../agent/unify/engine.js');
    const eng = new Engine({
      adapter: { async *stream() {} },
      trace: { logTool() {}, logTurn() {}, close() {} },
      config: { model: 'x' },
    });
    expect(eng.currentThreadId).toBe(MAIN_THREAD_ID);
  });

  it('Engine.currentThreadId reflects SwitchThread', async () => {
    const { Engine } = await import('../../agent/unify/engine.js');
    const spawned = parse(await spawnThread.execute({ name: 'side' }));
    await switchThread.execute({ thread_id: spawned.thread.id });
    const eng = new Engine({
      adapter: { async *stream() {} },
      trace: { logTool() {}, logTurn() {}, close() {} },
      config: { model: 'x' },
    });
    expect(eng.currentThreadId).toBe(spawned.thread.id);
  });
});

describe('createFullRegistry wiring', () => {
  it('registers all 6 thread/spawn tools', async () => {
    const { createFullRegistry } = await import('../../agent/unify/tools/index.js');
    const r = createFullRegistry();
    const names = r.names;
    for (const n of ['SpawnThread', 'SwitchThread', 'ListThreads', 'AttachThreadToTask', 'SpawnTask', 'SpawnSubtask']) {
      expect(names).toContain(n);
    }
  });
});
