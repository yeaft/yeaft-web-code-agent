import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { verifyToken, generateSkipAuthSession } from './auth.js';
import { encodeKey } from './encryption.js';
import { userDb } from './database.js';
import { agents, webClients, trackRequest } from './context.js';
import {
  parseMessage, sendToWebClient, sendToAgent,
  broadcastAgentList, resolveAgentAccessError
} from './ws-utils.js';
import { handleClientConversation } from './handlers/client-conversation.js';
import { handleClientWorkbench } from './handlers/client-workbench.js';
import { handleClientMisc } from './handlers/client-misc.js';
import { recordPerfTraceEvent } from './perf-trace.js';

export function handleWebConnection(ws, url) {
  const clientId = randomUUID();
  const token = url.searchParams.get('token');

  let authenticated = false;
  let sessionKey = null;
  let username = null;
  let userId = null;
  let role = null;

  // Check for skip auth mode
  if (CONFIG.skipAuth) {
    authenticated = true;
    const session = generateSkipAuthSession();
    sessionKey = session.sessionKey;
    username = 'dev-user';
    role = 'admin';
  } else if (token) {
    const result = verifyToken(token);
    if (result.valid) {
      authenticated = true;
      sessionKey = result.sessionKey;
      username = result.username;
      role = result.role === 'admin' ? 'admin' : 'pro';
    }
  }

  // 获取或创建用户
  if (authenticated && username) {
    try {
      const user = userDb.getOrCreate(username);
      userId = user.id;
      userDb.updateLogin(userId);
    } catch (e) {
      console.error('Failed to get/create user:', e.message);
    }
  }

  webClients.set(clientId, {
    ws,
    authenticated,
    username,
    userId,
    role,
    currentAgent: null,
    currentConversation: null,
    sessionKey,
    isAlive: true,
    // feat-ws-plaintext-negotiation: per-client flag. Defaults `true`
    // (= old client, encrypt outbound for back-compat). Flipped to
    // `false` when the client sends `client_hello { plaintextOk: true }`
    // — see early dispatch in handleWebMessage.
    encryptOutbound: true
  });

  // 心跳响应处理
  ws.on('pong', () => {
    const client = webClients.get(clientId);
    if (client) client.isAlive = true;
  });

  console.log(`Web client connected: ${clientId} (authenticated: ${authenticated})`);

  const client = webClients.get(clientId);

  if (authenticated) {
    // Send auth result unencrypted (client doesn't have key yet).
    // `acceptPlaintext: true` advertises that this server will accept
    // plaintext from a new client. Old clients ignore the unknown field.
    // The corresponding flip on the server side (stop encrypting outbound
    // to this client) happens when the new client confirms it can speak
    // plaintext via the `client_hello` frame — see handleWebMessage.
    ws.send(JSON.stringify({
      type: 'auth_result',
      success: true,
      sessionKey: sessionKey ? encodeKey(sessionKey) : null,
      role,
      acceptPlaintext: true
    }));
    setTimeout(() => broadcastAgentList(), 100);
  } else {
    ws.send(JSON.stringify({ type: 'auth_result', success: false, error: 'Authentication required' }));
    ws.close(1008, 'Authentication required');
    return;
  }

  ws.on('message', async (data) => {
    const client = webClients.get(clientId);
    const msg = await parseMessage(data, client?.sessionKey);
    if (!msg) return;
    // Stats tracking: exclude ping heartbeats from request count
    if (msg.type !== 'ping') {
      trackRequest(client?.userId, data.length || 0);
    }
    if (msg.perfTraceId) {
      recordPerfTraceEvent({
        traceId: msg.perfTraceId,
        source: 'server',
        phase: 'websocket.web_received',
        at: Date.now(),
        userId: client?.userId || null,
        agentId: msg.agentId || client?.currentAgent || null,
        sessionId: msg.sessionId || null,
        messageType: msg.type,
        bytes: data.length || 0,
      });
    }
    handleWebMessage(clientId, msg);
  });

  ws.on('close', () => {
    const client = webClients.get(clientId);
    // Web 客户端断开时，检查是否需要禁用其关联 Agent 的端口
    if (client?.currentAgent) {
      const agentId = client.currentAgent;
      const agent = agents.get(agentId);
      if (agent?.proxyPorts?.length > 0) {
        // 检查是否还有其他 Web 客户端连接到同一个 agent
        let otherClientsOnAgent = false;
        for (const [otherId, otherClient] of webClients.entries()) {
          if (otherId !== clientId && otherClient.currentAgent === agentId && otherClient.ws.readyState === WebSocket.OPEN) {
            otherClientsOnAgent = true;
            break;
          }
        }
        // 只有当没有其他 Web 客户端连接到同一 agent 时才禁用
        if (!otherClientsOnAgent) {
          agent.proxyPorts = agent.proxyPorts.map(p => ({ ...p, enabled: false }));
          if (agent.ws.readyState === WebSocket.OPEN) {
            sendToAgent(agent, { type: 'proxy_update_ports', ports: agent.proxyPorts });
          }
          broadcastAgentList();
        }
      }
    }
    webClients.delete(clientId);
    console.log(`Web client disconnected: ${clientId}`);
  });

  ws.on('error', (err) => {
    console.error(`Web client error (${clientId}):`, err.message);
  });
}

