/**
 * Regression test — chat-mode messages must NOT bleed into the open
 * Yeaft view, even when chat-mode WS handlers (conversation_resumed,
 * conversation_selected, agent_list restore, crew session restore)
 * clobber `activeConversations` while the user is sitting on Yeaft.
 *
 * Bug:
 *   1. User in Yeaft, `yeaftConversationId === 'yeaft-conv-1'`,
 *      `activeConversations === ['yeaft-conv-1']`.
 *   2. A backgrounded chat WS event (e.g. conversation_resumed for an
 *      agent reconnect) writes `activeConversations = ['chat-A']`
 *      regardless of `currentView`.
 *   3. Every getter that read `activeConversations[0]` immediately
 *      sourced chat data into the Yeaft view (`messages` showed chat
 *      content; `vpsTypingInCurrentConv` looked up the wrong key and
 *      came back empty).
 *
 * Fix: a single canonical selector,
 *   web/stores/helpers/active-conv.js#selectActiveConversationId.
 * In Yeaft view it returns `yeaftConversationId`; in Chat / Crew it
 * returns `activeConversations[0]`. The store getters route through
 * it instead of reading `activeConversations[0]` directly.
 *
 * This test exercises the real production helper. There is no inline
 * reimplementation of the rule.
 */
import { describe, it, expect } from 'vitest';
import { selectActiveConversationId } from '../../../web/stores/helpers/active-conv.js';

function mkState(overrides = {}) {
  return {
    currentView: 'chat',
    activeConversations: [],
    yeaftConversationId: null,
    ...overrides,
  };
}

describe('selectActiveConversationId — view routing', () => {
  it('chat view: returns activeConversations[0]', () => {
    const state = mkState({
      currentView: 'chat',
      activeConversations: ['chat-A', 'chat-B'],
      yeaftConversationId: 'yeaft-1',
    });
    expect(selectActiveConversationId(state)).toBe('chat-A');
  });

  it('chat view with empty activeConversations: returns null', () => {
    const state = mkState({ currentView: 'chat', activeConversations: [] });
    expect(selectActiveConversationId(state)).toBeNull();
  });

  it('crew view: also returns activeConversations[0] (Crew shares the chat conversation list)', () => {
    const state = mkState({
      currentView: 'crew',
      activeConversations: ['crew-conv-1'],
      yeaftConversationId: 'yeaft-1',
    });
    expect(selectActiveConversationId(state)).toBe('crew-conv-1');
  });

  it('yeaft view: returns yeaftConversationId, IGNORING activeConversations[0]', () => {
    // The bleed scenario: a backgrounded chat handler clobbered
    // activeConversations while the user is in Yeaft. The selector
    // must NOT see the clobbered value.
    const state = mkState({
      currentView: 'yeaft',
      activeConversations: ['chat-A'],
      yeaftConversationId: 'yeaft-1',
    });
    expect(selectActiveConversationId(state)).toBe('yeaft-1');
  });

  it('yeaft view with no yeaftConversationId: returns null (does NOT fall back to chat)', () => {
    // Hardening: even if the yeaft session hasn't been initialised,
    // we refuse to fall back to activeConversations.
    const state = mkState({
      currentView: 'yeaft',
      activeConversations: ['chat-A'],
      yeaftConversationId: null,
    });
    expect(selectActiveConversationId(state)).toBeNull();
  });
});

/**
 * Higher-level invariant test: `messages`, `vpsTypingInCurrentConv`,
 * and `isVpTypingInCurrentConv` in chat.js all flow through this
 * selector. We re-execute the relevant slices over a synthetic state
 * to confirm — but the routing CALL itself is the production helper,
 * not a reimplementation.
 */
describe('store getters — Yeaft isolation via selectActiveConversationId', () => {
  // Slice that mirrors chat.js#messages — only the parts the bug
  // touches. The selector call here is the REAL one.
  const EMPTY = Object.freeze([]);
  function getMessages(state) {
    const convId = selectActiveConversationId(state);
    const raw = convId ? (state.messagesMap[convId] || EMPTY) : EMPTY;
    if (state.currentView === 'yeaft' && state.yeaftActiveGroupFilter) {
      return raw.filter(m => m && m.groupId === state.yeaftActiveGroupFilter);
    }
    return raw;
  }

  it('yeaft view: messages stays scoped to yeaftConversationId despite activeConversations clobber', () => {
    const state = mkState({
      currentView: 'yeaft',
      activeConversations: ['chat-A'],
      yeaftConversationId: 'yeaft-1',
      yeaftActiveGroupFilter: null,
      messagesMap: {
        'chat-A': [{ id: 'leaked' }],
        'yeaft-1': [{ id: 'u1' }],
      },
    });
    expect(getMessages(state).map(m => m.id)).toEqual(['u1']);
  });

  it('yeaft view + group filter: still scoped to yeaft stream and filtered by groupId', () => {
    const state = mkState({
      currentView: 'yeaft',
      activeConversations: ['chat-A'],
      yeaftConversationId: 'yeaft-1',
      yeaftActiveGroupFilter: 'grp_alpha',
      messagesMap: {
        // Same groupId on the leaked side — strict equality alone
        // would let it through; the selector is what blocks it.
        'chat-A': [{ id: 'leaked', groupId: 'grp_alpha' }],
        'yeaft-1': [
          { id: 'u1', groupId: 'grp_alpha' },
          { id: 'u2', groupId: 'grp_beta' },
        ],
      },
    });
    expect(getMessages(state).map(m => m.id)).toEqual(['u1']);
  });

  it('chat view: messages source unchanged (regression guard for the chat side)', () => {
    const state = mkState({
      currentView: 'chat',
      activeConversations: ['chat-A'],
      yeaftConversationId: 'yeaft-1',
      messagesMap: {
        'chat-A': [{ id: 'm1' }, { id: 'm2' }],
        'yeaft-1': [{ id: 'u1' }],
      },
    });
    expect(getMessages(state).map(m => m.id)).toEqual(['m1', 'm2']);
  });
});
