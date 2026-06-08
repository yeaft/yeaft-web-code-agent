/**
 * Regression test — Yeaft messages that arrive while the user is on the
 * Chat view must still appear when the user switches back to Yeaft.
 *
 * Bug scenario (user report 2026-06-08):
 *   1. User in Yeaft Session A, VP starts a turn.
 *   2. User switches UI to Claude Chat (or another Yeaft Session).
 *   3. Agent finishes the VP turn while the user is away — `yeaft_output`
 *      envelopes are broadcast to all of this owner's webClients.
 *   4. User switches back to Yeaft Session A → UI is frozen on the
 *      state from before the switch. New messages are invisible until a
 *      full page refresh or force-re-fetch.
 *
 * Root cause: `helpers/messages.js#inActiveYeaftConv` used to gate on
 * `store.currentView === 'yeaft'`. The yeaft message arrival path in
 * `chat.js#handleYeaftOutput` still ran (server broadcasts to every
 * webClient by owner regardless of view), but `addMessageToConversation`
 * skipped the `sessionId` stamp because the predicate returned false.
 *
 * The `messages` getter in chat.js does a strict `m.sessionId === target`
 * filter, so any untagged row gets silently dropped on the way to
 * MessageList. To the user it looks like nothing arrived. Worse: the
 * delta cursor (chat.js:1201-1210) advanced past those orphan rows, so
 * `enterYeaft`'s `yeaft_load_history { afterSeq }` returned zero — the
 * server side reported "you're up to date" and the orphan rows never
 * got re-fetched.
 *
 * Fix: predicate keys off "is this the yeaft conversation id", not
 * "is the user currently looking at yeaft view". View is presentation;
 * data attribution is independent of it.
 *
 * Field rename note (msg.groupId → msg.sessionId, refactor sweep 2026-06-08):
 * the stamped field on every yeaft message is now `sessionId`. Tests
 * assert on the new name; the strict-equality getter slice below also
 * keys off `m.sessionId`. The agent / web-bridge wire field is
 * `sessionId` as well; legacy `groupId` is only accepted as a fallback
 * on the read side in helpers like `messageHandler.js` and `chat.js`.
 *
 * This test exercises the real production helper (not a reimplementation)
 * and the real getter slice from chat.js.
 */
import { describe, it, expect } from 'vitest';
import { addMessageToConversation } from '../../../web/stores/helpers/messages.js';

const EMPTY = Object.freeze([]);

// Slice mirroring chat.js#messages getter (the filter that was dropping
// untagged rows). Real call against the real `addMessageToConversation`
// upstream — only the getter is sliced.
function getMessages(state) {
  const convId = state.yeaftConversationId;
  const raw = convId ? (state.messagesMap[convId] || EMPTY) : EMPTY;
  if (state.currentView === 'yeaft' && state.yeaftActiveSessionFilter) {
    const target = state.yeaftActiveSessionFilter;
    return raw.filter((m) => m && m.sessionId === target);
  }
  return raw;
}

function mkStore(overrides = {}) {
  return {
    currentView: 'yeaft',
    yeaftConversationId: 'yeaft-conv-1',
    yeaftActiveSessionFilter: 'grp_alpha',
    _currentYeaftSessionId: null,
    _currentYeaftVpId: null,
    _currentYeaftTurnId: null,
    _currentYeaftThreadId: null,
    _currentYeaftThreadTitle: null,
    messagesMap: { 'yeaft-conv-1': [] },
    ...overrides,
  };
}

describe('yeaft view-switch — messages arriving while in Chat view still surface on switch-back', () => {
  it('reproduces the user scenario: chat-view arrival → switch back → message visible', () => {
    // User starts in Yeaft Session grp_alpha.
    const store = mkStore({ currentView: 'yeaft' });

    // First, a message arrives while user is on Yeaft view (baseline).
    store._currentYeaftSessionId = 'grp_alpha';
    addMessageToConversation(store, 'yeaft-conv-1', {
      type: 'assistant',
      content: 'first reply',
    });
    expect(getMessages(store).map((m) => m.content)).toEqual(['first reply']);

    // User switches to Claude Chat view.
    store.currentView = 'chat';

    // Agent finishes another VP turn while user is on Chat view. Server
    // broadcasts the `yeaft_output` envelope; `handleYeaftOutput` sets
    // the in-flight session id and calls addMessageToConversation with
    // the yeaft conversation id.
    store._currentYeaftSessionId = 'grp_alpha';
    addMessageToConversation(store, 'yeaft-conv-1', {
      type: 'assistant',
      content: 'background reply',
    });

    // User switches back to Yeaft.
    store.currentView = 'yeaft';

    // The background message must be visible. Pre-fix this returned
    // ['first reply'] only — the second row was stamped without a
    // sessionId because the predicate gated on currentView, and the
    // strict-equality filter in the messages getter dropped it.
    expect(getMessages(store).map((m) => m.content)).toEqual([
      'first reply',
      'background reply',
    ]);
    expect(store.messagesMap['yeaft-conv-1'][1].sessionId).toBe('grp_alpha');
  });

  it('stamps sessionId regardless of view, sourced from _currentYeaftSessionId', () => {
    // The send-context session id is what determines which session a
    // message belongs to, NOT the user's current filter — that way
    // background turns from a different session also land correctly.
    const store = mkStore({
      currentView: 'chat',
      yeaftActiveSessionFilter: 'grp_alpha',
      _currentYeaftSessionId: 'grp_beta',
    });
    addMessageToConversation(store, 'yeaft-conv-1', {
      type: 'assistant',
      content: 'beta reply',
    });
    expect(store.messagesMap['yeaft-conv-1'][0].sessionId).toBe('grp_beta');
  });

  it('falls back to yeaftActiveSessionFilter when no send-context is set (e.g. local echo)', () => {
    const store = mkStore({
      currentView: 'chat',
      _currentYeaftSessionId: null,
      yeaftActiveSessionFilter: 'grp_alpha',
    });
    addMessageToConversation(store, 'yeaft-conv-1', {
      type: 'user',
      content: 'hi',
    });
    expect(store.messagesMap['yeaft-conv-1'][0].sessionId).toBe('grp_alpha');
  });

  it('does NOT stamp yeaft sessionId on messages going to a non-yeaft conversation', () => {
    // Cross-conversation isolation — Chat conversation must not pick up
    // yeaft session metadata even when the yeaft routing context is set.
    const store = mkStore({
      currentView: 'chat',
      yeaftConversationId: 'yeaft-conv-1',
      _currentYeaftSessionId: 'grp_alpha',
      messagesMap: { 'chat-conv-A': [] },
    });
    addMessageToConversation(store, 'chat-conv-A', {
      type: 'assistant',
      content: 'chat reply',
    });
    expect(store.messagesMap['chat-conv-A'][0].sessionId).toBeUndefined();
  });

  it('does not double-stamp when caller already set sessionId explicitly', () => {
    const store = mkStore({
      currentView: 'chat',
      _currentYeaftSessionId: 'grp_alpha',
    });
    addMessageToConversation(store, 'yeaft-conv-1', {
      type: 'assistant',
      content: 'x',
      sessionId: 'grp_explicit',
    });
    expect(store.messagesMap['yeaft-conv-1'][0].sessionId).toBe('grp_explicit');
  });
});
