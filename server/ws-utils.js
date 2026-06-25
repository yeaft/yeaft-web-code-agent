import { WebSocket } from 'ws';
import { CONFIG } from './config.js';
import { encrypt, decrypt, isEncrypted, encodeKey } from './encryption.js';
import { sessionDb } from './database.js';
import { agents, webClients, directoryCache, DIR_CACHE_TTL, DIR_CACHE_MAX_SIZE, trackBytesSent } from './context.js';

// Send message to web client.
// feat-ws-plaintext-negotiation: defaults to plaintext when the client
// advertised plaintext-ok capability via client_hello (encryptOutbound
// flipped to false). Falls back to ciphertext for old clients that
// haven't sent client_hello — back-compat. skipAuth still forces
// plaintext for local dev visibility.
export async function sendToWebClient(client, msg) {
  if (client.ws.readyState !== WebSocket.OPEN) return;

  // Plaintext path: dev mode OR new client that announced plaintext-ok.
  if (CONFIG.skipAuth || client.encryptOutbound === false) {
    const payload = JSON.stringify(msg);
    trackBytesSent(client.userId, payload.length);
    client.ws.send(payload);
    return;
  }

  // Encrypted fallback for old clients that never sent client_hello.
  if (!client.sessionKey) {
    console.error('Cannot send to client: missing session key in production mode');
    client.ws.close(1008, 'Encryption required');
    return;
  }
  try {
    const encrypted = await encrypt(msg, client.sessionKey);
    const payload = JSON.stringify(encrypted);
    trackBytesSent(client.userId, payload.length);
    if (msg.type === 'file_content') console.log(`[sendToWebClient] file_content encrypted, payload size=${payload.length}, compressed=${encrypted.z}`);
    client.ws.send(payload);
  } catch (e) {
    console.error(`[sendToWebClient] Error encrypting/sending ${msg.type}:`, e.message, e.stack);
  }
}

// Send message to agent.
// feat-ws-plaintext-negotiation: same shape as sendToWebClient — defaults
// to plaintext when the agent advertised the `plaintext-ok` capability.
// Falls back to ciphertext for old agents that haven't.
export async function sendToAgent(agent, msg) {
  if (agent.ws.readyState !== WebSocket.OPEN) return;

  if (CONFIG.skipAuth || agent.encryptOutbound === false) {
    agent.ws.send(JSON.stringify(msg));
    return;
  }

  if (!agent.sessionKey) {
    console.error('Cannot send to agent: missing session key in production mode');
    agent.ws.close(1008, 'Encryption required');
    return;
  }
  const encrypted = await encrypt(msg, agent.sessionKey);
  agent.ws.send(JSON.stringify(encrypted));
}

// Parse incoming message (decrypt if needed)
export async function parseMessage(data, sessionKey) {
  try {
    const parsed = JSON.parse(data.toString());

    if (sessionKey && isEncrypted(parsed)) {
      return await decrypt(parsed, sessionKey);
    }

    return parsed;
  } catch (e) {
    console.error('Failed to parse message:', e.message);
    return null;
  }
}

// 广播 agent 列表给所有已认证的 web 客户端（按 owner 过滤）
export async function broadcastAgentList() {
  for (const [, client] of webClients) {
    if (client.authenticated) {
      // 按 owner 过滤：只显示属于该用户的 agent，或 ownerId=null 的全局 agent（仅 admin 可见）
      const agentList = Array.from(agents.entries())
        .filter(([, agent]) =>
          CONFIG.skipAuth ||
          agent.ownerId === client.userId ||
          (!agent.ownerId && client.role === 'admin')
        )
        .map(([id, agent]) => ({
          id,
          name: agent.name,
          instanceId: agent.instanceId || null,
          workDir: agent.workDir,
          online: agent.ws.readyState === WebSocket.OPEN,
          status: agent.status || 'ready',
          latency: agent.latency || null,
          capabilities: agent.capabilities || ['terminal', 'file_editor', 'background_tasks'],
          version: agent.version || null,
          yeaftStatus: agent.yeaftStatus || null,
          proxyPorts: agent.proxyPorts || [],
          conversations: Array.from(agent.conversations.values()).filter(c =>
            CONFIG.skipAuth || !c.userId || c.userId === client.userId
          ).map(c => {
            // fix-chat-title-sticky: lazy-hydrate `customTitle` from
            // the DB whenever it's missing, so pre-fix in-memory
            // convInfo objects (and any future rebuild path that
            // forgets) still produce a correct broadcast.
            if (!c.title || (c.type === 'crew' && !c.name) || c.customTitle === undefined) {
              const dbSession = sessionDb.get(c.id);
              if (dbSession?.title) {
                c.title = c.title || dbSession.title;
                // Crew sessions store name as title in DB
                if (c.type === 'crew' && !c.name) c.name = dbSession.title;
              }
              if (dbSession) {
                c.pinned = !!dbSession.is_pinned;
                if (c.customTitle === undefined) c.customTitle = !!dbSession.customTitle;
              }
            } else {
              const dbSession = sessionDb.get(c.id);
              if (dbSession) c.pinned = !!dbSession.is_pinned;
            }
            return c;
          })
        }));
      await sendToWebClient(client, {
        type: 'agent_list',
        agents: agentList
      });
    }
  }
}

