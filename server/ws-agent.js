import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { verifyAgent } from './auth.js';

import { encodeKey } from './encryption.js';
import { agents, pendingAgentConnections, takeAgentSettingsRequestsForAgent, webClients } from './context.js';
import { agentInventoryDb, userDb } from './database.js';
import {
  parseMessage, broadcastAgentList, clearAgentDirCache, sendToWebClient
} from './ws-utils.js';
import { handleAgentConversation } from './handlers/agent-conversation.js';
import { handleAgentOutput } from './handlers/agent-output.js';
import { handleAgentWorkCenter } from './handlers/agent-work-center.js';
import { handleAgentFileTerminal } from './handlers/agent-file-terminal.js';
import { handleAgentSync } from './handlers/agent-sync.js';
import { recordPerfTraceEvent } from './perf-trace.js';
import { clearWorkbenchCorrelationsForAgent } from './workbench-correlation.js';
import { clearBrowserRuntimeForAgent } from './browser-runtime-routes.js';
import { clearFileContentAssembliesForAgent } from './file-content-assembly.js';
import { handleAgentBrowser } from './handlers/agent-browser.js';
import { markAgentHeartbeatSeen } from './heartbeat-policy.js';

/**
 * Build the internal Map key for an agent.
 * Uses `${ownerId}:${agentName}` to prevent different users' same-named
 * agents from colliding. Global (AGENT_SECRET) connections use `global:`.
 */
function buildAgentMapKey(ownerId, agentName) {
  const prefix = ownerId || 'global';
  return `${prefix}:${agentName}`;
}

function parseSemver(version) {
  const match = String(version || '').trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function isNewerAgentVersion(candidate, current) {
  const next = parseSemver(candidate);
  const installed = parseSemver(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next.core[index] !== installed.core[index]) return next.core[index] > installed.core[index];
  }
  if (next.prerelease.length === 0 || installed.prerelease.length === 0) {
    return next.prerelease.length === 0 && installed.prerelease.length > 0;
  }
  const length = Math.max(next.prerelease.length, installed.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = next.prerelease[index];
    const right = installed.prerelease[index];
    if (left === right) continue;
    if (left === undefined || right === undefined) return right === undefined;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) > Number(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return left > right;
  }
  return false;
}

let nextAgentConnectionGeneration = 0;
// Keep the latest generation as a tombstone while an older auth may still arrive.
const latestAgentConnectionGenerations = new Map();

function claimAgentConnection(agentId, generation) {
  const latestGeneration = latestAgentConnectionGenerations.get(agentId);
  if (latestGeneration !== undefined && latestGeneration > generation) return false;
  latestAgentConnectionGenerations.set(agentId, generation);
  return true;
}

function pruneAgentConnectionGenerations() {
  for (const [agentId, generation] of latestAgentConnectionGenerations) {
    if (agents.has(agentId)) continue;
    const hasPotentiallyOlderConnection = [...pendingAgentConnections.values()].some(pending => {
      if (pending.connectionGeneration >= generation) return false;
      return pending.skipAgentAuth ? pending.agentId === agentId : true;
    });
    if (!hasPotentiallyOlderConnection) latestAgentConnectionGenerations.delete(agentId);
  }
}

function persistAgentInventory(agentId, agent) {
  if (!agentInventoryDb?.upsert || !agent?.name) return;
  try {
    agentInventoryDb.upsert({
      ...agent,
      id: agentId,
      lastSeenAt: agent.lastSeenAt,
      lastConnectedAt: agent.lastConnectedAt,
    });
  } catch (error) {
    // The inventory is an admin read model. Never reject a live Agent because
    // this best-effort durability write failed.
    console.error(`[AgentInventory] Failed to persist ${agentId}:`, error.message);
  }
}

function persistAgentHeartbeat(agentId, agent, now = Date.now()) {
  if (!agentInventoryDb?.touch || !agent) return;
  const lastPersistedAt = Number(agent.inventoryLastPersistedAt) || 0;
  if (lastPersistedAt && now - lastPersistedAt < 10_000) return;
  agent.inventoryLastPersistedAt = now;
  try {
    const touched = agentInventoryDb.touch(agentId, now);
    if (touched === false) persistAgentInventory(agentId, agent);
  } catch (error) {
    console.error(`[AgentInventory] Failed to persist heartbeat for ${agentId}:`, error.message);
  }
}

