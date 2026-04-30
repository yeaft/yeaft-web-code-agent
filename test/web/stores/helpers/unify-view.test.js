/**
 * Tests for the Chat ↔ Unify view-transition helper.
 *
 * Background: a regression where Unify messages bled into the Chat view
 * after leaveUnify. Root cause: enterUnify unconditionally overwrote the
 * `_savedActiveConversations` snapshot with the CURRENT activeConversations,
 * even when the user was already in Unify view. So a second enterUnify
 * call (e.g. switching agents, programmatic re-entry) saved the unify-only
 * array as if it were the original Chat state, and the next leaveUnify
 * "restored" the unify conversationId into Chat's active list.
 *
 * The helper is idempotent: only the first Chat → Unify edge takes a
 * snapshot; redundant calls keep the existing one.
 */
import { describe, it, expect } from 'vitest';
import {
  applyEnterUnifyTransition,
  applyLeaveUnifyTransition,
} from '../../../../web/stores/helpers/unify-view.js';

function mkStore(overrides = {}) {
  return {
    currentView: 'chat',
    activeConversations: [],
    _savedActiveConversations: null,
    unifyConversationId: 'unify-local-1',
    ...overrides,
  };
}

describe('applyEnterUnifyTransition', () => {
  it('on first Chat → Unify: snapshots activeConversations and swaps to unify id', () => {
    const store = mkStore({
      activeConversations: ['chat-1', 'chat-2'],
    });
    const fresh = applyEnterUnifyTransition(store);
    expect(fresh).toBe(true);
    expect(store._savedActiveConversations).toEqual(['chat-1', 'chat-2']);
    expect(store.activeConversations).toEqual(['unify-local-1']);
  });

  it('takes a snapshot even when chat side is empty', () => {
    const store = mkStore({ activeConversations: [] });
    const fresh = applyEnterUnifyTransition(store);
    expect(fresh).toBe(true);
    expect(store._savedActiveConversations).toEqual([]);
    expect(store.activeConversations).toEqual(['unify-local-1']);
  });

  it('snapshot is a copy (mutating the original does not affect the snapshot)', () => {
    const original = ['chat-a'];
    const store = mkStore({ activeConversations: original });
    applyEnterUnifyTransition(store);
    original.push('chat-b');
    expect(store._savedActiveConversations).toEqual(['chat-a']);
  });

  it('redundant call while already in Unify: does NOT overwrite the snapshot (regression guard)', () => {
    // This is the exact scenario that caused chat ↔ unify crosstalk.
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-1'],
    });
    // First entry — snapshots correctly.
    applyEnterUnifyTransition(store);
    store.currentView = 'unify'; // store flips after the helper, in real code
    expect(store._savedActiveConversations).toEqual(['chat-1']);
    expect(store.activeConversations).toEqual(['unify-local-1']);

    // Second entry while already in Unify (e.g. switching agents).
    const fresh = applyEnterUnifyTransition(store);
    expect(fresh).toBe(false);
    // Snapshot must STILL be the original Chat state, NOT the unify-only array.
    expect(store._savedActiveConversations).toEqual(['chat-1']);
    expect(store.activeConversations).toEqual(['unify-local-1']);
  });

  it('redundant call also tolerates the unifyConversationId changing (e.g. session migration)', () => {
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-original'],
    });
    applyEnterUnifyTransition(store);
    store.currentView = 'unify';

    // Backend session_ready migrated the local convId to a real one.
    store.unifyConversationId = 'unify-real-1';
    applyEnterUnifyTransition(store);

    expect(store._savedActiveConversations).toEqual(['chat-original']);
    expect(store.activeConversations).toEqual(['unify-real-1']);
  });
});

describe('applyLeaveUnifyTransition', () => {
  it('restores the snapshot and clears it', () => {
    const store = mkStore({
      activeConversations: ['unify-local-1'],
      _savedActiveConversations: ['chat-1', 'chat-2'],
    });
    applyLeaveUnifyTransition(store);
    expect(store.activeConversations).toEqual(['chat-1', 'chat-2']);
    expect(store._savedActiveConversations).toBeNull();
  });

  it('no-op when there is no snapshot (cold leave)', () => {
    const store = mkStore({
      activeConversations: ['something'],
      _savedActiveConversations: null,
    });
    applyLeaveUnifyTransition(store);
    expect(store.activeConversations).toEqual(['something']);
    expect(store._savedActiveConversations).toBeNull();
  });

  it('round-trip: enter → leave restores exactly the original list', () => {
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-A', 'chat-B'],
    });
    applyEnterUnifyTransition(store);
    store.currentView = 'unify';
    applyLeaveUnifyTransition(store);
    expect(store.activeConversations).toEqual(['chat-A', 'chat-B']);
    expect(store._savedActiveConversations).toBeNull();
  });

  it('round-trip with a redundant re-entry: still restores the original Chat list', () => {
    // The full bug scenario end-to-end on the helpers.
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-A'],
    });
    applyEnterUnifyTransition(store);
    store.currentView = 'unify';
    // Redundant re-entry (used to corrupt the snapshot).
    applyEnterUnifyTransition(store);
    // Now leave.
    applyLeaveUnifyTransition(store);
    expect(store.activeConversations).toEqual(['chat-A']);
  });
});
