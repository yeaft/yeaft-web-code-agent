import { afterEach, describe, expect, it, vi } from 'vitest';

const originalTimeoutEnv = process.env.YEAFT_AGENT_HEARTBEAT_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeoutEnv === undefined) delete process.env.YEAFT_AGENT_HEARTBEAT_TIMEOUT_MS;
  else process.env.YEAFT_AGENT_HEARTBEAT_TIMEOUT_MS = originalTimeoutEnv;
  vi.resetModules();
});

async function loadPolicyWithEnv(value) {
  vi.resetModules();
  if (value === undefined) delete process.env.YEAFT_AGENT_HEARTBEAT_TIMEOUT_MS;
  else process.env.YEAFT_AGENT_HEARTBEAT_TIMEOUT_MS = value;
  return import('../../agent/connection/heartbeat-policy.js');
}

describe('agent connection heartbeat policy', () => {
  it('reconnects after the heartbeat timeout when no pong arrives', async () => {
    const { shouldReconnectForHeartbeat } = await loadPolicyWithEnv('60000');

    expect(shouldReconnectForHeartbeat(1000, 59000)).toBe(false);
    expect(shouldReconnectForHeartbeat(1000, 62000)).toBe(true);
  });

  it('does not reconnect during a measured agent event-loop stall', async () => {
    const { shouldReconnectForHeartbeat } = await loadPolicyWithEnv('60000');

    expect(shouldReconnectForHeartbeat(1000, 120000, undefined, { timerDriftMs: 65000 })).toBe(false);
    expect(shouldReconnectForHeartbeat(1000, 120000, undefined, { timerDriftMs: 0 })).toBe(true);
  });
});
