import { describe, it, expect } from 'vitest';

globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({
  ...(options.state ? options.state() : {}),
  ...(options.actions || {}),
});
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

const { useChatStore } = await import('../../../web/stores/chat.js');

describe('chat store assistant output actions', () => {
  it('creates execution status through the provider-neutral helper', () => {
    const store = useChatStore();

    const status = store.getOrCreateExecutionStatus('conv-1');

    expect(status).toEqual({
      currentTool: null,
      toolHistory: [],
      lastActivity: null,
    });
    expect(store.executionStatusMap['conv-1']).toBe(status);
  });

  it('does not clear processing state for history replay result frames', () => {
    const store = useChatStore();
    store.processingConversations = { 'conv-1': true };
    store.messagesMap = {
      'conv-1': [{ id: 'a1', type: 'assistant', content: 'old', isStreaming: true, status: 'pending' }],
    };

    store.handleAssistantOutputFrame('conv-1', { type: 'result', isHistoryReplay: true });

    expect(store.processingConversations['conv-1']).toBe(true);
    expect(store.messagesMap['conv-1'][0].isStreaming).toBe(false);
  });

  it('scopes history replay result finalization to its replayed turn', () => {
    const store = useChatStore();
    store.yeaftConversationId = 'conv-1';
    store.processingConversations = { 'conv-1': true };
    store.messagesMap = {
      'conv-1': [
        { id: 'live', type: 'assistant', content: 'live', turnId: 'turn-live', isStreaming: true, status: 'pending' },
        { id: 'hist', type: 'assistant', content: 'history', turnId: 'turn-history', isStreaming: true, status: 'pending' },
      ],
    };

    store.handleYeaftOutput({
      conversationId: 'conv-1',
      sessionId: 'session-b',
      turnId: 'turn-history',
      data: { type: 'result', isHistoryReplay: true },
    });

    expect(store.processingConversations['conv-1']).toBe(true);
    expect(store.messagesMap['conv-1'][0].isStreaming).toBe(true);
    expect(store.messagesMap['conv-1'][1].isStreaming).toBe(false);
  });
});
