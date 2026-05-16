/**
 * unify-tool-stats-routing.test.js — regression for the silent-drop
 * bug fixed in this PR.
 *
 * The agent emits `unify_tool_stats` as a BARE top-level message
 * (`sendToServer({type:'unify_tool_stats', ...})`), so the
 * dispatcher in `web/stores/helpers/messageHandler.js` MUST own the
 * case. A prior implementation accidentally placed the case inside
 * `chat.js#handleUnifyOutput`'s inner `switch (event.type)`, which is
 * only reachable for messages wrapped in a `unify_output` envelope —
 * meaning the bare reply silently fell through the dispatcher and the
 * 10-second timeout in `fetchUnifyToolStats` always fired. This test
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
    _fetchUnifyToolStatsTimer: null,
    _lastPongAt: 0,
    unifyToolStats: null,
    unifyToolStatsLoading: true,
    // The dispatcher writes `_lastPongAt` unconditionally; everything
    // else lives behind specific switch cases we never hit.
    addMessage() {},
  };
}

describe('messageHandler — unify_tool_stats routing', () => {
  let store;
  beforeEach(() => {
    store = mkStore();
  });

  it('writes the agent-shaped reply into unifyToolStats', () => {
    handleMessage(store, {
      type: 'unify_tool_stats',
      snapshot: {
        Bash: { callCount: 3, errorCount: 0, errorRate: 0, avgMs: 1200, p50Ms: 1000, p95Ms: 1800, lastCalledAt: '2026-05-16T12:31:52.326Z', lastError: null },
      },
      registered: ['Bash', 'Read', 'Edit'],
      unused: ['Read', 'Edit'],
    });
    expect(store.unifyToolStats).toBeTruthy();
    expect(store.unifyToolStats.snapshot.Bash.callCount).toBe(3);
    expect(store.unifyToolStats.registered).toEqual(['Bash', 'Read', 'Edit']);
    expect(store.unifyToolStats.unused).toEqual(['Read', 'Edit']);
    expect(store.unifyToolStats.error).toBeNull();
    expect(store.unifyToolStats.notice).toBeNull();
    expect(typeof store.unifyToolStats.fetchedAt).toBe('number');
    expect(store.unifyToolStatsLoading).toBe(false);
  });

  it('clears the inflight 10s timeout so the misleading fallback notice never fires', () => {
    let firedTimes = 0;
    store._fetchUnifyToolStatsTimer = setTimeout(() => { firedTimes++; }, 0);
    handleMessage(store, {
      type: 'unify_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
    });
    expect(store._fetchUnifyToolStatsTimer).toBeNull();
    // Allow any pending microtask/timer to fire — should NOT, since
    // the handler cleared it.
    return new Promise(resolve => setTimeout(() => {
      expect(firedTimes).toBe(0);
      resolve();
    }, 10));
  });

  it('accepts the server fast-fail shape (notice + empty snapshot)', () => {
    handleMessage(store, {
      type: 'unify_tool_stats',
      snapshot: {},
      registered: [],
      unused: [],
      notice: 'Agent is offline.',
    });
    expect(store.unifyToolStats.notice).toBe('Agent is offline.');
    expect(store.unifyToolStats.snapshot).toEqual({});
    expect(store.unifyToolStatsLoading).toBe(false);
  });

  it('defends against malformed payloads (non-object snapshot, non-array lists)', () => {
    handleMessage(store, {
      type: 'unify_tool_stats',
      snapshot: 'oops',
      registered: 'oops',
      unused: null,
    });
    expect(store.unifyToolStats.snapshot).toEqual({});
    expect(store.unifyToolStats.registered).toEqual([]);
    expect(store.unifyToolStats.unused).toEqual([]);
  });
});
