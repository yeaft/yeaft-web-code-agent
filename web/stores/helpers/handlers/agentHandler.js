/**
 * Agent-related message handlers: agent_list, agent_selected.
 * The most complex handler — includes auto-restore and reconnection logic.
 */

import { isRecentlyClosed, stopProcessingWatchdog } from '../watchdog.js';
import { clearSessionLoading } from '../session.js';

/**
 * 恢复上次查看的 conversation（公共逻辑）。
 */
export function restoreLastViewedConversation(store, agentSetup) {
  const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
  if (!lastViewed) return false;

  // 跳过已删除的 crew session
  if (store._deletedCrewSessionIds?.has(lastViewed)) return false;

  const conv = store.conversations.find(c => c.id === lastViewed);
  if (!conv) return false;

  const agentId = agentSetup?.agentId || store.currentAgent;

  // 设置 agent（AutoRestore 路径需要）
  if (agentSetup) {
    store.currentAgent = agentSetup.agentId;
    store.currentAgentInfo = agentSetup.agentInfo;
    store.sendWsMessage({ type: 'select_agent', agentId: agentSetup.agentId, silent: true });
  }

  // 设置 conversation 状态
  // For crew conversations, initialize crewMessagesMap BEFORE setting currentConversation
  if (conv.type === 'crew' && !store.crewMessagesMap[lastViewed]) {
    store.crewMessagesMap[lastViewed] = [];
  }
  store.currentConversation = lastViewed;
  store.currentWorkDir = conv.workDir;
  store.messages = [];
  store.sendWsMessage({ type: 'select_conversation', conversationId: lastViewed });

  if (conv.type === 'crew') {
    store.sendWsMessage({
      type: 'resume_crew_session',
      sessionId: lastViewed,
      agentId
    });
  } else {
    store.sendWsMessage({
      type: 'sync_messages',
      conversationId: lastViewed,
      turns: 5
    });
    store.sendWsMessage({ type: 'refresh_conversation', conversationId: lastViewed });
  }
  return true;
}

/**
 * Handle agent_list message: sync conversations, proxy ports, reconnection.
 */
