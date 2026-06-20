/**
 * load-more-yeaft-history.test.js — Yeaft "Load older messages" front-end.
 *
 * Covers two pieces:
 *   1. The chunk handler `handleYeaftHistoryChunk` — prepends user/assistant
 *      rows at index 0 of `messagesMap[convId]`, updates `yeaftHasMoreHistory`
 *      / `yeaftOldestLoadedSeq`, and ALWAYS clears `yeaftLoadingMoreHistory`
 *      (even on empty / missing-conv-id paths so the spinner doesn't stick).
 *   2. The store action `loadMoreYeaftHistory` — gates on `currentView`,
 *      `yeaftLoadingMoreHistory`, `yeaftHasMoreHistory`, a resolvable agent
 *      (the active session's owner, else `currentAgent`),
 *      and `yeaftOldestLoadedSeq`; flips `yeaftLoadingMoreHistory=true`
 *      and posts a `yeaft_load_more_history` envelope.
 *
 * Field naming (post msg.groupId → msg.sessionId rename, 2026-06-08):
 * the wire-level field used by all newly-built envelopes is `sessionId`.
 * The chunk handler still accepts legacy `msg.groupId` as a fallback for
 * deploy-window compat with older agents; this is exercised in the
 * "accepts legacy groupId field" test below.
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

const { handleYeaftHistoryChunk } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
const {
  getDefaultYeaftVisibleTurns,
  getYeaftWindowLoadStepTurns,
  hasHiddenYeaftMessageTurns,
  sliceYeaftMessagesByRecentTurns,
} = await import('../../../web/stores/helpers/yeaft-message-window.js');

// Mirror production's `resolveAgentIdForSession`: prefer the session row's
// owning agent (sessions store), then the per-session cache, then the single
// client-bound `currentAgent`.
function resolveAgentIdForSession(state, sessionId) {
  if (sessionId) {
    try {
      const gs = (typeof window !== 'undefined') && (
        window.Pinia?.useSessionsStore?.() ||
        (window.__useSessionsStore && window.__useSessionsStore())
      );
      const sess = gs && typeof gs.sessionById === 'function' ? gs.sessionById(sessionId) : null;
      if (sess && sess.agentId) return sess.agentId;
    } catch { /* sessions store missing */ }
    const mapped = state?.yeaftSessionAgentById ? state.yeaftSessionAgentById[sessionId] : null;
    if (mapped) return mapped;
  }
  return state?.currentAgent || null;
}

// Re-implement the action body 1:1 here so we can drive it without booting
// Pinia. Keeping it in lock-step with the production version is what the
// review will scan against.
function loadMoreYeaftHistory() {
  if (this.currentView !== 'yeaft') return;
  if (this.yeaftLoadingMoreHistory || !this.yeaftHasMoreHistory) return;
  if (this.yeaftOldestLoadedSeq == null) return;

  let sessionId = this.yeaftActiveSessionFilter || null;
  if (!sessionId) {
    try {
      const gs = (typeof window !== 'undefined') && (
        window.Pinia?.useSessionsStore?.() ||
        (window.__useSessionsStore && window.__useSessionsStore())
      );
      sessionId = (gs && gs.activeSessionId) || null;
    } catch { /* sessions store missing — agent treats null as no-op */ }
  }

  const targetAgentId = resolveAgentIdForSession(this, sessionId);
  if (!targetAgentId) return;

  this.yeaftLoadingMoreHistory = true;
  const sessionKey = sessionId || '__all__';
  this.yeaftSessionHistoryState = {
    ...this.yeaftSessionHistoryState,
    [sessionKey]: {
      ...(this.yeaftSessionHistoryState[sessionKey] || {}),
      loading: true,
    },
  };
  this.sendWsMessage({
    type: 'yeaft_load_more_history',
    agentId: targetAgentId,
    sessionId,
    beforeSeq: this.yeaftOldestLoadedSeq,
    turns: 10,
  });
}

function mkStore(overrides = {}) {
  const sent = [];
  return {
    currentView: 'yeaft',
    yeaftConversationId: 'yeaft-1',
    currentAgent: 'agent-1',
    yeaftHasMoreHistory: true,
    yeaftLoadingMoreHistory: false,
    yeaftOldestLoadedSeq: 100,
    yeaftSessionHistoryState: {},
    yeaftMessageWindowState: {},
    messagesMap: {},
    sendWsMessage(msg) { sent.push(msg); },
    _sent: sent,
    ...overrides,
  };
}

