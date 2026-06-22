import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../../agent/providers/acp-client.js';

function makePair() {
  const stdin = new EventEmitter();
  stdin.write = vi.fn(() => true);
  const stdout = new EventEmitter();
  return { stdin, stdout };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AcpClient request timeout', () => {
  it('rejects a request that gets no response within timeoutMs', async () => {
    vi.useFakeTimers();
    const { stdin, stdout } = makePair();
    const client = new AcpClient({ stdin, stdout });

    const p = client.request('initialize', {}, { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('does NOT time out when a response arrives in time', async () => {
    vi.useFakeTimers();
    const { stdin, stdout } = makePair();
    const client = new AcpClient({ stdin, stdout });

    const p = client.request('initialize', {}, { timeoutMs: 1000 });
    // Respond to id 1 before the deadline.
    stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`);
    await vi.advanceTimersByTimeAsync(2000); // past the old deadline
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('has no timeout when timeoutMs is omitted (long-running turns are allowed)', async () => {
    vi.useFakeTimers();
    const { stdin, stdout } = makePair();
    const client = new AcpClient({ stdin, stdout });

    const p = client.request('session/prompt', {});
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 10 minutes
    expect(settled).toBe(false); // still pending, not timed out

    stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } })}\n`);
    await expect(p).resolves.toEqual({ stopReason: 'end_turn' });
  });
});