export function handleAgentList(store, msg) {
  store.agents = msg.agents;
  {
    const agentIds = new Set(msg.agents.map(a => a.id));
    for (const agent of msg.agents) {
      store.proxyPorts[agent.id] = agent.proxyPorts || [];
    }
    for (const id of Object.keys(store.proxyPorts)) {
      if (!agentIds.has(id)) {
        delete store.proxyPorts[id];
      }
    }
  }
  if (store.currentAgent) {
    const agent = msg.agents.find(a => a.id === store.currentAgent);
    if (agent) {
      store.currentAgentInfo = agent;
    }
  }
  // ★ 同步所有 agent 的 conversations 到 store.conversations
  {
    const allServerConvs = [];
    const allServerConvIds = new Set();
    for (const agent of msg.agents) {
      for (const serverConv of (agent.conversations || [])) {
        if (allServerConvIds.has(serverConv.id)) continue;
        allServerConvIds.add(serverConv.id);
        allServerConvs.push({
          ...serverConv,
          type: serverConv.type,
          agentId: agent.id,
          agentName: agent.name
        });
        if (serverConv.title && !store.conversationTitles[serverConv.id]) {
          store.conversationTitles[serverConv.id] = serverConv.title;
        }
      }
    }

    for (const serverConv of allServerConvs) {
      // 跳过已删除的 crew session，防止 conversation_list 同步恢复
      if (store._deletedCrewSessionIds?.has(serverConv.id)) continue;
      const existing = store.conversations.find(c => c.id === serverConv.id);
      if (existing) {
        existing.claudeSessionId = serverConv.claudeSessionId || existing.claudeSessionId;
        existing.processing = serverConv.processing;
        existing.userId = serverConv.userId;
        existing.username = serverConv.username;
        existing.agentId = serverConv.agentId;
        existing.agentName = serverConv.agentName;
        if (serverConv.type) existing.type = serverConv.type;
        // Preserve crew session name from server; keep existing if server has none
        if (serverConv.name !== undefined) existing.name = serverConv.name;
      } else {
        store.conversations.push(serverConv);
      }
    }
    store.conversations = store.conversations.filter(c => allServerConvIds.has(c.id));

    for (const serverConv of allServerConvs) {
      const isStaleCrewProcessing = serverConv.processing && serverConv.type === 'crew'
        && !store.crewSessions?.[serverConv.id];
      if (serverConv.processing && !isRecentlyClosed(store, serverConv.id)
          && !store._turnCompletedConvs?.has(serverConv.id)
          && !isStaleCrewProcessing) {
        store.processingConversations[serverConv.id] = true;
      } else if (store.processingConversations[serverConv.id]) {
        delete store.processingConversations[serverConv.id];
        stopProcessingWatchdog(store, serverConv.id);
        const status = store.executionStatusMap[serverConv.id];
        if (status) status.currentTool = null;
        store.finishStreamingForConversation(serverConv.id);
      }
    }
    for (const convId of Object.keys(store.processingConversations)) {
      if (!allServerConvIds.has(convId)) {
        console.log(`[agent_list] Clearing stale processing state for ${convId}`);
        delete store.processingConversations[convId];
        stopProcessingWatchdog(store, convId);
        const status = store.executionStatusMap[convId];
        if (status) status.currentTool = null;
        store.finishStreamingForConversation(convId);
      }
    }
  }
  // ★ Reconnect: 清空客户端残留状态
  store._turnCompletedConvs?.clear();
  store._closedAt = {};
  // ★ Reconnect 恢复
  if (store.currentAgent) {
    const agent = msg.agents.find(a => a.id === store.currentAgent && a.online);
    if (agent) {
      console.log('[Reconnect] Agent online, restoring selection:', store.currentAgent);
      store.currentAgentInfo = agent;
      store.sendWsMessage({ type: 'select_agent', agentId: store.currentAgent, silent: true });
      if (store.currentConversation) {
        const conv = store.conversations.find(c => c.id === store.currentConversation);
        store.sendWsMessage({ type: 'select_conversation', conversationId: store.currentConversation });
        if (conv?.type === 'crew') {
          console.log('[Reconnect] Crew conversation detected, resuming crew session:', store.currentConversation);
          store.sendWsMessage({
            type: 'resume_crew_session',
            sessionId: store.currentConversation,
            agentId: store.currentAgent
          });
        } else {
          if (store.messages.length > 0) {
            const lastMessageId = store.messages[store.messages.length - 1]?.id;
            console.log('[Reconnect] Requesting missed messages after:', lastMessageId);
            store.sendWsMessage({
              type: 'sync_messages',
              conversationId: store.currentConversation,
              afterMessageId: lastMessageId
            });
          } else {
            store.sendWsMessage({
              type: 'sync_messages',
              conversationId: store.currentConversation,
              turns: 5
            });
          }
          store.sendWsMessage({
            type: 'refresh_conversation',
            conversationId: store.currentConversation
          });
        }
      } else if (!store.recoveryDismissed) {
        console.log('[Reconnect] currentConversation null, attempting restore');
        restoreLastViewedConversation(store);
      }
      return;
    } else {
      console.log('[Reconnect] Agent not online yet:', store.currentAgent);
      return;
    }
  }
  // ★ 自动恢复上次查看的 conversation（UI 刷新后）
  if (!store.currentConversation && !store.currentAgent && !store.recoveryDismissed) {
    const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
    const lastAgent = store.lastUsedAgent;

    if (lastViewed) {
      const conv = store.conversations.find(c => c.id === lastViewed);
      if (conv) {
        const agent = msg.agents.find(a => a.id === conv.agentId && a.online);
        if (agent) {
          console.log('[AutoRestore] Restoring last viewed conversation:', lastViewed, 'on agent:', conv.agentId);
          restoreLastViewedConversation(store, { agentId: conv.agentId, agentInfo: agent });
          return;
        }
      }
    }

    if (lastAgent) {
      const agent = store.agents.find(a => a.id === lastAgent && a.online);
      if (agent) {
        console.log('[AutoRestore] Auto-selecting last used agent:', lastAgent);
        store.selectAgent(lastAgent);
      } else {
        store.checkPendingRecovery();
      }
    }
  }
}

/**
 * Handle agent_selected message.
 */
