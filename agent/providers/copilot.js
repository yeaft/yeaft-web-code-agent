import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import ctx from '../context.js';

export const name = 'copilot';

const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
// Opt-in only: --allow-all-tools is a destructive footgun by default in a
// multi-tenant agent. Set COPILOT_YOLO=1 (and only if you know what you're
// doing) to skip Copilot's tool prompts.
const YOLO = process.env.COPILOT_YOLO === '1';

/**
 * Start (or resume) a Copilot session.
 * Copilot's `-p` mode is one-shot per turn, so "start" just prepares state.
 * Each sendInput() spawns one `copilot -p ...` child with the same
 * --session-id for continuity.
 */
export async function start(opts) {
  const conversationId = opts.conversationId;
  // Tear down any prior entry so we don't leak children.
  const prior = ctx.conversations.get(conversationId);
  if (prior?.copilotChild) {
    try { prior.copilotChild.kill('SIGTERM'); } catch { /* noop */ }
  }

  const sessionId = opts.resumeSessionId || randomUUID();
  const providerOptions = opts.providerOptions || prior?.providerOptions || {};
  const state = {
    providerName: name,
    conversationId: opts.conversationId,
    query: null,
    inputStream: null,
    workDir: opts.workDir,
    claudeSessionId: sessionId,
    sessionId,
    createdAt: prior?.createdAt || Date.now(),
    abortController: null,
    tools: [],
    slashCommands: [],
    model: providerOptions.model || 'copilot',
    userId: opts.userId,
    username: opts.username,
    disallowedTools: prior?.disallowedTools || null,
    copilotChild: null,
    providerOptions,
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalCostUsd: 0 },
  };
  ctx.conversations.set(conversationId, state);
  return state;
}

export async function sendInput(state, prompt, opts = {}) {
  const conversationId = opts.conversationId || state.conversationId;
  if (!conversationId) throw new Error('copilot: conversationId required');
  if (!state.sessionId) state.sessionId = randomUUID();

  // Abort any in-flight turn.
  if (state.copilotChild) {
    try { state.copilotChild.kill('SIGTERM'); } catch { /* noop */ }
    state.copilotChild = null;
  }
  const abortController = new AbortController();
  state.abortController = abortController;
  state.turnActive = true;
  state.turnResultReceived = false;

  const args = ['-p', prompt, '--output-format', 'json', '-C', state.workDir, '--session-id', state.sessionId];
  const po = { ...(state.providerOptions || {}), ...(opts.providerOptions || {}) };
  if (po.model) args.push('--model', String(po.model));
  if (po.effort) args.push('--effort', String(po.effort));
  if (Array.isArray(po.addDirs)) {
    for (const d of po.addDirs) args.push('--add-dir', String(d));
  }
  // YOLO env var still wins as a global override; per-conv allowAllTools
  // lets the user opt in from the UI without setting an env var.
  if (YOLO || po.allowAllTools) args.push('--allow-all-tools');

  let child;
  try {
    child = spawn(COPILOT_BIN, args, {
      cwd: state.workDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    sendOutput(conversationId, {
      type: 'result',
      subtype: 'error',
      session_id: state.sessionId,
      is_error: true,
      error: `copilot spawn failed: ${err?.message || err}`,
    });
    state.turnActive = false;
    ctx.sendToServer({ type: 'turn_completed', conversationId, claudeSessionId: state.sessionId, workDir: state.workDir });
    return;
  }
  state.copilotChild = child;

  // Pre-register error handler so async ENOENT from spawn is never unhandled.
  child.on('error', (err) => {
    sendOutput(conversationId, {
      type: 'result',
      subtype: 'error',
      session_id: state.sessionId,
      is_error: true,
      error: `copilot process error: ${err?.message || err}`,
    });
  });

  let killTimer = null;
  abortController.signal.addEventListener('abort', () => {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
    // Escalate to SIGKILL if the child ignores SIGTERM, so the awaited
    // close promise resolves and the next turn isn't blocked forever.
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, 5000);
  });

  let stderrBuf = '';
  const STDERR_CAP = 64 * 1024;
  let sawResult = false;

  const parser = createNdjsonParser((evt) => {
    const envelopes = translateCopilotEvent(evt, state);
    for (const e of envelopes) {
      sendOutput(conversationId, e);
      if (e?.type === 'result') sawResult = true;
    }
  });

  child.stdout.on('data', (chunk) => parser.push(chunk));
  child.stderr.on('data', (chunk) => {
    if (stderrBuf.length < STDERR_CAP) {
      stderrBuf += chunk.toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
    }
  });

  await new Promise((resolve) => {
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      parser.flush();
      if (!sawResult) {
        const ok = code === 0;
        sendOutput(conversationId, {
          type: 'result',
          subtype: ok ? 'success' : 'error',
          session_id: state.sessionId,
          is_error: !ok,
          error: ok ? undefined : (stderrBuf.trim().slice(0, 2000) || `copilot exited with code ${code}`),
        });
      }
      state.copilotChild = null;
      state.turnActive = false;
      ctx.sendToServer({
        type: 'turn_completed',
        conversationId,
        claudeSessionId: state.sessionId,
        workDir: state.workDir,
      });
      resolve();
    });
  });
}