// 发送 conversation 列表给特定客户端
export async function sendConversationList(clientId, agentId) {
  const client = webClients.get(clientId);
  const agent = agents.get(agentId);

  if (client && agent) {
    const filteredConvs = Array.from(agent.conversations.values()).filter(c =>
      CONFIG.skipAuth || !c.userId || c.userId === client.userId
    ).map(c => {
      // fix-chat-title-sticky: same lazy-hydrate as broadcastAgentList —
      // ensure `customTitle` is reliably set on the wire so the
      // per-message auto-title gate stays honest after restart / sync.
      if (!c.title || (c.type === 'crew' && !c.name) || c.customTitle === undefined) {
        const dbSession = sessionDb.get(c.id);
        if (dbSession?.title) {
          c.title = c.title || dbSession.title;
          if (c.type === 'crew' && !c.name) c.name = dbSession.title;
        }
        if (dbSession) {
          c.pinned = !!dbSession.is_pinned;
          if (c.customTitle === undefined) c.customTitle = !!dbSession.customTitle;
        }
      } else {
        const dbSession = sessionDb.get(c.id);
        if (dbSession) c.pinned = !!dbSession.is_pinned;
      }
      return c;
    });
    await sendToWebClient(client, {
      type: 'conversation_list',
      agentId,
      conversations: filteredConvs
    });
  }
}

// 通知会话更新给相关客户端
export async function notifyConversationUpdate(agentId, msg) {
  // 对于 folders_list、history_sessions_list、crew_sessions_list，优先定向发送给请求者
  if (msg.type === 'folders_list' || msg.type === 'history_sessions_list' || msg.type === 'crew_sessions_list' || msg.type === 'crew_exists_result' || msg.type === 'models_list') {
    const targetClientId = msg._requestClientId;
    if (targetClientId) {
      const targetClient = webClients.get(targetClientId);
      if (targetClient?.authenticated) {
        const { _requestClientId, ...cleanMsg } = msg;
        await sendToWebClient(targetClient, cleanMsg);
        return;
      }
      // Target client disconnected/reconnected — fall through to broadcast
    }
    // Fallback: 如果没有 _requestClientId 或 target 不可用，发送给所有已认证客户端
    const { _requestClientId: _, ...cleanMsg } = msg;
    for (const [, client] of webClients) {
      if (client.authenticated) {
        await sendToWebClient(client, cleanMsg);
      }
    }
    return;
  }

  // 对于 conversation_created 和 conversation_resumed，只发送给拥有该会话的用户的客户端
  // 避免其他用户收到后误触发 select_conversation 导致 Permission denied
  if (msg.type === 'conversation_created' || msg.type === 'conversation_resumed') {
    const msgWithAgent = { ...msg, agentId };
    const ownerId = msg.userId;
    for (const [, client] of webClients) {
      // 只发送给已认证且属于同一用户的客户端（或开发模式下所有客户端）
      if (client.authenticated && (!ownerId || CONFIG.skipAuth || client.userId === ownerId)) {
        await sendToWebClient(client, msgWithAgent);
      }
    }
    return;
  }

  for (const [, client] of webClients) {
    if (client.authenticated && client.currentAgent === agentId) {
      await sendToWebClient(client, msg);
    }
  }
}

/**
 * 检查用户是否有权访问指定的 Agent
 * @param {string} agentId
 * @param {string} userId
 * @param {string} [role] - 用户角色，ownerId=null 的全局 agent 仅 admin 可访问
 * @returns {boolean}
 */
export function verifyAgentOwnership(agentId, userId, role = null) {
  if (CONFIG.skipAuth) return true;
  const agent = agents.get(agentId);
  if (!agent) return false;
  if (agent.ownerId === userId) return true;
  // ownerId=null 表示通过全局 AGENT_SECRET 连接，仅 admin 可访问
  if (!agent.ownerId && role === 'admin') return true;
  return false;
}

export function resolveAgentAccessError(agentId, userId, role = null) {
  if (!agentId) return 'Agent not found';
  const agent = agents.get(agentId);
  if (!agent) return 'Agent not found or offline';
  if (!verifyAgentOwnership(agentId, userId, role)) return 'Agent access denied';
  if (agent.ws?.readyState !== WebSocket.OPEN) return 'Agent not found or offline';
  return null;
}

