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
  it.each([['output_read', { outputId: id, offset: 10, maxBytes: 65536 }]])('relays %s with owner/correlation and exact bounded fields', async (op, payload) => {
    await relay.request(client, message(op, payload));
    const outgoing = forward.mock.lastCall[1];
    expect(outgoing).toMatchObject({ op, payload, ownerId: 'alice' }); expect(outgoing.requestId).not.toBe('browser');
    await relay.response('agent', { type: 'person_response', requestId: outgoing.requestId, ok: true, data: { items: [] }, ownerId: 'victim', op: 'forged' });
    expect(send.mock.lastCall[1]).toEqual({ type: 'person_response', agentId: 'agent', requestId: 'browser', op, ok: true, data: { items: [] } });
  });
  it.each([['output_read', { outputId: '../path' }], ['output_read', { outputId: id, path: '/etc/passwd' }]])('rejects malformed %s payload %j without forwarding', async (op, payload) => {
    await relay.request(client, message(op, payload)); expect(forward).not.toHaveBeenCalled();
    expect(send.mock.lastCall[1]).toMatchObject({ requestId: 'browser', op, ok: false, errorCode: 'invalid_request' });
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
});
