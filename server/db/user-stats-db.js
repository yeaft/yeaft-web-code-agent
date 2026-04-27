import db from './connection.js';
import { stmts, transaction } from './connection.js';

/**
 * Get today's date string in YYYY-MM-DD format (local time).
 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Get the start date string for a given period.
 */
function periodStartDate(period) {
  const now = new Date();
  switch (period) {
    case 'today':
      return todayStr();
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - 6); // last 7 days
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    case 'month': {
      const d = new Date(now);
      d.setDate(d.getDate() - 29); // last 30 days
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    default: // 'all'
      return '1970-01-01';
  }
}

export const userStatsDb = {
  /**
   * Batch flush in-memory deltas to DB.
   * Writes to both user_stats (cumulative) and daily_stats (per-day).
   * @param {Map<string, {requests: number, bytesSent: number, bytesReceived: number, messages: number, sessions: number}>} deltaMap
   */
  flushDeltas(deltaMap) {
    if (deltaMap.size === 0) return;

    const now = Date.now();
    const today = todayStr();
    const flush = transaction(() => {
      for (const [userId, delta] of deltaMap) {
        // Cumulative stats
        stmts.upsertUserStats.run(
          userId,
          delta.messages || 0,
          delta.sessions || 0,
          delta.requests || 0,
          delta.bytesSent || 0,
          delta.bytesReceived || 0,
          now
        );
        // Daily stats
        stmts.upsertDailyStats.run(
          userId,
          today,
          delta.messages || 0,
          delta.sessions || 0,
          delta.requests || 0,
          delta.bytesSent || 0,
          delta.bytesReceived || 0
        );
      }
    });
    flush();
  },

  getAll() {
    return stmts.getUserStats.all();
  },

  /**
   * Get user stats aggregated by period.
   * @param {'today'|'week'|'month'|'all'} period
   */
  getByPeriod(period) {
    if (period === 'all') {
      return this.getAll();
    }
    const startDate = periodStartDate(period);
    return stmts.getDailyStatsAll.all(startDate);
  },

  getByUserId(userId) {
    return stmts.getUserStatsById.get(userId) || null;
  },

  getDashboardTotals() {
    return stmts.getDashboardTotals.get();
  },

  getTodayActiveUsers() {
    const row = stmts.getTodayActiveUsers.get(todayStr());
    return row?.count || 0;
  },

  getTodayMessages() {
    const row = stmts.getTodayMessages.get(todayStr());
    return row?.count || 0;
  }
};
