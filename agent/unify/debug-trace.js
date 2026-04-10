/**
 * debug-trace.js — SQLite-backed debug trace for Yeaft
 *
 * Records every LLM turn, tool call, and event for debugging and analytics.
 * When disabled, uses NullTrace (same interface, zero overhead).
 *
 * Reference: server/db/connection.js — Database(path), pragma WAL
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';

/** Schema DDL — 3 tables + indexes */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS trace_turns (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    message_id TEXT,
    mode TEXT,
    turn_number INTEGER,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    stop_reason TEXT,
    latency_ms INTEGER,
    response_text TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS trace_tools (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_input TEXT,
    tool_output TEXT,
    duration_ms INTEGER,
    is_error INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (turn_id) REFERENCES trace_turns(id)
  );

  CREATE TABLE IF NOT EXISTS trace_events (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_turns_trace_id ON trace_turns(trace_id);
  CREATE INDEX IF NOT EXISTS idx_turns_message_id ON trace_turns(message_id);
  CREATE INDEX IF NOT EXISTS idx_turns_started_at ON trace_turns(started_at);
  CREATE INDEX IF NOT EXISTS idx_turns_model ON trace_turns(model);
  CREATE INDEX IF NOT EXISTS idx_tools_turn_id ON trace_tools(turn_id);
  CREATE INDEX IF NOT EXISTS idx_tools_name ON trace_tools(tool_name);
  CREATE INDEX IF NOT EXISTS idx_events_trace_id ON trace_events(trace_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON trace_events(event_type);
`;

/** Max tool_output size stored (10KB). Longer outputs are truncated. */
const MAX_TOOL_OUTPUT = 10240;

/**
 * Truncate a string to a max length, appending "... [truncated]" if needed.
 * @param {string|null|undefined} str
 * @param {number} max
 * @returns {string|null}
 */
function truncate(str, max) {
  if (!str) return str ?? null;
  if (str.length <= max) return str;
  return str.slice(0, max) + '... [truncated]';
}

/**
 * DebugTrace — SQLite-backed debug trace.
 */
export class DebugTrace {
  /** @type {Database.Database} */
  #db;

  /** @type {string} */
  #dbPath;

  // Prepared statements (created lazily)
  #stmts = {};

  /**
   * @param {string} dbPath — Path to the SQLite database file.
   */
  constructor(dbPath) {
    this.#dbPath = dbPath;
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  // ─── Write API ───────────────────────────────────────────────

  /**
   * Start a new turn.
   * @param {{ traceId: string, messageId?: string, mode?: string, turnNumber?: number }} opts
   * @returns {string} — turnId
   */
  startTurn({ traceId, messageId = null, mode = null, turnNumber = null }) {
    const id = randomUUID();
    const now = Date.now();
    this.#prepare('insertTurn', `
      INSERT INTO trace_turns (id, trace_id, message_id, mode, turn_number, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, traceId, messageId, mode, turnNumber, now);
    return id;
  }

  /**
   * End a turn with model response info.
   * @param {string} turnId
   * @param {{ model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, stopReason?: string, latencyMs?: number, responseText?: string }} info
   */
  endTurn(turnId, {
    model = null,
    inputTokens = null,
    outputTokens = null,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    stopReason = null,
    latencyMs = null,
    responseText = null,
  } = {}) {
    const now = Date.now();
    this.#prepare('endTurn', `
      UPDATE trace_turns SET
        model = ?, input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?,
        stop_reason = ?, latency_ms = ?, response_text = ?, ended_at = ?
      WHERE id = ?
    `).run(
      model, inputTokens, outputTokens,
      cacheReadTokens, cacheWriteTokens,
      stopReason, latencyMs, truncate(responseText, MAX_TOOL_OUTPUT),
      now, turnId,
    );
  }

  /**
   * Log a tool call within a turn.
   * @param {string} turnId
   * @param {{ toolName: string, toolInput?: string, toolOutput?: string, durationMs?: number, isError?: boolean }} info
   * @returns {string} — tool record id
   */
  logTool(turnId, {
    toolName,
    toolInput = null,
    toolOutput = null,
    durationMs = null,
    isError = false,
  }) {
    const id = randomUUID();
    const now = Date.now();
    this.#prepare('insertTool', `
      INSERT INTO trace_tools (id, turn_id, tool_name, tool_input, tool_output, duration_ms, is_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, turnId, toolName,
      truncate(toolInput, MAX_TOOL_OUTPUT),
      truncate(toolOutput, MAX_TOOL_OUTPUT),
      durationMs, isError ? 1 : 0, now,
    );
    return id;
  }

  /**
   * Log a freeform event.
   * @param {{ traceId: string, eventType: string, eventData?: unknown }} info
   * @returns {string} — event id
   */
  logEvent({ traceId, eventType, eventData = null }) {
    const id = randomUUID();
    const now = Date.now();
    const data = eventData != null ? JSON.stringify(eventData) : null;
    this.#prepare('insertEvent', `
      INSERT INTO trace_events (id, trace_id, event_type, event_data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, traceId, eventType, data, now);
    return id;
  }

  // ─── Read API ────────────────────────────────────────────────

  /**
   * Query all data for a specific message.
   * @param {string} messageId
   * @returns {{ turns: object[], tools: object[], events: object[] }}
   */
  queryByMessage(messageId) {
    const turns = this.#prepare('turnsByMessage', `
      SELECT * FROM trace_turns WHERE message_id = ? ORDER BY started_at
    `).all(messageId);
    return this.#expandTurns(turns);
  }

  /**
   * Query all data for a trace.
   * @param {string} traceId
   * @returns {{ turns: object[], tools: object[], events: object[] }}
   */
  queryByTrace(traceId) {
    const turns = this.#prepare('turnsByTrace', `
      SELECT * FROM trace_turns WHERE trace_id = ? ORDER BY started_at
    `).all(traceId);
    const events = this.#prepare('eventsByTrace', `
      SELECT * FROM trace_events WHERE trace_id = ? ORDER BY created_at
    `).all(traceId);
    const turnIds = turns.map(t => t.id);
    const tools = turnIds.length > 0
      ? this.#db.prepare(
          `SELECT * FROM trace_tools WHERE turn_id IN (${turnIds.map(() => '?').join(',')}) ORDER BY created_at`
        ).all(...turnIds)
      : [];
    return { turns, tools, events };
  }

  /**
   * Query recent turns.
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  queryRecent(limit = 20) {
    return this.#prepare('recentTurns', `
      SELECT * FROM trace_turns ORDER BY started_at DESC LIMIT ?
    `).all(limit);
  }

  /**
   * Query tool calls with optional filters.
   * @param {{ name?: string, since?: number }} [filters={}]
   * @returns {object[]}
   */
  queryTools({ name = null, since = null } = {}) {
    if (name && since) {
      return this.#prepare('toolsByNameSince', `
        SELECT * FROM trace_tools WHERE tool_name = ? AND created_at >= ? ORDER BY created_at DESC
      `).all(name, since);
    }
    if (name) {
      return this.#prepare('toolsByName', `
        SELECT * FROM trace_tools WHERE tool_name = ? ORDER BY created_at DESC
      `).all(name);
    }
    if (since) {
      return this.#prepare('toolsSince', `
        SELECT * FROM trace_tools WHERE created_at >= ? ORDER BY created_at DESC
      `).all(since);
    }
    return this.#prepare('allTools', `
      SELECT * FROM trace_tools ORDER BY created_at DESC LIMIT 100
    `).all();
  }

  /**
   * Full-text search across response_text and tool_output.
   * @param {string} keyword
   * @returns {object[]}
   */
  search(keyword) {
    const like = `%${keyword}%`;
    return this.#prepare('search', `
      SELECT DISTINCT t.* FROM trace_turns t
      LEFT JOIN trace_tools tt ON tt.turn_id = t.id
      WHERE t.response_text LIKE ? OR tt.tool_output LIKE ?
      ORDER BY t.started_at DESC LIMIT 50
    `).all(like, like);
  }

  /**
   * Get trace statistics.
   * @returns {{ turnCount: number, toolCount: number, eventCount: number, dbSizeBytes: number }}
   */
  stats() {
    const turnCount = this.#db.prepare('SELECT COUNT(*) as c FROM trace_turns').get().c;
    const toolCount = this.#db.prepare('SELECT COUNT(*) as c FROM trace_tools').get().c;
    const eventCount = this.#db.prepare('SELECT COUNT(*) as c FROM trace_events').get().c;
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(this.#dbPath).size;
    } catch { /* ignore */ }
    return { turnCount, toolCount, eventCount, dbSizeBytes };
  }

  // ─── Maintenance ─────────────────────────────────────────────

  /**
   * Delete data older than retentionDays.
   * @param {number} [retentionDays=30]
   * @returns {{ deletedTurns: number, deletedTools: number, deletedEvents: number }}
   */
  cleanup(retentionDays = 30) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deletedTools = this.#db.prepare(`
      DELETE FROM trace_tools WHERE turn_id IN (
        SELECT id FROM trace_turns WHERE started_at < ?
      )
    `).run(cutoff).changes;
    const deletedTurns = this.#db.prepare(`
      DELETE FROM trace_turns WHERE started_at < ?
    `).run(cutoff).changes;
    const deletedEvents = this.#db.prepare(`
      DELETE FROM trace_events WHERE created_at < ?
    `).run(cutoff).changes;
    return { deletedTurns, deletedTools, deletedEvents };
  }

  /** Delete all trace data. */
  purge() {
    this.#db.exec('DELETE FROM trace_tools');
    this.#db.exec('DELETE FROM trace_turns');
    this.#db.exec('DELETE FROM trace_events');
  }

  /** Close the database connection. */
  close() {
    this.#db.close();
  }

  // ─── Internal ────────────────────────────────────────────────

  /**
   * Get or create a prepared statement.
   * @param {string} key
   * @param {string} sql
   * @returns {Database.Statement}
   */
  #prepare(key, sql) {
    if (!this.#stmts[key]) {
      this.#stmts[key] = this.#db.prepare(sql);
    }
    return this.#stmts[key];
  }

  /**
   * Expand turns with their tools.
   * @param {object[]} turns
   * @returns {{ turns: object[], tools: object[], events: object[] }}
   */
  #expandTurns(turns) {
    const turnIds = turns.map(t => t.id);
    const tools = turnIds.length > 0
      ? this.#db.prepare(
          `SELECT * FROM trace_tools WHERE turn_id IN (${turnIds.map(() => '?').join(',')}) ORDER BY created_at`
        ).all(...turnIds)
      : [];
    // Events need trace_ids from turns
    const traceIds = [...new Set(turns.map(t => t.trace_id))];
    const events = traceIds.length > 0
      ? this.#db.prepare(
          `SELECT * FROM trace_events WHERE trace_id IN (${traceIds.map(() => '?').join(',')}) ORDER BY created_at`
        ).all(...traceIds)
      : [];
    return { turns, tools, events };
  }
}

/**
 * NullTrace — No-op implementation with the same interface.
 * Used when debug is disabled. Zero overhead.
 */
export class NullTrace {
  startTurn() { return 'null'; }
  endTurn() {}
  logTool() { return 'null'; }
  logEvent() { return 'null'; }
  queryByMessage() { return { turns: [], tools: [], events: [] }; }
  queryByTrace() { return { turns: [], tools: [], events: [] }; }
  queryRecent() { return []; }
  queryTools() { return []; }
  search() { return []; }
  stats() { return { turnCount: 0, toolCount: 0, eventCount: 0, dbSizeBytes: 0 }; }
  cleanup() { return { deletedTurns: 0, deletedTools: 0, deletedEvents: 0 }; }
  purge() {}
  close() {}
}

/**
 * Create a DebugTrace or NullTrace based on config.
 * @param {{ enabled: boolean, dbPath?: string }} opts
 * @returns {DebugTrace | NullTrace}
 */
export function createTrace({ enabled, dbPath }) {
  if (!enabled || !dbPath) {
    return new NullTrace();
  }
  return new DebugTrace(dbPath);
}
