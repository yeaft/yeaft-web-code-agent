/**
 * debug-trace-async-perf.test.js — performance + async contract for the
 * file-backed DebugTrace.
 *
 * Root cause this guards against: opening the Yeaft debug panel while several
 * Sessions are active used to re-scan + JSON.parse EVERY session's trace files
 * on EVERY query (and again, twice, inside every flush's prune). That O(N^2)
 * synchronous file I/O blocked the agent's single event loop long enough to
 * miss WebSocket heartbeats (server 30s / agent 45s), dropping the agent.
 *
 * The contract:
 *   1. A cold DebugTrace hydrates a lightweight in-memory summary index from
 *      disk exactly ONCE. Subsequent index queries are served purely from
 *      memory — zero additional file reads. No N-squared rescans.
 *   2. Disk reads go through `fs.promises` (async) so they yield the event
 *      loop instead of blocking it.
 *   3. `close()` resolves only after pending writes are flushed; the trace is
 *      then durably round-trippable by a fresh reader instance.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { DebugTrace } from '../../../agent/yeaft/debug-trace.js';

let root = null;

function freshRoot() {
  root = join(tmpdir(), `yeaft-trace-perf-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  rmSync(root, { recursive: true, force: true });
  return root;
}

function seed(trace, sessions, perSession) {
  for (const s of sessions) {
    for (let i = 0; i < perSession; i++) {
      const id = trace.startTurn({ traceId: `${s}-req-${i}`, turnNumber: 1, sessionId: s, userPrompt: `prompt ${s} ${i}` });
      trace.endTurn(id, {
        model: 'm',
        responseText: `response ${i}`,
        messages: [{ role: 'user', content: `prompt ${s} ${i}` }],
        usage: { inputTokens: i, outputTokens: 1, totalTokens: i + 1 },
      });
    }
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  vi.restoreAllMocks();
});

describe('DebugTrace async + in-memory index performance', () => {
  it('hydrates from disk once, then serves repeated index queries with zero disk reads', async () => {
    freshRoot();
    const sessions = ['s1', 's2', 's3', 's4'];
    const perSession = 8;

    const writer = new DebugTrace(root);
    seed(writer, sessions, perSession);
    await writer.close();

    // Fresh, cold instance: in-memory index is empty until first hydrate.
    const reader = new DebugTrace(root);
    const readSpy = vi.spyOn(fsp, 'readFile');

    const first = await reader.fetchRecentDebugHistory({ indexOnly: true, limit: 5, dreamLimit: 0 });
    expect(Array.isArray(first.turns)).toBe(true);

    // Cold hydrate must actually read the on-disk trace files (async fs).
    const hydrateReads = readSpy.mock.calls.length;
    expect(hydrateReads).toBeGreaterThanOrEqual(sessions.length);

    // The smoking gun: repeated index queries (panel re-hydrate, multi-session
    // filters) must NOT re-scan disk. Pre-fix this was ~N files per call.
    readSpy.mockClear();
    for (let i = 0; i < 10; i++) {
      await reader.fetchRecentDebugHistory({ indexOnly: true, limit: 5, dreamLimit: 0 });
      await reader.fetchRecentDebugHistory({ sessionId: 's2', indexOnly: true, limit: 5, dreamLimit: 0 });
    }
    expect(readSpy.mock.calls.length).toBe(0);
  });

  it('keeps per-session index isolation after hydrate', async () => {
    freshRoot();
    const writer = new DebugTrace(root);
    seed(writer, ['a', 'b'], 3);
    await writer.close();

    const reader = new DebugTrace(root);
    const a = await reader.fetchRecentDebugHistory({ sessionId: 'a', indexOnly: true, limit: 5, dreamLimit: 0 });
    const b = await reader.fetchRecentDebugHistory({ sessionId: 'b', indexOnly: true, limit: 5, dreamLimit: 0 });

    expect(a.turns).toHaveLength(3);
    expect(a.turns.every(t => t.sessionId === 'a')).toBe(true);
    expect(b.turns.every(t => t.sessionId === 'b')).toBe(true);
  });

  it('persists trace files after close() resolves and round-trips via a fresh reader', async () => {
    freshRoot();
    const writer = new DebugTrace(root);
    const id = writer.startTurn({ traceId: 'persist-1', turnNumber: 1, sessionId: 's1', userPrompt: 'hi' });
    writer.endTurn(id, { responseText: 'ok', messages: [{ role: 'user', content: 'hi' }] });
    await writer.close();

    expect(existsSync(join(root, 'sessions', 's1', 'debug', 'requests'))).toBe(true);

    const reader = new DebugTrace(root);
    const detail = await reader.fetchRecentDebugHistory({ sessionId: 's1', detailTurnId: 'persist-1', dreamLimit: 0 });
    expect(detail.turns).toHaveLength(1);
    expect(detail.loops).toHaveLength(1);
  });

  it('does not destroy prior-run dream events when an event flush beats first hydrate', async () => {
    freshRoot();
    // Run 1: persist some dream events to disk.
    const first = new DebugTrace(root);
    first.event('dream_progress', { sessionId: 's1', phase: 'start', n: 1 });
    first.event('dream_progress', { sessionId: 's1', phase: 'done', n: 2 });
    await first.close();

    // Run 2 (fresh instance, cold): a new event fires and its flush lands
    // BEFORE any read triggers #ensureHydrated. Pre-fix the all-or-nothing
    // hydrate skipped disk (ring non-empty) and the flush overwrote history.
    const second = new DebugTrace(root);
    second.event('dream_progress', { sessionId: 's1', phase: 'start', n: 3 });
    await second.flush(); // force the event flush through before any query

    const history = await second.fetchRecentDebugHistory({ sessionId: 's1', dreamLimit: 50, limit: 5 });
    const ns = history.dreamEvents.map(e => e.n).sort((a, b) => a - b);
    // All three survive: the two prior-run events were merged, not clobbered.
    expect(ns).toEqual([1, 2, 3]);

    // And the merge is durable on disk for a third reader.
    await second.close();
    const third = new DebugTrace(root);
    const after = await third.fetchRecentDebugHistory({ sessionId: 's1', dreamLimit: 50, limit: 5 });
    expect(after.dreamEvents.map(e => e.n).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
