/**
 * yeaft-debug-history-routing.test.js — pins the messageHandler hydration
 * contract for the persistent SQLite trace replay.
 *
 * The agent emits `yeaft_debug_history` as a BARE top-level message
 * (`sendToServer({type:'yeaft_debug_history', ...})`), so the dispatcher
 * in `web/stores/helpers/messageHandler.js` MUST own the case. This test
 * also pins the merge keys (turnId, NOT id — the original implementation
 * had a silent C1-class bug that dropped every hydrated row) and the
 * live-loop preservation contract (loops captured between request and
 * reply must survive the merge instead of being clobbered).
 */
import { describe, it, expect, beforeEach } from 'vitest';

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
    _fetchYeaftDebugHistoryTimer: null,
    _lastPongAt: 0,
    yeaftDebugLoops: [],
    yeaftDebugTurnsById: {},
    yeaftDebugTurnOrder: [],
    yeaftDebugHistoryLoading: true,
    yeaftDebugHistoryError: null,
    yeaftDebugHistoryFetchedAt: 0,
    yeaftDreamEvents: {},
    yeaftDreamLatest: {},
    _appendDreamEvent(scope, event) {
      const prev = this.yeaftDreamEvents[scope] || [];
      this.yeaftDreamEvents = { ...this.yeaftDreamEvents, [scope]: [...prev, event] };
    },
    handleYeaftOutput(msg) {
      const event = msg?.event;
      if (!event || event.type !== 'dream_progress') return;
      const scope = event.groupId ? `group/${event.groupId}` : (event.target || '*');
      this.yeaftDreamLatest = { ...this.yeaftDreamLatest, [scope]: { phase: event.phase, status: event.phase === 'done' ? 'success' : 'running', finishedAt: event.phase === 'done' ? event.ts : null } };
    },
    addMessage() {},
  };
}

describe('messageHandler — yeaft_debug_history routing', () => {
  let store;
  beforeEach(() => {
    store = mkStore();
  });

  it('writes hydrated turns into yeaftDebugTurnsById keyed by turnId (not id)', () => {
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: [
        { turnId: 't1', loopNumber: 1, model: 'm', latencyMs: 10, usage: { totalTokens: 5 } },
      ],
      turns: [
        { turnId: 't1', userPrompt: 'hello', groupId: 'g1', vpId: 'vp1', threadId: 'thr_a', openedAt: 1, closedAt: 2, totalMs: 10, totalTokens: 5, loopCount: 1, tools: [] },
      ],
    });
    // C1 regression: the dispatcher MUST key off `turnId`. Keying off
    // `id` would store the record under literal "undefined" and the
    // panel selector would render nothing.
    expect(store.yeaftDebugTurnsById.t1).toBeTruthy();
    expect(store.yeaftDebugTurnsById.t1.userPrompt).toBe('hello');
    expect(store.yeaftDebugTurnsById.t1.threadId).toBe('thr_a');
    expect(store.yeaftDebugTurnOrder).toContain('t1');
    expect(store.yeaftDebugLoops).toHaveLength(1);
    expect(store.yeaftDebugLoops[0].turnId).toBe('t1');
    expect(store.yeaftDebugHistoryLoading).toBe(false);
  });

  it('preserves a live loop that arrived between request and reply (I1 regression)', () => {
    // Simulate the race: a live `loop` event already populated the store
    // with one loop while the network round-trip was in flight.
    store.yeaftDebugLoops = [
      { turnId: 't_live', loopNumber: 1, model: 'live', usage: { totalTokens: 99 } },
    ];
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: [
        { turnId: 't_hist', loopNumber: 1, model: 'hist', usage: { totalTokens: 5 } },
      ],
      turns: [
        { turnId: 't_hist', userPrompt: 'old', loopCount: 1 },
      ],
    });
    // The live loop must NOT be clobbered by the hydration payload.
    expect(store.yeaftDebugLoops).toHaveLength(2);
    const liveLoop = store.yeaftDebugLoops.find((l) => l.turnId === 't_live');
    expect(liveLoop).toBeTruthy();
    expect(liveLoop.model).toBe('live');
    expect(store.yeaftDebugLoops.find((l) => l.turnId === 't_hist')).toBeTruthy();
  });

  it('lets live-streamed turn detail win over hydrated stub (I1 regression — turns side)', () => {
    // A live `turn_open` populated this turn with richer detail
    // (memoryLoaded, tools) that the SQL row doesn't carry. The
    // hydrated copy is a stub that must NOT overwrite live data.
    store.yeaftDebugTurnsById = {
      t_overlap: {
        turnId: 't_overlap',
        userPrompt: 'live',
        memoryLoaded: ['live-mem'],
        tools: [{ name: 'Bash' }],
      },
    };
    store.yeaftDebugTurnOrder = ['t_overlap'];
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: [],
      turns: [
        { turnId: 't_overlap', userPrompt: 'old', memoryLoaded: null, tools: [] },
      ],
    });
    // Live richer detail wins.
    expect(store.yeaftDebugTurnsById.t_overlap.memoryLoaded).toEqual(['live-mem']);
    expect(store.yeaftDebugTurnsById.t_overlap.tools).toEqual([{ name: 'Bash' }]);
    expect(store.yeaftDebugTurnsById.t_overlap.userPrompt).toBe('live');
  });

  it('clears the inflight timeout so the misleading fallback notice never fires', () => {
    let firedTimes = 0;
    store._fetchYeaftDebugHistoryTimer = setTimeout(() => { firedTimes++; }, 0);
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: [],
      turns: [],
    });
    expect(store._fetchYeaftDebugHistoryTimer).toBeNull();
    return new Promise(resolve => setTimeout(() => {
      expect(firedTimes).toBe(0);
      resolve();
    }, 10));
  });

  it('defends against malformed payloads (non-array loops/turns)', () => {
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: 'oops',
      turns: null,
    });
    expect(store.yeaftDebugLoops).toEqual([]);
    expect(store.yeaftDebugTurnsById).toEqual({});
    expect(store.yeaftDebugTurnOrder).toEqual([]);
    expect(store.yeaftDebugHistoryLoading).toBe(false);
  });

  it('skips records missing turnId without throwing', () => {
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: [
        { turnId: 't1', loopNumber: 1 },
        { /* no turnId */ loopNumber: 2 },
      ],
      turns: [
        { turnId: 't1', userPrompt: 'kept' },
        { /* no turnId */ userPrompt: 'dropped' },
      ],
    });
    expect(Object.keys(store.yeaftDebugTurnsById)).toEqual(['t1']);
    expect(store.yeaftDebugTurnOrder).toEqual(['t1']);
  });

  it('hydrates persisted dream events into the Dream debug state', () => {
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: [],
      turns: [],
      dreamEvents: [
        { type: 'dream_progress', phase: 'triage', groupId: 'g1', ts: 100, at: 100 },
        { type: 'dream_progress', phase: 'done', ts: 200, at: 200 },
      ],
    });
    expect(store.yeaftDreamEvents['group/g1']).toHaveLength(1);
    expect(store.yeaftDreamEvents['*']).toHaveLength(1);
    expect(store.yeaftDreamLatest['group/g1']).toEqual(expect.objectContaining({ phase: 'triage' }));
    expect(store.yeaftDreamLatest['*']).toEqual(expect.objectContaining({ phase: 'done', status: 'success' }));
  });

  it('surfaces error string from agent into yeaftDebugHistoryError', () => {
    handleMessage(store, {
      type: 'yeaft_debug_history',
      loops: [],
      turns: [],
      error: 'db locked',
    });
    expect(store.yeaftDebugHistoryError).toBe('db locked');
  });
});
