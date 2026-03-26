import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { verifyAgent } from './auth.js';
import { encodeKey } from './encryption.js';
import { agents, pendingAgentConnections } from './context.js';
import {
  parseMessage, broadcastAgentList, clearAgentDirCache
} from './ws-utils.js';
import { handleAgentConversation } from './handlers/agent-conversation.js';
import { handleAgentOutput } from './handlers/agent-output.js';
import { handleAgentCrew } from './handlers/agent-crew.js';
import { handleAgentFileTerminal } from './handlers/agent-file-terminal.js';
import { handleAgentSync } from './handlers/agent-sync.js';

/**
 * Build the internal Map key for an agent.
 * Uses `${ownerId}:${agentName}` to prevent different users' same-named
 * agents from colliding. Global (AGENT_SECRET) connections use `global:`.
 */
function buildAgentMapKey(ownerId, agentName) {
  const prefix = ownerId || 'global';
  return `${prefix}:${agentName}`;
}

export function handleAgentConnection(ws, url) {
  const clientAgentId = url.searchParams.get('id') || randomUUID();
  const agentName = url.searchParams.get('name') || `Agent-${clientAgentId.slice(0, 8)}`;
  const workDir = url.searchParams.get('workDir') || '';

  // In development mode (SKIP_AUTH), register immediately
  if (CONFIG.skipAuth) {
    // Dev mode: no owner isolation, use clientAgentId as-is for backward compat
    const capabilities = (url.searchParams.get('capabilities') || '').split(',').filter(Boolean);
    completeAgentRegistration(ws, clientAgentId, agentName, workDir, null, capabilities);

    ws.on('message', async (data) => {
      const agent = agents.get(clientAgentId);
      if (!agent) {
        console.error(`[Agent] No agent found for id: ${clientAgentId}`);
        return;
      }
      const msg = await parseMessage(data, agent.sessionKey);
      if (msg) {
        console.log(`[Agent] Received message from ${clientAgentId}: ${msg.type}`);
        handleAgentMessage(clientAgentId, msg);
      } else {
        console.error(`[Agent] Failed to parse message from ${clientAgentId}`);
      }
    });

    ws.on('close', () => {
      handleAgentDisconnect(clientAgentId, agentName);
    });

    ws.on('error', (err) => {
      console.error(`Agent error (${agentName}):`, err.message);
    });
    return;
  }

  // In production mode, wait for auth message with secret
  const tempId = randomUUID();
  // Mutable: will be updated to the owner-scoped key after auth succeeds
  let resolvedAgentId = null;

  const authTimeout = setTimeout(() => {
    console.log(`Agent auth timeout: ${agentName}`);
    pendingAgentConnections.delete(tempId);
    ws.close(1008, 'Authentication timeout');
  }, 30000);

  pendingAgentConnections.set(tempId, {
    ws,
    agentId: clientAgentId,
    agentName,
    workDir,
    timeout: authTimeout
  });

  // Request authentication
  ws.send(JSON.stringify({
    type: 'auth_required',
    tempId
  }));

  ws.on('message', async (data) => {
    const pending = pendingAgentConnections.get(tempId);
    if (pending) {
      // Still pending authentication
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth' && msg.tempId === tempId) {
          clearTimeout(pending.timeout);
          pendingAgentConnections.delete(tempId);

          const authResult = verifyAgent(msg.secret);
          if (!authResult.valid) {
            console.log(`Agent auth failed: ${agentName}`);
            ws.close(1008, 'Invalid agent secret');
            return;
          }

          const capabilities = msg.capabilities || [];
          const agentVersion = msg.version || null;
          // Build owner-scoped key to prevent cross-user collision
          resolvedAgentId = buildAgentMapKey(authResult.userId, pending.agentName);
          completeAgentRegistration(ws, resolvedAgentId, pending.agentName, pending.workDir, authResult.sessionKey, capabilities, authResult.userId, authResult.username, agentVersion);
        }
      } catch (e) {
        console.error('Failed to parse agent auth message:', e.message);
      }
    } else {
      // Already authenticated, handle normally
      if (!resolvedAgentId) return;
      const agent = agents.get(resolvedAgentId);
      if (!agent) {
        console.error(`[Agent] No agent found for id: ${resolvedAgentId}`);
        return;
      }
      const msg = await parseMessage(data, agent.sessionKey);
      if (msg) {
        console.log(`[Agent] Received message from ${resolvedAgentId}: ${msg.type}`);
        handleAgentMessage(resolvedAgentId, msg);
      } else {
        console.error(`[Agent] Failed to parse message from ${resolvedAgentId}`);
      }
    }
  });

  ws.on('close', () => {
    const pending = pendingAgentConnections.get(tempId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAgentConnections.delete(tempId);
    }
    // Use resolvedAgentId if auth completed, otherwise nothing to clean
    if (resolvedAgentId) {
      handleAgentDisconnect(resolvedAgentId, agentName);
    }
  });

  ws.on('error', (err) => {
    console.error(`Agent error (${agentName}):`, err.message);
  });
}

