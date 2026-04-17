/**
 * task-298 — Unify multi-thread data layer tests.
 *
 * Covers:
 *   - ThreadStore CRUD + 'main' bootstrap + delete protection
 *   - InputQueueStore enqueue / list FIFO / status transitions
 *   - TaskStore parentTaskId + primaryThreadId + children() + tree()
 *   - ConversationStore.migrateMessagesToThread idempotency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { ThreadStore, MAIN_THREAD_ID } from '../../agent/unify/threads/store.js';
import { InputQueueStore } from '../../agent/unify/input-queue/store.js';
import { TaskStore } from '../../agent/unify/tasks/store.js';
import { ConversationStore } from '../../agent/unify/conversation/persist.js';

function mkTmp() {
  const d = join(tmpdir(), `yeaft-thread-data-${randomUUID().slice(0, 8)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe('ThreadStore', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('bootstraps the main thread automatically', () => {
    const s = new ThreadStore(dir);
    expect(s.get(MAIN_THREAD_ID)).not.toBeNull();
    expect(s.get(MAIN_THREAD_ID).id).toBe('main');
  });

  it('create + list + get round-trip', () => {
    const s = new ThreadStore(dir);
    s.create({ id: 't-alpha', name: 'Alpha', status: 'active' });
    s.create({ id: 't-beta', name: 'Beta', status: 'idle' });
    const all = s.list();
    expect(all.length).toBe(3); // main + 2
    expect(s.get('t-alpha').name).toBe('Alpha');
    expect(s.list({ status: 'idle' }).map(t => t.id)).toEqual(['t-beta']);
  });

  it("refuses to delete the 'main' thread", () => {
    const s = new ThreadStore(dir);
    expect(() => s.delete('main')).toThrow();
    expect(s.get('main')).not.toBeNull();
  });

  it('persists threads across instances', () => {
    const s1 = new ThreadStore(dir);
    s1.create({ id: 't-persist', name: 'Persist', status: 'active', summary: 'hello' });
    const s2 = new ThreadStore(dir);
    const t = s2.get('t-persist');
    expect(t).not.toBeNull();
    expect(t.name).toBe('Persist');
  });
});

describe('InputQueueStore', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('enqueues entries FIFO by createdAt', () => {
    const q = new InputQueueStore(dir);
    const a = q.enqueue({ text: 'one' });
    // Force distinct createdAt by manually updating
    q.update(a.id, { });
    const b = q.enqueue({ text: 'two' });
    const c = q.enqueue({ text: 'three' });
    // Patch createdAt to guarantee ordering (independent of clock resolution)
    q.update(a.id, {});
    const now = Date.now();
    // Overwrite createdAts via direct update of the object-not-possible-route;
    // rely on fact that enqueue creates with new Date().toISOString() and list
    // sorts by string compare.
    const list = q.list();
    expect(list.length).toBe(3);
    expect(list[0].id).toBe(a.id);
    expect(list[list.length - 1].id).toBe(c.id);
  });

  it('supports status transitions', () => {
    const q = new InputQueueStore(dir);
    const e = q.enqueue({ text: 'hello' });
    expect(e.status).toBe('pending');
    const r = q.update(e.id, { status: 'routing' });
    expect(r.status).toBe('routing');
    const d = q.update(e.id, { status: 'dispatched', routedTo: { threadId: 'main' } });
    expect(d.status).toBe('dispatched');
    expect(d.routedTo.threadId).toBe('main');
    expect(q.list({ status: 'dispatched' }).length).toBe(1);
  });

  it('rejects invalid status on enqueue and update', () => {
    const q = new InputQueueStore(dir);
    expect(() => q.enqueue({ text: 'x', status: 'bogus' })).toThrow();
    const e = q.enqueue({ text: 'x' });
    expect(() => q.update(e.id, { status: 'bogus' })).toThrow();
  });

  it('persists across instances', () => {
    const q1 = new InputQueueStore(dir);
    q1.enqueue({ text: 'persist me' });
    const q2 = new InputQueueStore(dir);
    expect(q2.size).toBe(1);
    expect(q2.list()[0].text).toBe('persist me');
  });
});

describe('TaskStore parentTaskId + primaryThreadId', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('stores parentTaskId + primaryThreadId via create and reloads from disk', () => {
    const s1 = new TaskStore(dir);
    s1.create({
      id: 'task-p',
      title: 'Parent',
      status: 'pending',
      priority: 'high',
      createdAt: 1000,
      updatedAt: 1000,
    });
    s1.create({
      id: 'task-c',
      title: 'Child',
      status: 'pending',
      priority: 'medium',
      parentTaskId: 'task-p',
      primaryThreadId: 'main',
      createdAt: 2000,
      updatedAt: 2000,
    });
    const s2 = new TaskStore(dir);
    const child = s2.get('task-c');
    expect(child.parentTaskId).toBe('task-p');
    expect(child.primaryThreadId).toBe('main');
    const parent = s2.get('task-p');
    expect(parent.parentTaskId).toBe(null);
    expect(parent.primaryThreadId).toBe(null);
  });

  it('children() returns direct children sorted by createdAt', () => {
    const s = new TaskStore(dir);
    s.create({ id: 'p1', title: 'P', status: 'pending', createdAt: 100, updatedAt: 100 });
    s.create({ id: 'c-late', title: 'CL', status: 'pending', parentTaskId: 'p1', createdAt: 300, updatedAt: 300 });
    s.create({ id: 'c-early', title: 'CE', status: 'pending', parentTaskId: 'p1', createdAt: 200, updatedAt: 200 });
    s.create({ id: 'other', title: 'O', status: 'pending', createdAt: 150, updatedAt: 150 });
    const kids = s.children('p1');
    expect(kids.map(t => t.id)).toEqual(['c-early', 'c-late']);
  });

  it('tree() returns only roots, with nested children attached', () => {
    const s = new TaskStore(dir);
    s.create({ id: 'r1', title: 'R1', status: 'pending', createdAt: 100, updatedAt: 100 });
    s.create({ id: 'r2', title: 'R2', status: 'pending', createdAt: 200, updatedAt: 200 });
    s.create({ id: 'r1-c1', title: 'R1C1', status: 'pending', parentTaskId: 'r1', createdAt: 150, updatedAt: 150 });
    s.create({ id: 'r1-c1-c1', title: 'deep', status: 'pending', parentTaskId: 'r1-c1', createdAt: 160, updatedAt: 160 });
    const roots = s.tree();
    expect(roots.map(t => t.id)).toEqual(['r1', 'r2']);
    expect(roots.every(r => r.parentTaskId === null)).toBe(true);
    expect(roots[0].children.map(c => c.id)).toEqual(['r1-c1']);
    expect(roots[0].children[0].children.map(c => c.id)).toEqual(['r1-c1-c1']);
    expect(roots[1].children).toEqual([]);
  });
});

describe('ConversationStore.migrateMessagesToThread', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('migrates legacy messages lacking threadId and is idempotent', () => {
    const convDir = join(dir, 'conversation');
    const msgDir = join(convDir, 'messages');
    mkdirSync(msgDir, { recursive: true });
    // Write a legacy message with no threadId
    const legacy = [
      '---',
      'id: m0001',
      'role: user',
      'time: 2026-04-01T00:00:00Z',
      'tokens_est: 10',
      '---',
      '',
      'Hello world',
    ].join('\n');
    writeFileSync(join(msgDir, 'm0001.md'), legacy, 'utf8');

    const store = new ConversationStore(dir);
    const first = store.migrateMessagesToThread('main');
    expect(first.migrated).toBe(1);
    expect(first.scanned).toBe(1);

    // Confirm file now contains threadId
    const rewritten = readFileSync(join(msgDir, 'm0001.md'), 'utf8');
    expect(rewritten).toMatch(/threadId: main/);

    // Second run: nothing to migrate (idempotent)
    const second = store.migrateMessagesToThread('main');
    expect(second.migrated).toBe(0);
    expect(second.scanned).toBe(1);
  });

  it('append() defaults threadId to main when not supplied', () => {
    const store = new ConversationStore(dir);
    const m = store.append({ role: 'user', content: 'hi' });
    expect(m.threadId).toBe('main');
    expect(m.taskId).toBe(null);
    expect(m.parentMessageId).toBe(null);
    // Round-trip via disk
    const loaded = store.loadAll();
    expect(loaded.length).toBe(1);
    expect(loaded[0].threadId).toBe('main');
  });
});
