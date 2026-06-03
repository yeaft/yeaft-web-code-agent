import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import ctx from '../context.js';
import { AcpClient } from './acp-client.js';
import { COPILOT_MODELS, DEFAULT_COPILOT_MODEL } from './copilot-models.js';

export const name = 'copilot';

export const capabilities = Object.freeze({
  compact: false,         // TODO: probe ACP for /compact equivalent
  clear: true,            // session/new gives us a fresh transcript
  expert: false,          // Copilot has /fleet, different model
  mcp: true,              // ACP advertises mcpCapabilities at init
  subagents: false,
  attachments: true,      // ACP promptCapabilities.image + embeddedContext
  askUser: true,          // session/request_permission round-trip
  modelPicker: true,
});

const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
// YOLO is now opt-in only; per-conv allowAllTools is the normal channel.
const YOLO = process.env.COPILOT_YOLO === '1';
const ACP_PROTOCOL_VERSION = 1;

/**
 * Start (or resume) a Copilot ACP session.
 *
 * Spawns one persistent `copilot --acp` child per conversation and runs the
 * ACP handshake: initialize → session/new (or session/load). The child stays
 * alive for the conversation's lifetime; each turn is a `session/prompt`
 * JSONRPC request, not a fresh process.
 */
export async function start(opts) {
  const conversationId = opts.conversationId;
  // Tear down any prior entry so we don't leak children.
  const prior = ctx.conversations.get(conversationId);
  if (prior?.copilotChild) {
    try { prior.copilotChild.kill('SIGTERM'); } catch { /* noop */ }
  }
  if (prior?.acpClient) {
    try { prior.acpClient.close('replaced'); } catch { /* noop */ }
  }

  const providerOptions = opts.providerOptions || prior?.providerOptions || {};
  const model = providerOptions.model || DEFAULT_COPILOT_MODEL;
  const allowAllTools = YOLO || !!providerOptions.allowAllTools;

  const state = {
    providerName: name,
    conversationId,
    query: null,
    inputStream: null,
    workDir: opts.workDir,
    claudeSessionId: opts.resumeSessionId || null,  // set after session/new or session/load
    sessionId: opts.resumeSessionId || null,
    createdAt: prior?.createdAt || Date.now(),
    abortController: null,
    tools: [],
    slashCommands: [],
    model,
    userId: opts.userId,
    username: opts.username,
    disallowedTools: prior?.disallowedTools || null,
    copilotChild: null,
    acpClient: null,
    providerOptions,
    allowAllTools,
    capabilities,
    initialized: false,
    pendingPermissions: new Map(),  // requestId → { resolve, reject } for ask-user round-trip
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalCostUsd: 0 },
  };
  ctx.conversations.set(conversationId, state);

  // Best-effort start; failures emit a result envelope and leave state in place
  // so the next sendInput retries.
  try {
    await _bootAcp(state, opts.resumeSessionId || null, model);
  } catch (err) {
    sendOutput(conversationId, {
      type: 'result',
      subtype: 'error',
      session_id: state.sessionId,
      is_error: true,
      error: `copilot ACP init failed: ${err?.message || err}. Run \`copilot login\` and ensure CLI >= 1.0.59.`,
    });
  }
  return state;
}

