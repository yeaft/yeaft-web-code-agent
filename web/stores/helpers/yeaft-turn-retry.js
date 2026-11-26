import { isRetiredYeaftConversation } from './yeaft-conversation-generation.js';

export const YEAFT_RETRY_TURN_TIMEOUT_MS = 15_000;
const VALID_RETRY_MODES = new Set(['plain', 'compact']);

const normalizeId = (value) => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    ? value.trim()
    : null
);

const normalizeMessage = (value) => (
  typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, 2000)
    : null
);

const generationOf = (store) => Number(store?.chatHistoryConnectionGeneration || 0);

const isAgentOnline = (store, agentId) => {
  if (!agentId) return false;
  if (!Array.isArray(store?.agents)) return true;
  return store.agents.some(agent => agent?.id === agentId && agent.online);
};

export function retryTurnKey(agentId, sessionId, turnId) {
  return JSON.stringify([agentId, sessionId, turnId]);
}

function acceptsEnvelope(store, agentId, conversationId) {
  if (!agentId || !conversationId) return false;
  if (isRetiredYeaftConversation(store, agentId, conversationId)) return false;
  const bound = store.yeaftConversationIdsByAgent?.[agentId];
  return !bound || bound === conversationId;
}

function clearPendingEntry(store, key, result = null) {
  const pending = store.yeaftRetryPendingByKey?.[key];
  if (!pending) return null;
  if (pending.timer) clearTimeout(pending.timer);
  const next = { ...(store.yeaftRetryPendingByKey || {}) };
  delete next[key];
  store.yeaftRetryPendingByKey = next;
  if (result && typeof pending.resolve === 'function') pending.resolve(result);
  return pending;
}

function clearTurnErrorFromVpStatuses(store, agentId, sessionId, turnId) {
  const current = store?.vpStatuses;
  if (!current || typeof current !== 'object') return;
  let changed = false;
  const next = { ...current };
  for (const [statusKey, status] of Object.entries(current)) {
    if (!status) continue;
    if (agentId && status.agentId && status.agentId !== agentId) continue;
    const statusSession = status.sessionId ?? status.groupId ?? null;
    if (sessionId && statusSession && statusSession !== sessionId) continue;

    let updated = status;
    const detailMatches = status.errorDetail?.turnId === turnId;
    const aggregateMatches = status.state === 'error'
      && (!status.turnId || status.turnId === turnId || detailMatches);
    if (aggregateMatches || detailMatches) {
      updated = {
        ...updated,
        ...(updated.state === 'error' ? { state: 'idle' } : {}),
        errorDetail: null,
      };
    }

    if (Array.isArray(updated.threads)) {
      let threadsChanged = false;
      const nextThreads = updated.threads.map(thread => {
        if (!thread || thread.turnId !== turnId) return thread;
        if (thread.state !== 'error' && !thread.errorDetail) return thread;
        threadsChanged = true;
        return {
          ...thread,
          ...(thread.state === 'error' ? { state: 'idle' } : {}),
          errorDetail: null,
        };
      });
      if (threadsChanged) updated = { ...updated, threads: nextThreads };
    }

    if (updated !== status) {
      next[statusKey] = updated;
      changed = true;
    }
  }
  if (changed) store.vpStatuses = next;
}

/**
 * Record retry metadata advertised on a native Yeaft Session `yeaft_output`
 * error event (`retryTurnId` + `retryToken`).
 *
 * Buttons are driven from the authoritative `session_turns` snapshot (which
 * publishes `retryableTurns` only after the final terminal/driver transition),
 * so an `error` event alone keeps `ready: false` unless the exact same
 * `retryToken` was already confirmed ready by `session_turns`.
 */
