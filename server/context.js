import { WebSocket } from 'ws';

// 存储所有连接的 agents
// agentId -> { ws, name, workDir, conversations: Map<convId, {workDir, claudeSessionId}>, sessionKey, isAlive, capabilities }
export const agents = new Map();

// 存储所有 web 客户端
// clientId -> { ws, authenticated, currentAgent, currentConversation, sessionKey, webHeartbeatPendingSince }
export const webClients = new Map();

// 临时文件存储: fileId -> { name, mimeType, buffer, uploadedAt, userId }
export const pendingFiles = new Map();

// Port proxy
export const pendingProxyRequests = new Map(); // requestId → { res, timeout, streaming }
export const proxyWsConnections = new Map(); // proxyWsId → { browserWs, agentId }

// Store pending agent connections (waiting for auth message)
// tempId -> { ws, agentId, agentName, instanceId, workDir, skipAgentAuth, connectionGeneration, timeout }
export const pendingAgentConnections = new Map();

// ★ Phase 3: Server-side message queues
// conversationId → [{id, prompt, workDir, userId, clientId, queuedAt, files}]
export const serverMessageQueues = new Map();

// ★ Phase 4: Directory listing cache
// key: `${agentId}:${normalizedDirPath}` → { entries, timestamp }
export const directoryCache = new Map();
export const DIR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
export const DIR_CACHE_MAX_SIZE = 500;

// Workbench Files tab state. Route-aware writers use
// `${userId}:${routeKey}\0${workspaceGeneration}`; legacy pairs keep the
// historical `${userId}:${agentId}` key.
export const userFileTabs = new Map();

// Preview file cache for binary file preview (Office/PDF/Image)
// fileId → { buffer, mimeType, filename, createdAt, token }
export const previewFiles = new Map();

// Debug trace replies may come from an older Agent that does not echo the
// private browser client id. Keep the correlation on the Server, where the
// original Agent/Session ownership check happened, and consume it exactly once.
const YEAFT_DEBUG_REQUEST_TTL_MS = 30_000;
const YEAFT_DEBUG_REQUEST_MAX_PENDING = 2048;
const YEAFT_DEBUG_REQUEST_MAX_PENDING_PER_CLIENT = 256;
export const pendingYeaftDebugRequests = new Map();

// Agent settings replies share one Agent connection across browser clients.
// Correlation-capable Agents require exact requestId matching. Legacy Agents are
// allowed one in-flight request per Agent/operation so an identity-less reply has
// exactly one possible owner.
const AGENT_SETTINGS_REQUEST_TTL_MS = 120_000;
const AGENT_SETTINGS_REQUEST_MAX_PENDING = 2048;
const AGENT_SETTINGS_REQUEST_MAX_PENDING_PER_CLIENT = 256;
export const pendingAgentSettingsRequests = new Map();

function agentSettingsRequestKey(agentId, requestId) {
  return `${String(agentId || '')}\u0000${String(requestId || '')}`;
}

function pruneAgentSettingsRequests(now = Date.now()) {
  for (const [key, pending] of pendingAgentSettingsRequests) {
    if (!pending || pending.expiresAt <= now || !webClients.has(pending.clientId)) {
      pendingAgentSettingsRequests.delete(key);
    }
  }
}

/** Register an owner-checked settings request before it is sent to the Agent. */
export function registerAgentSettingsRequest({ agentId, operation, requestId, clientId, allowLegacyReply = false }) {
  if (!agentId || !operation || !requestId || !clientId) return false;
  const now = Date.now();
  pruneAgentSettingsRequests(now);
  const key = agentSettingsRequestKey(agentId, requestId);
  if (pendingAgentSettingsRequests.has(key)) return false;
  let clientPending = 0;
  for (const pending of pendingAgentSettingsRequests.values()) {
    if (pending?.clientId === clientId) clientPending++;
    if (allowLegacyReply && pending?.agentId === agentId && pending?.operation === operation) return false;
  }
  if (clientPending >= AGENT_SETTINGS_REQUEST_MAX_PENDING_PER_CLIENT
      || pendingAgentSettingsRequests.size >= AGENT_SETTINGS_REQUEST_MAX_PENDING) return false;
  pendingAgentSettingsRequests.set(key, {
    agentId,
    operation,
    requestId,
    clientId,
    allowLegacyReply,
    expiresAt: now + AGENT_SETTINGS_REQUEST_TTL_MS,
  });
  return true;
}