async function _bootAcp(state, resumeSessionId, model) {
  const args = ['--acp'];
  // ACP doesn't yet expose a per-session model param in its public schema, so
  // pass --model at spawn for the lifetime of this child.
  if (model) args.push('--model', String(model));
  if (Array.isArray(state.providerOptions?.addDirs)) {
    for (const d of state.providerOptions.addDirs) args.push('--add-dir', String(d));
  }

  const child = spawn(COPILOT_BIN, args, {
    cwd: state.workDir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  state.copilotChild = child;

  let stderrBuf = '';
  const STDERR_CAP = 64 * 1024;
  child.stderr.on('data', (chunk) => {
    if (stderrBuf.length < STDERR_CAP) {
      stderrBuf += chunk.toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
    }
  });
  child.on('error', (err) => {
    sendOutput(state.conversationId, {
      type: 'result',
      subtype: 'error',
      session_id: state.sessionId,
      is_error: true,
      error: `copilot process error: ${err?.message || err}`,
    });
  });
  child.on('close', (code) => {
    if (state.turnActive) {
      const tail = stderrBuf.trim().slice(-2000);
      sendOutput(state.conversationId, {
        type: 'result',
        subtype: 'error',
        session_id: state.sessionId,
        is_error: true,
        error: tail || `copilot exited mid-turn (code ${code})`,
      });
      ctx.sendToServer({
        type: 'turn_completed',
        conversationId: state.conversationId,
        claudeSessionId: state.sessionId,
        workDir: state.workDir,
      });
      state.turnActive = false;
    }
    state.copilotChild = null;
    state.acpClient = null;
    state.initialized = false;
  });

  const client = new AcpClient({
    stdin: child.stdin,
    stdout: child.stdout,
    onNotification: (method, params) => _handleAcpNotification(state, method, params),
    onRequest: (method, params) => _handleAcpRequest(state, method, params),
    onError: (err) => {
      if (ctx?.CONFIG?.debug) console.warn('[copilot] acp transport:', err?.message || err);
    },
  });
  state.acpClient = client;

  // 1) initialize
  const initResp = await client.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  state.acpCapabilities = initResp?.agentCapabilities || {};
  state.initialized = true;

  // 2) session/new or session/load
  if (resumeSessionId && state.acpCapabilities.loadSession) {
    const r = await client.request('session/load', {
      sessionId: resumeSessionId,
      cwd: state.workDir,
      mcpServers: [],
    });
    state.sessionId = resumeSessionId;
    state.claudeSessionId = resumeSessionId;
    if (Array.isArray(r?.modes?.availableModes)) state.acpModes = r.modes.availableModes;
  } else {
    const r = await client.request('session/new', {
      cwd: state.workDir,
      mcpServers: [],
    });
    state.sessionId = r?.sessionId || randomUUID();
    state.claudeSessionId = state.sessionId;
    if (Array.isArray(r?.modes?.availableModes)) state.acpModes = r.modes.availableModes;
  }

  // 3) Emit a system_init envelope so the UI populates tools / model panels.
  // Copilot's built-in toolset is not enumerated over ACP today; advertise the
  // well-known core set so the panel isn't empty.
  state.tools = _knownCopilotTools();
  sendOutput(state.conversationId, {
    type: 'system',
    subtype: 'init',
    session_id: state.sessionId,
    model: state.model,
    tools: state.tools,
    mcp_servers: [],
    permissionMode: state.allowAllTools ? 'bypassPermissions' : 'default',
  });
}

export async function sendInput(state, prompt, opts = {}) {
  const conversationId = opts.conversationId || state.conversationId;
  if (!conversationId) throw new Error('copilot: conversationId required');

  // Ensure ACP child + session are up; reboot if a prior crash dropped them.
  if (!state.initialized || !state.acpClient) {
    try {
      await _bootAcp(state, state.sessionId || null, state.model);
    } catch (err) {
      sendOutput(conversationId, {
        type: 'result',
        subtype: 'error',
        session_id: state.sessionId,
        is_error: true,
        error: `copilot ACP reinit failed: ${err?.message || err}`,
      });
      ctx.sendToServer({ type: 'turn_completed', conversationId, claudeSessionId: state.sessionId, workDir: state.workDir });
      return;
    }
  }

  // Per-turn provider option overrides (e.g. updated model). If the model
  // changed we don't restart the child; ACP doesn't expose model switch yet,
  // so we leave a warning rather than silently drop the request.
  const po = { ...(state.providerOptions || {}), ...(opts.providerOptions || {}) };
  if (po.model && po.model !== state.model) {
    if (ctx?.CONFIG?.debug) console.warn('[copilot] mid-conversation model switch not supported; ignoring');
  }

  const abortController = new AbortController();
  state.abortController = abortController;
  state.turnActive = true;
  state.turnResultReceived = false;

  // Build prompt content blocks. ACP ContentBlock variants: text, image,
  // audio, resource, resource_link. Web attachments arrive on `opts.attachments`
  // (existing wire shape: [{type:'image', data, mimeType} | {type:'text', text}]).
  const promptBlocks = [{ type: 'text', text: String(prompt ?? '') }];
  if (Array.isArray(opts.attachments)) {
    for (const a of opts.attachments) {
      if (!a) continue;
      if (a.type === 'image' && a.data) {
        promptBlocks.push({ type: 'image', data: a.data, mimeType: a.mimeType || 'image/png' });
      } else if (a.type === 'text' && a.text) {
        promptBlocks.push({ type: 'text', text: String(a.text) });
      } else if (typeof a === 'string') {
        promptBlocks.push({ type: 'text', text: a });
      }
    }
  }

  abortController.signal.addEventListener('abort', () => {
    if (state.acpClient && state.sessionId) {
      try { state.acpClient.notify('session/cancel', { sessionId: state.sessionId }); }
      catch { /* noop */ }
    }
  });

  try {
    const resp = await state.acpClient.request('session/prompt', {
      sessionId: state.sessionId,
      prompt: promptBlocks,
    });
    const stopReason = resp?.stopReason || 'end_turn';
    const isErr = stopReason === 'refusal' || stopReason === 'error';
    sendOutput(conversationId, {
      type: 'result',
      subtype: isErr ? 'error' : 'success',
      session_id: state.sessionId,
      stop_reason: stopReason,
      is_error: isErr,
      error: isErr ? `copilot stop_reason=${stopReason}` : undefined,
    });
  } catch (err) {
    sendOutput(conversationId, {
      type: 'result',
      subtype: 'error',
      session_id: state.sessionId,
      is_error: true,
      error: err?.message || String(err),
    });
  } finally {
    state.turnActive = false;
    ctx.sendToServer({
      type: 'turn_completed',
      conversationId,
      claudeSessionId: state.sessionId,
      workDir: state.workDir,
    });
  }
}

export function abort(state) {
  if (state?.abortController) {
    try { state.abortController.abort(); } catch { /* noop */ }
  }
  if (state?.acpClient && state.sessionId) {
    try { state.acpClient.notify('session/cancel', { sessionId: state.sessionId }); }
    catch { /* noop */ }
  }
}

/**
 * /clear support: ask ACP for a brand-new session under the same
 * conversationId. Keeps the child alive — no spawn cost.
 */
export async function clear(state) {
  if (!state?.acpClient) return;
  try {
    const r = await state.acpClient.request('session/new', {
      cwd: state.workDir,
      mcpServers: [],
    });
    state.sessionId = r?.sessionId || randomUUID();
    state.claudeSessionId = state.sessionId;
    sendOutput(state.conversationId, {
      type: 'system',
      subtype: 'init',
      session_id: state.sessionId,
      model: state.model,
      tools: state.tools,
      mcp_servers: [],
      permissionMode: state.allowAllTools ? 'bypassPermissions' : 'default',
    });
  } catch (err) {
    if (ctx?.CONFIG?.debug) console.warn('[copilot] clear failed:', err?.message || err);
  }
}

// ---------- internals ----------

function sendOutput(conversationId, data) {
  ctx.sendToServer({ type: 'claude_output', conversationId, data });
}

function _handleAcpNotification(state, method, params) {
  if (method === 'session/update') {
    _handleSessionUpdate(state, params);
    return;
  }
  if (ctx?.CONFIG?.debug) console.warn('[copilot] unknown ACP notification:', method);
}

async function _handleAcpRequest(state, method, params) {
  if (method === 'session/request_permission') {
    return _handlePermissionRequest(state, params);
  }
  // fs/read_text_file, fs/write_text_file, terminal/* — Copilot's agent
  // doesn't need them because it runs its own tools, but answer politely
  // to anything we don't implement.
  throw Object.assign(new Error(`unsupported method: ${method}`), { code: -32601 });
}

function _handleSessionUpdate(state, params) {
  if (!params || !params.sessionId || params.sessionId !== state.sessionId) {
    // Stale update from a prior session; ignore.
    return;
  }
  const upd = params.update || params;
  const kind = upd.sessionUpdate;
  switch (kind) {
    case 'agent_message_chunk': {
      const text = _extractText(upd.content);
      if (!text) return;
      sendOutput(state.conversationId, {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
      return;
    }
    case 'agent_thought_chunk': {
      const text = _extractText(upd.content);
      if (!text) return;
      sendOutput(state.conversationId, {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
      });
      return;
    }
    case 'user_message_chunk': {
      // Echo of our own prompt — drop (frontend already shows it).
      return;
    }
    case 'tool_call': {
      const id = upd.toolCallId || upd.id || randomUUID();
      const toolName = upd.title || upd.kind || 'tool';
      const input = upd.rawInput || upd.input || {};
      sendOutput(state.conversationId, {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input }] },
      });
      return;
    }
    case 'tool_call_update': {
      const id = upd.toolCallId || upd.id;
      if (!id) return;
      const status = upd.status;
      // Only emit a tool_result when the call reaches a terminal state with
      // some content/output; intermediate "in_progress" updates would render
      // as duplicate empty results in the existing renderer.
      const isTerminal = status === 'completed' || status === 'failed';
      if (!isTerminal) return;
      const text = _extractToolContent(upd.content) || (upd.rawOutput ? _stringify(upd.rawOutput) : '');
      sendOutput(state.conversationId, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: status === 'failed' }] },
      });
      return;
    }
    case 'plan': {
      // Optional: render as a todo-style assistant message. Keep it minimal.
      const entries = Array.isArray(upd.entries) ? upd.entries : [];
      if (!entries.length) return;
      const text = entries.map(e => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`).join('\n');
      sendOutput(state.conversationId, {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `**Plan:**\n${text}` }] },
      });
      return;
    }
    case 'available_commands_update': {
      if (Array.isArray(upd.availableCommands)) {
        state.slashCommands = upd.availableCommands.map(c => c.name || c).filter(Boolean);
      }
      return;
    }
    default:
      if (ctx?.CONFIG?.debug) console.warn('[copilot] unhandled session update:', kind);
  }
}

async function _handlePermissionRequest(state, params) {
  // Auto-approve if the user enabled allowAllTools (or YOLO env).
  if (state.allowAllTools) {
    const allow = (params?.options || []).find(o => o.kind === 'allow_always' || o.kind === 'allow_once') || params?.options?.[0];
    return { outcome: { outcome: 'selected', optionId: allow?.optionId || 'allow' } };
  }
  // Otherwise route through the existing ask-user wire path. We do it inline
  // here using a per-state Promise; the frontend responds via the standard
  // `ask_user_response` message which conversation.js routes back into the
  // driver via `respondToPermissionRequest(state, requestId, optionId)`.
  const requestId = `copilot-perm-${randomUUID()}`;
  const opt = params?.options || [];
  return new Promise((resolve) => {
    state.pendingPermissions.set(requestId, { resolve, options: opt });
    ctx.sendToServer({
      type: 'ask_user_question',
      conversationId: state.conversationId,
      requestId,
      question: _formatPermissionPrompt(params),
      options: opt.map(o => ({ id: o.optionId, label: o.name || o.optionId, kind: o.kind })),
    });
  });
}

/**
 * Called by conversation.js when the frontend posts an ask_user_response for
 * a permission prompt we issued. Exported so the message router can hand it
 * back without exposing the state internals.
 */
export function respondToPermissionRequest(state, requestId, optionId) {
  const slot = state?.pendingPermissions?.get(requestId);
  if (!slot) return false;
  state.pendingPermissions.delete(requestId);
  const opt = slot.options.find(o => o.optionId === optionId) || slot.options[0];
  slot.resolve({ outcome: { outcome: 'selected', optionId: opt?.optionId || optionId } });
  return true;
}

function _formatPermissionPrompt(params) {
  const tc = params?.toolCall || {};
  const title = tc.title || tc.kind || 'tool';
  const rawIn = tc.rawInput;
  let suffix = '';
  if (rawIn && typeof rawIn === 'object') {
    try { suffix = '\n```\n' + JSON.stringify(rawIn, null, 2).slice(0, 600) + '\n```'; }
    catch { /* noop */ }
  }
  return `Copilot wants to run \`${title}\`. Allow?${suffix}`;
}

function _extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content.map(c => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('');
  }
  return '';
}

