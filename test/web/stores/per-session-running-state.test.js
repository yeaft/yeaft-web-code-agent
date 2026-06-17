import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageData = new Map();

globalThis.localStorage = {
  getItem: vi.fn((key) => localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: vi.fn((key, value) => { localStorageData.set(key, String(value)); }),
  removeItem: vi.fn((key) => { localStorageData.delete(key); }),
};

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
globalThis.window = globalThis.window || { addEventListener: vi.fn(), removeEventListener: vi.fn() };
globalThis.document = globalThis.document || { addEventListener: vi.fn(), removeEventListener: vi.fn() };

const { useChatStore } = await import('../../../web/stores/chat.js');

function freshStore() {
  const store = useChatStore();
  store.currentView = 'chat';
  store.activeConversations = [];
  store.yeaftActiveSessionFilter = null;
  store.yeaftConversationId = null;
  store.processingConversations = {};
  store.compactStatus = null;
  store.yeaftProcessingSessions = {};
  store.activeVpTurns = {};
  store.stoppingVpTurnIds = {};
  store.messagesMap = {};
  store.sendWsMessage = vi.fn(() => true);
  return store;
}

describe('per-session running state', () => {
  beforeEach(() => {
    localStorageData.clear();
  });

  it('keeps Chat running state scoped to the active conversation', () => {
    const store = freshStore();
    store.activeConversations = ['chat-a'];
    store.processingConversations = { 'chat-a': true };

    expect(store.isProcessing).toBe(true);
    expect(store.isConversationProcessing('chat-a')).toBe(true);
    expect(store.isConversationProcessing('chat-b')).toBe(false);

    store.activeConversations = ['chat-b'];

    expect(store.isProcessing).toBe(false);
    expect(store.isConversationProcessing('chat-a')).toBe(true);
    expect(store.isConversationProcessing('chat-b')).toBe(false);
  });

  it('keeps Yeaft running state scoped to the selected session', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftProcessingSessions = { 'session-a': true };
    store.yeaftActiveSessionFilter = 'session-a';

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(false);

    store.yeaftActiveSessionFilter = 'session-b';

    expect(store.isProcessing).toBe(false);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);
    expect(store.isYeaftSessionProcessing('session-b')).toBe(false);
  });

  it('keeps Yeaft active while any VP turn in that session is unfinished', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftActiveSessionFilter = 'session-a';

    store.handleYeaftOutput({ event: { type: 'vp_turn_start', sessionId: 'session-a', vpId: 'vp-a', turnId: 'turn-a', ts: 1 } });
    store.handleYeaftOutput({ event: { type: 'vp_turn_start', sessionId: 'session-a', vpId: 'vp-b', turnId: 'turn-b', ts: 2 } });

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);

    store.handleYeaftOutput({ event: { type: 'vp_turn_end', sessionId: 'session-a', vpId: 'vp-a', turnId: 'turn-a', reason: 'end_turn' } });

    expect(store.isProcessing).toBe(true);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(true);

    store.handleYeaftOutput({ event: { type: 'vp_turn_end', sessionId: 'session-a', vpId: 'vp-b', turnId: 'turn-b', reason: 'end_turn' } });

    expect(store.isProcessing).toBe(false);
    expect(store.isYeaftSessionProcessing('session-a')).toBe(false);
  });

  it('keeps Chat compacting state scoped to the active conversation', () => {
    const store = freshStore();
    store.currentView = 'chat';
    store.activeConversations = ['chat-a'];
    store.compactStatus = { conversationId: 'chat-a', status: 'compacting', message: 'Compacting...' };

    expect(store.isConversationCompacting('chat-a')).toBe(true);
    expect(store.isConversationCompacting('chat-b')).toBe(false);

    store.activeConversations = ['chat-b'];

    expect(store.isConversationCompacting(store.activeConversationId)).toBe(false);
  });

  it('does not let Chat compacting state leak into Yeaft input state', () => {
    const store = freshStore();
    store.currentView = 'yeaft';
    store.yeaftConversationId = 'yeaft-conv';
    store.yeaftActiveSessionFilter = 'session-b';
    store.compactStatus = { conversationId: 'chat-a', status: 'compacting', message: 'Compacting...' };
    store.processingConversations = { 'chat-a': true };

    expect(store.isConversationCompacting('chat-a')).toBe(true);
    expect(store.isConversationCompacting(store.yeaftConversationId)).toBe(false);
    expect(store.isProcessing).toBe(false);

    store.yeaftProcessingSessions = { 'session-b': true };

    expect(store.isProcessing).toBe(true);
  });
});
