import { describe, expect, it } from 'vitest';
import { buildVpQueryOpts } from '../../../agent/yeaft/web-bridge.js';

describe('buildVpQueryOpts active scope context', () => {
  it('threads current session roster to the engine as sessionMembers', () => {
    const opts = buildVpQueryOpts({
      vpId: 'vp-linus',
      sessionId: 'session_members',
      sessionCoordinator: {
        group: {
          getMeta() {
            return {
              id: 'session_members',
              defaultVpId: 'vp-omni',
              roster: ['vp-omni', ' ', 'vp-linus', 42, 'vp-martin'],
              announcement: 'ship it',
            };
          },
        },
      },
    });

    expect(opts.sessionId).toBe('session_members');
    expect(opts.senderVpId).toBe('vp-linus');
    expect(opts.sessionMembers).toEqual(['vp-omni', 'vp-linus', 'vp-martin']);
    expect(opts.sessionAnnouncement).toBe('ship it');
  });
});
