import { sessionDb, messageDb } from '../database.js';
import {
  broadcastAgentList, notifyConversationUpdate, forwardToClients
} from '../ws-utils.js';
import { agents } from '../context.js';
import { CONFIG } from '../config.js';

/**
 * Handle conversation lifecycle messages from agent.
 * Types: conversation_list, conversation_created, conversation_resumed,
 *        session_id_update, turn_completed, conversation_closed,
 *        conversation_deleted, history_sessions_list, folders_list,
 *        conversation_refresh, conversation_settings_updated
 */
export async function handleAgentConversation(agentId, agent, msg) {
  switch (msg.type) {
    case 'conversation_list': {
      // Agent 发送的 conversation 列表 - 合并而非覆盖，保留已有的 userId/username
      const incomingIds = new Set(msg.conversations.map(c => c.id));
      for (const [id, conv] of agent.conversations) {
        // 保留从 DB 恢复的历史 conversations（agent 不会上报已完成的会话）
        if (!incomingIds.has(id) && !conv.fromDb) {
          agent.conversations.delete(id);
        }
      }
      for (const conv of msg.conversations) {
        // fix-session-dup: if the DB says this conv now belongs to a
        // DIFFERENT agent (the user resumed it elsewhere), drop the
        // agent's stale local copy. Without this guard, an agent
        // restart can re-broadcast a transferred conv under its own
        // banner, undoing the resume-time transfer and recreating
        // the "same conv on two agents" condition.
        const dbForConv = sessionDb.get(conv.id);
        if (dbForConv && dbForConv.agent_id && dbForConv.agent_id !== agentId) {
          if (CONFIG.debug) {
            console.log(`[conversation_list] dropping conv ${conv.id} from agent ${agentId} — DB owner is ${dbForConv.agent_id}`);
          }
          agent.conversations.delete(conv.id);
          continue;
        }
        const existing = agent.conversations.get(conv.id);
        if (existing) {
          // 原地更新属性而非替换对象，避免其他持有旧引用的代码失效
          existing.workDir = conv.workDir || existing.workDir;
          existing.claudeSessionId = conv.claudeSessionId || existing.claudeSessionId;
          existing.createdAt = conv.createdAt || existing.createdAt;
          if (conv.processing !== undefined) existing.processing = conv.processing;
          // Agent 主动上报了这个 conversation，清除 DB 恢复标记
          delete existing.fromDb;
          // 保留 crew 相关字段
          if (conv.type) existing.type = conv.type;
          // Security: 不信任 agent 上报的 userId/username，保留 server 端已有值
          if (!existing.userId) {
            const dbSession = sessionDb.get(conv.id);
            existing.userId = dbSession?.user_id || agent.ownerId || null;
            existing.username = dbSession?.username || agent.ownerUsername || null;
          }
          // fix-chat-title-sticky: hydrate the persisted title +
          // sticky-bit on every list refresh. The agent doesn't track
          // titles, so without this the in-memory `convInfo.customTitle`
          // is stuck at `undefined` and the per-message auto-title write
          // happily overwrites the user's renamed title.
          if (existing.customTitle === undefined) {
            const dbSession = sessionDb.get(conv.id);
            if (dbSession) {
              if (dbSession.title) existing.title = dbSession.title;
              existing.customTitle = !!dbSession.customTitle;
            }
          }
        } else {
          // 新 conversation — 从 DB 或 agent.ownerId 获取 userId，不信任 agent 上报
          const dbSession = sessionDb.get(conv.id);
          const trustedUserId = dbSession?.user_id || agent.ownerId || null;
          const trustedUsername = dbSession?.username || agent.ownerUsername || null;
          agent.conversations.set(conv.id, {
            ...conv,
            userId: trustedUserId,
            username: trustedUsername,
            // Hydrate sticky title bits if the DB has them.
            title: dbSession?.title || conv.title || null,
            customTitle: !!dbSession?.customTitle,
          });
        }
      }
      await broadcastAgentList();
      break;
    }

    case 'conversation_created':
    case 'conversation_resumed': {
      // 清理同 claudeSessionId 的旧条目（避免重复恢复同一个 session 累积）
      if (msg.type === 'conversation_resumed' && msg.claudeSessionId) {
        for (const [id, conv] of agent.conversations) {
          if (id !== msg.conversationId && conv.claudeSessionId === msg.claudeSessionId) {
            agent.conversations.delete(id);
          }
        }
      }

      // fix-session-dup: if this conv is currently held in another
      // agent's in-memory Map (e.g. user resumed it against a
      // different machine after the original agent went offline),
      // remove the stale copy AND re-point the DB row at the new
      // owner. Without this:
      //   1) the next get_agents restore would re-seat the conv
      //      under the OLD agent's Map again from DB.agent_id,
      //   2) the next broadcastAgentList would expose the conv
      //      via two different agent entries, producing the
      //      "one conversation, two sidebar rows with different
      //      badges" symptom this fix targets.
      // We only run the transfer when the OWNER actually changes —
      // resuming a conv on its own agent is a no-op for ownership.
      for (const [otherAgentId, otherAgent] of agents) {
        if (otherAgentId === agentId) continue;
        if (otherAgent.conversations.has(msg.conversationId)) {
          if (CONFIG.debug) {
            console.log(`[conversation_resumed] transferring conv ${msg.conversationId} from agent ${otherAgentId} → ${agentId}`);
          }
          otherAgent.conversations.delete(msg.conversationId);
        }
      }

      // Security: 使用 server 端可信来源的 userId，不信任 agent 回传
      const existingConvData = agent.conversations.get(msg.conversationId);
      const dbSessionData = sessionDb.get(msg.conversationId);
      const trustedUserId = existingConvData?.userId || dbSessionData?.user_id || agent.ownerId || msg.userId || null;
      const trustedUsername = existingConvData?.username || dbSessionData?.username || agent.ownerUsername || msg.username || null;

      agent.conversations.set(msg.conversationId, {
        id: msg.conversationId,
        workDir: msg.workDir,
        claudeSessionId: msg.claudeSessionId,
        userId: trustedUserId,
        username: trustedUsername,
        // fix-chat-title-sticky: hydrate the persisted title + sticky-bit
        // from the DB on resume/recreate. Without this, a user-renamed
        // session that's been resumed has `customTitle = undefined`,
        // so the next user prompt overwrites the title.
        //
        // The OR-merge (`existing || db`) is deliberate: the in-memory
        // value is fresher than the DB on the rare race where
        // update_conversation_settings has just cleared the bit but the
        // resume payload arrived from the agent before that write
        // settled. Both sources move in lockstep on rename and clear,
        // so they cannot disagree for long.
        title: dbSessionData?.title || existingConvData?.title || null,
        customTitle: !!(existingConvData?.customTitle || dbSessionData?.customTitle),
        createdAt: Date.now(),
        processing: false
      });
      try {
        if (msg.type === 'conversation_created') {
          if (!sessionDb.exists(msg.conversationId)) {
            sessionDb.create(msg.conversationId, agentId, agent.name, msg.workDir, msg.claudeSessionId, null, trustedUserId);
          }
        } else {
          if (sessionDb.exists(msg.conversationId)) {
            sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
            // fix-session-dup: also re-point the persisted agent_id
            // to the resuming agent when ownership actually changed.
            // The DB row is the source of truth that the `get_agents`
            // restore path consults, so failing to update it would
            // re-summon the duplicate on the next reload.
            if (dbSessionData && dbSessionData.agent_id !== agentId) {
              if (CONFIG.debug) {
                console.log(`[conversation_resumed] DB.agent_id ${dbSessionData.agent_id} → ${agentId} for ${msg.conversationId}`);
              }
              sessionDb.setAgent(msg.conversationId, agentId, agent.name);
            }
          } else {
            sessionDb.create(msg.conversationId, agentId, agent.name, msg.workDir, msg.claudeSessionId, null, trustedUserId);
          }
        }
        sessionDb.setActive(msg.conversationId, true);
      } catch (e) {
        console.error('Failed to save session to database:', e.message);
      }
      // Security: 覆盖 msg 中的 userId 为可信值
      msg.userId = trustedUserId;
      msg.username = trustedUsername;

      // Phase 6.1: 将 historyMessages 同步到 DB（支持增量 merge）
      if (msg.type === 'conversation_resumed' && msg.historyMessages && msg.historyMessages.length > 0) {
        try {
          const insertedCount = messageDb.bulkAddHistory(msg.conversationId, msg.historyMessages);
          if (insertedCount > 0) {
            console.log(`[conversation_resumed] Synced ${insertedCount} new messages to DB for ${msg.conversationId}`);
          }
        } catch (e) {
          console.error('Failed to sync history to DB:', e.message);
        }
        // 从 DB 读取最后 5 turns 发给前端
        const { messages: recentMessages, hasMore } = messageDb.getRecentTurns(msg.conversationId, 5);
        delete msg.historyMessages;
        msg.dbMessages = recentMessages;
        msg.hasMoreMessages = hasMore;
      }
      msg.dbMessageCount = messageDb.getCount(msg.conversationId);

      await notifyConversationUpdate(agentId, msg);
      await broadcastAgentList();
      break;
    }

    case 'session_id_update':
      if (msg.conversationId && msg.claudeSessionId) {
        const existingConv = agent.conversations.get(msg.conversationId);
        if (existingConv) {
          existingConv.claudeSessionId = msg.claudeSessionId;
        }
        try {
          sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
          console.log(`[session_id_update] Updated claudeSessionId for ${msg.conversationId}: ${msg.claudeSessionId}`);
        } catch (e) {
          console.error('Failed to update claudeSessionId in database:', e.message);
        }
      }
      await broadcastAgentList();
      break;

    case 'turn_completed':
      {
        const turnConv = agent.conversations.get(msg.conversationId);
        // Guard: 如果 processing 已为 false，说明是重复的 turn_completed，跳过
        if (turnConv && !turnConv.processing) {
          console.warn(`[turn_completed] Ignoring duplicate for ${msg.conversationId}`);
          break;
        }
        if (turnConv) {
          turnConv.processing = false;
          if (msg.claudeSessionId) {
            turnConv.claudeSessionId = msg.claudeSessionId;
          }
          if (msg.workDir) {
            turnConv.workDir = msg.workDir;
          }
        }
        try {
          if (msg.claudeSessionId) {
            sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
          }
        } catch (e) {
          console.error('Failed to update session in database:', e.message);
        }
        await forwardToClients(agentId, msg.conversationId, {
          type: 'turn_completed',
          conversationId: msg.conversationId,
          claudeSessionId: msg.claudeSessionId,
          workDir: msg.workDir
        });

        await broadcastAgentList();
      }
      break;

    case 'conversation_closed':
      {
        const closedConv = agent.conversations.get(msg.conversationId);
        if (closedConv) {
          closedConv.processing = false;
          if (msg.claudeSessionId) {
            closedConv.claudeSessionId = msg.claudeSessionId;
          }
          if (msg.workDir) {
            closedConv.workDir = msg.workDir;
          }
        }
        try {
          sessionDb.setActive(msg.conversationId, false);
          if (msg.claudeSessionId) {
            sessionDb.update(msg.conversationId, { claudeSessionId: msg.claudeSessionId });
          }
        } catch (e) {
          console.error('Failed to update session in database:', e.message);
        }
        await forwardToClients(agentId, msg.conversationId, {
          type: 'conversation_closed',
          conversationId: msg.conversationId,
          claudeSessionId: msg.claudeSessionId,
          workDir: msg.workDir
        });

        // ★ Remove from agent's in-memory conversations after marking inactive in DB.
        // This prevents closed sessions from accumulating in agent_list broadcasts
        // and reappearing in the sidebar. Session can be restored from DB if needed.
        agent.conversations.delete(msg.conversationId);

        await broadcastAgentList();
      }
      break;

    case 'conversation_deleted':
      agent.conversations.delete(msg.conversationId);
      try {
        sessionDb.setActive(msg.conversationId, false);
      } catch (e) {
        console.error('Failed to update session in database:', e.message);
      }
      await notifyConversationUpdate(agentId, msg);
      await broadcastAgentList();
      break;

    case 'history_sessions_list':
    case 'folders_list':
    case 'models_list':
    case 'crew_context_result':
      console.log(`[${msg.type}] Received from agent ${agentId}, forwarding to clients...`);
      console.log(`[${msg.type}] count: folders=${msg.folders?.length || 0} models=${msg.models?.length || 0} sessions=${msg.sessions?.length || 0}`);
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'conversation_refresh':
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'conversation_settings_updated':
      await forwardToClients(agentId, msg.conversationId, msg);
      break;

    default:
      return false; // Not handled
  }
  return true; // Handled
}
