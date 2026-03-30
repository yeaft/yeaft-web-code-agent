// Processing watchdog helpers
// Prevents processing state from getting stuck

export function isRecentlyClosed(store, conversationId) {
  if (!store._closedAt?.[conversationId]) return false;
  return (Date.now() - store._closedAt[conversationId]) < 30000;
}

export function startProcessingWatchdog(store, conversationId) {
  stopProcessingWatchdog(store, conversationId);
  if (!store._processingWatchdogs) store._processingWatchdogs = {};
  store._processingWatchdogs[conversationId] = setTimeout(() => {
    if (store.processingConversations[conversationId]) {
      console.log(`[Watchdog] Processing timeout for ${conversationId}, sending refresh`);
      const conv = store.conversations.find(c => c.id === conversationId);
      store.sendWsMessage({
        type: 'refresh_conversation',
        conversationId,
        agentId: conv?.agentId
      });
      // Give 10 more seconds for refresh response, then force clear
      store._processingWatchdogs[conversationId] = setTimeout(() => {
        if (store.processingConversations[conversationId]) {
          console.log(`[Watchdog] Force clearing processing state for ${conversationId}`);
          delete store.processingConversations[conversationId];
          const status = store.executionStatusMap[conversationId];
          if (status) status.currentTool = null;
          store.finishStreamingForConversation(conversationId);
        }
        delete store._processingWatchdogs[conversationId];
      }, 10000);
    }
  }, 90000); // 90 seconds
}

export function resetProcessingWatchdog(store, conversationId) {
  if (store.processingConversations[conversationId] && store._processingWatchdogs?.[conversationId]) {
    startProcessingWatchdog(store, conversationId);
  }
}

export function stopProcessingWatchdog(store, conversationId) {
  if (store._processingWatchdogs?.[conversationId]) {
    clearTimeout(store._processingWatchdogs[conversationId]);
    delete store._processingWatchdogs[conversationId];
  }
}