// Workbench 功能（terminal、file、git、proxy）仅 admin/pro 可用
const WORKBENCH_TYPES = new Set([
  'terminal_create', 'terminal_input', 'terminal_resize', 'terminal_close',
  'read_file', 'write_file', 'create_file', 'delete_files', 'move_files', 'copy_files', 'upload_to_dir', 'file_search',
  'git_status', 'git_diff', 'git_add', 'git_reset', 'git_restore', 'git_commit', 'git_push',
  'proxy_update_ports', 'update_file_tabs', 'restore_file_tabs'
]);

async function handleWebMessage(clientId, msg) {
  const client = webClients.get(clientId);
  if (!client || !client.authenticated) return;

  // feat-ws-plaintext-negotiation: early capability frame from new web
  // clients. Tells the server "you may stop encrypting outbound to me".
  // Old clients never send this; their per-client `encryptOutbound` flag
  // stays `true` and we keep the ciphertext path.
  if (msg.type === 'client_hello') {
    if (msg.plaintextOk === true) {
      client.encryptOutbound = false;
      console.log(`[WS] Client ${clientId} negotiated plaintext mode`);
    }
    return;
  }

  // Workbench 权限检查：仅 admin 和 pro 可用（当前所有用户都是 pro 或 admin）
  if (!CONFIG.skipAuth && WORKBENCH_TYPES.has(msg.type) && client.role !== 'admin' && client.role !== 'pro') {
    console.warn(`[Security] User ${client.userId} (role=${client.role}) denied workbench action: ${msg.type}`);
    await sendToWebClient(client, { type: 'error', message: 'Permission denied: workbench access requires pro or admin role' });
    return;
  }

  // Helper: check agent access (ownership + availability)
  const checkAgentAccess = async (agentId) => {
    const error = resolveAgentAccessError(agentId, client.userId, client.role);
    if (!error) return true;
    if (error === 'Agent access denied') {
      console.warn(`[Security] User ${client.userId} denied access to agent ${agentId}`);
    } else {
      console.warn(`[WS] Agent unavailable for user ${client.userId}: ${agentId || '(none)'}`);
    }
    await sendToWebClient(client, { type: 'error', message: error });
    return false;
  };

  // Dispatch to handler sub-modules
  if (await handleClientConversation(clientId, client, msg, checkAgentAccess)) return;
  if (await handleClientWorkbench(clientId, client, msg, checkAgentAccess)) return;
  if (await handleClientMisc(clientId, client, msg, checkAgentAccess)) return;
}
