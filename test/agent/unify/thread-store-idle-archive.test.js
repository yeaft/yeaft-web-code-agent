/**
 * thread-store-idle-archive.test.js — task-318.
 *
 * Covers ThreadStore's idleArchiveDays knob:
 *   - constructor accepts the option
 *   - getter returns the value
 *   - setIdleArchiveDays() updates it live
 *   - 0 / null / negative / NaN all disable (0)
 *   - initThreadStore() forwards the option when force:true
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ThreadStore,
  initThreadStore,
  _resetThreadStoreForTests,
} from '../../../agent/unify/threads/store.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-idle-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

describe('ThreadStore.idleArchiveDays (task-318)', () => {
  it('defaults to 0 when not provided', () => {
    const s = new ThreadStore(TEST_DIR);
    expect(s.idleArchiveDays).toBe(0);
  });

  it('accepts a positive integer via constructor opts', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 30 });
    expect(s.idleArchiveDays).toBe(30);
  });

  it('treats 0 / null / negative / NaN as disabled (0)', () => {
    expect(new ThreadStore(TEST_DIR, { idleArchiveDays: 0 }).idleArchiveDays).toBe(0);
    expect(new ThreadStore(TEST_DIR, { idleArchiveDays: null }).idleArchiveDays).toBe(0);
    expect(new ThreadStore(TEST_DIR, { idleArchiveDays: -5 }).idleArchiveDays).toBe(0);
    expect(new ThreadStore(TEST_DIR, { idleArchiveDays: 'bogus' }).idleArchiveDays).toBe(0);
  });

  it('floors fractional inputs to integer', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 14.7 });
    expect(s.idleArchiveDays).toBe(14);
  });

  it('setIdleArchiveDays() updates live', () => {
    const s = new ThreadStore(TEST_DIR, { idleArchiveDays: 30 });
    s.setIdleArchiveDays(7);
    expect(s.idleArchiveDays).toBe(7);
    s.setIdleArchiveDays(null);
    expect(s.idleArchiveDays).toBe(0);
  });

  it('initThreadStore() forwards idleArchiveDays via opts', () => {
    const s = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 45 });
    expect(s.idleArchiveDays).toBe(45);
  });
});
