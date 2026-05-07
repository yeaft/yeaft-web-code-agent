/**
 * vp-turn-detail-store.test.js — Task 4 of the VP quick-card plan.
 *
 * @vitest-environment happy-dom
 *
 * Pins the new `unifyOpenVpTurnDetail` state + its open/close actions on
 * the chat store. This is the right-side detail drawer descriptor used
 * when the user clicks a VpQuickCard in the main feed.
 *
 * Coexists with the older `unifyActiveVpDetailId` (center-column persona
 * view) — different dimension (turn-scoped vs vp-scoped), do not merge.
 *
 * Unit-only — captures the chat.js options object via a Pinia.defineStore
 * shim (same pattern as test/web/stores/chat-input-dispatch.test.js) and
 * invokes the actions against a hand-rolled `this`.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// chat.js does `const { defineStore } = Pinia;` against a global Pinia.
// Shim it so we capture the options object — that gives us direct
// access to the actions map and the initial state without a real Pinia.
let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  // The chat store has openVpTurnDetail in its actions map — capture it.
  // Other (smaller) stores imported transitively get a no-op stub.
  if (options && options.actions && options.actions.openVpTurnDetail) {
    capturedOptions = options;
  }
  return () => ({});
};

let actions;
let initialState;
beforeAll(async () => {
  await import('../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  actions = capturedOptions.actions;
  initialState = capturedOptions.state();
});

/** Minimal store-like `this` seeded from the captured initial state. */
function mkStore() {
  return { unifyOpenVpTurnDetail: initialState.unifyOpenVpTurnDetail };
}

describe('chat.js — unifyOpenVpTurnDetail', () => {
  it('starts at null', () => {
    expect(initialState.unifyOpenVpTurnDetail).toBeNull();
  });

  it('openVpTurnDetail sets the descriptor', () => {
    const store = mkStore();
    actions.openVpTurnDetail.call(store, { vpId: 'jobs', turnId: 't1' });
    expect(store.unifyOpenVpTurnDetail).toEqual({ vpId: 'jobs', turnId: 't1' });
  });

  it('closeVpTurnDetail resets to null', () => {
    const store = mkStore();
    actions.openVpTurnDetail.call(store, { vpId: 'jobs', turnId: 't1' });
    actions.closeVpTurnDetail.call(store);
    expect(store.unifyOpenVpTurnDetail).toBeNull();
  });

  it('openVpTurnDetail with another vpId/turnId switches detail target', () => {
    const store = mkStore();
    actions.openVpTurnDetail.call(store, { vpId: 'jobs', turnId: 't1' });
    actions.openVpTurnDetail.call(store, { vpId: 'wozniak', turnId: 't2' });
    expect(store.unifyOpenVpTurnDetail).toEqual({ vpId: 'wozniak', turnId: 't2' });
  });

  it('openVpTurnDetail ignores calls missing vpId or turnId', () => {
    const store = mkStore();
    actions.openVpTurnDetail.call(store, { vpId: 'jobs' });
    expect(store.unifyOpenVpTurnDetail).toBeNull();
    actions.openVpTurnDetail.call(store, { turnId: 't1' });
    expect(store.unifyOpenVpTurnDetail).toBeNull();
    actions.openVpTurnDetail.call(store, null);
    expect(store.unifyOpenVpTurnDetail).toBeNull();
  });

  it('whitelists payload to vpId+turnId only (rejects extra fields)', () => {
    const store = mkStore();
    actions.openVpTurnDetail.call(store, { vpId: 'a', turnId: 't1', foo: 1, hostile: true });
    expect(Object.keys(store.unifyOpenVpTurnDetail).sort()).toEqual(['turnId', 'vpId']);
    expect(store.unifyOpenVpTurnDetail.foo).toBeUndefined();
  });
});
