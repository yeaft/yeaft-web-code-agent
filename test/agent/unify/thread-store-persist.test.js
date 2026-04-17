/**
 * thread-store-persist.test.js — task-307a
 *
 * Round-trip persistence for ThreadStore and TaskStore. Each test writes a
 * store to a scratch dir, flushes synchronously, constructs a fresh store
 * pointing at the same dir, and verifies cached fields + attachments survive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ThreadStore,
  MAIN_THREAD_ID,
  _serializeThread,
  _parseThread,
} from '../../../agent/unify/threads/store.js';
import { TaskStore } from '../../../agent/unify/tasks/store.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'yeaft-persist-'));
}

describe('ThreadStore — persistence round-trip (task-307a)', () => {
  let dir;
  beforeEach(() => { dir = scratch(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('writes threads/{id}.md after create + flush()', () => {
    const s = new ThreadStore(dir);
    const t = s.create({ name: 'alpha' });
    s.flush();
    expect(existsSync(join(dir, 'threads', `${t.id}.md`))).toBe(true);
    expect(existsSync(join(dir, 'threads', 'main.md'))).toBe(true);
    expect(existsSync(join(dir, 'threads', 'index.md'))).toBe(true);
  });

  it('reloads all threads + cached fields on reopen', () => {
    const s1 = new ThreadStore(dir);
    const t = s1.create({ name: 'beta', goal: 'demo goal' });
    s1.noteMessage(t.id, 1_700_000_000_000, { preview: 'hello world' });
    s1.noteMessage(t.id, 1_700_000_001_000, { preview: 'second message' });
    s1.flush();

    const s2 = new ThreadStore(dir);
    const reloaded = s2.get(t.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded.name).toBe('beta');
    expect(reloaded.goal).toBe('demo goal');
    expect(reloaded.messageCount).toBe(2);
    expect(reloaded.lastMessageAt).toBe(1_700_000_001_000);
    expect(reloaded.lastActivityAt).toBe(1_700_000_001_000);
    expect(reloaded.unread).toBe(2);
    expect(reloaded.preview).toContain('second message');
  });

  it('persists archived status across reopen', () => {
    const s1 = new ThreadStore(dir);
    const t = s1.create({ name: 'gamma' });
    s1.archive(t.id);
    s1.flush();

    const s2 = new ThreadStore(dir);
    const r = s2.get(t.id);
    expect(r.status).toBe('archived');
    expect(r.archived).toBe(true);
  });

  it('persists markRead (unread=0) across reopen', () => {
    const s1 = new ThreadStore(dir);
    const t = s1.create({ name: 'delta' });
    s1.noteMessage(t.id, 1_700_000_000_000);
    expect(s1.get(t.id).unread).toBe(1);
    s1.markRead(t.id);
    s1.flush();

    const s2 = new ThreadStore(dir);
    expect(s2.get(t.id).unread).toBe(0);
  });

  it('persists attachments side-car across reopen', () => {
    const s1 = new ThreadStore(dir);
    const t = s1.create({ name: 'eps' });
    s1.attachTask(t.id, 'task-abc');
    s1.flush();
    expect(existsSync(join(dir, 'threads', 'attachments.json'))).toBe(true);

    const s2 = new ThreadStore(dir);
    expect(s2.attachedTask(t.id)).toBe('task-abc');
    expect(s2.listAttachments()).toEqual([{ threadId: t.id, taskId: 'task-abc' }]);
  });

  it('persists currentId through switch()', () => {
    const s1 = new ThreadStore(dir);
    const t = s1.create({ name: 'zeta' });
    s1.switch(t.id);
    s1.flush();

    const s2 = new ThreadStore(dir);
    expect(s2.currentId).toBe(t.id);
  });

  it('synthesises the main thread on a fresh empty dir', () => {
    const s = new ThreadStore(dir);
    expect(s.get(MAIN_THREAD_ID)).not.toBeNull();
    s.flush();
    expect(existsSync(join(dir, 'threads', 'main.md'))).toBe(true);
  });

  it('read-only mode skips disk writes', () => {
    const s = new ThreadStore(dir, { readOnly: true });
    s.create({ name: 'ro' });
    const written = s.flush();
    expect(written).toBe(0);
    // threads dir may exist (mkdir before readonly flip), but no *.md beyond index
    const files = existsSync(join(dir, 'threads'))
      ? readdirSync(join(dir, 'threads'))
      : [];
    expect(files.filter((f) => f.endsWith('.md'))).toEqual([]);
  });

  it('in-memory mode (no yeaftDir) — flush() is a no-op', () => {
    const s = new ThreadStore();
    s.create({ name: 'mem' });
    expect(s.flush()).toBe(0);
  });

  it('_serializeThread / _parseThread round-trip', () => {
    const t = {
      id: 'thr-1',
      name: 'round',
      goal: 'trip',
      parentThreadId: null,
      status: 'active',
      archived: false,
      messageCount: 5,
      lastMessageAt: 1234,
      lastActivityAt: 1234,
      unread: 2,
      preview: 'hi',
      createdAt: 1,
      updatedAt: 2,
    };
    const raw = _serializeThread(t);
    const parsed = _parseThread(raw);
    expect(parsed.id).toBe('thr-1');
    expect(parsed.messageCount).toBe(5);
    expect(parsed.unread).toBe(2);
    expect(parsed.preview.trim()).toBe('hi');
    expect(parsed.archived).toBe(false);
  });

  it('skips corrupt thread files silently', () => {
    const s1 = new ThreadStore(dir);
    s1.create({ name: 'ok' });
    s1.flush();
    // Corrupt file
    const fs = require('fs');
    fs.writeFileSync(join(dir, 'threads', 'garbage.md'), 'not-yaml', 'utf8');
    const s2 = new ThreadStore(dir);
    // Still loads valid threads + main
    expect(s2.size).toBeGreaterThanOrEqual(2);
  });

  it('index.md contains current thread id + thread table', () => {
    const s = new ThreadStore(dir);
    const t = s.create({ name: 'idx' });
    s.switch(t.id);
    s.flush();
    const idx = readFileSync(join(dir, 'threads', 'index.md'), 'utf8');
    expect(idx).toContain(`currentId: ${t.id}`);
    expect(idx).toContain('| ID | Name | Status');
    expect(idx).toContain(t.id);
  });
});

describe('TaskStore — persistence round-trip (task-307a)', () => {
  let dir;
  beforeEach(() => { dir = scratch(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('writes task.md / progress.md / memory.md on create', () => {
    const s = new TaskStore(dir);
    s.create({
      id: 'task-xyz12345',
      title: 'demo',
      status: 'pending',
      priority: 'high',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const td = join(dir, 'tasks', 'task-xyz12345');
    expect(existsSync(join(td, 'task.md'))).toBe(true);
    expect(existsSync(join(td, 'progress.md'))).toBe(true);
    expect(existsSync(join(td, 'memory.md'))).toBe(true);
  });

  it('reloads tasks + fields on reopen', () => {
    const s1 = new TaskStore(dir);
    s1.create({
      id: 'task-abcd1234',
      title: 'persist',
      status: 'pending',
      priority: 'medium',
      description: 'round-trip me',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    s1.update('task-abcd1234', { status: 'in_progress' });

    const s2 = new TaskStore(dir);
    const t = s2.get('task-abcd1234');
    expect(t).not.toBeNull();
    expect(t.title).toBe('persist');
    expect(t.status).toBe('in_progress');
    expect(t.priority).toBe('medium');
    expect(t.description).toContain('round-trip me');
  });

  it('progress log persists across reopen', () => {
    const s1 = new TaskStore(dir);
    s1.create({
      id: 'task-prog0001',
      title: 'p',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    s1.appendProgress('task-prog0001', 'hello note', {});
    const s2 = new TaskStore(dir);
    expect(s2.getProgress('task-prog0001')).toContain('hello note');
  });
});
