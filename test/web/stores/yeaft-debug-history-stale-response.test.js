import { describe, expect, it } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({
  ...(options.state ? options.state() : {}),
  ...(options.actions || {}),
});
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { handleMessage } = await import('../../../web/stores/helpers/messageHandler.js');

function makeDebugStore() {
  return {
    _lastPongAt: 0,
    _fetchYeaftDebugHistoryTimer: null,
    _yeaftDebugHistoryInFlightKey: 'list-b',
    _yeaftDebugHistoryLatestListRequestId: 'req-b',
    yeaftDebugLoops: [],
    yeaftDebugTurnsById: {},
    yeaftDebugTurnOrder: [],
    yeaftDebugHistoryHasMore: false,
    yeaftDebugHistoryLimit: 10,
    yeaftDebugHistoryLoading: true,
    yeaftDebugHistoryError: null,
    yeaftDebugHistoryFetchedAt: 0,
  };
}

describe('Yeaft debug history stale response guard', () => {
  it('accepts the latest list response and ignores an older list response that arrives after success', () => {
    const store = makeDebugStore();

    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'req-b',
      requestKind: 'list',
      turns: [{ turnId: 'turn-b', userPrompt: 'new search result' }],
      loops: [],
      limit: 10,
      indexOnly: true,
    });

    expect(store.yeaftDebugTurnOrder).toEqual(['turn-b']);
    expect(store.yeaftDebugTurnsById['turn-b']).toMatchObject({ userPrompt: 'new search result' });
    expect(store._yeaftDebugHistoryLatestListRequestId).toBe('req-b');

    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'req-a',
      requestKind: 'list',
      turns: [{ turnId: 'turn-a', userPrompt: 'old search result' }],
      loops: [],
      limit: 10,
      indexOnly: true,
    });

    expect(store.yeaftDebugTurnOrder).toEqual(['turn-b']);
    expect(store.yeaftDebugTurnsById['turn-a']).toBeUndefined();
    expect(store._yeaftDebugHistoryLatestListRequestId).toBe('req-b');
  });

  it('defensively caps default list responses to the newest single turn', () => {
    const store = makeDebugStore();
    store.yeaftDebugTurnsById = { stale: { turnId: 'stale', userPrompt: 'old cached row' } };
    store.yeaftDebugTurnOrder = ['stale'];
    store.yeaftDebugLoops = [{ turnId: 'stale', loopNumber: 1, response: 'old' }];
    const turns = Array.from({ length: 8 }, (_, i) => ({ turnId: `turn-${i}`, userPrompt: `prompt ${i}` }));

    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'req-b',
      requestKind: 'list',
      turns,
      loops: turns.map((turn, i) => ({ turnId: turn.turnId, loopNumber: 1, response: `response ${i}` })),
      limit: 999,
      indexOnly: false,
    });

    expect(store.yeaftDebugTurnOrder).toEqual(['turn-7']);
    expect(Object.keys(store.yeaftDebugTurnsById)).toEqual(['turn-7']);
    expect(store.yeaftDebugLoops.map(loop => loop.turnId)).toEqual(['turn-7']);
    expect(store.yeaftDebugHistoryLimit).toBe(1);
    expect(store.yeaftDebugHistoryHasMore).toBe(true);
  });

  it('keeps search responses capped to five turns', () => {
    const store = makeDebugStore();
    const turns = Array.from({ length: 8 }, (_, i) => ({ turnId: `turn-${i}`, userPrompt: `prompt ${i}` }));

    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'req-b',
      requestKind: 'list',
      search: 'prompt',
      turns,
      loops: [],
      limit: 999,
      indexOnly: true,
    });

    expect(store.yeaftDebugTurnOrder).toEqual(['turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7']);
    expect(store.yeaftDebugHistoryLimit).toBe(5);
  });

  it('allows detail responses to bypass the list/search request id guard', () => {
    const store = makeDebugStore();
    store.yeaftDebugTurnsById = { 'turn-b': { turnId: 'turn-b', userPrompt: 'new search result' } };
    store.yeaftDebugTurnOrder = ['turn-b'];

    handleMessage(store, {
      type: 'yeaft_debug_history',
      requestId: 'req-a',
      requestKind: 'detail',
      detailTurnId: 'turn-a',
      turns: [{ turnId: 'turn-a', userPrompt: 'detail backfill', detailsLoaded: true }],
      loops: [],
      limit: 1,
      indexOnly: false,
    });

    expect(store.yeaftDebugTurnOrder).toEqual(['turn-b', 'turn-a']);
    expect(store.yeaftDebugTurnsById['turn-a']).toMatchObject({ userPrompt: 'detail backfill' });
    expect(store._yeaftDebugHistoryLatestListRequestId).toBe('req-b');
  });
});
