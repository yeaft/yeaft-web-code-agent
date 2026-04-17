import { CONFIG } from '../config.js';
import { sessionDb } from '../database.js';
import { agents, webClients } from '../context.js';
import { sendToWebClient, broadcastAgentList } from '../ws-utils.js';
import {
  handleProxyResponse, handleProxyResponseChunk, handleProxyResponseEnd,
  handleProxyWsAgentMessage
} from '../proxy.js';

/**
 * Handle sync, proxy, and agent control messages from agent.
 * Types: agent_sync_complete, sync_sessions,
 *        proxy_response, proxy_response_chunk, proxy_response_end,
 *        proxy_ports_update, proxy_ws_opened/message/closed/error,
 *        restart_agent_ack, upgrade_agent_ack
 */
export async function handleAgentSync(agentId, agent, msg) {
  switch (msg.type) {
    // Phase 1: Agent 同步完成
    case 'agent_sync_complete': {
      agent.status = 'ready';
      if (agent._syncTimeout) {
        clearTimeout(agent._syncTimeout);
        delete agent._syncTimeout;
      }
      console.log(`[Sync] Agent ${agent.name} sync complete, status: ready`);
      await broadcastAgentList();
      break;
    }

    // Phase 2: Session 同步
    case 'sync_sessions': {
      const sessions = msg.sessions || [];
      // Security: 限制单次同步的 session 数量
      const MAX_SYNC_SESSIONS = 1000;
      if (sessions.length > MAX_SYNC_SESSIONS) {
        console.warn(`[Security] Agent ${agentId} tried to sync ${sessions.length} sessions (limit: ${MAX_SYNC_SESSIONS}), truncating`);
      }
      const safeSessions = sessions.slice(0, MAX_SYNC_SESSIONS);
      console.log(`[Sync] Received ${safeSessions.length} sessions from agent ${agent.name}`);
      let created = 0, updated = 0;
      for (const s of safeSessions) {
        // Security: 校验 sessionId 格式
        if (!s.sessionId || typeof s.sessionId !== 'string' || s.sessionId.length > 200) continue;
        try {
          const existing = sessionDb.get(s.sessionId);
          if (!existing) {
            // Security: 强制使用 agent.ownerId
            sessionDb.create(s.sessionId, agentId, agent.name, s.workDir, s.sessionId, s.title, agent.ownerId || null);
            // Auto-deactivate old sessions synced from disk (not modified in 2 days)
            if (s.lastModified && s.lastModified < Date.now() - 2 * 24 * 60 * 60 * 1000) {
              sessionDb.setActive(s.sessionId, false);
            }
            created++;
          } else {
            if (s.lastModified > existing.updated_at) {
              sessionDb.update(s.sessionId, { title: s.title });
            }
            updated++;
          }
        } catch (e) {
          console.error(`[Sync] Error syncing session ${s.sessionId}:`, e.message);
        }
      }
      console.log(`[Sync] Sessions synced: ${created} created, ${updated} existing`);
      break;
    }

    // Port proxy responses
    case 'proxy_response':
      handleProxyResponse(msg);
      break;

    case 'proxy_response_chunk':
      handleProxyResponseChunk(msg);
      break;

    case 'proxy_response_end':
      handleProxyResponseEnd(msg);
      break;

    case 'proxy_ports_update': {
      const a = agents.get(agentId);
      if (a) {
        a.proxyPorts = msg.ports || [];
        await broadcastAgentList();
      }
      break;
    }

    case 'restart_agent_ack': {
      // 只通知该 Agent 的 owner
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, { type: 'restart_agent_ack', agentId });
        }
      }
      break;
    }

    case 'upgrade_agent_ack': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, { type: 'upgrade_agent_ack', agentId, success: msg.success, error: msg.error, alreadyLatest: msg.alreadyLatest, version: msg.version });
        }
      }
      break;
    }

    // Proxy WebSocket messages from agent to browser
    case 'proxy_ws_opened':
    case 'proxy_ws_message':
    case 'proxy_ws_closed':
    case 'proxy_ws_error':
      handleProxyWsAgentMessage(msg);
      break;

    // MCP servers list from agent — store on agent and broadcast to owner clients
    case 'mcp_servers_list': {
      agent.mcpServers = msg.servers || [];
      console.log(`[MCP] Agent ${agent.name} reported ${agent.mcpServers.length} MCP servers`);
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'mcp_servers_list',
            agentId,
            servers: agent.mcpServers
          });
        }
      }
      break;
    }

    // Expert roles definition from agent — forward to owner clients
    case 'expert_roles_list': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'expert_roles_list',
            agentId,
            roles: msg.roles
          });
        }
      }
      break;
    }

    // MCP config updated acknowledgement from agent
    case 'mcp_config_updated': {
      agent.mcpServers = msg.servers || [];
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'mcp_config_updated',
            agentId,
            servers: agent.mcpServers
          });
        }
      }
      break;
    }

    // LLM config response from agent — relay to owner clients
    case 'llm_config': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'llm_config',
            agentId,
            providers: msg.providers,
            primaryModel: msg.primaryModel,
            fastModel: msg.fastModel,
            language: msg.language,
            needsSetup: msg.needsSetup,
            error: msg.error
          });
        }
      }
      break;
    }

    // LLM config updated acknowledgement from agent
    case 'llm_config_updated': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'llm_config_updated',
            agentId,
            providers: msg.providers,
            primaryModel: msg.primaryModel,
            fastModel: msg.fastModel,
            language: msg.language,
            error: msg.error
          });
        }
      }
      break;
    }

    // task-318: Unify runtime settings read / update ack — relay to owner
    case 'unify_settings':
    case 'unify_settings_updated': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: msg.type,
            agentId,
            maxConcurrentThreads: msg.maxConcurrentThreads,
            autoArchiveIdleDays: msg.autoArchiveIdleDays,
            error: msg.error
          });
        }
      }
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
