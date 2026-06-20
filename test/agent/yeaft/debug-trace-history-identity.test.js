import { describe, expect, it, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DebugTrace } from '../../../agent/yeaft/debug-trace.js';

let trace;
let dbPath;

function cleanup(path) {
  if (!path) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${path}${suffix}`, { force: true }); } catch { /* ignore */ }
  }
}

function openTrace() {
  dbPath = join(tmpdir(), `yeaft-debug-history-identity-${process.pid}-${Date.now()}-${Math.random()}.db`);
  cleanup(dbPath);
  trace = new DebugTrace(dbPath);
  return trace;
}

afterEach(() => {
  try { trace?.close(); } catch { /* ignore */ }
  trace = null;
  cleanup(dbPath);
  dbPath = null;
});

describe('DebugTrace.fetchRecentDebugHistory identity', () => {
  it('keeps healthy multi-loop turns grouped by trace id', () => {
    const t = openTrace();
    const first = t.startTurn({ traceId: 'query-1', turnNumber: 1, sessionId: 's1', userPrompt: 'do work' });
    t.endTurn(first, { responseText: 'tool please', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    const second = t.startTurn({ traceId: 'query-1', turnNumber: 2, sessionId: 's1', userPrompt: 'do work' });
    t.endTurn(second, { responseText: 'done', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } });

    const history = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, sessionId: 's1' });

    expect(history.turns).toHaveLength(1);
    expect(history.turns[0].turnId).toBe('query-1');
    expect(history.turns[0].loopCount).toBe(2);
    expect(history.loops.map((loop) => loop.turnId)).toEqual(['query-1', 'query-1']);
    expect(history.loops.map((loop) => loop.loopNumber)).toEqual([1, 2]);
  });

  it('index-only history lists requests without shipping loop detail, and detail fetch returns every loop', () => {
    const t = openTrace();
    for (let i = 1; i <= 60; i++) {
      const row = t.startTurn({ traceId: 'long-request', turnNumber: i, sessionId: 's1', userPrompt: 'long work' });
      t.endTurn(row, { responseText: `loop ${i}`, usage: { inputTokens: i, outputTokens: 1, totalTokens: i + 1 } });
    }
    const other = t.startTurn({ traceId: 'other-request', turnNumber: 1, sessionId: 's1', userPrompt: 'other work' });
    t.endTurn(other, { responseText: 'other', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });

    const index = t.fetchRecentDebugHistory({ limit: 1, dreamLimit: 0, sessionId: 's1', indexOnly: true });
    expect(index.loops).toHaveLength(0);
    expect(index.turns.map(turn => turn.turnId)).toEqual(['long-request', 'other-request']);
    expect(index.turns.find(turn => turn.turnId === 'long-request')).toMatchObject({
      loopCount: 60,
      detailsLoaded: false,
      userPrompt: 'long work',
    });

    const detail = t.fetchRecentDebugHistory({ limit: 1, dreamLimit: 0, sessionId: 's1', detailTurnId: 'long-request' });
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]).toMatchObject({ turnId: 'long-request', loopCount: 60, detailsLoaded: true });
    expect(detail.loops).toHaveLength(60);
    expect(detail.loops.map(loop => loop.loopNumber)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('splits legacy duplicate Loop 1 rows so separate requests do not share stale assistant text', () => {
    const t = openTrace();
    const first = t.startTurn({ traceId: 'engine-instance-legacy', turnNumber: 1, sessionId: 's1', userPrompt: 'old request' });
    t.logTool(first, { toolName: 'old-tool', toolCallId: 'old-call', toolOutput: 'old tool output', durationMs: 12 });
    t.endTurn(first, { responseText: 'old assistant text', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } });
    const second = t.startTurn({ traceId: 'engine-instance-legacy', turnNumber: 1, sessionId: 's1', userPrompt: 'new request' });
    t.logTool(second, { toolName: 'new-tool', toolCallId: 'new-call', toolOutput: 'new tool output', durationMs: 34 });
    t.endTurn(second, { responseText: 'new assistant text', usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 } });

    const history = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, sessionId: 's1' });

    expect(history.turns).toHaveLength(2);
    expect(new Set(history.turns.map((turn) => turn.turnId)).size).toBe(2);
    expect(history.turns.map((turn) => turn.userPrompt).sort()).toEqual(['new request', 'old request']);
    expect(history.loops).toHaveLength(2);
    expect(history.loops.map((loop) => loop.response).sort()).toEqual(['new assistant text', 'old assistant text']);
    expect(history.loops[0].turnId).not.toBe(history.loops[1].turnId);
    expect(history.loops[0].loopInstanceId).toBeTruthy();
    expect(history.loops[1].loopInstanceId).toBeTruthy();
    const responseByTurnId = new Map(history.loops.map((loop) => [loop.turnId, loop.response]));
    for (const turn of history.turns) {
      const response = responseByTurnId.get(turn.turnId);
      const expectedPrefix = turn.userPrompt === 'old request' ? 'old' : 'new';
      expect(response).toContain(expectedPrefix);
      expect(turn.tools).toHaveLength(1);
      expect(turn.tools[0].name).toBe(`${expectedPrefix}-tool`);
      expect(turn.tools[0].toolOutput).toBe(`${expectedPrefix} tool output`);
    }

    const index = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, sessionId: 's1', indexOnly: true });
    for (const indexedTurn of index.turns) {
      const detail = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, sessionId: 's1', detailTurnId: indexedTurn.turnId });
      expect(detail.turns).toHaveLength(1);
      expect(detail.turns[0].turnId).toBe(indexedTurn.turnId);
      expect(detail.turns[0].userPrompt).toBe(indexedTurn.userPrompt);
      expect(detail.loops).toHaveLength(1);
    }
  });
});