function _extractToolContent(content) {
  if (!content) return '';
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (!c) continue;
      // ToolCallContent variants: content (with ContentBlock), diff
      if (c.type === 'content' && c.content) parts.push(_extractText(c.content));
      else if (c.type === 'diff') parts.push(`diff: ${c.path || ''}\n${c.newText || ''}`);
      else if (typeof c === 'string') parts.push(c);
      else parts.push(_stringify(c));
    }
    return parts.filter(Boolean).join('\n');
  }
  return _stringify(content);
}

function _stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function _knownCopilotTools() {
  // Best-effort static list (Copilot doesn't expose its toolset over ACP).
  return [
    { name: 'bash', description: 'Execute shell commands' },
    { name: 'read', description: 'Read file contents' },
    { name: 'write', description: 'Write to a file' },
    { name: 'edit', description: 'Edit a file in place' },
    { name: 'grep', description: 'Search file contents' },
    { name: 'glob', description: 'Find files by glob' },
    { name: 'list_dir', description: 'List directory contents' },
    { name: 'web_fetch', description: 'Fetch URL contents' },
    { name: 'web_search', description: 'Search the web' },
    { name: 'ask_user', description: 'Ask the user a question' },
  ];
}

/** Exported for the model picker UI. */
export function listModels() {
  return COPILOT_MODELS.slice();
}

export default { name, capabilities, start, sendInput, abort, clear, listFolders, listSessions, loadHistory, listModels, respondToPermissionRequest };


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

