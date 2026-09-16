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
          delta.inputTokens || 0,
          delta.outputTokens || 0,
          delta.cacheReadTokens || 0,
          delta.cacheWriteTokens || 0,
          delta.totalTokens || 0,
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
          delta.bytesReceived || 0,
          delta.inputTokens || 0,
          delta.outputTokens || 0,
          delta.cacheReadTokens || 0,
          delta.cacheWriteTokens || 0,
          delta.totalTokens || 0
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

  recordTurnCompleted(userId, completedAt = Date.now()) {
    if (!userId) return;
    const timestamp = Number(completedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return;
    stmts.updateLastTurnCompletedAt.run(userId, timestamp, timestamp);
  },

  /**
   * Convert one cumulative agent snapshot into an idempotent user delta.
   * A new metric epoch means the agent process restarted and counters began at
   * zero. Repeated or lower snapshots in the same epoch never add usage.
   */
  recordAgentTokenSnapshot(userId, agentInstanceId, metrics = {}) {
    const metricEpoch = typeof metrics.metricEpoch === 'string' ? metrics.metricEpoch : '';
    if (!userId || !agentInstanceId || !metricEpoch) return null;

    const fields = [
      ['inputTokens', 'input_tokens'],
      ['outputTokens', 'output_tokens'],
      ['cacheReadTokens', 'cache_read_tokens'],
      ['cacheWriteTokens', 'cache_write_tokens'],
      ['totalTokens', 'total_tokens'],
    ];
    const current = {};
    for (const [metricKey] of fields) {
      current[metricKey] = Math.max(0, Number(metrics[metricKey]) || 0);
    }

    const now = Date.now();
    return transaction(() => {
      const previous = stmts.getAgentMetricWatermark.get(userId, agentInstanceId, metricEpoch);
      const delta = {};
      const watermark = {};
      for (const [metricKey, column] of fields) {
        const previousValue = Number(previous?.[column]) || 0;
        delta[metricKey] = Math.max(0, current[metricKey] - previousValue);
        watermark[metricKey] = Math.max(previousValue, current[metricKey]);
      }
      stmts.upsertAgentMetricWatermark.run(
        userId,
        agentInstanceId,
        metricEpoch,
        watermark.inputTokens,
        watermark.outputTokens,
        watermark.cacheReadTokens,
        watermark.cacheWriteTokens,
        watermark.totalTokens,
        now
      );
      if (Object.values(delta).some(value => value > 0)) {
        stmts.upsertUserStats.run(
          userId, 0, 0, 0, 0, 0,
          delta.inputTokens,
          delta.outputTokens,
          delta.cacheReadTokens,
          delta.cacheWriteTokens,
          delta.totalTokens,
          now
        );
        stmts.upsertDailyStats.run(
          userId, todayStr(), 0, 0, 0, 0, 0,
          delta.inputTokens,
          delta.outputTokens,
          delta.cacheReadTokens,
          delta.cacheWriteTokens,
          delta.totalTokens
        );
      }
      return delta;
    })();
  },

  getDashboardTotals() {
    return stmts.getDashboardTotals.get();
  },

  getDashboardTokenTotals() {
    return stmts.getDashboardTokenTotals.get();
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
