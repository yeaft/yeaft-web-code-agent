// Conversation lifecycle helpers

import { startProcessingWatchdog, stopProcessingWatchdog } from './watchdog.js';
import { setSessionLoading, saveOpenSessions } from './session.js';
import { ensureConnected } from './websocket.js';
import { markAllToolsCompleted } from './handlers/conversationHandler.js';
import { t } from '../../utils/i18n.js';

export function selectAgent(store, agentId) {
  if (agentId === store.currentAgent) {
    console.log('[selectAgent] Same agent, skipping:', agentId);
    return;
  }
  console.log('[selectAgent] Switching agent from', store.currentAgent, 'to', agentId);
  store.agentSwitching = true;
  store.sendWsMessage({
    type: 'select_agent',
    agentId
  });
}

export function createConversation(store, workDir, agentId = null, disallowedTools = null) {
  const targetAgent = agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({
      type: 'error',
      content: t('chat.agent.selectFirst')
    });
    return;
  }
  setSessionLoading(store, true, t('chat.session.creating'));
  const msg = {
    type: 'create_conversation',
    agentId: targetAgent,
    workDir: workDir || store.currentAgentWorkDir
  };
  if (disallowedTools !== null) {
    msg.disallowedTools = disallowedTools;
  }
  store.sendWsMessage(msg);
}

export function resumeConversation(store, claudeSessionId, workDir, agentId = null, disallowedTools = null) {
  const targetAgent = agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({
      type: 'error',
      content: t('chat.agent.selectFirst')
    });
    return;
  }
  setSessionLoading(store, true, t('chat.session.loadingHistory'));
  const msg = {
    type: 'resume_conversation',
    agentId: targetAgent,
    claudeSessionId,
    workDir: workDir || store.currentAgentWorkDir
  };
  if (disallowedTools !== null) {
    msg.disallowedTools = disallowedTools;
  }
  store.sendWsMessage(msg);
}

export function selectConversation(store, conversationId, agentId) {
  // In split mode, selectConversation from sidebar routes to the active panel
  if (store.panels.length > 1) {
    const targetPanelId = store.activePanelId || store.panels[0]?.id;
    if (targetPanelId) {
      store.setPanelConversation(targetPanelId, conversationId);
    }
    return;
  }

  if (conversationId === store.currentConversation) return;

  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv && conv.agentId && conv.agentId !== store.currentAgent) {
    const agent = store.agents.find(a => a.id === conv.agentId);
    if (agent) {
      store.currentAgent = conv.agentId;
      store.currentAgentInfo = agent;
      store.sendWsMessage({
        type: 'select_agent',
        agentId: conv.agentId,
        silent: true
      });
    }
  }

  store.sendWsMessage({
    type: 'select_conversation',
    conversationId
  });

  if (conv?.type === 'crew') {
    // Crew conversations use crewMessagesMap, not messagesMap.
    // Initialize crewMessagesMap entry BEFORE setting activeConversations,
    // so that currentCrewMessages getter tracks the correct reactive property.
    if (!store.crewMessagesMap[conversationId]) {
      store.crewMessagesMap[conversationId] = [];
    }
    store.messagesMap[conversationId] = [];
  }

  // Split mode aware — don't nuke other panes' conversations
  if (store.panels.length > 1) {
    if (!store.activeConversations.includes(conversationId)) {
      store.activeConversations.push(conversationId);
    }
  } else {
    store.activeConversations = [conversationId];
  }
  if (conv) {
    store.currentWorkDir = conv.workDir;
  }

  if (conv?.type === 'crew') {
    // If crew messages are empty, trigger resume to load them from server.
    const hasCrewMessages = store.crewMessagesMap[conversationId].length > 0;
    if (!hasCrewMessages) {
      store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: conversationId,
        agentId: conv.agentId || store.currentAgent
      });
    }
  } else {
    const cachedMessages = store.messagesMap[conversationId];
    if (cachedMessages && cachedMessages.length > 0) {
      // Messages already in messagesMap, nothing to do
    } else {
      store.messagesMap[conversationId] = [];
      // ★ Phase 6.1: 使用 turns 加载最近 5 个 turn
      store.sendWsMessage({
        type: 'sync_messages',
        conversationId,
        turns: 5
      });
    }
  }
  // ★ Bug #4: 重置分页状态
  store.hasMoreMessages = false;
  store.loadingMoreMessages = false;

  // 保存 lastViewedConversation 到 localStorage
  saveOpenSessions(store);
}

