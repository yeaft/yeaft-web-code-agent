import { afterEach, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { __testHandleEngineEvent } from '../../../agent/yeaft/web-bridge.js';

const original = { ws: ctx.ws, queue: ctx.outboundSendQueue, active: ctx.outboundSendQueueActive, encryption: ctx.serverEncryptionRequired };
afterEach(() => {
  ctx.ws = original.ws;
  ctx.outboundSendQueue = original.queue;
  ctx.outboundSendQueueActive = original.active;
  ctx.serverEncryptionRequired = original.encryption;
  vi.useRealTimers();
});

it('forwards only scoped progress metadata without touching timers, text batching or history', () => {
  vi.useFakeTimers();
  ctx.ws = { readyState: 1, send() {} };
  ctx.serverEncryptionRequired = false;
  ctx.outboundSendQueue = [];
  ctx.outboundSendQueueActive = true;
  const hctx = {
    sessionId: 's', vpId: 'v', turnId: 't', threadId: 'main',
    assistantTextParts: [], toolCallsAccum: [], toolResultsAccum: [],
    resetQueryTimer: vi.fn(), pauseQueryTimer: vi.fn(), touchQueryTimer: vi.fn(), stopQueryTimer: vi.fn(),
  };
  __testHandleEngineEvent({ type: 'text_delta', text: 'first' }, hctx);
  __testHandleEngineEvent({ type: 'text_delta', text: 'pending' }, hctx);
  const pendingTimer = hctx.streamTextBatch.timer;
  hctx.resetQueryTimer.mockClear();
  ctx.outboundSendQueue = [];
  const progress = { type: 'query_progress', sessionId: 's', vpId: 'v', turnId: 't', threadId: 'main',
    revision: 1, modelRequests: 2, toolExecutions: 3, reusedCalls: 1, repeatedCalls: 1, failedCalls: 0,
    stage: 'warning', reason: 'repeated_results', lastEvidenceAt: 100, stagnantBatches: 2 };
  __testHandleEngineEvent({ ...progress, text: 'PRIVATE', input: { password: 'PRIVATE' } }, hctx);
  expect(ctx.outboundSendQueue.map(row => row.msg)).toEqual([expect.objectContaining({ type: 'yeaft_output', event: progress })]);
  expect(hctx.streamTextBatch.parts).toEqual(['pending']);
  expect(hctx.streamTextBatch.timer).toBe(pendingTimer);
  expect(hctx.assistantTextParts).toEqual(['first', 'pending']);
  expect(hctx.toolCallsAccum).toEqual([]);
  for (const timer of ['resetQueryTimer', 'pauseQueryTimer', 'touchQueryTimer', 'stopQueryTimer']) expect(hctx[timer]).not.toHaveBeenCalled();
  expect(JSON.stringify(ctx.outboundSendQueue)).not.toContain('PRIVATE');
  for (const invalid of [{ sessionId: 'other' }, { revision: 0 }, { revision: 2, stage: 'secret' }, { revision: 2, reason: 'raw error' }]) {
    __testHandleEngineEvent({ ...progress, ...invalid }, hctx);
  }
  expect(ctx.outboundSendQueue).toHaveLength(1);
  vi.advanceTimersByTime(200);
  expect(ctx.outboundSendQueue).toHaveLength(2);

  const enhanced = { ...progress, revision: 2, inputTokens: 0, outputTokens: 25,
    toolStats: [{ name: 'FileRead', executions: 2, failedCalls: 1, blockedCalls: 1 }], toolStatsTruncated: false };
  __testHandleEngineEvent({ ...enhanced, unknown: 'PRIVATE', toolStats: enhanced.toolStats.map(row => ({ ...row,
    input: { password: 'PRIVATE' }, output: 'PRIVATE', error: 'PRIVATE', other: 'PRIVATE' })) }, hctx);
  expect(ctx.outboundSendQueue.at(-1).msg.event).toEqual(enhanced);
  expect(JSON.stringify(ctx.outboundSendQueue)).not.toContain('PRIVATE');

  let revision = 2;
  for (const optional of [
    { inputTokens: -1, outputTokens: Infinity, toolStats: 'PRIVATE', toolStatsTruncated: 'PRIVATE' },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1.5, toolStats: [null] },
    { inputTokens: '0', outputTokens: null, toolStats: [{ name: 'x'.repeat(129), executions: 1, failedCalls: 0, blockedCalls: 0 }] },
    { toolStats: [{ name: 'FileRead', executions: -1, failedCalls: 1, blockedCalls: 0 }] },
    { toolStats: [{ name: 'FileRead', executions: 1, failedCalls: 0, blockedCalls: 1 }] },
    { toolStats: [{ name: '', executions: 0, failedCalls: 0, blockedCalls: 0 }] },
    ...[' FileRead', 'FileRead ', '\tFileRead', 'File\nRead', 'File\u0000Read', 'File\u001fRead', 'File\u007fRead',
      '\u00a0FileRead', 'FileRead\u00a0'].map(name => ({ toolStats: [{ name, executions: 1, failedCalls: 0, blockedCalls: 0 }], toolStatsTruncated: true })),
    { toolStats: [...enhanced.toolStats, ...enhanced.toolStats], toolStatsTruncated: true },
    { toolStats: Array.from({ length: 129 }, (_, i) => ({ name: `Tool${i}`, executions: 1, failedCalls: 0, blockedCalls: 0 })) },
    { toolStatsTruncated: true },
  ]) {
    const expected = { ...progress, revision: ++revision };
    __testHandleEngineEvent({ ...expected, ...optional, text: 'PRIVATE' }, hctx);
    expect(ctx.outboundSendQueue.at(-1).msg.event).toEqual(expected);
  }
  const boundedStats = Array.from({ length: 128 }, (_, i) => ({ name: i === 127 ? 'x'.repeat(128) : `Tool${i}`, executions: 1, failedCalls: 0, blockedCalls: 0 }));
  __testHandleEngineEvent({ ...progress, revision: ++revision, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: -1,
    toolStats: boundedStats, toolStatsTruncated: true }, hctx);
  expect(ctx.outboundSendQueue.at(-1).msg.event).toEqual({ ...progress, revision, inputTokens: Number.MAX_SAFE_INTEGER,
    toolStats: boundedStats, toolStatsTruncated: true });
  expect(JSON.stringify(ctx.outboundSendQueue)).not.toContain('PRIVATE');
  expect(hctx.streamTextBatch.timer).toBeNull();
  expect(hctx.toolCallsAccum).toEqual([]);
  for (const timer of ['resetQueryTimer', 'pauseQueryTimer', 'touchQueryTimer', 'stopQueryTimer']) expect(hctx[timer]).not.toHaveBeenCalled();
  hctx.skipPartialHistory = true;
  __testHandleEngineEvent({ type: 'turn_end', terminal: true, stopReason: 'end_turn' }, hctx);
  const count = ctx.outboundSendQueue.length;
  __testHandleEngineEvent({ ...enhanced, revision: revision + 1 }, hctx);
  expect(ctx.outboundSendQueue).toHaveLength(count);
});