export function recordYeaftRetryableError(store, msg) {
  const event = msg?.event;
  if (!event || event.type !== 'error') return false;
  const agentId = normalizeId(msg.agentId);
  const sessionId = normalizeId(event.sessionId || msg.sessionId || msg.groupId);
  const retryTurnId = normalizeId(event.retryTurnId);
  const retryToken = normalizeId(event.retryToken);
  const conversationId = normalizeId(msg.conversationId) || store.yeaftConversationIdsByAgent?.[agentId] || null;
  if (!agentId || !sessionId || !retryTurnId || !retryToken || !acceptsEnvelope(store, agentId, conversationId)) {
    return false;
  }

  const key = retryTurnKey(agentId, sessionId, retryTurnId);
  // If a retry launch had been pending and a new error arrived for the same
  // logical turn, settle the pending state so controls can become interactive
  // again once the authoritative snapshot publishes the new retryToken.
  clearPendingEntry(store, key, { ok: false, error: normalizeMessage(event.message) || 'retry_failed' });

  const prev = store.yeaftRetryableTurnsByKey?.[key] || null;
  const sameToken = !!(prev && prev.retryToken === retryToken);
  const nextEntry = {
    agentId,
    sessionId,
    conversationId,
    connectionGeneration: generationOf(store),
    turnId: retryTurnId,
    retryToken,
    ready: sameToken ? !!prev.ready : false,
    vpId: normalizeId(event.vpId || msg.vpId) || (sameToken ? prev?.vpId : null) || null,
    threadId: normalizeId(event.threadId || msg.threadId) || (sameToken ? prev?.threadId : null) || 'main',
    message: normalizeMessage(event.message) || (sameToken ? prev?.message : null) || null,
    reason: normalizeId(event.reason) || (sameToken ? prev?.reason : null) || null,
    code: normalizeId(event.code) || (sameToken ? prev?.code : null) || null,
    retryAttempts: Number.isSafeInteger(event.retryAttempts) && event.retryAttempts >= 0
      ? event.retryAttempts
      : (sameToken ? (prev?.retryAttempts ?? null) : null),
    retryError: sameToken ? (prev?.retryError || null) : null,
    at: Date.now(),
  };
  store.yeaftRetryableTurnsByKey = {
    ...(store.yeaftRetryableTurnsByKey || {}),
    [key]: nextEntry,
  };
  return true;
}

/**
 * Reconcile authoritative `retryableTurns` (`[{ turnId, vpId, threadId, retryToken }]`)
 * from `yeaft_output` `session_turns` (always an array on new Agent).
 * This is the authoritative ready boundary after final terminal/driver transition
 * and on reconnect / page reload.
 */
export function reconcileYeaftRetryableTurns(store, msg, { scopedSessionId = undefined } = {}) {
  const rawList = Array.isArray(msg?.event?.retryableTurns)
    ? msg.event.retryableTurns
    : (Array.isArray(msg?.retryableTurns) ? msg.retryableTurns : null);
  if (!rawList) return false;

  const agentId = normalizeId(msg?.agentId);
  const conversationId = normalizeId(msg?.conversationId) || store.yeaftConversationIdsByAgent?.[agentId] || null;
  if (!agentId || !acceptsEnvelope(store, agentId, conversationId)) return false;

  const resolvedScope = scopedSessionId !== undefined
    ? normalizeId(scopedSessionId)
    : normalizeId(msg?.event?.sessionId || msg?.sessionId || msg?.groupId);

  const prevMap = store.yeaftRetryableTurnsByKey || {};
  const next = { ...prevMap };
  for (const [key, row] of Object.entries(prevMap)) {
    if (!row || row.agentId !== agentId) continue;
    if (resolvedScope != null && row.sessionId !== resolvedScope) continue;
    delete next[key];
  }

  const generation = generationOf(store);
  const now = Date.now();
  for (const item of rawList) {
    const turnId = normalizeId(item?.turnId);
    const retryToken = normalizeId(item?.retryToken);
    const sessionId = normalizeId(item?.sessionId) || resolvedScope;
    if (!turnId || !retryToken || !sessionId) continue;
    if (resolvedScope != null && sessionId !== resolvedScope) continue;
    const key = retryTurnKey(agentId, sessionId, turnId);
    const prev = prevMap[key] || null;
    const sameToken = !!(prev && prev.retryToken === retryToken);
    next[key] = {
      agentId,
      sessionId,
      conversationId,
      connectionGeneration: generation,
      turnId,
      retryToken,
      ready: true,
      vpId: normalizeId(item?.vpId) || (sameToken ? prev?.vpId : null) || null,
      threadId: normalizeId(item?.threadId) || (sameToken ? prev?.threadId : null) || 'main',
      message: normalizeMessage(item?.message) || (sameToken ? prev?.message : null) || null,
      reason: normalizeId(item?.reason) || (sameToken ? prev?.reason : null) || null,
      code: normalizeId(item?.code) || (sameToken ? prev?.code : null) || null,
      retryAttempts: Number.isSafeInteger(item?.retryAttempts) && item.retryAttempts >= 0
        ? item.retryAttempts
        : (sameToken ? (prev?.retryAttempts ?? null) : null),
      retryError: sameToken ? (prev?.retryError || null) : null,
      at: Number.isFinite(item?.at) ? item.at : (sameToken && prev?.at ? prev.at : now),
    };
  }

  store.yeaftRetryableTurnsByKey = next;
  // Clear pending requests for turns no longer retryable or superseded by a new retryToken.
  for (const [key, pending] of Object.entries(store.yeaftRetryPendingByKey || {})) {
    if (!pending || pending.agentId !== agentId) continue;
    if (resolvedScope != null && pending.sessionId !== resolvedScope) continue;
    if (!next[key]) {
      clearPendingEntry(store, key, { ok: true });
    } else if (pending.retryToken && next[key].retryToken !== pending.retryToken) {
      clearPendingEntry(store, key, { ok: false, error: 'stale_retry_token' });
    }
  }
  return true;
}

