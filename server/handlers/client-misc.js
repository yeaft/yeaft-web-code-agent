import { agents, userFileTabs } from '../context.js';
import {
  sendToWebClient, forwardToAgent, broadcastAgentList
} from '../ws-utils.js';
import {
  broadcastGlobalLlmConfigToWeb,
  pollGithubDeviceFlow,
  readGlobalLlmConfigForAgent,
  readGlobalLlmConfigForWeb,
  saveGlobalLlmConfigFromWeb,
  sendGlobalLlmConfigToUserAgents,
  startGithubDeviceFlow,
} from '../llm-global-config.js';

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

    // LLM configuration — global config is server-owned; agent config is node-local.
    case 'get_llm_config': {
      const llmAgentId = msg.agentId || client.currentAgent;
      if (!llmAgentId) break;
      if (!await checkAgentAccess(llmAgentId)) break;
      await forwardToAgent(llmAgentId, {
        type: 'get_llm_config',
        globalConfig: readGlobalLlmConfigForAgent(client.userId)
      });
      break;
    }

    case 'update_llm_config': {
      const llmUpdateAgentId = msg.agentId || client.currentAgent;
      if (!llmUpdateAgentId) break;
      if (!await checkAgentAccess(llmUpdateAgentId)) break;
      if (msg.scope === 'global') {
        try {
          const globalConfig = saveGlobalLlmConfigFromWeb(client.userId, msg.config || {});
          await sendGlobalLlmConfigToUserAgents(client.userId);
          await broadcastGlobalLlmConfigToWeb(client.userId, llmUpdateAgentId);
          await forwardToAgent(llmUpdateAgentId, {
            type: 'get_llm_config',
            globalConfig: readGlobalLlmConfigForAgent(client.userId)
          });
          await sendToWebClient(client, { type: 'llm_config_updated', agentId: llmUpdateAgentId, globalConfig });
        } catch (e) {
          await sendToWebClient(client, { type: 'llm_config_updated', agentId: llmUpdateAgentId, error: e.message });
        }
        break;
      }
      await forwardToAgent(llmUpdateAgentId, {
        type: 'update_llm_config',
        config: msg.config || {},
        globalConfig: readGlobalLlmConfigForAgent(client.userId)
      });
      break;
    }

    case 'llm_github_device_start': {
      try {
        const flow = await startGithubDeviceFlow();
        await sendToWebClient(client, { type: 'llm_github_device_started', ...flow });
      } catch (e) {
        await sendToWebClient(client, { type: 'llm_github_device_started', error: e.message });
      }
      break;
    }

    case 'llm_github_device_poll': {
      const llmAgentId = msg.agentId || client.currentAgent;
      try {
        const result = await pollGithubDeviceFlow({ deviceCode: msg.deviceCode });
        if (!result.ok) {
          await sendToWebClient(client, { type: 'llm_github_device_poll_result', ...result });
          break;
        }
        const current = readGlobalLlmConfigForWeb(client.userId);
        const providers = current.providers.filter(p => p.name !== result.provider.name);
        providers.push(result.provider);
        const globalConfig = saveGlobalLlmConfigFromWeb(client.userId, { providers });
        await sendGlobalLlmConfigToUserAgents(client.userId);
        await broadcastGlobalLlmConfigToWeb(client.userId, llmAgentId);
        await sendToWebClient(client, { type: 'llm_github_device_poll_result', ok: true, globalConfig });
      } catch (e) {
        await sendToWebClient(client, { type: 'llm_github_device_poll_result', ok: false, error: e.message });
      }
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

    // task-318: Yeaft runtime settings (thread cap + archive threshold)
    case 'get_yeaft_settings': {
      const yeaftAgentId = msg.agentId || client.currentAgent;
      if (!yeaftAgentId) break;
      if (!await checkAgentAccess(yeaftAgentId)) break;
      await forwardToAgent(yeaftAgentId, { type: 'get_yeaft_settings' });
      break;
    }

    case 'update_yeaft_settings': {
      const yeaftUpdateAgentId = msg.agentId || client.currentAgent;
      if (!yeaftUpdateAgentId) break;
      if (!await checkAgentAccess(yeaftUpdateAgentId)) break;
      await forwardToAgent(yeaftUpdateAgentId, {
        type: 'update_yeaft_settings',
        settings: msg.settings || msg.config || {}
      });
      break;
    }

    // Search settings (web-search backend + Tavily key + on-demand usage probe).
    // Mirrors the get/update_yeaft_settings pair: the agent owns the
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
