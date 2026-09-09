import { CONFIG } from '../config.js';
import { agentInventoryDb, sessionDb, userStatsDb } from '../database.js';
import {
  agents,
  consumeAgentSettingsRequest,
  webClients,
} from '../context.js';
import { sendToWebClient, broadcastAgentList } from '../ws-utils.js';
import {
  handleProxyResponse, handleProxyResponseChunk, handleProxyResponseEnd,
  handleProxyWsAgentMessage
} from '../proxy.js';

const numberMetric = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

async function sendAgentSettingsReply(agentId, agent, operation, msg, payload) {
  const pending = consumeAgentSettingsRequest({ agentId, operation, requestId: msg.requestId });
  if (!pending) return false;
  if (!msg.requestId) payload.requestId = pending.requestId;
  const client = webClients.get(pending.clientId);
  if (!client?.authenticated || (!CONFIG.skipAuth
    && !((agent.ownerId && client.userId === agent.ownerId)
      || (!agent.ownerId && client.role === 'admin')))) return false;
  await sendToWebClient(client, payload);
  return true;
}

function normalizeAgentMetrics(metrics = {}) {
  const chatTurns = numberMetric(metrics.chatTurns);
  const yeaftTurns = numberMetric(metrics.yeaftTurns);
  const totalTurns = numberMetric(metrics.totalTurns) || chatTurns + yeaftTurns;
  const inputTokens = numberMetric(metrics.inputTokens);
  const outputTokens = numberMetric(metrics.outputTokens);
  const cacheReadTokens = numberMetric(metrics.cacheReadTokens);
  const cacheWriteTokens = numberMetric(metrics.cacheWriteTokens);
  const totalTokens = numberMetric(metrics.totalTokens) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    metricEpoch: typeof metrics.metricEpoch === 'string' ? metrics.metricEpoch : null,
    chatTurns,
    yeaftTurns,
    totalTurns,
    sessionsCreated: numberMetric(metrics.sessionsCreated),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    lastUpdatedAt: numberMetric(metrics.lastUpdatedAt) || null,
  };
}

async function forwardAgentMetrics(agentId, agent) {
  const payload = {
    type: 'agent_metrics',
    agentId,
    metrics: agent.metrics,
    metricsUpdatedAt: agent.metricsUpdatedAt || null,
  };
  for (const [, client] of webClients) {
    if (client.authenticated && (CONFIG.skipAuth ||
      (agent.ownerId && client.userId === agent.ownerId) ||
      (!agent.ownerId && client.role === 'admin')
    )) {
      await sendToWebClient(client, payload);
    }
  }
}

/**
 * Handle sync, proxy, and agent control messages from agent.
 * Types: agent_sync_complete, sync_sessions, agent_metrics,
 *        proxy_response, proxy_response_chunk, proxy_response_end,
 *        proxy_ports_update, proxy_ws_opened/message/closed/error,
 *        restart_agent_ack, upgrade_agent_ack
 */
