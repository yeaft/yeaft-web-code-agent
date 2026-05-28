/**
 * chat-conversation-mode.test.js — Chat-mode message identity and loading.
 *
 * Chat and group/Unify use different message stores and wire verbs. A fix for
 * one mode must not make the other mode reuse cached rows or send through the
 * wrong path.
 */
import { describe, it, expect } from 'vitest';

// chat.js does `const { defineStore } = Pinia;` against a global Pinia.
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useChatStore } = await import('../../../web/stores/chat.js');

function makeStore() {
  const schema = useChatStore();
  const state = schema.state();
  const store = {
    ...state,
    sent: [],
    ws: { readyState: 1, send: () => {} },
  };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  store.sendWsMessage = function sendWsMessage(msg) { this.sent.push(msg); return true; };
  store.saveOpenSessions = () => {};
  store.addMessage = (msg) => {
    const convId = store.currentConversation;
    if (!convId) return;
    if (!store.messagesMap[convId]) store.messagesMap[convId] = [];
    store.messagesMap[convId].push(msg);
  };
  store.getOrCreateExecutionStatus = (convId) => {
    if (!store.executionStatusMap[convId]) {
      store.executionStatusMap[convId] = { currentTool: null, toolHistory: [], lastActivity: Date.now() };
    }
    return store.executionStatusMap[convId];
  };
  return store;
}

describe('Chat-mode conversation messages', () => {
  it('selecting a chat conversation requests authoritative chat history even when a stale cache exists', () => {
    const store = makeStore();
    store.currentView = 'chat';
    store.currentAgent = 'agent-1';
    store.agents = [{ id: 'agent-1', online: true }];
    store.conversations = [{ id: 'chat-1', agentId: 'agent-1', type: 'chat', workDir: '/repo' }];
    store.activeConversations = ['chat-other'];
    store.messagesMap = {
      'chat-1': [{ id: 'stale-local-row', type: 'assistant', content: 'old cache' }],
    };

    store.selectConversation('chat-1', 'agent-1');

    expect(store.currentView).toBe('chat');
    expect(store.activeConversations).toEqual(['chat-1']);
    expect(store.messagesMap['chat-1']).toEqual([]);
    expect(store.sent).toEqual([
      { type: 'select_conversation', conversationId: 'chat-1' },
      { type: 'sync_messages', conversationId: 'chat-1', turns: 5 },
    ]);
  });

  it('chat send uses the server chat verb and active chat conversation, not Unify group routing', () => {
    const store = makeStore();
    store.currentView = 'chat';
    store.currentAgent = 'agent-1';
    store.currentWorkDir = '/repo';
    store.activeConversations = ['chat-1'];
    store.conversations = [{ id: 'chat-1', agentId: 'agent-1', type: 'chat', workDir: '/repo' }];
    store.unifyConversationId = 'unify-1';
    store.unifyActiveGroupFilter = 'grp_fun';

    store.sendMessageToConversation('chat-1', 'hello chat', [], {});

    expect(store.sent).toHaveLength(1);
    expect(store.sent[0]).toEqual(expect.objectContaining({
      type: 'chat',
      prompt: 'hello chat',
      conversationId: 'chat-1',
      workDir: '/repo',
    }));
    expect(store.sent[0].type).not.toBe('unify_group_chat');
    expect(store.messagesMap['chat-1'].some(m => m.type === 'user' && m.content === 'hello chat')).toBe(true);
  });
});
