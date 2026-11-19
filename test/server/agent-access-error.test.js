import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents, webClients } from '../../server/context.js';
import { userDb, yeaftSessionDb } from '../../server/database.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { createMockAgent, createMockWebClient } from '../helpers/mockWs.js';
import { clearSessionTurnDeletesForClient, handleAgentSessionTurnDelete } from '../../server/handlers/session-turn-delete.js';

describe('native Session turn deletion relay', () => {
  const agentId = 'owner:agent';
  const sessionId = 'session_shared';
  const DELETE = 'yeaft_session_delete_turn';
  const AUTHORIZED_DELETE = 'session_turn_delete_authorized';
  const RESULT = 'yeaft_session_delete_turn_result';
  const DELETED = 'yeaft_session_turn_deleted';
  const request = { type: DELETE, agentId, sessionId, requestId: 'delete_1', messageId: 'msg_001' };
  const unexpectedGenericRelay = vi.fn(async () => true);

  function addWeb(id, overrides = {}) {
    const client = createMockWebClient({ userId: 'owner', role: 'pro', encryptOutbound: false, ...overrides });
    webClients.set(id, client);
    return client;
  }

  function send(id, overrides = {}) {
    return handleClientConversation(id, webClients.get(id), { ...request, ...overrides }, unexpectedGenericRelay);
  }

  const originalSkipAuth = CONFIG.skipAuth;
  let agent;
  let owner;
  beforeEach(() => {
    CONFIG.skipAuth = false;
    agent = createMockAgent({ ownerId: 'owner', capabilities: ['session_delete_turn'], encryptOutbound: false });
    agents.set(agentId, agent);
    owner = addWeb('requester', { currentAgent: agentId });
    vi.spyOn(userDb, 'isActive').mockReturnValue(true);
    vi.spyOn(yeaftSessionDb, 'getForAgent').mockImplementation((user, agentKey, sessionKey) => (
      user === 'owner' && agentKey === agentId && sessionKey === sessionId ? { id: sessionId } : null
    ));
  });
  afterEach(() => {
    for (const id of webClients.keys()) clearSessionTurnDeletesForClient(id);
    webClients.clear();
    agents.clear();
    CONFIG.skipAuth = originalSkipAuth;
    vi.restoreAllMocks();
    unexpectedGenericRelay.mockClear();
    vi.useRealTimers();
  });

  it('requires explicit valid IDs and ownership, and reserves Agent-only frames and aliases', async () => {
    await send('requester', { agentId: undefined });
    await send('requester', { sessionId: '../session_shared' });
    await send('requester', { sessionId: 'session_shared\n' });
    await send('requester', { messageId: 'msg/1' });
    await send('requester', { requestId: 'r'.repeat(161) });
    expect(owner.ws.getSentMessages().map(m => m.errorCode)).toEqual(Array(5).fill('invalid_request'));
    await send('requester', { type: 'unify_session_delete_turn', sessionId: 'session_other' });
    expect(owner.ws.getLastMessage()).toMatchObject({ type: RESULT, ok: false, errorCode: 'agent_access_denied' });
    const other = addWeb('other', { userId: 'other', role: 'admin' });
    CONFIG.skipAuth = true;
    await send('other');
    expect(other.ws.getLastMessage()).toMatchObject({ type: RESULT, ok: false, errorCode: 'agent_access_denied' });
    for (const type of [AUTHORIZED_DELETE, RESULT, DELETED, 'unify_session_delete_turn_result', 'unify_session_turn_deleted']) {
      expect(await send('requester', { type, userId: 'owner', authorized: true })).toBe(true);
    }
    expect(unexpectedGenericRelay).not.toHaveBeenCalled();
    expect(agent.ws.getSentMessages()).toEqual([]);
  });

  it('isolates same-ID requests across tabs and Agents and forwards only approved fields', async () => {
    const tab = addWeb('other-tab');
    await send('requester', { role: 'admin', actor: { userId: 'fake' }, _requestClientId: 'other-tab', turnId: 'injected' });
    await send('requester'); // same-tab duplicate is not dispatched again
    await send('other-tab'); // same Web request ID is independently correlated
    const [first, second] = agent.ws.getSentMessages();
    expect(agent.ws.getSentMessages()).toHaveLength(2);
    expect(first).toEqual({ ...request, type: AUTHORIZED_DELETE, requestId: expect.any(String) });
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).not.toBe(request.requestId);
    const result = { ...first, type: RESULT, agentId: 'forged', ok: true, turnId: 'deletion_a', userTurnId: 'arbitrary/raw user ID', deletedMessageIds: ['msg_001'], _requestClientId: 'other-tab' };
    const wrongAgent = createMockAgent({ ownerId: 'owner' });
    agents.set('owner:wrong', wrongAgent);
    yeaftSessionDb.getForAgent.mockReturnValue({ id: sessionId });
    await handleAgentSessionTurnDelete('owner:wrong', wrongAgent, result);
    await handleAgentSessionTurnDelete(agentId, agent, { ...result, sessionId: 'session_wrong' });
    expect(owner.ws.getSentMessages()).toEqual([]);
    await handleAgentSessionTurnDelete(agentId, agent, result);
    await handleAgentSessionTurnDelete(agentId, agent, result);
    expect(owner.ws.getSentMessages()).toEqual([{ type: RESULT, agentId, sessionId, requestId: request.requestId, ok: true, turnId: 'deletion_a', deletedMessageIds: ['msg_001'] }]);
    expect(tab.ws.getSentMessages()).toEqual([]);
    await handleAgentSessionTurnDelete(agentId, agent, { ...result, requestId: second.requestId, ok: false, errorCode: 'turn_active', error: 'Turn is running' });
    expect(tab.ws.getSentMessages()).toEqual([{ type: RESULT, agentId, sessionId, requestId: request.requestId, ok: false, errorCode: 'turn_active', error: 'Turn is running' }]);
  });

  it('broadcasts a reconnect-flushed deletion only to authorized owner tabs, without replying to a replacement requester', async () => {
    await send('requester');
    const dispatched = agent.ws.getLastMessage();
    const staleAgent = agent;
    clearSessionTurnDeletesForClient('requester');
    webClients.delete('requester');
    const reconnected = addWeb('replacement');
    const tab = addWeb('tab', { currentAgent: 'owner:another' });
    const other = addWeb('other', { userId: 'other', role: 'admin' });
    const unauth = addWeb('unauth', { authenticated: false });
    agent = createMockAgent({ ownerId: 'owner', encryptOutbound: false });
    agents.set(agentId, agent);
    const update = { type: DELETED, agentId: 'spoof', sessionId, turnId: 'deletion_a', deletedMessageIds: ['msg_001'] };
    await handleAgentSessionTurnDelete(agentId, staleAgent, update);
    await handleAgentSessionTurnDelete(agentId, agent, { ...update, sessionId: 'session_other' });
    await handleAgentSessionTurnDelete(agentId, agent, { ...update, turnId: [] });
    await handleAgentSessionTurnDelete(agentId, agent, { ...dispatched, type: RESULT, ok: true });
    expect(reconnected.ws.getSentMessages()).toEqual([]);
    await handleAgentSessionTurnDelete(agentId, agent, update);
    expect(reconnected.ws.getSentMessages()).toEqual([{ ...update, agentId }]);
    expect(tab.ws.getSentMessages()).toEqual([{ ...update, agentId }]);
    expect([owner, other, unauth].map(c => c.ws.getSentMessages())).toEqual([[], [], []]);
  });

});