export function clearYeaftRetryableTurn(store, { agentId = null, sessionId = null, turnId = null, retryToken = null, clearVpError = false } = {}) {
  const normalizedTurnId = normalizeId(turnId);
  if (!normalizedTurnId) return false;
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  const normalizedRetryToken = normalizeId(retryToken);

  let changed = false;
  const next = { ...(store.yeaftRetryableTurnsByKey || {}) };
  for (const [key, row] of Object.entries(next)) {
    if (!row || row.turnId !== normalizedTurnId) continue;
    if (normalizedAgentId && row.agentId !== normalizedAgentId) continue;
    if (normalizedSessionId && row.sessionId !== normalizedSessionId) continue;
    if (normalizedRetryToken && row.retryToken !== normalizedRetryToken) continue;
    delete next[key];
    changed = true;
  }
  if (changed) store.yeaftRetryableTurnsByKey = next;

  for (const [key, pending] of Object.entries(store.yeaftRetryPendingByKey || {})) {
    if (!pending || pending.turnId !== normalizedTurnId) continue;
    if (normalizedAgentId && pending.agentId !== normalizedAgentId) continue;
    if (normalizedSessionId && pending.sessionId !== normalizedSessionId) continue;
    if (normalizedRetryToken && pending.retryToken !== normalizedRetryToken) continue;
    clearPendingEntry(store, key, { ok: true });
  }

  if (clearVpError) {
    clearTurnErrorFromVpStatuses(store, normalizedAgentId, normalizedSessionId, normalizedTurnId);
  }
  return changed;
}

/**
 * When `vp_turn_start` arrives with `retry: true` for the same logical `turnId`,
 * retain existing tool calls and assistant text rows while clearing failure-only
 * UI markers so the resumed turn can settle cleanly when it finishes.
 */
export function prepareYeaftTurnForRetryResume(store, {
  agentId = null,
  sessionId = null,
  vpId = null,
  turnId = null,
  conversationId = null,
} = {}) {
  const normalizedTurnId = normalizeId(turnId);
  if (!normalizedTurnId) return false;
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  const normalizedVpId = normalizeId(vpId);
  const conv = normalizeId(conversationId)
    || (normalizedAgentId ? store?.yeaftConversationIdsByAgent?.[normalizedAgentId] : null)
    || null;
  if (!conv || !Array.isArray(store?.messagesMap?.[conv])) return false;

  const rows = store.messagesMap[conv];
  let changed = false;
  const nextRows = [];
  for (const row of rows) {
    if (!row) {
      nextRows.push(row);
      continue;
    }
    const rowSessionId = row.sessionId ?? row.groupId ?? null;
    const sameScope = row.turnId === normalizedTurnId
      && (!normalizedSessionId || !rowSessionId || rowSessionId === normalizedSessionId)
      && (!normalizedVpId || !row.speakerVpId || row.speakerVpId === normalizedVpId);

    // Drop failure-only error rows belonging to the retried turn; preserve all
    // user, assistant text, and tool-use/tool-result rows.
    if (sameScope && row.type === 'error') {
      changed = true;
      continue;
    }

    if (sameScope && row.type === 'assistant'
        && (row.status === 'errored' || row.turnEndReason === 'errored' || row.turnEndReason === 'error')) {
      row.status = 'pending';
      delete row.turnEndReason;
      delete row.turnEndAt;
      delete row.turnEndDetail;
      delete row.turnDurationMs;
      changed = true;
    }

    nextRows.push(row);
  }

  if (changed) {
    store.messagesMap = { ...store.messagesMap, [conv]: nextRows };
  }
  return changed;
}

