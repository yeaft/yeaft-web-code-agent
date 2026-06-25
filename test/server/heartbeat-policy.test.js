import { afterEach, describe, it, expect, vi } from 'vitest';

const originalTimeoutEnv = process.env.AGENT_HEARTBEAT_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeoutEnv === undefined) delete process.env.AGENT_HEARTBEAT_TIMEOUT_MS;
  else process.env.AGENT_HEARTBEAT_TIMEOUT_MS = originalTimeoutEnv;
  vi.resetModules();
});

async function loadPolicyWithEnv(value) {
  vi.resetModules();
  if (value === undefined) delete process.env.AGENT_HEARTBEAT_TIMEOUT_MS;
  else process.env.AGENT_HEARTBEAT_TIMEOUT_MS = value;
  return import('../../server/heartbeat-policy.js');
}

describe('agent heartbeat policy', () => {
  it('does not kill an agent after one missed 30s pong while messages are flowing', async () => {
    const { markAgentHeartbeatSeen, shouldTerminateAgentHeartbeat } = await loadPolicyWithEnv(undefined);
    const agent = {};
    markAgentHeartbeatSeen(agent, 1000);

    expect(shouldTerminateAgentHeartbeat(agent, 31000)).toBe(false);
    expect(shouldTerminateAgentHeartbeat(agent, 179000)).toBe(false);
    expect(shouldTerminateAgentHeartbeat(agent, 181001)).toBe(true);
  });

  it('treats inbound agent messages as liveness, not only websocket pong frames', async () => {
    const { markAgentHeartbeatSeen, shouldTerminateAgentHeartbeat } = await loadPolicyWithEnv(undefined);
    const agent = {};
    markAgentHeartbeatSeen(agent, 1000);
    markAgentHeartbeatSeen(agent, 170000);

    expect(shouldTerminateAgentHeartbeat(agent, 200000)).toBe(false);
  });

  it('allows operators to override the timeout with AGENT_HEARTBEAT_TIMEOUT_MS', async () => {
    const { AGENT_HEARTBEAT_TIMEOUT_MS, markAgentHeartbeatSeen, shouldTerminateAgentHeartbeat } = await loadPolicyWithEnv('60000');
    const agent = {};
    markAgentHeartbeatSeen(agent, 1000);

    expect(AGENT_HEARTBEAT_TIMEOUT_MS).toBe(60000);
    expect(shouldTerminateAgentHeartbeat(agent, 59000)).toBe(false);
    expect(shouldTerminateAgentHeartbeat(agent, 62000)).toBe(true);
  });

  it('does not terminate during a measured server event-loop stall', async () => {
    const { markAgentHeartbeatSeen, shouldTerminateAgentHeartbeat } = await loadPolicyWithEnv('60000');
    const agent = {};
    markAgentHeartbeatSeen(agent, 1000);

    expect(shouldTerminateAgentHeartbeat(agent, 120000, undefined, { timerDriftMs: 65000 })).toBe(false);
    expect(shouldTerminateAgentHeartbeat(agent, 120000, undefined, { timerDriftMs: 0 })).toBe(true);
  });
});
