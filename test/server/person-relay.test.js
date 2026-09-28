import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/config.js', () => ({ CONFIG: { skipAuth: false } }));
vi.mock('../../server/context.js', () => ({ agents: new Map() }));
vi.mock('../../server/ws-utils.js', () => ({ forwardToAgent: vi.fn(), sendToWebClient: vi.fn(), resolveAgentAccessError: vi.fn() }));
import { createPersonRelay } from '../../server/handlers/client-person.js';

let relay, send, forward, accessError, client, agentMap;
beforeEach(() => {
  vi.useFakeTimers();
  client = { authenticated: true, userId: 'owner-a', role: 'pro' };
  agentMap = new Map([['agent-a', { capabilities: ['digital_person'] }], ['agent-b', { capabilities: ['digital_person'] }]]);
  send = vi.fn(async () => true);
  forward = vi.fn(async () => true);
  accessError = vi.fn(() => null);
  relay = createPersonRelay({ agentMap, send, forward, accessError });
});
afterEach(() => { relay.close(); vi.useRealTimers(); });
const message = (extra = {}) => ({ type: 'person_request', agentId: 'agent-a', requestId: 'browser-1', op: 'snapshot', payload: {}, ...extra });

describe('digital person authenticated relay', () => {
  it('replaces identity and correlation, strips forged payload fields, never broadcasts', async () => {
    await relay.request(client, message({ ownerId: 'victim', op: 'send', payload: { ownerId: 'victim', personId: 'victim', text: 'hello', clientMessageId: 'm1', uri: 'mongodb://evil' } }));
    const outbound = forward.mock.calls[0][1];
    expect(outbound).toMatchObject({ ownerId: 'owner-a', op: 'send', payload: { text: 'hello', clientMessageId: 'm1' } });
    expect(outbound.payload).not.toHaveProperty('ownerId');
    expect(outbound.payload).not.toHaveProperty('uri');
    expect(outbound.requestId).not.toBe('browser-1');
    await relay.response('agent-a', { type: 'person_response', requestId: outbound.requestId, agentId: 'agent-b', ownerId: 'victim', op: 'forged', ok: true, data: { busy: false } });
    expect(send).toHaveBeenCalledExactlyOnceWith(client, { type: 'person_response', requestId: 'browser-1', agentId: 'agent-a', op: 'send', ok: true, data: { busy: false } });
    await relay.response('agent-a', { type: 'person_response', requestId: outbound.requestId, ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not let wrong Agent consume a pending request', async () => {
    await relay.request(client, message());
    const requestId = forward.mock.calls[0][1].requestId;
    await relay.response('agent-b', { type: 'person_response', requestId, ok: true });
    expect(send).not.toHaveBeenCalled();
    await relay.response('agent-a', { type: 'person_response', requestId, ok: true, data: {} });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'connection', 'access', 'logout'])('fences late response after %s changes', async kind => {
    await relay.request(client, message());
    const requestId = forward.mock.calls[0][1].requestId;
    if (kind === 'owner') client.userId = 'owner-b';
    if (kind === 'connection') agentMap.set('agent-a', { capabilities: ['digital_person'] });
    if (kind === 'access') accessError.mockReturnValue('denied');
    if (kind === 'logout') client.authenticated = false;
    await relay.response('agent-a', { type: 'person_response', requestId, ok: true, data: { secret: 'private' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects unsupported agent, access, malformed operation and oversized payload with correlation', async () => {
    agentMap.get('agent-a').capabilities = [];
    await relay.request(client, message());
    expect(send.mock.lastCall[1]).toMatchObject({ requestId: 'browser-1', ok: false });
    agentMap.get('agent-a').capabilities = ['digital_person'];
    accessError.mockReturnValue('Agent access denied');
    await relay.request(client, message());
    expect(send.mock.lastCall[1].error).toBe('Agent access denied');
    accessError.mockReturnValue(null);
    await relay.request(client, message({ op: '__proto__' }));
    await relay.request(client, message({ op: 'send', payload: { text: 'x'.repeat(40_001) } }));
    expect(send).toHaveBeenCalledTimes(4);
    expect(forward).not.toHaveBeenCalled();
  });

  it('accepts synchronous responses without losing correlation', async () => {
    forward.mockImplementation(async (agentId, msg) => {
      await relay.response(agentId, { type: 'person_response', requestId: msg.requestId, ok: true, data: {} });
      return true;
    });
    await relay.request(client, message());
    await vi.advanceTimersByTimeAsync(31_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall[1].ok).toBe(true);
  });

  it('expires requests, handles send failure and cleans disconnected clients', async () => {
    await relay.request(client, message());
    await vi.advanceTimersByTimeAsync(30_001);
    expect(send.mock.lastCall[1]).toMatchObject({ ok: false, requestId: 'browser-1' });
    expect(send.mock.lastCall[1].error).toContain('timed out');
    forward.mockResolvedValueOnce(false);
    await relay.request(client, message());
    expect(send.mock.lastCall[1].error).toContain('offline');
    await relay.request(client, message());
    relay.clearClient(client);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('bounds pending work per browser and ignores unrelated messages', async () => {
    expect(await relay.request(client, { type: 'other' })).toBe(false);
    expect(await relay.response('agent-a', { type: 'other' })).toBe(false);
    for (let i = 0; i < 33; i++) await relay.request(client, message({ requestId: `r${i}` }));
    expect(forward).toHaveBeenCalledTimes(32);
    expect(send.mock.lastCall[1].error).toContain('Too many');
  });
});
