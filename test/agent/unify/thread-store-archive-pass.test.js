/**
 * thread-store-archive-pass.test.js — task-317.
 *
 * Covers ThreadStore.runArchivePass():
 *   - threshold trigger: old threads get archived, fresh ones don't
 *   - main thread is ALWAYS exempt
 *   - idleArchiveDays === 0 disables feature (no-op)
 *   - already-archived threads are left alone (idempotent)
 *   - lowering idleArchiveDays + re-running immediately archives more
 *   - createdAt fallback for threads with no messages
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ThreadStore,
  MAIN_THREAD_ID,
  _resetThreadStoreForTests,
} from '../../../agent/unify/threads/store.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-archive-pass-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const DAY = 86400000;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  _resetThreadStoreForTests();
});

afterEach(() => {
  _resetThreadStoreForTests();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('ThreadStore.runArchivePass (task-317)', () => {
  it('idleArchiveDays=0 disables auto-archive (no-op)', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 0 });
    const t = s.create({ name: 'old' });
    // Force lastMessageAt to 100 days ago.
    s.noteMessage(t.id, Date.now() - 100 * DAY);
    const { archived } = s.runArchivePass();
    expect(archived).toEqual([]);
    expect(s.get(t.id).status).toBe('active');
  });

  it('archives threads older than threshold', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 7 });
    const fresh = s.create({ name: 'fresh' });
    const stale = s.create({ name: 'stale' });
    const now = Date.now();
    s.noteMessage(fresh.id, now - 3 * DAY);
    s.noteMessage(stale.id, now - 30 * DAY);

    const { archived } = s.runArchivePass(now);
    expect(archived).toEqual([stale.id]);
    expect(s.get(fresh.id).status).toBe('active');
    expect(s.get(stale.id).status).toBe('archived');
    expect(s.get(stale.id).archived).toBe(true);
  });

  it('never archives the main thread regardless of age', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 1 });
    const now = Date.now();
    // Artificially age main by re-noting an ancient message.
    s.noteMessage(MAIN_THREAD_ID, now - 365 * DAY);
    const { archived } = s.runArchivePass(now);
    expect(archived).not.toContain(MAIN_THREAD_ID);
    expect(s.get(MAIN_THREAD_ID).status).toBe('active');
  });

  it('is idempotent — archived threads are skipped on re-run', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 7 });
    const t = s.create({ name: 'stale' });
    const now = Date.now();
    s.noteMessage(t.id, now - 30 * DAY);
    expect(s.runArchivePass(now).archived).toEqual([t.id]);
    // Second pass: same threshold, should find nothing new.
    expect(s.runArchivePass(now).archived).toEqual([]);
  });

  it('config live-change + re-run immediately picks up more threads', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 90 });
    const t = s.create({ name: 'mid' });
    const now = Date.now();
    s.noteMessage(t.id, now - 30 * DAY);
    // With idleArchiveDays=90, 30-day-old is fresh.
    expect(s.runArchivePass(now).archived).toEqual([]);
    // User drops the threshold to 7 days — next sweep catches it.
    s.setIdleArchiveDays(7);
    expect(s.runArchivePass(now).archived).toEqual([t.id]);
  });

  it('falls back to createdAt when thread has no messages', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 1 });
    const t = s.create({ name: 'empty' });
    // Backdate createdAt so it looks ancient (direct mutation acceptable
    // — this mirrors how a thread that sat untouched for weeks would look).
    s.get(t.id).createdAt = Date.now() - 30 * DAY;
    s.get(t.id).lastMessageAt = null;
    s.get(t.id).lastActivityAt = null;
    const { archived } = s.runArchivePass();
    expect(archived).toContain(t.id);
  });

  it('broadcast-relevant return value: archived[] empty when nothing changes', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 7 });
    const t = s.create({ name: 'fresh' });
    s.noteMessage(t.id, Date.now() - 1 * DAY);
    const { archived } = s.runArchivePass();
    expect(archived).toEqual([]);
  });
});