export function handleAgentConnection(ws, url) {
  const clientAgentId = url.searchParams.get('id') || randomUUID();
  const agentName = url.searchParams.get('name') || `Agent-${clientAgentId.slice(0, 8)}`;
  const instanceId = url.searchParams.get('instanceId') || clientAgentId;
  const workDir = url.searchParams.get('workDir') || '';
  const urlPlatform = url.searchParams.get('platform') || null;

  // Both authenticated and SKIP_AUTH connections use the existing auth frame
  // for registration metadata. Released Agents already send their version there;
  // SKIP_AUTH only bypasses secret validation and owner scoping.
  const skipAgentAuth = CONFIG.skipAuth;
  const urlCapabilities = (url.searchParams.get('capabilities') || '').split(',').filter(Boolean);
  const connectionGeneration = ++nextAgentConnectionGeneration;

  // SKIP_AUTH has a complete identity at connect time. Authenticated connections
  // can only claim an owner-scoped identity after their secret is verified.
  if (skipAgentAuth) claimAgentConnection(clientAgentId, connectionGeneration);

  const tempId = randomUUID();
  // Mutable: will be updated to the owner-scoped key after auth succeeds
  let resolvedAgentId = null;

  const authTimeout = setTimeout(() => {
    console.log(`Agent auth timeout: ${agentName}`);
    pendingAgentConnections.delete(tempId);
    pruneAgentConnectionGenerations();
    ws.close(1008, 'Authentication timeout');
  }, 30000);

  pendingAgentConnections.set(tempId, {
    ws,
    agentId: clientAgentId,
    agentName,
    instanceId,
    workDir,
    skipAgentAuth,
    connectionGeneration,
    timeout: authTimeout
  });

  // Request the existing registration frame. SKIP_AUTH ignores its secret.
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

          const authResult = msg.authKind
            ? { valid: false, sessionKey: null, userId: null, username: null }
            : skipAgentAuth
              ? { valid: true, sessionKey: null, userId: null, username: null }
              : verifyAgent(msg.secret);
          if (!authResult.valid) {
            pruneAgentConnectionGenerations();
            console.log(`Agent auth failed: ${agentName}`);
            ws.close(1008, 'Invalid agent secret');
            return;
          }

          const authCapabilitiesProvided = Array.isArray(msg.capabilities);
          // Modern Agents always include this query key, including for an
          // explicit empty list. The key's presence is the metadata signal;
          // its value only determines the effective capability list.
          const urlCapabilitiesProvided = url.searchParams.has('capabilities');
          const capabilityMetadataProvided = authCapabilitiesProvided || urlCapabilitiesProvided;
          const capabilities = authCapabilitiesProvided ? msg.capabilities : urlCapabilities;
          const agentVersion = msg.version || null;
          const agentPlatform = typeof msg.platform === 'string' && msg.platform
            ? msg.platform
            : urlPlatform;
          // Local no-auth mode still has one durable browser owner. This makes
          // the server-side Session catalog persistent without changing generic
          // development-server behavior, which remains ownerless.
          const localOwner = skipAgentAuth && process.env.YEAFT_LOCAL_RUN === 'true'
            ? userDb.getOrCreate('dev-user')
            : null;
          const ownerId = localOwner?.id || authResult.userId;
          const ownerUsername = localOwner?.username || authResult.username || null;
          const registeredInstanceId = pending.instanceId || pending.agentId || pending.agentName;
          // Authenticated Agents use an owner-scoped key. SKIP_AUTH preserves
          // its historical unscoped id while still receiving version metadata.
          resolvedAgentId = skipAgentAuth
            ? clientAgentId
            : buildAgentMapKey(ownerId, registeredInstanceId);
          if (!claimAgentConnection(resolvedAgentId, connectionGeneration)) {
            resolvedAgentId = null;
            pruneAgentConnectionGenerations();
            ws.close(1008, 'Superseded by a newer Agent connection');
            return;
          }
          completeAgentRegistration(
            ws,
            resolvedAgentId,
            pending.agentName,
            pending.workDir,
            authResult.sessionKey,
            capabilities,
            capabilityMetadataProvided,
            ownerId,
            ownerUsername,
            agentVersion,
            registeredInstanceId,
            agentPlatform,
          );
          pruneAgentConnectionGenerations();
        }
      } catch (e) {
        pruneAgentConnectionGenerations();
        console.error('Failed to parse agent auth message:', e.message);
      }
    } else {
      // Already authenticated, handle normally
      if (!resolvedAgentId) return;
      const agent = agents.get(resolvedAgentId);
      if (!agent || agent.ws !== ws) {
        if (!agent) console.error(`[Agent] No agent found for id: ${resolvedAgentId}`);
        return;
      }
      if (!skipAgentAuth && agent.ownerId && !userDb.isActive(agent.ownerId)) {
        ws.close(1008, 'Account disabled');
        return;
      }
      const now = Date.now();
      markAgentHeartbeatSeen(agent, now);
      persistAgentHeartbeat(resolvedAgentId, agent, now);
      const msg = await parseMessage(data, agent.sessionKey);
      if (msg) {
        console.log(`[Agent] Received message from ${resolvedAgentId}: ${msg.type}`);
        if (msg.perfTraceId) {
          recordPerfTraceEvent({
            traceId: msg.perfTraceId,
            source: 'server',
            phase: 'websocket.agent_received',
            at: Date.now(),
            agentId: resolvedAgentId,
            sessionId: msg.sessionId || null,
            vpId: msg.vpId || null,
            turnId: msg.turnId || null,
            threadId: msg.threadId || null,
            messageType: msg.type,
            bytes: data.length || 0,
          });
        }
        handleAgentMessage(resolvedAgentId, msg, ws);
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
      pruneAgentConnectionGenerations();
    }
    // Use resolvedAgentId if auth completed, otherwise nothing to clean
    if (resolvedAgentId) {
      handleAgentDisconnect(resolvedAgentId, agentName, ws);
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
function handleAgentDisconnect(agentId, agentName, ws) {
  const agent = agents.get(agentId);
  if (!agent || agent.ws !== ws) return;
  // Capture the last in-memory heartbeat before removing the live socket. The
  // durable row remains an offline historical record; it never grants access.
  persistAgentInventory(agentId, agent);
  // Phase 4: 清理目录缓存
  clearAgentDirCache(agentId);
  clearWorkbenchCorrelationsForAgent(agentId);
  clearFileContentAssembliesForAgent(agentId);
  clearBrowserRuntimeForAgent(agentId);
  for (const pending of takeAgentSettingsRequestsForAgent(agentId)) {
    const client = webClients.get(pending.clientId);
    if (!client?.authenticated) continue;
    const responseTypes = {
      restart: 'restart_agent_ack', dream: 'dream_enabled_changed', upgrade: 'upgrade_agent_ack',
      'plugins:load': 'yeaft_plugins', 'plugins:update': 'yeaft_plugins_updated',
      'telemetry:load': 'telemetry_settings', 'telemetry:update': 'telemetry_settings_updated',
    };
    void sendToWebClient(client, {
      type: responseTypes[pending.operation] || 'agent_request_error',
      agentId,
      requestId: pending.requestId,
      error: 'Agent disconnected before completing the request.',
    });
  }
  // Phase 1: 清理同步超时
  if (agent._syncTimeout) {
    clearTimeout(agent._syncTimeout);
  }
  // Remove agent entirely — eliminates zombie agents from broadcastAgentList
  agents.delete(agentId);
  pruneAgentConnectionGenerations();
  console.log(`Agent disconnected: ${agentName}`);
  broadcastAgentList();
}

function completeAgentRegistration(ws, agentId, agentName, workDir, sessionKey, capabilities = [], capabilityMetadataProvided = false, ownerId = null, ownerUsername = null, agentVersion = null, instanceId = null, agentPlatform = null) {
  // 如果是重连，保留 conversations；否则（server 重启）创建空 Map
  const existingAgent = agents.get(agentId);
  const conversations = existingAgent?.conversations || new Map();
  const proxyPorts = (existingAgent?.proxyPorts || []).map(p => ({ ...p, enabled: false }));
  const slashCommands = existingAgent?.slashCommands || [];
  const slashCommandDescriptions = existingAgent?.slashCommandDescriptions || {};
  const yeaftSessions = existingAgent?.yeaftSessions || new Map();
  if (existingAgent?._syncTimeout) clearTimeout(existingAgent._syncTimeout);

  // 兼容旧版 agent：未上报 capabilities 时默认全部开启
  const effectiveCapabilities = capabilities.length > 0
    ? capabilities
    : ['terminal', 'file_editor', 'background_tasks'];

  // feat-ws-plaintext-negotiation: new agents advertise `plaintext-ok` in
  // their capability list (either via the URL query string in skipAuth
  // path or in the `auth` frame in prod path). When absent, treat as old
  // agent and keep encrypting outbound (back-compat).
  const encryptOutbound = !effectiveCapabilities.includes('plaintext-ok');

  const latestAgentVersion = process.env.AGENT_LATEST_VERSION || null;
  // This environment value is only an optional push hint. It is not a registry
  // query and must never claim an equal, older, or malformed version is newer.
  const upgradeAvailable = isNewerAgentVersion(latestAgentVersion, agentVersion)
    ? latestAgentVersion
    : null;

  agents.set(agentId, {
    ws,
    name: agentName,
    instanceId,
    workDir,
    conversations,
    sessionKey,
    isAlive: true,
    lastSeenAt: Date.now(),
    lastConnectedAt: Date.now(),
    capabilities: effectiveCapabilities,
    // The fallback list supports old UI features but cannot prove that an
    // Agent made an explicit capability claim.
    capabilityMetadataProvided,
    proxyPorts,
    slashCommands,
    slashCommandDescriptions,
    yeaftSessions,
    status: 'syncing',
    ownerId,
    ownerUsername,
    version: agentVersion,
    upgradeAvailable,
    platform: agentPlatform,
    encryptOutbound
  });

  const syncTimeout = setTimeout(() => {
    const ag = agents.get(agentId);
    if (ag?.ws === ws && ag.status === 'syncing') {
      console.warn(`[Sync] Agent ${agentName} sync timeout, forcing ready`);
      ag.status = 'ready';
      broadcastAgentList();
    }
  }, 30000);
  agents.get(agentId)._syncTimeout = syncTimeout;
  persistAgentInventory(agentId, agents.get(agentId));

  if (existingAgent?.ws && existingAgent.ws !== ws) {
    clearBrowserRuntimeForAgent(agentId);
    existingAgent.ws.close(1008, 'Superseded by a newer Agent connection');
  }

  // 心跳响应处理 + latency 测量
  ws.on('pong', () => {
    const agent = agents.get(agentId);
    if (agent?.ws === ws) {
      const now = Date.now();
      markAgentHeartbeatSeen(agent, now);
      persistAgentHeartbeat(agentId, agent, now);
      if (agent.pingSentAt) {
        agent.latency = Date.now() - agent.pingSentAt;
        agent.pingSentAt = null;
      }
    }
  });

  // Send registration (with session key only in production mode)
  ws.send(JSON.stringify({
    type: 'registered',
    agentId,
    sessionKey: sessionKey ? encodeKey(sessionKey) : null,
    // feat-ws-plaintext-negotiation: tell new agents that this server
    // will accept plaintext outbound from them. Old agents ignore the
    // unknown field. New agents flip `serverEncryptionRequired = false`
    // and stop calling encrypt() on the send path.
    acceptPlaintext: true,
    serverCapabilities: ['workbench_file_content_chunks'],
    ...(upgradeAvailable && { upgradeAvailable })
  }));

  console.log(`Agent connected: ${agentName} (${agentId})${encryptOutbound ? '' : ' [plaintext mode]'}`);
  broadcastAgentList();
}

async function handleAgentMessage(agentId, msg, ws) {
  const agent = agents.get(agentId);
  if (!agent || agent.ws !== ws) return;

  // Security: 需要 conversationId 的消息类型，验证该 conversation 属于此 agent.
  // The conversation-id check only authorizes Chat flows where the
  // conversationId IS the ownership key. Workbench responses and Yeaft
  // events use `_requestUserId` for ownership (enforced in
  // `forwardToClients`), so they bypass this gate. See PR #772.
  const CONV_EXEMPT_TYPES = new Set([
    'conversation_list', 'conversation_created', 'conversation_resumed',
    'agent_sync_complete', 'sync_sessions', 'proxy_response', 'proxy_response_chunk',
    'proxy_response_end', 'proxy_ports_update', 'proxy_ws_opened', 'proxy_ws_message',
    'proxy_ws_closed', 'proxy_ws_error', 'restart_agent_ack', 'upgrade_agent_ack',
    'directory_listing', 'folders_list', 'models_list', 'yeaft_output', 'yeaft_session_output', 'session_output', 'yeaft_asset_put',
    'yeaft_history_chunk', 'yeaft_history_outline', 'yeaft_history_search_result', 'yeaft_history_window', 'slash_commands_update', 'agent_metrics',
    'file_content', 'file_content_chunk', 'video_metadata', 'video_chunk', 'file_saved', 'file_op_result', 'file_search_result',
    'git_status_result', 'git_diff_result', 'git_op_result',
    'terminal_created', 'terminal_output', 'terminal_closed', 'terminal_error',
    'agent_capabilities_updated', 'browser_runtime_status_result', 'browser_runtime_install_progress', 'browser_runtime_error',
    'browser_session_created', 'browser_session_error', 'browser_session_snapshot', 'browser_session_list_result',
    'browser_peer_prepared', 'browser_peer_offer', 'browser_peer_ice_candidate', 'browser_peer_state', 'browser_peer_error'
  ]);
  if (msg.conversationId && !CONV_EXEMPT_TYPES.has(msg.type)) {
    if (!agent.conversations.has(msg.conversationId)) {
      console.warn(`[Security] Agent ${agentId} sent ${msg.type} for unknown conversation ${msg.conversationId}, ignoring`);
      return;
    }
  }

  // Dispatch to handler sub-modules
  if (await handleAgentConversation(agentId, agent, msg)) return;
  if (await handleAgentBrowser(agentId, agent, msg)) return;
  if (await handleAgentWorkCenter(agentId, msg)) return;
  if (await handleAgentOutput(agentId, agent, msg)) return;
  if (await handleAgentFileTerminal(agentId, agent, msg)) return;
  if (await handleAgentSync(agentId, agent, msg)) return;
}
