/**
 * select-conversation-cache.test.js — pins the perf-chat-session-switch-cache
 * contract for `selectConversation` and the `chatSessionState` lifecycle.
 *
 * Bug context (v0.1.898 and earlier):
 *   Every sidebar click into a previously-opened Chat session blanked
 *   `messagesMap[convId]` and refetched the last 5 turns from the agent.
 *   Cause was a dead-code gate `currentView !== 'chat'` that flipped the
 *   "cache is usable" predicate to `false` in normal daily use. Effect was
 *   a white-screen-until-WebSocket-replies on every session switch.
 *
 * Fix:
 *   1. selectConversation cache-hit branch: if any cached message has a
 *      `dbMessageId`, leave `messagesMap[convId]` untouched and send
 *      `sync_messages { afterMessageId: max(dbMessageId) }` for the delta.
 *   2. Empty cache OR cache-of-only-streaming-partials → fall back to
 *      the legacy `turns: 5` cold-load path.
 *   3. `lastSeenDbId` must be the **MAX** dbMessageId in the cache, not
 *      the tail — the tail can be an in-flight assistant partial with
 *      no dbMessageId; using a stale id wastes bandwidth (dedup catches
 *      the dup, but every switch re-pulls the same rows).
 *   4. `chatSessionState[convId]` records `lastSeenDbId / hasMoreOlder`
 *      so the cache-hit path is O(1) and multi-panel switches don't
 *      clobber per-conv pagination. (Earlier drafts also tracked
 *      `loaded` and `lastSyncedAt`; Torvalds review dropped them as
 *      unused dead state — keep this shape minimal.)
 *   5. closeSession + handleConversationDeleted MUST delete the entry —
 *      a same-id rebirth would otherwise inherit the dead session's
 *      cursor.
 *
 * The tests below all run against the real helper modules; we only mock
 * `sendWsMessage` (to capture the wire packet) and the bare minimum of
 * store surface that selectConversation reads.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// `conversation.js` transitively imports `web/stores/auth.js`, which
// does `const { defineStore } = Pinia;` against a global Pinia.
// Same shim as sync-messages-mid-turn.test.js.
globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};

// closeSession reaches into localStorage when activeConversations
// drops to zero; handleConversationDeleted dispatches a DOM event on
// window. Provide minimal stubs so Node-side tests don't crash. These
// are only used by the two lifecycle tests in this file but are
// installed globally for simplicity — the other tests in this file
// don't touch them.
if (typeof globalThis.localStorage === 'undefined') {
  const _store = new Map();
  globalThis.localStorage = {
    getItem(k) { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    dispatchEvent() { /* no-op */ },
  };
}
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
}

const { selectConversation, closeSession } = await import(
  '../../../../web/stores/helpers/conversation.js'
);
const { handleSyncMessagesResult, handleConversationDeleted, handleConversationResumed } = await import(
  '../../../../web/stores/helpers/handlers/conversationHandler.js'
);
const { formatDbMessage } = await import(
  '../../../../web/stores/helpers/messages.js'
);

function mkStore(overrides = {}) {
  const sent = [];
  const store = {
    // Connection / agents — left empty so the "switch agent first"
    // branch is a no-op.
    currentAgent: null,
    currentAgentInfo: null,
    agents: [],

    // Conversation registry.
    conversations: [],
    currentWorkDir: null,

    // Multi-panel: single-screen mode (panels.length <= 1 takes the
    // simple path we want to test).
    panels: [],
    activePanelId: null,

    // What we're actually exercising.
    messagesMap: {},
    chatSessionState: {},
    activeConversations: [],
    crewMessagesMap: {},

    // Pagination flags the cache-hit branch reads.
    hasMoreMessages: false,
    loadingMoreMessages: false,

    // selectConversation calls saveOpenSessions, which early-returns on
    // !store.currentAgent so we never touch localStorage.
    saveOpenSessions() { /* no-op for tests */ },

    // wsMessage capture.
    sendWsMessage(msg) { sent.push(msg); },

    ...overrides,
  };
  // Expose the captured packets out-of-band.
  store.__sentMessages = sent;
  return store;
}

