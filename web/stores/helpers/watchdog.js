// Processing watchdog helpers — ping-based session health monitoring
// Sends periodic ping_session to agent and tracks pong responses

export function isRecentlyClosed(store, conversationId) {
  if (!store._closedAt?.[conversationId]) return false;
  return (Date.now() - store._closedAt[conversationId]) < 30000;
}

/**
 * Start the processing watchdog for a conversation.
 * After an initial 45s delay, sends ping_session every 30s.
 * If no pong received within 10s, sets sessionHealth to agent-offline.
 */
export function startProcessingWatchdog(store, conversationId) {
  stopProcessingWatchdog(store, conversationId);
  if (!store._processingWatchdogs) store._processingWatchdogs = {};

  const sendPing = () => {
    if (!store.processingConversations[conversationId]) return;
    const conv = store.conversations.find(c => c.id === conversationId);
    store.sendWsMessage({
      type: 'ping_session',
      conversationId,
      agentId: conv?.agentId
    });

    // 10s timeout for pong response
    const pongTimeout = setTimeout(() => {
      if (store.processingConversations[conversationId]) {
        console.log(`[Watchdog] No pong for ${conversationId}, marking agent-offline`);
        if (!store.sessionHealth) store.sessionHealth = {};
        store.sessionHealth[conversationId] = { status: 'agent-offline' };
      }
    }, 10000);

    // Store pong timeout so resetProcessingWatchdog can clear it
    if (!store._pongTimeouts) store._pongTimeouts = {};
    store._pongTimeouts[conversationId] = pongTimeout;
  };

  // First ping after 45s, then every 30s
  const initialTimer = setTimeout(() => {
    if (!store.processingConversations[conversationId]) return;
    sendPing();
    store._processingWatchdogs[conversationId] = setInterval(() => {
      if (!store.processingConversations[conversationId]) {
        stopProcessingWatchdog(store, conversationId);
        return;
      }
      sendPing();
    }, 30000);
  }, 45000);

  store._processingWatchdogs[conversationId] = initialTimer;
}

/**
 * Reset the watchdog when an assistant output frame is received.
 * Clears health warnings and restarts the appropriate watchdog type.
 */
export function resetProcessingWatchdog(store, conversationId) {
  if (store._yeaftWatchdogPauseReasons?.[conversationId]?.size) return;
  if (store.processingConversations[conversationId] && store._processingWatchdogs?.[conversationId]) {
    // Clear pong timeout
    if (store._pongTimeouts?.[conversationId]) {
      clearTimeout(store._pongTimeouts[conversationId]);
      delete store._pongTimeouts[conversationId];
    }
    // Clear session health warning (got activity = healthy)
    if (store.sessionHealth?.[conversationId]) {
      delete store.sessionHealth[conversationId];
    }
    // Restart the correct watchdog type
    if (store._yeaftWatchdogConvs?.has(conversationId)) {
      startYeaftWatchdog(store, conversationId);
    } else {
      startProcessingWatchdog(store, conversationId);
    }
  }
}

/**
 * Stop the watchdog and clean up all timers.
 */
export function stopProcessingWatchdog(store, conversationId) {
  if (store._processingWatchdogs?.[conversationId]) {
    clearTimeout(store._processingWatchdogs[conversationId]);
    clearInterval(store._processingWatchdogs[conversationId]);
    delete store._processingWatchdogs[conversationId];
  }
  if (store._pongTimeouts?.[conversationId]) {
    clearTimeout(store._pongTimeouts[conversationId]);
    delete store._pongTimeouts[conversationId];
  }
  // Clean up session health state
  if (store.sessionHealth?.[conversationId]) {
    delete store.sessionHealth[conversationId];
  }
  // Clean up auto-refresh flag
  if (store._autoRefreshed?.[conversationId]) {
    delete store._autoRefreshed[conversationId];
  }
  // Clean up Yeaft watchdog tracking
  store._yeaftWatchdogConvs?.delete(conversationId);
  if (store._yeaftWatchdogPauseReasons) {
    delete store._yeaftWatchdogPauseReasons[conversationId];
  }
  // If this stop coincides with clearing CLI processing state, also clear any stale Cosmos running dismissal
  if (!store.processingConversations?.[conversationId]) {
    store.clearCliCosmosDismissedSignal?.(conversationId);
  }
}

