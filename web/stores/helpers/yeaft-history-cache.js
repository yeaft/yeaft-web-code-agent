import { yeaftHistoryIdentityKey } from './yeaft-history-identity.js';
import { activeYeaftHistoryIdentity, syncActiveYeaftHistoryLoad } from './yeaft-history-load.js';

export const YEAFT_HISTORY_MAX_TURNS = 500;

export const YEAFT_HISTORY_CACHE_LIMITS = Object.freeze({
  maxTurnsPerSession: YEAFT_HISTORY_MAX_TURNS,
});

function rowSessionId(row) {
  // `groupId` is a legacy hydrated-row alias retained during rolling upgrades.
  return row?.sessionId ?? row?.groupId ?? null;
}

function persistedMessageId(row) {
  for (const value of [row?.persistedMessageId, row?.messageId, row?.id]) {
    if (typeof value !== 'string') continue;
    const match = value.match(/^(m\d+)/);
    if (match) return match[1];
  }
  return null;
}

export function isDurableYeaftHistoryRow(row) {
  if (row?.isStreaming || row?.status === 'pending') return false;
  return Number.isFinite(row?.seq) || !!persistedMessageId(row)
    || (row?.isHistory === true && !row?.clientMessageId);
}

export function yeaftHistoryRowSeq(row) {
  if (Number.isFinite(row?.seq)) return Number(row.seq);
  const id = persistedMessageId(row);
  const match = id?.match(/^m(\d+)$/);
  if (match) return Number(match[1]);
  const leading = typeof row?.id === 'string' ? row.id.match(/^(\d+)/) : null;
  return leading ? Number(leading[1]) : null;
}

function rowBytes(row) {
  try { return new TextEncoder().encode(JSON.stringify(row)).length; }
  catch { return 0; }
}

function isUnsafeResidentRow(row) {
  if (!row) return false;
  if (row.isStreaming || row.status === 'pending') return true;
  if (row.type === 'tool-use' && (row.askPending || (!row.hasResult
    && (row.toolName === 'AskUser' || row.toolName === 'AskUserQuestion')))) return true;
  if (row.type !== 'user' || !row.clientMessageId) return false;
  return !row.dbMessageId && !persistedMessageId(row);
}

function residentTurns(rows) {
  const turns = [];
  const byUserTurn = new Map();
  let current = null;
  for (const row of rows) {
    if (row?.userTurnId) {
      let turn = byUserTurn.get(row.userTurnId);
      if (!turn) {
        turn = { rows: [], protected: false };
        byUserTurn.set(row.userTurnId, turn);
        turns.push(turn);
      }
      turn.rows.push(row);
      if (isUnsafeResidentRow(row)) turn.protected = true;
      current = turn;
      continue;
    }
    if (row?.type === 'user' || !current) {
      current = { rows: [], protected: false };
      turns.push(current);
    }
    current.rows.push(row);
    if (isUnsafeResidentRow(row)) current.protected = true;
  }
  return turns;
}

/**
 * Bound all resident rows for one Session (or one Chat conversation when
 * sessionId is null). Unlike durable history pruning, this also covers live
 * assistant/tool projections that have no standalone persisted message id.
 * Whole user turns are retained so eviction never leaves an orphan response.
 */