export function updateConversationSettings(store, conversationId, settings) {
  if (!conversationId) return;
  store.sendWsMessage({
    type: 'update_conversation_settings',
    conversationId,
    ...settings
  });
}

/**
 * Toggle MCP server for the current conversation.
 * Optimistically updates conversationMcpServers, then sends update_conversation_settings.
 * Uses serverTools mapping to expand to full tool names for disallowedTools.
 */
export function toggleConversationMcp(store, serverName, enabled) {
  const convId = store.currentConversation;
  if (!convId) return;

  // Optimistic update
  const servers = store.conversationMcpServers[convId];
  if (servers) {
    const server = servers.find(s => s.name === serverName);
    if (server) server.enabled = enabled;
  }

  // Compute new disallowedTools using full tool names from serverTools mapping
  const currentServers = store.conversationMcpServers[convId] || [];
  const serverToolsMap = store.conversationMcpServerTools[convId] || {};
  const mcpDisallowed = [];
  for (const s of currentServers) {
    if (!s.enabled) {
      const tools = serverToolsMap[s.name];
      if (tools && tools.length > 0) {
        mcpDisallowed.push(...tools);
      } else {
        // Fallback: use prefix pattern if no tools mapping available
        mcpDisallowed.push(`mcp__${s.name}`);
      }
    }
  }

  // Merge with non-MCP disallowed tools from existing conversation settings
  const conv = store.conversations.find(c => c.id === convId);
  const existing = conv?.disallowedTools || [];
  const nonMcpDisallowed = existing.filter(t => !t.startsWith('mcp__'));
  const newDisallowed = [...nonMcpDisallowed, ...mcpDisallowed];

  updateConversationSettings(store, convId, { disallowedTools: newDisallowed });
}

export function closeSession(store, conversationId, agentId) {
  const conv = store.conversations.find(c => c.id === conversationId);

  // Crew sessions: stop all roles + mark hidden on agent side + clean crew data
  if (conv?.type === 'crew' && store.crewSessions[conversationId]) {
    store.sendWsMessage({
      type: 'crew_control',
      sessionId: conversationId,
      action: 'stop_all',
      agentId
    });
    // Mark session as hidden on agent side so it won't reappear after page refresh
    store.sendWsMessage({
      type: 'delete_crew_session',
      sessionId: conversationId
    });
    // Blacklist this session so incoming conversation_list won't resurrect it
    if (!store._deletedCrewSessionIds) store._deletedCrewSessionIds = new Set();
    store._deletedCrewSessionIds.add(conversationId);
    delete store.crewSessions[conversationId];
    delete store.crewMessagesMap[conversationId];
    delete store.crewOlderMessages[conversationId];
    delete store.crewStatuses[conversationId];
  }

  // Optimistically remove from local conversations list
  store.conversations = store.conversations.filter(c => c.id !== conversationId);

  // Clean up caches
  delete store.messagesMap[conversationId];
  delete store.processingConversations[conversationId];
  stopProcessingWatchdog(store, conversationId);
  delete store.executionStatusMap[conversationId];

  // Remove from activeConversations if present
  const activeIdx = store.activeConversations.indexOf(conversationId);
  if (activeIdx >= 0) {
    store.activeConversations.splice(activeIdx, 1);
    if (store.activeConversations.length === 0) {
      // Clear lastViewedConversation so refresh doesn't restore this session
      localStorage.removeItem('lastViewedConversation');
      store.lastViewedConversation = null;
    }
  }

  // Clear from splitPanes if present
  for (const pane of store.panels) {
    if (pane.conversationId === conversationId) {
      pane.conversationId = null;
    }
  }

  // Clear pin state if present
  const pinIdx = store.pinnedSessions.indexOf(conversationId);
  if (pinIdx >= 0) {
    store.pinnedSessions.splice(pinIdx, 1);
    localStorage.setItem('pinned-sessions', JSON.stringify(store.pinnedSessions));
  }

  // Send delete_conversation to server (reuses existing handler which:
  // 1. removes from agent.conversations Map
  // 2. sets is_active=0 in DB (data preserved)
  // 3. broadcasts updated agent list
  // 4. forwards to agent for resource cleanup (terminals, processes))
  if (agentId && agentId !== store.currentAgent) {
    store.sendWsMessage({ type: 'select_agent', agentId, silent: true });
    store.sendWsMessage({ type: 'delete_conversation', conversationId });
    store.sendWsMessage({ type: 'select_agent', agentId: store.currentAgent, silent: true });
  } else {
    store.sendWsMessage({ type: 'delete_conversation', conversationId });
  }

  store.saveOpenSessions();
}