// 转发消息给拥有该会话的用户的所有客户端
export async function forwardToClients(agentId, conversationId, msg) {
  // ★ Security: 从 agent.conversations 获取会话的 userId
  const agent = agents.get(agentId);
  const conv = agent?.conversations.get(conversationId);
  // ★ Security: ownerId 优先级: conversation.userId > _requestUserId > agent.ownerId
  // 确保生产模式下不会因 ownerId 缺失而向所有用户广播
  const ownerId = conv?.userId || msg._requestUserId || agent?.ownerId || null;

  let forwarded = false;
  for (const [clientId, client] of webClients) {
    // 只发送给已认证且属于同一用户的客户端
    // 仅在开发模式下，无 ownerId 时允许广播给所有已认证客户端
    if (client.authenticated && (CONFIG.skipAuth ? (!ownerId || client.userId === ownerId) : (ownerId && client.userId === ownerId))) {
      try {
        await sendToWebClient(client, msg);
        forwarded = true;
        if (msg.type === 'file_content') console.log(`[Forward] file_content sent to client ${clientId}, size=${JSON.stringify(msg).length}`);
      } catch (e) {
        console.error(`[Forward] Error sending ${msg.type} to client ${clientId}:`, e.message);
      }
    } else if (msg.type === 'file_content') {
      console.log(`[Forward] file_content SKIPPED client ${clientId}: auth=${client.authenticated}, ownerId=${ownerId}, clientUserId=${client.userId}`);
    }
  }
  if (!forwarded) {
    if (msg.type === 'file_content') {
      console.warn(`[Forward] file_content NOT forwarded! conv=${conversationId}, agent=${agentId}, ownerId=${ownerId}, _reqUser=${msg._requestUserId}, webClients=${webClients.size}`);
    } else if (msg.type === 'claude_output') {
      console.warn(`[Forward] No authenticated clients for conv=${conversationId}, owner=${ownerId}`);
    } else if (msg.type === 'directory_listing') {
      console.warn(`[Forward] directory_listing NOT forwarded! conv=${conversationId}, agent=${agentId}, ownerId=${ownerId}, _reqUser=${msg._requestUserId}, webClients=${webClients.size}`);
    }
  }
}

// 转发消息给指定 agent
export async function forwardToAgent(agentId, msg) {
  const agent = agents.get(agentId);
  if (agent) {
    await sendToAgent(agent, msg);
  }
}

// 通过 agent name 查找 agent
export function findAgentByName(agentName) {
  for (const [id, agent] of agents) {
    if (agent.name === agentName || id === agentName) {
      return { id, agent };
    }
  }
  return null;
}

/**
 * 检查用户是否拥有指定的会话
 */
export function verifyConversationOwnership(conversationId, userId) {
  if (!conversationId || !userId) {
    console.warn(`[Ownership] Check failed: conversationId=${conversationId}, userId=${userId} (missing parameter)`);
    return false;
  }

  // 先从内存中的 agent conversations 查找
  for (const [agentId, agent] of agents) {
    const conv = agent.conversations.get(conversationId);
    if (conv) {
      // 无 owner 的 conversation（创建时未启用 auth）允许任何已认证用户访问
      if (!conv.userId) return true;
      const match = conv.userId === userId;
      if (!match) {
        console.warn(`[Ownership] Mismatch for ${conversationId}: conv.userId=${conv.userId}, client.userId=${userId}, agent=${agentId}`);
      }
      return match;
    }
  }

  // 再从数据库查找
  try {
    const session = sessionDb.get(conversationId);
    if (session) {
      if (!session.user_id) return true;
      const match = session.user_id === userId;
      if (!match) {
        console.warn(`[Ownership] DB mismatch for ${conversationId}: session.user_id=${session.user_id}, client.userId=${userId}`);
      }
      return match;
    }
  } catch (e) {
    console.error('Failed to verify conversation ownership:', e.message);
  }

  // conversation 在内存和数据库中都找不到 — 拒绝访问
  console.warn(`[Ownership] Conversation ${conversationId} not found anywhere, userId=${userId}, denying access`);
  return false;
}

// ★ Phase 4: Directory cache helpers

function normalizeDirPath(p) {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function getDirCacheKey(agentId, dirPath) {
  return `${agentId}:${normalizeDirPath(dirPath)}`;
}

export function getCachedDir(agentId, dirPath) {
  const key = getDirCacheKey(agentId, dirPath);
  const cached = directoryCache.get(key);
  if (cached && Date.now() - cached.timestamp < DIR_CACHE_TTL) {
    return cached.entries;
  }
  if (cached) directoryCache.delete(key);
  return null;
}

export function setCachedDir(agentId, dirPath, entries) {
  if (directoryCache.size >= DIR_CACHE_MAX_SIZE) {
    const oldest = [...directoryCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) directoryCache.delete(oldest[0]);
  }
  directoryCache.set(getDirCacheKey(agentId, dirPath), {
    entries, timestamp: Date.now()
  });
}

export function clearAgentDirCache(agentId) {
  const prefix = `${agentId}:`;
  const keysToDelete = [];
  for (const key of directoryCache.keys()) {
    if (key.startsWith(prefix)) keysToDelete.push(key);
  }
  for (const key of keysToDelete) directoryCache.delete(key);
}

export function invalidateParentDirCache(agentId, filePath) {
  if (!filePath) return;
  const parentDir = filePath.replace(/[\\\/][^\\\/]+$/, '');
  if (parentDir) {
    const key = getDirCacheKey(agentId, parentDir);
    directoryCache.delete(key);
  }
}