export function pruneConversationMessageRetention(store, {
  conversationId,
  agentId = null,
  sessionId = null,
  limits = YEAFT_HISTORY_CACHE_LIMITS,
} = {}) {
  const allRows = store?.messagesMap?.[conversationId];
  if (!Array.isArray(allRows) || allRows.length === 0 || !agentId || !sessionId) {
    return { evictedRows: 0, keptRows: 0 };
  }
  const matchesScope = row => rowSessionId(row) === sessionId;
  const scopedRows = allRows.filter(matchesScope);
  const turns = residentTurns(scopedRows);
  if (turns.length === 0) return { evictedRows: 0, keptRows: 0 };

  const protectedTurns = turns.filter(turn => turn.protected);
  const selected = new Set(protectedTurns);
  const maxTurns = Number.isFinite(limits.maxTurnsPerSession)
    ? Math.max(0, Math.floor(limits.maxTurnsPerSession))
    : YEAFT_HISTORY_MAX_TURNS;
  // Protected live turns stay resident even if they temporarily take the count
  // above the durable limit. Completed turns fill the remaining newest slots.
  let completedSlots = Math.max(0, maxTurns - protectedTurns.length);
  for (let index = turns.length - 1; index >= 0 && completedSlots > 0; index -= 1) {
    const turn = turns[index];
    if (selected.has(turn)) continue;
    selected.add(turn);
    completedSlots -= 1;
  }
  const keptRows = new Set(turns.filter(turn => selected.has(turn)).flatMap(turn => turn.rows));
  const evicted = scopedRows.filter(row => !keptRows.has(row));
  if (evicted.length === 0) return { evictedRows: 0, keptRows: keptRows.size };
  const nextRows = allRows.filter(row => !matchesScope(row) || keptRows.has(row));
  allRows.splice(0, allRows.length, ...nextRows);

  const key = yeaftHistoryIdentityKey(agentId, sessionId);
  const previousCache = store.yeaftHistoryCacheState?.[key] || null;
  const summary = summarizeRows(scopedRows.filter(row => keptRows.has(row)));
  const previousRanges = JSON.stringify(previousCache?.ranges || []);
  const rangeEpoch = previousRanges === JSON.stringify(summary.ranges)
    ? (Number(previousCache?.rangeEpoch) || 0)
    : (Number(previousCache?.rangeEpoch) || 0) + 1;
  store.yeaftHistoryCacheState = {
    ...(store.yeaftHistoryCacheState || {}),
    [key]: {
      ...(previousCache || {}),
      agentId,
      sessionId,
      conversationId,
      lastAccessed: Date.now(),
      rangeEpoch,
      ...summary,
    },
  };

  if (evicted.some(isDurableYeaftHistoryRow)) {
    const oldestResidentSeq = summary.ranges[0]?.startSeq ?? null;
    const previousHistory = store.yeaftSessionHistoryState?.[key] || {};
    store.yeaftSessionHistoryState = {
      ...(store.yeaftSessionHistoryState || {}),
      [key]: {
        ...previousHistory,
        serverOldestFetchedSeq: oldestResidentSeq,
        oldestSeq: oldestResidentSeq,
        serverHasMore: oldestResidentSeq !== null,
        hasMore: oldestResidentSeq !== null,
        gapTraversalInitialized: false,
        gapQueue: [],
        requestedBeforeSeqs: [],
        completedHistoryWorkKeys: [],
        pendingPageKind: null,
        pendingPageBeforeSeq: null,
        pendingGapStopAtSeq: null,
        pendingCacheEpoch: null,
        pendingHistoryWorkKey: null,
        paginationError: null,
        count: summary.rowCount,
      },
    };
    const active = activeYeaftHistoryIdentity(store);
    if (active.agentId === agentId && active.sessionId === sessionId) {
      syncActiveYeaftHistoryLoad(store);
    }
  }
  return {
    evictedRows: evicted.length,
    keptRows: keptRows.size,
  };
}

export function yeaftHistoryUnitKey(row) {
  if (row?.historyEntryId) return `entry:${row.historyEntryId}`;
  const seq = yeaftHistoryRowSeq(row);
  return Number.isFinite(seq) ? `seq:${seq}` : (row?.stableKey || row?.uiKey || row?.id || row?.messageId || 'legacy');
}

function durableTurnRows(rows) {
  const turns = [];
  const roots = new Map();
  let current = null;
  for (const row of rows) {
    if (!isDurableYeaftHistoryRow(row)) continue;
    if (row.userTurnId) {
      if (!roots.has(row.userTurnId)) {
        roots.set(row.userTurnId, []);
        turns.push(roots.get(row.userTurnId));
      }
      current = roots.get(row.userTurnId);
    } else if (row?.type === 'user' || !current) {
      current = [];
      turns.push(current);
    }
    current.push(row);
  }
  return turns;
}

