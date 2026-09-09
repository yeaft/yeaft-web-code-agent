import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONFIG } from '../../server/config.js';
import {
  agents,
  clearAgentSettingsRequestsForClient,
  consumeAgentSettingsRequest,
  pendingAgentConnections,
  pendingAgentSettingsRequests,
  registerAgentSettingsRequest,
  webClients,
} from '../../server/context.js';
import { userDb, sessionDb, yeaftProjectDb, yeaftSessionDb, sessionUiMetadataDb } from '../../server/database.js';
import {
  buildHiddenSessionCatalog,
  buildSessionCatalog,
  resolveAgentAccessError,
  verifyConversationOwnership,
} from '../../server/ws-utils.js';
import { handleAgentOutput } from '../../server/handlers/agent-output.js';
import { handleAgentSync } from '../../server/handlers/agent-sync.js';
import { handleAgentConversation } from '../../server/handlers/agent-conversation.js';
import { handleClientConversation } from '../../server/handlers/client-conversation.js';
import {
  CONTAINER_AGENT_CAPABILITY,
  CONTAINER_IMAGE_UPGRADE_REASON,
  SAFE_REMOTE_UPGRADE_CAPABILITY,
  YEAFT_PLUGINS_CAPABILITY,
  YEAFT_PLUGINS_UNSUPPORTED_ERROR,
  handleClientMisc,
  requiresManualUpgradeBridge,
} from '../../server/handlers/client-misc.js';
import { routeSessionPin } from '../../server/handlers/session-pin-router.js';
import {
  YEAFT_MANAGED_SKILLS_CAPABILITY,
  YEAFT_MANAGED_SKILLS_UNSUPPORTED_ERROR,
} from '../../server/yeaft-managed-skill-capability.js';
import { handleAgentConnection, isNewerAgentVersion } from '../../server/ws-agent.js';
import { MockWebSocket, WS_OPEN } from '../helpers/mockWs.js';