/**
 * Shared disconnect handler: clean up and remove agent from the agents Map.
 * Conversations are persisted in DB and will be restored on reconnect via
 * get_agents (client-side recovery) and conversation_list (agent-side sync).
 */
function handleAgentDisconnect(agentId, agentName) {
  const agent = agents.get(agentId);
  // Phase 4: 清理目录缓存
  clearAgentDirCache(agentId);
  // Phase 1: 清理同步超时
  if (agent?._syncTimeout) {
    clearTimeout(agent._syncTimeout);
  }
  // Remove agent entirely — eliminates zombie agents from broadcastAgentList
  agents.delete(agentId);
  console.log(`Agent disconnected: ${agentName}`);
  broadcastAgentList();
}

function completeAgentRegistration(ws, agentId, agentName, workDir, sessionKey, capabilities = [], ownerId = null, ownerUsername = null, agentVersion = null) {
  // 如果是重连，保留 conversations；否则（server 重启）创建空 Map
  const existingAgent = agents.get(agentId);
  const conversations = existingAgent?.conversations || new Map();
  const proxyPorts = (existingAgent?.proxyPorts || []).map(p => ({ ...p, enabled: false }));

  // 兼容旧版 agent：未上报 capabilities 时默认全部开启
  const effectiveCapabilities = capabilities.length > 0
    ? capabilities
    : ['terminal', 'file_editor', 'background_tasks'];

  agents.set(agentId, {
    ws,
    name: agentName,
    workDir,
    conversations,
    sessionKey,
    isAlive: true,
    capabilities: effectiveCapabilities,
    proxyPorts,
    status: 'syncing',
    ownerId,
    ownerUsername,
    version: agentVersion
  });

  // 同步超时保护：30 秒后强制 ready
  const syncTimeout = setTimeout(() => {
    const ag = agents.get(agentId);
    if (ag && ag.status === 'syncing') {
      console.warn(`[Sync] Agent ${agentName} sync timeout, forcing ready`);
      ag.status = 'ready';
      broadcastAgentList();
    }
  }, 30000);
  agents.get(agentId)._syncTimeout = syncTimeout;

  // 心跳响应处理 + latency 测量
  ws.on('pong', () => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.isAlive = true;
      if (agent.pingSentAt) {
        agent.latency = Date.now() - agent.pingSentAt;
        agent.pingSentAt = null;
      }
    }
  });

  // Send registration (with session key only in production mode)
  const latestAgentVersion = process.env.AGENT_LATEST_VERSION || null;
  const upgradeAvailable = (latestAgentVersion && agentVersion && latestAgentVersion !== agentVersion) ? latestAgentVersion : null;

  ws.send(JSON.stringify({
    type: 'registered',
    agentId,
    sessionKey: sessionKey ? encodeKey(sessionKey) : null,
    ...(upgradeAvailable && { upgradeAvailable })
  }));

  console.log(`Agent connected: ${agentName} (${agentId})`);
  broadcastAgentList();
}

async function handleAgentMessage(agentId, msg) {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Security: 需要 conversationId 的消息类型，验证该 conversation 属于此 agent
  const CONV_EXEMPT_TYPES = new Set([
    'conversation_list', 'conversation_created', 'conversation_resumed',
    'agent_sync_complete', 'sync_sessions', 'proxy_response', 'proxy_response_chunk',
    'proxy_response_end', 'proxy_ports_update', 'proxy_ws_opened', 'proxy_ws_message',
    'proxy_ws_closed', 'proxy_ws_error', 'restart_agent_ack', 'upgrade_agent_ack',
    'directory_listing', 'folders_list'
  ]);
  if (msg.conversationId && !CONV_EXEMPT_TYPES.has(msg.type)) {
    if (!agent.conversations.has(msg.conversationId)) {
      console.warn(`[Security] Agent ${agentId} sent ${msg.type} for unknown conversation ${msg.conversationId}, ignoring`);
      return;
    }
  }

  // Dispatch to handler sub-modules
  if (await handleAgentConversation(agentId, agent, msg)) return;
  if (await handleAgentOutput(agentId, agent, msg)) return;
  if (await handleAgentCrew(agentId, agent, msg)) return;
  if (await handleAgentFileTerminal(agentId, agent, msg)) return;
  if (await handleAgentSync(agentId, agent, msg)) return;
}
