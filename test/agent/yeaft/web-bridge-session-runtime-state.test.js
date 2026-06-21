import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn(),
}));

const { __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

describe('Yeaft session runtime state decoration', () => {
  beforeEach(() => {
    __testHooks.resetVpStatusBroker();
  });

  it('does not mark a session running for a retained VP error status', () => {
    __testHooks.seedVpStatus({
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'main',
      state: 'error',
      turnId: 'turn-a',
    });

    const [row] = __testHooks.decorateSessionsWithRuntimeState([
      { id: 'session-a', name: 'Session A' },
    ]);

    expect(row).toMatchObject({
      id: 'session-a',
      running: false,
      active: false,
      runningVpCount: 0,
    });
  });

  it('still marks a session running for active VP states', () => {
    __testHooks.seedVpStatus({
      sessionId: 'session-a',
      vpId: 'vp-a',
      threadId: 'main',
      state: 'tool',
      turnId: 'turn-a',
    });

    const [row] = __testHooks.decorateSessionsWithRuntimeState([
      { id: 'session-a', name: 'Session A' },
    ]);

    expect(row).toMatchObject({
      id: 'session-a',
      running: true,
      active: true,
      runningVpCount: 1,
    });
  });
});
