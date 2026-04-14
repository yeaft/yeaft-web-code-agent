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
 * Reset the watchdog when claude_output is received.
 * Clears health warnings and restarts the appropriate watchdog type.
 */
export function resetProcessingWatchdog(store, conversationId) {
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
    if (store._unifyWatchdogConvs?.has(conversationId)) {
      startUnifyWatchdog(store, conversationId);
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
  // Clean up Unify watchdog tracking
  store._unifyWatchdogConvs?.delete(conversationId);
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
 * Unify watchdog — simpler than ping-based watchdog since Unify
 * doesn't support ping_session. After 150s of silence (no events
 * received), force-clears processing state. The 150s is deliberately
 * longer than the 120s agent-side query timeout, so the agent aborts
 * first under normal conditions. This is a last-resort safety net.
 *
 * Reuses the same _processingWatchdogs slot so resetProcessingWatchdog
 * (called from handleClaudeOutput on every event) keeps resetting it.
 */
export function startUnifyWatchdog(store, conversationId) {
  stopProcessingWatchdog(store, conversationId);
  if (!store._processingWatchdogs) store._processingWatchdogs = {};
  // Track this as a Unify watchdog so resetProcessingWatchdog restarts the correct type
  if (!store._unifyWatchdogConvs) store._unifyWatchdogConvs = new Set();
  store._unifyWatchdogConvs.add(conversationId);
  store._processingWatchdogs[conversationId] = setTimeout(() => {
    if (store.processingConversations[conversationId]) {
      console.warn(`[Unify Watchdog] Force-clearing stale processing state for ${conversationId} after 150s`);
      delete store.processingConversations[conversationId];
      const status = store.executionStatusMap[conversationId];
      if (status) status.currentTool = null;
      store.finishStreamingForConversation(conversationId);
    }
    delete store._processingWatchdogs[conversationId];
  }, 150000);
}
