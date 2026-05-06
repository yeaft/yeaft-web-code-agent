/**
 * Regression test: chat-mode messages must NOT bleed into the open Unify
 * view, even when chat-mode WS handlers (conversation_resumed,
 * conversation_selected, agent_list restore, crew session restore) clobber
 * `activeConversations` while the user is sitting on the Unify page.
 *
 * Bug scenario:
 *   1. User is in Unify with `unifyConversationId = 'unify-conv-1'` and
 *      `activeConversations = ['unify-conv-1']`.
 *   2. A backgrounded chat WS event (e.g. conversation_resumed for an
 *      agent that was reconnecting) writes `activeConversations = ['chat-A']`
 *      without checking `currentView`.
 *   3. `store.messages` was sourcing from `activeConversations[0]` and
 *      thus started returning `messagesMap['chat-A']` — chat messages
 *      visibly leaked into the Unify view (and into `MessageList.js`'s
 *      turn aggregator + scroll watchers).
 *
 * Fix: when `currentView === 'unify'` the getter sources from
 * `unifyConversationId` instead. Chat-mode handlers can keep clobbering
 * activeConversations as before — the Unify view is no longer affected.
 *
 * This test exercises the getter logic directly with a synthetic state
 * shape (no Pinia / no Vue), mirroring the slice the real getter reads.
 */
import { describe, it, expect } from 'vitest';

// Reproduce the messages getter in isolation. If you change the
// production getter in web/stores/chat.js, mirror the change here so
// the regression contract stays explicit.
const EMPTY = Object.freeze([]);
function messagesGetter(state) {
  const convId = state.currentView === 'unify'
    ? state.unifyConversationId
    : state.activeConversations[0];
  const raw = convId ? (state.messagesMap[convId] || EMPTY) : EMPTY;
  if (state.currentView === 'unify' && state.unifyActiveGroupFilter) {
    const target = state.unifyActiveGroupFilter;
    return raw.filter(m => m && m.groupId === target);
  }
  return raw;
}

function mkState(overrides = {}) {
  return {
    currentView: 'chat',
    activeConversations: [],
    unifyConversationId: null,
    unifyActiveGroupFilter: null,
    messagesMap: {},
    ...overrides,
  };
}

describe('messages getter — chat/unify isolation', () => {
  it('chat view: sources from activeConversations[0] (existing behaviour)', () => {
    const state = mkState({
      currentView: 'chat',
      activeConversations: ['chat-A'],
      messagesMap: {
        'chat-A': [{ id: 'm1', content: 'hello' }],
        'unify-1': [{ id: 'u1', content: 'should not appear' }],
      },
    });
    expect(messagesGetter(state)).toEqual([{ id: 'm1', content: 'hello' }]);
  });

  it('unify view: sources from unifyConversationId, NOT activeConversations[0]', () => {
    // Simulates the bleed: a backgrounded chat handler wrote
    // activeConversations = ['chat-A'] while the user is in Unify.
    const state = mkState({
      currentView: 'unify',
      activeConversations: ['chat-A'],
      unifyConversationId: 'unify-1',
      messagesMap: {
        'chat-A': [{ id: 'leaked', content: 'CHAT LEAK' }],
        'unify-1': [
          { id: 'u1', content: 'unify msg', groupId: 'grp_default' },
        ],
      },
    });
    const out = messagesGetter(state);
    expect(out).toEqual([
      { id: 'u1', content: 'unify msg', groupId: 'grp_default' },
    ]);
    expect(out.find(m => m.id === 'leaked')).toBeUndefined();
  });

  it('unify view + group filter: still scoped to unify stream and filtered by groupId', () => {
    const state = mkState({
      currentView: 'unify',
      activeConversations: ['chat-A'],
      unifyConversationId: 'unify-1',
      unifyActiveGroupFilter: 'grp_alpha',
      messagesMap: {
        'chat-A': [{ id: 'leaked', content: 'CHAT LEAK', groupId: 'grp_alpha' }],
        'unify-1': [
          { id: 'u1', content: 'alpha', groupId: 'grp_alpha' },
          { id: 'u2', content: 'beta',  groupId: 'grp_beta'  },
        ],
      },
    });
    const out = messagesGetter(state);
    expect(out).toEqual([
      { id: 'u1', content: 'alpha', groupId: 'grp_alpha' },
    ]);
    // Even though the leaked chat message has groupId === 'grp_alpha',
    // it must NOT appear because the source list is unify-only.
    expect(out.find(m => m.id === 'leaked')).toBeUndefined();
  });

  it('unify view with no unifyConversationId: returns empty (does not fall back to chat)', () => {
    // Hardening: even if the unify session hasn't been initialised, we
    // refuse to fall back to activeConversations.
    const state = mkState({
      currentView: 'unify',
      activeConversations: ['chat-A'],
      unifyConversationId: null,
      messagesMap: { 'chat-A': [{ id: 'leaked' }] },
    });
    expect(messagesGetter(state)).toEqual([]);
  });

  it('returns the same EMPTY sentinel when there is no source convId (no churn)', () => {
    // The getter's stable-empty sentinel keeps Vue computed from
    // re-rendering on every call; verify both branches share it.
    const stateA = mkState({ currentView: 'chat', activeConversations: [] });
    const stateB = mkState({ currentView: 'unify', unifyConversationId: null });
    expect(messagesGetter(stateA)).toBe(messagesGetter(stateB));
  });
});

describe('messages getter — production source-of-truth assertion', () => {
  // Cheap integrity guard — if someone refactors the production getter
  // without updating this test, the substring assertion catches it.
  it('chat.js getter mirrors the view-aware source selection above', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../../../web/stores/chat.js', import.meta.url);
    const src = await fs.readFile(url, 'utf8');
    // The fix: convId selection branches on currentView === 'unify'
    expect(src).toMatch(/state\.currentView === 'unify'\s*\?\s*state\.unifyConversationId\s*:\s*state\.activeConversations\[0\]/);
  });
});
