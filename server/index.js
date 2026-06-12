import { assertNodeVersion } from './check-node-version.js';
assertNodeVersion({ component: 'yeaft-server' });

import express from 'express';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CONFIG, isEmailConfigured, validateProductionConfig } from './config.js';
import { agents, webClients, userFileTabs, userStatsDeltas } from './context.js';
import { invitationDb, userStatsDb, closeDb } from './database.js';
import { registerApiRoutes } from './api.js';
import { registerProxyRoutes, handleProxyWebSocketUpgrade } from './proxy.js';
import { handleAgentConnection } from './ws-agent.js';
import { handleWebConnection } from './ws-client.js';
import { sendToWebClient } from './ws-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);
const server = createServer(app);
// maxPayload: defaults to 256 MiB but is env-overridable so operators on
// constrained VMs can throttle without a redeploy. The Yeaft debug feature
// ships verbatim LLM raw request/response bodies through this WebSocket
// (see anthropic.js / openai-responses.js onRawExchange — payloads are
// never truncated). A pathological tool result or a long SSE stream can
// plausibly exceed the `ws` library's 100 MiB default. The default 256 MiB
// covers realistic worst case; the per-tab retention is bounded separately
// on the client by MAX_YEAFT_DEBUG_LOOPS in web/stores/chat.js.
//
// Memory math: with N concurrent agents each delivering one full-frame
// payload, the server transiently holds N × maxPayload before dispatch.
// On a small VM (≤1 GiB), set WS_MAX_PAYLOAD_BYTES lower (e.g. 64 MiB).
const DEFAULT_WS_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const envOverride = Number(process.env.WS_MAX_PAYLOAD_BYTES);
const WS_MAX_PAYLOAD_BYTES = Number.isFinite(envOverride) && envOverride > 0
  ? envOverride
  : DEFAULT_WS_MAX_PAYLOAD_BYTES;
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  // RFC 7692 permessage-deflate. Browsers advertise this natively; the
  // `ws` library handles compression streaming for the agent. Replaces
  // the hand-rolled gzip-before-encrypt that ran only on the (now
  // back-compat) encrypted send path. With plaintext outbound enabled,
  // this is the only compression layer — payloads in DevTools still show
  // the uncompressed JSON (browser inflates before exposing the frame).
  perMessageDeflate: {
    zlibDeflateOptions: { level: 6, memLevel: 7 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    clientNoContextTakeover: true,  // bound per-connection memory
    serverNoContextTakeover: true,
    threshold: 1024                 // skip compression for tiny frames
  }
});

// =====================
// WebSocket 心跳机制
// =====================
const AGENT_HEARTBEAT_INTERVAL = 30000;
const CLIENT_HEARTBEAT_INTERVAL = 90000;

setInterval(() => {
  for (const [agentId, agent] of agents) {
    if (agent.isAlive === false) {
      console.log(`[Heartbeat] Agent ${agentId} not responding, terminating`);
      agent.ws.terminate();
      continue;
    }
    agent.isAlive = false;
    agent.pingSentAt = Date.now();
    agent.ws.ping();
  }
}, AGENT_HEARTBEAT_INTERVAL);

setInterval(() => {
  for (const [clientId, client] of webClients) {
    if (client.isAlive === false) {
      console.log(`[Heartbeat] Web client ${clientId} not responding, terminating`);
      client.ws.terminate();
      continue;
    }
    client.isAlive = false;
    client.ws.ping();
  }
}, CLIENT_HEARTBEAT_INTERVAL);

// ★ Phase 5: 每小时清理超过 24 小时的 file tab 状态
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, state] of userFileTabs) {
    if (state.timestamp < cutoff) userFileTabs.delete(key);
  }
}, 60 * 60 * 1000);

// ★ Phase 6: 每小时清理过期的未使用邀请码
setInterval(() => {
  invitationDb.cleanup();
}, 60 * 60 * 1000);

// ★ Admin Dashboard: 每 60 秒批量持久化用户统计增量到 DB
function flushUserStats() {
  if (userStatsDeltas.size === 0) return;
  try {
    userStatsDb.flushDeltas(userStatsDeltas);
    userStatsDeltas.clear();
  } catch (e) {
    console.error('[UserStats] Flush error:', e.message);
  }
}
setInterval(flushUserStats, 60 * 1000);

