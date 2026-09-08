import { WebSocket } from 'ws';
import { agentInventoryDb, userDb, userStatsDb } from '../database.js';
import { agents, webClients, userStatsDeltas } from '../context.js';

const toNumber = (value) => Number(value) || 0;

function onlineUserIds() {
  const ids = new Set();
  for (const [, client] of webClients) {
    if (client.authenticated && client.userId && client.ws?.readyState === WebSocket.OPEN) {
      ids.add(client.userId);
    }
  }
  return ids;
}

function emptyAgentMetrics() {
  return {
    totalTurns: 0,
    chatTurns: 0,
    yeaftTurns: 0,
    sessionsCreated: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    lastUpdatedAt: null,
  };
}

function safeAgentMetrics(metrics = {}) {
  const out = emptyAgentMetrics();
  for (const key of Object.keys(out)) {
    if (key === 'lastUpdatedAt') continue;
    out[key] = toNumber(metrics[key]);
  }
  out.lastUpdatedAt = metrics.lastUpdatedAt || null;
  if (!out.totalTurns) out.totalTurns = out.chatTurns + out.yeaftTurns;
  if (!out.totalTokens) out.totalTokens = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheWriteTokens;
  return out;
}

function sumAgentMetrics() {
  const totals = emptyAgentMetrics();
  for (const [, agent] of agents) {
    const metrics = safeAgentMetrics(agent.metrics || {});
    totals.totalTurns += metrics.totalTurns;
    totals.chatTurns += metrics.chatTurns;
    totals.yeaftTurns += metrics.yeaftTurns;
    totals.sessionsCreated += metrics.sessionsCreated;
    totals.inputTokens += metrics.inputTokens;
    totals.outputTokens += metrics.outputTokens;
    totals.cacheReadTokens += metrics.cacheReadTokens;
    totals.cacheWriteTokens += metrics.cacheWriteTokens;
    totals.totalTokens += metrics.totalTokens;
    if (metrics.lastUpdatedAt && (!totals.lastUpdatedAt || metrics.lastUpdatedAt > totals.lastUpdatedAt)) {
      totals.lastUpdatedAt = metrics.lastUpdatedAt;
    }
  }
  return totals;
}

function mergePendingUserStats(stats) {
  const byUser = new Map(stats.map(row => [row.user_id, { ...row }]));
  for (const [userId, delta] of userStatsDeltas) {
    const row = byUser.get(userId);
    if (!row) {
      byUser.set(userId, {
        user_id: userId,
        username: userId,
        display_name: userId,
        role: 'pro',
        last_turn_completed_at: null,
        updated_at: Date.now(),
        message_count: toNumber(delta.messages),
        session_count: toNumber(delta.sessions),
        request_count: toNumber(delta.requests),
        bytes_sent: toNumber(delta.bytesSent),
        bytes_received: toNumber(delta.bytesReceived),
      });
      continue;
    }
    row.message_count = toNumber(row.message_count) + toNumber(delta.messages);
    row.session_count = toNumber(row.session_count) + toNumber(delta.sessions);
    // request_count is a legacy field and may contain old control-frame
    // traffic. The current dashboard request metric is the user-turn count.
    row.request_count = toNumber(row.message_count);
    row.bytes_sent = toNumber(row.bytes_sent) + toNumber(delta.bytesSent);
    row.bytes_received = toNumber(row.bytes_received) + toNumber(delta.bytesReceived);
  }
  return Array.from(byUser.values());
}

function pendingTodayMessages() {
  let count = 0;
  for (const delta of userStatsDeltas.values()) count += toNumber(delta.messages);
  return count;
}

/**
 * Register admin-only REST API routes for the dashboard.
 */
