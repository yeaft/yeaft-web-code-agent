import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/config.js', () => ({ CONFIG: { skipAuth: false } }));
vi.mock('../../server/context.js', () => ({ agents: new Map(), pendingFiles: new Map() }));
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
    await relay.request(client, message({ ownerId: 'victim', op: 'send', payload: { ownerId: 'victim', personId: 'victim', text: 'hello', clientMessageId: 'm1', yeaftDir: '/browser/override' } }));
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

  it.each(['owner', 'connection', 'access', 'logout'])('fences private output after %s changes while in flight', async kind => {
    await relay.request(client, message({ op: 'output_read', payload: { outputId: '550e8400-e29b-41d4-a716-446655440000' } }));
    expect(forward).toHaveBeenCalledTimes(1);
    const requestId = forward.mock.calls[0][1].requestId;
    if (kind === 'owner') client.userId = 'owner-b';
    if (kind === 'connection') agentMap.set('agent-a', { capabilities: ['digital_person'] });
    if (kind === 'access') accessError.mockReturnValue('denied');
    if (kind === 'logout') client.authenticated = false;
    await relay.response('agent-a', { type: 'person_response', requestId, ok: true, data: { content: Buffer.from('private-output-bytes').toString('base64') } });
    expect(send).not.toHaveBeenCalled();
  });
});