export async function handleAgentSync(agentId, agent, msg) {
  switch (msg.type) {
    // Phase 1: Agent 同步完成
    case 'agent_sync_complete': {
      agent.status = 'ready';
      agent.dreamEnabled = msg.dreamEnabled === true;
      if (agent._syncTimeout) {
        clearTimeout(agent._syncTimeout);
        delete agent._syncTimeout;
      }
      console.log(`[Sync] Agent ${agent.name} sync complete, status: ready`);
      await broadcastAgentList();
      break;
    }

    case 'dream_enabled_changed': {
      if (!msg.error) {
        agent.dreamEnabled = msg.enabled !== false;
        await broadcastAgentList();
      }
      const payload = {
        type: 'dream_enabled_changed',
        agentId,
        requestId: msg.requestId,
        enabled: msg.error ? agent.dreamEnabled === true : msg.enabled !== false,
        ...(msg.error ? { error: msg.error } : {}),
      };
      await sendAgentSettingsReply(agentId, agent, 'dream', msg, payload);
      break;
    }

    case 'agent_capabilities_updated': {
      const capabilities = Array.isArray(msg.capabilities)
        ? [...new Set(msg.capabilities.filter(value => (
          typeof value === 'string' && value.length > 0 && value.length <= 128
        )).slice(0, 128))]
        : null;
      if (!capabilities || capabilities.length === 0) break;
      agent.capabilities = capabilities;
      try {
        agentInventoryDb.upsert({ ...agent, id: agentId });
      } catch (error) {
        console.error(`[AgentInventory] Failed to persist capabilities for ${agentId}:`, error.message);
      }
      // Transport encryption negotiation is connection-scoped and immutable.
      // A runtime capability refresh must never flip framing mid-connection.
      await broadcastAgentList();
      break;
    }

    case 'agent_metrics': {
      agent.metrics = normalizeAgentMetrics(msg.metrics || {});
      agent.metricsUpdatedAt = Date.now();
      try {
        const persisted = agentInventoryDb.updateMetrics(agentId, agent.metrics, agent.metricsUpdatedAt);
        if (persisted === false) agentInventoryDb.upsert({ ...agent, id: agentId });
      } catch (error) {
        console.error(`[AgentInventory] Failed to persist metrics for ${agentId}:`, error.message);
      }
      if (agent.ownerId && agent.metrics.metricEpoch) {
        try {
          userStatsDb.recordAgentTokenSnapshot(
            agent.ownerId,
            agent.instanceId || agentId,
            agent.metrics
          );
        } catch (error) {
          console.error(`[AgentMetrics] Failed to persist token usage for ${agentId}:`, error.message);
        }
      }
      await forwardAgentMetrics(agentId, agent);
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
            // fix-chat-title-sticky: don't let the agent's bulk title
            // sync overwrite a user-renamed session. The title in the
            // DB is sticky once `customTitle` is set; only the
            // agent's claudeSessionId / activity timestamp need to
            // refresh on this path.
            if (s.lastModified > existing.updated_at && !existing.customTitle) {
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
      const payload = { type: 'restart_agent_ack', agentId, requestId: msg.requestId };
      await sendAgentSettingsReply(agentId, agent, 'restart', msg, payload);
      break;
    }

    case 'upgrade_agent_ack': {
      const payload = { type: 'upgrade_agent_ack', agentId, requestId: msg.requestId, success: msg.success, error: msg.error, alreadyLatest: msg.alreadyLatest, version: msg.version, reason: msg.reason, currentNode: msg.currentNode, requiredNode: msg.requiredNode, requiredCapability: msg.requiredCapability };
      await sendAgentSettingsReply(agentId, agent, 'upgrade', msg, payload);
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
            requestId: msg.requestId,
            providers: msg.providers,
            primaryModel: msg.primaryModel,
            fastModel: msg.fastModel,
            language: msg.language,
            needsSetup: msg.needsSetup,
            agentConfig: msg.agentConfig,
            effectiveConfig: msg.effectiveConfig,
            error: msg.error
          });
        }
      }
      break;
    }

    // LLM model discovery response from agent — relay to owner clients
    case 'llm_models_discovered': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'llm_models_discovered',
            agentId,
            requestId: msg.requestId,
            providerType: msg.providerType,
            provider: msg.provider,
            models: msg.models || [],
            providerModels: msg.providerModels || [],
            source: msg.source,
            warning: msg.warning,
            error: msg.error,
          });
        }
      }
      break;
    }

    case 'llm_config_updated': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'llm_config_updated',
            agentId,
            requestId: msg.requestId,
            providers: msg.providers,
            primaryModel: msg.primaryModel,
            fastModel: msg.fastModel,
            language: msg.language,
            agentConfig: msg.agentConfig,
            effectiveConfig: msg.effectiveConfig,
            statusRefreshError: msg.statusRefreshError,
            error: msg.error
          });
        }
      }
      break;
    }

    // models.dev registry response from agent — relay to owner clients
    case 'models_dev_registry': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, {
            type: 'models_dev_registry',
            agentId,
            requestId: msg.requestId,
            registry: msg.registry,
            fetchedAt: msg.fetchedAt,
            error: msg.error,
          });
        }
      }
      break;
    }

    // task-318: Yeaft runtime settings read / update ack — relay to owner
    case 'yeaft_settings':
    case 'yeaft_settings_updated': {
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

    // Agent-level plugin selection. The Agent owns config.json; the server
    // only stamps ownership and relays request-scoped replies to the UI.
    case 'yeaft_plugins':
    case 'yeaft_plugins_updated':
    // Local telemetry settings relay. Only bounded config is forwarded;
    // trace payloads stay on the Agent.
    case 'telemetry_settings':
    case 'telemetry_settings_updated': {
      const operation = msg.type === 'yeaft_plugins_updated'
        ? 'plugins:update'
        : msg.type === 'yeaft_plugins'
          ? 'plugins:load'
          : msg.type === 'telemetry_settings_updated'
            ? 'telemetry:update'
            : 'telemetry:load';
      await sendAgentSettingsReply(agentId, agent, operation, msg, { ...msg, agentId });
      break;
    }

    // Search settings + Tavily usage relays. We pass the whole msg
    // through (minus agentId, which we set ourselves) — the payload
    // shapes differ per type and the front-end already filters on
    // `type`, so a generic forward is simpler than three nearly-
    // identical branches.
    case 'search_settings':
    case 'search_settings_updated':
    case 'tavily_usage': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, { ...msg, agentId });
        }
      }
      break;
    }

    // Yeaft MCP CRUD result + live-update broadcast. Same generic pass-
    // through as the search-settings branch above — the payload shape
    // is documented in web-bridge.js handlers (`handleYeaftMcp*`).
    case 'yeaft_mcp_list_result':
    case 'yeaft_mcp_add_result':
    case 'yeaft_mcp_remove_result':
    case 'yeaft_mcp_reload_result':
    case 'yeaft_mcp_updated': {
      for (const [, client] of webClients) {
        if (client.authenticated && (CONFIG.skipAuth ||
          (agent.ownerId && client.userId === agent.ownerId) ||
          (!agent.ownerId && client.role === 'admin')
        )) {
          await sendToWebClient(client, { ...msg, agentId });
        }
      }
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
