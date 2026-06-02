/**
 * Debug drawer tool stats fallback.
 *
 * The web drawer requests `yeaft_fetch_tool_stats` and expects an agent-side
 * `yeaft_tool_stats` reply. If the selected agent is absent or offline, the
 * generic `yeaft_*` relay used to swallow the request silently, leaving the
 * browser to show `Timed out waiting for agent reply.` after 10 seconds.
 * These tests pin the server-side empty response used for unavailable agents.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const _sent = [];
const _agents = new Map();
const _forwarded = [];

function _reset() {
  _sent.length = 0;
  _agents.clear();
  _forwarded.length = 0;
}

vi.mock('../../server/database.js', () => ({
  sessionDb: {},
  messageDb: {},
  userDb: {},
}));

vi.mock('../../server/context.js', () => ({
  agents: _agents,
  pendingFiles: new Map(),
}));

vi.mock('../../server/config.js', () => ({
  CONFIG: { skipAuth: true },
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient: vi.fn(async (client, envelope) => {
    _sent.push({ clientId: client.__id, envelope });
  }),
  forwardToAgent: vi.fn(async (agentId, msg) => {
    _forwarded.push({ agentId, msg });
  }),
  broadcastAgentList: vi.fn(),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');

const client = { __id: 'client-1', currentAgent: null, userId: 'user-1' };

beforeEach(() => {
  _reset();
  client.currentAgent = null;
});

describe('client-conversation.js — yeaft_fetch_tool_stats fallback', () => {
  it('returns empty tool stats when no agent is selected', async () => {
    const handled = await handleClientConversation('client-1', client, {
      type: 'yeaft_fetch_tool_stats',
    }, vi.fn(async () => true));

    expect(handled).toBe(true);
    expect(_forwarded).toHaveLength(0);
    expect(_sent).toHaveLength(1);
    expect(_sent[0].envelope).toEqual({
      type: 'yeaft_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
      notice: 'No agent selected.',
    });
  });

  it('returns empty tool stats when the requested agent is not accessible', async () => {
    const handled = await handleClientConversation('client-1', client, {
      type: 'yeaft_fetch_tool_stats',
      agentId: 'agent-1',
    }, vi.fn(async () => false));

    expect(handled).toBe(true);
    expect(_forwarded).toHaveLength(0);
    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
      notice: 'Agent is not available.',
    });
  });

  it('returns empty tool stats when the agent socket is offline', async () => {
    _agents.set('agent-1', { ws: { readyState: 3 } });

    const handled = await handleClientConversation('client-1', client, {
      type: 'yeaft_fetch_tool_stats',
      agentId: 'agent-1',
    }, vi.fn(async () => true));

    expect(handled).toBe(true);
    expect(_forwarded).toHaveLength(0);
    expect(_sent[0].envelope).toMatchObject({
      type: 'yeaft_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
      notice: 'Agent is offline.',
    });
  });

  it('forwards normally when the agent socket is open', async () => {
    _agents.set('agent-1', { ws: { readyState: 1 } });

    const handled = await handleClientConversation('client-1', client, {
      type: 'yeaft_fetch_tool_stats',
      agentId: 'agent-1',
      ignored: false,
    }, vi.fn(async () => true));

    expect(handled).toBe(true);
    expect(_sent).toHaveLength(0);
    expect(_forwarded).toEqual([{
      agentId: 'agent-1',
      msg: {
        type: 'yeaft_fetch_tool_stats',
        ignored: false,
      },
    }]);
  });
});