export function abort(state) {
  if (state?.abortController) {
    try { state.abortController.abort(); } catch { /* noop */ }
  }
  if (state?.copilotChild) {
    try { state.copilotChild.kill('SIGTERM'); } catch { /* noop */ }
  }
}

// ---------- internals ----------

function sendOutput(conversationId, data) {
  ctx.sendToServer({ type: 'claude_output', conversationId, data });
}

export function createNdjsonParser(onEvent) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); }
        catch (err) {
          if (ctx?.CONFIG?.debug) console.warn('[copilot] dropping unparsable line:', line.slice(0, 200));
          continue;
        }
        try { onEvent(evt); }
        catch (err) { console.warn('[copilot] event handler error:', err?.message || err); }
      }
    },
    flush() {
      const line = buf.trim();
      buf = '';
      if (!line) return;
      try {
        const evt = JSON.parse(line);
        onEvent(evt);
      } catch { /* discard trailing junk */ }
    },
  };
}

/**
 * Map a Copilot NDJSON event to zero-or-more claude_output envelopes.
 * Defensive: unknown shapes are logged and dropped.
 *
 * Recognized loose schemas (Copilot CLI JSON output is not yet stable, so
 * we accept several aliases and forward only what we understand):
 *  - text:        { type: 'text'|'text_delta'|'assistant_text', text|delta }
 *  - message:     { type: 'message', role, content }
 *  - tool_call:   { type: 'tool_call'|'tool_use', id, name|tool, input|arguments }
 *  - tool_result: { type: 'tool_result', tool_use_id|id, content|output }
 *  - done:        { type: 'result'|'done'|'complete', session_id?, error? }
 *  - error:       { type: 'error', message|error }
 */
export function translateCopilotEvent(evt, state) {
  if (!evt || typeof evt !== 'object') return [];
  const t = evt.type;

  if (t === 'text' || t === 'text_delta' || t === 'assistant_text') {
    const text = typeof evt.text === 'string' ? evt.text : (typeof evt.delta === 'string' ? evt.delta : '');
    if (!text) return [];
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }];
  }

  if (t === 'message' && evt.role === 'assistant') {
    const content = normalizeContent(evt.content);
    return [{ type: 'assistant', message: { role: 'assistant', content } }];
  }

  if (t === 'tool_call' || t === 'tool_use') {
    const id = evt.id || evt.call_id || randomUUID();
    const toolName = evt.name || evt.tool || 'unknown';
    const input = evt.input ?? evt.arguments ?? {};
    return [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input }] } }];
  }

  if (t === 'tool_result') {
    const tool_use_id = evt.tool_use_id || evt.id || 'unknown';
    const content = typeof evt.content === 'string'
      ? evt.content
      : (typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.content ?? evt.output ?? ''));
    return [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] } }];
  }

  if (t === 'result' || t === 'done' || t === 'complete') {
    const isErr = !!evt.error || evt.is_error === true;
    return [{
      type: 'result',
      subtype: isErr ? 'error' : 'success',
      session_id: evt.session_id || state?.sessionId || null,
      is_error: isErr,
      error: isErr ? (evt.error || evt.message || 'copilot error') : undefined,
    }];
  }

  if (t === 'error') {
    return [{
      type: 'result',
      subtype: 'error',
      session_id: state?.sessionId || null,
      is_error: true,
      error: evt.message || evt.error || 'copilot error',
    }];
  }

  if (ctx?.CONFIG?.debug) console.warn('[copilot] dropping unknown event type:', t);
  return [];
}

function normalizeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: String(content ?? '') }];
}

export default { name, start, sendInput, abort, listFolders, listSessions, loadHistory };

// ---------- history surface (reads ~/.copilot/session-store.db) ----------

export function getCopilotDbPath() {
  return process.env.COPILOT_DB_PATH || join(homedir(), '.copilot', 'session-store.db');
}

let _dbHandle = null;
let _dbHandlePath = null;
function openDb() {
  const path = getCopilotDbPath();
  if (!existsSync(path)) return null;
  if (_dbHandle && _dbHandlePath === path) return _dbHandle;
  if (_dbHandle) {
    try { _dbHandle.close(); } catch { /* noop */ }
    _dbHandle = null;
  }
  try {
    _dbHandle = new DatabaseSync(path, { readOnly: true });
    _dbHandlePath = path;
    return _dbHandle;
  } catch (err) {
    if (ctx?.CONFIG?.debug) console.warn('[copilot] cannot open session DB:', err?.message || err);
    return null;
  }
}

// Exposed for tests so they can drop the cached handle when swapping
// COPILOT_DB_PATH between cases.
export function _resetCopilotDbHandle() {
  if (_dbHandle) {
    try { _dbHandle.close(); } catch { /* noop */ }
  }
  _dbHandle = null;
  _dbHandlePath = null;
}

function toEpochMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export async function listFolders() {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT cwd, COUNT(*) AS sessionCount, MAX(updated_at) AS lastUpdated
      FROM sessions
      WHERE cwd IS NOT NULL AND cwd <> ''
      GROUP BY cwd
      ORDER BY lastUpdated DESC
    `).all();
    return rows.map(r => ({
      name: r.cwd,
      path: r.cwd,
      sessionCount: Number(r.sessionCount) || 0,
      lastModified: toEpochMs(r.lastUpdated),
    }));
  } catch (err) {
    if (ctx?.CONFIG?.debug) console.warn('[copilot] listFolders failed:', err?.message || err);
    return [];
  }
}

export async function listSessions(workDir) {
  if (!workDir) return [];
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT s.id, s.summary, s.created_at, s.updated_at,
             (SELECT user_message FROM turns WHERE session_id = s.id ORDER BY turn_index ASC LIMIT 1) AS first_user
      FROM sessions s
      WHERE s.cwd = ?
      ORDER BY s.updated_at DESC
    `).all(workDir);
    return rows.map(r => {
      const preview = (r.first_user || '').toString().slice(0, 100);
      const title = (r.summary && r.summary.trim()) || preview || r.id.slice(0, 8);
      return {
        sessionId: r.id,
        workDir,
        title,
        preview,
        lastModified: toEpochMs(r.updated_at) || toEpochMs(r.created_at),
      };
    }).filter(s => s.title);
  } catch (err) {
    if (ctx?.CONFIG?.debug) console.warn('[copilot] listSessions failed:', err?.message || err);
    return [];
  }
}

export async function loadHistory(workDir, sessionId, limit = 500) {
  if (!sessionId) return [];
  const db = openDb();
  if (!db) return [];
  try {
    const allTurns = db.prepare(`
      SELECT turn_index, user_message, assistant_response, timestamp
      FROM turns WHERE session_id = ? ORDER BY turn_index ASC
    `).all(sessionId);
    // Apply limit at the turn level so we never split a tool_use / tool_result
    // pair when truncating. Each turn typically expands to <=4 messages, so
    // ceil(limit/4) turns is a safe upper bound that preserves recency.
    const turns = limit && allTurns.length > Math.ceil(limit / 4)
      ? allTurns.slice(-Math.ceil(limit / 4))
      : allTurns;

    // Tool-call events per turn, in order. Copilot's schema is not fully
    // documented; in some versions a single tool call writes multiple rows
    // (e.g. a "started" row with the command and a "completed" row with
    // output/exit_code). Dedupe by tool_call_id, preferring rows that
    // carry output so we render one tool_use + one tool_result per call.
    const events = db.prepare(`
      SELECT id, turn_index, tool_call_id, event_type, command, output, exit_code,
             event_key, event_value, created_at
      FROM forge_trajectory_events
      WHERE session_id = ?
      ORDER BY turn_index ASC, id ASC
    `).all(sessionId);

    const mergedByCallId = new Map();
    const orderedKeys = [];
    for (const e of events) {
      const key = e.tool_call_id || `__row:${e.id}`;
      const prev = mergedByCallId.get(key);
      if (!prev) {
        orderedKeys.push(key);
        mergedByCallId.set(key, { ...e });
      } else {
        // Merge later rows in; non-null values win so the "completed" row
        // adds output/exit_code without erasing the "started" row's command.
        for (const [k, v] of Object.entries(e)) {
          if (v != null && v !== '') prev[k] = v;
        }
      }
    }
    const eventsByTurn = new Map();
    for (const key of orderedKeys) {
      const e = mergedByCallId.get(key);
      const arr = eventsByTurn.get(e.turn_index) || [];
      arr.push(e);
      eventsByTurn.set(e.turn_index, arr);
    }

    const messages = [];
    for (const t of turns) {
      if (t.user_message) {
        messages.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: String(t.user_message) }] },
        });
      }
      // Render any tool calls captured for this turn as assistant tool_use +
      // user tool_result pairs, then the final assistant text.
      const turnEvents = eventsByTurn.get(t.turn_index) || [];
      for (const e of turnEvents) {
        if (!e.event_type) continue;
        const toolId = e.tool_call_id || `copilot-${t.turn_index}-${messages.length}`;
        const toolName = e.event_type;
        const input = e.command
          ? { command: e.command }
          : (e.event_key ? { [e.event_key]: e.event_value } : {});
        messages.push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: toolName, input }] },
        });
        const outText = e.output != null
          ? String(e.output)
          : (e.exit_code != null ? `exit ${e.exit_code}` : '');
        messages.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: outText }] },
        });
      }
      if (t.assistant_response) {
        messages.push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: String(t.assistant_response) }] },
        });
      }
    }
    return messages;
  } catch (err) {
    if (ctx?.CONFIG?.debug) console.warn('[copilot] loadHistory failed:', err?.message || err);
    return [];
  }
}

