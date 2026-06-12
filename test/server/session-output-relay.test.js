import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  broadcastAgentList: vi.fn(),
  forwardToClients: vi.fn(),
}));

vi.mock('../../server/database.js', () => ({
  messageDb: {},
  yeaftSessionDb: {
    reconcileFromSnapshot: vi.fn(),
    getByAgent: vi.fn(() => []),
    upsertFromSnapshot: vi.fn(),
  },
}));

const { CONFIG } = await import('../../server/config.js');
const { webClients } = await import('../../server/context.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');

const originalSkipAuth = CONFIG.skipAuth;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  webClients.clear();
  sendToWebClient.mockClear();
});

describe('Yeaft Session output relay aliases', () => {
  it('accepts neutral agent aliases and relays legacy yeaft_output for old web compatibility', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', {
      authenticated: true,
      userId: 'owner-1',
      sent: [],
    });

    const data = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    await expect(handleAgentOutput('agent-1', { ownerId: 'owner-1' }, {
      type: 'session_output',
      conversationId: 'yeaft-1',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      threadId: 'thread-1',
      data,
    })).resolves.toBe(true);

    expect(webClients.get('owner-client').sent).toEqual([{
      type: 'yeaft_output',
      conversationId: 'yeaft-1',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      threadId: 'thread-1',
      data,
      event: undefined,
    }]);
  });
});
