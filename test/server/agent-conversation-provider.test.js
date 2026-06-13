import { afterEach, describe, expect, it, vi } from 'vitest';

// fix-copilot-provider-persist: guard the persist layer against CLOBBER.
// The agent's resume handler defaults an absent provider to 'claude-code',
// so a provider-less resume (web auto-restore / recovery) reports
// provider:'claude-code' even for a copilot conv. agent-conversation must
// NOT overwrite a stored non-default provider with that default.

// Stateful fake sessionDb: tracks the provider column per id.
const store = new Map(); // id -> { provider }
const sessionDb = {
  get: vi.fn((id) => (store.has(id) ? { ...store.get(id), agent_id: 'agent-1' } : null)),
  exists: vi.fn((id) => store.has(id)),
  create: vi.fn((id, _a, _n, _w, _c, _t, _u, provider = null) => { store.set(id, { provider }); }),
  setProvider: vi.fn((id, provider) => { store.set(id, { ...(store.get(id) || {}), provider }); }),
  update: vi.fn(),
  setActive: vi.fn(),
  setAgent: vi.fn(),
};

vi.mock('../../server/database.js', () => ({
  sessionDb,
  messageDb: { bulkAddHistory: vi.fn(() => 0), getRecentTurns: vi.fn(() => ({ messages: [], hasMore: false })), getCount: vi.fn(() => 0) },
}));
vi.mock('../../server/ws-utils.js', () => ({
  broadcastAgentList: vi.fn(),
  notifyConversationUpdate: vi.fn(),
  forwardToClients: vi.fn(),
}));

const { agents } = await import('../../server/context.js');
const { handleAgentConversation } = await import('../../server/handlers/agent-conversation.js');

function freshAgent() {
  return { name: 'A1', ownerId: 'owner-1', ownerUsername: 'u', conversations: new Map() };
}

afterEach(() => {
  store.clear();
  agents.clear();
  vi.clearAllMocks();
});

describe('agent-conversation provider persistence (clobber guard)', () => {
  it('persists a copilot provider on conversation_created', async () => {
    const agent = freshAgent();
    agents.set('agent-1', agent);
    await handleAgentConversation('agent-1', agent, {
      type: 'conversation_created', conversationId: 'conv-1', workDir: '/w', provider: 'copilot',
    });
    expect(store.get('conv-1')?.provider).toBe('copilot');
    expect(agent.conversations.get('conv-1')?.provider).toBe('copilot');
  });

  it('does NOT clobber a stored copilot when a provider-less resume reports claude-code', async () => {
    const agent = freshAgent();
    agents.set('agent-1', agent);
    // Seed: copilot conv already persisted.
    store.set('conv-1', { provider: 'copilot' });

    // The agent restarted and the web auto-restore resumed with no provider →
    // the agent defaulted it to 'claude-code' and reports that.
    await handleAgentConversation('agent-1', agent, {
      type: 'conversation_resumed', conversationId: 'conv-1', workDir: '/w', provider: 'claude-code',
    });

    // The stored binding must survive.
    expect(store.get('conv-1')?.provider).toBe('copilot');
    expect(sessionDb.setProvider).not.toHaveBeenCalledWith('conv-1', 'claude-code');
    // And the in-memory conv carries copilot (restored from DB), not claude-code.
    expect(agent.conversations.get('conv-1')?.provider).toBe('copilot');
  });

  it('still upgrades a stored null provider to copilot on an explicit resume', async () => {
    const agent = freshAgent();
    agents.set('agent-1', agent);
    store.set('conv-1', { provider: null });

    await handleAgentConversation('agent-1', agent, {
      type: 'conversation_resumed', conversationId: 'conv-1', workDir: '/w', provider: 'copilot',
    });

    expect(store.get('conv-1')?.provider).toBe('copilot');
  });
});
