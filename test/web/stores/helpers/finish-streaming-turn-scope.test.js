/**
 * Tests for v0.1.768 streaming-stuck fixes in the message helpers.
 *
 * Bug guarded against:
 *   In Unify multi-VP fan-out, several VP turns stream concurrently inside
 *   the same conversation, each tagged with its own `turnId`. When VP-A's
 *   `result` fires the legacy blanket-clear in `finishStreamingForConversation`
 *   walked back across VP-B's still-streaming message and flipped its
 *   `isStreaming` flag too early. VP-B's next text_delta then forked a new
 *   message via the addMessage branch, leaving the original misflagged
 *   message as a permanent orphan — its VP showed "生成中" forever in the
 *   timeline.
 *
 * Two-part fix:
 *   1) `finishStreamingForConversation` scopes the walk-back to
 *      `_currentUnifyTurnId` so VP-A's result can only finish VP-A's
 *      messages.
 *   2) `sweepStaleStreamingForConversation` is a safety net: when both
 *      `processingConversations[convId]` and `activeVpTurns` are empty,
 *      sweep every leftover `isStreaming: true` flag in the conversation.
 *      This handles the case where a `result` was genuinely lost.
 */
import { describe, it, expect } from 'vitest';
import {
  finishStreamingForConversation,
  sweepStaleStreamingForConversation,
} from '../../../../web/stores/helpers/messages.js';

function mkStore(overrides = {}) {
  return {
    currentView: 'unify',
    unifyConversationId: 'conv-1',
    unifyActiveGroupFilter: null,
    _currentUnifyGroupId: null,
    _currentUnifyVpId: null,
    _currentUnifyTurnId: null,
    activeVpTurns: {},
    processingConversations: {},
    messagesMap: { 'conv-1': [] },
    ...overrides,
  };
}

