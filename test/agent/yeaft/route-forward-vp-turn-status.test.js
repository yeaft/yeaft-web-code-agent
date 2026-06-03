/**
 * route-forward-vp-turn-status.test.js
 *
 * Regression: a successful RouteForward is a VP hand-off, not a normal tool
 * loop. The forwarding VP's visible turn must end immediately, otherwise the
 * roster/timeline row remains stuck on thinking even though another VP now owns
 * the next turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn(),
}));

import { sendToServer } from '../../../agent/connection/buffer.js';
import {
  __testHandleEngineEvent,
  __testResetVpState,
} from '../../../agent/yeaft/web-bridge.js';

describe('route_forward turn status', () => {
  beforeEach(async () => {
    await __testResetVpState();
    sendToServer.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(1770000000000);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await __testResetVpState();
  });

  it('settles the forwarding VP and emits vp_turn_end on route_forward tool_handoff', () => {
    const thread = { status: 'thinking', title: 'Forward bug', messageIds: ['m1'] };
    const hctx = {
      sessionId: 'grp_fun',
      vpId: 'linus',
      threadId: 'thr_forward',
      turnId: 'turn_forward:linus',
      thread,
      resetQueryTimer: () => {},
      assistantTextParts: [],
    };

    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'tool_handoff',
      threadId: 'thr_forward',
      detail: {
        kind: 'route_forward',
        fromVpId: 'linus',
        dispatched: ['martin'],
      },
    }, hctx);

    expect(thread.status).toBe('idle');
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_output',
      sessionId: 'grp_fun',
      vpId: 'linus',
      event: expect.objectContaining({
        type: 'vp_status_changed',
        state: 'idle',
        runningThreadCount: 0,
        turnId: null,
      }),
    }));
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_output',
      sessionId: 'grp_fun',
      vpId: 'linus',
      turnId: 'turn_forward:linus',
      threadId: 'thr_forward',
      event: expect.objectContaining({
        type: 'vp_turn_end',
        sessionId: 'grp_fun',
        vpId: 'linus',
        threadId: 'thr_forward',
        turnId: 'turn_forward:linus',
        stopReason: 'tool_handoff',
        detail: expect.objectContaining({ kind: 'route_forward' }),
      }),
    }));
  });

  it('does not settle the visible turn for an ordinary tool_use loop boundary', () => {
    const thread = { status: 'thinking', title: 'Normal tool', messageIds: [] };

    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'tool_use',
      threadId: 'thr_tool',
    }, {
      sessionId: 'grp_fun',
      vpId: 'linus',
      threadId: 'thr_tool',
      turnId: 'turn_tool:linus',
      thread,
      resetQueryTimer: () => {},
      assistantTextParts: [],
    });

    expect(thread.status).toBe('thinking');
    expect(sendToServer).not.toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ type: 'vp_turn_end' }),
    }));
  });
});