function scopedYeaftMessages(state) {
  const convId = state.yeaftConversationId || null;
  const raw = convId ? (state.messagesMap[convId] || []) : [];
  if (state.yeaftActiveSessionFilter) {
    return raw.filter(m => m && m.sessionId === state.yeaftActiveSessionFilter);
  }
  return raw;
}

function visibleMessages(state) {
  const convId = state.currentView === 'yeaft'
    ? (state.yeaftConversationId || null)
    : (state.activeConversations?.[0] || null);
  const raw = convId ? (state.messagesMap[convId] || []) : [];
  if (state.currentView !== 'yeaft') return raw;
  const scoped = scopedYeaftMessages(state);
  const sessionKey = state.yeaftActiveSessionFilter || '__all__';
  const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
    || getDefaultYeaftVisibleTurns();
  return sliceYeaftMessagesByRecentTurns(scoped, visibleTurns);
}

function hasHiddenYeaftMessages(state) {
  const sessionKey = state.yeaftActiveSessionFilter || '__all__';
  const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
    || getDefaultYeaftVisibleTurns();
  return hasHiddenYeaftMessageTurns(scopedYeaftMessages(state), visibleTurns);
}

function pruneYeaftMessageWindow(sessionId = null) {
  const sessionKey = sessionId || this.yeaftActiveSessionFilter || '__all__';
  this.yeaftMessageWindowState = {
    ...this.yeaftMessageWindowState,
    [sessionKey]: { visibleTurns: getDefaultYeaftVisibleTurns() },
  };
}

function expandYeaftMessageWindow(sessionId = null, turns = getYeaftWindowLoadStepTurns()) {
  const sessionKey = sessionId || this.yeaftActiveSessionFilter || '__all__';
  const current = this.yeaftMessageWindowState[sessionKey]?.visibleTurns || getDefaultYeaftVisibleTurns();
  this.yeaftMessageWindowState = {
    ...this.yeaftMessageWindowState,
    [sessionKey]: { visibleTurns: current + turns },
  };
}