/** Pause stale-state cleanup while the backend owns a declared long phase. */
export function pauseYeaftWatchdog(store, conversationId, reason = 'phase') {
  if (!conversationId || !store.processingConversations[conversationId]) return;
  if (!store._yeaftWatchdogPauseReasons) store._yeaftWatchdogPauseReasons = {};
  const reasons = store._yeaftWatchdogPauseReasons[conversationId] || new Set();
  reasons.add(reason);
  store._yeaftWatchdogPauseReasons[conversationId] = reasons;
  if (store._processingWatchdogs?.[conversationId]) {
    clearTimeout(store._processingWatchdogs[conversationId]);
    clearInterval(store._processingWatchdogs[conversationId]);
    delete store._processingWatchdogs[conversationId];
  }
}

/** Resume stale-state cleanup after the declared long phase completes. */
export function resumeYeaftWatchdog(store, conversationId, reason = null) {
  if (!conversationId) return;
  const reasons = store._yeaftWatchdogPauseReasons?.[conversationId];
  if (!reasons) return;
  if (reason) reasons.delete(reason);
  else reasons.clear();
  if (reasons.size) return;
  delete store._yeaftWatchdogPauseReasons[conversationId];
  if (store.processingConversations[conversationId]) startYeaftWatchdog(store, conversationId);
}

/**
 * Legacy watchdog for old agents that don't support ping_session.
 * After 90s of processing, sends refresh_conversation.
 * If still processing after 10s more, force-clears processing state.
 */
export function startLegacyWatchdog(store, conversationId) {
  stopProcessingWatchdog(store, conversationId);
  if (!store._processingWatchdogs) store._processingWatchdogs = {};
  store._processingWatchdogs[conversationId] = setTimeout(() => {
    if (store.processingConversations[conversationId]) {
      const conv = store.conversations.find(c => c.id === conversationId);
      store.sendWsMessage({
        type: 'refresh_conversation',
        conversationId,
        agentId: conv?.agentId
      });
      store._processingWatchdogs[conversationId] = setTimeout(() => {
        if (store.processingConversations[conversationId]) {
          delete store.processingConversations[conversationId];
          store.clearCliCosmosDismissedSignal?.(conversationId);
          const status = store.executionStatusMap[conversationId];
          if (status) status.currentTool = null;
          store.finishStreamingForConversation(conversationId);
        }
        delete store._processingWatchdogs[conversationId];
      }, 10000);
    }
  }, 90000);
}

/**
 * Yeaft watchdog — simpler than ping-based watchdog since Yeaft
 * doesn't support ping_session. After 150s of silence (no events
 * received), force-clears processing state. Declared long-running backend
 * phases pause this fallback timer and own their own deadlines.
 */
export function startYeaftWatchdog(store, conversationId) {
  const pauseReasons = store._yeaftWatchdogPauseReasons?.[conversationId];
  stopProcessingWatchdog(store, conversationId);
  if (!store._processingWatchdogs) store._processingWatchdogs = {};
  if (pauseReasons?.size) {
    if (!store._yeaftWatchdogConvs) store._yeaftWatchdogConvs = new Set();
    if (!store._yeaftWatchdogPauseReasons) store._yeaftWatchdogPauseReasons = {};
    store._yeaftWatchdogConvs.add(conversationId);
    store._yeaftWatchdogPauseReasons[conversationId] = new Set(pauseReasons);
    return;
  }
  // Track this as a Yeaft watchdog so resetProcessingWatchdog restarts the correct type
  if (!store._yeaftWatchdogConvs) store._yeaftWatchdogConvs = new Set();
  store._yeaftWatchdogConvs.add(conversationId);
  store._processingWatchdogs[conversationId] = setTimeout(() => {
    if (store.processingConversations[conversationId]) {
      console.warn(`[Yeaft Watchdog] Force-clearing stale processing state for ${conversationId} after 150s`);
      delete store.processingConversations[conversationId];
      store.clearCliCosmosDismissedSignal?.(conversationId);
      const status = store.executionStatusMap[conversationId];
      if (status) status.currentTool = null;
      store.finishStreamingForConversation(conversationId);
    }
    delete store._processingWatchdogs[conversationId];
  }, 150000);
}
