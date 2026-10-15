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
  hctx.skipPartialHistory = true;
  __testHandleEngineEvent({ type: 'turn_end', terminal: true, stopReason: 'end_turn' }, hctx);
  const count = ctx.outboundSendQueue.length;
  __testHandleEngineEvent({ ...progress, revision: 3 }, hctx);
  expect(ctx.outboundSendQueue).toHaveLength(count);
});
