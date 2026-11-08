import { ensureMessageUiKeys, mergeMessagesByStableId } from './messages.js';
import { conversationRepositoryFor } from './conversation-repository.js';
import { retireYeaftConversation } from './yeaft-conversation-generation.js';
import { startYeaftWatchdog, stopProcessingWatchdog } from './watchdog.js';

function mergeRows(store, sourceConversationId, targetConversationId) {
  const sourceRows = store.messagesMap?.[sourceConversationId] || [];
  const targetRows = store.messagesMap?.[targetConversationId] || [];
  if (!store.messagesMap) store.messagesMap = {};
  ensureMessageUiKeys(store, sourceConversationId, sourceRows);
  ensureMessageUiKeys(store, targetConversationId, targetRows);
  const merged = mergeMessagesByStableId(targetRows, sourceRows)
    .sort((a, b) => {
      const aSeq = Number.isFinite(a?.seq) ? a.seq : null;
      const bSeq = Number.isFinite(b?.seq) ? b.seq : null;
      if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
      if (aSeq !== null && bSeq === null) return -1;
      if (aSeq === null && bSeq !== null) return 1;
      return (a?.timestamp || 0) - (b?.timestamp || 0);
    });
  conversationRepositoryFor(store).replaceProjection(targetConversationId, merged);
}

function copyRuntimeValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) {}
  }
  if (Array.isArray(value)) return value.slice();
  return { ...value };
}

function hasMapEntry(map, conversationId) {
  return !!map && Object.prototype.hasOwnProperty.call(map, conversationId);
}

function moveMapEntry(map, sourceConversationId, targetConversationId, { removeSource }) {
  if (!hasMapEntry(map, sourceConversationId)) return;
  if (!hasMapEntry(map, targetConversationId)) {
    map[targetConversationId] = removeSource
      ? map[sourceConversationId]
      : copyRuntimeValue(map[sourceConversationId]);
  }
  if (removeSource) delete map[sourceConversationId];
}

/**
 * Move every Web runtime state slot that follows a Yeaft bridge conversation.
 * The Agent id remains the authority outside this helper; this function only
 * moves one already-validated source conversation into its replacement.
 */
export function pendingYeaftConversationPromotion(store, agentId, targetConversationId = null) {
  if (!agentId) return null;
  const pending = store?._yeaftPendingConversationPromotions?.[agentId] || null;
  if (!pending?.sourceConversationId || !pending.targetConversationId) return null;
  if (targetConversationId && pending.targetConversationId !== targetConversationId) return null;
  return pending;
}

export function rememberYeaftConversationPromotion(store, agentId, sourceConversationId, targetConversationId) {
  if (!agentId || !sourceConversationId || !targetConversationId || sourceConversationId === targetConversationId) return false;
  store._yeaftPendingConversationPromotions = {
    ...(store._yeaftPendingConversationPromotions || {}),
    [agentId]: { sourceConversationId, targetConversationId },
  };
  return true;
}

export function clearYeaftConversationPromotion(store, agentId, targetConversationId = null) {
  const pending = pendingYeaftConversationPromotion(store, agentId, targetConversationId);
  if (!pending) return null;
  const next = { ...(store._yeaftPendingConversationPromotions || {}) };
  delete next[agentId];
  store._yeaftPendingConversationPromotions = next;
  return pending;
}

export function retargetYeaftConversationPromotion(store, agentId, targetConversationId) {
  const pending = pendingYeaftConversationPromotion(store, agentId);
  if (!pending || !targetConversationId || pending.targetConversationId === targetConversationId) return null;
  migrateYeaftConversationState(store, pending.targetConversationId, targetConversationId, {
    removeSource: true,
  });
  retireYeaftConversation(store, agentId, pending.targetConversationId, targetConversationId);
  rememberYeaftConversationPromotion(store, agentId, pending.sourceConversationId, targetConversationId);
  return pending;
}

export function migrateYeaftConversationState(store, sourceConversationId, targetConversationId, {
  removeSource = true,
} = {}) {
  if (!sourceConversationId || !targetConversationId || sourceConversationId === targetConversationId) return false;

  mergeRows(store, sourceConversationId, targetConversationId);
  if (store.yeaftHistoryCacheState) {
    store.yeaftHistoryCacheState = Object.fromEntries(
      Object.entries(store.yeaftHistoryCacheState).map(([key, entry]) => [
        key,
        entry?.conversationId === sourceConversationId
          ? { ...entry, conversationId: targetConversationId }
          : entry,
      ]),
    );
  }
  // A destination snapshot (including []) is newer and authoritative. Only
  // carry the source catalogue when the replacement has not received one yet.
  moveMapEntry(store.slashCommandsMap, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store.processingConversations, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store.executionStatusMap, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store.refreshingSessionMap, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store._closedAt, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store._autoRefreshed, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store.sessionHealth, sourceConversationId, targetConversationId, { removeSource });

  if (store._turnCompletedConvs?.has(sourceConversationId)) {
    store._turnCompletedConvs.add(targetConversationId);
    if (removeSource) store._turnCompletedConvs.delete(sourceConversationId);
  }

  const sourceUsesYeaftWatchdog = !!store._yeaftWatchdogConvs?.has(sourceConversationId);
  const sourcePauseReasons = store._yeaftWatchdogPauseReasons?.[sourceConversationId];
  const sourceWatchdogPaused = !!sourcePauseReasons?.size;
  const hadSourceWatchdog = !!store._processingWatchdogs?.[sourceConversationId];
  if (sourceWatchdogPaused) {
    if (!store._yeaftWatchdogPauseReasons) store._yeaftWatchdogPauseReasons = {};
    store._yeaftWatchdogPauseReasons[targetConversationId] = new Set(sourcePauseReasons);
  }
  if (removeSource && (hadSourceWatchdog || sourceWatchdogPaused)) {
    stopProcessingWatchdog(store, sourceConversationId);
  }
  if (removeSource && store._pongTimeouts?.[sourceConversationId]) {
    clearTimeout(store._pongTimeouts[sourceConversationId]);
    delete store._pongTimeouts[sourceConversationId];
  }
  const shouldRestoreYeaftWatchdog = removeSource
    && (hadSourceWatchdog || sourceUsesYeaftWatchdog || sourceWatchdogPaused)
    && !!store.processingConversations?.[targetConversationId];
  if (shouldRestoreYeaftWatchdog) {
    if (store._processingWatchdogs?.[targetConversationId]) {
      store._yeaftWatchdogConvs?.add(targetConversationId);
    } else {
      const targetHadHealth = hasMapEntry(store.sessionHealth, targetConversationId);
      const targetHealth = store.sessionHealth?.[targetConversationId];
      const targetHadAutoRefresh = hasMapEntry(store._autoRefreshed, targetConversationId);
      const targetAutoRefreshed = store._autoRefreshed?.[targetConversationId];
      startYeaftWatchdog(store, targetConversationId);
      if (targetHadHealth) {
        if (!store.sessionHealth) store.sessionHealth = {};
        store.sessionHealth[targetConversationId] = targetHealth;
      }
      if (targetHadAutoRefresh) {
        if (!store._autoRefreshed) store._autoRefreshed = {};
        store._autoRefreshed[targetConversationId] = targetAutoRefreshed;
      }
    }
  }

  if (removeSource && store.messagesMap) delete store.messagesMap[sourceConversationId];
  return true;
}
