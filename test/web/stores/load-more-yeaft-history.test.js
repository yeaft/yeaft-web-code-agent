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

import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isProxy, reactive } from 'vue';

// `conversationHandler.js` transitively imports `web/stores/auth.js`,
// which does `const { defineStore } = Pinia;` against a global Pinia
// (loaded via CDN in the browser). Shim it for Node-side tests.
globalThis.Pinia = globalThis.Pinia || {
  defineStore: () => () => ({}),
};

const { handleYeaftHistoryChunk } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
const { yeaftHistoryIdentityKey } = await import('../../../web/stores/helpers/yeaft-history-identity.js');
const {
  isDurableYeaftHistoryRow,
  pruneConversationMessageRetention,
  pruneYeaftHistoryCache,
  YEAFT_HISTORY_CACHE_LIMITS,
} = await import('../../../web/stores/helpers/yeaft-history-cache.js');
const {
  commitYeaftHistoryPage,
  planNextYeaftHistoryPage,
} = await import('../../../web/stores/helpers/yeaft-history-pagination.js');
const {
  activeYeaftHistoryIdentity,
  beginYeaftHistoryLoad,
  failYeaftHistoryLoad,
  finishYeaftHistoryLoad,
  isCurrentYeaftHistoryResponse,
  syncActiveYeaftHistoryLoad,
} = await import('../../../web/stores/helpers/yeaft-history-load.js');
const { shouldShowYeaftOnboardingGuide } = await import('../../../web/utils/yeaftOnboarding.js');
const {
  getDefaultYeaftVisibleTurns,
  getYeaftWindowLoadStepTurns,
  hasHiddenScopedYeaftMessageTurns,
  sliceScopedYeaftMessagesByRecentTurns,
} = await import('../../../web/stores/helpers/yeaft-message-window.js');
const { conversationRepositoryFor } = await import('../../../web/stores/helpers/conversation-repository.js');

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
function loadMoreYeaftHistory(turns = getYeaftWindowLoadStepTurns()) {
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

  const requestedTurns = Math.min(50, Math.max(1, Number.isFinite(turns)
    ? Math.floor(turns)
    : getYeaftWindowLoadStepTurns()));

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
    turns: requestedTurns,
  });
}

function mkStore(overrides = {}) {
  const sent = [];
  const store = {
    currentView: 'yeaft',
    yeaftConversationId: 'yeaft-1',
    currentAgent: 'agent-1',
    yeaftHasMoreHistory: true,
    yeaftLoadingMoreHistory: false,
    yeaftOldestLoadedSeq: 100,
    yeaftSessionHistoryState: {},
    yeaftMessageWindowState: {},
    messagesMap: {},
    continueYeaftHistoryDelta: vi.fn(() => true),
    clearYeaftHistoryMemory: vi.fn(),
    sendWsMessage(msg) { sent.push(msg); },
    _sent: sent,
    ...overrides,
  };
  store.conversationRepository = conversationRepositoryFor(store);
  return store;
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
  const sessionKey = state.yeaftActiveSessionFilter || '__all__';
  const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
    || getDefaultYeaftVisibleTurns();
  return sliceScopedYeaftMessagesByRecentTurns(raw, state.yeaftActiveSessionFilter || null, visibleTurns);
}

function hasHiddenYeaftMessages(state) {
  const convId = state.yeaftConversationId || null;
  const raw = convId ? (state.messagesMap[convId] || []) : [];
  const sessionKey = state.yeaftActiveSessionFilter || '__all__';
  const visibleTurns = state.yeaftMessageWindowState[sessionKey]?.visibleTurns
    || getDefaultYeaftVisibleTurns();
  return hasHiddenScopedYeaftMessageTurns(raw, state.yeaftActiveSessionFilter || null, visibleTurns);
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

  const targetAgentId = next ? resolveAgentIdForSession(this, next) : this.currentAgent;
  if (targetAgentId && next && !savedState?.loading) {
    const latestSeq = Number.isFinite(savedState?.latestSeq) ? savedState.latestSeq : null;
    if (savedState?.loaded && latestSeq === null) return;
    const payload = { type: 'yeaft_load_history', agentId: targetAgentId, sessionId: next };
    if (latestSeq !== null) payload.afterSeq = latestSeq;
    else payload.limit = 50;

    if (savedState?.loaded) {
      if (savedState?.syncingAfterSeq === latestSeq) return;
      this.yeaftSessionHistoryState = {
        ...this.yeaftSessionHistoryState,
        [sessionKey]: { ...savedState, loaded: true, loading: false, syncingAfterSeq: latestSeq, latestSeq },
      };
      this.yeaftLoadingMoreHistory = false;
    } else {
      this.yeaftSessionHistoryState = {
        ...this.yeaftSessionHistoryState,
        [sessionKey]: { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0, syncingAfterSeq: null, latestSeq },
      };
      this.yeaftLoadingMoreHistory = true;
    }
    this.sendWsMessage(payload);
  }
}

const consolidatedHistoryScenarios = [];
function historyScenario(name, run) { consolidatedHistoryScenarios.push({ name, run }); }
async function runConsolidatedHistoryScenarios() {
  for (const scenario of consolidatedHistoryScenarios) {
    try { await scenario.run(); }
    catch (error) { error.message = `[${scenario.name}] ${error.message}`; throw error; }
  }
}

describe('Conversation Repository', () => {
  it('keeps durable rows and ephemeral overlays in one stable reactive projection', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    const repository = store.conversationRepository;

    repository.commitDurable({
      conversationId: 'yeaft-1',
      agentId: 'agent-1',
      sessionId: 'session-a',
      rows: [
        { id: 'm0002', messageId: 'm0002', stableKey: 'durable:m0002', seq: 2, type: 'assistant', content: 'answer', sessionId: 'session-a', isHistory: true },
        { id: 'm0001', messageId: 'm0001', stableKey: 'durable:m0001', seq: 1, type: 'user', content: 'question', sessionId: 'session-a', isHistory: true },
      ],
      mode: 'recent',
    });
    const projection = store.messagesMap['yeaft-1'];
    repository.upsertOverlay({
      conversationId: 'yeaft-1',
      agentId: 'agent-1',
      sessionId: 'session-a',
      row: { id: 'turn-live', messageId: 'turn-live', type: 'assistant', content: 'stream', sessionId: 'session-a', turnId: 'turn-live', isStreaming: true, status: 'pending' },
    });
    repository.appendOverlayText({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a', turnId: 'turn-live', text: 'ing',
    });

    expect(store.messagesMap['yeaft-1']).toBe(projection);
    expect(projection.map(row => row.content)).toEqual(['question', 'answer', 'streaming']);
    expect(repository.snapshot('yeaft-1', 'session-a')).toMatchObject({
      durableRows: [expect.objectContaining({ id: 'm0001' }), expect.objectContaining({ id: 'm0002' })],
      overlayRows: [expect.objectContaining({ id: 'turn-live', isStreaming: true })],
    });
  });

  it('reconciles optimistic and streaming overlays when persisted history arrives', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    const repository = store.conversationRepository;
    repository.upsertOverlay({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a',
      row: { id: 'client-1', messageId: 'client-1', clientMessageId: 'client-1', stableKey: 'optimistic:client-1', type: 'user', content: 'hello', sessionId: 'session-a' },
    });
    repository.upsertOverlay({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a',
      row: { id: 'live-a', messageId: 'live-a', type: 'assistant', content: 'partial', sessionId: 'session-a', turnId: 'turn-1', isStreaming: true, status: 'pending' },
    });

    repository.commitDurable({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a', mode: 'delta',
      rows: [
        { id: 'm0010', messageId: 'm0010', clientMessageId: 'client-1', stableKey: 'durable:m0010', seq: 10, type: 'user', content: 'hello', sessionId: 'session-a', turnId: 'turn-1', isHistory: true },
        { id: 'm0011', messageId: 'm0011', stableKey: 'durable:m0011', seq: 11, type: 'assistant', content: 'partial complete', sessionId: 'session-a', turnId: 'turn-1', _hasPersistedTurnId: true, isHistory: true },
      ],
    });

    expect(store.messagesMap['yeaft-1']).toHaveLength(2);
    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({ id: 'm0010', clientMessageId: 'client-1' }),
      expect.objectContaining({ id: 'm0011', content: 'partial complete', isStreaming: false }),
    ]);
    expect(repository.snapshot('yeaft-1', 'session-a').overlayRows).toEqual([]);

    // A later durable assistant response must not jump above its still-local
    // user prompt, nor above earlier streaming text or tools from this turn.
    repository.replaceProjection('yeaft-1', []);
    const liveRows = [
      { id: 'client-2', messageId: 'client-2', clientMessageId: 'client-2', type: 'user', content: 'question', timestamp: 100 },
      { id: 'live-2', type: 'assistant', content: 'working', turnId: 'turn-2', timestamp: 200, isStreaming: true },
      { id: 'tool-2', type: 'tool-use', toolName: 'Bash', timestamp: 200 },
    ].map(row => ({ ...row, sessionId: 'session-a' }));
    for (const row of liveRows) repository.upsertOverlay({ conversationId: 'yeaft-1', row });
    const projection = store.messagesMap['yeaft-1'];
    repository.commitDurable({
      conversationId: 'yeaft-1', sessionId: 'session-a', mode: 'delta',
      rows: [{ id: 'm0022', seq: 22, type: 'assistant', content: 'later response', timestamp: 300, sessionId: 'session-a', isHistory: true }],
    });
    expect(projection.map(row => row.id)).toEqual(['client-2', 'live-2', 'tool-2', 'm0022']);
    repository.appendOverlayText({ conversationId: 'yeaft-1', sessionId: 'session-a', turnId: 'turn-2', text: ' still' });
    expect(projection[1].content).toBe('working still');
    expect(projection[1].timestamp).toBe(200);
    repository.commitDurable({
      conversationId: 'yeaft-1', sessionId: 'session-a', mode: 'delta',
      rows: [{ id: 'm0020', messageId: 'm0020', seq: 20, clientMessageId: 'client-2', type: 'user', content: 'question', timestamp: 100, sessionId: 'session-a', isHistory: true }],
    });
    expect(store.messagesMap['yeaft-1']).toBe(projection);
    expect(projection.map(row => row.id)).toEqual(['m0020', 'live-2', 'tool-2', 'm0022']);

    // Out-of-order live arrivals also sort by time; equal-time sibling rows
    // remain stable instead of changing position on each projection rebuild.
    repository.upsertOverlay({ conversationId: 'yeaft-1', row: { id: 'late-arrival', type: 'assistant', timestamp: 150, isStreaming: true } });
    repository.replaceProjection('yeaft-1', [...projection]);
    expect(projection.map(row => row.id)).toEqual(['m0020', 'late-arrival', 'live-2', 'tool-2', 'm0022']);
    repository.upsertOverlay({ conversationId: 'yeaft-1', row: { id: '999-local', type: 'user', timestamp: 400 } });
    repository.upsertOverlay({ conversationId: 'yeaft-1', row: { id: '100-local', type: 'user', timestamp: 400 } });
    expect(projection.slice(-2).map(row => row.id)).toEqual(['999-local', '100-local']);
    repository.commitDurable({
      conversationId: 'yeaft-1', sessionId: 'session-a', mode: 'delta',
      rows: [{ id: 'live-2', seq: 21, type: 'assistant', content: 'working still', timestamp: 200, sessionId: 'session-a', isHistory: true, isStreaming: false }],
    });
    expect(projection.filter(row => row.timestamp === 200).map(row => row.id)).toEqual(['live-2', 'tool-2']);
  });

  it('keeps newer overlays while replacing a mismatched durable generation', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    const repository = store.conversationRepository;
    repository.commitDurable({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a', mode: 'recent',
      rows: [{ id: 'old', messageId: 'old', stableKey: 'durable:old', seq: 1, type: 'user', content: 'old', sessionId: 'session-a', isHistory: true }],
    });
    repository.upsertOverlay({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a',
      row: { id: 'pending', messageId: 'pending', clientMessageId: 'pending', type: 'user', content: 'pending', sessionId: 'session-a' },
    });
    repository.commitDurable({
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-a', mode: 'recent',
      replaceDurable: true,
      rows: [{ id: 'new', messageId: 'new', stableKey: 'durable:new', seq: 2, type: 'assistant', content: 'new', sessionId: 'session-a', isHistory: true }],
    });

    expect(store.messagesMap['yeaft-1'].map(row => row.content)).toEqual(['new', 'pending']);
  });
});

