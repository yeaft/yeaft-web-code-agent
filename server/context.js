import { WebSocket } from 'ws';

// 存储所有连接的 agents
// agentId -> { ws, name, workDir, conversations: Map<convId, {workDir, claudeSessionId}>, sessionKey, isAlive, capabilities }
export const agents = new Map();

// 存储所有 web 客户端
// clientId -> { ws, authenticated, currentAgent, currentConversation, sessionKey, isAlive }
export const webClients = new Map();

// 临时文件存储: fileId -> { name, mimeType, buffer, uploadedAt, userId }
export const pendingFiles = new Map();

// Port proxy
export const pendingProxyRequests = new Map(); // requestId → { res, timeout, streaming }
export const proxyWsConnections = new Map(); // proxyWsId → { browserWs, agentId }

// Store pending agent connections (waiting for auth message)
// tempId -> { ws, agentId, agentName, workDir, timeout }
export const pendingAgentConnections = new Map();

// ★ Phase 3: Server-side message queues
// conversationId → [{id, prompt, workDir, userId, clientId, queuedAt, files}]
export const serverMessageQueues = new Map();

// ★ Phase 4: Directory listing cache
// key: `${agentId}:${normalizedDirPath}` → { entries, timestamp }
export const directoryCache = new Map();
export const DIR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
export const DIR_CACHE_MAX_SIZE = 500;

// ★ Phase 5: File Tab state storage
// key: `${userId}:${agentId}` → { files: [{path}], activeIndex, timestamp }
export const userFileTabs = new Map();

// Preview file cache for binary file preview (Office/PDF/Image)
// fileId → { buffer, mimeType, filename, createdAt, token }
export const previewFiles = new Map();

// Admin dashboard usage stats.
// userId → { requests, bytesSent, bytesReceived, messages, sessions }
// `messages` is user turn count. bytesSent/bytesReceived are message traffic
// only; heartbeat/control frames are deliberately excluded.
export const userStatsDeltas = new Map();

const HEARTBEAT_MESSAGE_TYPES = new Set([
  'ping',
  'pong',
  'ping_session',
  'pong_session',
  'client_hello'
]);

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
    delta = { requests: 0, bytesSent: 0, bytesReceived: 0, messages: 0, sessions: 0 };
    userStatsDeltas.set(userId, delta);
  }
  return delta;
}

export function isHeartbeatMessageType(type) {
  return HEARTBEAT_MESSAGE_TYPES.has(type);
}

export function isOutboundMessageTraffic(type) {
  return OUTBOUND_MESSAGE_TRAFFIC_TYPES.has(type);
}

/**
 * Record a non-heartbeat WS request received from a user. This is kept for
 * operator diagnostics; dashboard traffic comes from user-turn/message bytes.
 */
export function trackRequest(userId, bytesReceived, messageType = '') {
  if (!userId || isHeartbeatMessageType(messageType)) return;
  const delta = getOrCreateDelta(userId);
  delta.requests++;
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
  delta.messages++;
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