describe('selectConversation — cache reuse + incremental sync', () => {
  it('cache hit with dbMessageId → does NOT blow cache away, sends afterMessageId', () => {
    const cached = [
      formatDbMessage({ id: 5, role: 'user', content: 'hi',     created_at: 1000 }),
      formatDbMessage({ id: 6, role: 'assistant', content: 'hey',    created_at: 1100 }),
      formatDbMessage({ id: 7, role: 'user', content: 'again',  created_at: 1200 }),
    ];
    const cachedRef = cached;
    const store = mkStore({
      messagesMap: { 'conv-1': cached },
      activeConversations: ['conv-other'], // not conv-1 yet → won't bail at the equality check
    });

    selectConversation(store, 'conv-1');

    // Cache untouched — same array object, same length, same elements.
    expect(store.messagesMap['conv-1']).toBe(cachedRef);
    expect(store.messagesMap['conv-1']).toHaveLength(3);

    // Wire packet: incremental sync with afterMessageId = max dbId.
    const sync = store.__sentMessages.find(m => m.type === 'sync_messages');
    expect(sync).toBeDefined();
    expect(sync).toMatchObject({
      type: 'sync_messages',
      conversationId: 'conv-1',
      afterMessageId: 7,
    });
    // Must NOT carry `turns: 5` — that's the cold-load fallback shape.
    expect(sync.turns).toBeUndefined();
  });

  it('cache empty → blanks map, falls back to turns:5 cold-load', () => {
    const store = mkStore({
      messagesMap: { 'conv-1': [] },
      activeConversations: ['conv-other'],
    });

    selectConversation(store, 'conv-1');

    // The empty-array entry should be replaced (cold-load reseats it).
    expect(store.messagesMap['conv-1']).toEqual([]);

    const sync = store.__sentMessages.find(m => m.type === 'sync_messages');
    expect(sync).toBeDefined();
    expect(sync).toMatchObject({
      type: 'sync_messages',
      conversationId: 'conv-1',
      turns: 5,
    });
    expect(sync.afterMessageId).toBeUndefined();
  });

  it('cache contains only streaming partials (no dbMessageId) → fallback to turns:5', () => {
    // Pathological case: a hot reload mid-stream where the only thing in
    // the cache is an assistant partial that hasn't been persisted yet.
    // We can't anchor an incremental sync on a non-existent id, so we
    // cold-load.
    const partial = { type: 'assistant', content: 'I am think', isStreaming: true };
    const store = mkStore({
      messagesMap: { 'conv-1': [partial] },
      activeConversations: ['conv-other'],
    });

    selectConversation(store, 'conv-1');

    const sync = store.__sentMessages.find(m => m.type === 'sync_messages');
    expect(sync).toMatchObject({
      type: 'sync_messages',
      conversationId: 'conv-1',
      turns: 5,
    });
    expect(sync.afterMessageId).toBeUndefined();

    // Cache got reseated to [] for the cold load. The partial is
    // discarded because we're cold-loading; this matches the legacy
    // behavior (no regression vs. v0.1.898).
    expect(store.messagesMap['conv-1']).toEqual([]);
  });

  it('lastSeenDbId is the MAX dbMessageId, never the tail', () => {
    // Realistic mid-stream scenario:
    //   - Persisted rows 5 and 3 sit in cache (insertion order doesn't
    //     equal dbMessageId order — could come from older-history prepend
    //     or out-of-order delivery).
    //   - Tail is a streaming partial with no dbMessageId.
    // Tail = streaming partial → naive last-element lookup would yield
    // `undefined`. Naive penultimate-element lookup would yield 3, not 5.
    // The contract: max across all entries, ignoring undefined.
    const cached = [
      { type: 'user', content: 'a', dbMessageId: 5, id: 5 },
      { type: 'assistant', content: 'b', dbMessageId: 3, id: 3 }, // smaller id appears later
      { type: 'assistant', content: 'partial...', isStreaming: true }, // no dbMessageId
    ];
    const store = mkStore({
      messagesMap: { 'conv-1': cached },
      activeConversations: ['conv-other'],
    });

    selectConversation(store, 'conv-1');

    const sync = store.__sentMessages.find(m => m.type === 'sync_messages');
    expect(sync.afterMessageId).toBe(5);
  });

  it('cache with only dbMessageId === 0 → cold-load fallback (I3 zero-id safety)', () => {
    // Bug context (Torvalds review I3 on PR #906): the original
    // selectConversation cache-hit predicate `lastSeenDbId !== null`
    // would treat dbMessageId=0 as a legitimate cursor, but SQLite
    // AUTOINCREMENT starts at 1, so any `dbMessageId === 0` we ever
    // saw came from a synthesizer bug or test fixture. The server side
    // also had a falsy gate (`if (msg.afterMessageId)`) that would
    // silently swap to cold-load on the server when we sent 0,
    // re-issuing the entire window — but only on the server, so the
    // client thought it was doing an incremental sync. Now we treat
    // any dbMessageId <= 0 as "no real cursor" → fall back to cold-load
    // explicitly on the client.
    const cached = [
      { type: 'user', content: 'a', dbMessageId: 0, id: 0 },
    ];
    const store = mkStore({
      messagesMap: { 'conv-1': cached },
      activeConversations: ['conv-other'],
    });

    selectConversation(store, 'conv-1');

    const sync = store.__sentMessages.find(m => m.type === 'sync_messages');
    expect(sync).toMatchObject({
      type: 'sync_messages',
      conversationId: 'conv-1',
      turns: 5,
    });
    expect(sync.afterMessageId).toBeUndefined();
  });
});

