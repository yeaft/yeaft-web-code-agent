import { randomUUID } from 'crypto';
import { sessionDb } from '../database.js';
import { previewFiles } from '../context.js';
import {
  broadcastAgentList, notifyConversationUpdate, forwardToClients
} from '../ws-utils.js';

/**
 * Handle Crew (multi-agent) messages from agent.
 * Types: crew_session_created, crew_session_restored, crew_output,
 *        crew_image, crew_status, crew_turn_completed, crew_human_needed,
 *        crew_role_added, crew_role_removed, crew_sessions_list,
 *        crew_exists_result, crew_history_loaded
 */
export async function handleAgentCrew(agentId, agent, msg) {
  switch (msg.type) {
    case 'crew_session_created': {
      // 在 agent 的 conversations 中注册 crew session（复用现有转发机制）
      const crewUserId = msg.userId || agent.ownerId || null;
      const crewUsername = msg.username || agent.ownerUsername || null;
      agent.conversations.set(msg.sessionId, {
        id: msg.sessionId,
        name: msg.name || '',
        workDir: msg.projectDir,
        userId: crewUserId,
        username: crewUsername,
        createdAt: Date.now(),
        processing: true,
        type: 'crew',
        roles: msg.roles
      });
      // 持久化到 sessionDb
      try {
        if (!sessionDb.exists(msg.sessionId)) {
          sessionDb.create(msg.sessionId, agentId, agent.name, msg.projectDir, null, msg.name || null, crewUserId);
        }
      } catch (e) {
        console.error('Failed to save crew session to database:', e.message);
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      await broadcastAgentList();
      break;
    }

    case 'crew_session_restored': {
      // 恢复时重新注册到 agent.conversations（server 可能重启过）
      const restoreUserId = msg.userId || agent.ownerId || null;
      const restoreUsername = msg.username || agent.ownerUsername || null;
      if (!agent.conversations.has(msg.sessionId)) {
        agent.conversations.set(msg.sessionId, {
          id: msg.sessionId,
          name: msg.name || '',
          workDir: msg.projectDir,
          userId: restoreUserId,
          username: restoreUsername,
          createdAt: Date.now(),
          processing: true,
          type: 'crew',
          roles: msg.roles
        });
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'crew_output':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_image': {
      // Size check
      const dataSize = msg.data ? Buffer.byteLength(msg.data, 'base64') : 0;
      if (dataSize > 10 * 1024 * 1024) {
        console.warn(`[Server] Crew image too large: ${dataSize} bytes, skipping`);
        break;
      }
      const fileId = randomUUID();
      const token = randomUUID();
      previewFiles.set(fileId, {
        buffer: Buffer.from(msg.data, 'base64'),
        mimeType: msg.mimeType,
        filename: `crew-${msg.role}-${Date.now()}.${(msg.mimeType || 'image/png').split('/')[1] || 'png'}`,
        createdAt: Date.now(),
        token
      });
      await forwardToClients(agentId, msg.sessionId, {
        type: 'crew_image',
        sessionId: msg.sessionId,
        role: msg.role,
        roleIcon: msg.roleIcon,
        roleName: msg.roleName,
        toolId: msg.toolId,
        fileId,
        previewToken: token,
        mimeType: msg.mimeType,
        taskId: msg.taskId,
        taskTitle: msg.taskTitle
      });
      console.log(`[Server] Cached crew image: fileId=${fileId}, role=${msg.role}, mime=${msg.mimeType}`);
      break;
    }

    case 'crew_status': {
      // Update conversation processing state based on crew session status
      const crewConv = agent.conversations.get(msg.sessionId);
      if (crewConv && (msg.status === 'stopped' || msg.status === 'completed')) {
        crewConv.processing = false;
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'crew_turn_completed':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_human_needed':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_role_added':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_role_removed':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'crew_sessions_list':
      // 定向转发给请求者（参照 folders_list）
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'crew_exists_result':
      // 定向转发给请求者
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'crew_history_loaded':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    default:
      return false; // Not handled
  }
  return true; // Handled
}
