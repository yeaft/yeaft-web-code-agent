import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../server/config.js';
import { agents, pendingAgentConnections, pendingAgentSettingsRequests, webClients } from '../../server/context.js';
import { userDb, sessionDb } from '../../server/database.js';
import { buildSessionCatalog, resolveAgentAccessError } from '../../server/ws-utils.js';
import { handleAgentConversation } from '../../server/handlers/agent-conversation.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import { routeSessionPin } from '../../server/handlers/session-pin-router.js';
import { WS_OPEN } from '../helpers/mockWs.js';

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
