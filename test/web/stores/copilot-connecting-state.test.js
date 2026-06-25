import { describe, expect, it, vi } from 'vitest';

// Handlers transitively import stores that read Pinia/localStorage globals from
// the browser build. Provide minimal shims before importing (same pattern as
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = globalThis.Pinia.defineStore || ((_id, options) => () => options);
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  _m: {},
  getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};

const { handleConversationCreated, handleConversationResumed } = await import(
  '../../../web/stores/helpers/handlers/conversationHandler.js'
);
const { handleAssistantOutputFrame } = await import('../../../web/stores/helpers/assistantOutput.js');

// Minimal store stub covering only what these handlers touch. The handlers call
// a handful of store methods; we stub them as no-ops and assert on the
// conversation row's `connecting` flag, which is the behavior under test.
function makeStore() {
  return {
    agents: [{ id: 'agent-a', name: 'Agent A' }],
    conversations: [],
    activeConversations: [],
    messagesMap: {},
    processingConversations: {},
    executionStatusMap: {},
    panels: [{ id: 'p1', conversationId: null }],
    compactStatus: null,
    activeVpTurns: {},
    chatSessionState: {},
    conversationTitles: {},
    customConversationTitles: {},
    _closedAt: {},
    _turnCompletedConvs: new Set(),
    currentAgent: null,
    currentAgentInfo: null,
    currentWorkDir: null,
    _pendingPaneId: null,
    _pendingSessionTitle: null,
    addMessage: vi.fn(),
    addMessageToConversation: vi.fn(),
    sendWsMessage: vi.fn(),
    saveOpenSessions: vi.fn(),
    finishStreamingForConversation: vi.fn(),
    sweepStaleStreamingForConversation: vi.fn(),
    clearYeaftSessionProcessingIfIdle: vi.fn(),
  };
}

describe('Copilot session connecting state', () => {
  it('marks a newly created non-Claude conversation as connecting', () => {
    const store = makeStore();
    handleConversationCreated(store, {
      conversationId: 'conv-copilot',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'copilot',
    });
    const conv = store.conversations.find(c => c.id === 'conv-copilot');
    expect(conv.connecting).toBe(true);
  });

  it('does NOT mark a Claude conversation as connecting (it prestarts in background already)', () => {
    const store = makeStore();
    handleConversationCreated(store, {
      conversationId: 'conv-claude',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'claude-code',
    });
    const conv = store.conversations.find(c => c.id === 'conv-claude');
    expect(conv.connecting).toBe(false);
  });

  it('clears connecting when the system_init envelope arrives', () => {
    const store = makeStore();
    handleConversationCreated(store, {
      conversationId: 'conv-copilot',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'copilot',
    });
    expect(store.conversations.find(c => c.id === 'conv-copilot').connecting).toBe(true);

    handleAssistantOutputFrame(store, 'conv-copilot', { type: 'system', subtype: 'init', session_id: 's1' });
    expect(store.conversations.find(c => c.id === 'conv-copilot').connecting).toBe(false);
  });

  it('clears connecting when a terminal result (e.g. boot error) arrives without init', () => {
    const store = makeStore();
    handleConversationCreated(store, {
      conversationId: 'conv-copilot',
      agentId: 'agent-a',
      workDir: '/repo',
      provider: 'copilot',
    });
    expect(store.conversations.find(c => c.id === 'conv-copilot').connecting).toBe(true);

    handleAssistantOutputFrame(store, 'conv-copilot', {
      type: 'result', subtype: 'error', is_error: true, error: 'copilot ACP init failed',
    });
    expect(store.conversations.find(c => c.id === 'conv-copilot').connecting).toBe(false);
  });

  it('marks a resumed non-Claude conversation as connecting', () => {
    const store = makeStore();
    handleConversationResumed(store, {
      conversationId: 'conv-copilot-r',
      agentId: 'agent-a',
      workDir: '/repo',
      claudeSessionId: 'sess-1',
      provider: 'copilot',
      dbMessages: [],
    });
    const conv = store.conversations.find(c => c.id === 'conv-copilot-r');
    expect(conv.connecting).toBe(true);
  });
});
