/**
 * yeaft-tool-stats-routing.test.js — regression for the silent-drop
 * bug fixed in this PR.
 *
 * The agent emits `yeaft_tool_stats` as a BARE top-level message
 * (`sendToServer({type:'yeaft_tool_stats', ...})`), so the
 * dispatcher in `web/stores/helpers/messageHandler.js` MUST own the
 * case. A prior implementation accidentally placed the case inside
 * `chat.js#handleYeaftOutput`'s inner `switch (event.type)`, which is
 * only reachable for messages wrapped in a `yeaft_output` envelope —
 * meaning the bare reply silently fell through the dispatcher and the
 * 10-second timeout in `fetchYeaftToolStats` always fired. This test
 * pins the routing contract so future refactors can't regress it.
 *
 * Unit-only: imports the helper directly and exercises it against a
 * hand-rolled store stub. No Vue, no Pinia, no WebSocket.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// Tests pull in messageHandler.js → auth.js which reads `Pinia` as a
// bare global (window.Pinia in production). Provide a minimal stub
// BEFORE the import so the module-level `const { defineStore } = Pinia`
// destructure doesn't ReferenceError.
globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({
    setSessionKey() {},
    reset() {},
    role: null,
  }),
};
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

const { handleMessage } = await import('../../../web/stores/helpers/messageHandler.js');

function mkStore() {
  return {
    _fetchYeaftToolStatsTimer: null,
    _lastPongAt: 0,
    yeaftToolStats: null,
    yeaftToolStatsLoading: true,
    // The dispatcher writes `_lastPongAt` unconditionally; everything
    // else lives behind specific switch cases we never hit.
    addMessage() {},
  };
}

describe('messageHandler — yeaft_tool_stats routing', () => {
  let store;
  beforeEach(() => {
    store = mkStore();
  });

  it('writes the agent-shaped reply into yeaftToolStats', () => {
    handleMessage(store, {
      type: 'yeaft_tool_stats',
      snapshot: {
        Bash: { callCount: 3, errorCount: 0, errorRate: 0, avgMs: 1200, p50Ms: 1000, p95Ms: 1800, lastCalledAt: '2026-05-16T12:31:52.326Z', lastError: null },
      },
      registered: ['Bash', 'Read', 'Edit'],
      unused: ['Read', 'Edit'],
    });
    expect(store.yeaftToolStats).toBeTruthy();
    expect(store.yeaftToolStats.snapshot.Bash.callCount).toBe(3);
    expect(store.yeaftToolStats.registered).toEqual(['Bash', 'Read', 'Edit']);
    expect(store.yeaftToolStats.unused).toEqual(['Read', 'Edit']);
    expect(store.yeaftToolStats.error).toBeNull();
    expect(store.yeaftToolStats.notice).toBeNull();
    expect(typeof store.yeaftToolStats.fetchedAt).toBe('number');
    expect(store.yeaftToolStatsLoading).toBe(false);
  });

  it('clears the inflight 10s timeout so the misleading fallback notice never fires', () => {
    let firedTimes = 0;
    store._fetchYeaftToolStatsTimer = setTimeout(() => { firedTimes++; }, 0);
    handleMessage(store, {
      type: 'yeaft_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
    });
    expect(store._fetchYeaftToolStatsTimer).toBeNull();
    // Allow any pending microtask/timer to fire — should NOT, since
    // the handler cleared it.
    return new Promise(resolve => setTimeout(() => {
      expect(firedTimes).toBe(0);
      resolve();
    }, 10));
  });

  it('accepts the server fast-fail shape (notice + empty snapshot)', () => {
    handleMessage(store, {
      type: 'yeaft_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
      notice: 'Agent is offline.',
    });
    expect(store.yeaftToolStats.notice).toBe('Agent is offline.');
    expect(store.yeaftToolStats.snapshot).toEqual({});
    expect(store.yeaftToolStatsLoading).toBe(false);
  });

  it('defends against malformed payloads (non-object snapshot, non-array lists)', () => {
    handleMessage(store, {
      type: 'yeaft_tool_stats',
      snapshot: 'oops',
      registered: 'oops',
      unused: null,
    });
    expect(store.yeaftToolStats.snapshot).toEqual({});
    expect(store.yeaftToolStats.registered).toEqual([]);
    expect(store.yeaftToolStats.unused).toEqual([]);
  });

  it('rejects array-shaped snapshot (typeof [] === "object" loophole)', () => {
    // Without the !Array.isArray guard, the drawer would call
    // Object.entries(['Bash', 'Read']) and render rows with numeric
    // names like "0" / "1" — weird and user-visible.
    handleMessage(store, {
      type: 'yeaft_tool_stats',
      snapshot: ['Bash', 'Read'],
      registered: [],
      unused: [],
    });
    expect(store.yeaftToolStats.snapshot).toEqual({});
  });
});