export function deleteConversation(store, conversationId, agentId) {
  // 清理 crew 数据（不管 server 是否响应）
  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv?.type === 'crew') {
    delete store.crewSessions?.[conversationId];
    delete store.crewMessagesMap?.[conversationId];
    delete store.crewOlderMessages?.[conversationId];
    delete store.crewStatuses?.[conversationId];
    // Remove from agent's crew index so it won't reappear
    store.sendWsMessage({
      type: 'delete_crew_session',
      sessionId: conversationId,
      agentId: agentId || store.currentAgent
    });
  }

  // 立即从本地列表移除（不等 server 同步）
  store.conversations = store.conversations.filter(c => c.id !== conversationId);
  // Remove from activeConversations if present
  const delIdx = store.activeConversations.indexOf(conversationId);
  if (delIdx >= 0) {
    store.activeConversations.splice(delIdx, 1);
    if (store.activeConversations.length === 0) {
      // 清除 lastViewedConversation，防止页面刷新时 autoRestore 恢复已删除的对话
      localStorage.removeItem('lastViewedConversation');
      store.lastViewedConversation = null;
    }
  }

  // Clear from splitPanes if present
  for (const pane of store.panels) {
    if (pane.conversationId === conversationId) {
      pane.conversationId = null;
    }
  }

  // Clear pin state if present
  const pinIdx2 = store.pinnedSessions.indexOf(conversationId);
  if (pinIdx2 >= 0) {
    store.pinnedSessions.splice(pinIdx2, 1);
    localStorage.setItem('pinned-sessions', JSON.stringify(store.pinnedSessions));
  }

  // 如果目标 conversation 在其他 agent 上，需要先通知 server 切换 agent
  // 否则 server 端 forwardToAgent 会发送到 client.currentAgent
  if (agentId && agentId !== store.currentAgent) {
    // 先选择目标 agent，再发删除，最后切回
    store.sendWsMessage({ type: 'select_agent', agentId, silent: true });
    store.sendWsMessage({
      type: 'delete_conversation',
      conversationId
    });
    // 切回原 agent
    store.sendWsMessage({ type: 'select_agent', agentId: store.currentAgent, silent: true });
  } else {
    store.sendWsMessage({
      type: 'delete_conversation',
      conversationId
    });
  }
}