describe('resolveAgentAccessError', () => {
  const originalSkipAuth = CONFIG.skipAuth;

  it('only treats a valid newer semver push hint as an available upgrade', () => {
    expect(isNewerAgentVersion('1.10.0', '1.9.9')).toBe(true);
    expect(isNewerAgentVersion('v2.0.0', '1.99.99')).toBe(true);
    expect(isNewerAgentVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerAgentVersion('1.0.0', '1.1.0')).toBe(false);
    expect(isNewerAgentVersion('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true);
    expect(isNewerAgentVersion('1.0.0-beta.1', '1.0.0')).toBe(false);
    expect(isNewerAgentVersion('latest', '1.0.0')).toBe(false);
  });

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

  it.each(['owner', 'agent', 'provider', 'live-owner', 'live-agent', 'live-provider'])(
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
      if (conflict === 'provider') row.provider = 'claude-code';
      if (conflict.startsWith('live-')) {
        const liveAgent = conflict === 'live-agent'
          ? { ownerId: 'user-1', conversations: new Map() } : agent;
        if (liveAgent !== agent) agents.set('other-agent', liveAgent);
        liveAgent.conversations.set(row.id, {
          id: row.id, userId: conflict === 'live-owner' ? 'user-2' : 'user-1',
          provider: conflict === 'live-provider' ? 'claude-code' : 'copilot',
        });
      }
      const client = {
        encryptOutbound: false, userId: 'user-1', role: 'user', currentAgent: 'unchanged',
        ws: { readyState: WS_OPEN, send: payload => replies.push(JSON.parse(payload)) },
      };
      const get = vi.spyOn(sessionDb, 'get').mockReturnValue(conflict.startsWith('live-') ? null : row);
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

  it.each(['claude-code', 'copilot'])('resumes an owned %s Web ID without a provider and preserves scoped CLI siblings', async provider => {
    CONFIG.skipAuth = false;
    const id = `resume-${provider}-${Date.now()}-${Math.random()}`;
    const userId = userDb.getOrCreate(id).id;
    const forwarded = [];
    const replies = [];
    const sibling = { id: 'other-provider', userId: userId, claudeSessionId: 'cli-id', provider: provider === 'copilot' ? 'claude-code' : 'copilot' };
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

  it('preserves telemetry correlation and replies only to the originating browser', async () => {
    CONFIG.skipAuth = true;
    const forwarded = [];
    const originMessages = [];
    const siblingMessages = [];
    const agent = {
      id: 'agent-telemetry', name: 'Telemetry', ownerId: 'user-1',
      ws: { readyState: WS_OPEN, send: payload => forwarded.push(JSON.parse(payload)) },
    };
    agents.set(agent.id, agent);
    const origin = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => originMessages.push(JSON.parse(payload)) } };
    const sibling = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => siblingMessages.push(JSON.parse(payload)) } };
    webClients.set('browser-origin', origin);
    webClients.set('browser-sibling', sibling);

    await handleClientMisc('browser-origin', origin, {
      type: 'get_telemetry_settings', agentId: agent.id, requestId: 'telemetry-1',
    }, async () => true);
    expect(forwarded).toEqual([{ type: 'get_telemetry_settings', requestId: 'telemetry-1', clientId: 'browser-origin' }]);

    await handleAgentSync(agent.id, agent, {
      type: 'telemetry_settings', requestId: 'telemetry-1', clientId: 'browser-origin', enabled: true,
    });
    expect(originMessages).toEqual([{ type: 'telemetry_settings', requestId: 'telemetry-1', clientId: 'browser-origin', enabled: true, agentId: agent.id }]);
    expect(siblingMessages).toEqual([]);
  });

  it('correlates a sole legacy Agent reply without requestId and rejects ambiguous dispatch', async () => {
    CONFIG.skipAuth = true;
    const forwarded = [];
    const firstMessages = [];
    const secondMessages = [];
    const agent = {
      id: 'agent-legacy', name: 'Legacy', ownerId: 'user-1', capabilities: [],
      ws: { readyState: WS_OPEN, send: payload => forwarded.push(JSON.parse(payload)) },
    };
    agents.set(agent.id, agent);
    const first = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => firstMessages.push(JSON.parse(payload)) } };
    const second = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => secondMessages.push(JSON.parse(payload)) } };
    webClients.set('browser-first', first);
    webClients.set('browser-second', second);

    await handleClientMisc('browser-first', first, {
      type: 'get_telemetry_settings', agentId: agent.id, requestId: 'legacy-first',
    }, async () => true);
    await handleClientMisc('browser-second', second, {
      type: 'get_telemetry_settings', agentId: agent.id, requestId: 'legacy-second',
    }, async () => true);
    expect(forwarded).toHaveLength(1);
    expect(secondMessages).toEqual([expect.objectContaining({
      type: 'telemetry_settings', requestId: 'legacy-second', error: expect.stringMatching(/rejected/i),
    })]);

    await handleAgentSync(agent.id, agent, { type: 'telemetry_settings', enabled: true });
    expect(firstMessages).toEqual([{
      type: 'telemetry_settings', enabled: true, agentId: agent.id, requestId: 'legacy-first',
    }]);
  });

  it('drops identity-less telemetry replies instead of guessing browser ownership', async () => {
    CONFIG.skipAuth = true;
    const firstMessages = [];
    const secondMessages = [];
    const agent = { id: 'agent-legacy', name: 'Legacy', ownerId: 'user-1' };
    webClients.set('browser-first', {
      authenticated: true, userId: 'user-1', role: 'user',
      ws: { readyState: WS_OPEN, send: payload => firstMessages.push(JSON.parse(payload)) },
    });
    webClients.set('browser-second', {
      authenticated: true, userId: 'user-1', role: 'user',
      ws: { readyState: WS_OPEN, send: payload => secondMessages.push(JSON.parse(payload)) },
    });

    await handleAgentSync(agent.id, agent, {
      type: 'telemetry_settings_updated', enabled: false,
    });

    expect(firstMessages).toEqual([]);
    expect(secondMessages).toEqual([]);
  });

  it('keeps interleaved registrations atomic and operation-scoped', () => {
    webClients.set('browser-a', { authenticated: true });
    webClients.set('browser-b', { authenticated: true });
    expect(registerAgentSettingsRequest({
      agentId: 'agent-a', operation: 'telemetry:load', requestId: 'request-a', clientId: 'browser-a',
    })).toBe(true);
    expect(registerAgentSettingsRequest({
      agentId: 'agent-a', operation: 'telemetry:update', requestId: 'request-b', clientId: 'browser-b',
    })).toBe(true);
    expect(pendingAgentSettingsRequests.size).toBe(2);

    expect(consumeAgentSettingsRequest({
      agentId: 'agent-a', operation: 'telemetry:load', requestId: 'request-b',
    })).toBeNull();
    expect(consumeAgentSettingsRequest({
      agentId: 'agent-a', operation: 'telemetry:update', requestId: 'request-b',
    })).toMatchObject({ clientId: 'browser-b' });
    clearAgentSettingsRequestsForClient('browser-a');
    expect(pendingAgentSettingsRequests.size).toBe(0);
  });

  it('keeps the global registry intact when one browser exhausts its own quota', () => {
    webClients.set('browser-abusive', { authenticated: true });
    webClients.set('browser-healthy', { authenticated: true });
    for (let i = 0; i < 256; i++) {
      expect(registerAgentSettingsRequest({
        agentId: 'agent-a', operation: 'telemetry:load', requestId: `abusive-${i}`, clientId: 'browser-abusive',
      })).toBe(true);
    }
    expect(registerAgentSettingsRequest({
      agentId: 'agent-a', operation: 'telemetry:load', requestId: 'abusive-overflow', clientId: 'browser-abusive',
    })).toBe(false);
    expect(registerAgentSettingsRequest({
      agentId: 'agent-a', operation: 'telemetry:load', requestId: 'healthy', clientId: 'browser-healthy',
    })).toBe(true);
    expect(consumeAgentSettingsRequest({ agentId: 'agent-a', operation: 'telemetry:load', requestId: 'healthy' }))
      .toMatchObject({ clientId: 'browser-healthy' });
  });

  it('removes a registered request when dispatch cannot reach the Agent', async () => {
    CONFIG.skipAuth = true;
    const replies = [];
    const client = {
      authenticated: true, userId: 'user-1', role: 'user',
      ws: { readyState: WS_OPEN, send: payload => replies.push(JSON.parse(payload)) },
    };
    webClients.set('browser-origin', client);
    agents.set('agent-closed', {
      ownerId: 'user-1', capabilities: [YEAFT_PLUGINS_CAPABILITY],
      ws: { readyState: 3, send() { throw new Error('must not send'); } },
    });

    await handleClientMisc('browser-origin', client, {
      type: 'get_yeaft_plugins', agentId: 'agent-closed', requestId: 'plugins-closed',
    }, async () => true);

    expect(pendingAgentSettingsRequests.size).toBe(0);
    expect(replies).toEqual([expect.objectContaining({
      type: 'yeaft_plugins', requestId: 'plugins-closed', error: 'Agent is unavailable.',
    })]);
  });

  it('removes a registered request when Agent dispatch throws', async () => {
    CONFIG.skipAuth = true;
    const replies = [];
    const client = {
      authenticated: true, userId: 'user-1', role: 'user',
      ws: { readyState: WS_OPEN, send: payload => replies.push(JSON.parse(payload)) },
    };
    webClients.set('browser-origin', client);
    agents.set('agent-throwing', {
      ownerId: 'user-1', capabilities: [YEAFT_PLUGINS_CAPABILITY],
      ws: { readyState: WS_OPEN, send() { throw new Error('socket write failed'); } },
    });

    await handleClientMisc('browser-origin', client, {
      type: 'get_yeaft_plugins', agentId: 'agent-throwing', requestId: 'plugins-throwing',
    }, async () => true);

    expect(pendingAgentSettingsRequests.size).toBe(0);
    expect(replies).toEqual([expect.objectContaining({
      type: 'yeaft_plugins', requestId: 'plugins-throwing',
      error: 'Failed to send request to Agent: socket write failed',
    })]);
  });

  it('fails and clears pending requests when the Agent disconnects', async () => {
    CONFIG.skipAuth = true;
    const replies = [];
    const client = {
      authenticated: true, userId: 'user-1', role: 'user',
      ws: { readyState: WS_OPEN, send: payload => replies.push(JSON.parse(payload)) },
    };
    webClients.set('browser-origin', client);
    const socket = new MockWebSocket(WS_OPEN);
    const agentId = 'agent-disconnecting';
    const url = new URL(`ws://localhost/?type=agent&id=${agentId}&name=${agentId}&instanceId=${agentId}&capabilities=plaintext-ok`);
    handleAgentConnection(socket, url);
    const challenge = socket.getLastMessage();
    socket.simulateMessage({
      type: 'auth', tempId: challenge.tempId, secret: '', capabilities: ['plaintext-ok'], version: '1.0.0',
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(registerAgentSettingsRequest({
      agentId, operation: 'telemetry:load', requestId: 'disconnect-pending', clientId: 'browser-origin',
    })).toBe(true);
    socket.close(1000, 'test disconnect');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(pendingAgentSettingsRequests.size).toBe(0);
    expect(replies).toContainEqual(expect.objectContaining({
      type: 'telemetry_settings', agentId, requestId: 'disconnect-pending',
      error: 'Agent disconnected before completing the request.',
    }));
  });

  it('routes Plugin replies only to the originating browser', async () => {
    CONFIG.skipAuth = true;
    const forwarded = [];
    const firstMessages = [];
    const secondMessages = [];
    const agent = {
      id: 'agent-plugins', ownerId: 'user-1', capabilities: [YEAFT_PLUGINS_CAPABILITY],
      ws: { readyState: WS_OPEN, send: payload => forwarded.push(JSON.parse(payload)) },
    };
    agents.set(agent.id, agent);
    const first = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => firstMessages.push(JSON.parse(payload)) } };
    const second = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => secondMessages.push(JSON.parse(payload)) } };
    webClients.set('browser-first', first);
    webClients.set('browser-second', second);

    await handleClientMisc('browser-first', first, {
      type: 'get_yeaft_plugins', agentId: agent.id, requestId: 'plugins-first',
    }, async () => true);
    expect(forwarded).toEqual([{ type: 'get_yeaft_plugins', requestId: 'plugins-first' }]);
    await handleAgentSync(agent.id, agent, {
      type: 'yeaft_plugins', requestId: 'plugins-first', plugins: { tools: ['FileRead'] }, clientId: 'browser-second',
    });

    expect(firstMessages).toEqual([expect.objectContaining({ type: 'yeaft_plugins', requestId: 'plugins-first' })]);
    expect(secondMessages).toEqual([]);
  });

  it('routes concurrent replies by Server-owned request provenance', async () => {
    CONFIG.skipAuth = true;
    const forwarded = [];
    const firstMessages = [];
    const secondMessages = [];
    const agent = {
      id: 'agent-concurrent', name: 'Concurrent', ownerId: 'user-1', capabilities: ['settings_request_correlation'],
      ws: { readyState: WS_OPEN, send: payload => forwarded.push(JSON.parse(payload)) },
    };
    agents.set(agent.id, agent);
    const first = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => firstMessages.push(JSON.parse(payload)) } };
    const second = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => secondMessages.push(JSON.parse(payload)) } };
    webClients.set('browser-first', first);
    webClients.set('browser-second', second);

    await handleClientMisc('browser-first', first, {
      type: 'get_telemetry_settings', agentId: agent.id, requestId: 'load-first',
    }, async () => true);
    await handleClientMisc('browser-second', second, {
      type: 'get_telemetry_settings', agentId: agent.id, requestId: 'load-second',
    }, async () => true);

    // Deliberately reverse response order and forge clientId. The Server registry,
    // not Agent-controlled clientId or arrival order, decides the recipient.
    await handleAgentSync(agent.id, agent, {
      type: 'telemetry_settings', requestId: 'load-second', clientId: 'browser-first', enabled: false,
    });
    await handleAgentSync(agent.id, agent, {
      type: 'telemetry_settings', requestId: 'load-first', clientId: 'browser-second', enabled: true,
    });

    expect(forwarded.map(message => message.requestId)).toEqual(['load-first', 'load-second']);
    expect(firstMessages).toEqual([expect.objectContaining({ requestId: 'load-first', enabled: true })]);
    expect(secondMessages).toEqual([expect.objectContaining({ requestId: 'load-second', enabled: false })]);
  });

  it('does not let a delayed identity-less response settle a later request', async () => {
    CONFIG.skipAuth = true;
    const firstMessages = [];
    const secondMessages = [];
    const agent = { id: 'agent-delayed', name: 'Delayed', ownerId: 'user-1', capabilities: ['settings_request_correlation'], ws: { readyState: WS_OPEN, send() {} } };
    agents.set(agent.id, agent);
    const first = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => firstMessages.push(JSON.parse(payload)) } };
    const second = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => secondMessages.push(JSON.parse(payload)) } };
    webClients.set('browser-first', first);
    webClients.set('browser-second', second);

    await handleClientMisc('browser-first', first, {
      type: 'update_telemetry_settings', agentId: agent.id, requestId: 'update-old', settings: { enabled: false },
    }, async () => true);
    await handleAgentSync(agent.id, agent, {
      type: 'telemetry_settings_updated', requestId: 'update-old', enabled: false,
    });
    await handleClientMisc('browser-second', second, {
      type: 'update_telemetry_settings', agentId: agent.id, requestId: 'update-new', settings: { enabled: true },
    }, async () => true);

    await handleAgentSync(agent.id, agent, {
      type: 'telemetry_settings_updated', enabled: false,
    });
    expect(secondMessages).toEqual([]);

    await handleAgentSync(agent.id, agent, {
      type: 'telemetry_settings_updated', requestId: 'update-new', enabled: true,
    });
    expect(firstMessages).toEqual([expect.objectContaining({ requestId: 'update-old', enabled: false })]);
    expect(secondMessages).toEqual([expect.objectContaining({ requestId: 'update-new', enabled: true })]);
  });

  it('treats a missing Dream sync field as disabled', async () => {
    CONFIG.skipAuth = true;
    const agent = {
      id: 'agent-dream-default', name: 'Dream default', ownerId: 'user-1',
      conversations: new Map(),
      ws: { readyState: WS_OPEN, send() {} },
    };
    agents.set(agent.id, agent);

    await handleAgentSync(agent.id, agent, { type: 'agent_sync_complete' });

    expect(agent.dreamEnabled).toBe(false);
  });

  it('routes correlated Agent maintenance and Dream replies only to the originating browser', async () => {
    CONFIG.skipAuth = true;
    const forwarded = [];
    const originMessages = [];
    const siblingMessages = [];
    const agent = {
      id: 'agent-lifecycle', name: 'Lifecycle', ownerId: 'user-1', dreamEnabled: true,
      conversations: new Map(),
      ws: { readyState: WS_OPEN, send: payload => forwarded.push(JSON.parse(payload)) },
    };
    agents.set(agent.id, agent);
    const origin = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => originMessages.push(JSON.parse(payload)) } };
    const sibling = { authenticated: true, userId: 'user-1', role: 'user', ws: { readyState: WS_OPEN, send: payload => siblingMessages.push(JSON.parse(payload)) } };
    webClients.set('browser-origin', origin);
    webClients.set('browser-sibling', sibling);

    await handleClientMisc('browser-origin', origin, {
      type: 'set_dream_enabled', agentId: agent.id, requestId: 'dream-1', enabled: false,
    }, async () => true);
    await handleAgentSync(agent.id, agent, {
      type: 'dream_enabled_changed', requestId: 'dream-1', clientId: 'browser-origin', enabled: false,
    });
    await handleClientMisc('browser-origin', origin, {
      type: 'restart_agent', agentId: agent.id, requestId: 'restart-1',
    }, async () => true);
    await handleAgentSync(agent.id, agent, {
      type: 'restart_agent_ack', requestId: 'restart-1', clientId: 'browser-origin',
    });

    expect(forwarded).toEqual([
      { type: 'set_dream_enabled', enabled: false, requestId: 'dream-1', clientId: 'browser-origin' },
      { type: 'restart_agent', requestId: 'restart-1', clientId: 'browser-origin' },
    ]);
    expect(originMessages).toContainEqual({ type: 'dream_enabled_changed', agentId: agent.id, requestId: 'dream-1', enabled: false });
    expect(originMessages).toContainEqual({ type: 'restart_agent_ack', agentId: agent.id, requestId: 'restart-1' });
    expect(siblingMessages.some(message => message.type === 'dream_enabled_changed' || message.type === 'restart_agent_ack')).toBe(false);
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

      agents.clear();
      const getSession = sessionDb.get;
      const hasOwnedRoute = sessionDb.hasOwnedRoute;
      sessionDb.get = () => ({ id: 'legacy-chat', user_id: null, agent_id: 'agent-offline' });
      sessionDb.hasOwnedRoute = (userId, agentId) => userId === 'user-1' && agentId === 'agent-offline';
      try {
        expect(verifyConversationOwnership('legacy-chat', 'user-1', 'user')).toBe(true);
        expect(verifyConversationOwnership('legacy-chat', 'user-2', 'user')).toBe(false);

        const foreignClient = {
          userId: 'user-2', role: 'user', currentAgent: null, authenticated: true,
          ws: { readyState: 1, send() {}, close() {} },
        };
        const setActive = sessionDb.setActive;
        sessionDb.setActive = (...args) => { throw new Error(`unexpected mutation ${args.join(':')}`); };
        try {
          await handleClientConversation('foreign-client', foreignClient, {
            type: 'delete_conversation',
            conversationId: 'legacy-chat',
            agentId: 'agent-offline',
            requestId: 'foreign-delete',
          }, async () => true);
        } finally {
          sessionDb.setActive = setActive;
        }
      } finally {
        sessionDb.get = getSession;
        sessionDb.hasOwnedRoute = hasOwnedRoute;
      }

      const deletedChatId = `agent-delete-${Date.now()}-${Math.random()}`;
      const deletedChatRow = {
        id: deletedChatId,
        user_id: 'user-1',
        agent_id: 'agent-owned',
        provider: 'copilot',
      };
      const deleteAgent = {
        ownerId: 'user-1',
        conversations: new Map([[deletedChatId, { id: deletedChatId, userId: 'user-1' }]]),
      };
      const originalGet = sessionDb.get;
      const originalSetActive = sessionDb.setActive;
      const originalDeleteForRoute = sessionUiMetadataDb.deleteForRoute;
      const deletionCalls = [];
      sessionDb.get = id => id === deletedChatId ? deletedChatRow : originalGet(id);
      sessionDb.setActive = (id, active) => deletionCalls.push(['active', id, active]);
      sessionUiMetadataDb.deleteForRoute = (userId, route) => deletionCalls.push(['metadata', userId, route]);
      try {
        await handleAgentConversation('agent-owned', deleteAgent, {
          type: 'conversation_deleted',
          conversationId: deletedChatId,
          // Agent payload identity must never control the cleanup target.
          userId: 'user-2',
          provider: 'claude-code',
        });
        expect(deletionCalls).toEqual([
          ['active', deletedChatId, false],
          ['metadata', 'user-1', {
            runtimeProvider: 'copilot',
            agentId: 'agent-owned',
            sessionId: deletedChatId,
          }],
        ]);

        const staleAgent = {
          ownerId: 'user-1',
          conversations: new Map([[deletedChatId, { id: deletedChatId, userId: 'user-1' }]]),
        };
        deletionCalls.length = 0;
        await handleAgentConversation('agent-stale', staleAgent, {
          type: 'conversation_deleted',
          conversationId: deletedChatId,
        });
        expect(deletionCalls).toEqual([['active', deletedChatId, false]]);
      } finally {
        sessionDb.get = originalGet;
        sessionDb.setActive = originalSetActive;
        sessionUiMetadataDb.deleteForRoute = originalDeleteForRoute;
      }
    } finally {
      sessionDb.getActiveByUser = getActive;
      sessionDb.getByUser = getByUser;
    }
  });

  it('atomically writes canonical metadata and authoritative Session snapshots', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const userId = `catalog-user-${suffix}`;
    const username = `catalog-${suffix}`;
    const now = Date.now();
    // The production DB module is isolated by the Vitest worker. Use public
    // APIs so this test exercises the same transaction as the handler.
    const { default: sql } = await import('../../server/db/connection.js');
    sql.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run(userId, username, now);
    const chatId = `chat-${suffix}`;
    sessionDb.create(chatId, 'agent-a', 'A', '/tmp', null, 'Chat', userId, 'copilot');
    sessionUiMetadataDb.applyBatch(userId, [{
      catalogKey: `chat:${chatId}`,
      runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: chatId,
      pinned: true, sortRank: 1,
    }]);
    expect(sessionDb.get(chatId).is_pinned).toBe(1);
    yeaftSessionDb.upsertFromSnapshot(userId, 'agent-a', { id: `same-${suffix}`, name: 'A' });
    yeaftSessionDb.upsertFromSnapshot(userId, 'agent-b', { id: `same-${suffix}`, name: 'B' });
    sessionUiMetadataDb.applyBatch(userId, [{
      catalogKey: `yeaft:agent-a:same-${suffix}`,
      runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: `same-${suffix}`,
      pinned: true, sortRank: 0,
    }]);
    expect(yeaftSessionDb.getForAgent(userId, 'agent-a', `same-${suffix}`).pinned).toBe(true);
    expect(yeaftSessionDb.getForAgent(userId, 'agent-b', `same-${suffix}`).pinned).toBe(false);
    expect(sessionUiMetadataDb.get(userId, `yeaft:agent-a:same-${suffix}`)).toMatchObject({
      pinned: true, sortRank: 0,
    });

    // A first pin has no metadata row and intentionally omits `hidden`. It
    // must remain a normal metadata upsert instead of being mistaken for a
    // restore of a hidden Session.
    const firstChatPinId = `first-chat-pin-${suffix}`;
    const firstYeaftPinId = `first-yeaft-pin-${suffix}`;
    sessionDb.create(firstChatPinId, 'agent-a', 'A', '/tmp', null, 'First Chat Pin', userId, 'claude-code');
    yeaftSessionDb.upsertFromSnapshot(userId, 'agent-a', { id: firstYeaftPinId, name: 'First Yeaft Pin' });
    const pinClient = {
      userId,
      role: 'user',
      authenticated: true,
      encryptOutbound: false,
      sent: [],
      ws: { readyState: WebSocket.OPEN, send(payload) { this.client.sent.push(JSON.parse(payload)); } },
    };
    pinClient.ws.client = pinClient;
    const originalSkipAuth = CONFIG.skipAuth;
    CONFIG.skipAuth = false;
    try {
      await handleClientConversation(`first-pin-chat-${suffix}`, pinClient, {
        type: 'set_session_ui_metadata',
        requestId: 'first-pin-chat',
        catalogKey: `chat:${firstChatPinId}`,
        routeRef: { runtimeProvider: 'claude-code', agentId: 'agent-a', sessionId: firstChatPinId },
        pinned: true,
        sortRank: null,
      }, async () => true);
      expect(pinClient.sent.at(-1)).toMatchObject({
        type: 'session_ui_metadata_updated',
        requestId: 'first-pin-chat',
        ok: true,
        pinned: true,
        hidden: false,
      });
      expect(sessionUiMetadataDb.get(userId, `chat:${firstChatPinId}`)).toMatchObject({
        pinned: true,
        hidden: false,
      });
      expect(sessionDb.get(firstChatPinId).is_pinned).toBe(1);

      pinClient.sent = [];
      await handleClientConversation(`first-pin-yeaft-${suffix}`, pinClient, {
        type: 'set_session_ui_metadata',
        requestId: 'first-pin-yeaft',
        catalogKey: `yeaft:agent-a:${firstYeaftPinId}`,
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: firstYeaftPinId },
        pinned: true,
        sortRank: null,
      }, async () => true);
      expect(pinClient.sent.at(-1)).toMatchObject({
        type: 'session_ui_metadata_updated',
        requestId: 'first-pin-yeaft',
        ok: true,
        pinned: true,
        hidden: false,
      });
      expect(sessionUiMetadataDb.get(userId, `yeaft:agent-a:${firstYeaftPinId}`)).toMatchObject({
        pinned: true,
        hidden: false,
      });
      expect(yeaftSessionDb.getForAgent(userId, 'agent-a', firstYeaftPinId).pinned).toBe(true);
    } finally {
      CONFIG.skipAuth = originalSkipAuth;
    }

    sessionUiMetadataDb.applyBatch(userId, [{
      catalogKey: `yeaft:agent-a:same-${suffix}`,
      runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: `same-${suffix}`,
      hidden: true,
    }]);
    const visibleCatalog = buildSessionCatalog(userId);
    expect(visibleCatalog.map(row => row.catalogKey)).not.toContain(`yeaft:agent-a:same-${suffix}`);
    expect(visibleCatalog.map(row => row.catalogKey)).toContain(`yeaft:agent-b:same-${suffix}`);
    const hiddenMetadata = sessionUiMetadataDb.get(userId, `yeaft:agent-a:same-${suffix}`);
    expect(hiddenMetadata).toMatchObject({ pinned: true, hidden: true, sortRank: 0 });
    expect(buildHiddenSessionCatalog(userId)).toEqual([
      expect.objectContaining({
        catalogKey: `yeaft:agent-a:same-${suffix}`,
        hidden: true,
        pinned: true,
      }),
    ]);

    sessionUiMetadataDb.applyBatch(userId, [{
      catalogKey: `yeaft:agent-a:same-${suffix}`,
      runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: `same-${suffix}`,
      hidden: false,
    }]);
    expect(buildSessionCatalog(userId).map(row => row.catalogKey))
      .toContain(`yeaft:agent-a:same-${suffix}`);

    const project = yeaftProjectDb.create(userId, `Project ${suffix}`);
    const secondProject = yeaftProjectDb.create(userId, `Project second ${suffix}`);
    expect(yeaftProjectDb.reorder(userId, [secondProject.id, project.id]).map(row => row.id))
      .toEqual([secondProject.id, project.id]);
    expect(() => yeaftProjectDb.reorder(userId, [project.id]))
      .toThrow('Complete Project order is required');
    expect(() => yeaftProjectDb.reorder(userId, [project.id, project.id]))
      .toThrow('Complete Project order is required');
    expect(yeaftProjectDb.reorder(userId, [project.id, secondProject.id]).map(row => row.id))
      .toEqual([project.id, secondProject.id]);
    yeaftProjectDb.delete(userId, secondProject.id);
    yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-a', sessionId: `same-${suffix}`, projectId: project.id,
    });
    yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-a', sessionId: `sibling-${suffix}`, projectId: project.id,
    });
    yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-b', sessionId: `foreign-agent-${suffix}`, projectId: project.id,
    });
    yeaftProjectDb.updateInstruction(userId, project.id, '  Follow the Project release checklist.  ');
    expect(() => yeaftProjectDb.updateInstruction(userId, project.id, 'x'.repeat(20_001)))
      .toThrow('must not exceed 20000 characters');
    expect(yeaftProjectDb.list(userId)).toEqual([
      expect.objectContaining({
        id: project.id,
        instruction: 'Follow the Project release checklist.',
        members: [
          { agentId: 'agent-a', sessionId: `same-${suffix}` },
          { agentId: 'agent-a', sessionId: `sibling-${suffix}` },
          { agentId: 'agent-b', sessionId: `foreign-agent-${suffix}` },
        ],
      }),
    ]);
    expect(yeaftProjectDb.contextForSession(userId, 'agent-a', `same-${suffix}`)).toEqual({
      projectId: project.id,
      projectName: `Project ${suffix}`,
      projectInstruction: 'Follow the Project release checklist.',
      sessionIds: [`sibling-${suffix}`],
    });
    expect(yeaftProjectDb.contextForSession(userId, 'agent-b', `foreign-agent-${suffix}`)).toEqual({
      projectId: project.id,
      projectName: `Project ${suffix}`,
      projectInstruction: 'Follow the Project release checklist.',
      sessionIds: [],
    });
    expect(yeaftProjectDb.listForAgent(userId, 'agent-a')).toEqual([
      expect.objectContaining({
        id: project.id,
        sessionIds: [`same-${suffix}`, `sibling-${suffix}`],
        members: expect.arrayContaining([
          { agentId: 'agent-b', sessionId: `foreign-agent-${suffix}` },
        ]),
      }),
    ]);

    expect(() => yeaftProjectDb.moveSession(userId, {
      agentId: 'agent-a',
      sessionId: `same-${suffix}`,
      projectId: null,
      catalogUpdates: [
        {
          catalogKey: `chat:${chatId}`,
          runtimeProvider: 'copilot',
          agentId: 'agent-a',
          sessionId: chatId,
          pinned: false,
          sortRank: 7,
        },
        {
          catalogKey: `yeaft:agent-a:missing-${suffix}`,
          runtimeProvider: 'yeaft',
          agentId: 'agent-a',
          sessionId: `missing-${suffix}`,
          pinned: false,
          sortRank: 8,
        },
      ],
    })).toThrow('Yeaft Session identity changed during metadata update');
    expect(yeaftProjectDb.contextForSession(userId, 'agent-a', `same-${suffix}`)).toMatchObject({
      projectId: project.id,
    });
    expect(sessionUiMetadataDb.get(userId, `chat:${chatId}`)).toMatchObject({
      pinned: true,
      sortRank: 1,
    });
    expect(sessionDb.get(chatId).is_pinned).toBe(1);

    const originalReconcileProjectSessions = yeaftProjectDb.reconcileAgentSessions;
    yeaftProjectDb.reconcileAgentSessions = () => { throw new Error('forced project reconciliation failure'); };
    try {
      await handleAgentOutput('agent-a', {
        ownerId: userId,
        ws: { readyState: 1 },
        conversations: new Map(),
      }, {
        type: 'session_crud_result',
        op: 'list',
        ok: true,
        sessions: [{ id: `replacement-${suffix}`, name: 'Replacement' }],
      });
      expect(yeaftSessionDb.getForAgent(userId, 'agent-a', `same-${suffix}`)).not.toBeNull();
      expect(yeaftSessionDb.getForAgent(userId, 'agent-a', `replacement-${suffix}`)).toBeUndefined();
      expect(yeaftProjectDb.contextForSession(userId, 'agent-a', `same-${suffix}`)).toMatchObject({
        projectId: project.id,
      });
    } finally {
      yeaftProjectDb.reconcileAgentSessions = originalReconcileProjectSessions;
    }

    await handleAgentOutput('agent-a', {
      ownerId: userId,
      ws: { readyState: 1 },
      conversations: new Map(),
    }, {
      type: 'session_crud_result',
      op: 'list',
      ok: true,
      sessions: [],
    });
    expect(yeaftSessionDb.getByAgent('agent-a').filter(row => row.userId === userId)).toEqual([]);
    expect(yeaftProjectDb.list(userId)[0].members).toEqual([
      { agentId: 'agent-b', sessionId: `foreign-agent-${suffix}` },
    ]);
  });

  it('blocks Agents without the safe remote-upgrade capability before they can take the Agent offline', async () => {
    expect(SAFE_REMOTE_UPGRADE_CAPABILITY).toBe('remote_upgrade_safe');
    expect(requiresManualUpgradeBridge(undefined)).toBe(true);
    expect(requiresManualUpgradeBridge([])).toBe(true);
    expect(requiresManualUpgradeBridge(['plaintext-ok'])).toBe(true);
    expect(requiresManualUpgradeBridge(['plaintext-ok'], 'win32')).toBe(true);
    expect(requiresManualUpgradeBridge(['plaintext-ok', 'work_item_attachments'], 'win32')).toBe(true);
    expect(requiresManualUpgradeBridge(['plaintext-ok'], 'linux')).toBe(false);
    expect(requiresManualUpgradeBridge(['plaintext-ok'], 'darwin')).toBe(false);
    expect(requiresManualUpgradeBridge(['plaintext-ok', 'work_item_attachments'])).toBe(false);
    expect(requiresManualUpgradeBridge(['plaintext-ok', SAFE_REMOTE_UPGRADE_CAPABILITY])).toBe(false);

    const client = {
      encryptOutbound: false,
      sent: [],
      ws: {
        readyState: 1,
        send(payload) { client.sent.push(JSON.parse(payload)); },
      },
    };
    const legacyCommands = [];
    agents.set('agent-old', {
      version: '1.0.369',
      capabilities: ['plaintext-ok'],
      encryptOutbound: false,
      ws: { readyState: 1, send(payload) { legacyCommands.push(JSON.parse(payload)); } },
    });

    await handleClientMisc('client-1', client, {
      type: 'upgrade_agent',
      agentId: 'agent-old',
    }, async () => true);

    expect(legacyCommands).toEqual([]);
    const manualAck = client.sent.at(-1);
    expect(manualAck).toMatchObject({
      type: 'upgrade_agent_ack',
      agentId: 'agent-old',
      success: false,
      reason: 'manual_upgrade_required',
      version: '1.0.369',
      requiredCapability: SAFE_REMOTE_UPGRADE_CAPABILITY,
    });
    expect(manualAck.error).toContain('PM2 or another service manager');
    expect(manualAck.error).toContain('foreground terminal');
    const stopIndex = manualAck.error.indexOf('First stop the selected Agent/service');
    const exitIndex = manualAck.error.indexOf('Confirm that process has exited');
    const installIndex = manualAck.error.indexOf('npm install -g @yeaft/webchat-agent@latest --registry=https://pkg.yeaft.com/');
    const restartIndex = manualAck.error.indexOf('restart the same Agent instance with its original configuration');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(stopIndex);
    expect(installIndex).toBeGreaterThan(exitIndex);
    expect(restartIndex).toBeGreaterThan(installIndex);

    const safeCommands = [];
    agents.set('agent-safe', {
      version: '1.0.369',
      capabilities: ['plaintext-ok', SAFE_REMOTE_UPGRADE_CAPABILITY],
      encryptOutbound: false,
      ws: { readyState: 1, send(payload) { safeCommands.push(JSON.parse(payload)); } },
    });
    await handleClientMisc('client-1', client, {
      type: 'upgrade_agent',
      agentId: 'agent-safe',
    }, async () => true);
    expect(safeCommands).toEqual([{ type: 'upgrade_agent' }]);

    const legacyLinuxCommands = [];
    agents.set('agent-linux-legacy', {
      version: '1.0.373',
      capabilities: ['plaintext-ok', 'work_item_attachments'],
      encryptOutbound: false,
      ws: { readyState: 1, send(payload) { legacyLinuxCommands.push(JSON.parse(payload)); } },
    });
    await handleClientMisc('client-1', client, {
      type: 'upgrade_agent',
      agentId: 'agent-linux-legacy',
    }, async () => true);
    expect(legacyLinuxCommands).toEqual([{ type: 'upgrade_agent' }]);
  });

  it('returns the Docker image upgrade contract without forwarding an npm command', async () => {
    const client = {
      encryptOutbound: false,
      sent: [],
      ws: {
        readyState: WS_OPEN,
        send(payload) { client.sent.push(JSON.parse(payload)); },
      },
    };
    const forwarded = [];
    agents.set('agent-container', {
      version: '1.0.415',
      capabilities: ['plaintext-ok', CONTAINER_AGENT_CAPABILITY],
      encryptOutbound: false,
      ws: { readyState: WS_OPEN, send(payload) { forwarded.push(JSON.parse(payload)); } },
    });

    await handleClientMisc('client-container', client, {
      type: 'upgrade_agent',
      agentId: 'agent-container',
    }, async () => true);

    expect(forwarded).toEqual([]);
    expect(client.sent.at(-1)).toMatchObject({
      type: 'upgrade_agent_ack',
      agentId: 'agent-container',
      success: false,
      reason: CONTAINER_IMAGE_UPGRADE_REASON,
      version: '1.0.415',
      requiredCapability: CONTAINER_AGENT_CAPABILITY,
    });
    expect(client.sent.at(-1).error).toContain('Docker image');
    expect(client.sent.at(-1).error).not.toContain('npm install -g');
  });

  it('preserves safe self-upgrades through the real SKIP_AUTH registration handshake', async () => {
    CONFIG.skipAuth = true;
    const client = {
      encryptOutbound: false,
      sent: [],
      ws: {
        readyState: WS_OPEN,
        send(payload) { client.sent.push(JSON.parse(payload)); },
      },
    };

    for (const [agentId, version, capabilities, platform, shouldUpgrade] of [
      ['skip-legacy', '1.0.369', ['plaintext-ok'], null, false],
      ['skip-windows', '1.0.373', ['plaintext-ok'], 'win32', false],
      ['skip-windows-legacy-signal', '1.0.373', ['plaintext-ok', 'work_item_attachments'], 'win32', false],
      ['skip-linux', '1.0.373', ['plaintext-ok'], 'linux', true],
      ['skip-safe', '1.0.369', ['plaintext-ok', SAFE_REMOTE_UPGRADE_CAPABILITY], null, true],
    ]) {
      const socket = new MockWebSocket(WS_OPEN);
      const url = new URL(`ws://localhost/?type=agent&id=${agentId}&name=${agentId}&instanceId=${agentId}&capabilities=${capabilities.join(',')}`);
      expect(url.searchParams.has('version')).toBe(false);

      handleAgentConnection(socket, url);
      const challenge = socket.getLastMessage();
      expect(challenge).toMatchObject({ type: 'auth_required' });
      socket.simulateMessage({
        type: 'auth',
        tempId: challenge.tempId,
        secret: '',
        capabilities,
        version,
        platform,
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(agents.get(agentId)).toMatchObject({
        version,
        capabilities,
        platform,
        ownerId: null,
        encryptOutbound: false,
      });
      socket.clearMessages();
      client.sent.length = 0;
      await handleClientMisc('client-1', client, {
        type: 'upgrade_agent',
        agentId,
      }, async () => true);

      if (shouldUpgrade) {
        expect(socket.getSentMessages()).toEqual([{ type: 'upgrade_agent' }]);
        expect(client.sent).toEqual([]);
      } else {
        expect(socket.getSentMessages()).toEqual([]);
        expect(client.sent.at(-1)).toMatchObject({
          type: 'upgrade_agent_ack',
          reason: 'manual_upgrade_required',
          version,
          requiredCapability: SAFE_REMOTE_UPGRADE_CAPABILITY,
        });
      }
    }
  });

  it('rejects Plugin configuration and catalog requests when the selected Agent lacks the protocol capability', async () => {
    CONFIG.skipAuth = false;
    const forwarded = [];
    const client = {
      userId: 'user-1', role: 'user', currentAgent: 'agent-plugins', authenticated: true,
      encryptOutbound: false,
      sent: [],
      ws: { readyState: WS_OPEN, send(payload) { client.sent.push(JSON.parse(payload)); }, close() {} },
    };
    agents.set('agent-plugins', {
      ownerId: 'user-1',
      capabilities: ['plaintext-ok'],
      capabilityMetadataProvided: true,
      encryptOutbound: false,
      ws: { readyState: WS_OPEN, send(payload) { forwarded.push(JSON.parse(payload)); } },
    });

    for (const request of [
      { type: 'get_yeaft_plugins', requestId: 'plugins-read' },
      { type: 'update_yeaft_plugins', requestId: 'plugins-write', plugins: { tools: ['FileRead'] } },
    ]) {
      await handleClientMisc('plugin-unsupported-client', client, request, async agentId => agentId === 'agent-plugins');
    }
    await handleClientConversation('plugin-unsupported-client', client, {
      type: 'yeaft_plugin_catalog', agentId: 'agent-plugins', requestId: 'plugins-catalog', workDir: 'Q:\\project',
    }, async agentId => agentId === 'agent-plugins');

    expect(YEAFT_PLUGINS_UNSUPPORTED_ERROR).toContain('does not support Plugins');
    expect(forwarded).toEqual([]);
    expect(client.sent).toEqual([
      expect.objectContaining({
        type: 'yeaft_plugins',
        agentId: 'agent-plugins',
        requestId: 'plugins-read',
        plugins: {},
        error: expect.stringContaining('does not support Plugins'),
      }),
      expect.objectContaining({
        type: 'yeaft_plugins_updated',
        agentId: 'agent-plugins',
        requestId: 'plugins-write',
        plugins: {},
        error: expect.stringContaining('does not support Plugins'),
      }),
      expect.objectContaining({
        type: 'yeaft_plugin_catalog_result',
        agentId: 'agent-plugins',
        requestId: 'plugins-catalog',
        catalog: { tools: [], skills: [], mcpServers: [] },
        error: YEAFT_PLUGINS_UNSUPPORTED_ERROR,
      }),
    ]);
  });

  it('rejects managed Skill mutation for Plugins-only and legacy Agents', async () => {
    CONFIG.skipAuth = false;
    const forwarded = [];
    const client = {
      userId: 'user-1', role: 'user', currentAgent: 'agent-skills', authenticated: true,
      encryptOutbound: false,
      sent: [],
      ws: { readyState: WS_OPEN, send(payload) { client.sent.push(JSON.parse(payload)); }, close() {} },
    };
    agents.set('agent-skills', {
      ownerId: 'user-1',
      capabilities: [YEAFT_PLUGINS_CAPABILITY],
      capabilityMetadataProvided: true,
      encryptOutbound: false,
      ws: { readyState: WS_OPEN, send(payload) { forwarded.push(JSON.parse(payload)); } },
    });

    await handleClientConversation('managed-skill-client', client, {
      type: 'yeaft_managed_skill', agentId: 'agent-skills', requestId: 'managed-skill-old',
      action: 'create', scope: 'user', skill: { name: 'safe', description: 'Safe', content: 'Safe.' },
    }, async agentId => agentId === 'agent-skills');

    expect(forwarded).toEqual([]);
    expect(client.sent).toEqual([expect.objectContaining({
      type: 'yeaft_managed_skill_result',
      agentId: 'agent-skills',
      requestId: 'managed-skill-old',
      catalog: { tools: [], skills: [], skillSources: [], mcpServers: [] },
      error: YEAFT_MANAGED_SKILLS_UNSUPPORTED_ERROR,
    })]);

    client.sent.length = 0;
    agents.get('agent-skills').capabilities.push(YEAFT_MANAGED_SKILLS_CAPABILITY);
    await handleClientConversation('managed-skill-client', client, {
      type: 'yeaft_managed_skill', agentId: 'agent-skills', requestId: 'managed-skill-new',
      action: 'create', scope: 'user', skill: { name: 'safe', description: 'Safe', content: 'Safe.' },
    }, async agentId => agentId === 'agent-skills');
    expect(forwarded).toEqual([expect.objectContaining({
      type: 'yeaft_managed_skill', requestId: 'managed-skill-new', _requestClientId: 'managed-skill-client',
    })]);
    expect(client.sent).toEqual([]);
  });

  it('distinguishes missing and explicit empty URL capability metadata through a real Agent handshake', async () => {
    CONFIG.skipAuth = true;
    const client = {
      userId: null, role: 'admin', authenticated: true, encryptOutbound: false,
      sent: [],
      ws: { readyState: WS_OPEN, send(payload) { client.sent.push(JSON.parse(payload)); }, close() {} },
    };

    for (const { agentId, urlCapabilitiesProvided, capabilityMetadataProvided } of [
      {
        agentId: 'plugins-handshake-legacy',
        urlCapabilitiesProvided: false,
        capabilityMetadataProvided: false,
      },
      {
        agentId: 'plugins-handshake-empty-url',
        urlCapabilitiesProvided: true,
        capabilityMetadataProvided: true,
      },
    ]) {
      const socket = new MockWebSocket(WS_OPEN);
      const url = new URL(`ws://localhost/?type=agent&id=${agentId}&name=${agentId}&instanceId=${agentId}`);
      if (urlCapabilitiesProvided) url.searchParams.set('capabilities', '');
      handleAgentConnection(socket, url);
      const challenge = socket.getLastMessage();
      socket.simulateMessage({ type: 'auth', tempId: challenge.tempId, secret: '' });
      await new Promise(resolve => setTimeout(resolve, 0));

      const registered = agents.get(agentId);
      expect(registered?.capabilities).toEqual(['terminal', 'file_editor', 'background_tasks']);
      expect(registered?.capabilityMetadataProvided).toBe(capabilityMetadataProvided);

      socket.clearMessages();
      client.sent.length = 0;
      await handleClientMisc('plugin-handshake-client', client, {
        type: 'get_yeaft_plugins', requestId: `${agentId}-config`, agentId,
      }, async requestedAgentId => requestedAgentId === agentId);
      await handleClientMisc('plugin-handshake-client', client, {
        type: 'update_yeaft_plugins', requestId: `${agentId}-update`, agentId,
        plugins: { tools: ['FileRead'] },
      }, async requestedAgentId => requestedAgentId === agentId);
      await handleClientConversation('plugin-handshake-client', client, {
        type: 'yeaft_plugin_catalog', requestId: `${agentId}-catalog`, agentId,
      }, async requestedAgentId => requestedAgentId === agentId);

      if (!capabilityMetadataProvided) {
        expect(socket.getSentMessages()).toEqual([
          { type: 'get_yeaft_plugins', requestId: `${agentId}-config` },
          {
            type: 'update_yeaft_plugins',
            requestId: `${agentId}-update`,
            plugins: { tools: ['FileRead'] },
          },
          expect.objectContaining({
            type: 'yeaft_plugin_catalog',
            requestId: `${agentId}-catalog`,
            _requestClientId: 'plugin-handshake-client',
          }),
        ]);
        expect(client.sent).toEqual([]);
      } else {
        expect(socket.getSentMessages()).toEqual([]);
        expect(client.sent).toEqual([
          expect.objectContaining({
            type: 'yeaft_plugins',
            agentId,
            requestId: `${agentId}-config`,
            error: YEAFT_PLUGINS_UNSUPPORTED_ERROR,
          }),
          expect.objectContaining({
            type: 'yeaft_plugins_updated',
            agentId,
            requestId: `${agentId}-update`,
            error: YEAFT_PLUGINS_UNSUPPORTED_ERROR,
          }),
          expect.objectContaining({
            type: 'yeaft_plugin_catalog_result',
            agentId,
            requestId: `${agentId}-catalog`,
            catalog: { tools: [], skills: [], mcpServers: [] },
            error: YEAFT_PLUGINS_UNSUPPORTED_ERROR,
          }),
        ]);
      }
    }
  });


  it('preserves explicit falsy Plugin payloads for Agent-side validation', async () => {
    CONFIG.skipAuth = false;
    const forwarded = [];
    agents.set('agent-plugins', {
      ownerId: 'user-1',
      capabilities: [YEAFT_PLUGINS_CAPABILITY],
      encryptOutbound: false,
      ws: { readyState: WS_OPEN, send(payload) { forwarded.push(JSON.parse(payload)); } },
    });
    const client = {
      userId: 'user-1', role: 'user', currentAgent: 'agent-plugins', authenticated: true,
      ws: { readyState: WS_OPEN, send() {}, close() {} },
    };

    for (const [index, payload] of [
      { plugins: null },
      { plugins: false },
      { plugins: '' },
      { config: null },
      { config: false },
      { config: '' },
    ].entries()) {
      await handleClientMisc(`plugin-client-${index}`, client, {
        type: 'update_yeaft_plugins',
        requestId: `plugin-${index}`,
        ...payload,
      }, async agentId => agentId === 'agent-plugins');
    }

    expect(forwarded).toEqual([
      { type: 'update_yeaft_plugins', requestId: 'plugin-0', plugins: null },
      { type: 'update_yeaft_plugins', requestId: 'plugin-1', plugins: false },
      { type: 'update_yeaft_plugins', requestId: 'plugin-2', plugins: '' },
      { type: 'update_yeaft_plugins', requestId: 'plugin-3', plugins: null },
      { type: 'update_yeaft_plugins', requestId: 'plugin-4', plugins: false },
      { type: 'update_yeaft_plugins', requestId: 'plugin-5', plugins: '' },
    ]);
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
