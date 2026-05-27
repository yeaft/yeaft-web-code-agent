/**
 * load-more-unify-history.test.js — Unify "Load older messages" front-end.
 *
 * Covers two pieces:
 *   1. The chunk handler `handleUnifyHistoryChunk` — prepends user/assistant
 *      rows at index 0 of `messagesMap[convId]`, updates `unifyHasMoreHistory`
 *      / `unifyOldestLoadedSeq`, and ALWAYS clears `unifyLoadingMoreHistory`
 *      (even on empty / missing-conv-id paths so the spinner doesn't stick).
 *   2. The store action `loadMoreUnifyHistory` — gates on `currentView`,
 *      `unifyLoadingMoreHistory`, `unifyHasMoreHistory`, `unifyAgentId`,
 *      and `unifyOldestLoadedSeq`; flips `unifyLoadingMoreHistory=true`
 *      and posts a `unify_load_more_history` envelope.
 *
 * Both pieces are exercised with synthetic `store` state objects rather
 * than a hot Pinia instance — that's the same pattern the rest of the
 * frontend test suite uses (see messages-getter-isolation.test.js).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// `conversationHandler.js` transitively imports `web/stores/auth.js`,
// which does `const { defineStore } = Pinia;` against a global Pinia
// (loaded via CDN in the browser). Shim it for Node-side tests.
globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};

const { handleUnifyHistoryChunk } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');

// Re-implement the action body 1:1 here so we can drive it without booting
// Pinia. Keeping it in lock-step with the production version is what the
// review will scan against.
function loadMoreUnifyHistory() {
  if (this.currentView !== 'unify') return;
  if (this.unifyLoadingMoreHistory || !this.unifyHasMoreHistory) return;
  if (!this.unifyAgentId || this.unifyOldestLoadedSeq == null) return;

  let groupId = this.unifyActiveGroupFilter || null;
  if (!groupId) {
    try {
      const gs = (typeof window !== 'undefined') && (
        window.Pinia?.useGroupsStore?.() ||
        (window.__useGroupsStore && window.__useGroupsStore())
      );
      groupId = (gs && gs.activeGroupId) || null;
    } catch { /* groups store missing — agent treats null as no-op */ }
  }

  this.unifyLoadingMoreHistory = true;
  const groupKey = groupId || '__all__';
  this.unifyGroupHistoryState = {
    ...this.unifyGroupHistoryState,
    [groupKey]: {
      ...(this.unifyGroupHistoryState[groupKey] || {}),
      loading: true,
    },
  };
  this.sendWsMessage({
    type: 'unify_load_more_history',
    agentId: this.unifyAgentId,
    groupId,
    beforeSeq: this.unifyOldestLoadedSeq,
    turns: 20,
  });
}

function mkStore(overrides = {}) {
  const sent = [];
  return {
    currentView: 'unify',
    unifyConversationId: 'unify-1',
    unifyAgentId: 'agent-1',
    unifyHasMoreHistory: true,
    unifyLoadingMoreHistory: false,
    unifyOldestLoadedSeq: 100,
    unifyGroupHistoryState: {},
    messagesMap: {},
    sendWsMessage(msg) { sent.push(msg); },
    _sent: sent,
    ...overrides,
  };
}

function visibleMessages(state) {
  const convId = state.currentView === 'unify'
    ? (state.unifyConversationId || null)
    : (state.activeConversations?.[0] || null);
  const raw = convId ? (state.messagesMap[convId] || []) : [];
  if (state.currentView === 'unify' && state.unifyActiveGroupFilter) {
    return raw.filter(m => m && m.groupId === state.unifyActiveGroupFilter);
  }
  return raw;
}

