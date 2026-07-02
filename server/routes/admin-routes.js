import { WebSocket } from 'ws';
import { userStatsDb } from '../database.js';
import { agents, webClients, userStatsDeltas } from '../context.js';

const toNumber = (value) => Number(value) || 0;

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
        last_login_at: null,
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
    row.request_count = toNumber(row.request_count) + toNumber(delta.requests);
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
      const onlineUsers = new Set();
      for (const [, client] of webClients) {
        if (client.authenticated && client.userId) {
          onlineUsers.add(client.userId);
        }
      }
      let onlineAgents = 0;
      for (const [, agent] of agents) {
        if (agent.ws.readyState === WebSocket.OPEN) onlineAgents++;
      }

      res.json({
        totalUsers: totals.total_users,
        totalSessions: totals.total_sessions,
        totalMessages: totals.total_messages,
        onlineUsers: onlineUsers.size,
        onlineAgents,
        todayActiveUsers: userStatsDb.getTodayActiveUsers(),
        todayMessages: userStatsDb.getTodayMessages() + pendingTodayMessages()
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
      const stats = mergePendingUserStats(userStatsDb.getByPeriod(validPeriods.includes(period) ? period : 'all'));
      res.json(stats.map(s => ({
        userId: s.user_id,
        username: s.username,
        displayName: s.display_name,
        role: s.role,
        messageCount: s.message_count,
        sessionCount: s.session_count,
        requestCount: s.request_count,
        bytesSent: s.bytes_sent,
        bytesReceived: s.bytes_received,
        lastLoginAt: s.last_login_at,
        updatedAt: s.updated_at
      })));
    } catch (e) {
      console.error('[Admin] User stats error:', e.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/admin/agents — full agent list (no owner filtering)
  app.get('/api/admin/agents', requireAuth, requireAdmin, (req, res) => {
    try {
      const agentList = Array.from(agents.entries()).map(([id, agent]) => ({
        id,
        name: agent.name,
        workDir: agent.workDir,
        online: agent.ws.readyState === WebSocket.OPEN,
        status: agent.status || 'ready',
        latency: agent.latency || null,
        version: agent.version || null,
        ownerId: agent.ownerId || null,
        ownerUsername: agent.ownerUsername || null,
        capabilities: agent.capabilities || [],
        conversationCount: agent.conversations?.size || 0
      }));
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
