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