function setActiveSessionFilter(sessionId) {
  const prev = this.yeaftActiveSessionFilter || null;
  const next = sessionId || null;
  this.yeaftActiveSessionFilter = next;
  if (next === prev) return;

  const sessionKey = next || '__all__';
  const savedState = this.yeaftSessionHistoryState[sessionKey] || null;
  this.yeaftHasMoreHistory = !!savedState?.hasMore;
  this.yeaftLoadingMoreHistory = !!savedState?.loading;
  this.yeaftOldestLoadedSeq = (typeof savedState?.oldestSeq === 'number') ? savedState.oldestSeq : null;
  pruneYeaftMessageWindow.call(this, next);

  const needsHydrate = !savedState?.loaded && !savedState?.loading;
  const targetAgentId = next ? resolveAgentIdForSession(this, next) : this.currentAgent;
  if (targetAgentId && next && needsHydrate) {
    this.yeaftSessionHistoryState = {
      ...this.yeaftSessionHistoryState,
      [sessionKey]: { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
    };
    this.yeaftLoadingMoreHistory = true;
    this.sendWsMessage({
      type: 'yeaft_load_history',
      agentId: targetAgentId,
      limit: 50,
      sessionId: next,
    });
  }
}

describe('handleYeaftHistoryChunk', () => {
  it('binds assistant history without VP attribution to the group default VP', () => {
    const oldWindow = globalThis.window;
    globalThis.window = {
      Pinia: {
        useSessionsStore: () => ({
          sessionById: (id) => id === 'g1' ? { id: 'g1', defaultVpId: 'linus' } : null,
        }),
      },
    };
    try {
      const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
      handleYeaftHistoryChunk(store, {
        conversationId: 'yeaft-1',
        sessionId: 'g1',
        messages: [
          { id: 'm0002', role: 'assistant', content: 'older-a1', sessionId: 'g1' },
        ],
        oldestSeq: 1,
        hasMore: false,
      });

      const [msg] = store.messagesMap['yeaft-1'];
      expect(msg.vpId).toBe('linus');
      expect(msg.speakerVpId).toBe('linus');
      expect(msg.isStreaming).toBe(false);
      expect(msg.isHistory).toBe(true);
    } finally {
      globalThis.window = oldWindow;
    }
  });

  it('prepends user + assistant rows at index 0 with isStreaming=false', () => {
    const store = mkStore({
      messagesMap: {
        'yeaft-1': [
          { type: 'user', content: 'newer-q', sessionId: 'g1' },
        ],
      },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [
        { id: 'm0001', role: 'user',      content: 'older-q1', sessionId: 'g1' },
        { id: 'm0002', role: 'assistant', content: 'older-a1', sessionId: 'g1' },
      ],
      oldestSeq: 1,
      hasMore: true,
    });

    const arr = store.messagesMap['yeaft-1'];
    expect(arr.map(m => m.content)).toEqual(['older-q1', 'older-a1', 'newer-q']);
    // Streaming flag false on prepended rows.
    expect(arr[0].isStreaming).toBe(false);
    expect(arr[1].isStreaming).toBe(false);
    // type/content/sessionId carried.
    expect(arr[0].type).toBe('user');
    expect(arr[1].type).toBe('assistant');
    expect(arr[0].sessionId).toBe('g1');
  });

  it('accepts legacy groupId field on a chunk for deploy-window compat', () => {
    // Old agents may still emit `groupId` instead of `sessionId` on the
    // wire envelope and per-row stamp. The handler must accept both and
    // promote to the canonical `sessionId` field on the stored row.
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      groupId: 'g1',
      messages: [
        { id: 'm0001', role: 'user',      content: 'legacy-q', groupId: 'g1' },
        { id: 'm0002', role: 'assistant', content: 'legacy-a', groupId: 'g1' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['legacy-q', 'legacy-a']);
    // Even though the agent sent `groupId`, the stored rows use `sessionId`.
    expect(store.messagesMap['yeaft-1'][0].sessionId).toBe('g1');
    expect(store.messagesMap['yeaft-1'][1].sessionId).toBe('g1');
  });

  it('preserves persisted timestamps from paginated history rows', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [
        { id: 'm0001', role: 'user', content: 'older-q1', sessionId: 'g1', ts: '2026-05-01T10:00:00.000Z' },
        { id: 'm0002', role: 'assistant', content: 'older-a1', sessionId: 'g1', time: '2026-05-01T10:00:05.000Z' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    const arr = store.messagesMap['yeaft-1'];
    expect(arr[0].timestamp).toBe(new Date('2026-05-01T10:00:00.000Z').getTime());
    expect(arr[1].timestamp).toBe(new Date('2026-05-01T10:00:05.000Z').getTime());
    expect(arr[0].isStreaming).toBe(false);
    expect(arr[1].isStreaming).toBe(false);
  });


  it('preserves stable ids and assistant speaker attribution from older history rows', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [
        { id: 'u-1', role: 'user', content: 'older-q', sessionId: 'g1' },
        { id: 'a-1', role: 'assistant', content: 'older-a', sessionId: 'g1', speakerVpId: 'vp-linus' },
      ],
      oldestSeq: 10,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({ id: 'u-1', messageId: 'u-1', type: 'user', sessionId: 'g1', turnId: 'u-1' }),
      expect.objectContaining({ id: 'a-1', messageId: 'a-1', type: 'assistant', sessionId: 'g1', turnId: 'a-1', vpId: 'vp-linus', speakerVpId: 'vp-linus' }),
    ]);
  });

  it('keeps session-scoped cursor state isolated when accepting matching chunks', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-A',
      yeaftSessionHistoryState: {
        'group-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 77, count: 2 },
      },
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'group-A',
      messages: [{ id: 'a-old', role: 'user', content: 'A-old', sessionId: 'group-A' }],
      oldestSeq: 11,
      hasMore: false,
    });

    expect(store.yeaftSessionHistoryState['group-A']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      hasMore: false,
      oldestSeq: 11,
      count: 1,
    }));
    expect(store.yeaftSessionHistoryState['group-B']).toEqual(expect.objectContaining({
      hasMore: true,
      oldestSeq: 77,
    }));
    expect(store.yeaftHasMoreHistory).toBe(false);
    expect(store.yeaftOldestLoadedSeq).toBe(11);
  });

  it('updates yeaftHasMoreHistory + yeaftOldestLoadedSeq from the chunk', () => {
    const store = mkStore({
      yeaftHasMoreHistory: true,
      yeaftOldestLoadedSeq: 200,
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      messages: [{ id: 'm0050', role: 'user', content: 'q', sessionId: null }],
      oldestSeq: 50,
      hasMore: false,
    });
    expect(store.yeaftHasMoreHistory).toBe(false);
    expect(store.yeaftOldestLoadedSeq).toBe(50);
  });

  it('always clears yeaftLoadingMoreHistory (even on empty chunk)', () => {
    const store = mkStore({
      yeaftLoadingMoreHistory: true,
      yeaftHasMoreHistory: true,
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      messages: [],
      oldestSeq: null,
      hasMore: false,
    });
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftHasMoreHistory).toBe(false);
    // Still no rows — empty chunk doesn't synthesize anything.
    expect(store.messagesMap['yeaft-1']).toEqual([]);
  });

  it('clears yeaftLoadingMoreHistory when conversationId is missing entirely', () => {
    const store = mkStore({
      yeaftConversationId: null,
      yeaftLoadingMoreHistory: true,
    });
    handleYeaftHistoryChunk(store, {
      // no conversationId in the message either
      messages: [{ id: 'm1', role: 'user', content: 'x' }],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    // No conversationId → no map mutation.
    expect(Object.keys(store.messagesMap)).toEqual([]);
  });

  it('falls back to store.yeaftConversationId when the chunk omits conversationId', () => {
    const store = mkStore();
    handleYeaftHistoryChunk(store, {
      // conversationId missing → fall back to store.yeaftConversationId='yeaft-1'
      messages: [{ id: 'm1', role: 'user', content: 'x', sessionId: null }],
      oldestSeq: 1,
      hasMore: true,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['x']);
    expect(store.yeaftOldestLoadedSeq).toBe(1);
    expect(store.yeaftHasMoreHistory).toBe(true);
  });

  it('skips rows that are neither user nor assistant', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      messages: [
        { id: 'm0001', role: 'user',      content: 'q1', sessionId: 'g1' },
        { id: 'm0002', role: 'tool',      content: '{"ok":true}' },          // dropped
        { id: 'm0003', role: 'system',    content: 'noise' },                 // dropped
        { id: 'm0004', role: 'assistant', content: 'a1', sessionId: 'g1' },
        null,                                                                  // dropped
        { id: 'm0005' },                                                       // no role → dropped
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['q1', 'a1']);
  });


  it('keeps chronological order and dedupes rows when older session history overlaps cached rows', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-A',
      messagesMap: {
        'yeaft-1': [
          { id: 'm0003', messageId: 'm0003', type: 'user', content: 'newer-q', sessionId: 'group-A' },
          { id: 'm0004', messageId: 'm0004', type: 'assistant', content: 'newer-a', sessionId: 'group-A', speakerVpId: 'vp-ada' },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'group-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'oldest-q', sessionId: 'group-A' },
        { id: 'm0002', role: 'assistant', content: 'oldest-a', sessionId: 'group-A', speakerVpId: 'vp-linus' },
        { id: 'm0003', role: 'user', content: 'newer-q', sessionId: 'group-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['m0001', 'm0002', 'm0003', 'm0004']);
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['oldest-q', 'oldest-a', 'newer-q', 'newer-a']);
  });

  it('drops reflected/system-like rows even if they arrive with role=user', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [
        { id: 'm0001', role: 'user', content: 'visible user', sessionId: 'g1' },
        { id: 'm0002', role: 'user', content: 'reflection text', sessionId: 'g1', _reflection: true },
        { id: 'm0003', role: 'assistant', content: 'system-only note', sessionId: 'g1', systemOnly: true },
        { id: 'm0004', role: 'assistant', content: 'visible assistant', sessionId: 'g1', speakerVpId: 'vp-linus' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['visible user', 'visible assistant']);
    expect(store.messagesMap['yeaft-1'][1]).toEqual(expect.objectContaining({ type: 'assistant', speakerVpId: 'vp-linus' }));
  });

  it('does not corrupt yeaftOldestLoadedSeq when chunk omits a numeric oldestSeq', () => {
    const store = mkStore({ yeaftOldestLoadedSeq: 100 });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      messages: [],
      oldestSeq: null,    // server says "no older messages remain"
      hasMore: false,
    });
    // Cursor is left as the previous value rather than nulled, so a
    // subsequent reset path (session switch / enter) is the only place that
    // can clear it. hasMore=false alone gates further fetches.
    expect(store.yeaftOldestLoadedSeq).toBe(100);
    expect(store.yeaftHasMoreHistory).toBe(false);
  });

  it('drops stale chunks whose sessionId no longer matches the active filter (race-with-session-switch)', () => {
    // Sequence: user is in session A, "Load older" fires while looking at A,
    // user switches to B before the chunk arrives. The B switch already
    // cleared messagesMap[convId] and reset the cursor; we must NOT
    // splice A's history into B's view when A's chunk finally lands.
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-B',
      yeaftLoadingMoreHistory: true,           // spinner up from the A click
      messagesMap: {
        'yeaft-1': [
          { type: 'user', content: 'B-msg', sessionId: 'group-B' },
        ],
      },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'group-A',                    // stale: chunk is for the OLD session
      messages: [
        { id: 'm0001', role: 'user',      content: 'A-old-q', sessionId: 'group-A' },
        { id: 'm0002', role: 'assistant', content: 'A-old-a', sessionId: 'group-A' },
      ],
      oldestSeq: 1,
      hasMore: true,
    });
    // No prepend — session B's stream is untouched.
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['B-msg']);
    // Spinner is cleared regardless so the UI doesn't get stuck.
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    // Cursor not corrupted by session A's data.
    expect(store.yeaftOldestLoadedSeq).toBe(100);
  });

  it('drops stale chunks with an empty-string sessionId instead of treating them as unscoped history', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-B',
      yeaftLoadingMoreHistory: true,
      yeaftSessionHistoryState: {
        '': { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
        'group-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 100, count: 1 },
      },
      messagesMap: {
        'yeaft-1': [
          { type: 'user', content: 'B-msg', sessionId: 'group-B' },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: '',
      messages: [
        { id: 'm-empty-1', role: 'user', content: 'empty-scope-q', sessionId: '' },
      ],
      oldestSeq: 1,
      hasMore: true,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['B-msg']);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftSessionHistoryState['']).toEqual(expect.objectContaining({ loading: false }));
    expect(store.yeaftSessionHistoryState.__all__).toBeUndefined();
    expect(store.yeaftOldestLoadedSeq).toBe(100);
  });

  it('preserves empty-string row sessionId when accepting an empty-string chunk', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: '',
      messagesMap: { 'yeaft-1': [] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: '',
      messages: [
        { id: 'm-empty-1', role: 'user', content: 'empty-scope-q', sessionId: '' },
        { id: 'm-empty-2', role: 'assistant', content: 'empty-scope-a', sessionId: '' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({ id: 'm-empty-1', sessionId: '' }),
      expect.objectContaining({ id: 'm-empty-2', sessionId: '' }),
    ]);
    expect(store.yeaftSessionHistoryState['']).toEqual(expect.objectContaining({ loading: false, hasMore: false }));
    expect(store.yeaftSessionHistoryState.__all__).toBeUndefined();
  });

  it('accepts a chunk whose sessionId matches the active filter', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-A',
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'group-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'A-old-q', sessionId: 'group-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['A-old-q']);
    expect(store.yeaftOldestLoadedSeq).toBe(1);
  });

  it('accepts a chunk when the active filter is null (no per-session scope set)', () => {
    // Edge case: bootstrap path before any session has been selected. The
    // chunk may carry a sessionId stamp; without an active filter we accept.
    const store = mkStore({
      yeaftActiveSessionFilter: null,
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'group-X',
      messages: [
        { id: 'm0001', role: 'user', content: 'q', sessionId: 'group-X' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['q']);
  });
});

describe('loadMoreYeaftHistory — action gates', () => {
  let originalWindow;
  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = {};
  });
  afterEach(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  it('happy path: posts yeaft_load_more_history and flips loading flag', () => {
    const store = mkStore({
      yeaftOldestLoadedSeq: 42,
    });
    // No sessions store wired — sessionId resolves to null, which is fine.
    loadMoreYeaftHistory.call(store);
    expect(store.yeaftLoadingMoreHistory).toBe(true);
    expect(store._sent).toHaveLength(1);
    expect(store._sent[0]).toEqual({
      type: 'yeaft_load_more_history',
      agentId: 'agent-1',
      sessionId: null,
      beforeSeq: 42,
      turns: 10,
    });
  });

  it('forwards activeSessionId from window.Pinia.useSessionsStore', () => {
    globalThis.window.Pinia = {
      useSessionsStore: () => ({ activeSessionId: 'grp-xyz' }),
    };
    const store = mkStore({ yeaftOldestLoadedSeq: 7 });
    loadMoreYeaftHistory.call(store);
    expect(store._sent[0].sessionId).toBe('grp-xyz');
    expect(store._sent[0].beforeSeq).toBe(7);
  });

  it('prefers yeaftActiveSessionFilter over a stale sessionsStore.activeSessionId', () => {
    globalThis.window.Pinia = {
      useSessionsStore: () => ({ activeSessionId: 'grp-stale' }),
    };
    const store = mkStore({
      yeaftActiveSessionFilter: 'grp-visible',
      yeaftOldestLoadedSeq: 9,
    });

    loadMoreYeaftHistory.call(store);

    expect(store._sent[0].sessionId).toBe('grp-visible');
    expect(store.yeaftSessionHistoryState['grp-visible'].loading).toBe(true);
    expect(store.yeaftSessionHistoryState['grp-stale']).toBeUndefined();
  });

  it('no-op when currentView is not yeaft', () => {
    const store = mkStore({ currentView: 'chat' });
    loadMoreYeaftHistory.call(store);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store._sent).toEqual([]);
  });

  it('no-op when already loading', () => {
    const store = mkStore({ yeaftLoadingMoreHistory: true });
    loadMoreYeaftHistory.call(store);
    // unchanged (still true), but no fresh send
    expect(store._sent).toEqual([]);
  });

  it('no-op when there are no more messages on the server', () => {
    const store = mkStore({ yeaftHasMoreHistory: false });
    loadMoreYeaftHistory.call(store);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store._sent).toEqual([]);
  });

  it('no-op when no agent resolves (no session owner, no currentAgent)', () => {
    const store = mkStore({ currentAgent: null });
    loadMoreYeaftHistory.call(store);
    expect(store._sent).toEqual([]);
  });

  it('no-op when the cursor is null (cold start, nothing loaded yet)', () => {
    const store = mkStore({ yeaftOldestLoadedSeq: null });
    loadMoreYeaftHistory.call(store);
    expect(store._sent).toEqual([]);
  });

  it('survives a throwing sessions-store accessor', () => {
    globalThis.window.Pinia = {
      useSessionsStore: () => { throw new Error('not registered'); },
    };
    const store = mkStore({ yeaftOldestLoadedSeq: 1 });
    expect(() => loadMoreYeaftHistory.call(store)).not.toThrow();
    expect(store._sent).toHaveLength(1);
    expect(store._sent[0].sessionId).toBeNull();
  });
});

