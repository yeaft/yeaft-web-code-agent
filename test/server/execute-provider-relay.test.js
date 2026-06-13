import { afterEach, describe, expect, it, vi } from 'vitest';

// fix-copilot-provider-persist: when a copilot conversation is sent to after
// an agent process restart, the server must forward the persisted `provider`
// on the `execute` payload so the agent's handleUserInput can self-heal the
// ACP child instead of mis-routing to Claude. This test drives the real
// `handleClientConversation` `chat` case and asserts the forwarded payload.

const forwardToAgent = vi.fn(async () => {});
const sendToWebClient = vi.fn(async () => {});

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent,
  broadcastAgentList: vi.fn(),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

// `dbProvider` lets each test control what the persisted column returns.
let dbProvider = null;
vi.mock('../../server/database.js', () => ({
  sessionDb: {
    get: vi.fn(() => (dbProvider !== undefined ? { provider: dbProvider } : null)),
    update: vi.fn(),
  },
  messageDb: {},
  userDb: {},
  yeaftSessionDb: {},
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { CONFIG } = await import('../../server/config.js');
const { agents, pendingFiles } = await import('../../server/context.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');

const allow = async () => true;

afterEach(() => {
  forwardToAgent.mockClear();
  sendToWebClient.mockClear();
  agents.clear();
  pendingFiles.clear();
  dbProvider = null;
});

function seedAgent(convInfo) {
  agents.set('agent-1', {
    status: 'ready',
    ws: { readyState: 1 },
    ownerId: 'owner-1',
    conversations: new Map(convInfo ? [['conv-1', convInfo]] : []),
  });
}

describe('execute relay forwards the conversation provider', () => {
  it('forwards provider from the live in-memory convInfo', async () => {
    CONFIG.skipAuth = true;
    seedAgent({ id: 'conv-1', workDir: '/w', provider: 'copilot' });
    const client = { userId: 'owner-1', username: 'u', currentAgent: 'agent-1', currentConversation: 'conv-1' };

    await handleClientConversation('c1', client, { type: 'chat', conversationId: 'conv-1', prompt: 'hi' }, allow);

    expect(forwardToAgent).toHaveBeenCalledTimes(1);
    const [, payload] = forwardToAgent.mock.calls[0];
    expect(payload).toMatchObject({ type: 'execute', conversationId: 'conv-1', provider: 'copilot' });
  });

  it('falls back to the persisted DB provider when the in-memory conv lost it (post-restart)', async () => {
    CONFIG.skipAuth = true;
    // Simulate a restart: the agent restored the conv from DB without a
    // provider field in memory, but the DB column still has it.
    seedAgent({ id: 'conv-1', workDir: '/w' /* no provider */ });
    dbProvider = 'copilot';
    const client = { userId: 'owner-1', username: 'u', currentAgent: 'agent-1', currentConversation: 'conv-1' };

    await handleClientConversation('c1', client, { type: 'chat', conversationId: 'conv-1', prompt: 'hi' }, allow);

    const [, payload] = forwardToAgent.mock.calls[0];
    expect(payload).toMatchObject({ type: 'execute', conversationId: 'conv-1', provider: 'copilot' });
  });

  it('omits provider for a default (claude-code) conversation', async () => {
    CONFIG.skipAuth = true;
    seedAgent({ id: 'conv-1', workDir: '/w' /* no provider */ });
    dbProvider = null; // DB has no provider either
    const client = { userId: 'owner-1', username: 'u', currentAgent: 'agent-1', currentConversation: 'conv-1' };

    await handleClientConversation('c1', client, { type: 'chat', conversationId: 'conv-1', prompt: 'hi' }, allow);

    const [, payload] = forwardToAgent.mock.calls[0];
    expect(payload.type).toBe('execute');
    expect('provider' in payload).toBe(false);
  });
});
