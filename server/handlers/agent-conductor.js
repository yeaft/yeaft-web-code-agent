/**
 * Handle Conductor (V2) messages from agent.
 * Types: conductor_session_created, conductor_session_restored,
 *        conductor_output, conductor_status, conductor_turn_completed,
 *        conductor_error, conductor_task_created, conductor_task_message,
 *        conductor_workdir_updated, conductor_sessions_list,
 *        conductor_session_cleared, conductor_history_loaded
 */
import { randomUUID } from 'crypto';
import { sessionDb } from '../database.js';
import {
  broadcastAgentList, notifyConversationUpdate, forwardToClients
} from '../ws-utils.js';

export async function handleAgentConductor(agentId, agent, msg) {
  switch (msg.type) {
    case 'conductor_session_created': {
      const userId = msg.userId || agent.ownerId || null;
      const username = msg.username || agent.ownerUsername || null;
      agent.conversations.set(msg.sessionId, {
        id: msg.sessionId,
        workDir: msg.workDir || null,
        userId,
        username,
        createdAt: Date.now(),
        processing: true,
        type: 'conductor'
      });
      try {
        if (!sessionDb.exists(msg.sessionId)) {
          sessionDb.create(msg.sessionId, agentId, agent.name, msg.workDir || '', null, msg.name || null, userId);
        }
      } catch (e) {
        console.error('Failed to save conductor session to database:', e.message);
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      await broadcastAgentList();
      break;
    }

    case 'conductor_session_restored': {
      const restoreUserId = msg.userId || agent.ownerId || null;
      const restoreUsername = msg.username || agent.ownerUsername || null;
      if (!agent.conversations.has(msg.sessionId)) {
        agent.conversations.set(msg.sessionId, {
          id: msg.sessionId,
          workDir: msg.workDir || null,
          userId: restoreUserId,
          username: restoreUsername,
          createdAt: Date.now(),
          processing: true,
          type: 'conductor'
        });
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'conductor_output':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_status': {
      const conv = agent.conversations.get(msg.sessionId);
      if (conv && (msg.status === 'stopped')) {
        conv.processing = false;
      }
      await forwardToClients(agentId, msg.sessionId, msg);
      break;
    }

    case 'conductor_turn_completed':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_error':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_task_created':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_task_message':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_workdir_updated':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_sessions_list':
      await notifyConversationUpdate(agentId, msg);
      break;

    case 'conductor_session_cleared':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    case 'conductor_history_loaded':
      await forwardToClients(agentId, msg.sessionId, msg);
      break;

    default:
      return false;
  }
  return true;
}
