/**
 * Tests for task-273: Unify task system file persistence (folder-per-task).
 *
 * Verifies:
 * 1. TaskStore creates directory structure
 * 2. Each task gets its own folder with task.md, progress.md, memory.md
 * 3. Tasks load from disk on construction
 * 4. Progress log is append-only
 * 5. Task memory can be read/updated
 * 6. Plan persists to plan.md
 * 7. Index.md is auto-generated
 * 8. task-tools.js uses TaskStore, exports TaskProgress and TaskMemory
 * 9. session.js initializes TaskStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ─── TaskStore unit tests ────────────────────────────────────

describe('TaskStore (folder-per-task)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `yeaft-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('creates tasks/ directory on construction', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    new TaskStore(tmpDir);
    expect(existsSync(join(tmpDir, 'tasks'))).toBe(true);
  });

  it('creates task folder with task.md, progress.md, memory.md', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-abc123',
      title: 'Test task',
      description: 'A test',
      priority: 'high',
      status: 'pending',
      parentId: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const taskDir = join(tmpDir, 'tasks', 'task-abc123');
    expect(existsSync(taskDir)).toBe(true);
    expect(existsSync(join(taskDir, 'task.md'))).toBe(true);
    expect(existsSync(join(taskDir, 'progress.md'))).toBe(true);
    expect(existsSync(join(taskDir, 'memory.md'))).toBe(true);

    const content = readFileSync(join(taskDir, 'task.md'), 'utf8');
    expect(content).toContain('id: task-abc123');
    expect(content).toContain('title: Test task');
    expect(content).toContain('status: pending');
    expect(content).toContain('priority: high');
  });

  it('creates initial progress entry on task creation', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-prog',
      title: 'Progress test',
      description: '',
      priority: 'medium',
      status: 'pending',
      parentId: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const progress = readFileSync(join(tmpDir, 'tasks', 'task-prog', 'progress.md'), 'utf8');
    expect(progress).toContain('# Progress Log');
    expect(progress).toContain('Created task: Progress test');
  });

  it('loads tasks from disk on construction', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');

    const store1 = new TaskStore(tmpDir);
    store1.create({
      id: 'task-persist',
      title: 'Persisted task',
      description: 'Should survive restart',
      priority: 'medium',
      status: 'in_progress',
      parentId: null,
      createdAt: 2000,
      updatedAt: 2000,
    });

    // New store from same directory should load existing task
    const store2 = new TaskStore(tmpDir);
    const task = store2.get('task-persist');
    expect(task).not.toBeNull();
    expect(task.title).toBe('Persisted task');
    expect(task.status).toBe('in_progress');
    expect(task.description).toBe('Should survive restart');
  });

  it('updates task.md on update', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-upd',
      title: 'Will update',
      description: '',
      priority: 'low',
      status: 'pending',
      parentId: null,
      createdAt: 3000,
      updatedAt: 3000,
    });

    store.update('task-upd', { status: 'completed', result: 'Done!' });

    const content = readFileSync(join(tmpDir, 'tasks', 'task-upd', 'task.md'), 'utf8');
    expect(content).toContain('status: completed');
    expect(content).toContain('## Result');
    expect(content).toContain('Done!');
  });

  it('logs status changes to progress.md', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-status',
      title: 'Status track',
      description: '',
      priority: 'medium',
      status: 'pending',
      parentId: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    store.update('task-status', { status: 'in_progress' });
    store.update('task-status', { status: 'completed' });

    const progress = readFileSync(join(tmpDir, 'tasks', 'task-status', 'progress.md'), 'utf8');
    expect(progress).toContain('Status changed: pending → in_progress');
    expect(progress).toContain('Status changed: in_progress → completed');
  });

  it('appendProgress adds entries to progress.md', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-ap',
      title: 'Append test',
      description: '',
      priority: 'medium',
      status: 'pending',
      parentId: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    store.appendProgress('task-ap', 'Started working on implementation');
    store.appendProgress('task-ap', 'Finished first pass');

    const progress = store.getProgress('task-ap');
    expect(progress).toContain('Started working on implementation');
    expect(progress).toContain('Finished first pass');
  });

  it('getMemory/updateMemory round-trips', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-mem',
      title: 'Memory test',
      description: '',
      priority: 'medium',
      status: 'pending',
      parentId: null,
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Initial memory
    const initial = store.getMemory('task-mem');
    expect(initial).toContain('# Task Memory');

    // Update
    store.updateMemory('task-mem', '# Task Memory\n\n## Key Decisions\n- Use RS256');

    const updated = store.getMemory('task-mem');
    expect(updated).toContain('Use RS256');
  });

  it('persists and loads plan.md', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store1 = new TaskStore(tmpDir);

    store1.setPlan('# My Plan\n\n1. Step one\n2. Step two');
    expect(existsSync(join(tmpDir, 'tasks', 'plan.md'))).toBe(true);

    const store2 = new TaskStore(tmpDir);
    expect(store2.getPlan()).toBe('# My Plan\n\n1. Step one\n2. Step two');
  });

  it('returns empty string for missing plan', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);
    expect(store.getPlan()).toBe('');
  });

  it('generates index.md', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({ id: 'task-a', title: 'Task A', description: '', priority: 'high', status: 'in_progress', parentId: null, createdAt: 1, updatedAt: 1 });
    store.create({ id: 'task-b', title: 'Task B', description: '', priority: 'low', status: 'pending', parentId: null, createdAt: 2, updatedAt: 2 });

    const index = readFileSync(join(tmpDir, 'tasks', 'index.md'), 'utf8');
    expect(index).toContain('totalTasks: 2');
    expect(index).toContain('task-a');
    expect(index).toContain('task-b');
    expect(index).toContain('Task A');
    expect(index).toContain('Task B');
  });

  it('filters tasks by status', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({ id: 't1', title: 'T1', description: '', priority: 'medium', status: 'pending', parentId: null, createdAt: 1, updatedAt: 1 });
    store.create({ id: 't2', title: 'T2', description: '', priority: 'high', status: 'in_progress', parentId: null, createdAt: 2, updatedAt: 2 });
    store.create({ id: 't3', title: 'T3', description: '', priority: 'low', status: 'pending', parentId: null, createdAt: 3, updatedAt: 3 });

    const pending = store.list({ status: 'pending' });
    expect(pending.length).toBe(2);

    const inProgress = store.list({ status: 'in_progress' });
    expect(inProgress.length).toBe(1);
    expect(inProgress[0].id).toBe('t2');
  });

  it('update returns null for non-existent task', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);
    expect(store.update('nonexistent', { status: 'done' })).toBeNull();
  });

  it('handles readOnly mode gracefully', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    mkdirSync(join(tmpDir, 'tasks'), { recursive: true });

    const store = new TaskStore(tmpDir, { readOnly: true });

    store.create({ id: 'task-ro', title: 'RO task', description: '', priority: 'medium', status: 'pending', parentId: null, createdAt: 1, updatedAt: 1 });

    // In memory but not on disk
    expect(store.get('task-ro')).not.toBeNull();
    expect(existsSync(join(tmpDir, 'tasks', 'task-ro'))).toBe(false);
  });
});

// ─── Serialization round-trip ────────────────────────────────

describe('Task serialization', () => {
  it('round-trips task through serialize/parse', async () => {
    const { _serializeTask, _parseTask } = await import('../../agent/unify/tasks/store.js');

    const task = {
      id: 'task-rt',
      title: 'Round trip test',
      description: 'Should survive serialization',
      priority: 'critical',
      status: 'blocked',
      parentId: 'task-parent',
      createdAt: 1713168000000,
      updatedAt: 1713168600000,
      result: 'Some result notes',
    };

    const serialized = _serializeTask(task);
    const parsed = _parseTask(serialized);

    expect(parsed.id).toBe('task-rt');
    expect(parsed.title).toBe('Round trip test');
    expect(parsed.description).toBe('Should survive serialization');
    expect(parsed.priority).toBe('critical');
    expect(parsed.status).toBe('blocked');
    expect(parsed.parentId).toBe('task-parent');
    expect(parsed.createdAt).toBe(1713168000000);
    expect(parsed.updatedAt).toBe(1713168600000);
    expect(parsed.result).toBe('Some result notes');
  });

  it('handles null parentId', async () => {
    const { _serializeTask, _parseTask } = await import('../../agent/unify/tasks/store.js');

    const task = {
      id: 'task-noparent',
      title: 'No parent',
      description: '',
      priority: 'medium',
      status: 'pending',
      parentId: null,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const parsed = _parseTask(_serializeTask(task));
    expect(parsed.parentId).toBeNull();
  });
});

// ─── Code structure tests ────────────────────────────────────

describe('task-tools.js uses TaskStore (code structure)', () => {
  it('imports TaskStore from tasks/store.js', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'tools', 'task-tools.js'),
      'utf8'
    );
    expect(src).toContain("import { TaskStore } from '../tasks/store.js'");
  });

  it('does NOT use in-memory Map for tasks', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'tools', 'task-tools.js'),
      'utf8'
    );
    expect(src).not.toContain('const tasks = new Map()');
    expect(src).not.toContain("let currentPlan = ''");
  });

  it('exports initTaskStore and getTaskStore', async () => {
    const { initTaskStore, getTaskStore } = await import('../../agent/unify/tools/task-tools.js');
    expect(typeof initTaskStore).toBe('function');
    expect(typeof getTaskStore).toBe('function');
  });

  it('exports TaskProgress tool', async () => {
    const { taskProgress } = await import('../../agent/unify/tools/task-tools.js');
    expect(taskProgress.name).toBe('TaskProgress');
    expect(typeof taskProgress.execute).toBe('function');
  });

  it('exports TaskMemory tool', async () => {
    const { taskMemory } = await import('../../agent/unify/tools/task-tools.js');
    expect(taskMemory.name).toBe('TaskMemory');
    expect(typeof taskMemory.execute).toBe('function');
  });
});

describe('index.js registers TaskProgress and TaskMemory', () => {
  it('allTools includes TaskProgress and TaskMemory', async () => {
    const { allTools } = await import('../../agent/unify/tools/index.js');
    const names = allTools.map(t => t.name);
    expect(names).toContain('TaskProgress');
    expect(names).toContain('TaskMemory');
  });
});

describe('session.js initializes TaskStore', () => {
  it('imports initTaskStore from task-tools.js', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'session.js'),
      'utf8'
    );
    expect(src).toContain("import { initTaskStore } from './tools/task-tools.js'");
  });

  it('calls initTaskStore during loadSession', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'session.js'),
      'utf8'
    );
    expect(src).toContain('initTaskStore(yeaftDir');
  });
});
