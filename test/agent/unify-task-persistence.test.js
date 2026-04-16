/**
 * Tests for task-273: Unify task system file persistence.
 *
 * Verifies:
 * 1. TaskStore creates directory structure
 * 2. Tasks persist to .md files with YAML frontmatter
 * 3. Tasks load from disk on construction
 * 4. Completed tasks move to completed/ directory
 * 5. Plan persists to plan.md
 * 6. task-tools.js uses TaskStore instead of in-memory Map
 * 7. session.js initializes TaskStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ─── TaskStore unit tests ────────────────────────────────────

describe('TaskStore', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `yeaft-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('creates directory structure on construction', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    new TaskStore(tmpDir);

    expect(existsSync(join(tmpDir, 'tasks'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tasks', 'active'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tasks', 'completed'))).toBe(true);
  });

  it('creates and persists a task to active/ directory', async () => {
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

    const filePath = join(tmpDir, 'tasks', 'active', 'task-abc123.md');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('id: task-abc123');
    expect(content).toContain('title: Test task');
    expect(content).toContain('status: pending');
    expect(content).toContain('priority: high');
  });

  it('loads tasks from disk on construction', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');

    // Create store and add task
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

    // Create new store from same directory — should load existing task
    const store2 = new TaskStore(tmpDir);
    const task = store2.get('task-persist');
    expect(task).not.toBeNull();
    expect(task.title).toBe('Persisted task');
    expect(task.status).toBe('in_progress');
    expect(task.description).toBe('Should survive restart');
  });

  it('moves completed tasks to completed/ directory', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-move',
      title: 'Will complete',
      description: '',
      priority: 'low',
      status: 'pending',
      parentId: null,
      createdAt: 3000,
      updatedAt: 3000,
    });

    // Should be in active/
    expect(existsSync(join(tmpDir, 'tasks', 'active', 'task-move.md'))).toBe(true);

    // Mark as completed
    store.update('task-move', { status: 'completed', result: 'Done!' });

    // Should be in completed/, not active/
    expect(existsSync(join(tmpDir, 'tasks', 'completed', 'task-move.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tasks', 'active', 'task-move.md'))).toBe(false);

    // File should contain result
    const content = readFileSync(join(tmpDir, 'tasks', 'completed', 'task-move.md'), 'utf8');
    expect(content).toContain('status: completed');
    expect(content).toContain('## Result');
    expect(content).toContain('Done!');
  });

  it('moves cancelled tasks to completed/ directory', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({
      id: 'task-cancel',
      title: 'Will cancel',
      description: '',
      priority: 'low',
      status: 'pending',
      parentId: null,
      createdAt: 4000,
      updatedAt: 4000,
    });

    store.update('task-cancel', { status: 'cancelled' });
    expect(existsSync(join(tmpDir, 'tasks', 'completed', 'task-cancel.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tasks', 'active', 'task-cancel.md'))).toBe(false);
  });

  it('persists and loads plan.md', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store1 = new TaskStore(tmpDir);

    store1.setPlan('# My Plan\n\n1. Step one\n2. Step two');

    expect(existsSync(join(tmpDir, 'tasks', 'plan.md'))).toBe(true);

    // New store should load same plan
    const store2 = new TaskStore(tmpDir);
    expect(store2.getPlan()).toBe('# My Plan\n\n1. Step one\n2. Step two');
  });

  it('returns empty string for missing plan', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);
    expect(store.getPlan()).toBe('');
  });

  it('filters tasks by status', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({ id: 't1', title: 'T1', description: '', priority: 'medium', status: 'pending', parentId: null, createdAt: 1, updatedAt: 1 });
    store.create({ id: 't2', title: 'T2', description: '', priority: 'high', status: 'in_progress', parentId: null, createdAt: 2, updatedAt: 2 });
    store.create({ id: 't3', title: 'T3', description: '', priority: 'low', status: 'pending', parentId: null, createdAt: 3, updatedAt: 3 });

    const pending = store.list({ status: 'pending' });
    expect(pending.length).toBe(2);
    expect(pending.every(t => t.status === 'pending')).toBe(true);

    const inProgress = store.list({ status: 'in_progress' });
    expect(inProgress.length).toBe(1);
    expect(inProgress[0].id).toBe('t2');
  });

  it('update returns null for non-existent task', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);
    expect(store.update('nonexistent', { status: 'done' })).toBeNull();
  });

  it('deletes a task and removes file', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    const store = new TaskStore(tmpDir);

    store.create({ id: 'task-del', title: 'Delete me', description: '', priority: 'low', status: 'pending', parentId: null, createdAt: 1, updatedAt: 1 });
    expect(store.get('task-del')).not.toBeNull();

    store.delete('task-del');
    expect(store.get('task-del')).toBeNull();
    expect(existsSync(join(tmpDir, 'tasks', 'active', 'task-del.md'))).toBe(false);
  });

  it('handles readOnly mode gracefully', async () => {
    const { TaskStore } = await import('../../agent/unify/tasks/store.js');
    // Pre-create dirs so constructor doesn't fail
    mkdirSync(join(tmpDir, 'tasks', 'active'), { recursive: true });
    mkdirSync(join(tmpDir, 'tasks', 'completed'), { recursive: true });

    const store = new TaskStore(tmpDir, { readOnly: true });

    store.create({ id: 'task-ro', title: 'RO task', description: '', priority: 'medium', status: 'pending', parentId: null, createdAt: 1, updatedAt: 1 });

    // Task should be in memory cache
    expect(store.get('task-ro')).not.toBeNull();

    // But NOT written to disk
    expect(existsSync(join(tmpDir, 'tasks', 'active', 'task-ro.md'))).toBe(false);
  });

  it('loads tasks from both active and completed directories', async () => {
    const { TaskStore, _serializeTask } = await import('../../agent/unify/tasks/store.js');

    // Pre-create directories and files
    mkdirSync(join(tmpDir, 'tasks', 'active'), { recursive: true });
    mkdirSync(join(tmpDir, 'tasks', 'completed'), { recursive: true });

    writeFileSync(join(tmpDir, 'tasks', 'active', 'task-a.md'), _serializeTask({
      id: 'task-a', title: 'Active task', description: 'Still working', priority: 'high', status: 'in_progress',
      createdAt: 100, updatedAt: 200,
    }));

    writeFileSync(join(tmpDir, 'tasks', 'completed', 'task-b.md'), _serializeTask({
      id: 'task-b', title: 'Done task', description: 'All done', priority: 'low', status: 'completed',
      createdAt: 50, updatedAt: 150, result: 'Finished successfully',
    }));

    const store = new TaskStore(tmpDir);
    expect(store.size).toBe(2);
    expect(store.get('task-a').status).toBe('in_progress');
    expect(store.get('task-b').status).toBe('completed');
    expect(store.get('task-b').result).toBe('Finished successfully');
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

  it('handles task without result', async () => {
    const { _serializeTask, _parseTask } = await import('../../agent/unify/tasks/store.js');

    const task = {
      id: 'task-noresult',
      title: 'No result',
      description: 'Just a description',
      priority: 'low',
      status: 'pending',
      createdAt: 1000,
      updatedAt: 1000,
    };

    const parsed = _parseTask(_serializeTask(task));
    expect(parsed.description).toBe('Just a description');
    expect(parsed.result).toBeUndefined();
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
  it('imports TaskStore from tasks/store.js', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'tools', 'task-tools.js'),
      'utf8'
    );

    expect(src).toContain("import { TaskStore } from '../tasks/store.js'");
  });

  it('does NOT use in-memory Map for tasks', async () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'agent', 'unify', 'tools', 'task-tools.js'),
      'utf8'
    );

    expect(src).not.toContain('const tasks = new Map()');
    expect(src).not.toContain("let currentPlan = ''");
  });

  it('exports initTaskStore function', async () => {
    const { initTaskStore } = await import('../../agent/unify/tools/task-tools.js');
    expect(typeof initTaskStore).toBe('function');
  });

  it('exports getTaskStore function', async () => {
    const { getTaskStore } = await import('../../agent/unify/tools/task-tools.js');
    expect(typeof getTaskStore).toBe('function');
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