export function sendMessage(store, text, attachments = [], options = {}) {
  const hasExpertSelections = options.expertSelections && options.expertSelections.length > 0;
  if ((!text.trim() && attachments.length === 0 && !hasExpertSelections) || !store.currentAgent || !store.currentConversation) return;

  store.addMessage({
    type: 'user',
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    expertSelections: hasExpertSelections ? options.expertSelections : undefined
  });

  if (text.trim()) {
    const title = text.trim().substring(0, 100);
    store.conversationTitles[store.currentConversation] = title;
  } else if (hasExpertSelections) {
    // When sending expert-only (no text), use first selection as title hint
    const sel = options.expertSelections[0];
    const label = `@${sel.role}${sel.action ? '\u00B7' + sel.action : ''}`;
    store.conversationTitles[store.currentConversation] = label;
  }

  // Update lastMessageAt for sidebar sorting (only user-sent messages should trigger reorder)
  const conv = store.conversations.find(c => c.id === store.currentConversation);
  if (conv) {
    conv.lastMessageAt = Date.now();
  }

  if (!store.processingConversations[store.currentConversation]) {
    store.processingConversations[store.currentConversation] = true;
    if (store._closedAt?.[store.currentConversation]) {
      delete store._closedAt[store.currentConversation];
    }
    store._turnCompletedConvs?.delete(store.currentConversation);
    // 预初始化 executionStatus entry，确保 getter 返回 reactive 对象
    store.getOrCreateExecutionStatus(store.currentConversation);
    startProcessingWatchdog(store, store.currentConversation);
  }

  const fileIds = attachments.map(a => a.fileId);
  const wsMsg = {
    type: 'chat',
    prompt: text,
    fileIds,
    workDir: store.currentWorkDir
  };
  // Pass targetRole for @mention routing
  if (options.targetRole) {
    wsMsg.targetRole = options.targetRole;
  }
  // Pass expertSelections for 帮帮团
  if (hasExpertSelections) {
    wsMsg.expertSelections = options.expertSelections;
  }

  // Try send; if WS not connected, auto-reconnect and retry
  if (!store.sendWsMessage(wsMsg)) {
    ensureConnected(store).then(() => {
      store.sendWsMessage(wsMsg);
    }).catch(() => {
      store.addMessage({
        type: 'system',
        content: t('chat.connection.reconnectFailed')
      });
      delete store.processingConversations[store.currentConversation];
      stopProcessingWatchdog(store, store.currentConversation);
    });
  }
}

export function cancelExecution(store) {
  if (!store.currentConversation) return;
  if (!store.processingConversations[store.currentConversation]) return;

  const convId = store.currentConversation;

  store.sendWsMessage({
    type: 'cancel_execution',
    conversationId: convId
  });

  delete store.processingConversations[convId];
  stopProcessingWatchdog(store, convId);
  if (!store._closedAt) store._closedAt = {};
  store._closedAt[convId] = Date.now();
  const status = store.executionStatusMap[convId];
  if (status) status.currentTool = null;
  store.finishStreamingForConversation(convId);
  markAllToolsCompleted(store, convId);

  store.addMessage({
    type: 'system',
    content: t('chat.execution.cancelled')
  });
}

export function answerUserQuestion(store, requestId, answers, conversationId) {
  const convId = conversationId || store.currentConversation;
  store.sendWsMessage({
    type: 'ask_user_answer',
    conversationId: convId,
    requestId,
    answers
  });
  // Find the AskUserQuestion tool-use message by askRequestId and mark it answered
  // Check both Chat messages and Crew messages
  const chatMsgs = store.messagesMap[convId] || [];
  const chatMsg = chatMsgs.find(m =>
    m.type === 'tool-use' && m.toolName === 'AskUserQuestion' && m.askRequestId === requestId
  );
  if (chatMsg) {
    chatMsg.askAnswered = true;
    chatMsg.selectedAnswers = answers;
  }
  // Also check Crew messages for the current conversation
  const crewMsgs = store.crewMessagesMap?.[convId];
  if (crewMsgs) {
    const crewMsg = crewMsgs.find(m =>
      m.type === 'tool' && m.toolName === 'AskUserQuestion' && m.askRequestId === requestId
    );
    if (crewMsg) {
      crewMsg.askAnswered = true;
      crewMsg.selectedAnswers = answers;
    }
  }
  // 立刻进入 processing 状态，显示"思考中"指示器
  if (convId && !store.processingConversations[convId]) {
    store.processingConversations[convId] = true;
    if (store._closedAt?.[convId]) {
      delete store._closedAt[convId];
    }
    store.getOrCreateExecutionStatus(convId);
  }
}

// ★ Multi-column: append a conversation as a new column (max 3)
export function appendColumn(store, conversationId) {
  if (!conversationId) return;
  if (store.activeConversations.includes(conversationId)) return;
  if (store.activeConversations.length >= 3) return;

  store.activeConversations.push(conversationId);

  // Ensure messagesMap entry exists
  if (!store.messagesMap[conversationId]) {
    store.messagesMap[conversationId] = [];
    // Load messages from server
    store.sendWsMessage({
      type: 'sync_messages',
      conversationId,
      turns: 5
    });
  }

  saveOpenSessions(store);
}

