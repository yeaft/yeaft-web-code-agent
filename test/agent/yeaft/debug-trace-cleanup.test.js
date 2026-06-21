import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'fs';
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

function sessionRequestDirs(sessionId) {
  const dir = join(rootDir, 'sessions', sessionId, 'debug', 'requests');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
}

beforeEach(() => {
  makeTrace();
});

afterEach(() => {
  try { trace?.close(); } catch { /* ignore */ }
  rmSync(rootDir, { recursive: true, force: true });
  trace = null;
  rootDir = null;
});

describe('DebugTrace file retention', () => {
  it('stores session traces beside session data and keeps only the newest 10 requests', () => {
    for (let i = 0; i < 12; i++) {
      const turnId = trace.startTurn({ traceId: `request-${i}`, turnNumber: 1, sessionId: 's1', userPrompt: `prompt ${i}` });
      trace.endTurn(turnId, {
        model: 'm',
        messages: [{ role: 'user', content: `prompt ${i}` }],
        responseText: `response ${i}`,
        usage: { inputTokens: i, outputTokens: 1, totalTokens: i + 1 },
      });
    }

    trace.close();
    expect(sessionRequestDirs('s1')).toHaveLength(10);
    const history = trace.fetchRecentDebugHistory({ sessionId: 's1', limit: 10, dreamLimit: 0, indexOnly: true });
    expect(history.turns).toHaveLength(10);
    expect(history.turns.map(t => t.turnId)).toEqual(Array.from({ length: 10 }, (_, i) => `request-${i + 2}`));
  });

  it('bounds index fetches to 10 even when callers ask for more', () => {
    for (let i = 0; i < 20; i++) {
      const turnId = trace.startTurn({ traceId: `bounded-${i}`, turnNumber: 1, sessionId: 's2', userPrompt: `p${i}` });
      trace.endTurn(turnId, { messages: [{ role: 'user', content: `p${i}` }], responseText: 'ok' });
    }

    const history = trace.fetchRecentDebugHistory({ sessionId: 's2', limit: 999, dreamLimit: 0, indexOnly: true });
    expect(history.turns).toHaveLength(10);
    expect(history.limit).toBe(10);
    expect(history.turns[0].turnId).toBe('bounded-10');
    expect(history.turns[9].turnId).toBe('bounded-19');
  });

  it('stores one file per request and reconstructs loop requests from base plus deltas', () => {
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

    trace.close();
    expect(sessionRequestDirs('s3')).toHaveLength(1);
    const detail = trace.fetchRecentDebugHistory({ sessionId: 's3', detailTurnId: 'multi-loop', dreamLimit: 0 });
    expect(detail.loops).toHaveLength(2);
    expect(detail.loops[0].messages).toEqual([{ role: 'user', content: 'do work' }]);
    expect(detail.loops[1].messages).toHaveLength(3);
    expect(detail.loops[1].messages[2]).toMatchObject({ role: 'tool', content: 'tool output' });
    expect(detail.loops[1].requestDelta).toMatchObject({ messagesFrom: 1 });
  });
});
