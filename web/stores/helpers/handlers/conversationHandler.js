/**
 * Conversation lifecycle handlers: created, resumed, selected, deleted, etc.
 */

import { isRecentlyClosed, stopProcessingWatchdog } from '../watchdog.js';
import { clearSessionLoading } from '../session.js';
import { t } from '../../../utils/i18n.js';

export function handleConversationCreated(store, msg) {
  clearSessionLoading(store);
  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }
  const createdAgent = store.agents.find(a => a.id === msg.agentId);
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    agentName: createdAgent?.name || msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    processing: false,
    type: 'chat',
    disallowedTools: msg.disallowedTools ?? null
  });
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = createdAgent;
  store.currentConversation = msg.conversationId;
  store.currentWorkDir = msg.workDir;
  store.messages = [];
  store.sendWsMessage({
    type: 'select_conversation',
    conversationId: msg.conversationId
  });
  store.addMessage({
    type: 'system',
    content: t('store.convCreated', { agent: createdAgent?.name || msg.agentId, workDir: msg.workDir })
  });
  store.saveOpenSessions();
}

export function handleConversationResumed(store, msg) {
  clearSessionLoading(store);
  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }
  const resumedAgent = store.agents.find(a => a.id === msg.agentId);
  store.conversations = store.conversations.filter(c =>
    c.id !== msg.conversationId &&
    !(c.claudeSessionId && c.claudeSessionId === msg.claudeSessionId)
  );
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    agentName: resumedAgent?.name || msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: msg.claudeSessionId,
    createdAt: Date.now(),
    processing: false,
    type: 'chat',
    disallowedTools: msg.disallowedTools ?? null
  });
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = resumedAgent;
  store.currentConversation = msg.conversationId;
  store.currentWorkDir = msg.workDir;
  store.messages = [];
  if (store._pendingSessionTitle) {
    store.conversationTitles[msg.conversationId] = store._pendingSessionTitle;
    store._pendingSessionTitle = null;
  }
  store.sendWsMessage({
    type: 'select_conversation',
    conversationId: msg.conversationId
  });
  store.addMessage({
    type: 'system',
    content: t('store.convResumed', { agent: resumedAgent?.name || msg.agentId, sessionId: msg.claudeSessionId ? msg.claudeSessionId.slice(0, 8) + '...' : '' })
  });
  console.log('dbMessages received:', msg.dbMessages?.length || 0, 'dbMessageCount:', msg.dbMessageCount || 0);
  if (msg.dbMessages && msg.dbMessages.length > 0) {
    const formatted = msg.dbMessages.map(m => store.formatDbMessage(m)).flat().filter(Boolean);
    // Filter empty user messages (tool_result artifacts from DB)
    const cleaned = formatted.filter(m => !(m.type === 'user' && (!m.content || !m.content.trim())));
    for (const m of cleaned) {
      store.messages.push(m);
    }
  }
  store.hasMoreMessages = !!msg.hasMoreMessages;
  store.saveOpenSessions();
}

export function handleConversationDeleted(store, msg) {
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  delete store.messagesCache[msg.conversationId];
  delete store.conversationTitles[msg.conversationId];
  delete store.processingConversations[msg.conversationId];
  if (store._closedAt) delete store._closedAt[msg.conversationId];
  stopProcessingWatchdog(store, msg.conversationId);
  delete store.executionStatusMap[msg.conversationId];
  // 清理 crew 数据
  delete store.crewSessions?.[msg.conversationId];
  delete store.crewMessagesMap?.[msg.conversationId];
  delete store.crewOlderMessages?.[msg.conversationId];
  delete store.crewStatuses?.[msg.conversationId];
  window.dispatchEvent(new CustomEvent('conversation-deleted', { detail: { conversationId: msg.conversationId } }));
  if (store.currentConversation === msg.conversationId) {
    store.currentConversation = null;
    store.messages = [];
    store.addMessage({
      type: 'system',
      content: t('chat.session.closed')
    });
  }
  store.saveOpenSessions();
}

