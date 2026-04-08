import { describe, it, expect } from 'vitest';
import { finishStreamingForConversation } from '../../web/stores/helpers/messages.js';

/**
 * Tests for task-249 follow-up: finishStreamingForConversation should finish
 * ALL streaming messages in the current turn, not just the last one.
 *
 * Bug: If a non-streaming message (chat-image, tool-use) is appended after
 * a streaming assistant message, the old code only checked the last message
 * and missed the buried streaming assistant message, leaving it stuck with
 * isStreaming: true.
 */

function createStore(conversationId, messages) {
  return {
    messagesMap: { [conversationId]: messages }
  };
}

describe('finishStreamingForConversation finishes all streaming messages', () => {
  it('finishes streaming message when last message is non-streaming (chat-image)', () => {
    const convId = 'conv-1';
    const store = createStore(convId, [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Response text', isStreaming: true },
      { type: 'chat-image', fileId: 'img-1', isStreaming: false }
    ]);

    finishStreamingForConversation(store, convId);

    expect(store.messagesMap[convId][1].isStreaming).toBe(false);
  });

  it('finishes multiple streaming messages in same turn', () => {
    const convId = 'conv-2';
    const store = createStore(convId, [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Part 1', isStreaming: true },
      { type: 'tool-use', toolName: 'Read', isStreaming: false },
      { type: 'assistant', content: 'Part 2', isStreaming: true }
    ]);

    finishStreamingForConversation(store, convId);

    expect(store.messagesMap[convId][1].isStreaming).toBe(false);
    expect(store.messagesMap[convId][3].isStreaming).toBe(false);
  });

  it('stops at user message boundary (does not affect previous turn)', () => {
    const convId = 'conv-3';
    const store = createStore(convId, [
      { type: 'assistant', content: 'Old turn', isStreaming: true },
      { type: 'user', content: 'New question' },
      { type: 'assistant', content: 'New response', isStreaming: true }
    ]);

    finishStreamingForConversation(store, convId);

    expect(store.messagesMap[convId][2].isStreaming).toBe(false);
    // Previous turn NOT touched
    expect(store.messagesMap[convId][0].isStreaming).toBe(true);
  });

  it('handles last message being the streaming one (backward compatible)', () => {
    const convId = 'conv-4';
    const store = createStore(convId, [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Response', isStreaming: true }
    ]);

    finishStreamingForConversation(store, convId);

    expect(store.messagesMap[convId][1].isStreaming).toBe(false);
  });

  it('handles empty message list gracefully', () => {
    const convId = 'conv-5';
    const store = createStore(convId, []);

    expect(() => finishStreamingForConversation(store, convId)).not.toThrow();
  });

  it('handles null conversationId gracefully', () => {
    const store = createStore('conv-6', []);
    expect(() => finishStreamingForConversation(store, null)).not.toThrow();
  });

  it('handles missing conversationId in messagesMap gracefully', () => {
    const store = { messagesMap: {} };
    expect(() => finishStreamingForConversation(store, 'nonexistent')).not.toThrow();
  });

  it('no-ops when no messages are streaming', () => {
    const convId = 'conv-7';
    const store = createStore(convId, [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Done', isStreaming: false },
      { type: 'chat-image', fileId: 'img-1', isStreaming: false }
    ]);

    finishStreamingForConversation(store, convId);

    expect(store.messagesMap[convId][1].isStreaming).toBe(false);
    expect(store.messagesMap[convId][2].isStreaming).toBe(false);
  });

  it('documents the old bug: last-only check misses buried streaming message', () => {
    const convId = 'conv-old';
    const msgs = [
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Response', isStreaming: true },
      { type: 'chat-image', fileId: 'img-1', isStreaming: false }
    ];

    // Old logic: only check last message
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.isStreaming) {
      lastMsg.isStreaming = false;
    }
    // Old logic missed the buried assistant message
    expect(msgs[1].isStreaming).toBe(true); // BUG: still streaming!

    // New logic fixes it
    const store = createStore(convId, msgs);
    finishStreamingForConversation(store, convId);
    expect(msgs[1].isStreaming).toBe(false); // FIXED
  });
});