// ★ Multi-column: remove a column
export function removeColumn(store, conversationId) {
  const idx = store.activeConversations.indexOf(conversationId);
  if (idx < 0) return;

  store.activeConversations.splice(idx, 1);

  if (store.activeConversations.length === 0) {
    localStorage.removeItem('lastViewedConversation');
    store.lastViewedConversation = null;
  }

  saveOpenSessions(store);
}

// ★ Multi-column: send message to a specific conversation (parameterized)
export function sendMessageToConversation(store, conversationId, text, attachments = [], options = {}) {
  const hasExpertSelections = options.expertSelections && options.expertSelections.length > 0;
  if ((!text.trim() && attachments.length === 0 && !hasExpertSelections) || !store.currentAgent || !conversationId) return;

  store.addMessageToConversation(conversationId, {
    type: 'user',
    content: text,
    attachments: attachments.length > 0 ? attachments : undefined,
    expertSelections: hasExpertSelections ? options.expertSelections : undefined
  });

  if (text.trim()) {
    const title = text.trim().substring(0, 100);
    store.conversationTitles[conversationId] = title;
  } else if (hasExpertSelections) {
    const sel = options.expertSelections[0];
    const label = `@${sel.role}${sel.action ? '\u00B7' + sel.action : ''}`;
    store.conversationTitles[conversationId] = label;
  }

  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv) {
    conv.lastMessageAt = Date.now();
  }

  if (!store.processingConversations[conversationId]) {
    store.processingConversations[conversationId] = true;
    if (store._closedAt?.[conversationId]) {
      delete store._closedAt[conversationId];
    }
    store._turnCompletedConvs?.delete(conversationId);
    store.getOrCreateExecutionStatus(conversationId);
    startProcessingWatchdog(store, conversationId);
  }

  const fileIds = attachments.map(a => a.fileId);
  const wsMsg = {
    type: 'chat',
    conversationId,
    prompt: text,
    fileIds,
    workDir: conv?.workDir || store.currentWorkDir
  };
  if (options.targetRole) {
    wsMsg.targetRole = options.targetRole;
  }
  if (hasExpertSelections) {
    wsMsg.expertSelections = options.expertSelections;
  }

  if (!store.sendWsMessage(wsMsg)) {
    ensureConnected(store).then(() => {
      store.sendWsMessage(wsMsg);
    }).catch(() => {
      store.addMessageToConversation(conversationId, {
        type: 'system',
        content: t('chat.connection.reconnectFailed')
      });
      delete store.processingConversations[conversationId];
      stopProcessingWatchdog(store, conversationId);
    });
  }
}

// ★ Multi-column: cancel execution for a specific conversation
export function cancelExecutionForConversation(store, conversationId) {
  if (!conversationId) return;
  if (!store.processingConversations[conversationId]) return;

  store.sendWsMessage({
    type: 'cancel_execution',
    conversationId
  });

  delete store.processingConversations[conversationId];
  stopProcessingWatchdog(store, conversationId);
  if (!store._closedAt) store._closedAt = {};
  store._closedAt[conversationId] = Date.now();
  const status = store.executionStatusMap[conversationId];
  if (status) status.currentTool = null;
  store.finishStreamingForConversation(conversationId);
  markAllToolsCompleted(store, conversationId);

  store.addMessageToConversation(conversationId, {
    type: 'system',
    content: t('chat.execution.cancelled')
  });
}

export function refreshAgents(store) {
  if (store.ws && store.ws.readyState === WebSocket.OPEN) {
    store.sendWsMessage({ type: 'get_agents' });
  }
}

export function refreshConversation(store) {
  if (!store.currentAgent || !store.currentConversation) return;
  store.sendWsMessage({
    type: 'refresh_conversation',
    conversationId: store.currentConversation
  });
}

export function restartAgent(store, agentId) {
  if (!agentId) return;
  store.sendWsMessage({
    type: 'restart_agent',
    agentId
  });
}

export function upgradeAgent(store, agentId) {
  if (!agentId) return;
  store.sendWsMessage({
    type: 'upgrade_agent',
    agentId
  });
}
