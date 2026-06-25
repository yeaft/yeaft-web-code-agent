import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { DebugTrace } from '../../../agent/yeaft/debug-trace.js';

let rootDir;
let trace;

function makeTrace() {
  rootDir = join(tmpdir(), `yeaft-file-trace-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  rmSync(rootDir, { recursive: true, force: true });
  trace = new DebugTrace(rootDir);
  return trace;
}

function sessionRequestsDir(sessionId) {
  return join(rootDir, 'sessions', sessionId, 'debug', 'requests');
}

function sessionRequestDirs(sessionId) {
  const dir = sessionRequestsDir(sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
}

function readOnlyTraceFile(sessionId) {
  const dirs = sessionRequestDirs(sessionId);
  expect(dirs).toHaveLength(1);
  return JSON.parse(readFileSync(join(sessionRequestsDir(sessionId), dirs[0], 'trace.json'), 'utf8'));
}

beforeEach(() => {
  makeTrace();
});

afterEach(async () => {
  try { await trace?.close(); } catch { /* ignore */ }
  rmSync(rootDir, { recursive: true, force: true });
  trace = null;
  rootDir = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DebugTrace file retention', () => {
  it('stores session traces beside session data while returning only the newest 5 requests to the UI', async () => {
    for (let i = 0; i < 12; i++) {
      const turnId = trace.startTurn({ traceId: `request-${i}`, turnNumber: 1, sessionId: 's1', userPrompt: `prompt ${i}` });
      trace.endTurn(turnId, {
        model: 'm',
        messages: [{ role: 'user', content: `prompt ${i}` }],
        responseText: `response ${i}`,
        usage: { inputTokens: i, outputTokens: 1, totalTokens: i + 1 },
      });
    }

    await trace.close();
    expect(sessionRequestDirs('s1')).toHaveLength(10);
    const history = await trace.fetchRecentDebugHistory({ sessionId: 's1', limit: 10, dreamLimit: 0, indexOnly: true });
    expect(history.turns).toHaveLength(5);
    expect(history.limit).toBe(5);
    expect(history.turns.map(t => t.turnId)).toEqual(Array.from({ length: 5 }, (_, i) => `request-${i + 7}`));
  });

  it('bounds index fetches to 5 even when callers ask for more', async () => {
    for (let i = 0; i < 20; i++) {
      const turnId = trace.startTurn({ traceId: `bounded-${i}`, turnNumber: 1, sessionId: 's2', userPrompt: `p${i}` });
      trace.endTurn(turnId, { messages: [{ role: 'user', content: `p${i}` }], responseText: 'ok' });
    }

    const history = await trace.fetchRecentDebugHistory({ sessionId: 's2', limit: 999, dreamLimit: 0, indexOnly: true });
    expect(history.turns).toHaveLength(5);
    expect(history.limit).toBe(5);
    expect(history.turns[0].turnId).toBe('bounded-15');
    expect(history.turns[4].turnId).toBe('bounded-19');
  });

  it('buffers active loop writes until the dirty loop threshold, timer, or final close', async () => {
    vi.useFakeTimers();
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    for (let i = 1; i <= 9; i++) {
      const turnId = trace.startTurn({ traceId: 'buffered-request', turnNumber: i, sessionId: 's-buffer', userPrompt: 'buffer work' });
      trace.endTurn(turnId, {
        responseText: `loop ${i}`,
        stopReason: 'tool_use',
        messages: [{ role: 'user', content: 'buffer work' }],
      });
      now += 100;
    }

    expect(sessionRequestDirs('s-buffer')).toHaveLength(0);

    const tenth = trace.startTurn({ traceId: 'buffered-request', turnNumber: 10, sessionId: 's-buffer', userPrompt: 'buffer work' });
    trace.endTurn(tenth, {
      responseText: 'loop 10',
      stopReason: 'tool_use',
      messages: [{ role: 'user', content: 'buffer work' }],
    });
    // The 10th dirty loop crosses TRACE_FLUSH_DIRTY_LOOPS and forces a flush.
    // The write itself is async (chained); flush() awaits it landing on disk.
    await trace.flush();

    vi.advanceTimersByTime(0);
    let stored = readOnlyTraceFile('s-buffer');
    expect(stored.loops).toHaveLength(10);

    const eleventh = trace.startTurn({ traceId: 'buffered-request', turnNumber: 11, sessionId: 's-buffer', userPrompt: 'buffer work' });
    trace.endTurn(eleventh, {
      responseText: 'loop 11',
      stopReason: 'tool_use',
      messages: [{ role: 'user', content: 'buffer work' }],
    });
    // Loop 11 is buffered (below threshold, timer pending) — not yet on disk.
    stored = readOnlyTraceFile('s-buffer');
    expect(stored.loops).toHaveLength(10);

    // Let the 5s flush timer fire (advanceTimersByTimeAsync runs the timer
    // callback), then flush() to await the real fs write it kicks off — fake
    // timers don't await libuv I/O.
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await trace.flush();
    stored = readOnlyTraceFile('s-buffer');
    expect(stored.loops).toHaveLength(11);

    const twelfth = trace.startTurn({ traceId: 'buffered-request', turnNumber: 12, sessionId: 's-buffer', userPrompt: 'buffer work' });
    trace.endTurn(twelfth, {
      responseText: 'loop 12',
      stopReason: 'tool_use',
      messages: [{ role: 'user', content: 'buffer work' }],
    });
    stored = readOnlyTraceFile('s-buffer');
    expect(stored.loops).toHaveLength(11);

    await trace.close();
    stored = readOnlyTraceFile('s-buffer');
    expect(stored.loops).toHaveLength(12);
  });

  it('stores one file per request and reconstructs loop requests from base plus deltas', async () => {
    const first = trace.startTurn({ traceId: 'multi-loop', turnNumber: 1, sessionId: 's3', userPrompt: 'do work' });
    trace.endTurn(first, {
      model: 'm',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'do work' }],
      responseText: 'need tool',
      toolCalls: [{ id: 'call_1', name: 'bash', input: {} }],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    const second = trace.startTurn({ traceId: 'multi-loop', turnNumber: 2, sessionId: 's3', userPrompt: 'do work' });
    trace.endTurn(second, {
      model: 'm',
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'do work' },
        { role: 'assistant', content: 'need tool', toolCalls: [{ id: 'call_1', name: 'bash', input: {} }] },
        { role: 'tool', toolCallId: 'call_1', content: 'tool output' },
      ],
      responseText: 'done',
      usage: { inputTokens: 15, outputTokens: 1, totalTokens: 16 },
    });

    await trace.close();
    expect(sessionRequestDirs('s3')).toHaveLength(1);
    const detail = await trace.fetchRecentDebugHistory({ sessionId: 's3', detailTurnId: 'multi-loop', dreamLimit: 0 });
    expect(detail.loops).toHaveLength(2);
    expect(detail.loops[0].messages).toEqual([{ role: 'user', content: 'do work' }]);
    expect(detail.loops[1].messages).toHaveLength(3);
    expect(detail.loops[1].messages[2]).toMatchObject({ role: 'tool', content: 'tool output' });
    expect(detail.loops[1].requestDelta).toMatchObject({ messagesFrom: 1 });
  });
});
