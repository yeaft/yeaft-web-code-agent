/**
 * sync-messages-mid-turn.test.js — refresh-during-streaming guard.
 *
 * Bug: previously the Chat-mode refresh button was hidden via `v-if`
 * while a turn was streaming (processingConversations[convId] gate),
 * AND `refreshSession` blanked `messagesMap[convId]` before sending
 * `sync_messages`. Together that meant users couldn't reload history
 * mid-turn, and even if they could, the in-flight assistant partial
 * would be wiped.
 *
 * Fix:
 *   - ChatHeader.js: drop processingConversations from `canRefresh`
 *     and drop the `v-if` (button stays visible, just disabled while
 *     a refresh is already in flight).
 *   - refreshSession only blanks messagesMap when NO turn is active.
 *
 * The merge contract is: `handleSyncMessagesResult` dedups by
 * `dbMessageId`. The streaming partial has none (it gets a
 * dbMessageId only after `turn_completed` and a follow-up sync). So
 * passing the partial through the sync merge is safe — db rows that
 * are already present are skipped, and the partial survives.
 *
 * This file pins the merge invariant.
 */
import { describe, it, expect } from 'vitest';

// `conversationHandler.js` transitively imports `web/stores/auth.js`,
// which does `const { defineStore } = Pinia;` against a global Pinia
// (loaded via CDN in the browser). Shim it for Node-side tests.
globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};

const { handleSyncMessagesResult } = await import('../../../../web/stores/helpers/handlers/conversationHandler.js');
const { formatDbMessage } = await import('../../../../web/stores/helpers/messages.js');

function mkStore(initialMsgs = []) {
  return {
    messagesMap: { 'conv-1': [...initialMsgs] },
    activeConversations: ['conv-1'],
    hasMoreMessages: false,
    loadingMoreMessages: false,
    formatDbMessage,
    setRefreshingSession: () => {},
  };
}

describe('handleSyncMessagesResult — mid-turn refresh', () => {
  it('preserves the in-flight streaming partial when sync returns history', () => {
    // Streaming assistant partial — no dbMessageId yet, isStreaming true.
    const partial = {
      type: 'assistant',
      content: 'I am think',
      isStreaming: true,
    };
    const store = mkStore([partial]);

    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [
        { id: 10, role: 'user',      content: 'hello',       created_at: 1000 },
        { id: 11, role: 'assistant', content: 'first reply', created_at: 1100 },
      ],
      hasMore: false,
    });

    const result = store.messagesMap['conv-1'];
    // Partial is still there, content untouched.
    const surviving = result.find(m => m === partial);
    expect(surviving).toBeDefined();
    expect(surviving.content).toBe('I am think');
    expect(surviving.isStreaming).toBe(true);
    // Both DB rows landed.
    expect(result.some(m => m.dbMessageId === 10)).toBe(true);
    expect(result.some(m => m.dbMessageId === 11)).toBe(true);
  });

  it('does not duplicate db rows that were already in messagesMap', () => {
    // Conversation already had row 10 from an earlier sync.
    const existing = formatDbMessage({
      id: 10, role: 'user', content: 'hello', created_at: 1000,
    });
    const store = mkStore([existing]);

    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [
        { id: 10, role: 'user',      content: 'hello', created_at: 1000 },
        { id: 11, role: 'assistant', content: 'reply', created_at: 1100 },
      ],
      hasMore: false,
    });

    const result = store.messagesMap['conv-1'];
    // Row 10 not duplicated; row 11 added.
    expect(result.filter(m => m.dbMessageId === 10)).toHaveLength(1);
    expect(result.filter(m => m.dbMessageId === 11)).toHaveLength(1);
  });

  it('partial without dbMessageId is never dedup-collided (undefined !== undefined gate)', () => {
    // Two streaming partials would be a pathological case (Chat mode
    // only ever has one in-flight assistant), but the gate must still
    // hold: m.dbMessageId && msgs.some(...) — the leading truthy check
    // means undefined dbMessageIds never participate in dedup.
    const partial1 = { type: 'assistant', content: 'a', isStreaming: true };
    const partial2 = { type: 'assistant', content: 'b', isStreaming: true };
    const store = mkStore([partial1, partial2]);

    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [
        { id: 10, role: 'user', content: 'hello', created_at: 1000 },
      ],
      hasMore: false,
    });

    const result = store.messagesMap['conv-1'];
    expect(result.includes(partial1)).toBe(true);
    expect(result.includes(partial2)).toBe(true);
  });
});
