/**
 * Tests for message timestamp preservation and chronological sorting
 * (Bug 1: message accuracy when switching conversations).
 *
 * Bug: addMessageToConversation always used Date.now() as timestamp,
 * discarding the original message ts from the agent. History messages
 * loaded from the agent arrived with arrival-time timestamps rather
 * than their real creation time, causing display order issues.
 *
 * Fix:
 *   1. If msg.ts is present (ISO string from agent), use it.
 *   2. After push, sort Unify messages by timestamp.
 */
import { describe, it, expect } from 'vitest';
import { addMessageToConversation } from '../../../../web/stores/helpers/messages.js';

function mkStore(overrides = {}) {
  return {
    currentView: 'unify',
    unifyConversationId: 'conv-1',
    unifyActiveGroupFilter: null,
    _currentUnifyGroupId: null,
    _currentUnifyVpId: null,
    _currentUnifyTurnId: null,
    messagesMap: { 'conv-1': [] },
    ...overrides,
  };
}

describe('addMessageToConversation: timestamp from agent ts', () => {
  it('uses msg.ts as timestamp when present (ISO string)', () => {
    const store = mkStore();
    addMessageToConversation(store, 'conv-1', {
      type: 'user',
      content: 'hello',
      ts: '2026-05-01T10:00:00.000Z',
    });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(new Date('2026-05-01T10:00:00.000Z').getTime());
  });

  it('falls back to Date.now() when msg.ts is missing', () => {
    const before = Date.now();
    const store = mkStore();
    addMessageToConversation(store, 'conv-1', {
      type: 'user',
      content: 'hello',
    });
    const after = Date.now();
    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(msgs[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('falls back to Date.now() when msg.ts is null/undefined', () => {
    const store = mkStore();
    addMessageToConversation(store, 'conv-1', {
      type: 'user',
      content: 'hello',
      ts: null,
    });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(1);
    // null ts should fall back to Date.now(), so timestamp should be a recent number
    expect(typeof msgs[0].timestamp).toBe('number');
    expect(msgs[0].timestamp).toBeGreaterThan(0);
  });

  it('sorts messages by timestamp after push (chronological order)', () => {
    const store = mkStore();
    // Insert out of order: newest first, then older
    addMessageToConversation(store, 'conv-1', {
      type: 'user',
      content: 'msg3',
      ts: '2026-05-03T12:00:00.000Z',
    });
    addMessageToConversation(store, 'conv-1', {
      type: 'assistant',
      content: 'msg1',
      ts: '2026-05-01T10:00:00.000Z',
    });
    addMessageToConversation(store, 'conv-1', {
      type: 'user',
      content: 'msg2',
      ts: '2026-05-02T11:00:00.000Z',
    });

    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe('msg1'); // oldest
    expect(msgs[1].content).toBe('msg2'); // middle
    expect(msgs[2].content).toBe('msg3'); // newest
  });

  it('does NOT sort non-Unify conversations (crew conversation)', () => {
    const store = mkStore({ unifyConversationId: 'unify-conv' });
    // This is a crew conversation, not the Unify conversation
    addMessageToConversation(store, 'crew-conv', {
      type: 'user',
      content: 'msg3',
      ts: '2026-05-03T12:00:00.000Z',
    });
    addMessageToConversation(store, 'crew-conv', {
      type: 'user',
      content: 'msg1',
      ts: '2026-05-01T10:00:00.000Z',
    });

    const msgs = store.messagesMap['crew-conv'];
    expect(msgs).toHaveLength(2);
    // Should retain insertion order (msg3 first, msg1 second)
    expect(msgs[0].content).toBe('msg3');
    expect(msgs[1].content).toBe('msg1');
  });

  it('mixed ts and no-ts messages are still sorted correctly', () => {
    const store = mkStore();
    const now = Date.now();

    // Insert a message from 10 days ago
    const oldDate = new Date(now - 10 * 86400000);
    addMessageToConversation(store, 'conv-1', {
      type: 'user',
      content: 'old-msg',
      ts: oldDate.toISOString(),
    });

    // Insert a message with no ts (uses Date.now())
    addMessageToConversation(store, 'conv-1', {
      type: 'user',
      content: 'recent-msg',
      // no ts
    });

    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(2);
    // old-msg should come first (older timestamp)
    expect(msgs[0].content).toBe('old-msg');
    expect(msgs[1].content).toBe('recent-msg');
  });
});
