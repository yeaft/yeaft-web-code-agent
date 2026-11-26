import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents, webClients } from '../../server/context.js';
import { userDb, yeaftSessionDb } from '../../server/database.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { handleAgentOutput } from '../../server/handlers/agent-output.js';
import { clearSessionTurnRetriesForClient } from '../../server/handlers/session-turn-retry.js';
import { createMockAgent, createMockWebClient } from '../helpers/mockWs.js';
import { clearSessionTurnDeletesForClient, handleAgentSessionTurnDelete } from '../../server/handlers/session-turn-delete.js';
import { handleSessionAttachmentChunk, readSessionAttachment } from '../../server/session-attachment-relay.js';

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
    for (const type of ['session_attachment_read_authorized', 'yeaft_session_attachment_read', 'unify_session_attachment_read', 'yeaft_session_attachment_chunk']) {
      await send('requester', { type, attachmentId: 'm0001.0' });
    }
    expect(agent.ws.getSentMessages()).toEqual([]);

    CONFIG.skipAuth = false;
    agent.capabilities.push('session_attachment_refs');
    vi.spyOn(userDb, 'getByUsername').mockImplementation(username => ({ id: username, deletion_state: 'active' }));
    const source = { agentId, sessionId, attachmentId: 'm0001.0', download: true };
    const signal = AbortSignal.timeout(5_000);
    await expect(readSessionAttachment({ username: 'other', role: 'admin' }, source, signal).next()).rejects.toMatchObject({ status: 403 });
    await expect(readSessionAttachment({ username: 'owner', role: 'pro' }, { ...source, sessionId: 'session_other' }, signal).next()).rejects.toMatchObject({ status: 404 });
    expect(agent.ws.getSentMessages()).toEqual([]);
    const stream = readSessionAttachment({ username: 'owner', role: 'pro' }, source, signal);
    const result = stream.next();
    const read = agent.ws.getLastMessage();
    expect(read).toEqual({ type: 'session_attachment_read_authorized', requestId: expect.any(String),
      sessionId, attachmentId: source.attachmentId, offset: 0, download: true });
    const reply = { ...read, type: 'yeaft_session_attachment_chunk', size: 2, version: 'a'.repeat(64), filename: 'file.txt', content: 'b2s=' };
    handleSessionAttachmentChunk(agentId, createMockAgent({ ownerId: 'owner' }), { ...reply, error: 'not_found' });
    handleSessionAttachmentChunk(agentId, agent, reply);
    await expect(result).resolves.toMatchObject({ value: { buffer: Buffer.from('ok') } });
    await stream.return();
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

