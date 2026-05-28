import { agents, userFileTabs } from '../context.js';
import {
  sendToWebClient, forwardToAgent, broadcastAgentList
} from '../ws-utils.js';

/**
 * Handle miscellaneous messages from web client.
 * Types: ping, restart_agent, upgrade_agent,
 *        proxy_update_ports, update_file_tabs, restore_file_tabs
 */
export async function handleClientMisc(clientId, client, msg, checkAgentAccess) {
  switch (msg.type) {
    case 'ping':
      await sendToWebClient(client, { type: 'pong' });
      break;

    case 'restart_agent': {
      const restartAgentId = msg.agentId;
      if (!restartAgentId) break;
      if (!await checkAgentAccess(restartAgentId)) break;
      await forwardToAgent(restartAgentId, { type: 'restart_agent' });
      break;
    }

    case 'upgrade_agent': {
      const upgradeAgentId = msg.agentId;
      if (!upgradeAgentId) break;
      if (!await checkAgentAccess(upgradeAgentId)) break;
      await forwardToAgent(upgradeAgentId, { type: 'upgrade_agent' });
      break;
    }

    case 'proxy_update_ports': {
      const proxyAgentId = msg.agentId || client.currentAgent;
      if (!proxyAgentId) break;
      if (!await checkAgentAccess(proxyAgentId)) break;
      const agent = agents.get(proxyAgentId);
      if (agent) agent.proxyPorts = msg.ports || [];
      await forwardToAgent(proxyAgentId, {
        type: 'proxy_update_ports',
        ports: msg.ports || []
      });
      break;
    }

    // File Tab 状态保存/恢复
    case 'update_file_tabs': {
      if (client.userId && client.currentAgent) {
        const key = `${client.userId}:${client.currentAgent}`;
        userFileTabs.set(key, {
          files: (msg.openFiles || []).map(f => ({ path: f.path })),
          activeIndex: msg.activeIndex || 0,
          timestamp: Date.now()
        });
      }
      break;
    }

    case 'restore_file_tabs': {
      const ftAgentId = msg.agentId || client.currentAgent;
      if (client.userId && ftAgentId) {
        if (!await checkAgentAccess(ftAgentId)) break;
        const key = `${client.userId}:${ftAgentId}`;
        const saved = userFileTabs.get(key);
        await sendToWebClient(client, {
          type: 'file_tabs_restored',
          openFiles: saved?.files || [],
          activeIndex: saved?.activeIndex || 0
        });
      }
      break;
    }

    // MCP configuration
    case 'get_mcp_servers': {
      const mcpAgentId = msg.agentId || client.currentAgent;
      if (!mcpAgentId) break;
      if (!await checkAgentAccess(mcpAgentId)) break;
      // If server already has cached list, return immediately
      const mcpAgent = agents.get(mcpAgentId);
      if (mcpAgent?.mcpServers?.length > 0) {
        await sendToWebClient(client, {
          type: 'mcp_servers_list',
          agentId: mcpAgentId,
          servers: mcpAgent.mcpServers
        });
      } else {
        await forwardToAgent(mcpAgentId, { type: 'get_mcp_servers' });
      }
      break;
    }

    // Expert roles definition (forward to agent)
    case 'get_expert_roles': {
      const expertAgentId = msg.agentId || client.currentAgent;
      if (!expertAgentId) break;
      if (!await checkAgentAccess(expertAgentId)) break;
      await forwardToAgent(expertAgentId, { type: 'get_expert_roles' });
      break;
    }

    case 'update_mcp_config': {
      const configAgentId = msg.agentId || client.currentAgent;
      if (!configAgentId) break;
      if (!await checkAgentAccess(configAgentId)) break;
      await forwardToAgent(configAgentId, {
        type: 'update_mcp_config',
        config: msg.config || {}
      });
      break;
    }

    // LLM configuration — relay to agent
    case 'get_llm_config': {
      const llmAgentId = msg.agentId || client.currentAgent;
      if (!llmAgentId) break;
      if (!await checkAgentAccess(llmAgentId)) break;
      await forwardToAgent(llmAgentId, { type: 'get_llm_config' });
      break;
    }

    case 'update_llm_config': {
      const llmUpdateAgentId = msg.agentId || client.currentAgent;
      if (!llmUpdateAgentId) break;
      if (!await checkAgentAccess(llmUpdateAgentId)) break;
      await forwardToAgent(llmUpdateAgentId, {
        type: 'update_llm_config',
        config: msg.config || {}
      });
      break;
    }

    // models.dev registry — relay to agent
    case 'get_models_dev_registry': {
      const mdAgentId = msg.agentId || client.currentAgent;
      if (!mdAgentId) break;
      if (!await checkAgentAccess(mdAgentId)) break;
      await forwardToAgent(mdAgentId, {
        type: 'get_models_dev_registry',
        forceRefresh: !!msg.forceRefresh,
        requestId: msg.requestId || null,
      });
      break;
    }

    // task-318: Unify runtime settings (thread cap + archive threshold)
    case 'get_unify_settings': {
      const unifyAgentId = msg.agentId || client.currentAgent;
      if (!unifyAgentId) break;
      if (!await checkAgentAccess(unifyAgentId)) break;
      await forwardToAgent(unifyAgentId, { type: 'get_unify_settings' });
      break;
    }

    case 'update_unify_settings': {
      const unifyUpdateAgentId = msg.agentId || client.currentAgent;
      if (!unifyUpdateAgentId) break;
      if (!await checkAgentAccess(unifyUpdateAgentId)) break;
      await forwardToAgent(unifyUpdateAgentId, {
        type: 'update_unify_settings',
        settings: msg.settings || msg.config || {}
      });
      break;
    }

    // Search settings (web-search backend + Tavily key + on-demand usage probe).
    // Mirrors the get/update_unify_settings pair: the agent owns the
    // config file, server is just a relay.
    case 'get_search_settings': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, { type: 'get_search_settings' });
      break;
    }

    case 'update_search_settings': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, {
        type: 'update_search_settings',
        settings: msg.settings || msg.config || {}
      });
      break;
    }

    case 'get_tavily_usage': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, { type: 'get_tavily_usage' });
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