export function registerAdminRoutes(app, { requireAuth, requireAdmin }) {
  // GET /api/admin/dashboard — aggregated overview
  app.get('/api/admin/dashboard', requireAuth, requireAdmin, (req, res) => {
    try {
      const totals = userStatsDb.getDashboardTotals();
      const onlineUsers = onlineUserIds();
      let onlineAgents = 0;
      for (const [, agent] of agents) {
        if (agent.ws.readyState === WebSocket.OPEN) onlineAgents++;
      }

      const agentMetrics = sumAgentMetrics();
      const tokenTotals = userStatsDb.getDashboardTokenTotals();
      res.json({
        totalUsers: totals.total_users,
        totalSessions: totals.total_sessions,
        totalMessages: totals.total_messages,
        onlineUsers: onlineUsers.size,
        onlineAgents,
        todayActiveUsers: userStatsDb.getTodayActiveUsers(),
        todayMessages: userStatsDb.getTodayMessages() + pendingTodayMessages(),
        agentMetrics,
        totalAgentTurns: agentMetrics.totalTurns,
        totalTokens: toNumber(tokenTotals.total_tokens)
      });
    } catch (e) {
      console.error('[Admin] Dashboard error:', e.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/user-stats — per-user stats list (supports ?period=today|week|month|all)
  app.get('/api/admin/user-stats', requireAuth, requireAdmin, (req, res) => {
    try {
      const period = req.query.period || 'all';
      const validPeriods = ['today', 'week', 'month', 'all'];
      const activeUserIds = onlineUserIds();
      const stats = mergePendingUserStats(userStatsDb.getByPeriod(validPeriods.includes(period) ? period : 'all'));
      const statsByUserId = new Map(stats.map(row => [row.user_id, row]));
      // Include users with no usage rows yet so the Active filter reflects all
      // currently connected users, not only users who have sent a prompt.
      for (const user of userDb.getAll()) {
        if (!statsByUserId.has(user.id)) {
          stats.push({
            user_id: user.id,
            username: user.username,
            display_name: user.display_name,
            role: user.role,
            message_count: 0,
            session_count: 0,
            request_count: 0,
            bytes_sent: 0,
            bytes_received: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 0,
            last_turn_completed_at: null,
            updated_at: user.created_at,
          });
        }
      }
      res.json(stats.map(s => ({
        userId: s.user_id,
        username: s.username,
        displayName: s.display_name,
        role: s.role,
        messageCount: s.message_count,
        // request_count predates the user-turn boundary and includes old
        // control/echo traffic. Use the canonical user-turn count for the UI.
        requestCount: toNumber(s.message_count),
        active: activeUserIds.has(s.user_id),
        bytesSent: s.bytes_sent,
        bytesReceived: s.bytes_received,
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        cacheReadTokens: s.cache_read_tokens,
        cacheWriteTokens: s.cache_write_tokens,
        totalTokens: s.total_tokens,
        lastTurnCompletedAt: s.last_turn_completed_at,
        updatedAt: s.updated_at
      })));
    } catch (e) {
      console.error('[Admin] User stats error:', e.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/agents — durable inventory with live connection overlay.
  // The route is admin-only; `online` still comes exclusively from the current
  // owner-scoped WebSocket in `agents`, never from persisted inventory state.
  app.get('/api/admin/agents', requireAuth, requireAdmin, (req, res) => {
    try {
      const liveAgents = new Map(Array.from(agents.entries()).map(([id, agent]) => [id, {
        id,
        instanceId: agent.instanceId || null,
        name: agent.name,
        workDir: agent.workDir,
        online: agent.ws?.readyState === WebSocket.OPEN,
        status: agent.status || 'ready',
        latency: agent.latency || null,
        version: agent.version || null,
        platform: agent.platform || null,
        ownerId: agent.ownerId || null,
        ownerUsername: agent.ownerUsername || null,
        capabilities: agent.capabilities || [],
        capabilityMetadataProvided: agent.capabilityMetadataProvided === true,
        conversationCount: agent.conversations?.size || 0,
        lastSeenAt: agent.lastSeenAt || null,
        lastConnectedAt: agent.lastConnectedAt || null,
        metrics: safeAgentMetrics(agent.metrics || {}),
        metricsUpdatedAt: agent.metricsUpdatedAt || null,
      }]));
      const ownerUsernames = new Map(userDb.getAll().map(user => [user.id, user.username]));
      const inventory = agentInventoryDb.getAll();
      const agentList = inventory.map(record => {
        const live = liveAgents.get(record.id);
        if (!live) {
          return {
            ...record,
            ownerUsername: record.ownerId ? (ownerUsernames.get(record.ownerId) || null) : null,
            online: false,
            status: 'offline',
            latency: null,
            conversationCount: 0,
            metrics: safeAgentMetrics(record.metrics || {}),
          };
        }
        liveAgents.delete(record.id);
        return live;
      });
      // Keep a best-effort fallback for a live record whose initial inventory
      // write failed; the next heartbeat/connection write repairs the row.
      agentList.push(...liveAgents.values());
      res.json(agentList);
    } catch (e) {
      console.error('[Admin] Agents error:', e.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/online-users — currently connected web clients
  app.get('/api/admin/online-users', requireAuth, requireAdmin, (req, res) => {
    try {
      // Deduplicate by userId, keep the most active connection
      const userMap = new Map();
      for (const [, client] of webClients) {
        if (!client.authenticated || !client.userId) continue;
        const existing = userMap.get(client.userId);
        if (!existing || client.currentAgent) {
          userMap.set(client.userId, {
            userId: client.userId,
            username: client.username,
            role: client.role,
            currentAgent: client.currentAgent || null,
            currentAgentName: client.currentAgent ? (agents.get(client.currentAgent)?.name || null) : null
          });
        }
      }
      res.json(Array.from(userMap.values()));
    } catch (e) {
      console.error('[Admin] Online users error:', e.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
