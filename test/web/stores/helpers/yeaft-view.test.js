/**
 * Tests for the Chat ↔ Yeaft view-transition helper.
 *
 * Background: a regression where Yeaft messages bled into the Chat view
 * after leaveYeaft. Root cause: enterYeaft unconditionally overwrote the
 * `_savedActiveConversations` snapshot with the CURRENT activeConversations,
 * even when the user was already in Yeaft view. So a second enterYeaft
 * call (e.g. switching agents, programmatic re-entry) saved the yeaft-only
 * array as if it were the original Chat state, and the next leaveYeaft
 * "restored" the yeaft conversationId into Chat's active list.
 *
 * The helper is idempotent: only the first Chat → Yeaft edge takes a
 * snapshot; redundant calls keep the existing one.
 */
import { describe, it, expect } from 'vitest';
import {
  applyEnterYeaftTransition,
  applyLeaveYeaftTransition,
} from '../../../../web/stores/helpers/yeaft-view.js';

function mkStore(overrides = {}) {
  return {
    currentView: 'chat',
    activeConversations: [],
    _savedActiveConversations: null,
    yeaftConversationId: 'yeaft-local-1',
    ...overrides,
  };
}

describe('applyEnterYeaftTransition', () => {
  it('on first Chat → Yeaft: snapshots activeConversations and swaps to yeaft id', () => {
    const store = mkStore({
      activeConversations: ['chat-1', 'chat-2'],
    });
    const fresh = applyEnterYeaftTransition(store);
    expect(fresh).toBe(true);
    expect(store._savedActiveConversations).toEqual(['chat-1', 'chat-2']);
    expect(store.activeConversations).toEqual(['yeaft-local-1']);
  });

  it('takes a snapshot even when chat side is empty', () => {
    const store = mkStore({ activeConversations: [] });
    const fresh = applyEnterYeaftTransition(store);
    expect(fresh).toBe(true);
    expect(store._savedActiveConversations).toEqual([]);
    expect(store.activeConversations).toEqual(['yeaft-local-1']);
  });

  it('snapshot is a copy (mutating the original does not affect the snapshot)', () => {
    const original = ['chat-a'];
    const store = mkStore({ activeConversations: original });
    applyEnterYeaftTransition(store);
    original.push('chat-b');
    expect(store._savedActiveConversations).toEqual(['chat-a']);
  });

  it('redundant call while already in Yeaft: does NOT overwrite the snapshot (regression guard)', () => {
    // This is the exact scenario that caused chat ↔ yeaft crosstalk.
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-1'],
    });
    // First entry — snapshots correctly.
    applyEnterYeaftTransition(store);
    store.currentView = 'yeaft'; // store flips after the helper, in real code
    expect(store._savedActiveConversations).toEqual(['chat-1']);
    expect(store.activeConversations).toEqual(['yeaft-local-1']);

    // Second entry while already in Yeaft (e.g. switching agents).
    const fresh = applyEnterYeaftTransition(store);
    expect(fresh).toBe(false);
    // Snapshot must STILL be the original Chat state, NOT the yeaft-only array.
    expect(store._savedActiveConversations).toEqual(['chat-1']);
    expect(store.activeConversations).toEqual(['yeaft-local-1']);
  });

  it('redundant call also tolerates the yeaftConversationId changing (e.g. session migration)', () => {
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-original'],
    });
    applyEnterYeaftTransition(store);
    store.currentView = 'yeaft';

    // Backend session_ready migrated the local convId to a real one.
    store.yeaftConversationId = 'yeaft-real-1';
    applyEnterYeaftTransition(store);

    expect(store._savedActiveConversations).toEqual(['chat-original']);
    expect(store.activeConversations).toEqual(['yeaft-real-1']);
  });
});

describe('applyLeaveYeaftTransition', () => {
  it('restores the snapshot and clears it', () => {
    const store = mkStore({
      activeConversations: ['yeaft-local-1'],
      _savedActiveConversations: ['chat-1', 'chat-2'],
    });
    applyLeaveYeaftTransition(store);
    expect(store.activeConversations).toEqual(['chat-1', 'chat-2']);
    expect(store._savedActiveConversations).toBeNull();
  });

  it('no-op when there is no snapshot (cold leave)', () => {
    const store = mkStore({
      activeConversations: ['something'],
      _savedActiveConversations: null,
    });
    applyLeaveYeaftTransition(store);
    expect(store.activeConversations).toEqual(['something']);
    expect(store._savedActiveConversations).toBeNull();
  });

  it('round-trip: enter → leave restores exactly the original list', () => {
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-A', 'chat-B'],
    });
    applyEnterYeaftTransition(store);
    store.currentView = 'yeaft';
    applyLeaveYeaftTransition(store);
    expect(store.activeConversations).toEqual(['chat-A', 'chat-B']);
    expect(store._savedActiveConversations).toBeNull();
  });

  it('round-trip with a redundant re-entry: still restores the original Chat list', () => {
    // The full bug scenario end-to-end on the helpers.
    const store = mkStore({
      currentView: 'chat',
      activeConversations: ['chat-A'],
    });
    applyEnterYeaftTransition(store);
    store.currentView = 'yeaft';
    // Redundant re-entry (used to corrupt the snapshot).
    applyEnterYeaftTransition(store);
    // Now leave.
    applyLeaveYeaftTransition(store);
    expect(store.activeConversations).toEqual(['chat-A']);
  });
});