describe('handleSyncMessagesResult — chatSessionState writes', () => {
  function mkHandlerStore(initialMsgs = []) {
    return {
      messagesMap: { 'conv-1': [...initialMsgs] },
      chatSessionState: {},
      activeConversations: ['conv-1'],
      hasMoreMessages: false,
      loadingMoreMessages: false,
      formatDbMessage,
      setRefreshingSession: () => {},
    };
  }

  it('writes chatSessionState[convId] with lastSeenDbId and hasMoreOlder', () => {
    const store = mkHandlerStore();

    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [
        { id: 10, role: 'user',      content: 'hi',  created_at: 1000 },
        { id: 11, role: 'assistant', content: 'hey', created_at: 1100 },
      ],
      hasMore: true,
    });

    const state = store.chatSessionState['conv-1'];
    expect(state).toBeDefined();
    expect(state.hasMoreOlder).toBe(true);
    expect(state.lastSeenDbId).toBe(11);
    // No dead fields — Torvalds review (PR #906) dropped loaded/lastSyncedAt.
    expect(state.loaded).toBeUndefined();
    expect(state.lastSyncedAt).toBeUndefined();
  });

  it('hasMoreOlder is false when the server omits hasMore', () => {
    const store = mkHandlerStore();
    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [{ id: 1, role: 'user', content: 'hi', created_at: 100 }],
      // hasMore omitted → !!undefined === false
    });
    expect(store.chatSessionState['conv-1'].hasMoreOlder).toBe(false);
  });

  it('handles an empty sync result by stamping lastSeenDbId from existing cache', () => {
    // Realistic delta scenario: client sent afterMessageId, server has
    // nothing new (`messages: []`). State must still stamp lastSeenDbId
    // from whatever is already in cache so future switches re-anchor on
    // the correct cursor without re-walking messagesMap each time.
    const existing = formatDbMessage({ id: 42, role: 'user', content: 'hi', created_at: 100 });
    const store = mkHandlerStore([existing]);

    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [],
      hasMore: false,
      afterMessageId: 42, // mark as delta sync
    });

    const state = store.chatSessionState['conv-1'];
    expect(state.lastSeenDbId).toBe(42);
    // Delta sync with no new messages: hasMoreOlder is NOT mutated by
    // an empty delta — see the "preserves prior hasMoreOlder" test below
    // for the regression coverage that pins this contract.
    expect(state.hasMoreOlder).toBe(false);
  });

  it('delta sync preserves prior hasMoreOlder when server reports an empty delta (C1)', () => {
    // Bug context (PR #906 review, Fowler + Torvalds independently flagged):
    //   Server's `hasMore` is computed from `getBeforeId(oldestId, 1)`.
    //   On a delta where `messages: []`, oldestId is undefined, server
    //   returns hasMore=false. If the client trusts this on delta path,
    //   a single empty-delta wipes the previously-correct "there is
    //   older history" flag and the "Load Older" button disappears.
    //
    // Contract: delta syncs (afterMessageId-anchored) MUST preserve the
    // pre-existing hasMoreOlder. Only cold-load (turns:N) syncs are
    // allowed to overwrite it.
    const existing = formatDbMessage({ id: 42, role: 'user', content: 'hi', created_at: 100 });
    const store = mkHandlerStore([existing]);
    // Seed: prior cold-load said "yes, there's older history".
    store.chatSessionState['conv-1'] = { lastSeenDbId: 42, hasMoreOlder: true };

    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [],
      hasMore: false,        // server reports false — but on delta this is noise
      afterMessageId: 42,    // marks this as a delta sync
    });

    expect(store.chatSessionState['conv-1'].hasMoreOlder).toBe(true);
    // Also: global mirror must NOT be clobbered on delta.
    expect(store.hasMoreMessages).toBe(false); // remained at its initial value
  });

  it('cold-load sync overwrites hasMoreOlder from server (C1 counter-example)', () => {
    // Counterpart to the previous test: on cold-load (turns-anchored,
    // no afterMessageId), the server's hasMore IS authoritative — we're
    // looking at the first page of the conversation, so getBeforeId
    // against the genuine oldest row is meaningful.
    const store = mkHandlerStore();
    store.chatSessionState['conv-1'] = { lastSeenDbId: null, hasMoreOlder: true };

    handleSyncMessagesResult(store, {
      conversationId: 'conv-1',
      messages: [{ id: 1, role: 'user', content: 'hi', created_at: 100 }],
      hasMore: false,
      // afterMessageId omitted → cold load
    });

    expect(store.chatSessionState['conv-1'].hasMoreOlder).toBe(false);
    expect(store.hasMoreMessages).toBe(false);
  });
});