function chooseDurableRows(rows, limits) {
  const maxTurns = Number.isFinite(limits.maxTurnsPerSession)
    ? Math.max(0, Math.floor(limits.maxTurnsPerSession))
    : YEAFT_HISTORY_MAX_TURNS;
  const turns = durableTurnRows(rows);
  const selected = new Set(turns.slice(-maxTurns).flat());
  // A click-driven search/outline window is the user's current read surface.
  // Keep its complete turns resident even when the recent tail already fills the
  // normal retention budget; it is removed when another window replaces it or
  // when Session memory is cleared. Hover prefetch rows are not pinned.
  for (const turn of turns) {
    if (!turn.some(row => row?._historyWindowDetached === true)) continue;
    for (const row of turn) selected.add(row);
  }
  return selected;
}

function compactRanges(rows) {
  const seqs = Array.from(new Set(rows.map(yeaftHistoryRowSeq).filter(Number.isFinite))).sort((a, b) => a - b);
  const ranges = [];
  for (const seq of seqs) {
    const current = ranges.at(-1);
    if (current && seq <= current.endSeq + 1) current.endSeq = seq;
    else ranges.push({ startSeq: seq, endSeq: seq });
  }
  return ranges;
}

function summarizeRows(rows) {
  const durable = rows.filter(isDurableYeaftHistoryRow);
  return {
    rowCount: durable.length,
    byteCount: durable.reduce((sum, row) => sum + rowBytes(row), 0),
    ranges: compactRanges(durable),
  };
}

function touchIncomingRows(rows, incomingRows, now) {
  const keys = new Set((incomingRows || []).map(row => row?.stableKey).filter(Boolean));
  if (keys.size === 0) return;
  for (const row of rows) {
    if (row?.stableKey && keys.has(row.stableKey)) row._historyCacheTouchedAt = now;
  }
}

function pruneOneSession(store, { conversationId, agentId, sessionId, incomingRows, now, limits }) {
  const allRows = store.messagesMap?.[conversationId] || [];
  const scoped = allRows.filter(row => rowSessionId(row) === sessionId);
  touchIncomingRows(scoped, incomingRows, now);
  const selectedDurableRows = chooseDurableRows(scoped, limits);
  const keptScoped = scoped.filter(row => (
    !isDurableYeaftHistoryRow(row) || selectedDurableRows.has(row)
  ));
  const keptSet = new Set(keptScoped);
  const nextRows = allRows.filter(row => rowSessionId(row) !== sessionId || keptSet.has(row));
  allRows.splice(0, allRows.length, ...nextRows);
  const summary = summarizeRows(keptScoped);
  const key = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = store.yeaftHistoryCacheState?.[key] || null;
  const previousRanges = JSON.stringify(previous?.ranges || []);
  const rangeEpoch = previousRanges === JSON.stringify(summary.ranges)
    ? (Number(previous?.rangeEpoch) || 0)
    : (Number(previous?.rangeEpoch) || 0) + 1;
  store.yeaftHistoryCacheState = {
    ...(store.yeaftHistoryCacheState || {}),
    [key]: {
      agentId,
      sessionId,
      conversationId,
      lastAccessed: now,
      rangeEpoch,
      ...summary,
    },
  };
}

export function countResidentYeaftHistoryTurns(store, conversationId, sessionId) {
  const rows = store?.messagesMap?.[conversationId];
  if (!Array.isArray(rows)) return 0;
  return durableTurnRows(rows.filter(row => rowSessionId(row) === sessionId)).length;
}

export function touchYeaftHistoryCache(store, agentId, sessionId, now = Date.now()) {
  if (!agentId || !sessionId) return;
  const key = yeaftHistoryIdentityKey(agentId, sessionId);
  const entry = store.yeaftHistoryCacheState?.[key];
  if (!entry) return;
  store.yeaftHistoryCacheState = {
    ...(store.yeaftHistoryCacheState || {}),
    [key]: { ...entry, lastAccessed: now },
  };
}

export function pruneYeaftHistoryCache(store, {
  conversationId,
  agentId,
  sessionId,
  incomingRows = [],
  now = Date.now(),
  limits = YEAFT_HISTORY_CACHE_LIMITS,
} = {}) {
  if (!store || !conversationId || !agentId || !sessionId) return;
  pruneOneSession(store, { conversationId, agentId, sessionId, incomingRows, now, limits });
}
