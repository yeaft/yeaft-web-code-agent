import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolUsageStats } from '../../../agent/yeaft/stats/tool-usage.js';

let dir, path;
const createStats = (options = {}) => new ToolUsageStats({
  path, flushEveryN: Infinity, flushIntervalMs: Infinity, ...options,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-tool-stats-'));
  path = join(dir, 'tool-usage.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('ToolUsageStats recent outcomes', () => {
  it('evicts old outcomes and reasons at 100 without changing lifetime/latency/unused contracts', async () => {
    const stats = createStats({ ringSize: 2 });
    stats.record({ name: 'GitRead', durationMs: 10, isError: true, errorMessage: '{"code":"git_timeout"}' });
    for (let i = 0; i < 100; i++) stats.record({ name: 'GitRead', durationMs: 20 });
    const snap = stats.snapshot().GitRead;
    expect(snap).toMatchObject({ callCount: 101, errorCount: 1, errorRate: 1 / 101, avgMs: 20, p50Ms: 20, p95Ms: 20 });
    expect(snap.recent).toEqual({ windowSize: 100, callCount: 100, errorCount: 0, errorRate: 0, errorReasons: {} });
    expect(stats.getRegisteredButUncalled(['GitRead', 'Unused'])).toEqual(['Unused']);
    await stats.flush();
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    expect(disk.schema).toBe(1);
    expect(disk.tools.GitRead.recentOutcomes).toHaveLength(100);
    expect(disk.tools.GitRead.durations).toEqual([20, 20]);
    const restored = createStats();
    await restored.load();
    expect(restored.snapshot()).toEqual(stats.snapshot());
  });

  it('keeps sync/async legacy history but reports unknown recent rate until new samples arrive', async () => {
    const legacy = { callCount: 1000, errorCount: 392, totalDurationMs: 5000, durations: [4, 6], lastCalledAt: '2026-01-01T00:00:00Z', lastError: 'historical failure' };
    writeFileSync(path, JSON.stringify({ schema: 1, tools: { GitRead: legacy } }));
    const sync = createStats();
    sync.loadSync();
    const async = createStats();
    await async.load();
    expect(sync.snapshot()).toEqual(async.snapshot());
    expect(sync.snapshot().GitRead).toMatchObject({ callCount: 1000, errorCount: 392, errorRate: 0.392, lastError: 'historical failure', recent: { callCount: 0, errorCount: 0, errorRate: null, errorReasons: {} } });
    sync.record({ name: 'GitRead', isError: false, errorMessage: 'not counted', errorCode: 'git_timeout' });
    expect(sync.snapshot().GitRead).toMatchObject({ callCount: 1001, errorCount: 392, recent: { callCount: 1, errorCount: 0, errorRate: 0 } });
    await sync.flush();
    const reload = createStats();
    reload.loadSync();
    expect(reload.snapshot()).toEqual(sync.snapshot());
  });

  it('uses safe codes from complete/truncated JSON and bounded categories without suppressing errors', () => {
    const stats = createStats();
    const errors = [
      '{"error":"bad args","code":"invalid_arguments"}',
      '{"error":"bad args","code":"git_output_limit","output":"truncated',
      '{"error":{"code":"git_timeout"}}',
      '{"code":"secret_customer_token","error":"private /home/name"}',
      'Worktree "private-project" already exists at /private/path',
      'fetch failed: ECONNRESET https://private.example/token',
      'HTTP error 429 at https://private.example',
      'permission denied /private/file',
      'ENOENT /private/file',
      'request timed out',
      'cancelled by user',
      'HTTP 503',
      null,
    ];
    for (const errorMessage of errors) stats.record({ name: 'Tool', isError: true, errorMessage });
    stats.record({ name: 'Tool', isError: true, errorCode: 'git_failed', errorMessage: '{"code":"git_timeout"}' });
    const rec = stats.snapshot().Tool;
    expect(rec.errorCount).toBe(14);
    expect(rec.recent).toMatchObject({ callCount: 14, errorCount: 14, errorRate: 1 });
    expect(rec.recent.errorReasons).toEqual({ invalid_arguments: 1, git_output_limit: 1, git_timeout: 1, other: 2, conflict: 1, network: 1, rate_limit: 1, permission: 1, not_found: 1, timeout: 1, cancelled: 1, http_error: 1, git_failed: 1 });
    expect(JSON.stringify(rec.recent)).not.toMatch(/private|secret_customer_token/);
    for (let i = 0; i < 300; i++) stats.record({ name: 'Tool', isError: true, errorMessage: JSON.stringify({ code: `sensitive_${i}` }) });
    expect(stats.snapshot().Tool.recent.errorReasons).toEqual({ other: 100 });
    expect(rec.recent.errorCount).toBe(14); // snapshot is detached
  });

  it('bounds loaded outcomes and sanitizes unrecognized reason keys on both readers', async () => {
    writeFileSync(path, JSON.stringify({ schema: 1, tools: { Tool: { callCount: 150, errorCount: 150, recentOutcomes: ['git_timeout', ...Array(120).fill('/private/path')] } } }));
    const stats = createStats();
    stats.loadSync();
    expect(stats.snapshot().Tool.recent).toEqual({ windowSize: 100, callCount: 100, errorCount: 100, errorRate: 1, errorReasons: { other: 100 } });
    const async = createStats();
    await async.load();
    expect(async.snapshot()).toEqual(stats.snapshot());
  });

  it('includes outcomes arriving during a throttled write in the explicit flush without racing tmp writers', async () => {
    const writeFile = fsp.writeFile.bind(fsp);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let writes = 0, active = 0, maxActive = 0;
    vi.spyOn(fsp, 'writeFile').mockImplementation(async (...args) => {
      active++;
      maxActive = Math.max(active, maxActive);
      if (++writes === 1) { entered(); await held; }
      try { return await writeFile(...args); } finally { active--; }
    });
    const stats = createStats({ flushEveryN: 1 });
    stats.record({ name: 'Tool', isError: true, errorCode: 'git_failed' });
    await started;
    stats.record({ name: 'Tool' });
    const done = stats.flush();
    release();
    await done;
    expect(maxActive).toBe(1);
    expect(writes).toBe(2);
    const reloaded = createStats();
    reloaded.loadSync();
    expect(reloaded.snapshot()).toEqual(stats.snapshot());
    expect(reloaded.snapshot().Tool.recent).toMatchObject({ callCount: 2, errorCount: 1, errorRate: 0.5 });
  });
});
