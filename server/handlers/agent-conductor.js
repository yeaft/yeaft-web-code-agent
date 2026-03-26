/**
 * Handle Conductor (V5) messages from agent.
 * All known types are forwarded to connected clients unchanged.
 */
import {
  broadcastAgentList, forwardToClients
} from '../ws-utils.js';

const CONDUCTOR_MSG_TYPES = new Set([
  'conductor_opened',
  'conductor_output',
  'conductor_status',
  'conductor_turn_completed',
  'conductor_error',
  'conductor_task_creating',
  'conductor_task_created',
  'conductor_task_status',
  'conductor_task_message',
  'conductor_cleared',
  'conductor_history_loaded'
]);

export async function handleAgentConductor(agentId, agent, msg) {
  if (!CONDUCTOR_MSG_TYPES.has(msg.type)) return false;
  await forwardToAllAgentClients(agentId, msg);
  return true;
}

/**
 * Forward conductor message to all clients connected to this agent.
 * Conductor is agent-level (no sessionId), so we use a sentinel conversationId.
 * forwardToClients will fall back to agent.ownerId when the sentinel is not found
 * in agent.conversations — this is expected behavior for conductor messages.
 */
async function forwardToAllAgentClients(agentId, msg) {
  await forwardToClients(agentId, '_conductor_', msg);
}
