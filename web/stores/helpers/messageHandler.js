/**
 * Message handler — thin switch dispatcher.
 * Delegates to sub-handlers for complex message types.
 */

import { useAuthStore } from '../auth.js';
import { decodeKey } from '../../utils/encryption.js';
import { t } from '../../utils/i18n.js';
import { stopProcessingWatchdog } from './watchdog.js';
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
      store.currentConversation = msg.conversationId;
      {
        const conv = store.conversations.find(c => c.id === msg.conversationId);
        if (conv) {
          store.currentWorkDir = conv.workDir;
        }
      }
      store.messages = [];
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

    case 'error': {
      const errorConvId = msg.conversationId || store.currentConversation;
      const isSystemError = ['Permission denied', 'Agent not found', 'No conversation selected', 'Agent is still syncing', 'Agent access denied'].some(
        s => msg.message?.includes(s)
      );
      if (msg.message?.includes('Agent is still syncing') || msg.message?.includes('Agent not found')) {
        clearSessionLoading(store);
      }
      const errorId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      store.addMessageToConversation(errorConvId, {
        type: 'error',
        content: msg.message,
        transient: isSystemError,
        dbMessageId: isSystemError ? ('err_' + errorId) : undefined
      });
      if (isSystemError && errorConvId) {
        const convId = errorConvId;
        const errMsgId = 'err_' + errorId;
        setTimeout(() => {
          if (store.currentConversation === convId) {
            const idx = store.messages.findIndex(m => m.id === errMsgId);
            if (idx >= 0) {
              store.messages.splice(idx, 1);
            }
          } else {
            const cached = store.messagesCache[convId];
            if (cached) {
              const idx = cached.findIndex(m => m.id === errMsgId);
              if (idx >= 0) {
                cached.splice(idx, 1);
              }
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

    case 'execution_cancelled':
      handleExecutionCancelled(store, msg);
      break;

    case 'slash_commands_update':
      if (msg.slashCommands && msg.slashCommands.length > 0 && msg.conversationId) {
        store.slashCommandsMap[msg.conversationId] = msg.slashCommands;
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

    case 'ask_user_question':
      if (msg.conversationId) {
        const tryLink = () => {
          const msgs = msg.conversationId === store.currentConversation
            ? store.messages
            : (store.messagesCache[msg.conversationId] || []);
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
      store.refreshingSession = false;
      clearRefreshTimeout();
      break;

    // /btw side question streaming
    case 'btw_stream':
      store.appendBtwDelta(msg.delta);
      break;

    case 'btw_done':
      store.btwLoading = false;
      break;

    case 'btw_error':
      store.btwAnswer = 'Error: ' + msg.error;
      store.btwLoading = false;
      break;

  }
}
