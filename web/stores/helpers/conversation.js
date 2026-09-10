// Conversation lifecycle helpers

import { startProcessingWatchdog, stopProcessingWatchdog } from './watchdog.js';
import { setSessionLoading, saveOpenSessions } from './session.js';
import { ensureConnected } from './websocket.js';
import { markAllToolsCompleted } from './handlers/conversationHandler.js';
import { t } from '../../utils/i18n.js';
import { EXPERT_ROLES, buildClientExpertMessage } from '../../utils/expert-roles.js';
import { normalizeChatRuntimeProvider } from './session-catalog.js';

function agentIdsForYeaftConversation(store, conversationId) {
  if (!conversationId || !store?.yeaftConversationIdsByAgent) return [];
  return Object.entries(store.yeaftConversationIdsByAgent)
    .filter(([, candidateConversationId]) => candidateConversationId === conversationId)
    .map(([agentId]) => agentId)
    .filter(Boolean);
}

/**
 * fix-usermsg-dup: opaque client-side id stamped on optimistic user
 * messages and forwarded to the server in the `chat` payload. The
 * server echoes it back on the assistant output frame so the
 * frontend dedup gate (assistantOutput.js) can match precisely instead of
 * falling back to string-equality on normalized content.
 *
 * Review C2 (Fowler): use `crypto.randomUUID()` rather than a homemade
 * `Date.now() + Math.random()` recipe. Two tabs hitting Send at the
 * same millisecond would share the timestamp half, dropping the
 * effective entropy to ~40 bits — birthday-bound that's a real
 * collision risk for power users. `crypto.randomUUID()` is in every
 * browser this app supports (Chrome 92+, Firefox 95+, Safari 15.4+)
 * and in Node 14.17+, so there's no dependency cost.
 *
 * The `cm_` prefix is preserved for the server-side validator
 * (C1) and to keep the id self-describing in logs / DB rows.
 */
function makeClientMessageId() {
  return `cm_${crypto.randomUUID()}`;
}

export function selectAgent(store, agentId) {
  if (agentId === store.currentAgent && !store.pendingAgentSelection) {
    console.log('[selectAgent] Same agent, skipping:', agentId);
    return;
  }
  console.log('[selectAgent] Switching agent from', store.currentAgent, 'to', agentId);
  const requestId = `agent_select_${crypto.randomUUID()}`;
  store.agentSwitching = true;
  store.pendingAgentSelection = { agentId, requestId };
  const sent = store.sendWsMessage({
    type: 'select_agent',
    agentId,
    requestId,
  });
  if (sent === false) {
    store.pendingAgentSelection = null;
    store.agentSwitching = false;
    return null;
  }
  return requestId;
}

export function createConversation(store, workDir, agentId = null, disallowedTools = null, options = {}) {
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
  if (options && typeof options.provider === 'string') {
    msg.provider = options.provider;
  }
  if (options && options.providerOptions && typeof options.providerOptions === 'object') {
    msg.providerOptions = options.providerOptions;
  }
  store.sendWsMessage(msg);
}

