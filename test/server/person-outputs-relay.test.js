import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../server/config.js', () => ({ CONFIG: { skipAuth: false } }));
vi.mock('../../server/context.js', () => ({ agents: new Map(), pendingFiles: new Map() }));
vi.mock('../../server/ws-utils.js', () => ({ forwardToAgent: vi.fn(), sendToWebClient: vi.fn(), resolveAgentAccessError: vi.fn() }));
import { createPersonRelay } from '../../server/handlers/client-person.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
let relay, send, forward, accessError, client, agents;
const message = (op, payload = {}) => ({ type: 'person_request', agentId: 'agent', requestId: 'browser', op, payload, ownerId: 'victim' });
beforeEach(() => {
  client = { authenticated: true, userId: 'alice', role: 'pro' };
  agents = new Map([['agent', { capabilities: ['digital_person'] }]]);
  send = vi.fn(async () => true); forward = vi.fn(async () => true); accessError = vi.fn(() => null);
  relay = createPersonRelay({ agentMap: agents, send, forward, accessError });
});
afterEach(() => relay.close());

describe('Person output read-only relay', () => {
  it.each([['outputs', {}], ['outputs', { cursor: '24', limit: 50 }], ['output_read', { outputId: id }], ['output_read', { outputId: id, offset: 10, maxBytes: 65536 }]])('relays %s with owner/correlation and exact bounded fields', async (op, payload) => {
    await relay.request(client, message(op, payload));
    const outgoing = forward.mock.lastCall[1];
    expect(outgoing).toMatchObject({ op, payload, ownerId: 'alice' }); expect(outgoing.requestId).not.toBe('browser');
    await relay.response('agent', { type: 'person_response', requestId: outgoing.requestId, ok: true, data: { items: [] }, ownerId: 'victim', op: 'forged' });
    expect(send.mock.lastCall[1]).toEqual({ type: 'person_response', agentId: 'agent', requestId: 'browser', op, ok: true, data: { items: [] } });
  });
  it.each([
    ['outputs', []], ['output_read', 'file-id'],
    ['outputs', { cursor: 2 }], ['outputs', { cursor: '0' }], ['outputs', { cursor: '../path' }], ['outputs', { limit: 51 }], ['outputs', { limit: null }],
    ['outputs', { ownerId: 'victim' }], ['outputs', { file_path: '/etc/passwd' }],
    ['output_read', {}], ['output_read', { outputId: '../path' }], ['output_read', { outputId: id, offset: -1 }],
    ['output_read', { outputId: id, offset: 1.2 }], ['output_read', { outputId: id, offset: null }],
    ['output_read', { outputId: id, maxBytes: 65537 }], ['output_read', { outputId: id, maxBytes: null }],
    ['output_read', { outputId: id, path: '/etc/passwd' }], ['output_read', { outputId: id, namespace: 'other' }],
  ])('rejects malformed %s payload %j without forwarding', async (op, payload) => {
    await relay.request(client, message(op, payload)); expect(forward).not.toHaveBeenCalled();
    expect(send.mock.lastCall[1]).toMatchObject({ requestId: 'browser', op, ok: false, errorCode: 'invalid_request' });
  });
  it('never exposes publication/arbitrary path selection as a browser operation', async () => {
    await relay.request(client, message('Output.publish', { file_path: '/etc/passwd' }));
    expect(forward).not.toHaveBeenCalled(); expect(send.mock.lastCall[1].ok).toBe(false);
  });
  it('requires authenticated access before forwarding either output operation', async () => {
    client.authenticated = false;
    await relay.request(client, message('outputs'));
    expect(forward).not.toHaveBeenCalled(); expect(send.mock.lastCall[1].ok).toBe(false);
    client.authenticated = true; accessError.mockReturnValue('denied');
    await relay.request(client, message('output_read', { outputId: id }));
    expect(forward).not.toHaveBeenCalled(); expect(send.mock.lastCall[1].ok).toBe(false);
  });
  it('isolates simultaneous same browser IDs by relay correlation and authenticated owner', async () => {
    const bob = { authenticated: true, userId: 'bob', role: 'pro' };
    await relay.request(client, message('outputs'));
    await relay.request(bob, message('outputs'));
    const aliceRequest = forward.mock.calls[0][1], bobRequest = forward.mock.calls[1][1];
    expect(aliceRequest.ownerId).toBe('alice'); expect(bobRequest.ownerId).toBe('bob');
    expect(aliceRequest.requestId).not.toBe(bobRequest.requestId);
    await relay.response('agent', { type: 'person_response', requestId: bobRequest.requestId, ok: true, data: { items: ['bob-only'] } });
    await relay.response('agent', { type: 'person_response', requestId: aliceRequest.requestId, ok: true, data: { items: ['alice-only'] } });
    expect(send.mock.calls[0][0]).toBe(bob); expect(send.mock.calls[0][1].data.items).toEqual(['bob-only']);
    expect(send.mock.calls[1][0]).toBe(client); expect(send.mock.calls[1][1].data.items).toEqual(['alice-only']);
  });
  it('ignores wrong Agent/correlation, then accepts the matching response only once', async () => {
    await relay.request(client, message('output_read', { outputId: id }));
    const requestId = forward.mock.lastCall[1].requestId;
    const reply = { type: 'person_response', requestId, ok: true, data: { data: 'file-bytes' } };
    await relay.response('other-agent', reply);
    await relay.response('agent', { ...reply, requestId: 'forged' });
    expect(send).not.toHaveBeenCalled();
    await relay.response('agent', reply); await relay.response('agent', reply);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('drops pending output responses on client disconnect', async () => {
    await relay.request(client, message('outputs'));
    const requestId = forward.mock.lastCall[1].requestId;
    relay.clearClient(client);
    await relay.response('agent', { type: 'person_response', requestId, ok: true, data: { items: ['private'] } });
    expect(send).not.toHaveBeenCalled();
  });
  it('maps unknown Agent errors to a generic safe output message', async () => {
    await relay.request(client, message('output_read', { outputId: id }));
    await relay.response('agent', { type: 'person_response', requestId: forward.mock.lastCall[1].requestId, ok: false, errorCode: 'driver_error', error: '/private/secret https://user:password@host/' });
    expect(send.mock.lastCall[1]).toMatchObject({ ok: false, errorCode: 'requestFailed', error: 'Digital person output request failed; refresh before retrying' });
  });
  it.each(['owner', 'connection', 'access', 'logout'])('fences a late output response after %s changes', async change => {
    await relay.request(client, message('output_read', { outputId: id })); const requestId = forward.mock.lastCall[1].requestId;
    if (change === 'owner') client.userId = 'bob';
    if (change === 'connection') agents.set('agent', { capabilities: ['digital_person'] });
    if (change === 'access') accessError.mockReturnValue('denied');
    if (change === 'logout') client.authenticated = false;
    await relay.response('agent', { type: 'person_response', requestId, ok: true, data: { data: 'private' } }); expect(send).not.toHaveBeenCalled();
  });
  it.each(['output_not_file', 'output_quota', 'output_path', 'output_platform', 'not_found', 'invalid_request', 'not_open'])('preserves %s but sanitizes error text', async errorCode => {
    await relay.request(client, message('output_read', { outputId: id }));
    await relay.response('agent', { type: 'person_response', requestId: forward.mock.lastCall[1].requestId, ok: false, errorCode, error: '/private/secret https://user:password@host/' });
    expect(send.mock.lastCall[1]).toMatchObject({ ok: false, errorCode });
    expect(send.mock.lastCall[1].error).not.toContain('/private'); expect(send.mock.lastCall[1].error).not.toContain('password');
  });
});
