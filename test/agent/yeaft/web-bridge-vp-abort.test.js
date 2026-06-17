import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

const { handleYeaftAbortTurn, handleYeaftAbortAll, __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

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

describe('Yeaft abort diagnostics — agent-side trace', () => {
  let warns;
  let logs;

  beforeEach(() => {
    sent.length = 0;
    __testHooks.resetAbortState();
    warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warns.mockRestore();
    logs.mockRestore();
  });

  it('emits a path=running ack when a running turn was actually aborted', () => {
    __testHooks.seedRunningVpTurn({ turnId: 'turn-x', vpId: 'vp-x' });

    handleYeaftAbortTurn({ turnId: 'turn-x' });

    const ack = sent.find((m) => m.event?.type === 'yeaft_turn_aborted');
    expect(ack).toBeTruthy();
    expect(ack.event.success).toBe(true);
    expect(ack.event.path).toBe('running');
    // No miss warn should fire when we actually stopped a running turn.
    expect(warns.mock.calls.some((args) => /no matching turn/i.test(String(args[0])))).toBe(false);
  });

  it('emits a path=queued ack when a queued turn was dropped', () => {
    __testHooks.seedQueuedVpTurn({
      sessionId: 'session-1', vpId: 'vp-q', threadId: 'main', turnId: 'turn-q',
    });

    handleYeaftAbortTurn({ turnId: 'turn-q' });

    const ack = sent.find((m) => m.event?.type === 'yeaft_turn_aborted');
    expect(ack.event.success).toBe(true);
    expect(ack.event.path).toBe('queued');
  });

  it('logs a diagnostic warn with known runningTurns/queuedTurns when stop misses', () => {
    __testHooks.seedRunningVpTurn({ turnId: 'turn-y', vpId: 'vp-y' });
    __testHooks.seedQueuedVpTurn({
      sessionId: 'session-1', vpId: 'vp-z', threadId: 'main', turnId: 'turn-z',
    });

    handleYeaftAbortTurn({ turnId: 'turn-missing' });

    const ack = sent.find((m) => m.event?.type === 'yeaft_turn_aborted');
    expect(ack.event.success).toBe(false);
    expect(ack.event.path).toBe('miss');

    // Diagnostic warn must (a) name the missing turn, (b) name the
    // running turn we DID know about, (c) include the queued count.
    const matching = warns.mock.calls.find(([, msg]) => msg === 'turn-missing');
    expect(matching).toBeTruthy();
    // Args: ('...no matching turn for', turnId, '— runningTurns:', [...], '— queuedTurns:', n)
    expect(matching[3]).toContain('turn-y');
    expect(matching[5]).toBe(1);
  });

  it('logs an audit line on yeaft_abort_all with pre-counts and aborted ids', () => {
    __testHooks.seedRunningVpTurn({ turnId: 'turn-1', vpId: 'vp-1' });
    __testHooks.seedRunningVpTurn({ turnId: 'turn-2', vpId: 'vp-2' });
    __testHooks.seedQueuedVpTurn({
      sessionId: 'session-1', vpId: 'vp-3', threadId: 'main', turnId: 'turn-3',
    });

    handleYeaftAbortAll();

    const line = logs.mock.calls.find(([msg]) => msg === '[Yeaft] yeaft_abort_all:');
    expect(line).toBeTruthy();
    // Order: [tag, 'beforeRunning=', n, 'beforeQueued=', n, 'beforeVps=', n, 'aborted=', [...]]
    expect(line[2]).toBe(2); // beforeRunning
    expect(line[4]).toBe(1); // beforeQueued
    expect(line[8]).toEqual(expect.arrayContaining(['turn-1', 'turn-2']));
  });

  it('rejects an abort_turn payload with no turnId and warns', () => {
    handleYeaftAbortTurn({});

    const ack = sent.find((m) => m.event?.type === 'yeaft_turn_aborted');
    expect(ack.event.success).toBe(false);
    expect(warns.mock.calls.some(([m]) => /no turnId/i.test(String(m)))).toBe(true);
  });
});
