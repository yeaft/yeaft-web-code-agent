import { describe, it, expect } from 'vitest';

function buildAgentMapKey(ownerId, agentName) {
  const prefix = ownerId || 'global';
  return `${prefix}:${agentName}`;
}

function resolveRegisteredAgentId({ ownerId, pending }) {
  return buildAgentMapKey(ownerId, pending.instanceId || pending.agentId || pending.agentName);
}

describe('server agent instance identity', () => {
  it('uses instanceId instead of display name for new agents', () => {
    const ownerId = 'user-1';
    const a = resolveRegisteredAgentId({
      ownerId,
      pending: { instanceId: 'target-a', agentId: 'target-a', agentName: 'Desk Agent' },
    });
    const b = resolveRegisteredAgentId({
      ownerId,
      pending: { instanceId: 'target-b', agentId: 'target-b', agentName: 'Desk Agent' },
    });

    expect(a).toBe('user-1:target-a');
    expect(b).toBe('user-1:target-b');
    expect(a).not.toBe(b);
  });

  it('keeps old-agent fallback to agentId/name when instanceId is absent', () => {
    expect(resolveRegisteredAgentId({
      ownerId: 'user-1',
      pending: { agentId: 'Legacy Name', agentName: 'Legacy Name' },
    })).toBe('user-1:Legacy Name');

    expect(resolveRegisteredAgentId({
      ownerId: 'user-1',
      pending: { agentName: 'Very Old Name' },
    })).toBe('user-1:Very Old Name');
  });
});
