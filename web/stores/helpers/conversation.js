// Conversation lifecycle helpers

import { startProcessingWatchdog, stopProcessingWatchdog } from './watchdog.js';
import { setSessionLoading, saveOpenSessions } from './session.js';
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
  if (conversationId === store.currentConversation) return;

  if (store.currentConversation && store.messages.length > 0) {
    store.messagesCache[store.currentConversation] = store.messages;
  }

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
    // Crew conversations use crewMessagesMap, not messages/messagesCache.
    // Initialize crewMessagesMap entry BEFORE setting currentConversation,
    // so that currentCrewMessages getter tracks the correct reactive property.
    if (!store.crewMessagesMap[conversationId]) {
      store.crewMessagesMap[conversationId] = [];
    }
    store.messages = [];
  }

  store.currentConversation = conversationId;
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
    const cachedMessages = store.messagesCache[conversationId];
    if (cachedMessages && cachedMessages.length > 0) {
      store.messages = cachedMessages;
    } else {
      store.messages = [];
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

export function deleteConversation(store, conversationId, agentId) {
  // 清理 crew 数据（不管 server 是否响应）
  const conv = store.conversations.find(c => c.id === conversationId);
  if (conv?.type === 'crew') {
    delete store.crewSessions?.[conversationId];
    delete store.crewMessagesMap?.[conversationId];
    delete store.crewOlderMessages?.[conversationId];
    delete store.crewStatuses?.[conversationId];
    // 记录已删除的 crew session，防止 conversation_list 同步时重新加入
    if (!store._deletedCrewSessionIds) store._deletedCrewSessionIds = new Set();
    store._deletedCrewSessionIds.add(conversationId);
    // 从 agent 的 crew index 中隐藏（不是真删），防止 sendConversationList 重新加载
    store.sendWsMessage({
      type: 'delete_crew_session',
      sessionId: conversationId,
      agentId: agentId || store.currentAgent
    });
  }

  // 立即从本地列表移除（不等 server 同步）
  store.conversations = store.conversations.filter(c => c.id !== conversationId);
  if (store.currentConversation === conversationId) {
    store.currentConversation = null;
    // 清除 lastViewedConversation，防止页面刷新时 autoRestore 恢复已删除的对话
    localStorage.removeItem('lastViewedConversation');
    store.lastViewedConversation = null;
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
  store.sendWsMessage(wsMsg);
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

  store.addMessage({
    type: 'system',
    content: t('chat.execution.cancelled')
  });
}

export function answerUserQuestion(store, requestId, answers) {
  store.sendWsMessage({
    type: 'ask_user_answer',
    conversationId: store.currentConversation,
    requestId,
    answers
  });
  // Find the AskUserQuestion tool-use message by askRequestId and mark it answered
  // Check both Chat messages and Crew messages
  const chatMsg = store.messages.find(m =>
    m.type === 'tool-use' && m.toolName === 'AskUserQuestion' && m.askRequestId === requestId
  );
  if (chatMsg) {
    chatMsg.askAnswered = true;
    chatMsg.selectedAnswers = answers;
  }
  // Also check Crew messages for the current conversation
  const crewMsgs = store.crewMessagesMap?.[store.currentConversation];
  if (crewMsgs) {
    const crewMsg = crewMsgs.find(m =>
      m.type === 'tool' && m.toolName === 'AskUserQuestion' && m.askRequestId === requestId
    );
    if (crewMsg) {
      crewMsg.askAnswered = true;
      crewMsg.selectedAnswers = answers;
    }
  }
  // Also check Conductor messages across all convIds
  if (store.conductorMessages) {
    for (const condMsgs of Object.values(store.conductorMessages)) {
      const condMsg = condMsgs.find(m =>
        m.type === 'tool' && m.toolName === 'AskUserQuestion' && m.askRequestId === requestId
      );
      if (condMsg) {
        condMsg.askAnswered = true;
        condMsg.selectedAnswers = answers;
        break;
      }
    }
  }
  // 立刻进入 processing 状态，显示"思考中"指示器
  if (store.currentConversation && !store.processingConversations[store.currentConversation]) {
    store.processingConversations[store.currentConversation] = true;
    if (store._closedAt?.[store.currentConversation]) {
      delete store._closedAt[store.currentConversation];
    }
    store.getOrCreateExecutionStatus(store.currentConversation);
  }
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
