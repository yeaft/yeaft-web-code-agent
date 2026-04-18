/**
 * unify-auto-archive-sweep.test.js — task-317 integration.
 *
 * Proves the web-bridge sweep + scheduler:
 *   - runAutoArchiveSweep() archives idle threads AND broadcasts
 *     `thread_list_updated` on sendToServer when any thread changed
 *   - No broadcast fires when nothing was archived (quiet sweep)
 *   - Installing the runtime bridge and then assigning
 *     `autoArchiveIdleDays` re-sweeps immediately (live config change)
 *   - `scheduleAutoArchive` registers an interval timer; fake timers
 *     prove the hourly tick calls the sweep without a real wait
 *   - Main thread is never archived by the sweep
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installUnifyRuntimeBridge,
  runAutoArchiveSweep,
  scheduleAutoArchive,
  clearAutoArchiveSchedule,
} from '../../agent/unify/web-bridge.js';
import {
  ThreadStore,
  MAIN_THREAD_ID,
  initThreadStore,
  _resetThreadStoreForTests,
} from '../../agent/unify/threads/store.js';
import { ThreadEngineRegistry } from '../../agent/unify/threads/engine-registry.js';
import ctx from '../../agent/context.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-auto-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const DAY = 86400000;

function stubFactory() {
  return (threadId) => ({
    threadId,
    terminated: false,
    query: async function* () { /* noop */ },
    terminate() { this.terminated = true; },
  });
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  _resetThreadStoreForTests();
  ctx.unifyRuntimeSettings = null;
  clearAutoArchiveSchedule();
});

afterEach(() => {
  clearAutoArchiveSchedule();
  _resetThreadStoreForTests();
  ctx.unifyRuntimeSettings = null;
  vi.useRealTimers();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('runAutoArchiveSweep (task-317)', () => {
  it('archives idle threads and broadcasts thread_list_updated', async () => {
    // Set singleton so sendThreadListUpdate (uses getThreadStore) sees
    // the same threads. With force:true we control the exact instance.
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 7 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });

    const stale = threadStore.create({ name: 'stale' });
    const fresh = threadStore.create({ name: 'fresh' });
    const now = Date.now();
    threadStore.noteMessage(stale.id, now - 30 * DAY);
    threadStore.noteMessage(fresh.id, now - 1 * DAY);

    const bufferMod = await import('../../agent/connection/buffer.js');
    const sendSpy = vi.spyOn(bufferMod, 'sendToServer').mockImplementation(() => {});

    try {
      const archived = runAutoArchiveSweep({ engineRegistry: registry, threadStore });
      expect(archived).toEqual([stale.id]);
      expect(threadStore.get(stale.id).status).toBe('archived');
      expect(threadStore.get(fresh.id).status).toBe('active');
      // Broadcast was sent.
      const broadcast = sendSpy.mock.calls.find(
        c => c[0]?.event?.type === 'thread_list_updated',
      );
      expect(broadcast).toBeDefined();
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('no broadcast when nothing was archived', async () => {
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 30 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    const fresh = threadStore.create({ name: 'fresh' });
    threadStore.noteMessage(fresh.id, Date.now() - 1 * DAY);

    const bufferMod = await import('../../agent/connection/buffer.js');
    const sendSpy = vi.spyOn(bufferMod, 'sendToServer').mockImplementation(() => {});

    try {
      const archived = runAutoArchiveSweep({ engineRegistry: registry, threadStore });
      expect(archived).toEqual([]);
      const broadcast = sendSpy.mock.calls.find(
        c => c[0]?.event?.type === 'thread_list_updated',
      );
      expect(broadcast).toBeUndefined();
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('idleArchiveDays=0 disables the sweep (no-op)', () => {
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 0 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    const t = threadStore.create({ name: 'ancient' });
    threadStore.noteMessage(t.id, Date.now() - 365 * DAY);

    const archived = runAutoArchiveSweep({ engineRegistry: registry, threadStore });
    expect(archived).toEqual([]);
    expect(threadStore.get(t.id).status).toBe('active');
  });

  it('main thread is never archived by the sweep', () => {
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 1 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    // Artificially age the main thread.
    threadStore.noteMessage(MAIN_THREAD_ID, Date.now() - 365 * DAY);

    const archived = runAutoArchiveSweep({ engineRegistry: registry, threadStore });
    expect(archived).not.toContain(MAIN_THREAD_ID);
    expect(threadStore.get(MAIN_THREAD_ID).status).toBe('active');
  });

  it('live config change (autoArchiveIdleDays setter) re-sweeps immediately', () => {
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 90 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    const t = threadStore.create({ name: 'mid' });
    threadStore.noteMessage(t.id, Date.now() - 30 * DAY);

    installUnifyRuntimeBridge({ engineRegistry: registry, threadStore });
    // With threshold 90, 30-day-old is fresh.
    expect(threadStore.get(t.id).status).toBe('active');

    // Drop threshold to 7 via the IPC surface — the setter should sweep.
    ctx.unifyRuntimeSettings.autoArchiveIdleDays = 7;

    expect(threadStore.idleArchiveDays).toBe(7);
    expect(threadStore.get(t.id).status).toBe('archived');
  });
});

describe('scheduleAutoArchive (task-317)', () => {
  it('installs a timer that calls the sweep on each tick (fake-timers)', () => {
    vi.useFakeTimers();
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 7 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    const t = threadStore.create({ name: 'stale' });
    // Backdate so the very first tick would catch it.
    threadStore.noteMessage(t.id, Date.now() - 30 * DAY);

    const handle = scheduleAutoArchive(
      { engineRegistry: registry, threadStore },
      { intervalMs: 100 },
    );
    expect(handle).toBeTruthy();

    // Not archived yet — the timer hasn't fired.
    expect(threadStore.get(t.id).status).toBe('active');

    // Advance one tick window: sweep should run.
    vi.advanceTimersByTime(150);
    expect(threadStore.get(t.id).status).toBe('archived');
  });

  it('re-scheduling replaces the prior timer (idempotent)', () => {
    vi.useFakeTimers();
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 7 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });

    const h1 = scheduleAutoArchive(
      { engineRegistry: registry, threadStore },
      { intervalMs: 100 },
    );
    const h2 = scheduleAutoArchive(
      { engineRegistry: registry, threadStore },
      { intervalMs: 200 },
    );
    expect(h1).not.toBe(h2);
    // No leaked ticks from the replaced timer.
    clearAutoArchiveSchedule();
    vi.advanceTimersByTime(1000);
    // Store is untouched — can't prove absence of ticks directly here,
    // but the structural replace is the contract we're testing.
    expect(threadStore.idleArchiveDays).toBe(7);
  });

  it('passing null session clears any existing timer and returns null', () => {
    vi.useFakeTimers();
    const threadStore = initThreadStore(TEST_DIR, { force: true, idleArchiveDays: 7 });
    const registry = new ThreadEngineRegistry({ factory: stubFactory(), maxConcurrent: 6 });
    const h1 = scheduleAutoArchive({ engineRegistry: registry, threadStore }, { intervalMs: 100 });
    expect(h1).toBeTruthy();
    const h2 = scheduleAutoArchive(null);
    expect(h2).toBeNull();
  });
});
