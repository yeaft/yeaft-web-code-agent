import { describe, expect, it } from 'vitest';

const { __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

describe('Yeaft Dream trigger routing', () => {
  it('accepts the current sessionId field', () => {
    expect(__testHooks.resolveDreamTriggerSessionId({ sessionId: 'session-a' })).toBe('session-a');
  });

  it('keeps accepting legacy groupId from older web clients', () => {
    expect(__testHooks.resolveDreamTriggerSessionId({ groupId: 'session-b' })).toBe('session-b');
  });

  it('prefers sessionId over legacy groupId when both are present', () => {
    expect(__testHooks.resolveDreamTriggerSessionId({ sessionId: 'session-new', groupId: 'session-old' })).toBe('session-new');
  });
});
