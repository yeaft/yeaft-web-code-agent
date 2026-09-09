import { isDurableYeaftHistoryRow, yeaftHistoryRowSeq } from './yeaft-history-cache.js';

const repositories = new WeakMap();

function rowSessionId(row) {
  return row?.sessionId ?? row?.groupId ?? null;
}

function rowIdentity(row) {
  const value = row?.stableKey ?? row?.uiKey ?? row?.messageId ?? row?.dbMessageId ?? row?.id;
  return value === null || value === undefined || value === '' ? null : String(value);
}

function sameAssistantTurn(existing, incoming) {
  if (existing?.type !== 'assistant' || incoming?.type !== 'assistant') return false;
  if (rowSessionId(existing) !== rowSessionId(incoming)) return false;
  if (existing.isHistory === true && !existing.isStreaming) return false;
  if (incoming._hasPersistedTurnId !== true) return false;
  if (!existing.turnId || !incoming.turnId || existing.turnId !== incoming.turnId) return false;
  const existingVp = existing.speakerVpId || existing.vpId || '';
  const incomingVp = incoming.speakerVpId || incoming.vpId || '';
  if (existingVp && incomingVp && existingVp !== incomingVp) return false;
  const existingThread = existing.threadId || '';
  const incomingThread = incoming.threadId || '';
  if (existingThread && incomingThread && existingThread !== incomingThread) return false;
  const existingText = typeof existing.content === 'string' ? existing.content : '';
  const incomingText = typeof incoming.content === 'string' ? incoming.content : '';
  return !!existingText && !!incomingText
    && (incomingText.startsWith(existingText) || existingText.startsWith(incomingText));
}

function mergeRow(existing, incoming) {
  const uiKey = existing.uiKey || incoming.uiKey || null;
  Object.assign(existing, incoming);
  if (uiKey) existing.uiKey = uiKey;
  if (isDurableYeaftHistoryRow(incoming)) {
    existing.isStreaming = false;
    if (existing.status === 'pending') existing.status = 'completed';
  }
  return existing;
}

function rowOrder(row) {
  const durable = isDurableYeaftHistoryRow(row);
  // Numeric local IDs are not transcript sequence numbers.
  const seq = durable ? yeaftHistoryRowSeq(row) : null;
  const timestamp = Number(row?.timestamp);
  // Persistence is not chronology: an optimistic user row may precede an
  // already-persisted assistant response. Only timestamp-less legacy history
  // and live rows use a head/tail fallback; known times always interleave.
  const time = Number.isFinite(timestamp) && timestamp > 0
    ? timestamp
    : (durable ? -Infinity : Infinity);
  // Equal known times keep projection order even when only part of a streamed
  // response has become durable. A persistence seq must not move its tool rows.
  return [time, Number.isFinite(time) ? 0 : (Number.isFinite(seq) ? seq : -1)];
}

/** Sort the visible projection in place, preserving arrival order for equal keys. */
export function sortYeaftConversationRows(rows) {
  rows.sort((left, right) => {
    const leftOrder = rowOrder(left);
    const rightOrder = rowOrder(right);
    for (let index = 0; index < leftOrder.length; index += 1) {
      if (leftOrder[index] !== rightOrder[index]) return leftOrder[index] - rightOrder[index];
    }
    return 0;
  });
  return rows;
}

function ensureRows(store, conversationId) {
  if (!Array.isArray(store.messagesMap?.[conversationId])) {
    store.messagesMap = store.messagesMap || {};
    store.messagesMap[conversationId] = [];
  }
  return store.messagesMap[conversationId];
}

function scopedRows(rows, sessionId) {
  return rows.filter(row => sessionId === undefined || rowSessionId(row) === sessionId);
}

function findMatchingRow(rows, incoming) {
  const identity = rowIdentity(incoming);
  if (identity) {
    const exact = rows.find(row => rowIdentity(row) === identity);
    if (exact) return exact;
  }
  if (incoming?.type === 'user' && incoming.clientMessageId) {
    const optimistic = rows.find(row => row?.type === 'user'
      && row.clientMessageId === incoming.clientMessageId
      && rowSessionId(row) === rowSessionId(incoming));
    if (optimistic) return optimistic;
  }
  if (incoming?.type === 'assistant') {
    return rows.find(row => sameAssistantTurn(row, incoming)) || null;
  }
  return null;
}