describe('handleConversationResumed — chatSessionState stamping (I1)', () => {
  // Bug context (Fowler review I1 on PR #906):
  //   `selectConversation` was the only path that wrote to
  //   `chatSessionState`. But conv-resumed (cold-open of an existing
  //   session via WebSocket replay) also seeds messagesMap and is the
  //   path that runs on first-load after a browser refresh. Without
  //   stamping here, a fresh page-load → switch-away → switch-back
  //   would re-enter selectConversation with an empty chatSessionState
  //   entry, fall back to hasMoreMessages=false, and the user would
  //   lose the "Load Older" affordance for any conv they hadn't yet
  //   delta-synced — i.e. literally on every browser refresh.
  it('stamps lastSeenDbId from msg.dbMessages and hasMoreOlder from msg.hasMoreMessages', () => {
    const store = mkConvResumedStore();
    handleConversationResumed(store, {
      conversationId: 'conv-1',
      agentId: 'agent-a',
      workDir: '/tmp/wd',
      dbMessages: [
        { id: 100, role: 'user',      content: 'hello',   created_at: 1000 },
        { id: 101, role: 'assistant', content: 'response', created_at: 1100 },
      ],
      hasMoreMessages: true,
    });

    const state = store.chatSessionState['conv-1'];
    expect(state).toBeDefined();
    expect(state.lastSeenDbId).toBe(101);
    expect(state.hasMoreOlder).toBe(true);
  });

  it('stamps lastSeenDbId=null when dbMessages is empty (brand-new conv)', () => {
    // Edge: conversation_resumed can fire with zero history if the
    // server has nothing persisted yet (cold-open of a session that
    // had no committed turns). The state must still be stamped so the
    // next selectConversation takes the fast path with a clean cursor.
    const store = mkConvResumedStore();
    handleConversationResumed(store, {
      conversationId: 'conv-1',
      agentId: 'agent-a',
      workDir: '/tmp/wd',
      dbMessages: [],
      hasMoreMessages: false,
    });

    const state = store.chatSessionState['conv-1'];
    expect(state).toBeDefined();
    expect(state.lastSeenDbId).toBeNull();
    expect(state.hasMoreOlder).toBe(false);
  });

  function mkConvResumedStore() {
    return {
      agents: [{ id: 'agent-a', name: 'Agent A' }],
      conversations: [],
      panels: [],
      activeConversations: [],
      messagesMap: {},
      chatSessionState: {},
      conversationTitles: {},
      hasMoreMessages: false,
      currentAgent: null,
      currentAgentInfo: null,
      currentWorkDir: null,
      formatDbMessage,
      addMessage() { /* no-op */ },
      sendWsMessage() { /* no-op */ },
      saveOpenSessions() { /* no-op */ },
      setRefreshingSession() { /* no-op */ },
    };
  }
});