// Gzip 压缩中间件
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    // Skip compression for proxy routes (avoid buffering SSE/streaming)
    if (req.path.startsWith('/agent/')) return false;
    return compression.filter(req, res);
  }
}));

// 静态文件服务
const webDir = process.env.SERVE_DIST === 'true'
  ? join(__dirname, '../web/dist')
  : join(__dirname, '../web');
app.use(express.static(webDir, {
  maxAge: process.env.SERVE_DIST === 'true' ? '1y' : 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// SPA fallback for OAuth callback routes (MSAL popup redirect)
app.get('/auth/callback', (req, res) => {
  res.sendFile(join(webDir, 'index.html'));
});

// Port proxy routes (must be before express.json() to get raw body)
registerProxyRoutes(app);

// JSON body parser — after proxy routes
app.use(express.json());

// API routes (auth, sessions, users, upload)
registerApiRoutes(app);

// =====================
// WebSocket 连接处理
// =====================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type');

  if (clientType === 'agent') {
    handleAgentConnection(ws, url);
  } else if (clientType === 'web') {
    handleWebConnection(ws, url);
  } else {
    ws.close(1008, 'Invalid client type');
  }
});

// =====================
// HTTP Upgrade handler
// =====================
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Check if this is a proxy WebSocket request
  const proxyMatch = url.pathname.match(/^\/agent\/([^/]+)\/(\d+)(\/.*)?$/);
  if (proxyMatch) {
    handleProxyWebSocketUpgrade(req, socket, head, proxyMatch);
    return;
  }

  // Otherwise, hand off to the main WebSocket server
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Validate production configuration before starting
const configValidation = validateProductionConfig();
if (!configValidation.valid) {
  console.error('\n========================================');
  console.error('SECURITY CONFIGURATION ERROR');
  console.error('========================================');
  for (const error of configValidation.errors) {
    console.error(`  - ${error}`);
  }
  console.error('\nServer cannot start with default secrets in production mode.');
  console.error('Please configure the following environment variables:');
  console.error('  - JWT_SECRET: A secure random string for JWT signing');
  console.error('\nOr set SKIP_AUTH=true for development mode (NOT recommended for production).');
  console.error('========================================\n');
  process.exit(1);
}
if (configValidation.warnings) {
  console.warn('\n⚠ Configuration warnings:');
  for (const w of configValidation.warnings) {
    console.warn(`  - ${w}`);
  }
  console.warn('');
}

server.listen(CONFIG.port, () => {
  console.log(`Server running on http://0.0.0.0:${CONFIG.port}`);
  console.log(`Auth mode: ${CONFIG.skipAuth ? 'SKIP (development)' : 'ENABLED'}`);
  if (!CONFIG.skipAuth) {
    console.log(`Users configured: ${CONFIG.users.length}`);
    console.log(`Email verification: ${isEmailConfigured() ? 'ENABLED' : 'DISABLED'}`);
  }
});

// =====================
// 优雅关闭（Graceful Shutdown）
// =====================
async function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, starting graceful shutdown...`);

  // 1. 通知所有 web client 服务即将更新
  const updateMsg = { type: 'server_updating' };
  for (const [, client] of webClients) {
    try {
      await sendToWebClient(client, updateMsg);
    } catch (e) { /* ignore send errors during shutdown */ }
  }

  // 2. 短暂等待，确保消息发送完毕
  await new Promise(resolve => setTimeout(resolve, 500));

  // 3. 关闭所有 WebSocket 连接
  for (const [, client] of webClients) {
    try { client.ws.close(1012, 'Server restarting'); } catch (e) {}
  }
  for (const [, agent] of agents) {
    try { agent.ws.close(1012, 'Server restarting'); } catch (e) {}
  }

  // 4. 停止接受新连接
  server.close(() => {
    console.log('[Shutdown] HTTP server closed');
    // Flush pending user stats before closing DB
    flushUserStats();
    closeDb();
    process.exit(0);
  });

  // 5. 强制退出兜底（5 秒超时）
  setTimeout(() => {
    console.warn('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