/**
 * Repository boundary for one Pinia chat store. All Yeaft durable history and
 * ephemeral optimistic/streaming rows converge here before the reactive
 * projection changes. IndexedDB stores only `durableRows()` snapshots; live
 * overlays remain memory-only until a persisted history row reconciles them.
 */
export class ConversationRepository {
  constructor(store) {
    this.store = store;
  }

  rows(conversationId) {
    return ensureRows(this.store, conversationId);
  }

  durableRows(conversationId, sessionId = undefined) {
    return scopedRows(this.rows(conversationId), sessionId).filter(isDurableYeaftHistoryRow);
  }

  overlayRows(conversationId, sessionId = undefined) {
    return scopedRows(this.rows(conversationId), sessionId).filter(row => !isDurableYeaftHistoryRow(row));
  }

  snapshot(conversationId, sessionId = undefined) {
    return {
      durableRows: this.durableRows(conversationId, sessionId),
      overlayRows: this.overlayRows(conversationId, sessionId),
    };
  }

  commitDurable({
    conversationId,
    sessionId = undefined,
    rows = [],
    mode = 'delta',
    replaceDurable = false,
    preserveEmpty = true,
  } = {}) {
    if (!conversationId) return { insertedRows: 0, preservedEmpty: false };
    const projection = this.rows(conversationId);
    const incoming = Array.isArray(rows) ? rows.filter(Boolean) : [];
    const hasScopedRows = scopedRows(projection, sessionId).length > 0;
    if (preserveEmpty && mode === 'recent' && incoming.length === 0 && hasScopedRows) {
      return { insertedRows: 0, inserted: [], preservedEmpty: true };
    }

    if (replaceDurable) {
      const kept = projection.filter(row => rowSessionId(row) !== sessionId || !isDurableYeaftHistoryRow(row));
      projection.splice(0, projection.length, ...kept);
    }

    let insertedRows = 0;
    const inserted = [];
    for (const row of incoming) {
      const existing = findMatchingRow(projection, row);
      if (existing) mergeRow(existing, row);
      else {
        projection.push(row);
        inserted.push(row);
        insertedRows += 1;
      }
    }
    sortYeaftConversationRows(projection);
    return { insertedRows, inserted, preservedEmpty: false };
  }

  upsertOverlay({ conversationId, row } = {}) {
    if (!conversationId || !row) return null;
    const projection = this.rows(conversationId);
    const existing = findMatchingRow(projection, row);
    if (existing) mergeRow(existing, row);
    else projection.push(row);
    sortYeaftConversationRows(projection);
    return existing || row;
  }

  appendOverlayText({ conversationId, sessionId = undefined, turnId = null, text = '' } = {}) {
    if (!conversationId || !text) return null;
    const projection = this.rows(conversationId);
    const row = projection.findLast(candidate => candidate?.type === 'assistant'
      && !isDurableYeaftHistoryRow(candidate)
      && (sessionId === undefined || rowSessionId(candidate) === sessionId)
      && (!turnId || candidate.turnId === turnId));
    if (!row) return null;
    if (!row.content) row.content = text;
    else if (text.startsWith(row.content)) row.content = text;
    else if (!row.content.endsWith(text)) row.content += text;
    return row;
  }

  replaceProjection(conversationId, rows = []) {
    const projection = this.rows(conversationId);
    projection.splice(0, projection.length, ...(Array.isArray(rows) ? rows : []));
    sortYeaftConversationRows(projection);
    return projection;
  }

  removeDurable({ conversationId, sessionId } = {}) {
    if (!conversationId) return 0;
    const projection = this.rows(conversationId);
    const kept = projection.filter(row => rowSessionId(row) !== sessionId || !isDurableYeaftHistoryRow(row));
    const removed = projection.length - kept.length;
    projection.splice(0, projection.length, ...kept);
    return removed;
  }
}

export function conversationRepositoryFor(store) {
  if (!store || typeof store !== 'object') return null;
  let repository = repositories.get(store);
  if (!repository) {
    repository = new ConversationRepository(store);
    repositories.set(store, repository);
  }
  return repository;
}
