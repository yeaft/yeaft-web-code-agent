/**
 * debug-trace.js — SQLite-backed debug trace for Yeaft
 *
 * Records every LLM turn, tool call, and event for debugging and analytics.
 * When disabled, uses NullTrace (same interface, zero overhead).
 *
 * Reference: server/db/connection.js — Database(path), pragma WAL
 */

import { DatabaseSync } from 'node:sqlite';
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
    ended_at INTEGER,
    group_id TEXT,
    vp_id TEXT,
    thread_id TEXT,
    system_prompt TEXT,
    messages_json TEXT,
    tool_calls_json TEXT,
    usage_json TEXT,
    ttfb_ms INTEGER,
    raw_request TEXT,
    raw_response TEXT,
    user_prompt TEXT
  );

  CREATE TABLE IF NOT EXISTS trace_tools (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_input TEXT,
    tool_output TEXT,
    tool_call_id TEXT,
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

/**
 * Indexes that reference columns added by the v0.1.x fix-vp-multi-thread
 * migration. Must be executed AFTER `migrateAddColumn` for those columns
 * — running them inside the main SCHEMA block would fail on an old DB
 * whose `trace_turns` table predates `group_id` / `vp_id` / `thread_id`
 * (`CREATE TABLE IF NOT EXISTS` is a no-op when the table already
 * exists, so the columns are never added by SCHEMA alone).
 */
const POST_MIGRATION_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_turns_group_id ON trace_turns(group_id);
  CREATE INDEX IF NOT EXISTS idx_turns_vp_id ON trace_turns(vp_id);
  CREATE INDEX IF NOT EXISTS idx_turns_thread_id ON trace_turns(thread_id);
`;

/**
 * Idempotent column-adds for pre-existing trace databases. `ALTER TABLE …
 * ADD COLUMN` throws if the column already exists, so we wrap each call.
 * Mirrors the columns introduced above so older DBs upgrade in place.
 */
function migrateAddColumn(db, table, column, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (!String(err?.message || err).match(/duplicate column name/i)) {
      throw err;
    }
  }
}

/** Max tool input size stored inline. Tool output is persisted raw. */
const MAX_TOOL_INPUT = 10240;

/**
 * Max per-loop payload (system prompt, messages JSON, raw request /
 * response, response text) stored per row. Larger than MAX_TOOL_INPUT
 * because real-world LLM exchanges (system prompt + 30K-token message
 * trail + raw response) routinely cross 10KB. 256KB lets us replay the
 * panel verbatim for the most recent traces without bloating the DB.
 */
const MAX_LOOP_PAYLOAD = 256 * 1024;

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

function truncatedJsonSentinel(originalBytes) {
  return {
    __truncated: true,
    originalBytes,
    maxBytes: MAX_LOOP_PAYLOAD,
  };
}

function truncateJsonValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') return truncate(value, MAX_LOOP_PAYLOAD);
  try {
    const s = JSON.stringify(value);
    if (s.length <= MAX_LOOP_PAYLOAD) return value;
    return truncatedJsonSentinel(s.length);
  } catch {
    return null;
  }
}

function boundDreamEventData(eventType, eventData) {
  if (eventType !== 'dream_loop' || !eventData || typeof eventData !== 'object') return eventData;
  return {
    ...eventData,
    systemPrompt: truncateJsonValue(eventData.systemPrompt),
    messages: truncateJsonValue(eventData.messages),
    response: truncateJsonValue(eventData.response),
    rawRequest: truncateJsonValue(eventData.rawRequest),
    rawResponse: truncateJsonValue(eventData.rawResponse),
  };
}

/**
 * DebugTrace — SQLite-backed debug trace.
 */
export class DebugTrace {
  /** @type {import('node:sqlite').DatabaseSync} */
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
    this.#db = new DatabaseSync(dbPath);
    // INCREMENTAL auto-vacuum lets cleanup() return freed pages to the OS via
    // `PRAGMA incremental_vacuum` instead of leaving the file at its historical
    // peak. SQLite only honours an auto_vacuum *change* before the first table
    // is created (a fresh DB) — on a pre-existing store it is a silent no-op, so
    // existing databases keep their default `auto_vacuum=NONE` and are
    // unaffected (they only shrink under a manual compact()/VACUUM). Databases
    // created from this version on are self-trimming. Must precede SCHEMA.
    this.#db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
    // Forward-compat: a DB created by an older version of the bridge
    // will be missing the group/vp/thread + per-loop snapshot columns.
    // Add them on open; no-op for fresh DBs (column already exists
    // from SCHEMA above).
    migrateAddColumn(this.#db, 'trace_turns', 'group_id', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'vp_id', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'thread_id', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'system_prompt', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'messages_json', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'tool_calls_json', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'usage_json', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'ttfb_ms', 'INTEGER');
    migrateAddColumn(this.#db, 'trace_turns', 'raw_request', 'TEXT');
    migrateAddColumn(this.#db, 'trace_turns', 'raw_response', 'TEXT');
    // C2 fix: explicit `user_prompt` column. Deriving the prompt from
    // `messages_json` is unsafe because every loop after turn 1 in a
    // multi-loop tool-call cycle persists the *cumulative* conversation
    // snapshot — `messages.find(role==='user')` would return turn 1's
    // text for every subsequent turn, mislabeling every Turn header.
    migrateAddColumn(this.#db, 'trace_turns', 'user_prompt', 'TEXT');
    migrateAddColumn(this.#db, 'trace_tools', 'tool_call_id', 'TEXT');
    // Indexes on the just-added columns. Must run AFTER the ALTER TABLEs
    // — running them inside SCHEMA's CREATE INDEX IF NOT EXISTS block
    // would fail with "no such column: group_id" on a pre-bugfix DB.
    this.#db.exec(POST_MIGRATION_INDEXES);
  }

  // ─── Write API ───────────────────────────────────────────────

  /**
   * Start a new turn.
   * @param {{ traceId: string, messageId?: string, mode?: string, turnNumber?: number, sessionId?: string, vpId?: string, threadId?: string, userPrompt?: string }} opts
   * @returns {string} — turnId
   */
  startTurn({ traceId, messageId = null, mode = null, turnNumber = null, sessionId = null, vpId = null, threadId = null, userPrompt = null }) {
    const id = randomUUID();
    const now = Date.now();
    this.#prepare('insertTurn', `
      INSERT INTO trace_turns (id, trace_id, message_id, mode, turn_number, started_at, group_id, vp_id, thread_id, user_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, traceId, messageId, mode, turnNumber, now, sessionId, vpId, threadId, truncate(userPrompt, MAX_LOOP_PAYLOAD));
    return id;
  }

  /**
   * End a turn with model response info.
   * @param {string} turnId
   * @param {{ model?: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, stopReason?: string, latencyMs?: number, responseText?: string, systemPrompt?: string, messages?: unknown, toolCalls?: unknown, usage?: unknown, ttfbMs?: number, rawRequest?: unknown, rawResponse?: unknown }} info
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
    systemPrompt = null,
    messages = null,
    toolCalls = null,
    usage = null,
    ttfbMs = null,
    rawRequest = null,
    rawResponse = null,
  } = {}) {
    const now = Date.now();
    // JSON-stringify the structured fields so they round-trip through
    // SQLite as TEXT. JSON serialisation might fail (cyclic structure /
    // BigInt) — guard with try/catch and persist null on failure so a
    // single bad message can never tank the whole turn record.
    //
    // I2 fix: if the serialised JSON exceeds MAX_LOOP_PAYLOAD, the naïve
    // `truncate(s, MAX)` would append `... [truncated]` mid-string and
    // make the row's JSON unparseable. The reader's `parseJsonSafe` would
    // then silently return null and the panel would render the loop with
    // empty messages / toolCalls / usage. Persist a structured sentinel
    // instead so the panel can render a "[truncated, N bytes]" notice.
    const safeStringify = (v) => {
      if (v == null) return null;
      try {
        const s = JSON.stringify(v);
        if (s.length <= MAX_LOOP_PAYLOAD) return s;
        return JSON.stringify(truncatedJsonSentinel(s.length));
      } catch { return null; }
    };
    // For raw request/response, accept either a pre-stringified blob
    // (treat as opaque text — truncation here is fine because
    // parseJsonSafe is not used on raw_*) or a structured object (route
    // through safeStringify which preserves JSON validity).
    const stringifyRaw = (v) => {
      if (v == null) return null;
      if (typeof v === 'string') return truncate(v, MAX_LOOP_PAYLOAD);
      return safeStringify(v);
    };
    this.#prepare('endTurn', `
      UPDATE trace_turns SET
        model = ?, input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?,
        stop_reason = ?, latency_ms = ?, response_text = ?, ended_at = ?,
        system_prompt = ?, messages_json = ?, tool_calls_json = ?,
        usage_json = ?, ttfb_ms = ?, raw_request = ?, raw_response = ?
      WHERE id = ?
    `).run(
      model, inputTokens, outputTokens,
      cacheReadTokens, cacheWriteTokens,
      stopReason, latencyMs, truncate(responseText, MAX_LOOP_PAYLOAD),
      now,
      truncate(systemPrompt, MAX_LOOP_PAYLOAD),
      safeStringify(messages),
      safeStringify(toolCalls),
      safeStringify(usage),
      ttfbMs,
      stringifyRaw(rawRequest),
      stringifyRaw(rawResponse),
      turnId,
    );
  }

  /**
   * Log a tool call within a turn.
   * @param {string} turnId
   * @param {{ toolName: string, toolCallId?: string|null, toolInput?: string, toolOutput?: string, durationMs?: number, isError?: boolean }} info
   * @returns {string} — tool record id
   */
  logTool(turnId, {
    toolName,
    toolCallId = null,
    toolInput = null,
    toolOutput = null,
    durationMs = null,
    isError = false,
  }) {
    const id = randomUUID();
    const now = Date.now();
    this.#prepare('insertTool', `
      INSERT INTO trace_tools (id, turn_id, tool_name, tool_input, tool_output, tool_call_id, duration_ms, is_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, turnId, toolName,
      truncate(toolInput, MAX_TOOL_INPUT),
      toolOutput == null ? null : String(toolOutput),
      toolCallId,
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
    const boundedData = boundDreamEventData(eventType, eventData);
    const data = boundedData != null ? JSON.stringify(boundedData) : null;
    this.#prepare('insertEvent', `
      INSERT INTO trace_events (id, trace_id, event_type, event_data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, traceId, eventType, data, now);
    return id;
  }

  /**
   * Compatibility helper used by older engine/dream call sites.
   * @param {string} eventType
   * @param {unknown} eventData
   * @returns {string}
   */
  event(eventType, eventData = null) {
    const traceId = (eventData && typeof eventData === 'object' && (eventData.turnId || eventData.runId))
      ? String(eventData.turnId || eventData.runId)
      : String(eventType || 'event');
    return this.logEvent({ traceId, eventType, eventData });
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
   * Fetch the recent debug history for the YeaftDebugPanel. Returns one
   * record per LLM loop (ordered oldest → newest) with the structured
   * fields the panel expects. JSON columns are parsed; truncated /
   * malformed payloads degrade to null instead of failing the call.
   *
   * @param {{ limit?: number, dreamLimit?: number, sessionId?: string|null, threadId?: string|null }} [opts]
   * @returns {{ loops: object[], turns: object[], dreamEvents: object[] }}
   */
  fetchRecentDebugHistory({ limit = 100, dreamLimit = 5, sessionId = null, threadId = null } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const dreamLim = Number.isFinite(Number(dreamLimit))
      ? Math.max(0, Math.min(50, Number(dreamLimit)))
      : 5;
    const where = [];
    const args = [];
    if (sessionId) { where.push('group_id = ?'); args.push(sessionId); }
    if (threadId) { where.push('thread_id = ?'); args.push(threadId); }
    const sql = `
      SELECT * FROM trace_turns
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC
      LIMIT ?
    `;
    // Fetch one extra row so the UI can tell whether older history exists
    // without issuing a second COUNT(*) against the hot debug trace table.
    args.push(lim + 1);
    const fetchedRows = this.#db.prepare(sql).all(...args);
    const hasMore = fetchedRows.length > lim;
    const rows = hasMore ? fetchedRows.slice(0, lim) : fetchedRows;
    const turnIds = rows.map(r => r.id);
    const tools = turnIds.length > 0
      ? this.#db.prepare(
          `SELECT * FROM trace_tools WHERE turn_id IN (${turnIds.map(() => '?').join(',')}) ORDER BY created_at`
        ).all(...turnIds)
      : [];
    const parseJsonSafe = (s) => {
      if (s == null) return null;
      try { return JSON.parse(s); }
      catch { return null; }
    };
    const normalizeUsage = (usage, row) => {
      const inputTokens = Number.isFinite(Number(usage?.inputTokens)) ? Number(usage.inputTokens) : (row.input_tokens || 0);
      const outputTokens = Number.isFinite(Number(usage?.outputTokens)) ? Number(usage.outputTokens) : (row.output_tokens || 0);
      const cacheReadTokens = Number.isFinite(Number(usage?.cacheReadTokens)) ? Number(usage.cacheReadTokens) : (row.cache_read_tokens || 0);
      const cacheWriteTokens = Number.isFinite(Number(usage?.cacheWriteTokens)) ? Number(usage.cacheWriteTokens) : (row.cache_write_tokens || 0);
      const totalInputTokens = Number.isFinite(Number(usage?.totalInputTokens))
        ? Number(usage.totalInputTokens)
        : inputTokens + cacheReadTokens + cacheWriteTokens;
      return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalInputTokens,
        totalTokens: Number.isFinite(Number(usage?.totalTokens))
          ? Number(usage.totalTokens)
          : totalInputTokens + outputTokens,
      };
    };
    // Group rows by (turnId, threadId, sessionId, vpId) → frontend Turn
    // record. Each row is also surfaced as a Loop.
    const duplicateLoopTraceIds = new Set();
    const seenLoopKeys = new Set();
    for (const r of rows) {
      const traceId = r.trace_id || r.id;
      const key = `${traceId}#${r.turn_number || 0}`;
      if (seenLoopKeys.has(key)) duplicateLoopTraceIds.add(traceId);
      else seenLoopKeys.add(key);
    }
    const turnsById = new Map();
    const loops = rows.map((r) => {
      const parsedMessages = parseJsonSafe(r.messages_json) || [];
      const parsedUsage = parseJsonSafe(r.usage_json);
      const baseTurnId = r.trace_id || r.id;
      // Legacy rows used one Engine-instance trace_id for many user requests.
      // That creates duplicate Loop 1/2/... rows under the same trace. Split
      // only those corrupted traces by SQLite row id; healthy rows keep trace_id
      // so multi-loop requests still hydrate as one turn.
      const hydratedTurnId = duplicateLoopTraceIds.has(baseTurnId) ? (r.id || baseTurnId) : baseTurnId;
      const loopInstanceId = duplicateLoopTraceIds.has(baseTurnId) ? (r.id || `${baseTurnId}#${r.turn_number || 0}`) : null;
      const loop = {
        turnId: hydratedTurnId,
        ...(loopInstanceId ? { loopInstanceId } : {}),
        loopNumber: r.turn_number || 0,
        model: r.model || null,
        systemPrompt: r.system_prompt || '',
        messages: parsedMessages,
        response: r.response_text || '',
        toolCalls: parseJsonSafe(r.tool_calls_json) || [],
        usage: normalizeUsage(parsedUsage, r),
        latencyMs: r.latency_ms || 0,
        ttfbMs: r.ttfb_ms || null,
        stopReason: r.stop_reason || null,
        rawRequest: r.raw_request || null,
        rawResponse: r.raw_response || null,
        sessionId: r.group_id || null,
        vpId: r.vp_id || null,
        threadId: r.thread_id || null,
      };
      if (!turnsById.has(hydratedTurnId)) {
        turnsById.set(hydratedTurnId, {
          turnId: hydratedTurnId,
          // C2 fix: read the explicit `user_prompt` column persisted at
          // startTurn time. Deriving from messages_json is unsafe — each
          // tool-loop iteration overwrites messages_json with the
          // cumulative conversation snapshot, so `messages[0].content`
          // would be turn-1's prompt for every subsequent turn header.
          userPrompt: r.user_prompt || '',
          sessionId: r.group_id || null,
          vpId: r.vp_id || null,
          threadId: r.thread_id || null,
          openedAt: r.started_at || 0,
          closedAt: r.ended_at || null,
          totalMs: 0,
          totalTokens: 0,
          loopCount: 0,
          memoryLoaded: null,
          memoryAdjust: null,
          tools: [],
        });
      }
      const t = turnsById.get(hydratedTurnId);
      t.loopCount += 1;
      // Aggregate per-loop latency / tokens so the Turn header shows the
      // same totals the live `turn_close` event would have stamped.
      t.totalMs += r.latency_ms || 0;
      t.totalTokens += loop.usage.totalTokens || 0;
      if (r.ended_at && (!t.closedAt || r.ended_at > t.closedAt)) t.closedAt = r.ended_at;
      return loop;
    });
    // Attach tools to their parent Turn so the panel can render per-tool
    // timing without scanning the loop bodies.
    for (const tool of tools) {
      // Find which loop row this tool belongs to → that row's trace_id
      // identifies the Turn.
      const owner = rows.find(r => r.id === tool.turn_id);
      if (!owner) continue;
      const t = turnsById.get(owner.trace_id);
      if (!t) continue;
      t.tools.push({
        loopNumber: owner.turn_number || 0,
        callId: tool.tool_call_id || tool.id,
        traceToolId: tool.id,
        name: tool.tool_name,
        toolOutput: tool.tool_output == null ? null : String(tool.tool_output),
        durationMs: tool.duration_ms || 0,
        isError: !!tool.is_error,
      });
    }
    const dreamEvents = [];
    if (dreamLim > 0) {
      const eventRows = this.#db.prepare(`
        SELECT * FROM trace_events
        WHERE event_type IN ('dream_progress', 'dream_loop', 'dream_turn_open', 'dream_turn_close', 'dream_run')
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      `).all(Math.max(dreamLim * 5, dreamLim));
      for (const er of eventRows) {
        const data = parseJsonSafe(er.event_data) || {};
        const evtGroupId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
        const target = typeof data.target === 'string' ? data.target : '';
        if (sessionId) {
          const isBroadcast = !evtGroupId && !target;
          const isThisGroup = evtGroupId === sessionId || target === `sessions/${sessionId}`;
          if (!isBroadcast && !isThisGroup) continue;
        }
        dreamEvents.push({
          type: data.type || (er.event_type === 'dream_progress' ? 'dream_progress' : er.event_type),
          ...data,
          at: er.created_at,
          ts: data.ts || data.at || er.created_at,
        });
        if (dreamEvents.length >= dreamLim) break;
      }
      dreamEvents.reverse();
    }

    // Reverse to oldest-first so the panel's existing append-driven UI
    // renders in chronological order on hydration.
    loops.reverse();
    return { loops, turns: Array.from(turnsById.values()), dreamEvents, hasMore, limit: lim };
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
    const turnCount = Number(this.#db.prepare('SELECT COUNT(*) as c FROM trace_turns').get().c);
    const toolCount = Number(this.#db.prepare('SELECT COUNT(*) as c FROM trace_tools').get().c);
    const eventCount = Number(this.#db.prepare('SELECT COUNT(*) as c FROM trace_events').get().c);
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(this.#dbPath).size;
    } catch { /* ignore */ }
    return { turnCount, toolCount, eventCount, dbSizeBytes };
  }

  // ─── Maintenance ─────────────────────────────────────────────

  /**
   * Delete trajectory data older than retentionDays, then mark the freed pages
   * reclaimable.
   *
   * The always-on trace stamps every turn with the cumulative request/response
   * snapshot, so each long-session row is MB-scale and the file grows fast
   * (a real deployment hit 5GB in 15 days). A plain DELETE marks pages free but
   * leaves the file at its peak size; `PRAGMA incremental_vacuum` moves those
   * pages onto the freelist for return to the OS — but only when the DB was
   * created with `auto_vacuum=INCREMENTAL` (see constructor). On a legacy
   * `auto_vacuum=NONE` store the vacuum is a harmless no-op, so this is safe to
   * call unconditionally. Note: in WAL mode the on-disk file truncates at the
   * next checkpoint (the running agent's automatic checkpoints handle this), so
   * the page_count drops here but the file size catches up shortly after.
   *
   * @param {number} [retentionDays=10]
   * @returns {{ deletedTurns: number, deletedTools: number, deletedEvents: number }}
   */
  cleanup(retentionDays = 10) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deletedTools = Number(this.#db.prepare(`
      DELETE FROM trace_tools WHERE turn_id IN (
        SELECT id FROM trace_turns WHERE started_at < ?
      )
    `).run(cutoff).changes);
    const deletedTurns = Number(this.#db.prepare(`
      DELETE FROM trace_turns WHERE started_at < ?
    `).run(cutoff).changes);
    const deletedEvents = Number(this.#db.prepare(`
      DELETE FROM trace_events WHERE created_at < ?
    `).run(cutoff).changes);
    // Reclaim freed pages (no-op on legacy auto_vacuum=NONE DBs). Wrapped so a
    // vacuum failure can never mask a successful delete, but surfaced as a warn
    // because this is the one operation the whole disk-growth fix relies on — a
    // silent persistent failure would look exactly like "the fix works".
    if (deletedTurns || deletedTools || deletedEvents) {
      try { this.#db.exec('PRAGMA incremental_vacuum'); }
      catch (err) { console.warn('[Yeaft] trace incremental_vacuum failed:', err?.message || err); }
    }
    return { deletedTurns, deletedTools, deletedEvents };
  }

  /**
   * One-shot full compaction (VACUUM). Rebuilds the entire database file,
   * reclaiming all free space AND converting a legacy `auto_vacuum=NONE` store
   * to INCREMENTAL going forward. This is a HEAVY operation: it locks the DB
   * and needs temporary scratch space up to the current file size, so it is
   * NOT called automatically on session load — invoke it deliberately (e.g.
   * from the `yeaft --trace` CLI) when an oversized legacy debug.db needs to be
   * shrunk in place.
   * @returns {{ before: number, after: number }} file size in bytes
   */
  compact() {
    let before = 0;
    try { before = statSync(this.#dbPath).size; } catch { /* ignore */ }
    this.#db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.#db.exec('VACUUM');
    // In WAL mode VACUUM writes the rebuilt (smaller) DB into the -wal file;
    // the main .db file does not shrink until a checkpoint folds the WAL back
    // in. TRUNCATE checkpoints and resets the WAL so the on-disk size we report
    // (and the user sees) reflects the reclaimed space immediately.
    try { this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
    let after = 0;
    try { after = statSync(this.#dbPath).size; } catch { /* ignore */ }
    return { before, after };
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
   * @returns {import('node:sqlite').StatementSync}
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
  event() { return 'null'; }
  queryByMessage() { return { turns: [], tools: [], events: [] }; }
  queryByTrace() { return { turns: [], tools: [], events: [] }; }
  queryRecent() { return []; }
  queryTools() { return []; }
  search() { return []; }
  stats() { return { turnCount: 0, toolCount: 0, eventCount: 0, dbSizeBytes: 0 }; }
  cleanup() { return { deletedTurns: 0, deletedTools: 0, deletedEvents: 0 }; }
  compact() { return { before: 0, after: 0 }; }
  purge() {}
  close() {}
  fetchRecentDebugHistory() { return { loops: [], turns: [], dreamEvents: [] }; }
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