describe('native Session retry relay', () => {
  const request = {
    type: 'yeaft_session_retry', agentId: 'owner:retry-agent', sessionId: 'session_retry_fixture',
    turnId: '12345678:vp', mode: 'plain', requestId: 'retry-1', retryToken: 'attempt-token',
  };
  const RESULT = 'yeaft_session_retry_result';
  const savedSkipAuth = CONFIG.skipAuth;
  let agent, requester, tab, outsider;
  const genericAccess = vi.fn(async () => true);

  function addClient(id, overrides = {}) {
    const client = createMockWebClient({ userId: 'owner', encryptOutbound: false, ...overrides });
    webClients.set(id, client);
    return client;
  }

  const send = (id = 'requester', overrides = {}) => handleClientConversation(
    id, webClients.get(id), { ...request, ...overrides }, genericAccess,
  );
  const dispatchFor = id => agent.ws.getSentMessages().findLast(message => message._requestClientId === id);
  const result = (overrides = {}) => handleAgentOutput(request.agentId, agent, {
    type: RESULT, agentId: request.agentId, sessionId: request.sessionId, turnId: request.turnId, requestId: request.requestId,
    ok: true, _requestClientId: 'requester', _dispatchId: dispatchFor(overrides._requestClientId || 'requester')?._dispatchId, ...overrides,
  });

  beforeEach(() => {
    CONFIG.skipAuth = false;
    agent = createMockAgent({ ownerId: 'owner', capabilities: ['session_turn_retry'], encryptOutbound: false });
    agents.set(request.agentId, agent);
    requester = addClient('requester', { currentAgent: request.agentId });
    tab = addClient('tab');
    outsider = addClient('outsider', { userId: 'other' });
    vi.spyOn(userDb, 'isActive').mockReturnValue(true);
    vi.spyOn(yeaftSessionDb, 'getForAgent').mockImplementation((owner, agentId, sessionId) => (
      owner === 'owner' && agentId === request.agentId && sessionId === request.sessionId ? { id: sessionId, isArchived: false } : null
    ));
  });

  afterEach(() => {
    CONFIG.skipAuth = savedSkipAuth;
    for (const id of webClients.keys()) clearSessionTurnRetriesForClient(id);
    agents.clear();
    webClients.clear();
    genericAccess.mockClear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('whitelists input and returns only a matched standalone result to the requesting tab', async () => {
    await send('requester', { _requestClientId: 'tab', _dispatchId: 'forged', _projectContext: { projectId: 'forged' }, toolState: { trusted: false }, messages: ['injected'] });
    expect(agent.ws.getSentMessages()).toEqual([{ ...request, type: 'session_turn_retry_authorized', _requestClientId: 'requester', _dispatchId: expect.not.stringMatching(/^forged$/), _projectContext: { sessionIds: [] } }]);
    await send(); // Same socket and request ID is dispatched only once.
    expect(agent.ws.getSentMessages()).toHaveLength(1);
    await send('tab', { mode: 'compact' });
    expect(agent.ws.getLastMessage()).toEqual({ ...request, type: 'session_turn_retry_authorized', mode: 'compact', _requestClientId: 'tab', _dispatchId: expect.any(String), _projectContext: { sessionIds: [] } });
    await result({ turnId: 'other-turn' });
    await result({ _requestClientId: undefined });
    await result({ _requestClientId: 'outsider' });
    expect(requester.ws.getSentMessages()).toEqual([]);
    expect(outsider.ws.getSentMessages()).toEqual([]);
    await result({ messages: ['transcript'], toolState: { hidden: true }, retryToken: request.retryToken });
    await result();
    const reply = { type: RESULT, agentId: request.agentId, sessionId: request.sessionId, turnId: request.turnId, requestId: request.requestId, ok: true };
    expect(requester.ws.getSentMessages()).toEqual([reply]);
    expect(tab.ws.getSentMessages()).toEqual([]);
    await result({ _requestClientId: 'tab', ok: false, error: 'Retry token expired', toolState: [] });
    expect(tab.ws.getSentMessages()).toEqual([{ ...reply, ok: false, error: 'Retry token expired' }]);
    expect(genericAccess).not.toHaveBeenCalled();
  });

  it('correlates invalid, inaccessible, unsupported, offline and failed-dispatch requests', async () => {
    const failure = (client, pattern, correlation = {}) => expect(client.ws.getLastMessage()).toEqual({
      type: RESULT, agentId: request.agentId, sessionId: request.sessionId, turnId: request.turnId, requestId: request.requestId,
      ok: false, error: expect.stringMatching(pattern), ...correlation,
    });
    for (const invalid of [{ agentId: undefined }, { mode: 'other' }, { retryToken: {} }, { retryToken: '' }]) {
      await send('requester', invalid);
      failure(requester, /required/i, invalid.agentId === undefined && Object.hasOwn(invalid, 'agentId') ? { agentId: null } : {});
    }
    await send('requester', { sessionId: 'session_unowned' });
    failure(requester, /owner/i, { sessionId: 'session_unowned' });
    CONFIG.skipAuth = true;
    await send('outsider');
    failure(outsider, /owner/i);
    CONFIG.skipAuth = false;
    agent.ownerId = null;
    await send();
    failure(requester, /owner/i);
    agent.ownerId = 'owner';
    agent.capabilities = [];
    await send();
    failure(requester, /not support/i);
    expect(agent.ws.getSentMessages()).toEqual([]);
    agent.capabilities = ['session_turn_retry'];
    vi.spyOn(agent.ws, 'send').mockImplementationOnce(() => { throw new Error('socket failed'); });
    await send();
    failure(requester, /offline/i);
    agents.delete(request.agentId);
    await send();
    failure(requester, /offline/i);
    expect(genericAccess).not.toHaveBeenCalled();
  });

  it('consumes client result frames and drops results after ownership or the socket changes', async () => {
    expect(await send('requester', { type: RESULT })).toBe(true);
    expect(await send('requester', { type: 'unify_session_retry_result' })).toBe(true);
    const anonymous = addClient('anonymous', { authenticated: false });
    await send('anonymous');
    expect(anonymous.ws.getSentMessages()).toEqual([]);
    expect(agent.ws.getSentMessages()).toEqual([]);

    await send();
    const replacement = addClient('requester');
    await result();
    expect(replacement.ws.getSentMessages()).toEqual([]);
    await send('tab');
    const originalAgent = agent;
    agent = createMockAgent({ ownerId: 'owner' });
    agents.set(request.agentId, agent);
    await result({ _requestClientId: 'tab' });
    expect(tab.ws.getSentMessages()).toEqual([]);
    agent = originalAgent;
    agents.set(request.agentId, agent);
    yeaftSessionDb.getForAgent.mockReturnValue(null);
    await result({ _requestClientId: 'tab' });
    expect(tab.ws.getSentMessages()).toEqual([]);
  });

  it('settles a missing acknowledgement once and drops late results', async () => {
    vi.useFakeTimers();
    await send();
    const old = dispatchFor('requester')._dispatchId;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requester.ws.getSentMessages()).toEqual([{
      type: RESULT, agentId: request.agentId, sessionId: request.sessionId, turnId: request.turnId, requestId: request.requestId,
      ok: false, error: expect.stringMatching(/No retry result/),
    }]);
    await send();
    expect(dispatchFor('requester')._dispatchId).not.toBe(old);
    await result({ _dispatchId: old });
    expect(requester.ws.getSentMessages()).toHaveLength(1);
    await result();
    expect(requester.ws.getSentMessages()).toHaveLength(2);
    expect(tab.ws.getSentMessages()).toEqual([]);
  });
});