/** Consume an exact response, or the sole explicitly legacy-compatible request. */
export function consumeAgentSettingsRequest({ agentId, operation, requestId }) {
  if (!agentId || !operation) return null;
  pruneAgentSettingsRequests();
  if (requestId) {
    const key = agentSettingsRequestKey(agentId, requestId);
    const pending = pendingAgentSettingsRequests.get(key);
    if (!pending || pending.operation !== operation) return null;
    pendingAgentSettingsRequests.delete(key);
    return pending;
  }
  let matchKey = null;
  let match = null;
  for (const [key, pending] of pendingAgentSettingsRequests) {
    if (pending?.agentId !== agentId || pending?.operation !== operation || !pending.allowLegacyReply) continue;
    if (match) return null;
    matchKey = key;
    match = pending;
  }
  if (!match) return null;
  pendingAgentSettingsRequests.delete(matchKey);
  return match;
}

export function deleteAgentSettingsRequest({ agentId, requestId, clientId = null }) {
  const key = agentSettingsRequestKey(agentId, requestId);
  const pending = pendingAgentSettingsRequests.get(key);
  if (!pending || (clientId && pending.clientId !== clientId)) return false;
  return pendingAgentSettingsRequests.delete(key);
}

export function clearAgentSettingsRequestsForClient(clientId) {
  if (!clientId) return;
  for (const [key, pending] of pendingAgentSettingsRequests) {
    if (pending?.clientId === clientId) pendingAgentSettingsRequests.delete(key);
  }
}

export function takeAgentSettingsRequestsForAgent(agentId) {
  const removed = [];
  if (!agentId) return removed;
  for (const [key, pending] of pendingAgentSettingsRequests) {
    if (pending?.agentId !== agentId) continue;
    pendingAgentSettingsRequests.delete(key);
    removed.push(pending);
  }
  return removed;
}

function yeaftDebugRequestKey(agentId, requestId) {
  return `${String(agentId || '')}\u0000${String(requestId || '')}`;
}

function pruneYeaftDebugRequests(now = Date.now()) {
  for (const [key, pending] of pendingYeaftDebugRequests) {
    if (!pending || pending.expiresAt <= now || !webClients.has(pending.clientId)) {
      pendingYeaftDebugRequests.delete(key);
    }
  }
}

/**
 * Register one owner-checked browser request before forwarding it to an Agent.
 * @param {{agentId:string, requestId:string, sessionId:string, clientId:string, userId:string}} request
 * @returns {boolean}
 */
export function registerYeaftDebugRequest({ agentId, requestId, sessionId, clientId, userId }) {
  if (!agentId || !requestId || !sessionId || !clientId || !userId) return false;
  const now = Date.now();
  pruneYeaftDebugRequests(now);
  const key = yeaftDebugRequestKey(agentId, requestId);
  if (pendingYeaftDebugRequests.has(key)) return false;
  let clientPending = 0;
  for (const pending of pendingYeaftDebugRequests.values()) {
    if (pending?.clientId === clientId) clientPending++;
  }
  if (clientPending >= YEAFT_DEBUG_REQUEST_MAX_PENDING_PER_CLIENT
      || pendingYeaftDebugRequests.size >= YEAFT_DEBUG_REQUEST_MAX_PENDING) return false;
  pendingYeaftDebugRequests.set(key, {
    agentId,
    requestId,
    sessionId,
    clientId,
    userId,
    expiresAt: now + YEAFT_DEBUG_REQUEST_TTL_MS,
  });
  return true;
}

/**
 * Advance one strictly ordered debug-detail chunk. The correlation is consumed
 * only after the complete sequence arrives; each accepted frame renews its TTL.
 */
export function advanceYeaftDebugRequestChunk({ agentId, requestId, sessionId, chunkIndex, chunkCount }) {
  if (!agentId || !requestId) return null;
  const now = Date.now();
  pruneYeaftDebugRequests(now);
  const key = yeaftDebugRequestKey(agentId, requestId);
  const pending = pendingYeaftDebugRequests.get(key);
  if (!pending || (sessionId && pending.sessionId !== sessionId)) return null;
  const expectedIndex = pending.nextChunkIndex ?? 0;
  const expectedCount = pending.chunkCount ?? chunkCount;
  if (chunkIndex !== expectedIndex || chunkCount !== expectedCount) {
    pendingYeaftDebugRequests.delete(key);
    return null;
  }
  pending.nextChunkIndex = expectedIndex + 1;
  pending.chunkCount = chunkCount;
  pending.expiresAt = now + YEAFT_DEBUG_REQUEST_TTL_MS;
  const complete = pending.nextChunkIndex === chunkCount;
  if (complete) pendingYeaftDebugRequests.delete(key);
  return { pending, complete };
}

