/**
 * Handle Conductor (V2) messages from web client.
 * Types: create_conductor_session, conductor_user_input,
 *        conductor_update_workdir, list_conductor_sessions,
 *        resume_conductor_session, update_conductor_session,
 *        stop_conductor_session, clear_conductor_session,
 *        delete_conductor_session, conductor_load_history
 */
import { randomUUID } from 'crypto';
import { agents } from '../context.js';
import { sendToWebClient, forwardToAgent } from '../ws-utils.js';

export async function handleClientConductor(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    case 'create_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      const agent = agents.get(agentId);
      if (!agent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        break;
      }
      client.currentAgent = agentId;
      await forwardToAgent(agentId, {
        type: 'create_conductor_session',
        sessionId: msg.sessionId || randomUUID(),
        name: msg.name || '',
        workDir: msg.workDir || null,
        scenarioId: msg.scenarioId || null,
        userId: client.userId,
        username: client.username
      });
      break;
    }

    case 'conductor_user_input': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'conductor_user_input',
        sessionId: msg.sessionId,
        content: msg.content
      });
      break;
    }

    case 'conductor_update_workdir': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'conductor_update_workdir',
        sessionId: msg.sessionId,
        workDir: msg.workDir
      });
      break;
    }

    case 'list_conductor_sessions': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'list_conductor_sessions',
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'resume_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      client.currentAgent = agentId;
      await forwardToAgent(agentId, {
        type: 'resume_conductor_session',
        sessionId: msg.sessionId,
        userId: client.userId,
        username: client.username
      });
      break;
    }

    case 'update_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'update_conductor_session',
        sessionId: msg.sessionId,
        name: msg.name,
        workDir: msg.workDir
      });
      break;
    }

    case 'stop_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'stop_conductor_session',
        sessionId: msg.sessionId
      });
      break;
    }

    case 'clear_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'clear_conductor_session',
        sessionId: msg.sessionId
      });
      break;
    }

    case 'delete_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'delete_conductor_session',
        sessionId: msg.sessionId
      });
      break;
    }

    case 'conductor_load_history': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'conductor_load_history',
        sessionId: msg.sessionId,
        shardIndex: msg.shardIndex,
        requestId: msg.requestId
      });
      break;
    }

    default:
      return false;
  }
  return true;
}
