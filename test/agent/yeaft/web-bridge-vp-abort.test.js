import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

const { handleYeaftAbortTurn, __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

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
});