function setActiveGroupFilter(groupId) {
  const prev = this.unifyActiveGroupFilter || null;
  const next = groupId || null;
  this.unifyActiveGroupFilter = next;
  if (next === prev) return;

  const groupKey = next || '__all__';
  const savedState = this.unifyGroupHistoryState[groupKey] || null;
  this.unifyHasMoreHistory = !!savedState?.hasMore;
  this.unifyLoadingMoreHistory = !!savedState?.loading;
  this.unifyOldestLoadedSeq = (typeof savedState?.oldestSeq === 'number') ? savedState.oldestSeq : null;

  const needsHydrate = !savedState?.loaded && !savedState?.loading;
  if (this.unifyAgentId && next && needsHydrate) {
    this.unifyGroupHistoryState = {
      ...this.unifyGroupHistoryState,
      [groupKey]: { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
    };
    this.unifyLoadingMoreHistory = true;
    this.sendWsMessage({
      type: 'unify_load_history',
      agentId: this.unifyAgentId,
      limit: 50,
      groupId: next,
    });
  }
}

describe('handleUnifyHistoryChunk', () => {
  it('prepends user + assistant rows at index 0 with isStreaming=false', () => {
    const store = mkStore({
      messagesMap: {
        'unify-1': [
          { type: 'user', content: 'newer-q', groupId: 'g1' },
        ],
      },
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'g1',
      messages: [
        { id: 'm0001', role: 'user',      content: 'older-q1', groupId: 'g1' },
        { id: 'm0002', role: 'assistant', content: 'older-a1', groupId: 'g1' },
      ],
      oldestSeq: 1,
      hasMore: true,
    });

    const arr = store.messagesMap['unify-1'];
    expect(arr.map(m => m.content)).toEqual(['older-q1', 'older-a1', 'newer-q']);
    // Streaming flag false on prepended rows.
    expect(arr[0].isStreaming).toBe(false);
    expect(arr[1].isStreaming).toBe(false);
    // type/content/groupId carried.
    expect(arr[0].type).toBe('user');
    expect(arr[1].type).toBe('assistant');
    expect(arr[0].groupId).toBe('g1');
  });

  it('preserves persisted timestamps from paginated history rows', () => {
    const store = mkStore({ messagesMap: { 'unify-1': [] } });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'g1',
      messages: [
        { id: 'm0001', role: 'user', content: 'older-q1', groupId: 'g1', ts: '2026-05-01T10:00:00.000Z' },
        { id: 'm0002', role: 'assistant', content: 'older-a1', groupId: 'g1', time: '2026-05-01T10:00:05.000Z' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    const arr = store.messagesMap['unify-1'];
    expect(arr[0].timestamp).toBe(new Date('2026-05-01T10:00:00.000Z').getTime());
    expect(arr[1].timestamp).toBe(new Date('2026-05-01T10:00:05.000Z').getTime());
    expect(arr[0].isStreaming).toBe(false);
    expect(arr[1].isStreaming).toBe(false);
  });


  it('preserves stable ids, thread ids, and assistant speaker attribution from older history rows', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'g1',
      messagesMap: { 'unify-1': [] },
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'g1',
      messages: [
        { id: 'u-1', role: 'user', content: 'older-q', groupId: 'g1', threadId: 'thr-a' },
        { id: 'a-1', role: 'assistant', content: 'older-a', groupId: 'g1', threadId: 'thr-a', speakerVpId: 'vp-linus' },
      ],
      oldestSeq: 10,
      hasMore: false,
    });

    expect(store.messagesMap['unify-1']).toEqual([
      expect.objectContaining({ id: 'u-1', messageId: 'u-1', type: 'user', groupId: 'g1', threadId: 'thr-a', turnId: 'thr-a' }),
      expect.objectContaining({ id: 'a-1', messageId: 'a-1', type: 'assistant', groupId: 'g1', threadId: 'thr-a', turnId: 'thr-a', vpId: 'vp-linus', speakerVpId: 'vp-linus' }),
    ]);
  });

  it('keeps group-scoped cursor state isolated when accepting matching chunks', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'group-A',
      unifyGroupHistoryState: {
        'group-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 77, count: 2 },
      },
      messagesMap: { 'unify-1': [] },
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'group-A',
      messages: [{ id: 'a-old', role: 'user', content: 'A-old', groupId: 'group-A' }],
      oldestSeq: 11,
      hasMore: false,
    });

    expect(store.unifyGroupHistoryState['group-A']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      hasMore: false,
      oldestSeq: 11,
      count: 1,
    }));
    expect(store.unifyGroupHistoryState['group-B']).toEqual(expect.objectContaining({
      hasMore: true,
      oldestSeq: 77,
    }));
    expect(store.unifyHasMoreHistory).toBe(false);
    expect(store.unifyOldestLoadedSeq).toBe(11);
  });

  it('updates unifyHasMoreHistory + unifyOldestLoadedSeq from the chunk', () => {
    const store = mkStore({
      unifyHasMoreHistory: true,
      unifyOldestLoadedSeq: 200,
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      messages: [{ id: 'm0050', role: 'user', content: 'q', groupId: null }],
      oldestSeq: 50,
      hasMore: false,
    });
    expect(store.unifyHasMoreHistory).toBe(false);
    expect(store.unifyOldestLoadedSeq).toBe(50);
  });

  it('always clears unifyLoadingMoreHistory (even on empty chunk)', () => {
    const store = mkStore({
      unifyLoadingMoreHistory: true,
      unifyHasMoreHistory: true,
      messagesMap: { 'unify-1': [] },
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      messages: [],
      oldestSeq: null,
      hasMore: false,
    });
    expect(store.unifyLoadingMoreHistory).toBe(false);
    expect(store.unifyHasMoreHistory).toBe(false);
    // Still no rows — empty chunk doesn't synthesize anything.
    expect(store.messagesMap['unify-1']).toEqual([]);
  });

  it('clears unifyLoadingMoreHistory when conversationId is missing entirely', () => {
    const store = mkStore({
      unifyConversationId: null,
      unifyLoadingMoreHistory: true,
    });
    handleUnifyHistoryChunk(store, {
      // no conversationId in the message either
      messages: [{ id: 'm1', role: 'user', content: 'x' }],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.unifyLoadingMoreHistory).toBe(false);
    // No conversationId → no map mutation.
    expect(Object.keys(store.messagesMap)).toEqual([]);
  });

  it('falls back to store.unifyConversationId when the chunk omits conversationId', () => {
    const store = mkStore();
    handleUnifyHistoryChunk(store, {
      // conversationId missing → fall back to store.unifyConversationId='unify-1'
      messages: [{ id: 'm1', role: 'user', content: 'x', groupId: null }],
      oldestSeq: 1,
      hasMore: true,
    });
    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['x']);
    expect(store.unifyOldestLoadedSeq).toBe(1);
    expect(store.unifyHasMoreHistory).toBe(true);
  });

  it('skips rows that are neither user nor assistant', () => {
    const store = mkStore({ messagesMap: { 'unify-1': [] } });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      messages: [
        { id: 'm0001', role: 'user',      content: 'q1', groupId: 'g1' },
        { id: 'm0002', role: 'tool',      content: '{"ok":true}' },          // dropped
        { id: 'm0003', role: 'system',    content: 'noise' },                 // dropped
        { id: 'm0004', role: 'assistant', content: 'a1', groupId: 'g1' },
        null,                                                                  // dropped
        { id: 'm0005' },                                                       // no role → dropped
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['q1', 'a1']);
  });


  it('keeps chronological order and dedupes rows when older group history overlaps cached rows', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'group-A',
      messagesMap: {
        'unify-1': [
          { id: 'm0003', messageId: 'm0003', type: 'user', content: 'newer-q', groupId: 'group-A' },
          { id: 'm0004', messageId: 'm0004', type: 'assistant', content: 'newer-a', groupId: 'group-A', speakerVpId: 'vp-ada' },
        ],
      },
    });

    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'group-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'oldest-q', groupId: 'group-A' },
        { id: 'm0002', role: 'assistant', content: 'oldest-a', groupId: 'group-A', speakerVpId: 'vp-linus' },
        { id: 'm0003', role: 'user', content: 'newer-q', groupId: 'group-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['unify-1'].map(m => m.id)).toEqual(['m0001', 'm0002', 'm0003', 'm0004']);
    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['oldest-q', 'oldest-a', 'newer-q', 'newer-a']);
  });

  it('drops reflected/system-like rows even if they arrive with role=user', () => {
    const store = mkStore({ messagesMap: { 'unify-1': [] } });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'g1',
      messages: [
        { id: 'm0001', role: 'user', content: 'visible user', groupId: 'g1' },
        { id: 'm0002', role: 'user', content: 'reflection text', groupId: 'g1', _reflection: true },
        { id: 'm0003', role: 'assistant', content: 'system-only note', groupId: 'g1', systemOnly: true },
        { id: 'm0004', role: 'assistant', content: 'visible assistant', groupId: 'g1', speakerVpId: 'vp-linus' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['visible user', 'visible assistant']);
    expect(store.messagesMap['unify-1'][1]).toEqual(expect.objectContaining({ type: 'assistant', speakerVpId: 'vp-linus' }));
  });

  it('does not corrupt unifyOldestLoadedSeq when chunk omits a numeric oldestSeq', () => {
    const store = mkStore({ unifyOldestLoadedSeq: 100 });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      messages: [],
      oldestSeq: null,    // server says "no older messages remain"
      hasMore: false,
    });
    // Cursor is left as the previous value rather than nulled, so a
    // subsequent reset path (group switch / enter) is the only place that
    // can clear it. hasMore=false alone gates further fetches.
    expect(store.unifyOldestLoadedSeq).toBe(100);
    expect(store.unifyHasMoreHistory).toBe(false);
  });

  it('drops stale chunks whose groupId no longer matches the active filter (race-with-group-switch)', () => {
    // Sequence: user is in group A, "Load older" fires while looking at A,
    // user switches to B before the chunk arrives. The B switch already
    // cleared messagesMap[convId] and reset the cursor; we must NOT
    // splice A's history into B's view when A's chunk finally lands.
    const store = mkStore({
      unifyActiveGroupFilter: 'group-B',
      unifyLoadingMoreHistory: true,           // spinner up from the A click
      messagesMap: {
        'unify-1': [
          { type: 'user', content: 'B-msg', groupId: 'group-B' },
        ],
      },
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'group-A',                      // stale: chunk is for the OLD group
      messages: [
        { id: 'm0001', role: 'user',      content: 'A-old-q', groupId: 'group-A' },
        { id: 'm0002', role: 'assistant', content: 'A-old-a', groupId: 'group-A' },
      ],
      oldestSeq: 1,
      hasMore: true,
    });
    // No prepend — group B's stream is untouched.
    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['B-msg']);
    // Spinner is cleared regardless so the UI doesn't get stuck.
    expect(store.unifyLoadingMoreHistory).toBe(false);
    // Cursor not corrupted by group A's data.
    expect(store.unifyOldestLoadedSeq).toBe(100);
  });

  it('drops stale chunks with an empty-string groupId instead of treating them as unscoped history', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'group-B',
      unifyLoadingMoreHistory: true,
      unifyGroupHistoryState: {
        '': { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
        'group-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 100, count: 1 },
      },
      messagesMap: {
        'unify-1': [
          { type: 'user', content: 'B-msg', groupId: 'group-B' },
        ],
      },
    });

    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: '',
      messages: [
        { id: 'm-empty-1', role: 'user', content: 'empty-scope-q', groupId: '' },
      ],
      oldestSeq: 1,
      hasMore: true,
    });

    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['B-msg']);
    expect(store.unifyLoadingMoreHistory).toBe(false);
    expect(store.unifyGroupHistoryState['']).toEqual(expect.objectContaining({ loading: false }));
    expect(store.unifyGroupHistoryState.__all__).toBeUndefined();
    expect(store.unifyOldestLoadedSeq).toBe(100);
  });

  it('preserves empty-string row groupId when accepting an empty-string chunk', () => {
    const store = mkStore({
      unifyActiveGroupFilter: '',
      messagesMap: { 'unify-1': [] },
    });

    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: '',
      messages: [
        { id: 'm-empty-1', role: 'user', content: 'empty-scope-q', groupId: '' },
        { id: 'm-empty-2', role: 'assistant', content: 'empty-scope-a', groupId: '' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['unify-1']).toEqual([
      expect.objectContaining({ id: 'm-empty-1', groupId: '' }),
      expect.objectContaining({ id: 'm-empty-2', groupId: '' }),
    ]);
    expect(store.unifyGroupHistoryState['']).toEqual(expect.objectContaining({ loading: false, hasMore: false }));
    expect(store.unifyGroupHistoryState.__all__).toBeUndefined();
  });

  it('accepts a chunk whose groupId matches the active filter', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'group-A',
      messagesMap: { 'unify-1': [] },
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'group-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'A-old-q', groupId: 'group-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['A-old-q']);
    expect(store.unifyOldestLoadedSeq).toBe(1);
  });

  it('accepts a chunk when the active filter is null (no per-group scope set)', () => {
    // Edge case: bootstrap path before any group has been selected. The
    // chunk may carry a groupId stamp; without an active filter we accept.
    const store = mkStore({
      unifyActiveGroupFilter: null,
      messagesMap: { 'unify-1': [] },
    });
    handleUnifyHistoryChunk(store, {
      conversationId: 'unify-1',
      groupId: 'group-X',
      messages: [
        { id: 'm0001', role: 'user', content: 'q', groupId: 'group-X' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['unify-1'].map(m => m.content)).toEqual(['q']);
  });
});

describe('loadMoreUnifyHistory — action gates', () => {
  let originalWindow;
  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = {};
  });
  afterEach(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  it('happy path: posts unify_load_more_history and flips loading flag', () => {
    const store = mkStore({
      unifyOldestLoadedSeq: 42,
    });
    // No groups store wired — groupId resolves to null, which is fine.
    loadMoreUnifyHistory.call(store);
    expect(store.unifyLoadingMoreHistory).toBe(true);
    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toEqual({
      type: 'unify_load_more_history',
      agentId: 'agent-1',
      groupId: null,
      beforeSeq: 42,
      turns: 20,
    });
  });

  it('forwards activeGroupId from window.Pinia.useGroupsStore', () => {
    globalThis.window.Pinia = {
      useGroupsStore: () => ({ activeGroupId: 'grp-xyz' }),
    };
    const store = mkStore({ unifyOldestLoadedSeq: 7 });
    loadMoreUnifyHistory.call(store);
    expect(store._sent[0].groupId).toBe('grp-xyz');
    expect(store._sent[0].beforeSeq).toBe(7);
  });

  it('prefers unifyActiveGroupFilter over a stale groupsStore.activeGroupId', () => {
    globalThis.window.Pinia = {
      useGroupsStore: () => ({ activeGroupId: 'grp-stale' }),
    };
    const store = mkStore({
      unifyActiveGroupFilter: 'grp-visible',
      unifyOldestLoadedSeq: 9,
    });

    loadMoreUnifyHistory.call(store);

    expect(store._sent[0].groupId).toBe('grp-visible');
    expect(store.unifyGroupHistoryState['grp-visible'].loading).toBe(true);
    expect(store.unifyGroupHistoryState['grp-stale']).toBeUndefined();
  });

  it('no-op when currentView is not unify', () => {
    const store = mkStore({ currentView: 'chat' });
    loadMoreUnifyHistory.call(store);
    expect(store.unifyLoadingMoreHistory).toBe(false);
    expect(store._sent).toEqual([]);
  });

  it('no-op when already loading', () => {
    const store = mkStore({ unifyLoadingMoreHistory: true });
    loadMoreUnifyHistory.call(store);
    // unchanged (still true), but no fresh send
    expect(store._sent).toEqual([]);
  });

  it('no-op when there are no more messages on the server', () => {
    const store = mkStore({ unifyHasMoreHistory: false });
    loadMoreUnifyHistory.call(store);
    expect(store.unifyLoadingMoreHistory).toBe(false);
    expect(store._sent).toEqual([]);
  });

  it('no-op when unifyAgentId is missing', () => {
    const store = mkStore({ unifyAgentId: null });
    loadMoreUnifyHistory.call(store);
    expect(store._sent).toEqual([]);
  });

  it('no-op when the cursor is null (cold start, nothing loaded yet)', () => {
    const store = mkStore({ unifyOldestLoadedSeq: null });
    loadMoreUnifyHistory.call(store);
    expect(store._sent).toEqual([]);
  });

  it('survives a throwing groups-store accessor', () => {
    globalThis.window.Pinia = {
      useGroupsStore: () => { throw new Error('not registered'); },
    };
    const store = mkStore({ unifyOldestLoadedSeq: 1 });
    expect(() => loadMoreUnifyHistory.call(store)).not.toThrow();
    expect(store._sent).toHaveLength(1);
    expect(store._sent[0].groupId).toBeNull();
  });
});