export function handleTurnCompleted(store, msg) {
  const convId = msg.conversationId;
  if (convId) {
    delete store.processingConversations[convId];
    stopProcessingWatchdog(store, convId);
    if (!store._closedAt) store._closedAt = {};
    store._closedAt[convId] = Date.now();
    const status = store.executionStatusMap[convId];
    if (status) {
      status.currentTool = null;
    }
    store.finishStreamingForConversation(convId);
    const conv = store.conversations.find(c => c.id === convId);
    if (conv) {
      if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;
      if (msg.workDir) conv.workDir = msg.workDir;
    }
    // Detect /clear completion: if clearStatus is 'clearing' for this conversation
    if (store.clearStatus?.conversationId === convId && store.clearStatus?.status === 'clearing') {
      store.clearStatus = { conversationId: convId, status: 'completed' };
      setTimeout(() => {
        if (store.clearStatus?.conversationId === convId && store.clearStatus?.status === 'completed') {
          store.clearStatus = null;
        }
      }, 3000);
    }
    store.saveOpenSessions();
  }
}

export function handleConversationClosed(store, msg) {
  const convId = msg.conversationId;
  if (convId) {
    delete store.processingConversations[convId];
    stopProcessingWatchdog(store, convId);
    if (!store._closedAt) store._closedAt = {};
    store._closedAt[convId] = Date.now();
    const status = store.executionStatusMap[convId];
    if (status) {
      status.currentTool = null;
    }
    store.finishStreamingForConversation(convId);
    const conv = store.conversations.find(c => c.id === convId);
    if (conv) {
      if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;
      if (msg.workDir) conv.workDir = msg.workDir;
    }
    store.saveOpenSessions();
  }
}

export function handleConversationRefresh(store, msg) {
  if (msg.conversationId) {
    if (msg.isProcessing && !isRecentlyClosed(store, msg.conversationId)) {
      store.processingConversations[msg.conversationId] = true;
    } else if (store.processingConversations[msg.conversationId]) {
      delete store.processingConversations[msg.conversationId];
      stopProcessingWatchdog(store, msg.conversationId);
      const status = store.executionStatusMap[msg.conversationId];
      if (status) status.currentTool = null;
      store.finishStreamingForConversation(msg.conversationId);
    }
  }
}

export function handleExecutionCancelled(store, msg) {
  const convId = msg.conversationId || store.currentConversation;
  if (convId) {
    delete store.processingConversations[convId];
    stopProcessingWatchdog(store, convId);
    if (!store._closedAt) store._closedAt = {};
    store._closedAt[convId] = Date.now();
    const status = store.executionStatusMap[convId];
    if (status) {
      status.currentTool = null;
    }
    store.finishStreamingForConversation(convId);
  }
}

export function handleSyncMessagesResult(store, msg) {
  if (msg.conversationId === store.currentConversation) {
    const formatted = (msg.messages || []).map(m => store.formatDbMessage(m)).flat().filter(Boolean);

    if (formatted.length > 0) {
      const firstDbMsg = store.messages.find(m => m.dbMessageId);
      if (firstDbMsg &&
          formatted[0].dbMessageId &&
          formatted[formatted.length - 1].dbMessageId < firstDbMsg.dbMessageId) {
        const insertIdx = store.messages.indexOf(firstDbMsg);
        console.log(`[Sync] Prepending ${formatted.length} older messages at index ${insertIdx}`);
        store.messages.splice(insertIdx, 0, ...formatted);
      } else {
        console.log(`[Sync] Received ${formatted.length} messages`);
        for (const m of formatted) {
          if (m.dbMessageId && store.messages.some(existing => existing.dbMessageId === m.dbMessageId)) {
            continue;
          }
          store.messages.push(m);
        }
      }
    }

    store.hasMoreMessages = msg.hasMore ?? false;
    clearSessionLoading(store);
  }
  store.loadingMoreMessages = false;
  store.refreshingSession = false;
}
