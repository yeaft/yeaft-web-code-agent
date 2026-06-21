import { beforeEach, describe, expect, it, vi } from 'vitest';

function createStoreFactory(_id, options) {
  let instance = null;
  return () => {
    if (instance) return instance;
    instance = {
      ...(typeof options.state === 'function' ? options.state() : {}),
    };
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(instance, name, {
        enumerable: true,
        get() { return getter(instance); },
      });
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      instance[name] = action.bind(instance);
    }
    return instance;
  };
}

globalThis.Pinia = { defineStore: createStoreFactory };
globalThis.Vue = globalThis.Vue || {};
globalThis.window = globalThis.window || { addEventListener: vi.fn(), removeEventListener: vi.fn() };
globalThis.document = globalThis.document || { addEventListener: vi.fn(), removeEventListener: vi.fn() };
globalThis.localStorage = globalThis.localStorage || {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};

const { useChatStore } = await import('../../../web/stores/chat.js');

function freshStore() {
  const store = useChatStore();
  store.activeConversations = ['conv-a'];
  store.yeaftConversationId = 'conv-a';
  store.messagesMap = { 'conv-a': [] };
  store.subagents = {};
  store.activeSubagentId = null;
  store.yeaftSubAgentCards = {};
  return store;
}

describe('sub-agent output messages', () => {
  beforeEach(() => {
    freshStore();
  });

  it('keeps legacy sub-agent panel messages assistant-text-only and counts tools', () => {
    const store = freshStore();
    store.addSubagent('conv-a', { id: 'sub-1', slug: 'worker', type: 'Task' });
    store.activeSubagentId = 'sub-1';

    store.appendSubagentMessage('conv-a', 'sub-1', { type: 'tool', content: 'Read file', toolName: 'Read' });
    store.appendSubagentMessage('conv-a', 'sub-1', { type: 'text', content: 'assistant answer' });

    expect(store.subagents['conv-a']['sub-1'].toolCallCount).toBe(1);
    expect(store.subagents['conv-a']['sub-1'].messages).toEqual([
      { type: 'text', content: 'assistant answer' },
    ]);
    expect(store.activeSubagentMessages).toEqual([
      { type: 'text', content: 'assistant answer' },
    ]);
  });

  it('keeps Yeaft sub-agent cards assistant-text-only and stores compact tool counts', () => {
    const store = freshStore();

    store.handleYeaftOutput({
      conversationId: 'conv-a',
      sessionId: 'session-a',
      event: { type: 'sub_agent_event', agentId: 'sub-1', payload: { type: 'tool_call', name: 'FileRead', agentName: 'worker' } },
    });
    store.handleYeaftOutput({
      conversationId: 'conv-a',
      sessionId: 'session-a',
      event: { type: 'sub_agent_event', agentId: 'sub-1', payload: { type: 'tool_end', name: 'FileRead', agentName: 'worker' } },
    });
    store.handleYeaftOutput({
      conversationId: 'conv-a',
      sessionId: 'session-a',
      event: { type: 'sub_agent_event', agentId: 'sub-1', payload: { type: 'sub_agent_turn_end', content: 'final assistant answer', status: 'running', agentName: 'worker' } },
    });
    store.handleYeaftOutput({
      conversationId: 'conv-a',
      sessionId: 'session-a',
      event: { type: 'sub_agent_event', agentId: 'sub-1', payload: { type: 'sub_agent_turn_end', content: 'second assistant answer', status: 'completed', agentName: 'worker' } },
    });

    const card = store.yeaftSubAgentCards['conv-a:sub-1'];
    expect(card).toMatchObject({
      agentId: 'sub-1',
      agentName: 'worker',
      text: 'final assistant answer\n\nsecond assistant answer',
      toolCallCount: 1,
      turns: 2,
      status: 'completed',
    });
    expect(card.toolCalls).toBeUndefined();
  });
});
