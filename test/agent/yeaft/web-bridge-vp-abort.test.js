import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

const { handleYeaftAbortTurn, __testHandleEngineEvent, __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

describe('Yeaft VP turn abort routing', () => {
  beforeEach(() => {
    sent.length = 0;
    __testHooks.resetAbortState();
  });

  it('removes a queued VP turn by turnId before an AbortController exists', () => {
    __testHooks.seedQueuedVpTurn({
      sessionId: 'session-1',
      vpId: 'vp-a',
      threadId: 'main',
      turnId: 'turn-a',
    });
    __testHooks.seedQueuedVpTurn({
      sessionId: 'session-1',
      vpId: 'vp-b',
      threadId: 'main',
      turnId: 'turn-b',
    });

    handleYeaftAbortTurn({ turnId: 'turn-a' });

    expect(__testHooks.queuedTurnIds()).toEqual(['turn-b']);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnId === 'turn-a'
      && msg.event.success === true)).toBe(true);
    expect(sent.some((msg) => msg.event?.type === 'vp_turn_end'
      && msg.event.turnId === 'turn-a'
      && msg.event.reason === 'aborted')).toBe(true);
  });

  it('aborts only the matching running VP turn', () => {
    const a = __testHooks.seedRunningVpTurn({ turnId: 'turn-a', vpId: 'vp-a' });
    const b = __testHooks.seedRunningVpTurn({ turnId: 'turn-b', vpId: 'vp-b' });

    handleYeaftAbortTurn({ turnId: 'turn-a' });

    expect(a.ctrl.signal.aborted).toBe(true);
    expect(b.ctrl.signal.aborted).toBe(false);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnId === 'turn-a'
      && msg.event.success === true)).toBe(true);
  });

  it('aborts a running VP turn by sessionId and vpId when turnId is unknown to the UI', () => {
    const a = __testHooks.seedRunningVpTurn({ sessionId: 'session-1', turnId: 'turn-a', vpId: 'vp-a' });
    const b = __testHooks.seedRunningVpTurn({ sessionId: 'session-1', turnId: 'turn-b', vpId: 'vp-b' });
    const c = __testHooks.seedRunningVpTurn({ sessionId: 'session-2', turnId: 'turn-c', vpId: 'vp-a' });

    handleYeaftAbortTurn({ sessionId: 'session-1', vpId: 'vp-a' });

    expect(a.ctrl.signal.aborted).toBe(true);
    expect(b.ctrl.signal.aborted).toBe(false);
    expect(c.ctrl.signal.aborted).toBe(false);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnId === 'turn-a'
      && msg.event.turnIds?.includes('turn-a')
      && msg.event.sessionId === 'session-1'
      && msg.event.vpId === 'vp-a'
      && msg.event.success === true)).toBe(true);
  });

  it('removes a queued VP turn by sessionId and vpId before an AbortController exists', () => {
    __testHooks.seedQueuedVpTurn({ sessionId: 'session-1', vpId: 'vp-a', turnId: 'turn-a' });
    __testHooks.seedQueuedVpTurn({ sessionId: 'session-1', vpId: 'vp-b', turnId: 'turn-b' });
    __testHooks.seedQueuedVpTurn({ sessionId: 'session-2', vpId: 'vp-a', turnId: 'turn-c' });

    handleYeaftAbortTurn({ sessionId: 'session-1', vpId: 'vp-a' });

    expect(__testHooks.queuedTurnIds().sort()).toEqual(['turn-b', 'turn-c']);
    expect(sent.some((msg) => msg.event?.type === 'vp_turn_end'
      && msg.event.turnId === 'turn-a'
      && msg.event.reason === 'aborted')).toBe(true);
    expect(sent.some((msg) => msg.event?.type === 'yeaft_turn_aborted'
      && msg.event.turnIds?.includes('turn-a')
      && msg.event.success === true)).toBe(true);
  });

  it('forwards final stream idle error metadata as a structured session event', () => {
    const err = new Error('OpenAI stream idle timeout after 20000ms');
    err.name = 'LLMStreamIdleTimeoutError';

    __testHandleEngineEvent({
      type: 'error',
      error: err,
      retryable: true,
      reason: 'stream_idle_timeout',
      retryExhausted: true,
    }, {
      resetQueryTimer: vi.fn(),
      sessionId: 'session-1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'main',
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'yeaft_output',
      sessionId: 'session-1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      event: expect.objectContaining({
        type: 'error',
        message: 'OpenAI stream idle timeout after 20000ms',
        errorName: 'LLMStreamIdleTimeoutError',
        retryable: true,
        reason: 'stream_idle_timeout',
        retryExhausted: true,
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'yeaft_output',
      data: expect.objectContaining({ type: 'assistant' }),
    }));
  });
});
