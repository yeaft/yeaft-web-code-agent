import { afterEach, describe, expect, it } from 'vitest';

import { CONFIG } from '../../server/config.js';
import { agents } from '../../server/context.js';
import { resolveAgentAccessError } from '../../server/ws-utils.js';

describe('resolveAgentAccessError', () => {
  const originalSkipAuth = CONFIG.skipAuth;

  afterEach(() => {
    CONFIG.skipAuth = originalSkipAuth;
    agents.clear();
  });

  it('classifies a missing agent as offline, not access denied', () => {
    CONFIG.skipAuth = false;

    expect(resolveAgentAccessError('agent-missing', 'user-1', 'user')).toBe('Agent not found or offline');
  });

  it('keeps real ownership failures as access denied', () => {
    CONFIG.skipAuth = false;
    agents.set('agent-1', { ownerId: 'user-1', ws: { readyState: 1 } });

    expect(resolveAgentAccessError('agent-1', 'user-2', 'user')).toBe('Agent access denied');
  });

  it('accepts an owned online agent', () => {
    CONFIG.skipAuth = false;
    agents.set('agent-1', { ownerId: 'user-1', ws: { readyState: 1 } });

    expect(resolveAgentAccessError('agent-1', 'user-1', 'user')).toBeNull();
  });

  it('classifies a closed owned websocket as offline', () => {
    CONFIG.skipAuth = false;
    agents.set('agent-1', { ownerId: 'user-1', ws: { readyState: 3 } });

    expect(resolveAgentAccessError('agent-1', 'user-1', 'user')).toBe('Agent not found or offline');
  });
});
