import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
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
  try { rmSync(`${path}.files`, { recursive: true, force: true }); } catch { /* ignore */ }
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
    expect(index.turns.map(turn => turn.turnId)).toEqual(['other-request']);
    expect(index.hasMore).toBe(true);

    const fullIndex = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, sessionId: 's1', indexOnly: true });
    expect(fullIndex.turns.map(turn => turn.turnId)).toEqual(['long-request', 'other-request']);
    expect(fullIndex.turns.find(turn => turn.turnId === 'long-request')).toMatchObject({
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

  it('attaches later loops to the newest split request when a trace id is reused', () => {
    const t = openTrace();
    const oldFirst = t.startTurn({ traceId: 'reused-trace', turnNumber: 1, sessionId: 's1', userPrompt: 'old request' });
    t.endTurn(oldFirst, { responseText: 'old loop 1', messages: [{ role: 'user', content: 'old request' }] });

    const newFirst = t.startTurn({ traceId: 'reused-trace', turnNumber: 1, sessionId: 's1', userPrompt: 'new request' });
    t.endTurn(newFirst, { responseText: 'new loop 1', messages: [{ role: 'user', content: 'new request' }] });
    const newSecond = t.startTurn({ traceId: 'reused-trace', turnNumber: 2, sessionId: 's1', userPrompt: 'new request' });
    t.endTurn(newSecond, {
      responseText: 'new loop 2',
      messages: [
        { role: 'user', content: 'new request' },
        { role: 'assistant', content: 'new loop 1' },
      ],
    });

    const index = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, sessionId: 's1', indexOnly: true });
    const oldTurn = index.turns.find(turn => turn.userPrompt === 'old request');
    const newTurn = index.turns.find(turn => turn.userPrompt === 'new request');
    expect(oldTurn).toMatchObject({ loopCount: 1 });
    expect(newTurn).toMatchObject({ loopCount: 2 });

    const newDetail = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, sessionId: 's1', detailTurnId: newTurn.turnId });
    expect(newDetail.loops.map(loop => loop.response)).toEqual(['new loop 1', 'new loop 2']);
  });

  it('searches recent debug history with a regex across sessions', () => {
    const t = openTrace();
    const alpha = t.startTurn({ traceId: 'alpha-request', turnNumber: 1, sessionId: 's1', vpId: 'linus', userPrompt: 'fix debug panel' });
    t.endTurn(alpha, {
      responseText: 'done',
      messages: [{ role: 'user', content: 'fix debug panel' }],
      toolCalls: [{ name: 'Bash', input: { command: 'npm test' } }],
    });
    const beta = t.startTurn({ traceId: 'beta-request', turnNumber: 1, sessionId: 's2', vpId: 'martin', userPrompt: 'review release flow' });
    t.endTurn(beta, {
      responseText: 'approved',
      messages: [{ role: 'user', content: 'review release flow' }],
      rawRequest: { url: 'https://llm.example/v1/responses', body: { model: 'm' } },
    });

    const global = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, indexOnly: true, search: 'release\\s+flow' });
    expect(global.turns).toHaveLength(1);
    expect(global.turns[0]).toMatchObject({ turnId: 'beta-request', sessionId: 's2' });

    const slashForm = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, indexOnly: true, search: '/debug panel/i' });
    expect(slashForm.turns).toHaveLength(1);
    expect(slashForm.turns[0]).toMatchObject({ turnId: 'alpha-request', sessionId: 's1' });
  });

  it('reports invalid debug history regexes instead of silently falling back', () => {
    const t = openTrace();
    const row = t.startTurn({ traceId: 'bad-regex-check', turnNumber: 1, sessionId: 's1', userPrompt: 'work' });
    t.endTurn(row, { responseText: 'done' });

    expect(() => t.fetchRecentDebugHistory({ search: '[' })).toThrow(/Invalid regular expression/);
    expect(() => t.fetchRecentDebugHistory({ search: '/x/q' })).toThrow(/Invalid debug search regex flag: q/);
    expect(() => t.fetchRecentDebugHistory({ search: '(a+)+$' })).toThrow(/unsafe quantified group/);
    expect(() => t.fetchRecentDebugHistory({ search: '(a|aa)+$' })).toThrow(/unsafe quantified group/);
  });

  it('does not run regex search against full raw request JSON', () => {
    const t = openTrace();
    const row = t.startTurn({ traceId: 'raw-only-request', turnNumber: 1, sessionId: 's1', userPrompt: 'ordinary prompt' });
    t.endTurn(row, {
      responseText: 'done',
      rawRequest: {
        url: 'https://llm.example/v1/responses',
        body: { messages: [{ role: 'user', content: 'needle-only-in-raw-request' }] },
      },
    });

    const byRawPayload = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, indexOnly: true, search: 'needle-only-in-raw-request' });
    expect(byRawPayload.turns).toHaveLength(0);

    const bySummary = t.fetchRecentDebugHistory({ limit: 10, dreamLimit: 0, indexOnly: true, search: 'ordinary prompt' });
    expect(bySummary.turns).toHaveLength(1);
    expect(bySummary.turns[0]).toMatchObject({ turnId: 'raw-only-request' });
  });

  it('stores cumulative rawRequest as base plus structural message deltas instead of repeating full requests', () => {
    const t = openTrace();
    const messages = [];
    for (let i = 1; i <= 20; i++) {
      messages.push({ role: 'user', content: `message ${i} ${'x'.repeat(200)}` });
      const row = t.startTurn({ traceId: 'raw-delta-request', turnNumber: i, sessionId: 's1', userPrompt: 'raw delta' });
      t.endTurn(row, {
        responseText: `loop ${i}`,
        stopReason: i === 20 ? 'end_turn' : 'tool_use',
        messages: messages.map(m => ({ ...m })),
        rawRequest: {
          url: 'https://llm.example/v1/messages',
          method: 'POST',
          headers: { authorization: '***' },
          body: {
            model: 'm',
            max_tokens: 1000,
            messages: messages.map(m => ({ ...m })),
          },
        },
      });
    }
    t.close();

    const requestsDir = join(`${dbPath}.files`, 'sessions', 's1', 'debug', 'requests');
    const requestDirs = readdirSync(requestsDir);
    const traceJson = JSON.parse(readFileSync(join(requestsDir, requestDirs[0], 'trace.json'), 'utf8'));
    expect(traceJson.baseRequest.rawRequest.body.messages).toHaveLength(1);
    expect(traceJson.loops[1].requestDelta.rawRequestDelta.body).toMatchObject({ messagesFrom: 1 });
    expect(traceJson.loops[19].requestDelta.rawRequestDelta.body).toMatchObject({ messagesFrom: 19 });
    expect(JSON.stringify(traceJson.loops[19].requestDelta)).not.toContain('message 1');
    expect(readFileSync(join(requestsDir, requestDirs[0], 'trace.json'), 'utf8').length).toBeLessThan(50_000);
  });
});