/**
 * Consume a matching, unexpired correlation exactly once.
 * @param {{agentId:string, requestId:string, sessionId?:string|null}} response
 * @returns {{agentId:string, requestId:string, sessionId:string, clientId:string, userId:string, expiresAt:number}|null}
 */
export function consumeYeaftDebugRequest({ agentId, requestId, sessionId }) {
  if (!agentId || !requestId) return null;
  const now = Date.now();
  pruneYeaftDebugRequests(now);
  const key = yeaftDebugRequestKey(agentId, requestId);
  const pending = pendingYeaftDebugRequests.get(key);
  if (!pending) return null;
  if (sessionId && pending.sessionId !== sessionId) return null;
  pendingYeaftDebugRequests.delete(key);
  return pending;
}

/** Remove one correlation after forwarding fails. */
export function deleteYeaftDebugRequest({ agentId, requestId, clientId = null }) {
  const key = yeaftDebugRequestKey(agentId, requestId);
  const pending = pendingYeaftDebugRequests.get(key);
  if (!pending || (clientId && pending.clientId !== clientId)) return false;
  return pendingYeaftDebugRequests.delete(key);
}

/** Remove all correlations owned by a disconnected browser client. */
export function clearYeaftDebugRequestsForClient(clientId) {
  if (!clientId) return;
  for (const [key, pending] of pendingYeaftDebugRequests) {
    if (pending?.clientId === clientId) pendingYeaftDebugRequests.delete(key);
  }
}

// Admin dashboard usage stats.
// userId → { requests, bytesSent, bytesReceived, messages, sessions }
// `messages` is user turn count. bytesSent/bytesReceived are message traffic
// only; heartbeat/control frames are deliberately excluded.
export const userStatsDeltas = new Map();

const OUTBOUND_MESSAGE_TRAFFIC_TYPES = new Set([
  'claude_output',
  'yeaft_output',
  'btw_stream',
  'btw_done',
  'btw_error',
  'context_usage',
  'ask_user_question'
]);

/**
 * Get or initialize a stats delta entry for a user.
 */
function getOrCreateDelta(userId) {
  let delta = userStatsDeltas.get(userId);
  if (!delta) {
    delta = {
      requests: 0,
      bytesSent: 0,
      bytesReceived: 0,
      messages: 0,
      sessions: 0,
    };
    userStatsDeltas.set(userId, delta);
  }
  return delta;
}

export function isOutboundMessageTraffic(type) {
  return OUTBOUND_MESSAGE_TRAFFIC_TYPES.has(type);
}

/**
 * Record outbound message bytes sent to a user via WS.
 */
export function trackMessageBytesSent(userId, bytesSent, messageType = '') {
  if (!userId || !bytesSent || !isOutboundMessageTraffic(messageType)) return;
  const delta = getOrCreateDelta(userId);
  delta.bytesSent += bytesSent;
}

/**
 * Backward-compatible alias. Only message output frames are counted.
 */
export function trackBytesSent(userId, bytesSent, messageType = '') {
  trackMessageBytesSent(userId, bytesSent, messageType);
}

/**
 * Record a user turn and the inbound message payload bytes for it.
 */
export function trackUserTurn(userId, bytesReceived = 0) {
  if (!userId) return;
  const delta = getOrCreateDelta(userId);
  // Both counters are recorded at the validated user-turn boundary. The old
  // WS ingress counter saw history/control frames and is intentionally gone.
  delta.messages++;
  delta.requests++;
  delta.bytesReceived += Math.max(0, Number(bytesReceived) || 0);
}

/**
 * Legacy name: a tracked "message" is now a user turn.
 */
export function trackMessage(userId, bytesReceived = 0) {
  trackUserTurn(userId, bytesReceived);
}

/**
 * Record a new session created by a user.
 */
export function trackSession(userId) {
  if (!userId) return;
  const delta = getOrCreateDelta(userId);
  delta.sessions++;
}
