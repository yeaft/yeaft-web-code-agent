import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents, pendingAgentConnections, pendingAgentSettingsRequests, webClients } from '../../server/context.js';
import { userDb, sessionDb, yeaftSessionDb } from '../../server/database.js';
import { buildSessionCatalog, resolveAgentAccessError } from '../../server/ws-utils.js';
import { handleAgentConversation } from '../../server/handlers/agent-conversation.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { routeSessionPin } from '../../server/handlers/session-pin-router.js';
import { createMockAgent, createMockWebClient, WS_CLOSED, WS_OPEN } from '../helpers/mockWs.js';
import { clearSessionTurnDeletesForClient, handleAgentSessionTurnDelete } from '../../server/handlers/session-turn-delete.js';

describe('resolveAgentAccessError', () => {
  const originalSkipAuth = CONFIG.skipAuth;

  afterEach(() => {
    CONFIG.skipAuth = originalSkipAuth;
    for (const agent of agents.values()) {
      if (agent._syncTimeout) clearTimeout(agent._syncTimeout);
    }
    for (const pending of pendingAgentConnections.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
    }
    agents.clear();
    pendingAgentConnections.clear();
    pendingAgentSettingsRequests.clear();
    webClients.clear();
  });

  it.each(['owner', 'agent'])(
    'rejects resume Web ID conflicts in %s before forwarding', async conflict => {
      CONFIG.skipAuth = false;
      const forwarded = [];
      const replies = [];
      const agent = {
        id: 'resume-agent', encryptOutbound: false, ownerId: 'user-1', conversations: new Map(),
        ws: { readyState: WS_OPEN, send: payload => forwarded.push(JSON.parse(payload)) },
      };
      agents.set(agent.id, agent);
      const row = { id: 'resume-web-id', user_id: 'user-1', agent_id: agent.id, provider: 'copilot' };
      if (conflict === 'owner') row.user_id = 'user-2';
      if (conflict === 'agent') row.agent_id = 'other-agent';
      const client = {
        encryptOutbound: false, userId: 'user-1', role: 'user', currentAgent: 'unchanged',
        ws: { readyState: WS_OPEN, send: payload => replies.push(JSON.parse(payload)) },
      };
      const get = vi.spyOn(sessionDb, 'get').mockReturnValue(row);
      try {
        await handleClientConversation('resume-client', client, {
          type: 'resume_conversation', conversationId: row.id, agentId: agent.id,
          provider: 'copilot', claudeSessionId: 'cli-id',
        }, async () => true);
        expect(forwarded).toEqual([]);
        expect(replies).toEqual([{ type: 'error', message: 'Permission denied' }]);
        expect(client.currentAgent).toBe('unchanged');
      } finally { get.mockRestore(); }
    },
  );

  it('resumes an owned Copilot Web ID without a provider and preserves scoped CLI siblings', async () => {
    const provider = 'copilot';
    CONFIG.skipAuth = false;
    const id = `resume-${provider}-${Date.now()}-${Math.random()}`;
    const userId = userDb.getOrCreate(id).id;
    const forwarded = [];
    const replies = [];
    const sibling = { id: 'other-provider', userId: userId, claudeSessionId: 'cli-id', provider: 'claude-code' };
    const agent = {
      id: 'resume-agent', name: 'Resume', encryptOutbound: false, ownerId: userId,
      conversations: new Map([
        [sibling.id, sibling],
        ['stale', { id: 'stale', userId: userId, claudeSessionId: 'cli-id', provider }],
      ]),
      ws: { readyState: WS_OPEN, send: payload => forwarded.push(JSON.parse(payload)) },
    };
    const other = { id: 'other-agent', ownerId: userId, ws: { readyState: WS_OPEN }, conversations: new Map([['other-web-id', { id: 'other-web-id', provider, claudeSessionId: 'cli-id', userId }]]) };
    agents.set(agent.id, agent);
    agents.set(other.id, other);
    sessionDb.create(id, agent.id, agent.name, '/repo', 'cli-id', null, userId, provider);
    const client = {
      encryptOutbound: false, userId: userId, role: 'user', authenticated: true, currentAgent: agent.id,
      ws: { readyState: WS_OPEN, send: payload => replies.push(JSON.parse(payload)) },
    };
    webClients.set('resume-client', client);
    await handleClientConversation('resume-client', client, {
      type: 'resume_conversation', conversationId: id, agentId: agent.id, claudeSessionId: 'cli-id',
    }, async () => true);
    expect(forwarded).toEqual([expect.objectContaining({ conversationId: id, provider, userId: userId })]);
    await handleAgentConversation(agent.id, agent, {
      ...forwarded[0], type: 'conversation_resumed', workDir: '/repo', historyMessages: [],
    });
    expect(agent.conversations.has('stale')).toBe(false);
    expect(agent.conversations.get(sibling.id)).toBe(sibling);
    expect(other.conversations.has('other-web-id')).toBe(true);
    expect(sessionDb.get(id)).toMatchObject({ agent_id: agent.id, user_id: userId, provider });
    expect(replies).toContainEqual(expect.objectContaining({ type: 'conversation_resumed', conversationId: id, provider, agentId: agent.id }));
  });

  it('classifies Agent access states and rejects foreign Project mutations', async () => {
    CONFIG.skipAuth = false;
    expect(resolveAgentAccessError('agent-missing', 'user-1', 'user')).toBe('Agent not found or offline');

    agents.set('agent-1', { ownerId: 'user-1', ws: { readyState: 1 } });
    expect(resolveAgentAccessError('agent-1', 'user-2', 'user')).toBe('Agent access denied');
    expect(resolveAgentAccessError('agent-1', 'user-1', 'user')).toBeNull();
    agents.get('agent-1').ws.readyState = 3;
    expect(resolveAgentAccessError('agent-1', 'user-1', 'user')).toBe('Agent not found or offline');

    const forwarded = [];
    agents.set('agent-foreign', {
      ownerId: 'user-2',
      ws: { readyState: 1, send: payload => forwarded.push(JSON.parse(payload)) },
    });
    const client = {
      userId: 'user-1', role: 'user', currentAgent: null, authenticated: true,
      ws: { readyState: 1, send() {}, close() {} },
    };
    const accessChecks = [];
    const handled = await handleClientConversation('project-access-client', client, {
      type: 'yeaft_project_mutation',
      agentId: 'agent-foreign',
      requestId: 'project-denied',
      op: 'delete',
      projectId: 'project-1',
    }, async agentId => {
      accessChecks.push(agentId);
      return false;
    });
    expect(handled).toBe(true);
    expect(accessChecks).toEqual([]);
    expect(forwarded).toEqual([]);
  });

  it('filters NULL-owner Chat rows by Agent ACL', async () => {
    CONFIG.skipAuth = false;
    agents.set('agent-owned', { ownerId: 'user-1', ws: { readyState: 1 } });
    agents.set('agent-foreign', { ownerId: 'user-2', ws: { readyState: 1 } });
    agents.set('agent-global', { ownerId: null, ws: { readyState: 1 } });
    const getActive = sessionDb.getActiveByUser;
    const getByUser = sessionDb.getByUser;
    sessionDb.getByUser = () => [];
    sessionDb.getActiveByUser = () => [
      { id: 'legacy-owned', user_id: null, agent_id: 'agent-owned', is_active: 1 },
      { id: 'legacy-foreign', user_id: null, agent_id: 'agent-foreign', is_active: 1 },
      { id: 'legacy-global', user_id: null, agent_id: 'agent-global', is_active: 1 },
      { id: 'legacy-offline', user_id: null, agent_id: 'agent-offline', is_active: 1 },
    ];
    try {
      sessionDb.getByUser = () => [{ user_id: 'user-1', agent_id: 'agent-offline' }];
      expect(buildSessionCatalog('user-1', 'user').map(row => row.catalogKey)).toEqual([
        'chat:legacy-offline', 'chat:legacy-owned',
      ]);
      expect(buildSessionCatalog('user-1', 'admin').map(row => row.catalogKey)).toEqual([
        'chat:legacy-global', 'chat:legacy-offline', 'chat:legacy-owned',
      ]);

    } finally {
      sessionDb.getActiveByUser = getActive;
      sessionDb.getByUser = getByUser;
    }
  });

  it('fails closed when legacy Yeaft pin identity is ambiguous', () => {
    const result = routeSessionPin({
      getYeaftRows: () => [
        { userId: 'user-1', agentId: 'agent-a' },
        { userId: 'user-1', agentId: 'agent-b' },
      ],
      verifyChatOwnership: () => true,
      skipAuth: false,
    }, { userId: 'user-1' }, { type: 'pin_session', conversationId: 'same-id' });
    expect(result).toMatchObject({ kind: 'denied', reason: 'yeaft-ambiguous' });
  });
});

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

  it('settles unsupported, offline, failed dispatch and timed-out requests without retrying mutations', async () => {
    vi.useFakeTimers();
    agent.capabilities = [];
    await send('requester');
    expect(owner.ws.getLastMessage()).toMatchObject({ type: RESULT, ok: false, errorCode: 'session_delete_turn_unsupported' });
    agent.ws.readyState = WS_CLOSED;
    await send('requester');
    expect(owner.ws.getLastMessage()).toMatchObject({ type: RESULT, ok: false, errorCode: 'agent_unavailable' });
    agent = createMockAgent({ ownerId: 'owner', capabilities: ['session_delete_turn'], encryptOutbound: false });
    agents.set(agentId, agent);
    const sendFrame = vi.spyOn(agent.ws, 'send').mockImplementationOnce(() => { throw new Error('socket closed'); });
    await send('requester');
    expect(owner.ws.getLastMessage()).toMatchObject({ type: RESULT, ok: false, errorCode: 'agent_unavailable' });
    await send('requester');
    const dispatched = agent.ws.getLastMessage();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.ws.getLastMessage()).toMatchObject({ type: RESULT, requestId: request.requestId, ok: false, errorCode: 'request_timeout' });
    await handleAgentSessionTurnDelete(agentId, agent, { ...dispatched, type: RESULT, ok: true });
    expect(owner.ws.getSentMessages()).toHaveLength(4);
    expect(sendFrame).toHaveBeenCalledTimes(2);
  });
});