export function clearYeaftRetryableTurnsForScope(store, agentId = null, sessionId = null) {
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);

  const next = {};
  for (const [key, row] of Object.entries(store.yeaftRetryableTurnsByKey || {})) {
    if (!row) continue;
    const matchesAgent = !normalizedAgentId || row.agentId === normalizedAgentId;
    const matchesSession = !normalizedSessionId || row.sessionId === normalizedSessionId;
    if (matchesAgent && matchesSession) continue;
    next[key] = row;
  }
  store.yeaftRetryableTurnsByKey = next;

  for (const [key, pending] of Object.entries(store.yeaftRetryPendingByKey || {})) {
    if (!pending) continue;
    const matchesAgent = !normalizedAgentId || pending.agentId === normalizedAgentId;
    const matchesSession = !normalizedSessionId || pending.sessionId === normalizedSessionId;
    if (matchesAgent && matchesSession) clearPendingEntry(store, key, { ok: false, error: 'aborted' });
  }
}

/** Agent↔Server disconnects do not bump the browser connection generation. */
export function invalidateOfflineYeaftTurnRetries(store) {
  const next = {};
  for (const [key, row] of Object.entries(store.yeaftRetryableTurnsByKey || {})) {
    if (!row || !isAgentOnline(store, row.agentId)) continue;
    next[key] = row;
  }
  store.yeaftRetryableTurnsByKey = next;

  for (const [key, pending] of Object.entries(store.yeaftRetryPendingByKey || {})) {
    if (!pending || isAgentOnline(store, pending.agentId)) continue;
    clearPendingEntry(store, key, { ok: false, error: 'offline' });
  }
}

export function interruptYeaftTurnRetries(store) {
  for (const key of Object.keys(store.yeaftRetryPendingByKey || {})) {
    clearPendingEntry(store, key, { ok: false, error: 'offline' });
  }
}

function nextRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `yeaft_retry_${crypto.randomUUID()}`;
  }
  return `yeaft_retry_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Send `yeaft_session_retry` for an eligible failed turn, echoing the current
 * `retryToken` to fence delayed clicks and stale tabs.
 * Never sends a user chat message, never queries history, never appends a fake bubble.
 */
export function requestYeaftTurnRetry(store, {
  agentId,
  sessionId,
  turnId,
  retryToken = null,
  mode = 'plain',
  timeoutMs = YEAFT_RETRY_TURN_TIMEOUT_MS,
} = {}) {
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  const normalizedTurnId = normalizeId(turnId);
  const normalizedRequestedToken = retryToken != null ? normalizeId(retryToken) : null;
  if (!normalizedAgentId || !normalizedSessionId || !normalizedTurnId || !VALID_RETRY_MODES.has(mode)) {
    return Promise.resolve({ ok: false, error: 'invalid_request' });
  }
  if (retryToken != null && !normalizedRequestedToken) {
    return Promise.resolve({ ok: false, error: 'invalid_request' });
  }

  const key = retryTurnKey(normalizedAgentId, normalizedSessionId, normalizedTurnId);
  if (store.yeaftRetryPendingByKey?.[key]) {
    return Promise.resolve({ ok: false, error: 'already_in_flight' });
  }

  const entry = store.yeaftRetryableTurnsByKey?.[key];
  const generation = generationOf(store);
  const boundConversationId = store.yeaftConversationIdsByAgent?.[normalizedAgentId] || null;
  if (!entry || entry.ready !== true || !entry.retryToken
      || entry.connectionGeneration !== generation
      || (boundConversationId && entry.conversationId !== boundConversationId)) {
    return Promise.resolve({ ok: false, error: 'not_retryable' });
  }
  if (normalizedRequestedToken && entry.retryToken !== normalizedRequestedToken) {
    return Promise.resolve({ ok: false, error: 'stale_retry_token' });
  }

  const activeRetryToken = entry.retryToken;

  if (store.connectionState !== 'connected' || !isAgentOnline(store, normalizedAgentId)) {
    store.yeaftRetryableTurnsByKey = {
      ...(store.yeaftRetryableTurnsByKey || {}),
      [key]: { ...entry, retryError: 'offline' },
    };
    return Promise.resolve({ ok: false, error: 'offline' });
  }

  // Clear previous relay error feedback when launching a fresh retry attempt.
  if (entry.retryError) {
    store.yeaftRetryableTurnsByKey = {
      ...(store.yeaftRetryableTurnsByKey || {}),
      [key]: { ...entry, retryError: null },
    };
  }

  const requestId = nextRequestId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const expired = clearPendingEntry(store, key, { ok: false, error: 'timeout' });
      const current = store.yeaftRetryableTurnsByKey?.[key];
      if (expired && current && current.retryToken === activeRetryToken) {
        store.yeaftRetryableTurnsByKey = {
          ...(store.yeaftRetryableTurnsByKey || {}),
          [key]: { ...current, retryError: 'timeout' },
        };
      }
    }, timeoutMs);

    store.yeaftRetryPendingByKey = {
      ...(store.yeaftRetryPendingByKey || {}),
      [key]: {
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        turnId: normalizedTurnId,
        retryToken: activeRetryToken,
        mode,
        requestId,
        timer,
        resolve,
      },
    };

    const sent = store.sendWsMessage({
      type: 'yeaft_session_retry',
      agentId: normalizedAgentId,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      retryToken: activeRetryToken,
      mode,
      requestId,
    });
    if (!sent) {
      clearPendingEntry(store, key, { ok: false, error: 'offline' });
      const current = store.yeaftRetryableTurnsByKey?.[key];
      if (current && current.retryToken === activeRetryToken) {
        store.yeaftRetryableTurnsByKey = {
          ...(store.yeaftRetryableTurnsByKey || {}),
          [key]: { ...current, retryError: 'offline' },
        };
      }
    }
  });
}

/**
 * Handle standalone `yeaft_session_retry_result` ack or relay failure.
 * - `ok: true`: clears initial error & retry eligibility immediately as retry launches.
 * - `ok: false`: re-enables controls and surfaces relay failure message (fenced by retryToken).
 */
export function handleYeaftTurnRetryResult(store, msg) {
  const sessionId = normalizeId(msg?.sessionId);
  const turnId = normalizeId(msg?.turnId);
  const requestId = normalizeId(msg?.requestId);
  const msgAgentId = normalizeId(msg?.agentId);
  if (!sessionId || !turnId || !requestId || typeof msg?.ok !== 'boolean') return false;

  let matchedKey = null;
  let matchedPending = null;
  for (const [key, pending] of Object.entries(store.yeaftRetryPendingByKey || {})) {
    if (!pending || pending.requestId !== requestId) continue;
    if (pending.sessionId !== sessionId || pending.turnId !== turnId) continue;
    if (msgAgentId && pending.agentId !== msgAgentId) continue;
    matchedKey = key;
    matchedPending = pending;
    break;
  }
  if (!matchedKey || !matchedPending) return false;

  if (msg.ok) {
    clearPendingEntry(store, matchedKey, { ok: true });
    clearYeaftRetryableTurn(store, {
      agentId: matchedPending.agentId,
      sessionId: matchedPending.sessionId,
      turnId: matchedPending.turnId,
      retryToken: matchedPending.retryToken,
      clearVpError: true,
    });
    return true;
  }

  const errorText = normalizeMessage(msg.error) || 'retry_failed';
  clearPendingEntry(store, matchedKey, { ok: false, error: errorText });
  const existing = store.yeaftRetryableTurnsByKey?.[matchedKey];
  if (existing && (!matchedPending.retryToken || existing.retryToken === matchedPending.retryToken)) {
    store.yeaftRetryableTurnsByKey = {
      ...(store.yeaftRetryableTurnsByKey || {}),
      [matchedKey]: { ...existing, retryError: errorText },
    };
  }
  return true;
}

/**
 * Return retryable failed turns visible in the active native Yeaft Session.
 * Driven from authoritative `session_turns.retryableTurns` (`ready === true` +
 * `retryToken`). Strictly returns `[]` for non-Yeaft providers (Claude CLI,
 * Copilot, etc.), offline states, or stale connection generations.
 */
export function visibleYeaftRetryableTurns(store, route) {
  if (!route || route.runtimeProvider !== 'yeaft') return [];
  const agentId = normalizeId(route.agentId);
  const sessionId = normalizeId(route.sessionId);
  if (!agentId || !sessionId) return [];
  if (store.connectionState !== 'connected' || !isAgentOnline(store, agentId)) return [];
  const conversationId = store.yeaftConversationIdsByAgent?.[agentId] || null;
  if (!conversationId || isRetiredYeaftConversation(store, agentId, conversationId)) return [];

  const generation = generationOf(store);
  const result = [];
  for (const [key, row] of Object.entries(store.yeaftRetryableTurnsByKey || {})) {
    if (!row || row.ready !== true || !row.retryToken) continue;
    if (row.agentId !== agentId || row.sessionId !== sessionId) continue;
    if (row.conversationId !== conversationId || row.connectionGeneration !== generation) continue;
    const pending = store.yeaftRetryPendingByKey?.[key] || null;
    result.push({
      ...row,
      pending: !!pending,
      pendingMode: pending?.mode || null,
    });
  }
  result.sort((a, b) => (a.at || 0) - (b.at || 0) || a.turnId.localeCompare(b.turnId));
  return result;
}
