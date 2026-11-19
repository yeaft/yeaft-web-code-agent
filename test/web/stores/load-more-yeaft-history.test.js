import { describe, it, expect, vi } from 'vitest';

// `conversationHandler.js` transitively imports `web/stores/auth.js`,
// which does `const { defineStore } = Pinia;` against a global Pinia
// (loaded before the browser modules). Shim it for Node-side tests.
const storeOptions = {};
globalThis.Pinia = {
  defineStore: (id, options) => { storeOptions[id] = options; return () => ({}); },
};

const { handleYeaftHistoryChunk } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
const { yeaftHistoryIdentityKey } = await import('../../../web/stores/helpers/yeaft-history-identity.js');

const { beginYeaftHistoryLoad, finishYeaftHistoryLoad, isCurrentYeaftHistoryResponse, syncActiveYeaftHistoryLoad } = await import('../../../web/stores/helpers/yeaft-history-load.js');

const { conversationRepositoryFor } = await import('../../../web/stores/helpers/conversation-repository.js');

function mkStore(overrides = {}) {
  const sent = [];
  const store = {
    currentView: 'yeaft',
    yeaftConversationId: 'yeaft-1',
    currentAgent: 'agent-1',
    yeaftHasMoreHistory: true,
    yeaftLoadingMoreHistory: false,
    yeaftOldestLoadedSeq: 100,
    yeaftSessionHistoryState: {},
    yeaftMessageWindowState: {},
    messagesMap: {},
    continueYeaftHistoryDelta: vi.fn(() => true),
    clearYeaftHistoryMemory: vi.fn(),
    sendWsMessage(msg) { sent.push(msg); },
    _sent: sent,
    ...overrides,
  };
  store.conversationRepository = conversationRepositoryFor(store);
  return store;
}

describe('Yeaft conversation loading state', () => {

  it('keeps the active Agent cursor intact when a same-id Session chunk arrives late from another Agent', () => {
    const sessionId = 'session_default';
    const agentAKey = yeaftHistoryIdentityKey('agent-a', sessionId);
    const agentBKey = yeaftHistoryIdentityKey('agent-b', sessionId);
    const store = mkStore({
      currentAgent: 'agent-b',
      yeaftActiveSessionFilter: sessionId,
      yeaftConversationId: 'conv-b',
      yeaftConversationIdsByAgent: { 'agent-a': 'conv-a', 'agent-b': 'conv-b' },
      yeaftLoadingMoreHistory: true,
      yeaftHasMoreHistory: true,
      yeaftOldestLoadedSeq: 10,
      yeaftSessionHistoryState: {
        [agentAKey]: { loaded: true, loading: true, latestSeq: 7, hasMore: true, oldestSeq: 3 },
        [agentBKey]: { loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10 },
      },
      messagesMap: { 'conv-a': [], 'conv-b': [{ type: 'user', content: 'B', sessionId }] },
    });

    handleYeaftHistoryChunk(store, {
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: 'conv-a',
      sessionId,
      mode: 'recent',
      messages: [{ id: '000001-a', role: 'user', content: 'A', sessionId }],
      latestSeq: 1,
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['conv-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'A', sessionId }),
    ]));
    expect(store.messagesMap['conv-b']).toEqual([expect.objectContaining({ content: 'B' })]);
    expect(store.yeaftConversationId).toBe('conv-b');
    expect(store.yeaftConversationIdsByAgent).toEqual({ 'agent-a': 'conv-a', 'agent-b': 'conv-b' });

    expect(store.yeaftSessionHistoryState[agentAKey]).toEqual(expect.objectContaining({
      loading: false, latestSeq: 1, hasMore: false, oldestSeq: 1,
    }));
    expect(store.yeaftSessionHistoryState[agentBKey]).toEqual({
      loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10,
    });
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(10);
    expect(store.yeaftLoadingMoreHistory).toBe(true);

    handleYeaftHistoryChunk(store, {
      type: 'yeaft_history_chunk',
      agentId: 'agent-b',
      conversationId: 'conv-b-replacement',
      sessionId,
      mode: 'delta',
      messages: [{ id: '000021-b', role: 'assistant', content: 'replacement', sessionId }],
      latestSeq: 21,
      hasMore: false,
    });
    expect(store.yeaftConversationId).toBe('conv-b');
    expect(store.activeConversations || []).not.toContain('conv-b-replacement');
    expect(store.messagesMap['conv-b']).toEqual([expect.objectContaining({ content: 'B' })]);
    expect(store.messagesMap['conv-b-replacement']).toEqual([
      expect.objectContaining({ content: 'replacement', sessionId }),
    ]);
  });
});