describe('setActiveSessionFilter — session-scoped conversation cache', () => {
  it('does not clear the shared Yeaft message stream when switching sessions', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-A',
      messagesMap: {
        'yeaft-1': [
          { id: 'a1', type: 'user', content: 'A before', sessionId: 'group-A' },
          { id: 'b1', type: 'user', content: 'B before', sessionId: 'group-B' },
        ],
      },
      yeaftSessionHistoryState: {
        'group-A': { loaded: true, loading: false, hasMore: true, oldestSeq: 10, count: 1 },
        'group-B': { loaded: true, loading: false, hasMore: false, oldestSeq: 20, count: 1 },
      },
    });

    const beforeA = visibleMessages(store).map(m => m.id);
    setActiveSessionFilter.call(store, 'group-B');
    const afterB = visibleMessages(store).map(m => m.id);
    setActiveSessionFilter.call(store, 'group-A');
    const afterA = visibleMessages(store).map(m => m.id);

    expect(beforeA).toEqual(['a1']);
    expect(afterB).toEqual(['b1']);
    expect(afterA).toEqual(['a1']);
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['a1', 'b1']);
    expect(store._sent).toEqual([]);
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(10);
  });

  it('hydrates only a session without cached rows or loaded history metadata', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-A',
      messagesMap: {
        'yeaft-1': [{ id: 'a1', type: 'user', content: 'A before', sessionId: 'group-A' }],
      },
      yeaftSessionHistoryState: {
        'group-A': { loaded: true, loading: false, hasMore: false, oldestSeq: null, count: 1 },
      },
    });

    setActiveSessionFilter.call(store, 'group-C');

    expect(visibleMessages(store)).toEqual([]);
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['a1']);
    expect(store._sent).toEqual([{ type: 'yeaft_load_history', agentId: 'agent-1', limit: 50, sessionId: 'group-C' }]);
    expect(store.yeaftSessionHistoryState['group-C']).toEqual(expect.objectContaining({ loading: true, loaded: false }));
  });

  it('keeps selected session and pending history state isolated across sessions', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'group-A',
      yeaftLoadingMoreHistory: false,
      yeaftSessionHistoryState: {
        'group-A': { loaded: true, loading: false, hasMore: true, oldestSeq: 101, count: 2 },
        'group-B': { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
      },
      messagesMap: {
        'yeaft-1': [
          { id: 'a1', type: 'assistant', content: 'A', sessionId: 'group-A', speakerVpId: 'vp-a' },
          { id: 'b1', type: 'assistant', content: 'B', sessionId: 'group-B', speakerVpId: 'vp-b' },
        ],
      },
    });

    setActiveSessionFilter.call(store, 'group-B');
    expect(visibleMessages(store).map(m => m.id)).toEqual(['b1']);
    expect(store.yeaftLoadingMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBeNull();

    setActiveSessionFilter.call(store, 'group-A');
    expect(visibleMessages(store).map(m => m.id)).toEqual(['a1']);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(101);
  });
});