describe('setActiveGroupFilter — group-scoped conversation cache', () => {
  it('does not clear the shared Unify message stream when switching groups', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'group-A',
      messagesMap: {
        'unify-1': [
          { id: 'a1', type: 'user', content: 'A before', groupId: 'group-A' },
          { id: 'b1', type: 'user', content: 'B before', groupId: 'group-B' },
        ],
      },
      unifyGroupHistoryState: {
        'group-A': { loaded: true, loading: false, hasMore: true, oldestSeq: 10, count: 1 },
        'group-B': { loaded: true, loading: false, hasMore: false, oldestSeq: 20, count: 1 },
      },
    });

    const beforeA = visibleMessages(store).map(m => m.id);
    setActiveGroupFilter.call(store, 'group-B');
    const afterB = visibleMessages(store).map(m => m.id);
    setActiveGroupFilter.call(store, 'group-A');
    const afterA = visibleMessages(store).map(m => m.id);

    expect(beforeA).toEqual(['a1']);
    expect(afterB).toEqual(['b1']);
    expect(afterA).toEqual(['a1']);
    expect(store.messagesMap['unify-1'].map(m => m.id)).toEqual(['a1', 'b1']);
    expect(store._sent).toEqual([]);
    expect(store.unifyHasMoreHistory).toBe(true);
    expect(store.unifyOldestLoadedSeq).toBe(10);
  });

  it('hydrates only a group without cached rows or loaded history metadata', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'group-A',
      messagesMap: {
        'unify-1': [{ id: 'a1', type: 'user', content: 'A before', groupId: 'group-A' }],
      },
      unifyGroupHistoryState: {
        'group-A': { loaded: true, loading: false, hasMore: false, oldestSeq: null, count: 1 },
      },
    });

    setActiveGroupFilter.call(store, 'group-C');

    expect(visibleMessages(store)).toEqual([]);
    expect(store.messagesMap['unify-1'].map(m => m.id)).toEqual(['a1']);
    expect(store._sent).toEqual([{ type: 'unify_load_history', agentId: 'agent-1', limit: 50, groupId: 'group-C' }]);
    expect(store.unifyGroupHistoryState['group-C']).toEqual(expect.objectContaining({ loading: true, loaded: false }));
  });

  it('keeps selected group and pending history state isolated across groups', () => {
    const store = mkStore({
      unifyActiveGroupFilter: 'group-A',
      unifyLoadingMoreHistory: false,
      unifyGroupHistoryState: {
        'group-A': { loaded: true, loading: false, hasMore: true, oldestSeq: 101, count: 2 },
        'group-B': { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
      },
      messagesMap: {
        'unify-1': [
          { id: 'a1', type: 'assistant', content: 'A', groupId: 'group-A', speakerVpId: 'vp-a' },
          { id: 'b1', type: 'assistant', content: 'B', groupId: 'group-B', speakerVpId: 'vp-b' },
        ],
      },
    });

    setActiveGroupFilter.call(store, 'group-B');
    expect(visibleMessages(store).map(m => m.id)).toEqual(['b1']);
    expect(store.unifyLoadingMoreHistory).toBe(true);
    expect(store.unifyOldestLoadedSeq).toBeNull();

    setActiveGroupFilter.call(store, 'group-A');
    expect(visibleMessages(store).map(m => m.id)).toEqual(['a1']);
    expect(store.unifyLoadingMoreHistory).toBe(false);
    expect(store.unifyHasMoreHistory).toBe(true);
    expect(store.unifyOldestLoadedSeq).toBe(101);
  });
});
