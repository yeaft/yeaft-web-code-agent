/**
 * load-more-chat-timeout.test.js — feat-chat-load-perf
 *
 * The chat-mode `loadMoreMessages` action (chat.js around line 3170) flips
 * `loadingMoreMessages = true` and dispatches a `sync_messages` envelope,
 * expecting the server to reply with `sync_messages_result` which clears
 * the spinner via `handleSyncMessagesResult`.
 *
 * Pre-fix, a dropped WS reply (reconnect mid-flight, server timeout,
 * agent crash) left `loadingMoreMessages` stuck on `true` forever and
 * the user saw an indefinite spinner — the "history load doesn't work
 * well" symptom in the original bug report.
 *
 * This test reproduces the action against a synthetic store object and
 * asserts:
 *   1. The action sets `loadingMoreMessages = true` and dispatches the
 *      expected WS envelope (sanity).
 *   2. After 10 seconds with no reply, the timer auto-clears
 *      `loadingMoreMessages` and the user can scroll to retry.
 *   3. The timer only clears state for the conversation that issued
 *      the call — switching conversations mid-flight does not touch
 *      the unrelated conversation's spinner state.
 *
 * Uses vitest fake timers so the 10s window doesn't actually slow the
 * suite down.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Re-implement the action body 1:1 from web/stores/chat.js#loadMoreMessages
// so we can drive it without booting Pinia. If you change one, change
// the other — keeping them in lock-step is what the review will scan.
function loadMoreMessages() {
  if (this.currentView === 'yeaft') return;
  if (this.loadingMoreMessages || !this.hasMoreMessages || !this.currentConversation) return;
  this.loadingMoreMessages = true;
  // Bump a per-call generation so a later setTimeout can recognise itself
  // as stale (a newer call has taken the flag back up since).
  const generation = (this._loadMoreGeneration = (this._loadMoreGeneration || 0) + 1);

  const msgs = this.messagesMap[this.currentConversation] || [];
  const firstMsgWithId = msgs.find(m => m.dbMessageId);
  const targetConvId = this.currentConversation;
  this.sendWsMessage({
    type: 'sync_messages',
    conversationId: targetConvId,
    turns: 5,
    ...(firstMsgWithId ? { beforeId: firstMsgWithId.dbMessageId } : {})
  });

  setTimeout(() => {
    if (this._loadMoreGeneration !== generation) return; // a newer call superseded us
    if (this.loadingMoreMessages && this.currentConversation === targetConvId) {
      this.loadingMoreMessages = false;
    }
  }, 10000);
}

function makeStore(overrides = {}) {
  const sent = [];
  return Object.assign({
    currentView: 'chat',
    currentConversation: 'conv-1',
    hasMoreMessages: true,
    loadingMoreMessages: false,
    messagesMap: { 'conv-1': [{ dbMessageId: 42, content: 'oldest visible' }] },
    sendWsMessage(msg) { sent.push(msg); },
    _sent: sent
  }, overrides);
}

describe('feat-chat-load-perf: chat loadMoreMessages timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips loadingMoreMessages and dispatches sync_messages with beforeId', () => {
    const store = makeStore();
    loadMoreMessages.call(store);

    expect(store.loadingMoreMessages).toBe(true);
    expect(store._sent).toEqual([{
      type: 'sync_messages',
      conversationId: 'conv-1',
      turns: 5,
      beforeId: 42
    }]);
  });

  it('clears stuck spinner after 10 seconds when no reply arrives', () => {
    const store = makeStore();
    loadMoreMessages.call(store);
    expect(store.loadingMoreMessages).toBe(true);

    // Advance just under the budget — spinner should still be up.
    vi.advanceTimersByTime(9_999);
    expect(store.loadingMoreMessages).toBe(true);

    // Cross the 10s threshold — timeout fires, spinner clears.
    vi.advanceTimersByTime(2);
    expect(store.loadingMoreMessages).toBe(false);
  });

  it('does not clear spinner if a fresh request superseded the stale timer', () => {
    const store = makeStore();
    loadMoreMessages.call(store);
    expect(store.loadingMoreMessages).toBe(true);
    const firstGeneration = store._loadMoreGeneration;

    // First WS reply lands quickly — handler clears the spinner.
    // (Simulated by jumping 200ms forward and flipping the flag.)
    vi.advanceTimersByTime(200);
    store.loadingMoreMessages = false;

    // User scrolls again — second call bumps the generation and re-arms
    // a brand-new 10s timer (T2) starting from now (200ms in). The old
    // timer T1 from the first call is still scheduled at t=10s; it must
    // NOT clobber T2's spinner when it fires at t=10s while T2's reply
    // is still in flight (T2's own deadline is t=10.2s).
    loadMoreMessages.call(store);
    expect(store.loadingMoreMessages).toBe(true);
    expect(store._loadMoreGeneration).toBe(firstGeneration + 1);

    // Advance to just past T1's 10s deadline (now at t = 200 + 9801 = 10001ms,
    // which is past 10s mark relative to start). T1's closure captured
    // generation=1; current generation is 2, so it short-circuits before
    // touching loadingMoreMessages — the bug under test would clear it here.
    vi.advanceTimersByTime(9_801);
    expect(store.loadingMoreMessages).toBe(true); // ← MUST stay true

    // T2's own 10s deadline (armed at t=200ms) fires at t=10200ms. We're
    // currently at t=10001ms; advance another 200ms to cross T2's deadline.
    // At that point no fresher call has superseded T2, so it correctly
    // clears the still-stuck spinner.
    vi.advanceTimersByTime(200);
    expect(store.loadingMoreMessages).toBe(false);
  });

  it('does not touch unrelated conversation when switched mid-flight', () => {
    const store = makeStore();
    loadMoreMessages.call(store);
    expect(store.loadingMoreMessages).toBe(true);

    // User switches to a different conversation before the reply.
    store.currentConversation = 'conv-2';
    store.loadingMoreMessages = true; // pretend the new conv has its own load-more in flight

    vi.advanceTimersByTime(11_000);
    // The timer captured `targetConvId = 'conv-1'`. currentConversation
    // is now 'conv-2', so the guard short-circuits — we leave the
    // unrelated conv-2 spinner untouched.
    expect(store.loadingMoreMessages).toBe(true);
  });

  it('does nothing if guards fail (yeaft, no hasMoreMessages, no currentConversation, already loading)', () => {
    const yeaftStore = makeStore({ currentView: 'yeaft' });
    loadMoreMessages.call(yeaftStore);
    expect(yeaftStore.loadingMoreMessages).toBe(false);
    expect(yeaftStore._sent.length).toBe(0);

    const noMoreStore = makeStore({ hasMoreMessages: false });
    loadMoreMessages.call(noMoreStore);
    expect(noMoreStore.loadingMoreMessages).toBe(false);
    expect(noMoreStore._sent.length).toBe(0);

    const noConvStore = makeStore({ currentConversation: null });
    loadMoreMessages.call(noConvStore);
    expect(noConvStore.loadingMoreMessages).toBe(false);
    expect(noConvStore._sent.length).toBe(0);

    const busyStore = makeStore({ loadingMoreMessages: true });
    loadMoreMessages.call(busyStore);
    // The flag was already true; the action should not re-fire the
    // WS message.
    expect(busyStore._sent.length).toBe(0);
  });
});