export function resumeConversation(store, claudeSessionId, workDir, agentId = null, disallowedToolsOrOptions = null, maybeOptions = null) {
  const targetAgent = agentId || store.currentAgent;
  if (!targetAgent) {
    store.addMessage({
      type: 'error',
      content: t('chat.agent.selectFirst')
    });
    return;
  }
  // Backwards-compatible: old call sites pass disallowedTools as 5th arg;
  // new ChatPage passes { provider } as the 5th arg.
  let disallowedTools = null;
  let options = {};
  if (disallowedToolsOrOptions && typeof disallowedToolsOrOptions === 'object' && !Array.isArray(disallowedToolsOrOptions)) {
    options = disallowedToolsOrOptions;
  } else {
    disallowedTools = disallowedToolsOrOptions;
    if (maybeOptions && typeof maybeOptions === 'object') options = maybeOptions;
  }
  // CLI history IDs are not Web conversation IDs. Reuse the existing Web
  // identity on this Agent/provider so resume keeps its catalog metadata and
  // persisted messages instead of creating a duplicate sidebar row.
  const provider = normalizeChatRuntimeProvider(options.provider);
  const existing = (store.conversations || []).find(conv => (
    conv.type !== 'yeaft'
    && conv.agentId === targetAgent
    && normalizeChatRuntimeProvider(conv.provider) === provider
    && conv.claudeSessionId === claudeSessionId
  ));
  const hiddenRow = existing && (store.hiddenSessionCatalog || []).find(row => (
    row.routeRef?.agentId === targetAgent
    && row.routeRef?.runtimeProvider === provider
    && row.routeRef?.sessionId === existing.id
  ));
  if (hiddenRow && store.restoreCatalogSession(hiddenRow) !== true) return;

  setSessionLoading(store, true, t('chat.session.loadingHistory'));
  const msg = {
    type: 'resume_conversation',
    agentId: targetAgent,
    ...(existing ? { conversationId: existing.id } : {}),
    claudeSessionId,
    workDir: workDir || store.currentAgentWorkDir
  };
  if (disallowedTools !== null) {
    msg.disallowedTools = disallowedTools;
  }
  if (typeof options.provider === 'string') {
    msg.provider = options.provider;
  }
  if (options.providerOptions && typeof options.providerOptions === 'object') {
    msg.providerOptions = options.providerOptions;
  }
  store.sendWsMessage(msg);
}

export function selectConversation(store, conversationId, agentId, { refresh = false } = {}) {
  // In split mode, selectConversation from sidebar routes to the active panel.
  if (store.panels.length > 1) {
    const targetPanelId = store.activePanelId || store.panels[0]?.id;
    if (targetPanelId) {
      store.setPanelConversation(targetPanelId, conversationId, { refresh });
    }
    return;
  }

  if (conversationId === store.currentConversation) {
    if (refresh) {
      store.syncChatConversationHistory?.(conversationId);
      saveOpenSessions(store);
    }
    return;
  }

  const conv = store.conversations.find(c => c.id === conversationId && c.type !== 'yeaft');
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

  // Paint cached rows immediately, then ask for the persisted delta. A click
  // is an explicit freshness boundary; cache presence must not suppress sync.
  const cachedMessages = store.messagesMap[conversationId];
  if (!cachedMessages || cachedMessages.length === 0) {
    store.messagesMap[conversationId] = [];
    setSessionLoading(store, true, t('chat.session.loadingHistory'));
  }
  store.syncChatConversationHistory?.(conversationId);
  // ★ Bug #4 / perf-chat-session-switch-cache: pagination state.
  //
  // Reset loadingMoreMessages unconditionally — any in-flight load-more
  // belonged to the previous conv and should not bleed across.
  //
  // hasMoreMessages now comes from per-conv chatSessionState so
  // switching away and back doesn't kill the "Load older" button on
  // a conv with pending older history. On a brand-new conv with no
  // recorded state, fall back to false (matches pre-PR behavior — the
  // cold-load that's about to fire will overwrite it).
  store.loadingMoreMessages = false;
  const persisted = store.chatSessionState[conversationId];
  store.hasMoreMessages = !!persisted?.hasMoreOlder;

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
  if (!conversationId) return false;
  return store.sendWsMessage({
    type: 'delete_conversation',
    requestId: `delete_${crypto.randomUUID()}`,
    conversationId,
    ...(agentId ? { agentId } : {}),
  });
}

export function deleteConversation(store, conversationId, agentId) {

  // Mark as recently deleted to prevent handleAgentList from re-adding it
  if (!store._recentlyDeletedSessions) store._recentlyDeletedSessions = {};
  store._recentlyDeletedSessions[conversationId] = Date.now();

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

  // Clear from split panels if present
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

  store.sendWsMessage({
    type: 'delete_conversation',
    requestId: `delete_${crypto.randomUUID()}`,
    conversationId,
    ...(agentId ? { agentId } : {}),
  });
}

