import { agents, userFileTabs } from '../context.js';
import {
  sendToWebClient, forwardToAgent, broadcastAgentList
} from '../ws-utils.js';
import { resolveWorkbenchRequest } from '../workbench-route.js';

// Only Agents that explicitly advertise the package-replacement-safe updater
// may receive remote upgrade commands. Version thresholds are insufficient:
// builds without this capability may still inherit the installed package cwd.
export const SAFE_REMOTE_UPGRADE_CAPABILITY = 'remote_upgrade_safe';

export function requiresManualUpgradeBridge(capabilities, platform = null) {
  if (Array.isArray(capabilities) && capabilities.includes(SAFE_REMOTE_UPGRADE_CAPABILITY)) return false;
  const normalizedPlatform = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  if (normalizedPlatform) return normalizedPlatform === 'win32';
  // v1.0.373 predates explicit platform metadata but advertises this Linux-only
  // capability, so it is safe to distinguish from the affected Windows build.
  if (Array.isArray(capabilities) && capabilities.includes('work_item_attachments')) return false;
  return true;
}

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
      const upgradeAgent = agents.get(upgradeAgentId);
      if (requiresManualUpgradeBridge(upgradeAgent?.capabilities, upgradeAgent?.platform)) {
        await sendToWebClient(client, {
          type: 'upgrade_agent_ack',
          agentId: upgradeAgentId,
          success: false,
          reason: 'manual_upgrade_required',
          version: upgradeAgent?.version || null,
          requiredCapability: SAFE_REMOTE_UPGRADE_CAPABILITY,
          error: `Agent ${upgradeAgent?.version || 'unknown'} does not advertise the safe remote-upgrade contract. First stop the selected Agent/service on that machine: if it runs under PM2 or another service manager, stop that exact instance there; if it runs in a foreground terminal, terminate that process. Confirm that process has exited, then run "npm install -g @yeaft/webchat-agent@latest --registry=https://pkg.yeaft.com/". Finally, restart the same Agent instance with its original configuration.`,
        });
        break;
      }
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
      const ftAgentId = msg.agentId || client.currentAgent;
      if (client.userId && ftAgentId) {
        if (!await checkAgentAccess(ftAgentId)) break;
        const resolved = resolveWorkbenchRequest(client, msg, ftAgentId);
        if (!resolved) break;
        const identity = resolved.routeKey
          ? `${resolved.routeKey}\u0000${resolved.workspaceGeneration}`
          : ftAgentId;
        const key = `${client.userId}:${identity}`;
        userFileTabs.set(key, {
          files: (msg.openFiles || []).map(f => ({ path: f.path })),
          activeIndex: Number.isFinite(msg.activeIndex) ? msg.activeIndex : 0,
          timestamp: Date.now()
        });
      }
      break;
    }

    case 'restore_file_tabs': {
      const ftAgentId = msg.agentId || client.currentAgent;
      if (client.userId && ftAgentId) {
        if (!await checkAgentAccess(ftAgentId)) break;
        const resolved = resolveWorkbenchRequest(client, msg, ftAgentId);
        if (!resolved) break;
        const identity = resolved.routeKey
          ? `${resolved.routeKey}\u0000${resolved.workspaceGeneration}`
          : ftAgentId;
        const key = `${client.userId}:${identity}`;
        const saved = userFileTabs.get(key);
        await sendToWebClient(client, {
          type: 'file_tabs_restored',
          agentId: ftAgentId,
          conversationId: resolved.conversationId || msg.conversationId || client.currentConversation,
          workbenchRouteKey: resolved.routeKey,
          workbenchWorkspaceGeneration: resolved.workspaceGeneration,
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

    // LLM configuration — this writes only the selected agent's local ~/.yeaft/config.json.
    case 'get_llm_config': {
      const llmAgentId = msg.agentId || client.currentAgent;
      if (!llmAgentId) break;
      if (!await checkAgentAccess(llmAgentId)) break;
      await forwardToAgent(llmAgentId, { type: 'get_llm_config' });
      break;
    }

    case 'discover_llm_models': {
      const llmDiscoverAgentId = msg.agentId || client.currentAgent;
      if (!llmDiscoverAgentId) break;
      if (!await checkAgentAccess(llmDiscoverAgentId)) break;
      await forwardToAgent(llmDiscoverAgentId, {
        type: 'discover_llm_models',
        agentId: llmDiscoverAgentId,
        requestId: msg.requestId,
        providerType: msg.providerType || msg.provider || msg.preset,
        baseUrl: msg.baseUrl,
        apiKey: msg.apiKey,
      });
      break;
    }

    case 'update_llm_config': {
      const llmUpdateAgentId = msg.agentId || client.currentAgent;
      if (!llmUpdateAgentId) break;
      if (!await checkAgentAccess(llmUpdateAgentId)) break;
      await forwardToAgent(llmUpdateAgentId, {
        type: 'update_llm_config',
        agentId: llmUpdateAgentId,
        requestId: msg.requestId,
        config: msg.config || {}
      });
      break;
    }

    case 'get_yeaft_settings': {
      const targetAgentId = msg.agentId || client.currentAgent;
      if (!targetAgentId) break;
      if (!await checkAgentAccess(targetAgentId)) break;
      await forwardToAgent(targetAgentId, { type: 'get_yeaft_settings' });
      break;
    }

    case 'get_yeaft_plugins': {
      const targetAgentId = msg.agentId || client.currentAgent;
      if (!targetAgentId) break;
      if (!await checkAgentAccess(targetAgentId)) break;
      await forwardToAgent(targetAgentId, {
        type: 'get_yeaft_plugins',
        requestId: msg.requestId || null,
      });
      break;
    }

    case 'update_yeaft_plugins': {
      const targetAgentId = msg.agentId || client.currentAgent;
      if (!targetAgentId) break;
      if (!await checkAgentAccess(targetAgentId)) break;
      const hasPlugins = Object.prototype.hasOwnProperty.call(msg, 'plugins');
      const hasConfig = Object.prototype.hasOwnProperty.call(msg, 'config');
      await forwardToAgent(targetAgentId, {
        type: 'update_yeaft_plugins',
        requestId: msg.requestId || null,
        // Preserve explicit falsy values so Agent-side schema validation can
        // reject them. Only an absent payload is the legacy empty selection.
        plugins: hasPlugins ? msg.plugins : (hasConfig ? msg.config : {}),
      });
      break;
    }

    case 'update_yeaft_settings': {
      const targetAgentId = msg.agentId || client.currentAgent;
      if (!targetAgentId) break;
      if (!await checkAgentAccess(targetAgentId)) break;
      await forwardToAgent(targetAgentId, {
        type: 'update_yeaft_settings',
        settings: msg.settings || msg.config || {}
      });
      break;
    }

    // Local performance telemetry settings. The agent owns the config file;
    // the server only checks access and relays the request.
    case 'get_telemetry_settings': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, { type: 'get_telemetry_settings' });
      break;
    }

    case 'update_telemetry_settings': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, {
        type: 'update_telemetry_settings',
        settings: msg.settings || msg.config || {},
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

    // Yeaft MCP CRUD (Claude-Code-style Settings → MCP tab).
    // Server is a pure relay: agent owns the config file at
    // `~/.yeaft/config.json` and the live MCPManager + ToolRegistry. We
    // forward `yeaft_mcp_list/add/remove/reload` to the selected agent
    // and the response (`yeaft_mcp_*_result` + broadcast
    // `yeaft_mcp_updated`) flows back via agent-output.
    case 'yeaft_mcp_list': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, {
        type: 'yeaft_mcp_list',
        requestId: msg.requestId || null,
      });
      break;
    }

    case 'yeaft_mcp_add': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, {
        type: 'yeaft_mcp_add',
        requestId: msg.requestId || null,
        server: msg.server || {},
      });
      break;
    }

    case 'yeaft_mcp_remove': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, {
        type: 'yeaft_mcp_remove',
        requestId: msg.requestId || null,
        name: msg.name || '',
      });
      break;
    }

    case 'yeaft_mcp_reload': {
      const a = msg.agentId || client.currentAgent;
      if (!a) break;
      if (!await checkAgentAccess(a)) break;
      await forwardToAgent(a, {
        type: 'yeaft_mcp_reload',
        requestId: msg.requestId || null,
        name: msg.name || null,
      });
      break;
    }

    default:
      return false; // Not handled
  }
  return true; // Handled
}
