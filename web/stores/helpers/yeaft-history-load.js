import { yeaftHistoryIdentityKey } from './yeaft-history-identity.js';

export const YEAFT_HISTORY_LOAD_TIMEOUT_MS = 15_000;

function normalizeRequestId(value) {
  return typeof value === 'string' && value ? value : null;
}

function loadState(store, sessionKey) {
  return store?.yeaftSessionHistoryState?.[sessionKey] || null;
}

export function activeYeaftHistoryIdentity(store) {
  let sessionId = store?.yeaftActiveSessionFilter || null;
  if (!sessionId) {
    try {
      const sessions = typeof window !== 'undefined' && window.Pinia?.useSessionsStore?.();
      sessionId = sessions?.activeSessionId || null;
    } catch (_) {}
  }
  if (!sessionId) return { agentId: store?.currentAgent || null, sessionId: null, sessionKey: '' };
  const agentId = (() => {
    try {
      const sessions = typeof window !== 'undefined' && window.Pinia?.useSessionsStore?.();
      const activeSession = sessions?.activeSessionKey
        ? sessions.sessions?.[sessions.activeSessionKey]
        : null;
      if (activeSession?.id === sessionId && activeSession.agentId) return activeSession.agentId;
    } catch (_) {}
    return typeof store?.resolveYeaftSessionAgentId === 'function'
      ? store.resolveYeaftSessionAgentId(sessionId)
      : store?.currentAgent || null;
  })();
  return {
    agentId,
    sessionId,
    sessionKey: yeaftHistoryIdentityKey(agentId, sessionId),
  };
}

export function beginYeaftHistoryLoad(store, {
  agentId,
  sessionId,
  mode = 'recent',
  preserveLoaded = false,
  latestSeq = null,
} = {}) {
  if (!agentId || !sessionId) return null;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = loadState(store, sessionKey) || {};
  const generation = Number(previous.generation || 0) + 1;
  const requestId = `yeaft_history_${generation}_${crypto.randomUUID()}`;
  const next = {
    ...previous,
    // Refreshes are stale-while-revalidate. Once a Session has a committed
    // history window, starting a recent replay must not make that window look
    // unloaded or clear its pagination metadata before the replacement lands.
    // A first-ever load still starts with loaded=false because `previous` is
    // empty. `preserveLoaded` remains relevant for delta/older callers that may
    // begin from a partially initialized state.
    loaded: !!previous.loaded,
    loading: true,
    error: null,
    requestId,
    generation,
    mode,
    background: mode === 'prefetch',
    requestedAt: Date.now(),
    latestSeq: Number.isFinite(latestSeq) ? latestSeq : (previous.latestSeq ?? null),
  };
  delete next.completionSeen;
  if (!preserveLoaded) {
    // A recent replay supersedes any delta request. Keep committed pagination,
    // but always retire the delta in-flight fence so a failed/empty replay
    // cannot permanently block the next catch-up.
    next.syncingAfterSeq = null;
    if (!previous.loaded) {
      next.hasMore = false;
      next.oldestSeq = null;
      next.serverOldestFetchedSeq = null;
      next.serverHasMore = false;
      next.gapQueue = [];
      next.requestedBeforeSeqs = [];
      next.count = 0;
    }
  }
  store.yeaftSessionHistoryState = {
    ...(store.yeaftSessionHistoryState || {}),
    [sessionKey]: next,
  };
  syncActiveYeaftHistoryLoad(store);
  return { sessionKey, requestId, generation, state: next };
}

export function isCurrentYeaftHistoryResponse(store, msg = {}) {
  const sessionId = msg.sessionId ?? msg.groupId ?? null;
  if (!sessionId) return false;
  const agentId = msg.agentId || store?.yeaftSessionAgentById?.[sessionId] || null;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const state = loadState(store, sessionKey);
  const responseRequestId = normalizeRequestId(msg.requestId);
  // Once a mutation fences this Session, uncorrelated legacy replays can
  // never prove they reflect it (including after a fresh chunk has landed).
  if (!responseRequestId && store.yeaftTurnDeleteHistoryBySession?.[sessionKey]) return false;
  if (!state) return responseRequestId === null;
  const pendingRequestId = normalizeRequestId(state.requestId);
  if (responseRequestId) return responseRequestId === pendingRequestId;
  return pendingRequestId === null;
}

export function finishYeaftHistoryLoad(store, msg = {}, patch = {}, frame = 'chunk') {
  if (!isCurrentYeaftHistoryResponse(store, msg)) return null;
  const sessionId = msg.sessionId ?? msg.groupId ?? null;
  const agentId = msg.agentId || store?.yeaftSessionAgentById?.[sessionId] || null;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = loadState(store, sessionKey) || {};
  const responseRequestId = normalizeRequestId(msg.requestId);
  const completionBeforeChunk = responseRequestId !== null && frame === 'completion';
  const next = {
    ...previous,
    ...(completionBeforeChunk ? {} : patch),
    ...(completionBeforeChunk ? { completionSeen: true } : {}),
    error: null,
  };
  if (completionBeforeChunk) {
    // `history_loaded` is metadata, not the data commit. The encrypted server
    // relay can deliver this small frame before the compressed chunk, so retain
    // the request fence until the chunk arrives. Ignoring the patch here also
    // avoids double-counting a delta when its chunk applies the same metadata.
    next.loading = true;
    next.requestId = responseRequestId;
  } else {
    // The chunk is the authoritative commit point. It can retire the request
    // without waiting for a completion frame, preserving older-history and
    // legacy Agent paths that emit only a chunk.
    next.loading = false;
    next.requestId = null;
    next.completedAt = Date.now();
    delete next.completionSeen;
  }
  store.yeaftSessionHistoryState = {
    ...(store.yeaftSessionHistoryState || {}),
    [sessionKey]: next,
  };
  syncActiveYeaftHistoryLoad(store);
  return next;
}

export function failYeaftHistoryLoad(store, { agentId, sessionId, requestId, error = 'history_load_failed' } = {}) {
  if (!agentId || !sessionId || !requestId) return false;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = loadState(store, sessionKey);
  if (!previous || previous.requestId !== requestId || !previous.loading) return false;
  store.yeaftSessionHistoryState = {
    ...(store.yeaftSessionHistoryState || {}),
    [sessionKey]: {
      ...previous,
      loading: false,
      error,
      requestId: null,
      completedAt: Date.now(),
    },
  };
  syncActiveYeaftHistoryLoad(store);
  return true;
}

export function syncActiveYeaftHistoryLoad(store) {
  const { sessionKey } = activeYeaftHistoryIdentity(store);
  const state = sessionKey ? loadState(store, sessionKey) : null;
  // Background prefetch owns the per-Session request fence but no visible
  // spinner or manual-load gate; scrolling can continue against resident rows.
  store.yeaftLoadingMoreHistory = !!state?.loading && state?.mode !== 'prefetch';
  store.yeaftHistoryLoadError = state?.error || null;
  store.yeaftHasMoreHistory = !!state?.hasMore;
  store.yeaftOldestLoadedSeq = Number.isFinite(state?.serverOldestFetchedSeq)
    ? state.serverOldestFetchedSeq
    : (Number.isFinite(state?.oldestSeq) ? state.oldestSeq : null);
  return state;
}

export function activeYeaftHistoryLoadState(store) {
  const { sessionKey } = activeYeaftHistoryIdentity(store);
  return sessionKey ? loadState(store, sessionKey) : null;
}
