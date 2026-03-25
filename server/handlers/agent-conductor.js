/**
 * Handle Conductor (V5) messages from agent.
 * Types: conductor_opened, conductor_output, conductor_status,
 *        conductor_turn_completed, conductor_error,
 *        conductor_task_created, conductor_task_message,
 *        conductor_cleared, conductor_history_loaded
 */
import {
  broadcastAgentList, forwardToClients
} from '../ws-utils.js';

export async function handleAgentConductor(agentId, agent, msg) {
  switch (msg.type) {
    case 'conductor_opened': {
      // Conductor opened (initial or resumed) — forward to all clients of this agent
      await forwardToAllAgentClients(agentId, msg);
      break;
    }

    case 'conductor_output':
      await forwardToAllAgentClients(agentId, msg);
      break;

    case 'conductor_status':
      await forwardToAllAgentClients(agentId, msg);
      break;

    case 'conductor_turn_completed':
      await forwardToAllAgentClients(agentId, msg);
      break;

    case 'conductor_error':
      await forwardToAllAgentClients(agentId, msg);
      break;

    case 'conductor_task_created':
      await forwardToAllAgentClients(agentId, msg);
      break;

    case 'conductor_task_message':
      await forwardToAllAgentClients(agentId, msg);
      break;

    case 'conductor_cleared':
      await forwardToAllAgentClients(agentId, msg);
      break;

    case 'conductor_history_loaded':
      await forwardToAllAgentClients(agentId, msg);
      break;

    default:
      return false;
  }
  return true;
}

/**
 * Forward conductor message to all clients connected to this agent.
 * Conductor is agent-level (no sessionId), so we broadcast to all agent clients.
 */
async function forwardToAllAgentClients(agentId, msg) {
  // Use forwardToClients with a sentinel sessionId so all agent clients receive it
  // The server's forwardToClients checks client.currentAgent matching
  await forwardToClients(agentId, '_conductor_', msg);
}
