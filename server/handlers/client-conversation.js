import { randomUUID } from 'crypto';
import { CONFIG } from '../config.js';
import { sessionDb, messageDb, userDb } from '../database.js';
import { agents, pendingFiles } from '../context.js';
import {
  sendToWebClient, forwardToAgent,
  broadcastAgentList, verifyConversationOwnership, verifyAgentOwnership
} from '../ws-utils.js';

/**
 * Handle conversation lifecycle messages from web client.
 * Types: get_agents, select_agent, create_conversation, resume_conversation,
 *        delete_conversation, select_conversation, sync_messages, chat,
 *        get_conversations, list_history_sessions, list_folders,
 *        cancel_execution, refresh_conversation,
 *        update_conversation_settings, ask_user_answer, btw_question
 */
export async function handleClientConversation(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    case 'get_agents':
      // 前端可能附带 conversationIds（server 重启后恢复场景）
      if (msg.conversationIds?.length > 0 && client.userId) {
        for (const convId of msg.conversationIds) {
          const dbSession = sessionDb.get(convId);
          if (!dbSession) continue;
          if (dbSession.user_id && dbSession.user_id !== client.userId && !CONFIG.skipAuth) continue;
          const agent = agents.get(dbSession.agent_id);
          if (!agent) continue;
          if (agent.conversations.has(convId)) continue;
          agent.conversations.set(convId, {
            id: convId,
            workDir: dbSession.work_dir,
            claudeSessionId: dbSession.claude_session_id,
            title: dbSession.title,
            createdAt: dbSession.created_at,
            userId: dbSession.user_id || client.userId,
            username: client.username,
            fromDb: true
          });
        }
      }
      // Restore all active sessions for this user from DB (cross-client sync)
      if (client.userId) {
        const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - TWO_DAYS_MS;
        const activeSessions = sessionDb.getActiveByUser(client.userId);
        for (const dbSession of activeSessions) {
          // Pinned sessions never auto-expire
          if (dbSession.is_pinned) {
            // Still need to restore pinned sessions to agent memory
          } else if (dbSession.updated_at < cutoff) {
            // Auto-deactivate stale sessions (not updated in 2 days)
            try { sessionDb.setActive(dbSession.id, false); } catch (e) { /* ignore */ }
            continue;
          }
          const agent = agents.get(dbSession.agent_id);
          if (!agent) continue;
          if (agent.conversations.has(dbSession.id)) continue;
          // For sessions with user_id IS NULL: only restore if agent belongs to this user
          // or skipAuth is enabled (prevents leaking orphan sessions to wrong users)
          if (!dbSession.user_id && !CONFIG.skipAuth && agent.ownerId !== client.userId) continue;
          agent.conversations.set(dbSession.id, {
            id: dbSession.id,
            workDir: dbSession.work_dir,
            claudeSessionId: dbSession.claude_session_id,
            title: dbSession.title,
            createdAt: dbSession.created_at,
            userId: dbSession.user_id || client.userId,
            username: client.username,
            fromDb: true
          });
        }
      }
      await broadcastAgentList();
      break;

    case 'select_agent': {
      if (!await checkAgentAccess(msg.agentId)) break;
      const agent = agents.get(msg.agentId);
      if (agent && agent.ws.readyState === 1 /* WebSocket.OPEN */) {
        client.currentAgent = msg.agentId;
        if (!msg.silent) {
          client.currentConversation = null;
        }

        if (msg.silent) break;

        const filteredConvs = Array.from(agent.conversations.values()).filter(c =>
          CONFIG.skipAuth || !c.userId || c.userId === client.userId
        ).map(c => {
          if (!c.title) {
            const dbSession = sessionDb.get(c.id);
            if (dbSession?.title) c.title = dbSession.title;
          }
          return c;
        });
        await sendToWebClient(client, {
          type: 'agent_selected',
          agentId: msg.agentId,
          agentName: agent.name,
          workDir: agent.workDir,
          capabilities: agent.capabilities || ['terminal', 'file_editor', 'background_tasks'],
          conversations: filteredConvs,
          slashCommands: agent.slashCommands || [],
          slashCommandDescriptions: agent.slashCommandDescriptions || {}
        });

        // If slash commands cache is empty, ask Agent to reload from filesystem
        if (!agent.slashCommands?.length) {
          await forwardToAgent(msg.agentId, { type: 'request_slash_commands' });
        }
      } else {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found or offline' });
      }
      break;
    }

    case 'create_conversation': {
      const createAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(createAgentId)) return;
      const createAgent = agents.get(createAgentId);
      if (!createAgent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        return;
      }
      if (createAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }
      client.currentAgent = createAgentId;
      await forwardToAgent(createAgentId, {
        type: 'create_conversation',
        conversationId: msg.conversationId || randomUUID(),
        workDir: msg.workDir,
        userId: client.userId,
        username: client.username,
        disallowedTools: msg.disallowedTools
      });
      break;
    }

    case 'resume_conversation': {
      const resumeAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(resumeAgentId)) return;
      const resumeAgent = agents.get(resumeAgentId);
      if (!resumeAgent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        return;
      }
      if (resumeAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }
      client.currentAgent = resumeAgentId;
      await forwardToAgent(resumeAgentId, {
        type: 'resume_conversation',
        conversationId: msg.conversationId || randomUUID(),
        claudeSessionId: msg.claudeSessionId,
        workDir: msg.workDir,
        userId: client.userId,
        username: client.username,
        disallowedTools: msg.disallowedTools
      });
      break;
    }

    case 'delete_conversation': {
      if (!client.currentAgent) return;

      // ★ DB cleanup: always execute regardless of agent online status
      // Use verifyConversationOwnership (checks DB) instead of checkAgentAccess (requires agent in memory)
      // This ensures close/delete works even when the agent is offline
      if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId)) {
        console.warn(`[Security] User ${client.userId} attempted to delete conversation ${msg.conversationId} they don't own`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }

      // Always deactivate in DB — this is the critical fix
      try {
        sessionDb.setActive(msg.conversationId, false);
      } catch (e) {
        console.error('Failed to deactivate session in database:', e.message);
      }

      // Remove from agent's in-memory conversations (if agent is online)
      const deleteAgent = agents.get(client.currentAgent);
      if (deleteAgent) {
        deleteAgent.conversations.delete(msg.conversationId);
      }
      await broadcastAgentList();

      // Forward to agent for resource cleanup (terminals, processes, etc.) — best effort
      // Only attempt if agent is online with an open WebSocket
      if (deleteAgent?.ws?.readyState === 1) {
        await forwardToAgent(client.currentAgent, {
          type: 'delete_conversation',
          conversationId: msg.conversationId
        });
      }
      break;
    }

    case 'select_conversation':
      if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId)) {
        console.warn(`[Security] User ${client.userId} attempted to select conversation ${msg.conversationId} they don't own`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      client.currentConversation = msg.conversationId;
      await sendToWebClient(client, {
        type: 'conversation_selected',
        conversationId: msg.conversationId
      });
      break;

    case 'pin_session':
    case 'unpin_session': {
      const pinConvId = msg.conversationId;
      if (!pinConvId) break;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(pinConvId, client.userId)) break;
      const isPinned = msg.type === 'pin_session';
      try {
        sessionDb.setPinned(pinConvId, isPinned);
        // If pinning, also ensure session is active (reactivate if it was auto-deactivated)
        if (isPinned) sessionDb.setActive(pinConvId, true);
      } catch (e) { /* ignore */ }
      await sendToWebClient(client, { type: 'session_pinned', conversationId: pinConvId, pinned: isPinned });
      break;
    }

    case 'sync_messages':
      if (msg.conversationId) {
        if (!CONFIG.skipAuth && !verifyConversationOwnership(msg.conversationId, client.userId)) {
          console.warn(`[Security] User ${client.userId} attempted to sync messages for conversation ${msg.conversationId} they don't own`);
          return;
        }
        try {
          let messages, hasMore;

          if (msg.turns) {
            if (msg.beforeId) {
              const result = messageDb.getTurnsBeforeId(msg.conversationId, msg.beforeId, msg.turns);
              messages = result.messages;
              hasMore = result.hasMore;
            } else {
              const result = messageDb.getRecentTurns(msg.conversationId, msg.turns);
              messages = result.messages;
              hasMore = result.hasMore;
            }
          } else {
            const limit = msg.limit || 100;
            if (msg.beforeId) {
              messages = messageDb.getBeforeId(msg.conversationId, msg.beforeId, limit);
            } else if (msg.afterMessageId) {
              messages = messageDb.getAfterId(msg.conversationId, msg.afterMessageId);
            } else {
              messages = messageDb.getRecent(msg.conversationId, limit);
            }
            const oldestId = messages.length > 0 ? messages[0].id : null;
            hasMore = oldestId ? messageDb.getBeforeId(msg.conversationId, oldestId, 1).length > 0 : false;
          }

          const total = messageDb.getCount(msg.conversationId);
          console.log(`[sync_messages] Found ${messages.length} messages (total=${total}, hasMore=${hasMore})`);
          await sendToWebClient(client, {
            type: 'sync_messages_result',
            conversationId: msg.conversationId,
            messages,
            hasMore,
            total
          });
        } catch (e) {
          console.error('Failed to sync messages:', e.message);
        }
      }
      break;

    case 'chat': {
      // Support explicit conversationId for multi-column mode
      const convId = msg.conversationId || client.currentConversation;
      if (!convId) {
        await sendToWebClient(client, { type: 'error', message: 'No conversation selected' });
        return;
      }

      // Ownership check when explicit conversationId is provided
      if (msg.conversationId && !CONFIG.skipAuth) {
        if (!verifyConversationOwnership(msg.conversationId, client.userId)) {
          await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
          return;
        }
      }

      // Find the agent that owns this conversation
      let chatAgentId = client.currentAgent;
      let chatAgent = agents.get(chatAgentId);
      let convInfo = chatAgent?.conversations.get(convId);

      // If conversation not found on current agent, search all agents
      if (!convInfo && msg.conversationId) {
        for (const [agentId, agent] of agents) {
          if (agent.conversations.has(convId)) {
            chatAgentId = agentId;
            chatAgent = agent;
            convInfo = agent.conversations.get(convId);
            break;
          }
        }
      }

      if (!chatAgentId || !chatAgent) {
        await sendToWebClient(client, { type: 'error', message: 'No agent available' });
        return;
      }

      if (!await checkAgentAccess(chatAgentId)) return;

      if (chatAgent.status === 'syncing') {
        await sendToWebClient(client, { type: 'error', message: 'Agent is still syncing, please wait...' });
        return;
      }

      // 处理附件
      const fileIds = msg.fileIds || [];
      let resolvedFiles = [];
      if (fileIds.length > 0) {
        for (const fileId of fileIds) {
          const file = pendingFiles.get(fileId);
          if (file && (!file.userId || CONFIG.skipAuth || file.userId === client.userId)) {
            resolvedFiles.push({
              name: file.name,
              mimeType: file.mimeType,
              data: file.buffer.toString('base64')
            });
            pendingFiles.delete(fileId);
          } else if (file && file.userId !== client.userId) {
            console.warn(`[Security] User ${client.userId} attempted to use file ${fileId} owned by ${file.userId}`);
          }
        }
      }

      if (convInfo) convInfo.processing = true;

      // 暂存 expertSelections 供 agent-output 保存 user 消息时使用
      if (msg.expertSelections?.length > 0 && convInfo) {
        convInfo._pendingExperts = msg.expertSelections;
      }

      // 用用户输入的 prompt 更新会话标题（跳过用户自定义标题的会话）
      if (msg.prompt && msg.prompt.trim() && !(convInfo?.customTitle)) {
        const title = msg.prompt.trim().substring(0, 100);
        sessionDb.update(convId, { title });
        if (convInfo) convInfo.title = title;
      }

      if (resolvedFiles.length > 0) {
        await forwardToAgent(chatAgentId, {
          type: 'transfer_files',
          conversationId: convId,
          files: resolvedFiles,
          prompt: msg.prompt,
          workDir: msg.workDir || convInfo?.workDir,
          claudeSessionId: convInfo?.claudeSessionId,
          targetRole: msg.targetRole || null,
          expertSelections: msg.expertSelections || null
        });
      } else {
        await forwardToAgent(chatAgentId, {
          type: 'execute',
          conversationId: convId,
          prompt: msg.prompt,
          workDir: msg.workDir || convInfo?.workDir,
          claudeSessionId: convInfo?.claudeSessionId,
          targetRole: msg.targetRole || null,
          expertSelections: msg.expertSelections || null
        });
      }
      break;
    }

    case 'get_conversations':
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      await forwardToAgent(client.currentAgent, { type: 'get_conversations' });
      break;

    case 'list_history_sessions': {
      const historyAgentId = msg.agentId || client.currentAgent;
      if (!historyAgentId) return;
      if (!await checkAgentAccess(historyAgentId)) return;
      await forwardToAgent(historyAgentId, {
        type: 'list_history_sessions',
        workDir: msg.workDir,
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'list_folders': {
      const foldersAgentId = msg.agentId || client.currentAgent;
      if (!foldersAgentId) return;
      if (!await checkAgentAccess(foldersAgentId)) return;
      await forwardToAgent(foldersAgentId, {
        type: 'list_folders',
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'check_crew_context': {
      const crewCtxAgentId = msg.agentId || client.currentAgent;
      if (!crewCtxAgentId) return;
      if (!await checkAgentAccess(crewCtxAgentId)) return;
      await forwardToAgent(crewCtxAgentId, {
        type: 'check_crew_context',
        projectDir: msg.projectDir,
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'cancel_execution': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const cancelConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(cancelConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} cancel denied for ${cancelConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(client.currentAgent, {
        type: 'cancel_execution',
        conversationId: cancelConvId
      });
      break;
    }

    case 'refresh_conversation': {
      const refreshAgent = msg.agentId || client.currentAgent;
      if (!refreshAgent) return;
      if (!await checkAgentAccess(refreshAgent)) return;
      const refreshConvId = msg.conversationId || client.currentConversation;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(refreshConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} refresh denied for ${refreshConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      await forwardToAgent(refreshAgent, {
        type: 'refresh_conversation',
        conversationId: refreshConvId,
        clientId
      });
      break;
    }

    case 'ping_session': {
      const pingAgent = msg.agentId || client.currentAgent;
      const pingConvId = msg.conversationId;
      if (!pingAgent || !pingConvId) return;
      // Check agent is online first — if not, reply directly
      const pingAgentObj = agents.get(pingAgent);
      if (!pingAgentObj || !pingAgentObj.ws || pingAgentObj.ws.readyState !== 1) {
        await sendToWebClient(client, {
          type: 'pong_session',
          conversationId: pingConvId,
          status: 'agent-offline'
        });
        return;
      }
      // Old agent doesn't support ping_session — reply unsupported
      if (!pingAgentObj.capabilities?.includes('ping_session')) {
        await sendToWebClient(client, {
          type: 'pong_session',
          conversationId: pingConvId,
          status: 'unsupported'
        });
        return;
      }
      await forwardToAgent(pingAgent, {
        type: 'ping_session',
        conversationId: pingConvId,
        clientId
      });
      break;
    }

    case 'update_conversation_settings': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const settingsConvId = msg.conversationId || client.currentConversation;
      if (!settingsConvId) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(settingsConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} settings update denied for ${settingsConvId}`);
        await sendToWebClient(client, { type: 'error', message: 'Permission denied' });
        return;
      }
      // Handle custom title (server-local, no agent forwarding needed)
      if (msg.title !== undefined) {
        const titleAgent = agents.get(client.currentAgent);
        const titleConvInfo = titleAgent?.conversations.get(settingsConvId);
        if (msg.title) {
          sessionDb.update(settingsConvId, { title: msg.title });
          if (titleConvInfo) { titleConvInfo.title = msg.title; titleConvInfo.customTitle = true; }
        } else {
          if (titleConvInfo) { titleConvInfo.customTitle = false; }
        }
      }
      // Only forward to agent if disallowedTools present
      if (msg.disallowedTools) {
        await forwardToAgent(client.currentAgent, {
          type: 'update_conversation_settings',
          conversationId: settingsConvId,
          disallowedTools: msg.disallowedTools
        });
      }
      break;
    }

    case 'ask_user_answer': {
      if (!client.currentAgent) return;
      if (!await checkAgentAccess(client.currentAgent)) return;
      const answerConvId = msg.conversationId || client.currentConversation;
      if (!answerConvId) return;
      if (!CONFIG.skipAuth && !verifyConversationOwnership(answerConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} ask_user_answer denied for ${answerConvId}`);
        return;
      }
      await forwardToAgent(client.currentAgent, {
        type: 'ask_user_answer',
        conversationId: answerConvId,
        requestId: msg.requestId,
        answers: msg.answers
      });
      // Persist answered state into the AskUserQuestion tool_use DB record
      try {
        if (answerConvId && msg.requestId) {
          const recent = messageDb.getRecent(answerConvId, 100);
          // Search from newest to oldest for the matching requestId
          let askMsg = null;
          for (let i = recent.length - 1; i >= 0; i--) {
            const m = recent[i];
            if (m.message_type !== 'tool_use' || m.tool_name !== 'AskUserQuestion') continue;
            if (!m.metadata) continue;
            try {
              const meta = JSON.parse(m.metadata);
              if (meta.askRequestId === msg.requestId) { askMsg = m; break; }
            } catch { /* skip */ }
          }
          if (askMsg) {
            const meta = JSON.parse(askMsg.metadata);
            messageDb.updateMetadata(askMsg.id, JSON.stringify({
              ...meta,
              askAnswered: true,
              selectedAnswers: msg.answers
            }));
          }
        }
      } catch (e) {
        // Silent — don't block the main flow
      }
      break;
    }

    case 'btw_question': {
      if (!client.currentAgent) {
        await sendToWebClient(client, { type: 'btw_error', error: 'No agent selected' });
        return;
      }
      if (!await checkAgentAccess(client.currentAgent)) return;
      const btwConvId = msg.conversationId || client.currentConversation;
      if (!btwConvId) {
        await sendToWebClient(client, { type: 'btw_error', error: 'No conversation selected' });
        return;
      }
      if (!CONFIG.skipAuth && !verifyConversationOwnership(btwConvId, client.userId)) {
        console.warn(`[Security] User ${client.userId} btw_question denied for ${btwConvId}`);
        await sendToWebClient(client, { type: 'btw_error', conversationId: btwConvId, error: 'Permission denied' });
        return;
      }
      await forwardToAgent(client.currentAgent, {
        type: 'btw_question',
        conversationId: btwConvId,
        question: msg.question,
        btwSessionId: msg.btwSessionId || null
      });
      break;
    }

    case 'unify_chat': {
      const unifyAgentId = msg.agentId || client.currentAgent;
      if (!unifyAgentId) {
        await sendToWebClient(client, { type: 'error', message: 'No agent selected' });
        return;
      }
      if (!await checkAgentAccess(unifyAgentId)) return;
      await forwardToAgent(unifyAgentId, {
        type: 'unify_chat',
        prompt: msg.prompt,
        userId: client.userId,
        username: client.username
      });
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
