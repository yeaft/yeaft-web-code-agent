/**
 * yeaft-load-history-relay.test.js — Bug B regression guard.
 *
 * The server's `yeaft_load_history` relay used to forward only
 * { type, limit, sessionId } and silently drop the `afterSeq` /
 * `afterMessageId` cursor. That made the agent's cheap delta-load path
 * unreachable: a reconnect catch-up (afterSeq set, limit undefined)
 * degraded into a full recent-history replay, re-sending the whole pane
 * every time instead of an empty delta.
 *
 * This test drives the real `handleClientConversation` and asserts the
 * forwarded envelope preserves the cursor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn(async () => {});

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient: vi.fn(),
  forwardToAgent,
  broadcastAgentList: vi.fn(),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: { get: vi.fn(() => null) },
  messageDb: {},
  userDb: {},
  yeaftSessionDb: { getByUser: vi.fn(() => []) },
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');

const allow = async () => true;
const client = { userId: 'owner-1', username: 'u', currentAgent: 'agent-1' };

afterEach(() => {
  forwardToAgent.mockClear();
});

describe('yeaft_load_history relay preserves the catch-up cursor', () => {
  it('forwards afterSeq (delta catch-up) instead of dropping it', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      afterSeq: 42,
    }, allow);

    expect(forwardToAgent).toHaveBeenCalledTimes(1);
    const [, forwarded] = forwardToAgent.mock.calls[0];
    expect(forwarded).toMatchObject({
      type: 'yeaft_load_history',
      sessionId: 'sess-1',
      afterSeq: 42,
    });
  });

  it('forwards afterMessageId when present', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      afterMessageId: '000007-user',
    }, allow);

    const [, forwarded] = forwardToAgent.mock.calls[0];
    expect(forwarded.afterMessageId).toBe('000007-user');
  });

  it('omits cursor fields on an initial (recent-window) load', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      limit: 5,
    }, allow);

    const [, forwarded] = forwardToAgent.mock.calls[0];
    expect(forwarded).toMatchObject({ type: 'yeaft_load_history', sessionId: 'sess-1', limit: 5 });
    expect('afterSeq' in forwarded).toBe(false);
    expect('afterMessageId' in forwarded).toBe(false);
  });
});
