/**
 * Message handler — thin switch dispatcher.
 * Delegates to sub-handlers for complex message types.
 */

import { useAuthStore } from '../auth.js';
import { decodeKey } from '../../utils/encryption.js';
import { t } from '../../utils/i18n.js';
import { stopProcessingWatchdog, startLegacyWatchdog } from './watchdog.js';
import { clearSessionLoading } from './session.js';
import { clearRefreshTimeout } from './crew.js';
import { handleAgentList, handleAgentSelected } from './handlers/agentHandler.js';
import {
  handleConversationCreated,
  handleConversationResumed,
  handleConversationDeleted,
  handleTurnCompleted,
  handleConversationClosed,
  handleConversationRefresh,
  handleExecutionCancelled,
  handleSyncMessagesResult
} from './handlers/conversationHandler.js';

export function handleMessage(store, msg) {
  const authStore = useAuthStore();

  // Any message means connection is alive
  store._lastPongAt = Date.now();

  switch (msg.type) {
    case 'auth_result':
      if (msg.success) {
        store.authenticated = true;

        if (msg.sessionKey) {
          store.sessionKey = decodeKey(msg.sessionKey);
          authStore.setSessionKey(msg.sessionKey);
        }

        if (msg.role) {
          authStore.role = msg.role;
        }

        const knownConvIds = store.conversations.map(c => c.id).filter(Boolean);
        store.sendWsMessage({
          type: 'get_agents',
          conversationIds: knownConvIds.length > 0 ? knownConvIds : undefined
        });

        store.checkPendingRecovery();
      } else {
        store.addMessage({
          type: 'error',
          content: msg.error || t('login.error.loginFailed')
        });
        authStore.reset();
      }
      break;

    case 'agent_list':
      handleAgentList(store, msg);
      break;

    case 'agent_selected':
      handleAgentSelected(store, msg);
      break;

    case 'conversation_created':
      handleConversationCreated(store, msg);
      break;

    case 'conversation_resumed':
      handleConversationResumed(store, msg);
      break;

    case 'conversation_selected':
      if (store.currentConversation === msg.conversationId) {
        return;
      }
      store.activeConversations = [msg.conversationId];
      {
        const conv = store.conversations.find(c => c.id === msg.conversationId);
        if (conv) {
          store.currentWorkDir = conv.workDir;
        }
      }
      store.messagesMap[msg.conversationId] = [];
      store.saveOpenSessions();
      break;

    case 'conversation_settings_updated': {
      const settingsConv = store.conversations.find(c => c.id === msg.conversationId);
      if (settingsConv && msg.disallowedTools !== undefined) {
        settingsConv.disallowedTools = msg.disallowedTools;
      }
      // 同步 conversationMcpServers 中的 enabled 状态
      const convMcpList = store.conversationMcpServers[msg.conversationId];
      if (convMcpList && msg.disallowedTools) {
        const disallowedSet = new Set(msg.disallowedTools);
        const serverToolsMap = store.conversationMcpServerTools[msg.conversationId] || {};
        for (const server of convMcpList) {
          const tools = serverToolsMap[server.name];
          if (tools && tools.length > 0) {
            // Server is disabled if any of its tools is in disallowedTools
            server.enabled = !tools.some(t => disallowedSet.has(t));
          } else {
            // Fallback: check prefix pattern
            server.enabled = !disallowedSet.has(`mcp__${server.name}`);
          }
        }
      }
      // 标记需要重启
      if (msg.needRestart && settingsConv) {
        settingsConv.needRestart = true;
      }
      break;
    }

    case 'sync_messages_result':
      handleSyncMessagesResult(store, msg);
      break;

    case 'conversation_deleted':
      handleConversationDeleted(store, msg);
      break;

    case 'turn_completed':
      handleTurnCompleted(store, msg);
      break;

    case 'conversation_closed':
      handleConversationClosed(store, msg);
      break;

    case 'claude_output':
      store.handleClaudeOutput(msg.conversationId, msg.data);
      break;

    case 'unify_output':
      store.handleUnifyOutput(msg);
      break;

    case 'chat_image':
      // Image from Claude response (tool screenshots, etc.)
      if (msg.conversationId && msg.fileId) {
        store.addMessageToConversation(msg.conversationId, {
          type: 'chat-image',
          fileId: msg.fileId,
          previewToken: msg.previewToken,
          mimeType: msg.mimeType
        });
      }
      break;

    case 'error': {
      const errorConvId = msg.conversationId || store.currentConversation;
      const isSystemError = ['Permission denied', 'Agent not found', 'No conversation selected', 'Agent is still syncing', 'Agent access denied'].some(
        s => msg.message?.includes(s)
      );
      if (msg.message?.includes('Agent is still syncing') || msg.message?.includes('Agent not found')) {
        clearSessionLoading(store);
      }

      // B: Dedup — collapse identical system error bubbles arriving within 3s.
      // Keep the first, drop repeats, append " (×N)" counter to the kept bubble.
      if (isSystemError && errorConvId) {
        const msgs = store.messagesMap[errorConvId];
        if (msgs && msgs.length > 0) {
          // Find the most recent error bubble (scan from tail, short walk)
          for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 5; i--) {
            const last = msgs[i];
            if (last && last.type === 'error' && last._sysErrBaseContent !== undefined) {
              if (last._sysErrBaseContent === msg.message && (Date.now() - (last._sysErrFirstAt || 0)) <= 3000) {
                last._sysErrCount = (last._sysErrCount || 1) + 1;
                last.content = `${last._sysErrBaseContent} (×${last._sysErrCount})`;
                // Extend auto-remove window so the counted bubble stays visible
                if (last._sysErrRemoveTimer) {
                  clearTimeout(last._sysErrRemoveTimer);
                  last._sysErrRemoveTimer = setTimeout(() => {
                    const cur = store.messagesMap[errorConvId];
                    if (cur) {
                      const idx = cur.findIndex(m => m.id === last.id);
                      if (idx >= 0) cur.splice(idx, 1);
                    }
                  }, 5000);
                }
                return;
              }
              break;
            }
          }
        }
      }

      const errorId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      const newMsg = {
        type: 'error',
        content: msg.message,
        transient: isSystemError,
        dbMessageId: isSystemError ? ('err_' + errorId) : undefined
      };
      if (isSystemError) {
        newMsg._sysErrBaseContent = msg.message;
        newMsg._sysErrCount = 1;
        newMsg._sysErrFirstAt = Date.now();
      }
      store.addMessageToConversation(errorConvId, newMsg);
      // Resolve the actual pushed object (addMessageToConversation spreads into a new object)
      let pushedMsg = null;
      if (isSystemError && errorConvId) {
        const arr = store.messagesMap[errorConvId];
        if (arr && arr.length > 0) pushedMsg = arr[arr.length - 1];
      }
      if (isSystemError && errorConvId && pushedMsg) {
        const convId = errorConvId;
        const errMsgId = 'err_' + errorId;
        pushedMsg._sysErrRemoveTimer = setTimeout(() => {
          const msgs = store.messagesMap[convId];
          if (msgs) {
            const idx = msgs.findIndex(m => m.id === errMsgId);
            if (idx >= 0) {
              msgs.splice(idx, 1);
            }
          }
        }, 5000);
      }
      if (!isSystemError && errorConvId) {
        delete store.processingConversations[errorConvId];
        stopProcessingWatchdog(store, errorConvId);
        store.finishStreamingForConversation(errorConvId);
      }
      break;
    }

    case 'history_sessions_list':
      if (msg.requestId && store._historySessionsRequestId && msg.requestId !== store._historySessionsRequestId) {
        break;
      }
      store.historySessions = msg.sessions || [];
      store.historySessionsLoading = false;
      break;

    case 'folders_list':
      console.log('[folders_list] Received:', msg.folders?.length || 0, 'folders, requestId:', msg.requestId);
      if (msg.requestId && store._foldersRequestId && msg.requestId !== store._foldersRequestId) {
        console.log('[folders_list] Stale response ignored, expected:', store._foldersRequestId);
        break;
      }
      store.folders = msg.folders || [];
      store.foldersLoading = false;
      if (store._foldersResolve) {
        store._foldersResolve();
        store._foldersResolve = null;
      }
      break;

    case 'crew_context_result':
      window.dispatchEvent(new CustomEvent('crew-context-result', { detail: msg }));
      break;

    case 'crew_sessions_list':
      break;

    case 'crew_exists_result':
      store.crewExistsResult = {
        exists: msg.exists,
        projectDir: msg.projectDir,
        sessionInfo: msg.sessionInfo || null,
        requestId: msg.requestId
      };
      break;

    case 'conversation_refresh':
      handleConversationRefresh(store, msg);
      break;

    case 'session_pinned':
      // Server confirms pin state — already applied optimistically
      break;

    case 'execution_cancelled':
      handleExecutionCancelled(store, msg);
      break;

    case 'slash_commands_update':
      if (msg.slashCommands && msg.slashCommands.length > 0) {
        if (msg.conversationId) {
          store.slashCommandsMap[msg.conversationId] = msg.slashCommands;
        }
        if (msg.agentId) {
          store.slashCommandsMap[`agent:${msg.agentId}`] = msg.slashCommands;
        }
      }
      // Merge command descriptions (cumulative — new descriptions extend existing)
      if (msg.slashCommandDescriptions) {
        store.slashCommandDescriptions = { ...store.slashCommandDescriptions, ...msg.slashCommandDescriptions };
      }
      break;

    case 'compact_status':
      {
        const convId = msg.conversationId;
        console.log(`[Compact] Status: ${msg.status} for ${convId}`);
        store.compactStatus = {
          conversationId: convId,
          status: msg.status,
          message: msg.message
        };
        if (msg.status === 'completed') {
          setTimeout(() => {
            if (store.compactStatus?.conversationId === convId && store.compactStatus?.status === 'completed') {
              store.compactStatus = null;
            }
          }, 3000);
        } else if (msg.status === 'compacting') {
          setTimeout(() => {
            if (store.compactStatus?.conversationId === convId && store.compactStatus?.status === 'compacting') {
              console.warn(`[Compact] Timeout: clearing stale compacting status for ${convId}`);
              store.compactStatus = null;
            }
          }, 30000);
        }
      }
      break;

    case 'pong_session': {
      const pongConvId = msg.conversationId;
      if (!pongConvId) break;

      // Clear pong timeout (watchdog sets it)
      if (store._pongTimeouts?.[pongConvId]) {
        clearTimeout(store._pongTimeouts[pongConvId]);
        delete store._pongTimeouts[pongConvId];
      }

      if (msg.status === 'unsupported') {
        // Old agent doesn't support ping — stop ping watchdog, fallback to legacy 90s refresh
        stopProcessingWatchdog(store, pongConvId);
        startLegacyWatchdog(store, pongConvId);
        break;
      }

      if (msg.status === 'ok') {
        // Clear health warning
        if (store.sessionHealth?.[pongConvId]) {
          delete store.sessionHealth[pongConvId];
        }
        // Sync processing state: if agent says not processing, clear frontend state
        if (!msg.isProcessing && store.processingConversations[pongConvId]) {
          console.log(`[Pong] Agent says not processing for ${pongConvId}, clearing`);
          delete store.processingConversations[pongConvId];
          stopProcessingWatchdog(store, pongConvId);
          store.finishStreamingForConversation(pongConvId);
        }
      } else {
        // session-lost, cli-exited, agent-offline
        if (!store.sessionHealth) store.sessionHealth = {};
        store.sessionHealth[pongConvId] = { status: msg.status };
        // Clear processing state for terminal statuses
        if (msg.status === 'session-lost' || msg.status === 'cli-exited') {
          // Auto-refresh (prevent duplicate)
          if (!store._autoRefreshed) store._autoRefreshed = {};
          if (!store._autoRefreshed[pongConvId]) {
            store._autoRefreshed[pongConvId] = true;
            const conv = store.conversations.find(c => c.id === pongConvId);
            store.sendWsMessage({
              type: 'refresh_conversation',
              conversationId: pongConvId,
              agentId: conv?.agentId
            });
          }
          // Clear processing state
          delete store.processingConversations[pongConvId];
          stopProcessingWatchdog(store, pongConvId);
          store.finishStreamingForConversation(pongConvId);
        }
      }
      break;
    }

    case 'ask_user_question':
      if (msg.conversationId) {
        const tryLink = () => {
          const msgs = store.messagesMap[msg.conversationId] || [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].type === 'tool-use' && msgs[i].toolName === 'AskUserQuestion' && !msgs[i].askRequestId) {
              msgs[i].askRequestId = msg.requestId;
              msgs[i].askQuestions = msg.questions;
              return true;
            }
          }
          // Crew mode: msg.conversationId is the role's individual conversation ID,
          // but crewMessagesMap is keyed by session ID (e.g. crew_XXXXX).
          // Search all crew sessions to find the matching AskUserQuestion tool message.
          if (store.crewMessagesMap) {
            for (const crewMsgs of Object.values(store.crewMessagesMap)) {
              for (let i = crewMsgs.length - 1; i >= 0; i--) {
                if (crewMsgs[i].type === 'tool' && crewMsgs[i].toolName === 'AskUserQuestion' && !crewMsgs[i].askRequestId) {
                  crewMsgs[i].askRequestId = msg.requestId;
                  crewMsgs[i].askQuestions = msg.questions;
                  return true;
                }
              }
            }
          }
          return false;
        };
        if (!tryLink()) {
          let retries = 0;
          const retryInterval = setInterval(() => {
            retries++;
            if (tryLink() || retries >= 10) {
              clearInterval(retryInterval);
            }
          }, 200);
        }
      }
      break;

    case 'restart_agent_ack':
      console.log(`[Agent] Restart acknowledged by agent: ${msg.agentId}`);
      window.dispatchEvent(new CustomEvent('agent-restart-ack', { detail: { agentId: msg.agentId } }));
      break;

    case 'upgrade_agent_ack':
      console.log(`[Agent] Upgrade ${msg.success ? 'succeeded' : 'failed'} for agent: ${msg.agentId}`, msg.error || '');
      window.dispatchEvent(new CustomEvent('agent-upgrade-ack', { detail: { agentId: msg.agentId, success: msg.success, error: msg.error, alreadyLatest: msg.alreadyLatest, version: msg.version } }));
      break;

    // Workbench messages - forward to components
    case 'terminal_created':
    case 'terminal_output':
    case 'terminal_closed':
    case 'terminal_error':
    case 'file_content':
    case 'file_saved':
    case 'directory_listing':
    case 'git_status_result':
    case 'git_diff_result':
    case 'git_op_result':
    case 'file_op_result':
    case 'file_search_result':
      if (msg.type === 'file_content') console.log('[Store] Dispatching file_content workbench-message:', msg.type, msg.filePath);
      if (msg.type === 'directory_listing') console.log('[Store] Dispatching directory_listing workbench-message, convId:', msg.conversationId, 'entries:', msg.entries?.length);
      window.dispatchEvent(new CustomEvent('workbench-message', { detail: msg }));
      break;

    case 'server_updating':
      console.log('[WS] Server is updating, will reconnect automatically');
      store.connectionState = 'updating';
      break;

    case 'context_usage':
      store.contextUsage = {
        inputTokens: msg.inputTokens,
        maxTokens: msg.maxTokens,
        percentage: msg.percentage,
        conversationId: msg.conversationId
      };
      break;

    // MCP servers configuration (agent-level, for Settings > Tools tab)
    case 'mcp_servers_list':
    case 'mcp_config_updated':
      if (msg.agentId && msg.servers) {
        store.mcpServers[msg.agentId] = msg.servers;
      }
      break;

    // Expert roles definition from agent
    case 'expert_roles_list':
      if (msg.roles) {
        store.expertRoleDefinitions = msg.roles;
      }
      break;

    // LLM configuration from agent
    case 'llm_config':
    case 'llm_config_updated':
      if (msg.agentId) {
        store.llmConfig[msg.agentId] = {
          providers: msg.providers || [],
          primaryModel: msg.primaryModel || null,
          fastModel: msg.fastModel || null,
          language: msg.language || 'en',
          needsSetup: msg.needsSetup || false,
          error: msg.error || null,
          loaded: true
        };
      }
      break;

    // task-318: Unify runtime settings (thread cap + auto-archive days)
    case 'unify_settings':
    case 'unify_settings_updated':
      if (msg.agentId) {
        store.unifySettings[msg.agentId] = {
          maxConcurrentThreads: msg.maxConcurrentThreads ?? 6,
          autoArchiveIdleDays: msg.autoArchiveIdleDays ?? 30,
          error: msg.error || null,
          loaded: true,
          at: Date.now(),
        };
      }
      break;

    // Per-conversation MCP servers (from Claude CLI init)
    case 'conversation_mcp_update':
      if (msg.conversationId && msg.servers) {
        store.conversationMcpServers[msg.conversationId] = msg.servers;
      }
      if (msg.conversationId && msg.serverTools) {
        store.conversationMcpServerTools[msg.conversationId] = msg.serverTools;
      }
      break;

    // Crew (multi-agent) messages
    case 'crew_session_created':
    case 'crew_session_restored':
    case 'crew_output':
    case 'crew_status':
    case 'crew_routing':
    case 'crew_turn_completed':
    case 'crew_human_needed':
    case 'crew_message_queued':
    case 'crew_image':
    case 'crew_role_added':
    case 'crew_role_removed':
    case 'crew_session_cleared':
    case 'crew_role_error':
    case 'crew_history_loaded':
      store.handleCrewOutput(msg);
      break;

    // Crew session restore failed — reset refreshingSession flag
    case 'crew_session_restore_failed':
      console.warn('[Crew] Session restore failed:', msg.message);
      store.setRefreshingSession(msg.sessionId, false);
      clearRefreshTimeout(msg.sessionId);
      break;

    // /btw mode streaming
    case 'btw_stream':
      store.appendBtwDelta(msg.delta);
      break;

    case 'btw_done':
      store.btwLoading = false;
      if (msg.btwSessionId) store.btwSessionId = msg.btwSessionId;
      break;

    case 'btw_error': {
      // Append error as the last assistant message content
      const lastBtw = store.btwMessages[store.btwMessages.length - 1];
      if (lastBtw && lastBtw.role === 'assistant') {
        lastBtw.content = 'Error: ' + msg.error;
      }
      store.btwLoading = false;
      break;
    }

    // Background task tracking (legacy — kept for server compatibility)
    case 'background_task_started':
    case 'background_task_output':
      // No longer rendered in frontend — superseded by subagent_* events
      break;

    // Sub-Agent JSONL messages (real-time subagent tracking)
    case 'subagent_started':
      if (msg.conversationId && msg.subagentId) {
        store.addSubagent(msg.conversationId, {
          id: msg.subagentId,
          slug: msg.slug,
          type: msg.subagentType,
          description: msg.description,
          parentToolUseId: msg.parentToolUseId
        });
      }
      break;

    case 'subagent_message':
      if (msg.conversationId && msg.subagentId && msg.message) {
        store.appendSubagentMessage(msg.conversationId, msg.subagentId, msg.message);
      }
      break;

    case 'subagent_completed':
      if (msg.conversationId && msg.subagentId) {
        store.completeSubagent(msg.conversationId, msg.subagentId);
      }
      break;

  }
}