export function sendMessage(store, text, attachments = [], options = {}) {
  const hasExpertSelections = options.expertSelections && options.expertSelections.length > 0;
  if ((!text.trim() && attachments.length === 0 && !hasExpertSelections) || !store.currentAgent || !store.currentConversation) return;

  // fix-usermsg-dup: stamp a stable id on the optimistic message AND on
  // the outgoing `chat` payload so the server can round-trip it back on
  // the assistant output user echo. Without this, dedup in
  // assistantOutput.js falls back to a fragile `content === content`
  // string match which breaks the moment normalization differs
  // (whitespace, `[Uploaded files]` marker, attachment-only sends, etc.),
  // producing the "user message rendered twice" symptom that only
  // reproduces after page refresh.
  const clientMessageId = makeClientMessageId();

  store.addMessage({
    type: 'user',
    content: text,
    clientMessageId,
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
    // fix-chat-reconnect-race — always pin the conversationId on chat
    // wsMsg, even on the legacy single-panel send path. Two reasons:
    //  1) Defense in depth on top of Fix A: if `client.currentConversation`
    //     on the server is somehow stale (e.g. a redeploy raced ahead of
    //     the next agent_list), the server's chat handler still resolves
    //     via `msg.conversationId || client.currentConversation`.
    //  2) Unlocks the server's "search all agents for conv owner"
    //     fallback (client-conversation.js around line 342) — that
    //     branch is gated on `msg.conversationId` being present, so
    //     without this we silently lose cross-agent routing.
    // sendMessageToConversation (the multi-panel variant) already sets
    // this; we're catching the legacy single-panel path up to it.
    conversationId: store.currentConversation,
    prompt: text,
    fileIds,
    workDir: store.currentWorkDir,
    // fix-usermsg-dup: round-trips back on the user echo so the dedup
    // gate matches by id, not by normalized-content string equality.
    clientMessageId
  };
  // Pass targetRole for @mention routing
  if (options.targetRole) {
    wsMsg.targetRole = options.targetRole;
  }
  // Pass expertSelections for 帮帮团
  if (hasExpertSelections) {
    wsMsg.expertSelections = options.expertSelections;
    // For custom roles, build the prompt on the client side
    const customResult = buildClientExpertMessage(
      options.expertSelections,
      store.customExpertRoles,
      text,
      store.language || 'zh-CN'
    );
    if (customResult) {
      wsMsg.expertMessage = customResult.effectivePrompt;
    }
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
  // Find the AskUserQuestion tool-use message first: Yeaft needs its exact
  // Session/VP/turn/thread envelope so parallel prompts cannot cross-resolve.
  const chatMsgs = store.messagesMap[convId] || [];
  const chatMsg = chatMsgs.find(m =>
    m.type === 'tool-use' && m.toolName === 'AskUserQuestion' && m.askRequestId === requestId
  );
  const isYeaftPrompt = store.currentView === 'yeaft' || !!chatMsg?.sessionId;
  if (isYeaftPrompt && (!chatMsg || chatMsg.askAnswered || chatMsg.askExpired)) return false;
  // A resend is explicit and bounded; lack of acknowledgement is not failure.
  if (isYeaftPrompt && chatMsg.askPending && Date.now() - (chatMsg.askSubmittedAt || 0) < 15_000) return false;
  const sessionId = chatMsg?.sessionId || store.yeaftActiveSessionFilter || null;
  const cardAgentId = typeof chatMsg?.agentId === 'string' && chatMsg.agentId
    ? chatMsg.agentId
    : null;
  const conversationAgentIds = isYeaftPrompt
    ? agentIdsForYeaftConversation(store, convId)
    : [];
  const conversationAgentId = conversationAgentIds.length === 1
    ? conversationAgentIds[0]
    : null;
  // The card identity came from the Agent event that created the prompt. Do
  // not replace it with a Session resolver that can fall back to the page's
  // current Agent while ownership is still hydrating. A unique conversation
  // mapping is also authoritative; if it conflicts with the card, fail closed
  // before mutating local state. Ambiguous mappings cannot disprove the card.
  if (cardAgentId && conversationAgentId && cardAgentId !== conversationAgentId) return false;
  const legacyOwnerAgentId = isYeaftPrompt && !cardAgentId && !conversationAgentId
    && typeof store.agentIdForSession === 'function'
    ? store.agentIdForSession(sessionId)
    : null;
  const sent = store.sendWsMessage(isYeaftPrompt ? {
    type: 'yeaft_ask_user_answer',
    agentId: cardAgentId || conversationAgentId || legacyOwnerAgentId || store.yeaftAgentId || store.currentAgent || null,
    conversationId: convId,
    requestId,
    toolCallId: chatMsg?.toolId || null,
    answers,
    sessionId,
    vpId: chatMsg?.vpId || chatMsg?.speakerVpId || null,
    turnId: chatMsg?.turnId || null,
    threadId: chatMsg?.threadId || 'main',
  } : {
    type: 'ask_user_answer',
    conversationId: convId,
    requestId,
    answers
  });
  // Yeaft prompts are shared across devices. Record a submitted answer on the
  // message row so a component/session remount cannot reopen the card, but wait
  // for the agent event or persisted tool result before marking it confirmed.
  // Chat-provider prompts retain their historical optimistic collapse behavior.
  if (chatMsg && !isYeaftPrompt) {
    chatMsg.askAnswered = true;
    chatMsg.selectedAnswers = answers;
  } else if (chatMsg && sent !== false) {
    chatMsg.askPending = true;
    chatMsg.pendingAnswers = answers;
    chatMsg.askSubmittedAt = Date.now();
    chatMsg.askError = null;
  } else if (chatMsg) {
    chatMsg.askError = 'send_failed';
  }

  // A browser send is not Agent acceptance. Native prompts remain in their
  // current execution state until the Agent confirms/continues the turn.
  if (!isYeaftPrompt && sent !== false && convId && !store.processingConversations[convId]) {
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
    // Load messages from server with a generation-scoped request.
    store.requestChatHistory?.(conversationId, { mode: 'recent', turns: 5 });
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

  // fix-usermsg-dup: see sendMessage above — same rationale, multi-column path.
  const clientMessageId = makeClientMessageId();

  store.addMessageToConversation(conversationId, {
    type: 'user',
    content: text,
    clientMessageId,
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
    workDir: conv?.workDir || store.currentWorkDir,
    // fix-usermsg-dup: see sendMessage above — same rationale.
    clientMessageId
  };
  if (options.targetRole) {
    wsMsg.targetRole = options.targetRole;
  }
  if (hasExpertSelections) {
    wsMsg.expertSelections = options.expertSelections;
    // For custom roles, build the prompt on the client side
    const customResult = buildClientExpertMessage(
      options.expertSelections,
      store.customExpertRoles,
      text,
      store.language || 'zh-CN'
    );
    if (customResult) {
      wsMsg.expertMessage = customResult.effectivePrompt;
    }
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
    if (typeof store.requestYeaftSessionInventory === 'function') {
      store.requestYeaftSessionInventory();
    } else {
      store.sendWsMessage({ type: 'get_agents' });
    }
  }
}

export function refreshConversation(store) {
  if (!store.currentAgent || !store.currentConversation) return;
  store.sendWsMessage({
    type: 'refresh_conversation',
    conversationId: store.currentConversation
  });
}

export function setDreamEnabled(store, agentId, enabled, requestId) {
  if (!agentId) return;
  store.sendWsMessage({ type: 'set_dream_enabled', agentId, enabled: enabled !== false, requestId });
}

export function upgradeAgent(store, agentId) {
  if (!agentId) return;
  store.sendWsMessage({
    type: 'upgrade_agent',
    agentId
  });
}
