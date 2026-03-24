import { randomUUID } from 'crypto';
import { CONFIG } from '../config.js';
import { agents, pendingFiles } from '../context.js';
import { sendToWebClient, forwardToAgent, broadcastAgentList } from '../ws-utils.js';

/**
 * Handle Crew (multi-agent) messages from web client.
 * Types: create_crew_session, crew_human_input, crew_control,
 *        crew_add_role, crew_remove_role, list_crew_sessions,
 *        check_crew_exists, delete_crew_dir, resume_crew_session,
 *        update_crew_session, delete_crew_session, crew_load_history
 */
export async function handleClientCrew(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    case 'create_crew_session': {
      const crewAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(crewAgentId)) break;
      const crewAgent = agents.get(crewAgentId);
      if (!crewAgent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        break;
      }
      client.currentAgent = crewAgentId;
      await forwardToAgent(crewAgentId, {
        type: 'create_crew_session',
        sessionId: msg.sessionId || randomUUID(),
        projectDir: msg.projectDir,
        sharedDir: msg.sharedDir,
        name: msg.name || '',
        roles: msg.roles,
        teamType: msg.teamType || 'dev',
        language: msg.language || 'zh-CN',
        userId: client.userId,
        username: client.username
      });
      break;
    }

    case 'crew_human_input': {
      const crewHumanAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(crewHumanAgentId)) break;
      // Resolve attachment fileIds to base64 data for agent
      let resolvedFiles;
      if (msg.attachments && msg.attachments.length > 0) {
        resolvedFiles = [];
        for (const att of msg.attachments) {
          if (att.fileId) {
            const file = pendingFiles.get(att.fileId);
            if (file && (!file.userId || CONFIG.skipAuth || file.userId === client.userId)) {
              resolvedFiles.push({
                name: file.name,
                mimeType: file.mimeType,
                data: file.buffer.toString('base64'),
                isImage: att.isImage || false
              });
              pendingFiles.delete(att.fileId);
            }
          }
        }
      }
      const fwd = {
        type: 'crew_human_input',
        sessionId: msg.sessionId,
        content: msg.content,
        targetRole: msg.targetRole
      };
      if (msg.interrupt) fwd.interrupt = true;
      if (resolvedFiles && resolvedFiles.length > 0) fwd.files = resolvedFiles;
      await forwardToAgent(crewHumanAgentId, fwd);
      break;
    }

    case 'crew_control': {
      const crewCtrlAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(crewCtrlAgentId)) break;
      await forwardToAgent(crewCtrlAgentId, {
        type: 'crew_control',
        sessionId: msg.sessionId,
        action: msg.action,
        targetRole: msg.targetRole
      });
      break;
    }

    case 'crew_add_role': {
      const addRoleAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(addRoleAgentId)) break;
      await forwardToAgent(addRoleAgentId, {
        type: 'crew_add_role',
        sessionId: msg.sessionId,
        role: msg.role
      });
      break;
    }

    case 'crew_remove_role': {
      const rmRoleAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(rmRoleAgentId)) break;
      await forwardToAgent(rmRoleAgentId, {
        type: 'crew_remove_role',
        sessionId: msg.sessionId,
        roleName: msg.roleName
      });
      break;
    }

    case 'list_crew_sessions': {
      const listCrewAgentId = msg.agentId || client.currentAgent;
      if (!listCrewAgentId) break;
      if (!await checkAgentAccess(listCrewAgentId)) break;
      await forwardToAgent(listCrewAgentId, {
        type: 'list_crew_sessions',
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'check_crew_exists': {
      const checkCrewAgentId = msg.agentId || client.currentAgent;
      if (!checkCrewAgentId) break;
      if (!await checkAgentAccess(checkCrewAgentId)) break;
      await forwardToAgent(checkCrewAgentId, {
        type: 'check_crew_exists',
        projectDir: msg.projectDir,
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'delete_crew_dir': {
      const delCrewAgentId = msg.agentId || client.currentAgent;
      if (!delCrewAgentId) break;
      if (!await checkAgentAccess(delCrewAgentId)) break;
      await forwardToAgent(delCrewAgentId, {
        type: 'delete_crew_dir',
        projectDir: msg.projectDir,
        _requestClientId: clientId
      });
      break;
    }

    case 'resume_crew_session': {
      const resumeCrewAgentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(resumeCrewAgentId)) break;
      client.currentAgent = resumeCrewAgentId;
      await forwardToAgent(resumeCrewAgentId, {
        type: 'resume_crew_session',
        sessionId: msg.sessionId,
        userId: client.userId,
        username: client.username
      });
      break;
    }

    case 'update_crew_session': {
      const updateCrewAgentId = msg.agentId || client.currentAgent;
      if (!updateCrewAgentId) break;
      if (!await checkAgentAccess(updateCrewAgentId)) break;
      // Sync name to server-side memory so broadcastAgentList sends it
      const updateAgent = agents.get(updateCrewAgentId);
      if (updateAgent && msg.sessionId && msg.name !== undefined) {
        const conv = updateAgent.conversations.get(msg.sessionId);
        if (conv) conv.name = msg.name;
      }
      const updatePayload = {
        type: 'update_crew_session',
        sessionId: msg.sessionId,
        name: msg.name
      };
      if (msg.roles) updatePayload.roles = msg.roles;
      await forwardToAgent(updateCrewAgentId, updatePayload);
      await broadcastAgentList();
      break;
    }

    case 'delete_crew_session': {
      const deleteCrewAgentId = msg.agentId || client.currentAgent;
      if (!deleteCrewAgentId) break;
      if (!await checkAgentAccess(deleteCrewAgentId)) break;
      await forwardToAgent(deleteCrewAgentId, {
        type: 'delete_crew_session',
        sessionId: msg.sessionId
      });
      break;
    }

    case 'crew_load_history': {
      const historyAgentId = msg.agentId || client.currentAgent;
      if (!historyAgentId) break;
      if (!await checkAgentAccess(historyAgentId)) break;
      await forwardToAgent(historyAgentId, {
        type: 'crew_load_history',
        sessionId: msg.sessionId,
        shardIndex: msg.shardIndex,
        requestId: msg.requestId
      });
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
