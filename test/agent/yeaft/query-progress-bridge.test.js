import { afterEach, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testHandleEngineEvent, __testHooks, __testResetVpState, __testSetSession, __testGetOrCreateVpEngine } from '../../../agent/yeaft/web-bridge.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';

const original = { ws: ctx.ws, queue: ctx.outboundSendQueue, active: ctx.outboundSendQueueActive, encryption: ctx.serverEncryptionRequired };
afterEach(() => {
  ctx.ws = original.ws;
  ctx.outboundSendQueue = original.queue;
  ctx.outboundSendQueueActive = original.active;
  ctx.serverEncryptionRequired = original.encryption;
  __testHooks.resetVpStatusBroker();
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

it('settles provider refusals, context truncation and exhausted pauses as errors, not successful results', () => {
  ctx.ws = { readyState: 1, send() {} };
  ctx.serverEncryptionRequired = false;
  ctx.outboundSendQueue = [];
  ctx.outboundSendQueueActive = true;
  for (const stopReason of ['refusal', 'model_context_window_exceeded', 'unknown', 'pause_turn']) {
    const hctx = { sessionId: 's', vpId: 'v', turnId: 't', threadId: 'main', skipPartialHistory: true,
      assistantTextParts: [], presentations: [], stopQueryTimer: vi.fn(), markEngineTerminal: vi.fn() };
    __testHandleEngineEvent({ type: 'turn_end', terminal: true, stopReason }, hctx);
    expect(hctx.markEngineTerminal).toHaveBeenCalledWith('error', null);
    expect(hctx.stopQueryTimer).toHaveBeenCalledOnce();
  }
  const publication = { presentation: { phase: 'final' }, responseKind: 'progress' };
  const hctx = { sessionId: 's', vpId: 'v', turnId: 't', threadId: 'main', skipPartialHistory: true,
    assistantTextParts: [], presentationTextPartsCount: 0, presentations: [publication], markEngineTerminal: vi.fn() };
  __testHandleEngineEvent({ type: 'turn_end', terminal: true, stopReason: 'stop_sequence' }, hctx);
  expect(publication).toMatchObject({ responseKind: 'result', stopReason: 'stop_sequence' });
  expect(publication.incomplete).not.toBe(true);
  expect(hctx.markEngineTerminal).not.toHaveBeenCalled();
});

it('retains the sanitized visible engine error and retry metadata in the correct thread status', () => {
  ctx.ws = { readyState: 1, send() {} };
  ctx.serverEncryptionRequired = false;
  ctx.outboundSendQueue = [];
  ctx.outboundSendQueueActive = true;
  const hctx = { sessionId: 's', vpId: 'v', turnId: 'failed-turn', threadId: 'failed-thread',
    assistantTextParts: [], toolCallsAccum: [], toolResultsAccum: [], markEngineTerminal: vi.fn(), resetQueryTimer: vi.fn() };
  __testHandleEngineEvent({ type: 'error', reason: 'stream_idle_timeout', code: 'timeout',
    error: new Error('Stream idle timeout'), retryExhausted: true, retryAttempts: 2, maxRetries: 2 }, hctx);
  let status = ctx.outboundSendQueue.map(row => row.msg.event).find(event => event?.type === 'vp_status_changed');
  expect(status).toMatchObject({ state: 'error', threadId: 'failed-thread', turnId: 'failed-turn',
    errorDetail: { message: 'Stream idle timeout after 2 fresh request retries', code: 'timeout',
      reason: 'stream_idle_timeout', retryExhausted: true, retryAttempts: 2, maxRetries: 2,
      at: expect.any(Number), turnId: 'failed-turn', threadId: 'failed-thread' } });
  expect(status.threads[0].errorDetail).toEqual(status.errorDetail);
  ctx.outboundSendQueue = [];
  __testHandleEngineEvent({ type: 'error', reason: 'content_policy_denied', retryable: false,
    retryExhausted: true, retryAttempts: 1, maxRetries: 1,
    error: Object.assign(new Error('PRIVATE provider body'), { name: 'LLMPolicyError', statusCode: 422,
      reasonCode: 'content_policy_denied', provider: 'provider', model: 'model', raw: 'PRIVATE' }) }, hctx);
  const wire = ctx.outboundSendQueue.map(row => row.msg);
  status = wire.find(row => row.event?.type === 'vp_status_changed').event;
  const visibleError = wire.find(row => row.event?.type === 'error').event;
  expect(status.errorDetail.message).toBe(visibleError.message);
  expect(status.errorDetail).toMatchObject({ errorName: 'LLMPolicyError', statusCode: 422,
    reasonCode: 'content_policy_denied', provider: 'provider', model: 'model', retryable: false,
    retryExhausted: true, retryAttempts: 1, maxRetries: 1 });
  expect(status.errorDetail.message).toContain('Continue and ask the VP');
  expect(JSON.stringify(wire)).not.toContain('PRIVATE');
  __testHandleEngineEvent({ type: 'turn_end', terminal: true, stopReason: 'error' }, hctx);
  expect(hctx.markEngineTerminal).toHaveBeenCalledWith('error', hctx.lastEngineErrorDetail);
  ctx.outboundSendQueue = [];
  __testHandleEngineEvent({ type: 'text_delta', text: 'Recovered' }, { ...hctx, turnId: 'new-turn' });
  status = ctx.outboundSendQueue.map(row => row.msg.event).find(event => event?.type === 'vp_status_changed');
  expect(status).toMatchObject({ state: 'streaming', turnId: 'new-turn' });
  expect(status).not.toHaveProperty('errorDetail');
  expect(status.threads[0]).not.toHaveProperty('errorDetail');
});

it('retains bounded thrown-error diagnostics and sanitizes content-policy failures at the turn boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-error-wire-'));
  const savedConfig = ctx.CONFIG;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await __testResetVpState();
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.outboundSendQueueActive = true;
    ctx.serverEncryptionRequired = false;
    __testSetSession({ yeaftDir: root, config: { model: 'test-model', maxOutputTokens: 1024 },
      trace: new NullTrace(), toolRegistry: new ToolRegistry(),
      conversationStore: { append: row => row, loadRecentBySession: () => [] },
      adapter: { async *stream() { yield { type: 'stop', stopReason: 'end_turn' }; } } });
    __testHooks.setYeaftConversationIdForTest('error-conversation');
    const engine = __testGetOrCreateVpEngine('s', 'v', 'main');
    const failed = Object.assign(new Error('Failure '.repeat(400)), { code: 'request_failed', statusCode: 503,
      stack: 'PRIVATE stack', cause: { payload: 'PRIVATE' }, response: 'PRIVATE' });
    const query = vi.spyOn(engine, 'query').mockImplementation(async function* () { throw failed; });
    try {
      ctx.outboundSendQueue = [];
      await __testHooks.runVpTurnForTest({ prompt: 'fail safely', sessionId: 's', vpId: 'v', threadId: 'main',
        turnId: 'thrown-turn', envelope: {}, vpAbort: new AbortController(), baseSnapshot: [] });
      let wire = ctx.outboundSendQueue.map(row => row.msg);
      let status = wire.find(row => row.event?.type === 'vp_status_changed' && row.event.state === 'error').event;
      expect(status).toMatchObject({ sessionId: 's', vpId: 'v', threadId: 'main', turnId: 'thrown-turn',
        errorDetail: { code: 'request_failed', errorName: 'Error', statusCode: 503, message: failed.message.slice(0, 2000),
          at: expect.any(Number), turnId: 'thrown-turn', threadId: 'main' } });
      expect(status.threads[0].errorDetail).toEqual(status.errorDetail);
      expect(status.errorDetail).toMatchObject(wire.find(row => row.event?.type === 'vp_turn_end').event.detail);
      expect(wire.some(row => row.event?.state === 'idle')).toBe(false);
      expect(JSON.stringify(wire)).not.toContain('PRIVATE');
      Object.assign(failed, { message: 'PRIVATE provider body', reasonCode: 'content_policy_denied', statusCode: 422 });
      ctx.outboundSendQueue = [];
      await __testHooks.runVpTurnForTest({ prompt: 'policy failure', sessionId: 's', vpId: 'v', threadId: 'main',
        turnId: 'policy-turn', envelope: {}, vpAbort: new AbortController(), baseSnapshot: [] });
      wire = ctx.outboundSendQueue.map(row => row.msg);
      status = wire.find(row => row.event?.type === 'vp_status_changed' && row.event.state === 'error').event;
      expect(status.errorDetail.message).toContain('Continue and ask the VP');
      expect(status.errorDetail.reasonCode).toBe('content_policy_denied');
      expect(JSON.stringify(wire)).not.toContain('PRIVATE');
      expect(wire.find(row => row.event?.type === 'vp_status_changed' && row.event.state === 'thinking').event)
        .not.toHaveProperty('errorDetail');
    } finally { query.mockRestore(); }
  } finally {
    await __testResetVpState();
    __testSetSession(null);
    ctx.CONFIG = savedConfig;
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
