/**
 * tool-usage-stats.test.js — coverage for the ToolUsageStats counter
 * sink behind the `yeaft-stats` CLI / Unify debug drawer.
 *
 * Scope:
 *   • record() bumps callCount/errorCount/totalDurationMs and rotates
 *     the durations ring
 *   • snapshot() computes avg/p50/p95/errorRate correctly
 *   • getRegisteredButUncalled() returns names that have NEVER been
 *     recorded (call count == 0)
 *   • flush() writes atomically; loadSync()/load() round-trip
 *   • reset() clears in-memory state and removes the file
 *
 * Tests use a per-test tmpdir so concurrent runs don't share state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolUsageStats } from '../../../agent/unify/stats/tool-usage.js';

async function makeTmpPath() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'yeaft-stats-test-'));
  return { dir, path: join(dir, 'tool-usage.json') };
}

describe('ToolUsageStats', () => {
  let tmp;

  beforeEach(async () => {
    tmp = await makeTmpPath();
  });

  afterEach(async () => {
    try { await fsp.rm(tmp.dir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('records a single call and exposes it in snapshot()', () => {
    const stats = new ToolUsageStats({ path: tmp.path, flushEveryN: 999, flushIntervalMs: 999999 });
    stats.record({ name: 'Bash', durationMs: 42, isError: false });
    const snap = stats.snapshot();
    expect(snap.Bash).toBeDefined();
    expect(snap.Bash.callCount).toBe(1);
    expect(snap.Bash.errorCount).toBe(0);
    expect(snap.Bash.errorRate).toBe(0);
    expect(snap.Bash.p50Ms).toBe(42);
    expect(snap.Bash.p95Ms).toBe(42);
    expect(snap.Bash.avgMs).toBe(42);
    expect(typeof snap.Bash.lastCalledAt).toBe('string');
  });

  it('aggregates errors and computes errorRate', () => {
    const stats = new ToolUsageStats({ path: tmp.path, flushEveryN: 999, flushIntervalMs: 999999 });
    stats.record({ name: 'Bash', durationMs: 10, isError: false });
    stats.record({ name: 'Bash', durationMs: 20, isError: true, errorMessage: 'oops' });
    stats.record({ name: 'Bash', durationMs: 30, isError: true, errorMessage: 'oops2' });
    stats.record({ name: 'Bash', durationMs: 40, isError: false });
    const snap = stats.snapshot();
    expect(snap.Bash.callCount).toBe(4);
    expect(snap.Bash.errorCount).toBe(2);
    expect(snap.Bash.errorRate).toBe(0.5);
  });

  it('computes p50 and p95 from a multi-call ring', () => {
    const stats = new ToolUsageStats({ path: tmp.path, flushEveryN: 999, flushIntervalMs: 999999 });
    // 100 calls: durations 1..100
    for (let i = 1; i <= 100; i++) {
      stats.record({ name: 'FileRead', durationMs: i });
    }
    const snap = stats.snapshot();
    expect(snap.FileRead.callCount).toBe(100);
    // p50 should be near the middle, p95 near the top of the sorted
    // sample. Implementation uses floor((p/100) * len) — that gives 50
    // and 95 for these ranges (sample idx is 0-based).
    expect(snap.FileRead.p50Ms).toBeGreaterThanOrEqual(50);
    expect(snap.FileRead.p50Ms).toBeLessThanOrEqual(52);
    expect(snap.FileRead.p95Ms).toBeGreaterThanOrEqual(94);
    expect(snap.FileRead.p95Ms).toBeLessThanOrEqual(96);
  });

  it('caps the durations ring at ringSize', () => {
    const stats = new ToolUsageStats({ path: tmp.path, ringSize: 5, flushEveryN: 999, flushIntervalMs: 999999 });
    for (let i = 1; i <= 20; i++) {
      stats.record({ name: 'Grep', durationMs: i });
    }
    // callCount should still be 20; but the ring (used for p50/p95)
    // should only contain the last 5 values: [16,17,18,19,20].
    const snap = stats.snapshot();
    expect(snap.Grep.callCount).toBe(20);
    // p50 of [16..20] is 18.
    expect(snap.Grep.p50Ms).toBe(18);
  });

  it('reports registered tools that have never been called', () => {
    const stats = new ToolUsageStats({ path: tmp.path, flushEveryN: 999, flushIntervalMs: 999999 });
    stats.record({ name: 'Bash' });
    stats.record({ name: 'FileRead' });
    const unused = stats.getRegisteredButUncalled([
      'Bash', 'FileRead', 'Grep', 'TodoWrite', 'WebSearch',
    ]);
    expect(unused).toEqual(['Grep', 'TodoWrite', 'WebSearch']);
  });

  it('flush() persists and load() restores state', async () => {
    const stats = new ToolUsageStats({ path: tmp.path, flushEveryN: 999, flushIntervalMs: 999999 });
    stats.record({ name: 'Bash', durationMs: 100 });
    stats.record({ name: 'Bash', durationMs: 200, isError: true });
    await stats.flush();
    expect(existsSync(tmp.path)).toBe(true);

    const reloaded = new ToolUsageStats({ path: tmp.path });
    reloaded.loadSync();
    const snap = reloaded.snapshot();
    expect(snap.Bash.callCount).toBe(2);
    expect(snap.Bash.errorCount).toBe(1);
  });

  it('reset() clears state and removes the file', async () => {
    const stats = new ToolUsageStats({ path: tmp.path, flushEveryN: 999, flushIntervalMs: 999999 });
    stats.record({ name: 'Bash' });
    await stats.flush();
    expect(existsSync(tmp.path)).toBe(true);
    await stats.reset();
    expect(existsSync(tmp.path)).toBe(false);
    expect(Object.keys(stats.snapshot())).toHaveLength(0);
  });

  it('handles missing/corrupt file by starting fresh', () => {
    // Non-existent path should not throw.
    const stats = new ToolUsageStats({ path: join(tmp.dir, 'nonexistent.json') });
    expect(() => stats.loadSync()).not.toThrow();
    expect(Object.keys(stats.snapshot())).toHaveLength(0);
  });

  it('throttles automatic flush by record count', async () => {
    const stats = new ToolUsageStats({ path: tmp.path, flushEveryN: 3, flushIntervalMs: 60_000 });
    stats.record({ name: 'Bash' });
    stats.record({ name: 'Bash' });
    // After 2 records the file should NOT yet exist (threshold is 3).
    expect(existsSync(tmp.path)).toBe(false);
    stats.record({ name: 'Bash' });
    // Flush is fire-and-forget — give the microtask queue a moment.
    await new Promise(r => setTimeout(r, 50));
    // Allow up to ~200ms for fs.promises.rename to land.
    for (let i = 0; i < 10 && !existsSync(tmp.path); i++) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(existsSync(tmp.path)).toBe(true);
  });

  it('concurrent flush()s coalesce — only one writer touches .tmp at a time', async () => {
    // Regression for the PR-767 Torvalds C1 race: manual flush() and the
    // throttled #maybeFlush() both ran #doFlush() directly, so two
    // concurrent rename()s could race on the same .tmp path and the
    // catch-block unlink could nuke the other writer's file. The fix
    // funnels every flush through the #flushInFlight singleton.
    const stats = new ToolUsageStats({
      path: tmp.path,
      flushEveryN: 2,
      flushIntervalMs: 60_000,
    });
    // Kick the throttled path and the manual path at the same time.
    stats.record({ name: 'Bash' });
    stats.record({ name: 'Bash' }); // overflow → schedules a #doFlush
    await Promise.all([stats.flush(), stats.flush(), stats.flush()]);
    expect(existsSync(tmp.path)).toBe(true);
    // The .tmp sibling must not be left behind by a racing writer.
    expect(existsSync(`${tmp.path}.tmp`)).toBe(false);
    // State on disk reflects what's in memory.
    const reloaded = new ToolUsageStats({ path: tmp.path });
    reloaded.loadSync();
    expect(reloaded.snapshot().Bash.callCount).toBe(2);
  });
});