describe('Yeaft message render window', () => {
  function makeTurns(count, sessionId = 'session-A') {
    const rows = [];
    for (let i = 1; i <= count; i++) {
      rows.push({
        id: `u-${i}`,
        type: 'user',
        content: `user ${i}`,
        sessionId,
        timestamp: i * 10,
      });
      rows.push({
        id: `a-${i}`,
        type: 'assistant',
        content: `assistant ${i}`,
        sessionId,
        vpId: 'vp-1',
        speakerVpId: 'vp-1',
        turnId: `turn-${i}`,
        timestamp: i * 10 + 1,
      });
      rows.push({
        id: `tool-${i}`,
        type: 'tool_use',
        content: '',
        sessionId,
        vpId: 'vp-1',
        speakerVpId: 'vp-1',
        turnId: `turn-${i}`,
        timestamp: i * 10 + 2,
      });
    }
    return rows;
  }

  it('renders only the latest five Yeaft turns while keeping full history cached', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: { 'yeaft-1': makeTurns(8) },
    });

    const visible = visibleMessages(store);

    expect(store.messagesMap['yeaft-1']).toHaveLength(24);
    expect(visible.map(m => m.id)).toEqual([
      'u-4', 'a-4', 'tool-4',
      'u-5', 'a-5', 'tool-5',
      'u-6', 'a-6', 'tool-6',
      'u-7', 'a-7', 'tool-7',
      'u-8', 'a-8', 'tool-8',
    ]);
    expect(hasHiddenYeaftMessages(store)).toBe(true);
  });

  it('loads older cached turns into the render window without truncating assistant chunks', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: { 'yeaft-1': makeTurns(8) },
    });

    expandYeaftMessageWindow.call(store);
    const visible = visibleMessages(store);

    expect(visible.map(m => m.id)).toEqual(makeTurns(8).map(m => m.id));
    expect(hasHiddenYeaftMessages(store)).toBe(false);
  });

  it('prunes back to the recent five turns when returning to the bottom', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: { 'yeaft-1': makeTurns(8) },
    });

    expandYeaftMessageWindow.call(store);
    expect(visibleMessages(store)[0].id).toBe('u-1');

    pruneYeaftMessageWindow.call(store);

    expect(visibleMessages(store)[0].id).toBe('u-4');
    expect(store.messagesMap['yeaft-1'][0].id).toBe('u-1');
  });
});
