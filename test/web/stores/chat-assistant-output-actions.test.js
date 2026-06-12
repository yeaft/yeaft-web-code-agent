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
});