describe('chatSessionState lifecycle — cleanup', () => {
  it('closeSession deletes the conv from chatSessionState', () => {
    const store = mkStore({
      messagesMap: { 'conv-1': [] },
      chatSessionState: {
        'conv-1': { lastSeenDbId: 5, hasMoreOlder: false },
      },
      conversations: [{ id: 'conv-1', agentId: 'agent-a', type: 'chat' }],
      activeConversations: ['conv-1'],
      processingConversations: {},
      executionStatusMap: {},
      pinnedSessions: [],
      _recentlyDeletedSessions: {},
      currentAgent: 'agent-a',
    });
    // closeSession touches localStorage via saveOpenSessions; override.
    store.saveOpenSessions = () => {};

    closeSession(store, 'conv-1', 'agent-a');

    expect(store.chatSessionState['conv-1']).toBeUndefined();
    expect(store.messagesMap['conv-1']).toBeUndefined();
  });

  it('handleConversationDeleted deletes the conv from chatSessionState', () => {
    const store = {
      conversations: [{ id: 'conv-1' }],
      messagesMap: { 'conv-1': [{ type: 'user', content: 'hi' }] },
      chatSessionState: {
        'conv-1': { lastSeenDbId: 5, hasMoreOlder: false },
      },
      conversationTitles: { 'conv-1': 'title' },
      customConversationTitles: {},
      processingConversations: { 'conv-1': true },
      executionStatusMap: { 'conv-1': {} },
      subagents: {},
      crewSessions: {},
      crewMessagesMap: {},
      crewOlderMessages: {},
      crewStatuses: {},
      activeConversations: ['conv-1'],
      panels: [],
      addMessage: () => {},
      saveOpenSessions: () => {},
    };

    handleConversationDeleted(store, { conversationId: 'conv-1' });

    expect(store.chatSessionState['conv-1']).toBeUndefined();
    expect(store.messagesMap['conv-1']).toBeUndefined();
  });
});

describe('selectConversation — pagination state (multi-panel safety)', () => {
  it('restores hasMoreMessages from chatSessionState[convId].hasMoreOlder on switch-back', () => {
    // Scenario:
    //   - User opens conv-1 and clicks "load older". A page lands;
    //     state records hasMoreOlder: true.
    //   - User switches to conv-2 (this used to globally reset
    //     hasMoreMessages = false, killing the load-older affordance
    //     for ALL future visits).
    //   - User switches back to conv-1. hasMoreMessages should re-emerge
    //     from chatSessionState rather than the global stale flag.
    const cached = [
      formatDbMessage({ id: 5, role: 'user', content: 'hi', created_at: 1000 }),
    ];
    const store = mkStore({
      messagesMap: { 'conv-1': cached },
      chatSessionState: {
        'conv-1': { lastSeenDbId: 5, hasMoreOlder: true },
      },
      hasMoreMessages: false, // global was reset by a prior switch
      activeConversations: ['conv-other'],
    });

    selectConversation(store, 'conv-1');

    expect(store.hasMoreMessages).toBe(true);
    // loadingMoreMessages always resets on switch (drops any in-flight
    // load-more spinner from the previous conv).
    expect(store.loadingMoreMessages).toBe(false);
  });

  it('falls back to hasMoreMessages=false when chatSessionState has no record', () => {
    const cached = [
      formatDbMessage({ id: 5, role: 'user', content: 'hi', created_at: 1000 }),
    ];
    const store = mkStore({
      messagesMap: { 'conv-1': cached },
      chatSessionState: {}, // never visited via handleSyncMessagesResult yet
      hasMoreMessages: true, // stale global from elsewhere
      activeConversations: ['conv-other'],
    });

    selectConversation(store, 'conv-1');

    // No per-conv record → false fallback (matches pre-fix default).
    expect(store.hasMoreMessages).toBe(false);
  });
});
