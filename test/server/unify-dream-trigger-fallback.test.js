/**
 * Dream trigger routing fallback.
 *
 * The header Dream button sends `unify_dream_trigger` through the generic
 * `unify_*` relay. If there is no selected/online agent, the request cannot
 * reach the agent-side Dream scheduler. That must not be silent: the browser
 * needs a scoped skipped result so the Dream status/debug UI can explain why
 * nothing ran.
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

describe('client-conversation.js — unify_dream_trigger fallback', () => {
  it('returns a scoped skipped result when no agent is selected', async () => {
    const handled = await handleClientConversation('client-1', client, {
      type: 'unify_dream_trigger',
      groupId: 'grp_demo',
    }, vi.fn(async () => true));

    expect(handled).toBe(true);
    expect(_forwarded).toHaveLength(0);
    expect(_sent).toEqual([{
      clientId: 'client-1',
      envelope: {
        type: 'unify_dream_result',
        groupId: 'grp_demo',
        success: false,
        skipped: true,
        skippedReason: 'no-agent-selected',
        trigger: 'manual',
        error: null,
      },
    }]);
  });

  it('returns a skipped result when the requested agent is not accessible', async () => {
    const handled = await handleClientConversation('client-1', client, {
      type: 'unify_dream_trigger',
      groupId: 'grp_demo',
      agentId: 'agent-1',
    }, vi.fn(async () => false));

    expect(handled).toBe(true);
    expect(_forwarded).toHaveLength(0);
    expect(_sent[0].envelope).toMatchObject({
      type: 'unify_dream_result',
      groupId: 'grp_demo',
      success: false,
      skipped: true,
      skippedReason: 'agent-not-available',
      trigger: 'manual',
      error: null,
    });
  });

  it('returns a skipped result when the target agent socket is offline', async () => {
    _agents.set('agent-1', { ws: { readyState: 3 } });

    const handled = await handleClientConversation('client-1', client, {
      type: 'unify_dream_trigger',
      groupId: 'grp_demo',
      agentId: 'agent-1',
    }, vi.fn(async () => true));

    expect(handled).toBe(true);
    expect(_forwarded).toHaveLength(0);
    expect(_sent[0].envelope).toMatchObject({
      type: 'unify_dream_result',
      groupId: 'grp_demo',
      success: false,
      skipped: true,
      skippedReason: 'agent-offline',
      trigger: 'manual',
      error: null,
    });
  });

  it('forwards to the selected online agent and strips agentId from the agent payload', async () => {
    _agents.set('agent-1', { ws: { readyState: 1 } });

    const handled = await handleClientConversation('client-1', client, {
      type: 'unify_dream_trigger',
      groupId: 'grp_demo',
      agentId: 'agent-1',
    }, vi.fn(async () => true));

    expect(handled).toBe(true);
    expect(_sent).toHaveLength(0);
    expect(_forwarded).toEqual([{
      agentId: 'agent-1',
      msg: {
        type: 'unify_dream_trigger',
        groupId: 'grp_demo',
      },
    }]);
  });

  it('uses client.currentAgent when the frame does not carry agentId', async () => {
    client.currentAgent = 'agent-current';
    _agents.set('agent-current', { ws: { readyState: 1 } });

    const handled = await handleClientConversation('client-1', client, {
      type: 'unify_dream_trigger',
      groupId: 'grp_demo',
    }, vi.fn(async () => true));

    expect(handled).toBe(true);
    expect(_sent).toHaveLength(0);
    expect(_forwarded).toEqual([{
      agentId: 'agent-current',
      msg: {
        type: 'unify_dream_trigger',
        groupId: 'grp_demo',
      },
    }]);
  });
});
