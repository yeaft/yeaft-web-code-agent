/**
 * Handle Conductor (V5) messages from web client.
 * Types: open_conductor, conductor_user_input,
 *        stop_conductor, clear_conductor, conductor_load_history
 */
import { agents } from '../context.js';
import { sendToWebClient, forwardToAgent } from '../ws-utils.js';

export async function handleClientConductor(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    case 'open_conductor': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      const agent = agents.get(agentId);
      if (!agent) {
        await sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        break;
      }
      client.currentAgent = agentId;
      await forwardToAgent(agentId, {
        type: 'open_conductor',
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
        content: msg.content,
        workDir: msg.workDir || undefined
      });
      break;
    }

    case 'stop_conductor': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'stop_conductor'
      });
      break;
    }

    case 'clear_conductor': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'clear_conductor'
      });
      break;
    }

    case 'conductor_load_history': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await forwardToAgent(agentId, {
        type: 'conductor_load_history',
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