export function handleAgentSelected(store, msg) {
  console.log('[agent_selected] Switching to agent:', msg.agentId);
  store.agentSwitching = false;
  const isSameAgent = store.currentAgent === msg.agentId;
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = {
    id: msg.agentId,
    name: msg.agentName,
    workDir: msg.workDir,
    capabilities: msg.capabilities || ['terminal', 'file_editor', 'background_tasks']
  };

  if (msg.slashCommands && msg.slashCommands.length > 0) {
    // Store as agent-level default, used as fallback when a conversation
    // hasn't reported its own slashCommands yet
    store.slashCommandsMap[`agent:${msg.agentId}`] = msg.slashCommands;
  }
  // Merge command descriptions
  if (msg.slashCommandDescriptions) {
    store.slashCommandDescriptions = { ...store.slashCommandDescriptions, ...msg.slashCommandDescriptions };
  }

  const serverConvs = msg.conversations || [];
  const seenIds = new Set();
  let activeConvs = serverConvs.filter(c => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  }).map(c => ({
    ...c,
    agentId: msg.agentId,
    agentName: msg.agentName
  }));

  if (isSameAgent && store.currentConversation) {
    const currentConvInServer = serverConvs.find(c => c.id === store.currentConversation);
    if (currentConvInServer && !activeConvs.find(c => c.id === currentConvInServer.id)) {
      activeConvs.push({
        ...currentConvInServer,
        agentId: msg.agentId,
        agentName: msg.agentName
      });
    }
  }

  const otherAgentConvs = store.conversations.filter(c => c.agentId !== msg.agentId);
  store.conversations = [...otherAgentConvs, ...activeConvs];

  for (const conv of serverConvs) {
    if (conv.title && !store.conversationTitles[conv.id]) {
      store.conversationTitles[conv.id] = conv.title;
    }
  }

  console.log('[agent_selected] Merged conversations:', store.conversations.length,
              'from agent:', msg.agentId, 'kept from others:', otherAgentConvs.length);

  const agentConvIds = new Set(serverConvs.map(c => c.id));
  for (const conv of serverConvs) {
    if (conv.processing && !isRecentlyClosed(store, conv.id)
        && !store._turnCompletedConvs?.has(conv.id)) {
      store.processingConversations[conv.id] = true;
    } else if (store.processingConversations[conv.id]) {
      delete store.processingConversations[conv.id];
      stopProcessingWatchdog(store, conv.id);
      const status = store.executionStatusMap[conv.id];
      if (status) status.currentTool = null;
      store.finishStreamingForConversation(conv.id);
    }
  }
  for (const convId of Object.keys(store.processingConversations)) {
    if (!agentConvIds.has(convId)) {
      const isOtherAgent = otherAgentConvs.some(c => c.id === convId);
      if (!isOtherAgent) {
        console.log(`[agent_selected] Clearing stale processing state for ${convId}`);
        delete store.processingConversations[convId];
        stopProcessingWatchdog(store, convId);
        const status = store.executionStatusMap[convId];
        if (status) status.currentTool = null;
        store.finishStreamingForConversation(convId);
      }
    }
  }

  if (isSameAgent && store.currentConversation) {
    const currentConv = store.conversations.find(c => c.id === store.currentConversation);
    store.currentWorkDir = currentConv?.workDir || store.currentWorkDir || msg.workDir;
    console.log('[Reconnect] Restoring conversation selection:', store.currentConversation);
    clearSessionLoading(store);
    store.sendWsMessage({
      type: 'select_conversation',
      conversationId: store.currentConversation
    });
    // ★ Crew session needs resume to restore roles after server restart
    if (currentConv?.type === 'crew') {
      console.log('[Reconnect] Crew conversation detected in agent_selected, resuming:', store.currentConversation);
      store.sendWsMessage({
        type: 'resume_crew_session',
        sessionId: store.currentConversation,
        agentId: msg.agentId
      });
    }
  } else {
    store.currentConversation = null;
    store.currentWorkDir = msg.workDir;
    store.messages = [];

    const lastViewed = store.lastViewedConversation || localStorage.getItem('lastViewedConversation');
    if (lastViewed && store.conversations.find(c => c.id === lastViewed)) {
      console.log('[AutoRestore] Restoring last viewed conversation:', lastViewed);
      store.autoRestoreConversation(lastViewed);
      store.pendingRecovery = null;
    }
  }
}