describe('Yeaft conversation loading state', () => {
  it('keeps background prefetch off the visible older-history spinner', () => {
    const sessionKey = yeaftHistoryIdentityKey('agent-1', 'session-a');
    const store = mkStore({
      currentAgent: 'agent-1',
      yeaftActiveSessionFilter: 'session-a',
      yeaftSessionHistoryState: {
        [sessionKey]: { loading: true, mode: 'prefetch', hasMore: true, oldestSeq: 10 },
      },
    });

    syncActiveYeaftHistoryLoad(store);

    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(10);
  });

  async function verifyLoadingState() {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID');
    let uuid = 0;
    randomUUID.mockImplementation(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`);
    try {
      const source = await readFile(new URL('../../../web/stores/chat.js', import.meta.url), 'utf8');
      const start = source.indexOf('setActiveSessionFilter(groupId, opts = {}) {');
      const end = source.indexOf('\n    },\n\n    // feat-yeaft-debug-console', start);
      const body = source.slice(start, end);
      const store = mkStore({
        yeaftActiveSessionFilter: 'g1',
        yeaftSessionAgentById: { g1: 'agent-1' },
        resolveYeaftSessionAgentId: () => 'agent-1',
        yeaftHistoryLoadError: null,
      });
      expect(body).not.toContain('if (savedState?.loading) return;');
      expect(body.indexOf('this.yeaftConversationId = targetConversationId;')).toBeGreaterThan(-1);
      expect(body.indexOf('gs.setActive(next, targetAgentId || null);')).toBeGreaterThan(-1);

      // Cold runtime boot emits the history chunk before session_ready. The
      // chunk already carries the authoritative bridge conversationId, so the
      // active Session must paint from it immediately instead of remaining on
      // the empty local placeholder until metadata finishes loading.
      const localConversationId = 'yeaft-local-agent-1-cold';
      const bridgeConversationId = 'yeaft-agent-1-cold';
      const coldStore = mkStore({
        currentAgent: 'agent-1',
        yeaftConversationId: localConversationId,
        yeaftConversationIdsByAgent: { 'agent-1': localConversationId },
        yeaftSessionAgentById: { g1: 'agent-1' },
        yeaftActiveSessionFilter: 'g1',
        activeConversations: [localConversationId],
        processingConversations: { [localConversationId]: true },
        executionStatusMap: { [localConversationId]: { status: 'processing' } },
        messagesMap: {
          [localConversationId]: [{
            id: 'local-pending',
            messageId: 'local-pending',
            clientMessageId: 'local-pending',
            type: 'user',
            content: 'pending send',
            sessionId: 'g1',
          }],
        },
        resolveYeaftSessionAgentId: () => 'agent-1',
        yeaftHistoryLoadError: null,
      });
      coldStore.isCurrentYeaftHistoryResponse = msg => isCurrentYeaftHistoryResponse(coldStore, msg);
      coldStore.finishYeaftHistoryLoad = (msg, patch) => finishYeaftHistoryLoad(coldStore, msg, patch);
      const coldRequest = beginYeaftHistoryLoad(coldStore, {
        agentId: 'agent-1', sessionId: 'g1', mode: 'recent', preserveLoaded: false,
      });
      handleYeaftHistoryChunk(coldStore, {
        agentId: 'agent-1',
        conversationId: bridgeConversationId,
        sessionId: 'g1',
        requestId: coldRequest.requestId,
        mode: 'recent',
        messages: [{ id: 'm0001', role: 'assistant', content: 'persisted answer', sessionId: 'g1' }],
        oldestSeq: 1,
        latestSeq: 1,
        hasMore: false,
      });
      expect(coldStore.yeaftConversationId).toBe(bridgeConversationId);
      expect(coldStore.yeaftConversationIdsByAgent['agent-1']).toBe(bridgeConversationId);
      expect(coldStore.activeConversations).toEqual([bridgeConversationId]);
      expect(coldStore.messagesMap[bridgeConversationId].map(row => row.id)).toEqual([
        'm0001',
        'local-pending',
      ]);
      expect(visibleMessages(coldStore).map(row => row.content)).toEqual([
        'persisted answer',
        'pending send',
      ]);
      expect(coldStore.messagesMap[localConversationId]).toBeUndefined();
      expect(coldStore.processingConversations).toEqual({ [bridgeConversationId]: true });
      expect(coldStore.executionStatusMap).toEqual({
        [bridgeConversationId]: { status: 'processing' },
      });

      const first = beginYeaftHistoryLoad(store, {
        agentId: 'agent-1', sessionId: 'g1', mode: 'recent', preserveLoaded: false,
      });
      const second = beginYeaftHistoryLoad(store, {
        agentId: 'agent-1', sessionId: 'g1', mode: 'recent', preserveLoaded: false,
      });

      expect(isCurrentYeaftHistoryResponse(store, {
        agentId: 'agent-1', sessionId: 'g1', requestId: first.requestId,
      })).toBe(false);
      expect(finishYeaftHistoryLoad(store, {
        agentId: 'agent-1', sessionId: 'g1', requestId: first.requestId,
      }, { loaded: true, count: 99 })).toBeNull();
      expect(finishYeaftHistoryLoad(store, {
        agentId: 'agent-1', sessionId: 'g1', requestId: second.requestId,
      }, { loaded: true, count: 2, hasMore: true, oldestSeq: 7 }, 'completion')).toMatchObject({
        loaded: false, loading: true, count: 0, requestId: second.requestId,
        completionSeen: true,
      });
      expect(finishYeaftHistoryLoad(store, {
        agentId: 'agent-1', sessionId: 'g1', requestId: second.requestId,
      }, { loaded: true, count: 2, hasMore: true, oldestSeq: 7 }, 'chunk')).toMatchObject({
        loaded: true, loading: false, count: 2, requestId: null,
      });
      expect(store.yeaftLoadingMoreHistory).toBe(false);
      expect(store.yeaftHasMoreHistory).toBe(true);
      expect(store.yeaftOldestLoadedSeq).toBe(7);

      const active = beginYeaftHistoryLoad(store, {
        agentId: 'agent-2', sessionId: 'g2', mode: 'recent', preserveLoaded: false,
      });
      const inactive = beginYeaftHistoryLoad(store, {
        agentId: 'agent-1', sessionId: 'g1', mode: 'recent', preserveLoaded: false,
      });
      store.currentAgent = 'agent-2';
      store.yeaftActiveSessionFilter = 'g2';
      store.yeaftSessionAgentById.g2 = 'agent-2';
      store.resolveYeaftSessionAgentId = id => store.yeaftSessionAgentById[id];
      finishYeaftHistoryLoad(store, {
        agentId: 'agent-1', sessionId: 'g1', requestId: inactive.requestId,
      }, { loaded: true, count: 4 });
      expect(store.yeaftLoadingMoreHistory).toBe(true);
      expect(store.yeaftSessionHistoryState[yeaftHistoryIdentityKey('agent-2', 'g2')].requestId).toBe(active.requestId);
      verifyTimeoutAndRestore();
    } finally {
      randomUUID.mockRestore();
    }
  }

  // The second half covers timeout recovery plus the cold-restore selectors in
  // the same state-machine scenario, keeping the bounded core suite at 499.
  function verifyTimeoutAndRestore() {
    const key = yeaftHistoryIdentityKey('agent-1', 'g1');
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      yeaftSessionAgentById: { g1: 'agent-1' },
      resolveYeaftSessionAgentId: () => 'agent-1',
      yeaftHistoryLoadError: null,
      yeaftSessionHistoryState: { [key]: { loaded: true, count: 3, latestSeq: 12 } },
    });
    const request = beginYeaftHistoryLoad(store, {
      agentId: 'agent-1', sessionId: 'g1', mode: 'delta', preserveLoaded: true, latestSeq: 12,
    });
    expect(failYeaftHistoryLoad(store, {
      agentId: 'agent-1', sessionId: 'g1', requestId: request.requestId,
      error: 'history_load_timeout',
    })).toBe(true);
    expect(store.yeaftSessionHistoryState[key]).toMatchObject({
      loaded: true, loading: false, count: 3, error: 'history_load_timeout',
    });
    expect(store.yeaftHistoryLoadError).toBe('history_load_timeout');
    expect(shouldShowYeaftOnboardingGuide({
      agentInventoryReady: false, hasYeaftAgent: false, sessionsReady: false, sessionsEmpty: true,
    })).toBe(false);
    expect(shouldShowYeaftOnboardingGuide({
      agentInventoryReady: true, hasYeaftAgent: true, sessionsReady: true, sessionsEmpty: true,
    })).toBe(true);

    const oldWindow = globalThis.window;
    globalThis.window = { Pinia: { useSessionsStore: () => ({ activeSessionId: 'g2' }) } };
    try {
      const restoringStore = mkStore({
        currentAgent: 'agent-2',
        yeaftActiveSessionFilter: null,
        yeaftSessionAgentById: { g2: 'agent-2' },
        resolveYeaftSessionAgentId: () => 'agent-2',
      });
      expect(activeYeaftHistoryIdentity(restoringStore)).toEqual({
        agentId: 'agent-2', sessionId: 'g2', sessionKey: yeaftHistoryIdentityKey('agent-2', 'g2'),
      });

      const localConversationId = 'yeaft-local-agent-2-restore';
      const bridgeConversationId = 'yeaft-agent-2-restore';
      restoringStore.yeaftConversationId = localConversationId;
      restoringStore.yeaftConversationIdsByAgent = { 'agent-2': bridgeConversationId };
      restoringStore.activeConversations = [localConversationId];
      restoringStore.messagesMap = {
        [localConversationId]: [{
          id: 'restore-pending',
          messageId: 'restore-pending',
          clientMessageId: 'restore-pending',
          type: 'user',
          content: 'restore pending',
          sessionId: 'g2',
        }],
      };
      handleYeaftHistoryChunk(restoringStore, {
        agentId: 'agent-2',
        conversationId: bridgeConversationId,
        sessionId: 'g2',
        mode: 'recent',
        messages: [{ id: 'restore-history', role: 'assistant', content: 'restored', sessionId: 'g2' }],
        oldestSeq: 1,
        latestSeq: 1,
        hasMore: false,
      });
      expect(restoringStore.yeaftConversationId).toBe(bridgeConversationId);
      expect(restoringStore.messagesMap[bridgeConversationId].map(row => row.id)).toEqual([
        'restore-history',
        'restore-pending',
      ]);
      expect(restoringStore.messagesMap[localConversationId]).toBeUndefined();
    } finally {
      globalThis.window = oldWindow;
    }
  }


  it('binds assistant history without VP attribution to the group default VP', async () => {
    await verifyLoadingState();
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
          {
            id: 'm0002', role: 'assistant', content: 'older-a1', sessionId: 'g1',
            responseKind: 'progress', incomplete: true, stopReason: 'error',
          },
        ],
        oldestSeq: 1,
        hasMore: false,
      });

      const [msg] = store.messagesMap['yeaft-1'];
      expect(msg.vpId).toBe('linus');
      expect(msg.speakerVpId).toBe('linus');
      expect(msg.isStreaming).toBe(false);
      expect(msg.isHistory).toBe(true);
      expect(msg).toMatchObject({
        responseKind: 'progress', incomplete: true, stopReason: 'error',
      });
    } finally {
      globalThis.window = oldWindow;
    }
  });

  it('keeps a tool-only persisted anchor on its derived tool row', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [{
        id: 'm0042',
        role: 'assistant',
        content: '',
        sessionId: 'g1',
        turnId: 'turn-tool-only',
        toolCalls: [{ id: 'tool-anchor', name: 'FileRead', input: { file_path: 'README.md' } }],
      }],
      oldestSeq: 42,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({
        id: 'm0042:tool:tool-anchor',
        messageId: 'm0042:tool:tool-anchor',
        persistedMessageId: 'm0042',
        type: 'tool-use',
        toolName: 'FileRead',
        toolInput: { file_path: 'README.md' },
        turnId: 'turn-tool-only',
      }),
    ]);
  });

  it('hydrates persisted image assets into the assistant turn', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [{
        id: 'm-image',
        role: 'assistant',
        content: '',
        sessionId: 'g1',
        turnId: 'turn-image',
        images: [{ assetId: 'asset-1', mimeType: 'image/png', filename: 'result.png', src: '/api/yeaft/assets/scope/asset?token=secret' }],
      }],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({
        type: 'chat-image',
        assetId: 'asset-1',
        sessionId: 'g1',
        turnId: 'turn-image',
        src: '/api/yeaft/assets/scope/asset?token=secret',
        isHistory: true,
      }),
    ]);
  });

  it('projects the durable RouteForward execution origin onto history rows', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      messages: [{
        id: 'm-route',
        role: 'assistant',
        content: 'handoff response',
        sessionId: 'g1',
        turnId: 'turn-route',
        speakerVpId: 'martin',
        executionOrigin: 'route_forward',
      }],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({
        id: 'm-route',
        type: 'assistant',
        turnId: 'turn-route',
        speakerVpId: 'martin',
        executionOrigin: 'route_forward',
        isHistory: true,
      }),
    ]);
  });

  it('does not start automatic older-page prefetch after a recent page', () => {
    const store = mkStore({ messagesMap: { 'yeaft-1': [] } });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      agentId: 'agent-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [
        { id: 'm0100', role: 'user', content: 'recent-q', sessionId: 'g1' },
        { id: 'm0101', role: 'assistant', content: 'recent-a', sessionId: 'g1' },
      ],
      oldestSeq: 100,
      nextBeforeSeq: 100,
      hasMore: true,
    });

    expect(store._sent).toEqual([]);
    expect(store.yeaftSessionHistoryState[yeaftHistoryIdentityKey('agent-1', 'g1')])
      .toMatchObject({ hasMore: true, oldestSeq: 100 });
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



  it('replaces stale recent bootstrap rows without blanking live session tail', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [
          { id: 'm0100', type: 'user', content: 'stale-q', sessionId: 'g1', timestamp: new Date('2026-05-01T09:59:59.000Z').getTime() },
          { id: 'stale-old', type: 'assistant', content: 'old stale row', sessionId: 'g1', timestamp: new Date('2026-05-01T09:59:30.000Z').getTime() },
          { id: 'live-user', type: 'user', content: 'live user', sessionId: 'g1', timestamp: new Date('2026-05-01T10:00:02.000Z').getTime() },
          { id: 'live-assistant', type: 'assistant', content: 'streaming', sessionId: 'g1', timestamp: new Date('2026-05-01T10:00:03.000Z').getTime(), isStreaming: true },
          { id: 'keep-g2', type: 'user', content: 'other session', sessionId: 'g2', timestamp: new Date('2026-05-01T09:59:58.000Z').getTime() },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [
        { id: 'm0100', role: 'user', content: 'fresh-q', sessionId: 'g1', ts: '2026-05-01T10:00:00.000Z' },
        { id: 'm0101', role: 'assistant', content: 'fresh-a', sessionId: 'g1', ts: '2026-05-01T10:00:01.000Z' },
      ],
      oldestSeq: 100,
      latestSeq: 101,
      hasMore: true,
    });

    const g1Ids = store.messagesMap['yeaft-1'].filter(m => m.sessionId === 'g1').map(m => m.id);
    expect(g1Ids).toEqual(['m0100', 'm0101', 'live-user', 'live-assistant']);
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toContain('keep-g2');
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).not.toContain('stale-old');
    expect(store.messagesMap['yeaft-1'].find(m => m.id === 'm0100')?.content).toBe('fresh-q');
    expect(store.messagesMap['yeaft-1'].find(m => m.id === 'live-assistant')?.isStreaming).toBe(true);
    expect(store.yeaftSessionHistoryState.g1).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      hasMore: true,
      oldestSeq: 100,
      latestSeq: 101,
      count: 2,
    }));
    expect(store.yeaftLoadingMoreHistory).toBe(false);
  });

  it('keeps older durable pages when a bounded recent replay refreshes the tail', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [
          { id: 'm0001', messageId: 'm0001', seq: 1, type: 'user', content: 'older q', sessionId: 'g1', isHistory: true, timestamp: 1 },
          { id: 'm0002', messageId: 'm0002', seq: 2, type: 'assistant', content: 'older a', sessionId: 'g1', isHistory: true, timestamp: 2 },
          { id: 'm0100', messageId: 'm0100', seq: 100, type: 'user', content: 'cached recent q', sessionId: 'g1', isHistory: true, timestamp: 100 },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [
        { id: 'm0100', role: 'user', content: 'fresh recent q', sessionId: 'g1', ts: 100 },
        { id: 'm0101', role: 'assistant', content: 'fresh recent a', sessionId: 'g1', ts: 101 },
      ],
      oldestSeq: 100,
      latestSeq: 101,
      hasMore: true,
    });

    expect(store.messagesMap['yeaft-1'].map(row => row.id)).toEqual([
      'm0001', 'm0002', 'm0100', 'm0101',
    ]);
    expect(store.messagesMap['yeaft-1'].find(row => row.id === 'm0100')?.content).toBe('fresh recent q');
  });

  it('continues a bounded delta after committing its new cursor', async () => {
    const store = mkStore({
      currentAgent: 'agent-1',
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [] },
      yeaftSessionHistoryState: {
        [yeaftHistoryIdentityKey('agent-1', 'g1')]: {
          loaded: true, loading: true, latestSeq: 10, requestId: 'delta-1',
        },
      },
      finishYeaftHistoryLoad(msg, patch) {
        this.yeaftSessionHistoryState[yeaftHistoryIdentityKey('agent-1', 'g1')] = {
          ...patch, requestId: null,
        };
      },
    });

    handleYeaftHistoryChunk(store, {
      agentId: 'agent-1',
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      requestId: 'delta-1',
      mode: 'delta',
      afterSeq: 10,
      latestSeq: 12,
      hasMoreAfter: true,
      messages: [{ id: 'm0012', role: 'assistant', content: 'page one', sessionId: 'g1' }],
    });
    await Promise.resolve();

    expect(store.continueYeaftHistoryDelta).toHaveBeenCalledWith('g1', 'agent-1', 12);
  });

  it('replaces stale durable rows on transcript identity mismatch without dropping live rows', async () => {
    const store = mkStore({
      currentAgent: 'agent-1',
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [
          { id: 'old', messageId: 'old', seq: 90, stableKey: 'old', type: 'assistant', content: 'stale', sessionId: 'g1', isHistory: true },
          { id: 'live', type: 'assistant', content: 'streaming', sessionId: 'g1', isStreaming: true },
        ],
      },
      yeaftSessionAgentById: { g1: 'agent-1' },
      yeaftSessionHistoryState: {
        [yeaftHistoryIdentityKey('agent-1', 'g1')]: {
          loaded: true, latestSeq: 90, streamId: 'stream-old', revision: 4,
        },
      },
      clearYeaftHistoryMemory: vi.fn(function ({ agentId, sessionId, preserveLiveRows, preserveSessionOwner }) {
        this.messagesMap['yeaft-1'] = this.messagesMap['yeaft-1'].filter(row => (
          row.sessionId !== sessionId || (preserveLiveRows && !isDurableYeaftHistoryRow(row))
        ));
        delete this.yeaftSessionHistoryState[yeaftHistoryIdentityKey(agentId, sessionId)];
        if (!preserveSessionOwner) delete this.yeaftSessionAgentById[sessionId];
      }),
    });

    handleYeaftHistoryChunk(store, {
      agentId: 'agent-1', conversationId: 'yeaft-1', sessionId: 'g1',
      mode: 'delta', afterSeq: 90, streamId: 'stream-new', revision: 0,
      latestSeq: 2, hasMoreAfter: false,
      messages: [
        { id: 'm0001', role: 'user', content: 'new question', sessionId: 'g1' },
        { id: 'm0002', role: 'assistant', content: 'new answer', sessionId: 'g1' },
      ],
    });
    await Promise.resolve();

    expect(store.clearYeaftHistoryMemory).toHaveBeenCalledWith({
      agentId: 'agent-1', sessionId: 'g1', preserveLiveRows: true, preserveSessionOwner: true,
    });
    expect(store.messagesMap['yeaft-1'].map(row => row.content)).toEqual([
      'new question', 'new answer', 'streaming',
    ]);
    expect(store.yeaftSessionAgentById.g1).toBe('agent-1');
    expect(store.continueYeaftHistoryDelta).not.toHaveBeenCalled();
  });

  it('keeps optimistic sends visible when a recent history reply races them', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [
          {
            id: 'u_local_race',
            messageId: 'u_local_race',
            clientMessageId: 'u_local_race',
            type: 'user',
            content: 'send while history is loading',
            sessionId: 'g1',
            turnId: 'u_local_race',
            timestamp: new Date('2026-05-01T09:59:59.000Z').getTime(),
          },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [
        { id: 'm0200', role: 'user', content: 'persisted q', sessionId: 'g1', ts: '2026-05-01T10:00:00.000Z' },
        { id: 'm0201', role: 'assistant', content: 'persisted a', sessionId: 'g1', ts: '2026-05-01T10:00:01.000Z' },
      ],
      oldestSeq: 200,
      latestSeq: 201,
      hasMore: false,
    });

    const rows = store.messagesMap['yeaft-1'].filter(m => m.sessionId === 'g1');
    expect(rows.map(m => m.id)).toEqual(['u_local_race', 'm0200', 'm0201']);
    expect(rows.find(m => m.id === 'u_local_race')).toEqual(expect.objectContaining({
      clientMessageId: 'u_local_race',
      content: 'send while history is loading',
    }));
    expect(store.yeaftLoadingMoreHistory).toBe(false);
  });

  it('restores quote metadata and the latest TodoWrite snapshot from Session history', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [] },
    });
    const quote = { id: 'm1', role: 'assistant', author: 'Linus', content: 'Earlier answer' };

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [
        { id: 'm0200', role: 'user', content: 'Follow up', sessionId: 'g1', quote },
        {
          id: 'm0201', role: 'assistant', content: 'Done', sessionId: 'g1', speakerVpId: 'vp-linus',
          ts: '2026-05-01T10:00:01.000Z',
          toolCalls: [
            { name: 'TodoWrite', input: { todos: [{ content: 'Old', status: 'pending' }] } },
            { name: 'Bash', input: { command: 'true' } },
            { name: 'TodoWrite', input: { todos: [{ content: 'Latest', status: 'completed' }] } },
          ],
        },
      ],
      oldestSeq: 200,
      latestSeq: 201,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({ id: 'm0200', type: 'user', quote }),
      expect.objectContaining({ id: 'm0201', type: 'assistant', content: 'Done' }),
      expect.objectContaining({
        id: 'm0201:todos', type: 'tool-use', toolName: 'TodoWrite',
        toolInput: { todos: [{ content: 'Latest', status: 'completed' }] },
        startTime: expect.any(Number),
      }),
      expect.objectContaining({
        id: 'm0201:tool:index%3A1', type: 'tool-use', toolName: 'Bash', toolInput: { command: 'true' },
        startTime: expect.any(Number),
      }),
    ]);
  });

  it('synthesizes full tool rows for tool-only assistant history', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [{
        id: 'm0200',
        role: 'assistant',
        content: '',
        sessionId: 'g1',
        speakerVpId: 'vp-linus',
        toolCalls: [
          { id: 'read-1', name: 'FileRead', input: { file_path: 'README.md' } },
          { id: 'grep-1', name: 'Grep', input: { pattern: 'tool' } },
          { id: 'bash-1', name: 'Bash', input: { command: 'true' } },
        ],
        ts: '2026-05-01T10:00:00.000Z',
      }],
      oldestSeq: 200,
      latestSeq: 200,
      hasMore: false,
    });

    const expectedStartTime = Date.parse('2026-05-01T10:00:00.000Z');
    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({ id: 'm0200:tool:read-1', type: 'tool-use', toolName: 'FileRead', speakerVpId: 'vp-linus', startTime: expectedStartTime }),
      expect.objectContaining({ id: 'm0200:tool:grep-1', type: 'tool-use', toolName: 'Grep', speakerVpId: 'vp-linus', startTime: expectedStartTime }),
      expect.objectContaining({ id: 'm0200:tool:bash-1', type: 'tool-use', toolName: 'Bash', speakerVpId: 'vp-linus', startTime: expectedStartTime }),
    ]);
    expect(store.yeaftSessionHistoryState.g1).toEqual(expect.objectContaining({ count: 1 }));
  });

  it('restores a persisted AskUser answer as a read-only card', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [{
        id: 'm0210',
        role: 'assistant',
        content: '',
        sessionId: 'g1',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        askUserResults: [{
          toolCallId: 'ask_1',
          status: 'answered',
          question: 'Continue?',
          options: ['Yes', 'No'],
          answers: { 'Continue?': 'Yes' },
        }],
        ts: '2026-05-01T10:00:00.000Z',
      }],
      oldestSeq: 210,
      latestSeq: 211,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual([
      expect.objectContaining({
        id: 'm0210:ask:ask_1',
        type: 'tool-use',
        toolId: 'ask_1',
        toolName: 'AskUserQuestion',
        askRequestId: null,
        askAnswered: true,
        selectedAnswers: { 'Continue?': 'Yes' },
        isHistory: true,
        hasResult: true,
        sessionId: 'g1',
        vpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
      }),
    ]);
  });

  it('keeps the submitted AskUser card during a recent refresh before the result is persisted', () => {
    const pendingCard = {
      id: 'live-pending-ask',
      type: 'tool-use',
      toolId: 'ask_pending',
      toolName: 'AskUserQuestion',
      askRequestId: 'request-pending',
      askPending: true,
      pendingAnswers: { 'Continue?': 'Yes' },
      sessionId: 'g1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      isHistory: false,
    };
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [pendingCard] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [{ id: 'm0209', role: 'user', content: 'question', sessionId: 'g1' }],
      oldestSeq: 209,
      latestSeq: 209,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'live-pending-ask',
        askPending: true,
        pendingAnswers: { 'Continue?': 'Yes' },
        askRequestId: 'request-pending',
      }),
    ]));
  });

  it('keeps an expired AskUser terminal state during a recent refresh', () => {
    const expiredCard = {
      id: 'live-expired-ask',
      type: 'tool-use',
      toolId: 'ask_expired',
      toolName: 'AskUserQuestion',
      askRequestId: null,
      askExpired: true,
      sessionId: 'g1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      isHistory: true,
    };
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: { 'yeaft-1': [expiredCard] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'recent',
      messages: [{ id: 'm0209', role: 'user', content: 'question', sessionId: 'g1' }],
      oldestSeq: 209,
      latestSeq: 209,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'live-expired-ask', askExpired: true, askRequestId: null }),
    ]));
  });

  it('settles the existing live AskUser card when answer history arrives as a delta', () => {
    const liveCard = {
      id: 'live-ask',
      type: 'tool-use',
      toolId: 'ask_1',
      toolName: 'AskUserQuestion',
      askRequestId: 'request-1',
      sessionId: 'g1',
      vpId: 'vp-a',
      turnId: 'turn-a',
      threadId: 'thread-a',
      isHistory: false,
    };
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      yeaftSessionHistoryState: {
        g1: { loaded: true, loading: false, latestSeq: 209, count: 1 },
      },
      messagesMap: { 'yeaft-1': [liveCard] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{
        id: 'm0210',
        role: 'assistant',
        content: '',
        sessionId: 'g1',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        askUserResults: [{
          toolCallId: 'ask_1',
          status: 'answered',
          question: 'Continue?',
          options: ['Yes'],
          answers: { 'Continue?': 'Yes' },
        }],
      }],
      latestSeq: 211,
    });

    const cards = store.messagesMap['yeaft-1'].filter(row => row.toolName === 'AskUserQuestion');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      toolId: 'ask_1',
      askRequestId: null,
      askAnswered: true,
      selectedAnswers: { 'Continue?': 'Yes' },
      isHistory: true,
    });
  });

  it('appends delta chunks without clobbering older-history cursors', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      yeaftHasMoreHistory: true,
      yeaftOldestLoadedSeq: 50,
      yeaftSessionHistoryState: {
        g1: { loaded: true, loading: false, hasMore: true, oldestSeq: 50, latestSeq: 100, count: 2 },
      },
      messagesMap: { 'yeaft-1': [{ id: 'm0100', type: 'user', content: 'cached', sessionId: 'g1', timestamp: 100 }] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{ id: 'm0101', role: 'assistant', content: 'new', sessionId: 'g1', ts: 101 }],
      latestSeq: 101,
      hasMore: false,
      oldestSeq: null,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['m0100', 'm0101']);
    expect(store.yeaftSessionHistoryState.g1).toEqual(expect.objectContaining({
      hasMore: true,
      oldestSeq: 50,
      latestSeq: 101,
      count: 3,
    }));
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(50);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
  });

  it('clears an empty delta sync without moving older-history cursors', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      yeaftHasMoreHistory: true,
      yeaftOldestLoadedSeq: 50,
      yeaftSessionHistoryState: {
        g1: {
          loaded: true,
          loading: false,
          hasMore: true,
          oldestSeq: 50,
          latestSeq: 100,
          syncingAfterSeq: 100,
          count: 2,
        },
      },
      messagesMap: { 'yeaft-1': [{ id: 'm0100', type: 'user', content: 'cached', sessionId: 'g1', timestamp: 100 }] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [],
      latestSeq: 100,
      afterSeq: 100,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['m0100']);
    expect(store.yeaftSessionHistoryState.g1).toEqual(expect.objectContaining({
      hasMore: true,
      oldestSeq: 50,
      latestSeq: 100,
      syncingAfterSeq: null,
      count: 2,
      loaded: true,
      loading: false,
    }));
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(50);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
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


  it('accepts inactive-session chunks so active turns survive session switches', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-B',
      yeaftLoadingMoreHistory: false,
      yeaftSessionHistoryState: {
        'session-A': { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
        'session-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 9, count: 1 },
      },
      messagesMap: { 'yeaft-1': [{ id: 'b1', type: 'user', content: 'B visible', sessionId: 'session-B', timestamp: 1 }] },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      mode: 'delta',
      messages: [
        { id: 'a1', role: 'user', content: 'A active prompt', sessionId: 'session-A', ts: '2026-05-01T10:00:00.000Z' },
        { id: 'a2', role: 'assistant', content: 'A active reply', sessionId: 'session-A', ts: '2026-05-01T10:00:01.000Z' },
      ],
      latestSeq: 2,
    });

    expect(store.messagesMap['yeaft-1'].filter(m => m.sessionId === 'session-A').map(m => m.content)).toEqual([
      'A active prompt',
      'A active reply',
    ]);
    expect(store.yeaftSessionHistoryState['session-A']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      latestSeq: 2,
    }));
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(100);
  });

  it('merges persisted user history with its optimistic client row', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [
          {
            id: 'u_local_1',
            messageId: 'u_local_1',
            clientMessageId: 'u_local_1',
            type: 'user',
            content: 'same prompt',
            sessionId: 'g1',
            turnId: 'u_local_1',
            timestamp: new Date('2026-05-01T10:00:00.000Z').getTime(),
          },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{
        id: 'm0100',
        role: 'user',
        content: 'same prompt',
        sessionId: 'g1',
        clientMessageId: 'u_local_1',
        ts: '2026-05-01T10:00:01.000Z',
      }],
      latestSeq: 100,
    });

    const users = store.messagesMap['yeaft-1'].filter(m => m.type === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual(expect.objectContaining({
      id: 'm0100',
      messageId: 'm0100',
      clientMessageId: 'u_local_1',
      content: 'same prompt',
    }));
  });

  it('merges persisted assistant history into a matching active stream only with the same turnId', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [{
          id: 'stream-1',
          type: 'assistant',
          content: 'partial answer',
          sessionId: 'g1',
          vpId: 'vp-linus',
          speakerVpId: 'vp-linus',
          threadId: 'thread-1',
          turnId: 'turn-active-1',
          isStreaming: true,
          timestamp: new Date('2026-05-01T10:00:00.000Z').getTime(),
        }],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{
        id: 'm0101',
        role: 'assistant',
        content: 'partial answer completed',
        sessionId: 'g1',
        speakerVpId: 'vp-linus',
        threadId: 'thread-1',
        turnId: 'turn-active-1',
        ts: '2026-05-01T10:00:01.000Z',
      }],
      latestSeq: 101,
    });

    const assistants = store.messagesMap['yeaft-1'].filter(m => m.type === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual(expect.objectContaining({
      id: 'm0101',
      messageId: 'm0101',
      content: 'partial answer completed',
      isStreaming: false,
      speakerVpId: 'vp-linus',
      threadId: 'thread-1',
      turnId: 'turn-active-1',
      _hasPersistedTurnId: true,
    }));
  });

  it('merges persisted assistant history into a completed live-local row with the same turnId', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [{
          id: 'local-random-assistant-id',
          type: 'assistant',
          content: 'completed live answer',
          sessionId: 'g1',
          vpId: 'vp-linus',
          speakerVpId: 'vp-linus',
          threadId: 'thread-1',
          turnId: 'turn-completed-1',
          isStreaming: false,
          timestamp: new Date('2026-05-01T10:00:00.000Z').getTime(),
        }],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{
        id: 'm0104',
        role: 'assistant',
        content: 'completed live answer with persisted suffix',
        sessionId: 'g1',
        speakerVpId: 'vp-linus',
        threadId: 'thread-1',
        turnId: 'turn-completed-1',
        ts: '2026-05-01T10:00:01.000Z',
      }],
      latestSeq: 104,
    });

    const assistants = store.messagesMap['yeaft-1'].filter(m => m.type === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual(expect.objectContaining({
      id: 'm0104',
      messageId: 'm0104',
      content: 'completed live answer with persisted suffix',
      isStreaming: false,
      isHistory: true,
      speakerVpId: 'vp-linus',
      threadId: 'thread-1',
      turnId: 'turn-completed-1',
      _hasPersistedTurnId: true,
    }));
  });

  it('does not merge prefix-matching assistant history from a different turn', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [{
          id: 'stream-1',
          type: 'assistant',
          content: 'Sure, I can',
          sessionId: 'g1',
          vpId: 'vp-linus',
          speakerVpId: 'vp-linus',
          threadId: 'thread-1',
          turnId: 'turn-active-1',
          isStreaming: true,
          timestamp: new Date('2026-05-01T10:00:00.000Z').getTime(),
        }],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{
        id: 'm0102',
        role: 'assistant',
        content: 'Sure, I can help with the old request.',
        sessionId: 'g1',
        speakerVpId: 'vp-linus',
        threadId: 'thread-1',
        turnId: 'turn-old-1',
        ts: '2026-05-01T10:00:01.000Z',
      }],
      latestSeq: 102,
    });

    const assistants = store.messagesMap['yeaft-1'].filter(m => m.type === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants.map(m => m.id)).toEqual(['stream-1', 'm0102']);
    expect(assistants[1]).toEqual(expect.objectContaining({
      id: 'm0102',
      messageId: 'm0102',
      content: 'Sure, I can help with the old request.',
      turnId: 'turn-old-1',
      _hasPersistedTurnId: true,
      isStreaming: false,
    }));
    expect(assistants[0]).toEqual(expect.objectContaining({
      id: 'stream-1',
      content: 'Sure, I can',
      turnId: 'turn-active-1',
      isStreaming: true,
    }));
  });

  it('does not prefix-merge assistant history that lacks persisted turnId', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'g1',
      messagesMap: {
        'yeaft-1': [{
          id: 'stream-1',
          type: 'assistant',
          content: '好的，我来',
          sessionId: 'g1',
          vpId: 'vp-linus',
          speakerVpId: 'vp-linus',
          threadId: 'thread-1',
          turnId: 'turn-active-1',
          isStreaming: true,
          timestamp: new Date('2026-05-01T10:00:00.000Z').getTime(),
        }],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'g1',
      mode: 'delta',
      messages: [{
        id: 'm0103',
        role: 'assistant',
        content: '好的，我来处理旧消息。',
        sessionId: 'g1',
        speakerVpId: 'vp-linus',
        threadId: 'thread-1',
        ts: '2026-05-01T10:00:01.000Z',
      }],
      latestSeq: 103,
    });

    const assistants = store.messagesMap['yeaft-1'].filter(m => m.type === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants.map(m => m.id)).toEqual(['stream-1', 'm0103']);
    expect(assistants[1]).toEqual(expect.objectContaining({
      turnId: 'm0103',
      _hasPersistedTurnId: false,
    }));
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
      expect.objectContaining({
        id: 'a-1',
        messageId: 'a-1',
        type: 'assistant',
        sessionId: 'g1',
        turnId: 'a-1',
        _hasPersistedTurnId: false,
        vpId: 'vp-linus',
        speakerVpId: 'vp-linus',
      }),
    ]);
  });

  it('keeps session-scoped cursor state isolated when accepting matching chunks', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      yeaftSessionHistoryState: {
        'session-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 77, count: 2 },
      },
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      messages: [{ id: 'a-old', role: 'user', content: 'A-old', sessionId: 'session-A' }],
      oldestSeq: 11,
      hasMore: false,
    });

    expect(store.yeaftSessionHistoryState['session-A']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      hasMore: false,
      oldestSeq: 11,
      count: 1,
    }));
    expect(store.yeaftSessionHistoryState['session-B']).toEqual(expect.objectContaining({
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


  historyScenario('keeps colliding persisted ids isolated across Sessions on one Agent', () => {
    const store = mkStore({
      currentAgent: 'agent-1',
      messagesMap: { 'yeaft-1': [] },
    });

    handleYeaftHistoryChunk(store, {
      agentId: 'agent-1',
      conversationId: 'yeaft-1',
      sessionId: 'session-a',
      mode: 'delta',
      messages: [{ id: 'm0001', role: 'user', content: 'A', sessionId: 'session-a' }],
      latestSeq: 1,
    });
    handleYeaftHistoryChunk(store, {
      agentId: 'agent-1',
      conversationId: 'yeaft-1',
      sessionId: 'session-b',
      mode: 'delta',
      messages: [{ id: 'm0001', role: 'user', content: 'B', sessionId: 'session-b' }],
      latestSeq: 1,
    });

    expect(store.messagesMap['yeaft-1'].map(row => [row.sessionId, row.id])).toEqual([
      ['session-a', 'm0001'],
      ['session-b', 'm0001'],
    ]);
    expect(new Set(store.messagesMap['yeaft-1'].map(row => row.stableKey)).size).toBe(2);
  });

  historyScenario('bounds resident live turns while preserving unsafe rows and other Sessions', () => {
    const conversationId = 'yeaft-live-retention';
    const targetSessionId = 'session-live';
    const otherSessionRow = {
      id: 'other-session',
      type: 'user',
      content: 'other Session stays isolated',
      sessionId: 'session-other',
    };
    const rows = [otherSessionRow];
    for (let turn = 1; turn <= 8; turn += 1) {
      rows.push(
        {
          id: `user-${turn}`,
          type: 'user',
          content: `prompt ${turn}`,
          sessionId: targetSessionId,
          clientMessageId: `client-${turn}`,
          dbMessageId: turn,
        },
        {
          id: `assistant-${turn}`,
          type: 'assistant',
          content: `response ${turn}`,
          sessionId: targetSessionId,
          turnId: `turn-${turn}`,
          status: 'completed',
        },
        {
          id: `tool-${turn}`,
          type: 'tool-use',
          toolName: 'Read',
          toolResult: `result ${turn}`,
          hasResult: true,
          sessionId: targetSessionId,
          turnId: `turn-${turn}`,
        },
      );
    }
    rows.push(
      {
        id: 'optimistic-user',
        type: 'user',
        content: 'pending send',
        sessionId: targetSessionId,
        clientMessageId: 'pending-client',
      },
      {
        id: 'streaming-assistant',
        type: 'assistant',
        content: 'still streaming',
        sessionId: targetSessionId,
        turnId: 'turn-active',
        status: 'pending',
        isStreaming: true,
      },
      {
        id: 'pending-ask',
        type: 'tool-use',
        toolName: 'AskUserQuestion',
        askPending: true,
        hasResult: false,
        sessionId: targetSessionId,
        turnId: 'turn-active',
      },
    );
    const store = { messagesMap: { [conversationId]: rows } };

    const result = pruneConversationMessageRetention(store, {
      conversationId,
      agentId: 'agent-live',
      sessionId: targetSessionId,
      limits: { maxTurnsPerSession: 2 },
    });

    const kept = store.messagesMap[conversationId];
    expect(result.evictedRows).toBeGreaterThan(0);
    expect(kept.filter(row => row.sessionId === targetSessionId)).toHaveLength(6);
    expect(kept).toContain(otherSessionRow);
    expect(kept.some(row => row.id === 'optimistic-user')).toBe(true);
    expect(kept.some(row => row.id === 'streaming-assistant')).toBe(true);
    expect(kept.some(row => row.id === 'pending-ask')).toBe(true);
    expect(kept.some(row => row.id === 'user-8')).toBe(true);
    expect(kept.some(row => row.id === 'assistant-8')).toBe(true);
    expect(kept.some(row => row.id === 'tool-8')).toBe(true);
    expect(kept.some(row => row.id === 'user-1')).toBe(false);
  });

  historyScenario('reopens exhausted pagination after resident durable eviction', () => {
    const conversationId = 'yeaft-reload-evicted';
    const agentId = 'agent-reload';
    const sessionId = 'session-reload';
    const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
    const rows = [];
    for (let seq = 1; seq <= 12; seq += 1) {
      rows.push({
        id: `m${seq}`,
        messageId: `m${seq}`,
        persistedMessageId: `m${seq}`,
        stableKey: `${sessionKey}:${seq}`,
        type: seq % 2 === 1 ? 'user' : 'assistant',
        content: `row ${seq}`,
        sessionId,
        seq,
        status: 'completed',
      });
    }
    const sent = [];
    const store = {
      currentView: 'yeaft',
      currentAgent: agentId,
      yeaftActiveSessionFilter: sessionId,
      yeaftHasMoreHistory: false,
      yeaftLoadingMoreHistory: false,
      yeaftOldestLoadedSeq: 1,
      resolveYeaftSessionAgentId: id => (id === sessionId ? agentId : null),
      sendWsMessage: message => sent.push(message),
      messagesMap: { [conversationId]: rows },
      yeaftHistoryCacheState: {
        [sessionKey]: {
          agentId,
          sessionId,
          conversationId,
          rowCount: 12,
          byteCount: 1200,
          ranges: [{ startSeq: 1, endSeq: 12 }],
          rangeEpoch: 1,
        },
      },
      yeaftSessionHistoryState: {
        [sessionKey]: {
          loaded: true,
          serverOldestFetchedSeq: 1,
          oldestSeq: 1,
          serverHasMore: false,
          hasMore: false,
          gapTraversalInitialized: true,
          completedHistoryWorkKeys: ['server:9'],
        },
      },
    };

    pruneConversationMessageRetention(store, {
      conversationId,
      agentId,
      sessionId,
      limits: { maxTurnsPerSession: 2 },
    });

    const cache = store.yeaftHistoryCacheState[sessionKey];
    expect(store.messagesMap[conversationId].map(row => row.seq)).toEqual([9, 10, 11, 12]);
    expect(cache).toEqual(expect.objectContaining({
      rowCount: 4,
      ranges: [{ startSeq: 9, endSeq: 12 }],
      rangeEpoch: 2,
    }));
    const plan = planNextYeaftHistoryPage(
      store.yeaftSessionHistoryState[sessionKey],
      cache.ranges,
      cache.rangeEpoch,
    );
    expect(plan.request).toEqual(expect.objectContaining({ kind: 'server', beforeSeq: 9 }));
    expect(plan.state.hasMore).toBe(true);
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(9);

    loadMoreYeaftHistory.call(store, 10);
    expect(sent).toEqual([expect.objectContaining({
      type: 'yeaft_load_more_history',
      agentId,
      sessionId,
      beforeSeq: 9,
    })]);
  });

  historyScenario('does not mutate active pagination mirrors when pruning a background Session', () => {
    const conversationId = 'yeaft-background-prune';
    const activeAgentId = 'agent-active';
    const activeSessionId = 'session-active';
    const backgroundAgentId = 'agent-background';
    const backgroundSessionId = 'session-background';
    const backgroundKey = yeaftHistoryIdentityKey(backgroundAgentId, backgroundSessionId);
    const rows = [];
    for (let seq = 1; seq <= 8; seq += 1) {
      rows.push({
        id: `m${seq}`,
        messageId: `m${seq}`,
        persistedMessageId: `m${seq}`,
        type: seq % 2 === 1 ? 'user' : 'assistant',
        content: `row ${seq}`,
        sessionId: backgroundSessionId,
        seq,
        status: 'completed',
      });
    }
    const store = {
      currentAgent: activeAgentId,
      yeaftActiveSessionFilter: activeSessionId,
      yeaftHasMoreHistory: false,
      yeaftLoadingMoreHistory: false,
      yeaftOldestLoadedSeq: 77,
      resolveYeaftSessionAgentId: id => (id === activeSessionId ? activeAgentId : backgroundAgentId),
      messagesMap: { [conversationId]: rows },
      yeaftHistoryCacheState: {
        [backgroundKey]: {
          agentId: backgroundAgentId,
          sessionId: backgroundSessionId,
          conversationId,
          rowCount: 8,
          ranges: [{ startSeq: 1, endSeq: 8 }],
          rangeEpoch: 1,
        },
      },
      yeaftSessionHistoryState: {
        [backgroundKey]: {
          serverOldestFetchedSeq: 1,
          oldestSeq: 1,
          serverHasMore: false,
          hasMore: false,
        },
      },
    };

    pruneConversationMessageRetention(store, {
      conversationId,
      agentId: backgroundAgentId,
      sessionId: backgroundSessionId,
      limits: { maxTurnsPerSession: 2 },
    });

    expect(store.yeaftSessionHistoryState[backgroundKey]).toEqual(expect.objectContaining({
      hasMore: true,
      oldestSeq: 5,
    }));
    expect(store.yeaftHasMoreHistory).toBe(false);
    expect(store.yeaftOldestLoadedSeq).toBe(77);
  });

  historyScenario('keeps one oversized newest turn instead of splitting its boundary', () => {
    const conversationId = 'yeaft-oversized-turn';
    const sessionId = 'session-large';
    const rows = [
      { id: 'old-user', type: 'user', content: 'old', sessionId, dbMessageId: 1 },
      { id: 'old-assistant', type: 'assistant', content: 'old response', sessionId, status: 'completed' },
      { id: 'new-user', type: 'user', content: 'new', sessionId, dbMessageId: 2 },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `new-tool-${index}`,
        type: 'tool-use',
        toolName: 'Read',
        toolResult: 'x'.repeat(200),
        hasResult: true,
        sessionId,
        turnId: 'new-turn',
      })),
    ];
    const store = { messagesMap: { [conversationId]: rows } };

    pruneConversationMessageRetention(store, {
      conversationId,
      agentId: 'agent-large',
      sessionId,
      limits: { maxTurnsPerSession: 1 },
    });

    expect(store.messagesMap[conversationId].map(row => row.id)).toEqual([
      'new-user',
      ...Array.from({ length: 8 }, (_, index) => `new-tool-${index}`),
    ]);
  });

  historyScenario('bounds durable ranges while preserving optimistic/live tail rows', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-cache',
      yeaftHistoryCacheState: {},
      messagesMap: {
        'yeaft-1': [
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `m${String(index + 1).padStart(4, '0')}`,
            messageId: `m${String(index + 1).padStart(4, '0')}`,
            seq: index + 1,
            stableKey: `durable-${index + 1}`,
            type: index % 2 ? 'assistant' : 'user',
            content: `durable-${index + 1}`,
            sessionId: 'session-cache',
          })),
          {
            id: 'local-live',
            clientMessageId: 'local-live',
            stableKey: 'live-tail',
            type: 'user',
            content: 'optimistic tail',
            sessionId: 'session-cache',
          },
        ],
      },
    });
    const limits = { maxTurnsPerSession: 2 };

    pruneYeaftHistoryCache(store, {
      conversationId: 'yeaft-1',
      agentId: 'agent-1',
      sessionId: 'session-cache',
      incomingRows: [{ stableKey: 'durable-2' }],
      activeAgentId: 'agent-1',
      activeSessionId: 'session-cache',
      now: 100,
      limits,
    });

    const rows = store.messagesMap['yeaft-1'];
    expect(rows.filter(isDurableYeaftHistoryRow)).toHaveLength(4);
    expect(rows.some(row => row.content === 'optimistic tail')).toBe(true);
    expect(rows.some(row => row.stableKey === 'durable-2')).toBe(false);
    expect(store.yeaftHistoryCacheState[yeaftHistoryIdentityKey('agent-1', 'session-cache')])
      .toMatchObject({ rowCount: 4, ranges: expect.any(Array), lastAccessed: 100 });

    const sessionId = 'session-frontier';
    const conversationId = 'yeaft-frontier';
    const liveTail = {
      id: 'local-live-frontier',
      clientMessageId: 'local-live-frontier',
      stableKey: 'live-frontier',
      type: 'user',
      content: 'optimistic tail survives',
      sessionId,
    };
    const frontierStore = mkStore({
      currentAgent: 'agent-1',
      yeaftActiveSessionFilter: sessionId,
      yeaftHistoryCacheState: {},
      messagesMap: {
        [conversationId]: [
          ...Array.from({ length: 100 }, (_, index) => {
            const seq = 901 + index;
            return {
              id: `m${String(seq).padStart(4, '0')}`,
              messageId: `m${String(seq).padStart(4, '0')}`,
              seq,
              stableKey: `frontier-${seq}`,
              type: seq % 2 ? 'user' : 'assistant',
              content: `message ${seq}`,
              sessionId,
            };
          }),
          liveTail,
        ],
      },
    });
    let pagination = {
      loaded: true,
      hasMore: true,
      oldestSeq: 901,
      serverOldestFetchedSeq: 901,
      serverHasMore: true,
      requestedBeforeSeqs: [],
      gapQueue: [],
    };
    const cursors = [];
    while (pagination.serverHasMore) {
      const currentCacheState = frontierStore.yeaftHistoryCacheState[
        yeaftHistoryIdentityKey('agent-1', sessionId)
      ] || { ranges: [{ startSeq: 901, endSeq: 1000 }], rangeEpoch: 0 };
      const planned = planNextYeaftHistoryPage(
        pagination,
        currentCacheState.ranges,
        currentCacheState.rangeEpoch,
      );
      expect(planned.request?.kind).toBe('server');
      const beforeSeq = planned.request.beforeSeq;
      cursors.push(beforeSeq);
      const oldestSeq = Math.max(1, beforeSeq - 20);
      const incomingRows = Array.from({ length: beforeSeq - oldestSeq }, (_, index) => {
        const seq = oldestSeq + index;
        return {
          id: `m${String(seq).padStart(4, '0')}`,
          messageId: `m${String(seq).padStart(4, '0')}`,
          seq,
          stableKey: `frontier-${seq}`,
          type: seq % 2 ? 'user' : 'assistant',
          content: `message ${seq}`,
          sessionId,
        };
      });
      frontierStore.messagesMap[conversationId].push(...incomingRows);
      pruneYeaftHistoryCache(frontierStore, {
        conversationId,
        agentId: 'agent-1',
        sessionId,
        incomingRows,
        activeAgentId: 'agent-1',
        activeSessionId: sessionId,
        now: cursors.length,
        limits: YEAFT_HISTORY_CACHE_LIMITS,
      });
      const nextCacheState = frontierStore.yeaftHistoryCacheState[
        yeaftHistoryIdentityKey('agent-1', sessionId)
      ];
      pagination = commitYeaftHistoryPage(planned.state, {
        mode: 'older',
        oldestSeq,
        hasMore: oldestSeq > 1,
        ranges: nextCacheState.ranges,
        pageKind: planned.request.kind,
        cacheEpoch: nextCacheState.rangeEpoch,
      });
      expect(frontierStore.messagesMap[conversationId].filter(isDurableYeaftHistoryRow).length)
        .toBeLessThanOrEqual(YEAFT_HISTORY_CACHE_LIMITS.maxTurnsPerSession * 2);
    }

    expect(cursors[0]).toBe(901);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors.every((cursor, index) => index === 0 || cursor < cursors[index - 1])).toBe(true);
    expect(pagination.serverOldestFetchedSeq).toBe(1);
    expect(frontierStore.messagesMap[conversationId].some(row => row.content === 'optimistic tail survives'))
      .toBe(true);
    const cacheKey = yeaftHistoryIdentityKey('agent-1', sessionId);
    const retainedRanges = frontierStore.yeaftHistoryCacheState[cacheKey].ranges;
    expect(retainedRanges).toEqual([{ startSeq: 1, endSeq: 1000 }]);
    expect(frontierStore.messagesMap[conversationId].filter(isDurableYeaftHistoryRow).length)
      .toBeLessThanOrEqual(YEAFT_HISTORY_CACHE_LIMITS.maxTurnsPerSession * 2);
    const completedTraversal = planNextYeaftHistoryPage(
      pagination,
      retainedRanges,
      frontierStore.yeaftHistoryCacheState[cacheKey].rangeEpoch,
    );
    expect(completedTraversal.request).toBeNull();
    expect(completedTraversal.state.hasMore).toBe(false);

    const noProgressPlan = planNextYeaftHistoryPage({
      loaded: true,
      hasMore: true,
      oldestSeq: 901,
      serverOldestFetchedSeq: 901,
      serverHasMore: true,
      requestedBeforeSeqs: [],
      gapQueue: [],
      noProgressCount: 0,
    }, []);
    const noProgress = commitYeaftHistoryPage(noProgressPlan.state, {
      mode: 'older',
      oldestSeq: 901,
      hasMore: true,
      ranges: [],
    });
    expect(noProgress).toMatchObject({
      serverHasMore: false,
      paginationError: 'history_cursor_no_progress',
    });
    expect(planNextYeaftHistoryPage(noProgress, []).request).toBeNull();
  });

  historyScenario('does not evict another Session as a global capacity side effect', () => {
    const store = mkStore({
      yeaftHistoryCacheState: {},
      messagesMap: { 'yeaft-1': [] },
    });
    for (let index = 1; index <= 3; index += 1) {
      const sessionId = `session-${index}`;
      store.messagesMap['yeaft-1'].push(
        {
          id: 'm0001', messageId: 'm0001', seq: 1, stableKey: `durable-${index}`,
          type: 'user', content: `durable ${index}`, sessionId,
        },
        {
          id: `live-${index}`, clientMessageId: `live-${index}`, stableKey: `live-${index}`,
          type: 'user', content: `live ${index}`, sessionId,
        },
      );
      pruneYeaftHistoryCache(store, {
        conversationId: 'yeaft-1',
        agentId: 'agent-1',
        sessionId,
        incomingRows: [{ stableKey: `durable-${index}` }],
        now: index,
        limits: { maxTurnsPerSession: 1 },
      });
    }

    const rows = store.messagesMap['yeaft-1'];
    expect(rows.filter(isDurableYeaftHistoryRow)).toHaveLength(3);
    expect(rows.filter(row => row.clientMessageId).map(row => row.content)).toEqual([
      'live 1', 'live 2', 'live 3',
    ]);
  });

  it('keeps chronological order and dedupes rows when older session history overlaps cached rows', async () => {
    await runConsolidatedHistoryScenarios();
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: {
        'yeaft-1': [
          { id: 'm0003', messageId: 'm0003', type: 'user', content: 'newer-q', sessionId: 'session-A' },
          { id: 'm0004', messageId: 'm0004', type: 'assistant', content: 'newer-a', sessionId: 'session-A', speakerVpId: 'vp-ada' },
        ],
      },
    });

    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'oldest-q', sessionId: 'session-A' },
        { id: 'm0002', role: 'assistant', content: 'oldest-a', sessionId: 'session-A', speakerVpId: 'vp-linus' },
        { id: 'm0003', role: 'user', content: 'newer-q', sessionId: 'session-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['m0001', 'm0002', 'm0003', 'm0004']);
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['oldest-q', 'oldest-a', 'newer-q', 'newer-a']);

    // A later delta re-sorts the complete cache. It must not undo the older
    // prepend or move the optimistic tail into persisted history.
    store.messagesMap['yeaft-1'].push({
      id: 'optimistic-tail',
      messageId: 'optimistic-tail',
      clientMessageId: 'optimistic-tail',
      type: 'user',
      content: 'optimistic-tail',
      sessionId: 'session-A',
      timestamp: 1,
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      mode: 'delta',
      messages: [
        { id: 'm0005', role: 'assistant', content: 'delta-a', sessionId: 'session-A', speakerVpId: 'vp-ada' },
      ],
      latestSeq: 5,
      hasMore: false,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual([
      'm0001',
      'm0002',
      'm0003',
      'm0004',
      'm0005',
      'optimistic-tail',
    ]);
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

  it('accepts chunks whose sessionId no longer matches the active filter (race-with-session-switch)', () => {
    // Sequence: user is in session A, "Load older" fires while looking at A,
    // user switches to B before the chunk arrives. Rows are session-stamped,
    // so accepting A's chunk preserves A's cache without making B's filtered
    // view show A rows.
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-B',
      yeaftLoadingMoreHistory: true,           // spinner up from the A click
      messagesMap: {
        'yeaft-1': [
          { type: 'user', content: 'B-msg', sessionId: 'session-B' },
        ],
      },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',                    // stale: chunk is for the OLD session
      messages: [
        { id: 'm0001', role: 'user',      content: 'A-old-q', sessionId: 'session-A' },
        { id: 'm0002', role: 'assistant', content: 'A-old-a', sessionId: 'session-A' },
      ],
      oldestSeq: 1,
      hasMore: true,
    });
    expect(store.messagesMap['yeaft-1'].filter(m => m.sessionId === 'session-B').map(m => m.content)).toEqual(['B-msg']);
    expect(store.messagesMap['yeaft-1'].filter(m => m.sessionId === 'session-A').map(m => m.content)).toEqual(['A-old-q', 'A-old-a']);
    expect(store.yeaftSessionHistoryState['session-A']).toEqual(expect.objectContaining({ loading: false, hasMore: true, oldestSeq: 1 }));
    // Spinner mirrors only the active Session.
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    // Active cursor not corrupted by session A's data.
    expect(store.yeaftOldestLoadedSeq).toBe(100);
  });

  it('keeps the active Agent cursor intact when a same-id Session chunk arrives late from another Agent', () => {
    const sessionId = 'session_default';
    const agentAKey = yeaftHistoryIdentityKey('agent-a', sessionId);
    const agentBKey = yeaftHistoryIdentityKey('agent-b', sessionId);
    const store = mkStore({
      currentAgent: 'agent-b',
      yeaftActiveSessionFilter: sessionId,
      yeaftConversationId: 'conv-b',
      yeaftConversationIdsByAgent: { 'agent-a': 'conv-a', 'agent-b': 'conv-b' },
      yeaftLoadingMoreHistory: true,
      yeaftHasMoreHistory: true,
      yeaftOldestLoadedSeq: 10,
      yeaftSessionHistoryState: {
        [agentAKey]: { loaded: true, loading: true, latestSeq: 7, hasMore: true, oldestSeq: 3 },
        [agentBKey]: { loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10 },
      },
      messagesMap: { 'conv-a': [], 'conv-b': [{ type: 'user', content: 'B', sessionId }] },
    });

    handleYeaftHistoryChunk(store, {
      type: 'yeaft_history_chunk',
      agentId: 'agent-a',
      conversationId: 'conv-a',
      sessionId,
      mode: 'recent',
      messages: [{ id: '000001-a', role: 'user', content: 'A', sessionId }],
      latestSeq: 1,
      oldestSeq: 1,
      hasMore: false,
    });

    expect(store.messagesMap['conv-a']).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'A', sessionId }),
    ]));
    expect(store.messagesMap['conv-b']).toEqual([expect.objectContaining({ content: 'B' })]);
    expect(store.yeaftConversationId).toBe('conv-b');
    expect(store.yeaftConversationIdsByAgent).toEqual({ 'agent-a': 'conv-a', 'agent-b': 'conv-b' });

    expect(store.yeaftSessionHistoryState[agentAKey]).toEqual(expect.objectContaining({
      loading: false, latestSeq: 1, hasMore: false, oldestSeq: 1,
    }));
    expect(store.yeaftSessionHistoryState[agentBKey]).toEqual({
      loaded: true, loading: true, latestSeq: 20, hasMore: true, oldestSeq: 10,
    });
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(10);
    expect(store.yeaftLoadingMoreHistory).toBe(true);

    handleYeaftHistoryChunk(store, {
      type: 'yeaft_history_chunk',
      agentId: 'agent-b',
      conversationId: 'conv-b-replacement',
      sessionId,
      mode: 'delta',
      messages: [{ id: '000021-b', role: 'assistant', content: 'replacement', sessionId }],
      latestSeq: 21,
      hasMore: false,
    });
    expect(store.yeaftConversationId).toBe('conv-b');
    expect(store.activeConversations || []).not.toContain('conv-b-replacement');
    expect(store.messagesMap['conv-b']).toEqual([expect.objectContaining({ content: 'B' })]);
    expect(store.messagesMap['conv-b-replacement']).toEqual([
      expect.objectContaining({ content: 'replacement', sessionId }),
    ]);
  });

  it('accepts inactive empty-string sessionId chunks without treating them as active unscoped history', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-B',
      yeaftLoadingMoreHistory: true,
      yeaftSessionHistoryState: {
        '': { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
        'session-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 100, count: 1 },
      },
      messagesMap: {
        'yeaft-1': [
          { type: 'user', content: 'B-msg', sessionId: 'session-B' },
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

    expect(store.messagesMap['yeaft-1'].filter(m => m.sessionId === 'session-B').map(m => m.content)).toEqual(['B-msg']);
    expect(store.messagesMap['yeaft-1'].filter(m => m.sessionId === '').map(m => m.content)).toEqual(['empty-scope-q']);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftSessionHistoryState['']).toEqual(expect.objectContaining({ loading: false, hasMore: true }));
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
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'A-old-q', sessionId: 'session-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual(['A-old-q']);
    expect(store.yeaftOldestLoadedSeq).toBe(1);
  });

  it('does not render legacy task-result or system-note rows from older history chunks', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: { 'yeaft-1': [] },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1',
      sessionId: 'session-A',
      messages: [
        { id: 'm0001', role: 'user', content: 'visible q', sessionId: 'session-A' },
        { id: 'm0002', role: 'user', content: '<task-result id="task_1" kind="shell" status="succeeded">\nlogTail:\n  PASS\n</task-result>', sessionId: 'session-A' },
        { id: 'm0003', role: 'user', content: '[system note] You have called ReadTaskLog with the same arguments 3 times. Previous result: {...}', sessionId: 'session-A' },
        { id: 'm0004', role: 'assistant', content: 'visible a', sessionId: 'session-A', speakerVpId: 'vp-a' },
        { id: 'm0005', role: 'user', content: 'please explain <task-result> tags', sessionId: 'session-A' },
        { id: 'm0006', role: 'user', content: 'In docs, <task-result> means XML-ish markup here', sessionId: 'session-A' },
        { id: 'm0007', role: 'user', content: '[system note] this is just prose, not a tool-folding warning', sessionId: 'session-A' },
      ],
      oldestSeq: 1,
      hasMore: false,
    });
    expect(store.messagesMap['yeaft-1'].map(m => m.content)).toEqual([
      'visible q',
      'visible a',
      'please explain <task-result> tags',
      'In docs, <task-result> means XML-ish markup here',
      '[system note] this is just prose, not a tool-folding warning',
    ]);
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
      turns: 20,
    });
  });

  it('clamps an explicit prefetch page size', () => {
    const store = mkStore({ yeaftOldestLoadedSeq: 42 });

    loadMoreYeaftHistory.call(store, 500);

    expect(store._sent[0]).toMatchObject({ turns: 50, beforeSeq: 42 });
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
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: {
        'yeaft-1': [
          { id: 'a1', type: 'user', content: 'A before', sessionId: 'session-A' },
          { id: 'b1', type: 'user', content: 'B before', sessionId: 'session-B' },
        ],
      },
      yeaftSessionHistoryState: {
        'session-A': { loaded: true, loading: false, hasMore: true, oldestSeq: 10, count: 1 },
        'session-B': { loaded: true, loading: false, hasMore: false, oldestSeq: 20, count: 1 },
      },
    });

    const beforeA = visibleMessages(store).map(m => m.id);
    setActiveSessionFilter.call(store, 'session-B');
    const afterB = visibleMessages(store).map(m => m.id);
    setActiveSessionFilter.call(store, 'session-A');
    const afterA = visibleMessages(store).map(m => m.id);

    expect(beforeA).toEqual(['a1']);
    expect(afterB).toEqual(['b1']);
    expect(afterA).toEqual(['a1']);
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['a1', 'b1']);
    expect(store._sent).toEqual([]);
    expect(store.yeaftHasMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBe(10);

    // Return to an active Session after history has overtaken its optimistic
    // prompt. Recent replay and later persistence must not pin the prompt last.
    store.messagesMap['yeaft-1'] = [
      { id: 'client-A', messageId: 'client-A', clientMessageId: 'client-A', type: 'user', content: 'A question', sessionId: 'session-A', timestamp: 100 },
      { id: 'b1', type: 'user', content: 'B before', sessionId: 'session-B', timestamp: 150 },
    ];
    setActiveSessionFilter.call(store, 'session-B');
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-A', mode: 'recent',
      messages: [{ id: 'm0020', seq: 20, role: 'assistant', content: 'A progress', sessionId: 'session-A', ts: 200 }],
      hasMore: false,
    });
    expect(visibleMessages(store).map(row => row.content)).toEqual(['B before']);
    setActiveSessionFilter.call(store, 'session-A');
    expect(visibleMessages(store).map(row => row.content)).toEqual(['A question', 'A progress']);
    store.conversationRepository.upsertOverlay({
      conversationId: 'yeaft-1',
      row: { id: 'stream-A', type: 'assistant', content: 'A continuing', sessionId: 'session-A', turnId: 'turn-A', timestamp: 300, isStreaming: true },
    });
    handleYeaftHistoryChunk(store, {
      conversationId: 'yeaft-1', agentId: 'agent-1', sessionId: 'session-A', mode: 'recent',
      messages: [
        { id: 'm0019', seq: 19, role: 'user', clientMessageId: 'client-A', content: 'A question', sessionId: 'session-A', ts: 100 },
        { id: 'm0020', seq: 20, role: 'assistant', content: 'A progress', sessionId: 'session-A', ts: 200 },
      ],
      hasMore: false,
    });
    setActiveSessionFilter.call(store, 'session-B');
    setActiveSessionFilter.call(store, 'session-A');
    expect(visibleMessages(store).map(row => row.content)).toEqual(['A question', 'A progress', 'A continuing']);
  });

  it('hydrates only a session without cached rows or loaded history metadata', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: {
        'yeaft-1': [{ id: 'a1', type: 'user', content: 'A before', sessionId: 'session-A' }],
      },
      yeaftSessionHistoryState: {
        'session-A': { loaded: true, loading: false, hasMore: false, oldestSeq: null, count: 1 },
      },
    });

    setActiveSessionFilter.call(store, 'group-C');

    expect(visibleMessages(store)).toEqual([]);
    expect(store.messagesMap['yeaft-1'].map(m => m.id)).toEqual(['a1']);
    expect(store._sent).toEqual([{ type: 'yeaft_load_history', agentId: 'agent-1', limit: 50, sessionId: 'group-C' }]);
    expect(store.yeaftSessionHistoryState['group-C']).toEqual(expect.objectContaining({ loading: true, loaded: false }));
  });

  it('switches to a cached session instantly and requests only a silent delta when latestSeq exists', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      yeaftSessionHistoryState: {
        'session-B': { loaded: true, loading: false, hasMore: true, oldestSeq: 10, latestSeq: 42, count: 2 },
      },
      messagesMap: { 'yeaft-1': [{ id: 'b1', type: 'user', content: 'B cached', sessionId: 'session-B' }] },
    });

    setActiveSessionFilter.call(store, 'session-B');

    expect(visibleMessages(store).map(m => m.id)).toEqual(['b1']);
    expect(store.yeaftLoadingMoreHistory).toBe(false);
    expect(store.yeaftSessionHistoryState['session-B']).toEqual(expect.objectContaining({
      loaded: true,
      loading: false,
      syncingAfterSeq: 42,
    }));
    expect(store._sent).toEqual([{ type: 'yeaft_load_history', agentId: 'agent-1', sessionId: 'session-B', afterSeq: 42 }]);
  });

  it('keeps selected session and pending history state isolated across sessions', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      yeaftLoadingMoreHistory: false,
      yeaftSessionHistoryState: {
        'session-A': { loaded: true, loading: false, hasMore: true, oldestSeq: 101, count: 2 },
        'session-B': { loaded: false, loading: true, hasMore: false, oldestSeq: null, count: 0 },
      },
      messagesMap: {
        'yeaft-1': [
          { id: 'a1', type: 'assistant', content: 'A', sessionId: 'session-A', speakerVpId: 'vp-a' },
          { id: 'b1', type: 'assistant', content: 'B', sessionId: 'session-B', speakerVpId: 'vp-b' },
        ],
      },
    });

    setActiveSessionFilter.call(store, 'session-B');
    expect(visibleMessages(store).map(m => m.id)).toEqual(['b1']);
    expect(store.yeaftLoadingMoreHistory).toBe(true);
    expect(store.yeaftOldestLoadedSeq).toBeNull();

    setActiveSessionFilter.call(store, 'session-A');
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

  it('keeps every resident Yeaft turn visible across Session switches', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: { 'yeaft-1': makeTurns(8) },
    });

    expect(visibleMessages(store).map(m => m.id)).toEqual(makeTurns(8).map(m => m.id));
    expect(hasHiddenYeaftMessages(store)).toBe(false);

    // A legacy prune request or returning to the bottom must not hide history
    // that is still resident; VirtualTranscript already bounds rendered DOM.
    pruneYeaftMessageWindow.call(store);
    expect(visibleMessages(store).map(m => m.id)).toEqual(makeTurns(8).map(m => m.id));
    expect(store.messagesMap['yeaft-1']).toHaveLength(24);
  });

  it('shows all cached turns again when returning to a previously loaded Session', () => {
    const store = mkStore({
      yeaftActiveSessionFilter: 'session-A',
      messagesMap: {
        'yeaft-1': [
          ...makeTurns(8, 'session-A'),
          ...makeTurns(2, 'session-B'),
        ],
      },
    });

    store.yeaftActiveSessionFilter = 'session-B';
    expect(visibleMessages(store).map(m => m.content)).toContain('assistant 2');
    store.yeaftActiveSessionFilter = 'session-A';

    expect(visibleMessages(store).map(m => m.id)).toEqual(makeTurns(8).map(m => m.id));
  });
});

describe('retired Yeaft browser history cleanup', () => {
  it('deletes the retired database once without blocking startup', async () => {
    const {
      __legacyYeaftHistoryCacheCleanupForTest,
      removeLegacyYeaftHistoryDatabase,
    } = await import('../../../web/stores/helpers/legacy-yeaft-history-cache-cleanup.js');
    const request = {};
    const deleteDatabase = vi.fn(() => request);
    const setItem = vi.fn();
    vi.stubGlobal('indexedDB', { deleteDatabase });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem });
    __legacyYeaftHistoryCacheCleanupForTest.reset();

    expect(removeLegacyYeaftHistoryDatabase()).toBe(true);
    expect(deleteDatabase).toHaveBeenCalledWith('yeaft-history-cache');
    expect(removeLegacyYeaftHistoryDatabase()).toBe(false);
    request.onsuccess();
    expect(setItem).toHaveBeenCalledWith('yeaft-history-cache-removed-v1', 'done');

    __legacyYeaftHistoryCacheCleanupForTest.reset();
    vi.unstubAllGlobals();
  });
});