describe('finishStreamingForConversation: per-turn isolation', () => {
  it("clears isStreaming only on messages tagged with the active turnId, leaving concurrent VP turns alone", () => {
    // Two concurrent fan-out streams. VP-A's result lands first; VP-B is
    // still mid-stream. The old blanket-clear walked into VP-B's message —
    // the fix scopes the walk to turnId.
    const store = mkStore({
      _currentUnifyTurnId: 'turn-a',
      messagesMap: {
        'conv-1': [
          { type: 'user', content: 'go' },
          { type: 'assistant', content: 'A streaming...', isStreaming: true, turnId: 'turn-a', vpId: 'vp-a' },
          { type: 'assistant', content: 'B streaming...', isStreaming: true, turnId: 'turn-b', vpId: 'vp-b' },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[1].isStreaming).toBe(false); // VP-A: cleared
    expect(msgs[2].isStreaming).toBe(true);  // VP-B: untouched
  });

  it("does not touch a streaming message tagged with a different turnId even if it is the LAST message", () => {
    // Critical regression scenario: VP-A finishes streaming AFTER VP-B
    // already created its later, still-streaming message. Walking from the
    // tail, the old code would have flipped VP-B's flag because it was the
    // first streaming assistant the walk encountered.
    const store = mkStore({
      _currentUnifyTurnId: 'turn-a',
      messagesMap: {
        'conv-1': [
          { type: 'user', content: 'go' },
          { type: 'assistant', content: 'A done text', isStreaming: true, turnId: 'turn-a', vpId: 'vp-a' },
          { type: 'assistant', content: 'B streaming', isStreaming: true, turnId: 'turn-b', vpId: 'vp-b' },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[1].isStreaming).toBe(false);
    expect(msgs[2].isStreaming).toBe(true);
  });

  it('stops at the user message turn fence and does not wander into older history', () => {
    const store = mkStore({
      _currentUnifyTurnId: 'turn-a',
      messagesMap: {
        'conv-1': [
          { type: 'assistant', content: 'older orphan', isStreaming: true, turnId: 'turn-x', vpId: 'vp-x' },
          { type: 'user', content: 'fence' },
          { type: 'assistant', content: 'A streaming', isStreaming: true, turnId: 'turn-a', vpId: 'vp-a' },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].isStreaming).toBe(true); // older orphan: NOT touched by per-turn pass
    expect(msgs[2].isStreaming).toBe(false); // current turn: cleared
  });

  it('legacy single-turn path (no _currentUnifyTurnId) keeps blanket-clear', () => {
    // Non-Unify chats never set _currentUnifyTurnId. The walk must still
    // clear every streaming message until the user turn fence.
    const store = mkStore({
      _currentUnifyTurnId: null,
      messagesMap: {
        'conv-1': [
          { type: 'user', content: 'q' },
          { type: 'assistant', content: 'text 1', isStreaming: true },
          { type: 'assistant', content: 'text 2', isStreaming: true },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[1].isStreaming).toBe(false);
    expect(msgs[2].isStreaming).toBe(false);
  });
});

describe('sweepStaleStreamingForConversation: gated orphan reaper', () => {
  it('clears every leftover isStreaming when both gates are open', () => {
    // No active per-VP turns AND no processing — safe to sweep.
    const store = mkStore({
      activeVpTurns: {},
      processingConversations: {},
      messagesMap: {
        'conv-1': [
          { type: 'user', content: 'q' },
          { type: 'assistant', content: 'orphan', isStreaming: true, turnId: 'lost-turn', vpId: 'vp-x' },
          { type: 'assistant', content: 'orphan2', isStreaming: true, turnId: 'lost-turn-2', vpId: 'vp-y' },
        ],
      },
    });
    sweepStaleStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[1].isStreaming).toBe(false);
    expect(msgs[2].isStreaming).toBe(false);
  });

  it('is a no-op when activeVpTurns is non-empty (concurrent VPs still running)', () => {
    const store = mkStore({
      activeVpTurns: { 'turn-b': { vpId: 'vp-b' } },
      processingConversations: {},
      messagesMap: {
        'conv-1': [
          { type: 'assistant', content: 'still-streaming', isStreaming: true, turnId: 'turn-b', vpId: 'vp-b' },
        ],
      },
    });
    sweepStaleStreamingForConversation(store, 'conv-1');
    expect(store.messagesMap['conv-1'][0].isStreaming).toBe(true);
  });

  it('is a no-op when processingConversations[convId] is truthy (chat-mode in flight)', () => {
    const store = mkStore({
      activeVpTurns: {},
      processingConversations: { 'conv-1': true },
      messagesMap: {
        'conv-1': [
          { type: 'assistant', content: 'streaming', isStreaming: true, turnId: 'turn-a', vpId: 'vp-a' },
        ],
      },
    });
    sweepStaleStreamingForConversation(store, 'conv-1');
    expect(store.messagesMap['conv-1'][0].isStreaming).toBe(true);
  });

  it('does not crash on empty / missing conversation', () => {
    const store = mkStore({ messagesMap: {} });
    expect(() => sweepStaleStreamingForConversation(store, 'conv-1')).not.toThrow();
    expect(() => sweepStaleStreamingForConversation(store, undefined)).not.toThrow();
  });

  it('preserves non-streaming flags (only touches isStreaming: true)', () => {
    const store = mkStore({
      activeVpTurns: {},
      processingConversations: {},
      messagesMap: {
        'conv-1': [
          { type: 'user', content: 'q' },
          { type: 'assistant', content: 'done', isStreaming: false, turnId: 'turn-a' },
          { type: 'assistant', content: 'orphan', isStreaming: true, turnId: 'lost' },
        ],
      },
    });
    sweepStaleStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[1].isStreaming).toBe(false);
    expect(msgs[2].isStreaming).toBe(false);
    // Non-streaming flag stayed false.
    expect(msgs[0].type).toBe('user');
  });
});
