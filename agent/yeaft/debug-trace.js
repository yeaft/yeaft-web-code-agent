/**
 * debug-trace.js — file-backed debug trace for Yeaft
 *
 * Stores bounded request traces on disk without SQLite. Each request owns one
 * compact JSON file under the session's debug folder:
 *   <yeaftDir>/sessions/<sessionId>/debug/requests/<requestKey>/trace.json
 *
 * The file keeps one base request snapshot plus per-loop deltas. This avoids
 * 100-200 tiny loop files and avoids repeating the whole cumulative message
 * array for every loop. Debug history remains best-effort: failures are logged
 * and dropped, never allowed to stop the agent.
 */

import { promises as fsp } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { randomUUID } from 'crypto';

const TRACE_VERSION = 2;
const REQUEST_RETENTION = 10;
const MAX_HISTORY_LIMIT = 5;
const MAX_DREAM_EVENTS = 100;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOOL_INPUT = 10 * 1024;
const MAX_INLINE_VALUE_BYTES = 1024 * 1024;
const MAX_RAW_REQUEST_BYTES = 2 * 1024 * 1024;
const TRACE_FLUSH_INTERVAL_MS = 5_000;
const TRACE_FLUSH_DIRTY_LOOPS = 10;
const MAX_SEARCH_PATTERN_CHARS = 300;

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function safeDirComponent(value, fallback = 'unknown') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || fallback;
}

function fileTraceRoot(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return null;
  // Back-compat: callers and tests historically pass a concrete debug.db
  // path. Do NOT collapse that to dirname(raw), or unrelated temp DB paths all
  // share /tmp/debug and traces bleed across tests/sessions. Explicit dirPath
  // callers pass the Yeaft root and get session-adjacent paths.
  return extname(basename(raw)) ? `${raw}.files` : raw;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function atomicWriteText(filePath, text) {
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function compileTraceSearchRegex(search) {
  const raw = typeof search === 'string' ? search.trim() : '';
  if (!raw) return null;
  if (raw.length > MAX_SEARCH_PATTERN_CHARS) {
    throw new Error(`Debug search regex is too long; max ${MAX_SEARCH_PATTERN_CHARS} characters`);
  }
  let pattern = raw;
  let flags = 'i';
  const slashForm = raw.match(/^\/(.*)\/([a-z]*)$/);
  if (slashForm) {
    pattern = slashForm[1];
    flags = slashForm[2] || '';
  }
  if (regexHasUnsafeQuantifiedGroup(pattern)) {
    throw new Error('Debug search regex contains an unsafe quantified group; refine the pattern');
  }
  const allowed = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
  const uniqueFlags = [];
  for (const ch of flags) {
    if (!allowed.has(ch)) throw new Error(`Invalid debug search regex flag: ${ch}`);
    if (!uniqueFlags.includes(ch)) uniqueFlags.push(ch);
  }
  if (!slashForm && !uniqueFlags.includes('i')) uniqueFlags.push('i');
  const stableFlags = uniqueFlags.filter(ch => ch !== 'g' && ch !== 'y').join('');
  return new RegExp(pattern, stableFlags);
}

function regexHasUnsafeQuantifiedGroup(pattern) {
  const groupBody = String.raw`(?:[^()\\]|\\.|\[[^\]]*\]|\([^()]*\))*`;
  const nestedQuantifier = new RegExp(String.raw`\(${groupBody}[+*{]${groupBody}\)\s*[+*{]`);
  const quantifiedAlternation = new RegExp(String.raw`\(${groupBody}\|${groupBody}\)\s*[+*{]`);
  return nestedQuantifier.test(pattern) || quantifiedAlternation.test(pattern);
}

function buildTraceSearchDocument(trace) {
  const loops = Array.isArray(trace?.loops) ? trace.loops : [];
  const tools = Array.isArray(trace?.tools) ? trace.tools : [];
  const toolNames = tools.map(t => t?.toolName || t?.name || '').filter(Boolean).join(' ');
  const loopModels = loops.map(l => l?.model || '').filter(Boolean).join(' ');
  const stopReasons = loops.map(l => l?.stopReason || '').filter(Boolean).join(' ');
  return [
    trace?.requestId,
    trace?.traceId,
    trace?.messageId,
    trace?.sessionId,
    trace?.vpId,
    trace?.threadId,
    trace?.mode,
    trace?.userPrompt,
    loopModels,
    stopReasons,
    toolNames,
  ].filter(v => v != null && v !== '').map(String).join('\n').slice(0, 20_000);
}

function traceMatchesRegex(trace, regex) {
  if (!regex) return true;
  try {
    return regex.test(buildTraceSearchDocument(trace));
  } catch {
    return false;
  }
}

function truncateText(value, maxBytes = MAX_TEXT_BYTES) {
  if (value == null) return value ?? null;
  const str = String(value);
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let out = str.slice(0, maxBytes);
  while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) out = out.slice(0, -1);
  return `${out}\n... [truncated to ${maxBytes} bytes]`;
}

function cloneJsonValue(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return null; }
}

function safeJsonValue(value, maxBytes = MAX_INLINE_VALUE_BYTES) {
  if (value == null) return value;
  try {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, 'utf8') <= maxBytes) return JSON.parse(json);
    return {
      __truncated: true,
      originalBytes: Buffer.byteLength(json, 'utf8'),
      maxBytes,
    };
  } catch {
    return null;
  }
}

function normalizeUsage(usage = {}, fallback = {}) {
  const inputTokens = Number.isFinite(Number(usage?.inputTokens)) ? Number(usage.inputTokens) : Number(fallback.inputTokens || 0);
  const outputTokens = Number.isFinite(Number(usage?.outputTokens)) ? Number(usage.outputTokens) : Number(fallback.outputTokens || 0);
  const cacheReadTokens = Number.isFinite(Number(usage?.cacheReadTokens)) ? Number(usage.cacheReadTokens) : Number(fallback.cacheReadTokens || 0);
  const cacheWriteTokens = Number.isFinite(Number(usage?.cacheWriteTokens)) ? Number(usage.cacheWriteTokens) : Number(fallback.cacheWriteTokens || 0);
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
}

function stableEqual(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

function jsonByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Infinity; }
}

function rawRequestSentinel(reason, value = null, maxBytes = MAX_RAW_REQUEST_BYTES) {
  const preview = typeof value === 'string'
    ? truncateText(value, Math.min(64 * 1024, maxBytes))
    : null;
  const originalBytes = value == null ? null : jsonByteLength(value);
  return {
    __truncated: true,
    reason,
    ...(originalBytes != null ? { originalBytes } : {}),
    maxBytes,
    ...(preview ? { preview } : {}),
  };
}

function boundRawValue(value, reason = 'raw_request_budget') {
  if (value == null) return value;
  const cloned = typeof value === 'string' ? value : cloneJsonValue(value);
  if (cloned == null) return null;
  if (jsonByteLength(cloned) <= MAX_RAW_REQUEST_BYTES) return cloned;
  return rawRequestSentinel(reason, value);
}

function buildRawRequestBase(value) {
  if (value == null) return null;
  if (typeof value === 'string') return truncateText(value, MAX_RAW_REQUEST_BYTES);
  if (!isPlainObject(value)) return boundRawValue(value);
  const base = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'body' && isPlainObject(item)) {
      const body = {};
      for (const [bodyKey, bodyValue] of Object.entries(item)) {
        body[bodyKey] = boundRawValue(bodyValue, `raw_request_body_${bodyKey}_budget`);
      }
      base.body = body;
    } else {
      base[key] = boundRawValue(item, `raw_request_${key}_budget`);
    }
  }
  return base;
}

function buildRawMessagesDelta(previousMessages, nextMessages) {
  if (!Array.isArray(nextMessages)) return null;
  const priorMessages = Array.isArray(previousMessages) ? previousMessages : [];
  const prefix = messagesPrefixLength(priorMessages, nextMessages);
  if (prefix === priorMessages.length && prefix <= nextMessages.length) {
    return { messagesFrom: prefix, messagesAppend: boundRawValue(nextMessages.slice(prefix), 'raw_request_messages_append_budget') };
  }
  return { messagesFrom: 0, messagesAppend: boundRawValue(nextMessages, 'raw_request_messages_append_budget') };
}

function rawComparableRequest(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) return value;
  const out = { ...value };
  if (isPlainObject(value.body)) out.body = { ...value.body };
  return out;
}

function buildRawRequestDelta(previous, next) {
  if (next == null) return previous == null ? null : { replacement: null };
  if (previous == null) return { base: buildRawRequestBase(next) };
  const comparablePrevious = rawComparableRequest(previous);
  const comparableNext = rawComparableRequest(next);
  if (typeof comparablePrevious === 'string' || typeof comparableNext === 'string') {
    return comparablePrevious === comparableNext ? null : { replacement: rawRequestSentinel('raw_request_string_replaced', comparableNext) };
  }
  if (!isPlainObject(comparablePrevious) || !isPlainObject(comparableNext)) {
    return stableEqual(comparablePrevious, comparableNext) ? null : { replacement: rawRequestSentinel('raw_request_replaced') };
  }

  const delta = { set: {}, body: {} };
  for (const key of Object.keys(comparableNext)) {
    if (key === 'body') continue;
    if (!stableEqual(comparablePrevious[key], comparableNext[key])) delta.set[key] = boundRawValue(comparableNext[key], `raw_request_${key}_budget`);
  }
  for (const key of Object.keys(comparablePrevious)) {
    if (key !== 'body' && !Object.prototype.hasOwnProperty.call(comparableNext, key)) delta.set[key] = null;
  }

  const prevBody = isPlainObject(comparablePrevious.body) ? comparablePrevious.body : null;
  const nextBody = isPlainObject(comparableNext.body) ? comparableNext.body : null;
  if (prevBody && nextBody) {
    for (const key of Object.keys(nextBody)) {
      if (key === 'messages' || key === 'input') continue;
      if (!stableEqual(prevBody[key], nextBody[key])) delta.body[key] = boundRawValue(nextBody[key], `raw_request_body_${key}_budget`);
    }
    for (const key of Object.keys(prevBody)) {
      if (key !== 'messages' && key !== 'input' && !Object.prototype.hasOwnProperty.call(nextBody, key)) delta.body[key] = null;
    }
    const prevMessages = Array.isArray(prevBody.messages) ? prevBody.messages : prevBody.input;
    const nextMessages = Array.isArray(nextBody.messages) ? nextBody.messages : nextBody.input;
    const msgDelta = buildRawMessagesDelta(prevMessages, nextMessages);
    if (msgDelta) Object.assign(delta.body, msgDelta);
  } else if (!stableEqual(previous.body, next.body)) {
    delta.set.body = rawRequestSentinel('raw_request_body_replaced');
  }

  if (Object.keys(delta.set).length === 0) delete delta.set;
  if (Object.keys(delta.body).length === 0) delete delta.body;
  if (!delta.set && !delta.body) return null;
  if (jsonByteLength(delta) > MAX_RAW_REQUEST_BYTES) {
    return { replacement: rawRequestSentinel('raw_request_delta_budget') };
  }
  return delta;
}

export function applyRawRequestDelta(previous, delta) {
  if (!delta) return previous ?? null;
  if (Object.prototype.hasOwnProperty.call(delta, 'base')) return cloneJsonValue(delta.base) ?? delta.base ?? null;
  if (Object.prototype.hasOwnProperty.call(delta, 'replacement')) return cloneJsonValue(delta.replacement) ?? delta.replacement ?? null;
  const next = isPlainObject(previous) ? cloneJsonValue(previous) || {} : {};
  if (isPlainObject(delta.set)) {
    for (const [key, value] of Object.entries(delta.set)) next[key] = cloneJsonValue(value) ?? value;
  }
  if (isPlainObject(delta.body)) {
    const body = isPlainObject(next.body) ? { ...next.body } : {};
    for (const [key, value] of Object.entries(delta.body)) {
      if (key === 'messagesFrom' || key === 'messagesAppend' || key === 'messages') continue;
      body[key] = cloneJsonValue(value) ?? value;
    }
    const messageKey = Array.isArray(body.messages) || Object.prototype.hasOwnProperty.call(delta.body, 'messages') ? 'messages' : 'input';
    if (Array.isArray(delta.body.messages)) {
      body[messageKey] = cloneJsonValue(delta.body.messages) || [];
    } else if (Array.isArray(delta.body.messagesAppend)) {
      const existing = Array.isArray(body[messageKey]) ? body[messageKey] : [];
      const from = Number.isFinite(Number(delta.body.messagesFrom)) ? Number(delta.body.messagesFrom) : existing.length;
      body[messageKey] = existing.slice(0, from).concat(cloneJsonValue(delta.body.messagesAppend) || []);
    }
    next.body = body;
  }
  return next;
}

function messagesPrefixLength(prevMessages, nextMessages) {
  if (!Array.isArray(prevMessages) || !Array.isArray(nextMessages)) return 0;
  const max = Math.min(prevMessages.length, nextMessages.length);
  let i = 0;
  for (; i < max; i++) {
    if (!stableEqual(prevMessages[i], nextMessages[i])) break;
  }
  return i;
}

function buildRequestSnapshot(info = {}) {
  return {
    systemPrompt: truncateText(info.systemPrompt || '', MAX_TEXT_BYTES),
    messages: Array.isArray(info.messages) ? cloneJsonValue(info.messages) : [],
    rawRequest: info.rawRequest ?? null,
  };
}

function buildRequestDelta(previous, next) {
  if (!previous) {
    const delta = {
      base: true,
      systemPrompt: next.systemPrompt || '',
      messages: Array.isArray(next.messages) ? next.messages : [],
    };
    const rawRequestDelta = buildRawRequestDelta(null, next.rawRequest);
    if (rawRequestDelta) delta.rawRequestDelta = rawRequestDelta;
    return delta;
  }
  const delta = {};
  if ((next.systemPrompt || '') !== (previous.systemPrompt || '')) {
    delta.systemPrompt = next.systemPrompt || '';
  }
  const prevMessages = Array.isArray(previous.messages) ? previous.messages : [];
  const nextMessages = Array.isArray(next.messages) ? next.messages : [];
  const prefix = messagesPrefixLength(prevMessages, nextMessages);
  if (prefix === prevMessages.length && prefix <= nextMessages.length) {
    const appended = nextMessages.slice(prefix);
    delta.messagesFrom = prefix;
    delta.messagesAppend = appended;
  } else {
    delta.messages = nextMessages;
  }
  const rawRequestDelta = buildRawRequestDelta(previous.rawRequest, next.rawRequest);
  if (rawRequestDelta) delta.rawRequestDelta = rawRequestDelta;
  return delta;
}

function applyRequestDelta(previous, delta = {}) {
  const base = previous || { systemPrompt: '', messages: [], rawRequest: null };
  const next = {
    systemPrompt: base.systemPrompt || '',
    messages: Array.isArray(base.messages) ? [...base.messages] : [],
    rawRequest: base.rawRequest ?? null,
  };
  if (delta.base) {
    const nextBase = {
      systemPrompt: delta.systemPrompt || '',
      messages: Array.isArray(delta.messages) ? delta.messages : [],
      rawRequest: null,
    };
    if (Object.prototype.hasOwnProperty.call(delta, 'rawRequestDelta')) {
      nextBase.rawRequest = applyRawRequestDelta(null, delta.rawRequestDelta);
    }
    return nextBase;
  }
  if (typeof delta.systemPrompt === 'string') next.systemPrompt = delta.systemPrompt;
  if (Array.isArray(delta.messages)) {
    next.messages = delta.messages;
  } else if (Array.isArray(delta.messagesAppend)) {
    const from = Number.isFinite(Number(delta.messagesFrom)) ? Number(delta.messagesFrom) : next.messages.length;
    next.messages = next.messages.slice(0, from).concat(delta.messagesAppend);
  }
  if (Object.prototype.hasOwnProperty.call(delta, 'rawRequestDelta')) next.rawRequest = applyRawRequestDelta(next.rawRequest, delta.rawRequestDelta);
  return next;
}

export function reconstructDebugRawRequest(baseRawRequest, requestDelta) {
  if (!requestDelta || !Object.prototype.hasOwnProperty.call(requestDelta, 'rawRequestDelta')) {
    return baseRawRequest ?? null;
  }
  return applyRawRequestDelta(baseRawRequest ?? null, requestDelta.rawRequestDelta);
}

function sessionRequestsDir(rootDir, sessionId) {
  if (sessionId) return join(rootDir, 'sessions', safeDirComponent(sessionId), 'debug', 'requests');
  return join(rootDir, 'debug', 'requests');
}

function requestFilePath(requestDir) {
  return join(requestDir, 'trace.json');
}

function tracePathFor(rootDir, sessionId, requestKey) {
  return requestFilePath(join(sessionRequestsDir(rootDir, sessionId), safeDirComponent(requestKey, 'request')));
}

function summarizeTrace(trace, detailsLoaded = false) {
  const loops = Array.isArray(trace?.loops) ? trace.loops : [];
  const usage = loops.reduce((acc, loop) => {
    const u = normalizeUsage(loop?.usage || {});
    acc.totalMs += Number(loop?.latencyMs || 0);
    acc.totalTokens += u.totalTokens || 0;
    acc.summaryInputTokens += u.totalInputTokens || 0;
    acc.summaryOutputTokens += u.outputTokens || 0;
    return acc;
  }, { totalMs: 0, totalTokens: 0, summaryInputTokens: 0, summaryOutputTokens: 0 });
  return {
    turnId: trace?.requestId || trace?.traceId || '',
    userPrompt: trace?.userPrompt || '',
    sessionId: trace?.sessionId || null,
    vpId: trace?.vpId || null,
    threadId: trace?.threadId || null,
    openedAt: trace?.openedAt || 0,
    closedAt: trace?.closedAt || null,
    totalMs: usage.totalMs,
    totalTokens: usage.totalTokens,
    summaryInputTokens: usage.summaryInputTokens,
    summaryOutputTokens: usage.summaryOutputTokens,
    loopCount: loops.length,
    memoryLoaded: null,
    memoryAdjust: null,
    tools: Array.isArray(trace?.tools) ? trace.tools.map(t => ({
      loopNumber: t.loopNumber || 0,
      callId: t.toolCallId || t.id || null,
      traceToolId: t.id || null,
      name: t.toolName || t.name || '?',
      toolOutput: t.toolOutput == null ? null : String(t.toolOutput),
      durationMs: t.durationMs || 0,
      isError: !!t.isError,
    })) : [],
    detailsLoaded,
    requestBase: trace?.baseRequest || null,
  };
}

function expandTrace(trace) {
  const turnsById = new Map([[trace.requestId || trace.traceId, summarizeTrace(trace, true)]]);
  let snapshot = null;
  const loops = [];
  for (const loop of Array.isArray(trace?.loops) ? trace.loops : []) {
    snapshot = applyRequestDelta(snapshot || trace.baseRequest || null, loop.requestDelta || {});
    const usage = normalizeUsage(loop?.usage || {});
    loops.push({
      turnId: trace.requestId || trace.traceId,
      loopInstanceId: loop.loopInstanceId || loop.turnRowId || null,
      loopNumber: loop.loopNumber || 0,
      model: loop.model || null,
      systemPrompt: snapshot.systemPrompt || '',
      messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
      response: loop.response || '',
      toolCalls: Array.isArray(loop.toolCalls) ? loop.toolCalls : [],
      usage,
      latencyMs: loop.latencyMs || 0,
      ttfbMs: loop.ttfbMs || null,
      stopReason: loop.stopReason || null,
      at: loop.at || null,
      rawRequest: null,
      rawResponse: loop.rawResponse ?? null,
      requestDelta: loop.requestDelta || {},
      requestBase: trace.baseRequest || null,
      sessionId: trace.sessionId || null,
      vpId: trace.vpId || null,
      threadId: trace.threadId || null,
    });
  }
  return { loops, turns: Array.from(turnsById.values()) };
}

function traceToLegacyRows(trace) {
  let snapshot = null;
  return (Array.isArray(trace?.loops) ? trace.loops : []).map((loop) => {
    snapshot = applyRequestDelta(snapshot || trace.baseRequest || null, loop.requestDelta || {});
    const u = normalizeUsage(loop?.usage || {});
    return {
      id: loop.turnRowId || loop.loopInstanceId || randomUUID(),
      trace_id: trace.traceId || trace.requestId,
      message_id: trace.messageId || null,
      mode: trace.mode || null,
      turn_number: loop.loopNumber || 0,
      model: loop.model || null,
      input_tokens: u.inputTokens || 0,
      output_tokens: u.outputTokens || 0,
      cache_read_tokens: u.cacheReadTokens || 0,
      cache_write_tokens: u.cacheWriteTokens || 0,
      stop_reason: loop.stopReason || null,
      latency_ms: loop.latencyMs || 0,
      response_text: loop.response || '',
      started_at: loop.startedAt || trace.openedAt || 0,
      ended_at: loop.at || trace.closedAt || null,
      group_id: trace.sessionId || null,
      vp_id: trace.vpId || null,
      thread_id: trace.threadId || null,
      system_prompt: snapshot.systemPrompt || '',
      messages_json: JSON.stringify(snapshot.messages || []),
      tool_calls_json: JSON.stringify(loop.toolCalls || []),
      usage_json: JSON.stringify(u),
      ttfb_ms: loop.ttfbMs || null,
      raw_request: null,
      raw_response: typeof loop.rawResponse === 'string' ? loop.rawResponse : JSON.stringify(loop.rawResponse ?? null),
      user_prompt: trace.userPrompt || '',
    };
  });
}

function traceToolToLegacy(trace, tool) {
  return {
    id: tool.id || randomUUID(),
    turn_id: tool.turnRowId || null,
    tool_name: tool.toolName || tool.name || '?',
    tool_input: tool.toolInput == null ? null : String(tool.toolInput),
    tool_output: tool.toolOutput == null ? null : String(tool.toolOutput),
    tool_call_id: tool.toolCallId || null,
    duration_ms: tool.durationMs || 0,
    is_error: tool.isError ? 1 : 0,
    created_at: tool.createdAt || trace.openedAt || 0,
  };
}

async function readdirSafe(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}

async function collectTraceFiles(rootDir, sessionId = null) {
  const files = [];
  const addFromRequestsDir = async (requestsDir) => {
    for (const entry of await readdirSafe(requestsDir)) {
      if (!entry.isDirectory()) continue;
      const file = requestFilePath(join(requestsDir, entry.name));
      try {
        await fsp.access(file);
        files.push(file);
      } catch { /* trace.json not yet written for this request dir */ }
    }
  };
  if (sessionId) {
    await addFromRequestsDir(sessionRequestsDir(rootDir, sessionId));
    return files;
  }
  await addFromRequestsDir(sessionRequestsDir(rootDir, null));
  const sessionsRoot = join(rootDir, 'sessions');
  for (const entry of await readdirSafe(sessionsRoot)) {
    if (!entry.isDirectory()) continue;
    await addFromRequestsDir(join(sessionsRoot, entry.name, 'debug', 'requests'));
  }
  return files;
}

async function readTraceSummaries(rootDir, sessionId = null) {
  const traces = [];
  for (const file of await collectTraceFiles(rootDir, sessionId)) {
    const trace = await readJson(file);
    if (!trace || !trace.requestId) continue;
    traces.push({ trace, file, openedAt: Number(trace.openedAt || 0) });
  }
  traces.sort((a, b) => ((a.openedAt || 0) - (b.openedAt || 0)) || String(a.trace?.requestKey || a.file).localeCompare(String(b.trace?.requestKey || b.file)));
  return traces;
}

async function countDirFiles(rootDir) {
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    for (const entry of await readdirSafe(dir)) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else {
        files += 1;
        try { bytes += (await fsp.stat(p)).size; } catch { /* ignore */ }
      }
    }
  };
  await walk(rootDir);
  return { files, bytes };
}

export class DebugTrace {
  /** @type {string} */
  #rootDir;
  /** @type {Map<string, { requestKey: string, sessionId: string|null, traceId: string, loopNumber: number }>} */
  #turnIndex = new Map();
  /** @type {Map<string, object>} */
  #requestCache = new Map();
  /** @type {Map<string, { trace: object, dirtyLoops: number, firstDirtyAt: number }>} */
  #pendingWrites = new Map();
  /** @type {NodeJS.Timeout|null} */
  #flushTimer = null;
  /** @type {number} */
  #sequence = 0;
  /**
   * In-memory dream/event ring (authoritative copy; persisted async).
   * @type {Array<object>}
   */
  #events = [];
  /** @type {boolean} */
  #eventsDirty = false;
  /**
   * Whether the on-disk events.json has been folded into #events yet. The
   * events ring must merge prior-run history exactly once before any flush
   * overwrites the file, or a live append landing before first hydrate would
   * silently destroy cross-restart dream history.
   * @type {boolean}
   */
  #eventsHydrated = false;
  /** @type {NodeJS.Timeout|null} */
  #eventFlushTimer = null;
  /**
   * One-time hydrate guard. Reads/maintenance load every on-disk trace into
   * #requestCache exactly once; afterwards every query is served from memory
   * with zero disk reads. The write path never hydrates — it only appends.
   * @type {boolean}
   */
  #hydrated = false;
  /** @type {Promise<void>|null} */
  #hydratePromise = null;
  /**
   * Serializes async flushes so two overlapping flushes never interleave
   * writes to the same trace file. close()/purge() await this to drain.
   * @type {Promise<void>}
   */
  #flushChain = Promise.resolve();

  /**
   * @param {string} tracePath — Back-compatible path. If it looks like a DB
   * file, traces are stored in a sibling `debug/` directory.
   */
  constructor(tracePath) {
    const rootDir = fileTraceRoot(tracePath);
    if (!rootDir) throw new Error('DebugTrace requires a storage path');
    this.#rootDir = rootDir;
    // Best-effort, fire-and-forget: atomicWriteText re-ensures the request
    // subdir before every write, so a missed mkdir here is harmless.
    ensureDir(rootDir).catch(() => {});
  }

  startTurn({ traceId, messageId = null, mode = null, turnNumber = null, sessionId = null, vpId = null, threadId = null, userPrompt = null } = {}) {
    const turnRowId = randomUUID();
    const now = Date.now();
    const request = this.#getOrCreateRequest({
      traceId: traceId || turnRowId,
      turnNumber: Number(turnNumber || 0),
      messageId,
      mode,
      sessionId,
      vpId,
      threadId,
      userPrompt,
      now,
      turnRowId,
    });
    this.#turnIndex.set(turnRowId, {
      requestKey: request.requestKey,
      sessionId: request.sessionId || null,
      traceId: request.traceId,
      loopNumber: Number(turnNumber || 0),
    });
    return turnRowId;
  }

  endTurn(turnId, info = {}) {
    const ctx = this.#turnIndex.get(turnId);
    if (!ctx) return;
    const trace = this.#loadRequest(ctx.sessionId, ctx.requestKey);
    if (!trace) return;
    const loopNumber = ctx.loopNumber || Number(info.turnNumber || 0);
    const snapshot = buildRequestSnapshot(info);
    const previousSnapshot = trace._lastSnapshot || this.#reconstructLastSnapshot(trace);
    if (!trace.baseRequest) {
      trace.baseRequest = {
        systemPrompt: snapshot.systemPrompt,
        messages: Array.isArray(snapshot.messages) ? cloneJsonValue(snapshot.messages) : [],
        rawRequest: null,
      };
    }
    const loopIndex = (trace.loops || []).findIndex(l => l.turnRowId === turnId);
    const loop = {
      loopInstanceId: turnId,
      turnRowId: turnId,
      loopNumber,
      startedAt: trace.openedAt || Date.now(),
      model: info.model || null,
      response: truncateText(info.responseText || '', MAX_TEXT_BYTES),
      toolCalls: cloneJsonValue(Array.isArray(info.toolCalls) ? info.toolCalls : []),
      usage: normalizeUsage(info.usage || {}, {
        inputTokens: info.inputTokens || 0,
        outputTokens: info.outputTokens || 0,
        cacheReadTokens: info.cacheReadTokens || 0,
        cacheWriteTokens: info.cacheWriteTokens || 0,
      }),
      latencyMs: Number(info.latencyMs || 0),
      ttfbMs: Number.isFinite(Number(info.ttfbMs)) ? Number(info.ttfbMs) : null,
      stopReason: info.stopReason || null,
      at: Date.now(),
      rawResponse: typeof info.rawResponse === 'string'
        ? truncateText(info.rawResponse, MAX_TEXT_BYTES)
        : safeJsonValue(info.rawResponse),
      requestDelta: buildRequestDelta(previousSnapshot, snapshot),
    };
    if (loopIndex >= 0) trace.loops[loopIndex] = loop;
    else trace.loops.push(loop);
    trace.loops.sort((a, b) => (a.loopNumber || 0) - (b.loopNumber || 0) || String(a.turnRowId || '').localeCompare(String(b.turnRowId || '')));
    trace.closedAt = loop.at;
    trace.updatedAt = loop.at;
    trace.active = info.stopReason ? !['end_turn', 'error', 'aborted'].includes(String(info.stopReason)) : false;
    trace._lastSnapshot = snapshot;
    this.#markDirty(trace, { dirtyLoops: 1, force: !trace.active });
  }

  logTool(turnId, { toolName, toolCallId = null, toolInput = null, toolOutput = null, durationMs = null, isError = false } = {}) {
    const id = randomUUID();
    const ctx = this.#turnIndex.get(turnId);
    if (!ctx) return id;
    const trace = this.#loadRequest(ctx.sessionId, ctx.requestKey);
    if (!trace) return id;
    if (!Array.isArray(trace.tools)) trace.tools = [];
    trace.tools.push({
      id,
      turnRowId: turnId,
      loopNumber: ctx.loopNumber || 0,
      toolName: toolName || '?',
      toolCallId,
      toolInput: truncateText(toolInput == null ? null : String(toolInput), MAX_TOOL_INPUT),
      toolOutput: truncateText(toolOutput == null ? null : String(toolOutput), MAX_TEXT_BYTES),
      durationMs: Number(durationMs || 0),
      isError: !!isError,
      createdAt: Date.now(),
    });
    trace.updatedAt = Date.now();
    this.#markDirty(trace, { dirtyLoops: 0, force: !trace.active });
    return id;
  }

  logEvent({ traceId, eventType, eventData = null } = {}) {
    const id = randomUUID();
    // In-memory authoritative ring; persisted async (fire-and-forget). The
    // dream/event sink runs on the engine hot path, so it must not block on a
    // synchronous read-modify-write of events.json.
    this.#events.push({
      id,
      traceId: traceId || String(eventType || 'event'),
      eventType: eventType || 'event',
      eventData: safeJsonValue(eventData),
      createdAt: Date.now(),
    });
    if (this.#events.length > MAX_DREAM_EVENTS) {
      this.#events = this.#events.slice(-MAX_DREAM_EVENTS);
    }
    this.#scheduleEventFlush();
    return id;
  }

  event(eventType, eventData = null) {
    const traceId = (eventData && typeof eventData === 'object' && (eventData.turnId || eventData.runId))
      ? String(eventData.turnId || eventData.runId)
      : String(eventType || 'event');
    return this.logEvent({ traceId, eventType, eventData });
  }

  async queryByMessage(messageId) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const traces = this.#traceSummaries()
      .filter(({ trace }) => trace.messageId === messageId)
      .map(({ trace }) => trace);
    return this.#expandLegacy(traces);
  }

  async queryByTrace(traceId) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const traces = this.#traceSummaries()
      .filter(({ trace }) => trace.traceId === traceId || trace.requestId === traceId)
      .map(({ trace }) => trace);
    return this.#expandLegacy(traces);
  }

  async queryRecent(limit = 20) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const lim = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Number(limit) || MAX_HISTORY_LIMIT));
    return this.#traceSummaries()
      .slice(-lim)
      .reverse()
      .flatMap(({ trace }) => traceToLegacyRows(trace));
  }

  async fetchRecentDebugHistory({ limit = MAX_HISTORY_LIMIT, dreamLimit = 5, sessionId = null, threadId = null, indexOnly = false, detailTurnId = null, search = '' } = {}) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const lim = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Number(limit) || MAX_HISTORY_LIMIT));
    const requestedDetailTurnId = typeof detailTurnId === 'string' && detailTurnId ? detailTurnId : null;
    const searchRegex = requestedDetailTurnId ? null : compileTraceSearchRegex(search);
    const traces = this.#traceSummaries(sessionId)
      .filter(({ trace }) => !threadId || trace.threadId === threadId)
      .filter(({ trace }) => requestedDetailTurnId || traceMatchesRegex(trace, searchRegex))
      .map(({ trace }) => trace);
    const dreamEvents = this.#readDreamEvents({ sessionId, dreamLimit });
    if (requestedDetailTurnId) {
      const trace = traces.find(t => t.requestId === requestedDetailTurnId || t.traceId === requestedDetailTurnId);
      if (!trace) return { loops: [], turns: [], dreamEvents, hasMore: false, limit: 0, indexOnly: false, detailTurnId: requestedDetailTurnId };
      const expanded = expandTrace(trace);
      return { ...expanded, dreamEvents, hasMore: false, limit: expanded.loops.length, indexOnly: false, detailTurnId: requestedDetailTurnId };
    }
    const selected = traces.slice(-lim);
    if (indexOnly) {
      return {
        loops: [],
        turns: selected.map(trace => summarizeTrace(trace, false)),
        dreamEvents,
        hasMore: traces.length > selected.length,
        limit: lim,
        indexOnly: true,
      };
    }
    const expanded = selected.reduce((acc, trace) => {
      const item = expandTrace(trace);
      acc.loops.push(...item.loops);
      acc.turns.push(...item.turns);
      return acc;
    }, { loops: [], turns: [] });
    return { ...expanded, dreamEvents, hasMore: traces.length > selected.length, limit: lim, indexOnly: false };
  }

  async queryTools({ name = null, since = null } = {}) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const tools = [];
    for (const { trace } of this.#traceSummaries()) {
      for (const tool of Array.isArray(trace.tools) ? trace.tools : []) {
        const row = traceToolToLegacy(trace, tool);
        if (name && row.tool_name !== name) continue;
        if (since && row.created_at < since) continue;
        tools.push(row);
      }
    }
    tools.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return tools.slice(0, 100);
  }

  async search(keyword) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const needle = String(keyword || '').toLowerCase();
    if (!needle) return [];
    return this.#traceSummaries()
      .filter(({ trace }) => JSON.stringify(trace).toLowerCase().includes(needle))
      .slice(-50)
      .reverse()
      .flatMap(({ trace }) => traceToLegacyRows(trace));
  }

  async stats() {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const traces = this.#traceSummaries().map(({ trace }) => trace);
    const turnCount = traces.reduce((n, trace) => n + (Array.isArray(trace.loops) ? trace.loops.length : 0), 0);
    const toolCount = traces.reduce((n, trace) => n + (Array.isArray(trace.tools) ? trace.tools.length : 0), 0);
    const eventCount = this.#events.length;
    const { bytes } = await countDirFiles(this.#rootDir);
    return { turnCount, toolCount, eventCount, dbSizeBytes: bytes, fileSizeBytes: bytes, requestCount: traces.length };
  }

  async cleanup(retention = REQUEST_RETENTION) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const keep = Math.max(1, Math.min(REQUEST_RETENTION, Number(retention) || REQUEST_RETENTION));
    const before = this.#traceSummaries().length;
    await this.#pruneAll(keep);
    const after = this.#traceSummaries().length;
    return { deletedTurns: Math.max(0, before - after), deletedTools: 0, deletedEvents: 0, deletedRequests: Math.max(0, before - after) };
  }

  async compact() {
    await this.#ensureHydrated();
    const before = (await countDirFiles(this.#rootDir)).bytes;
    await this.cleanup(REQUEST_RETENTION);
    const after = (await countDirFiles(this.#rootDir)).bytes;
    return { before, after };
  }

  async purge() {
    await this.#drainWrites();
    try { await fsp.rm(this.#rootDir, { recursive: true, force: true }); }
    catch { /* ignore */ }
    await ensureDir(this.#rootDir);
    this.#turnIndex.clear();
    this.#requestCache.clear();
    this.#events = [];
    this.#hydrated = false;
    this.#hydratePromise = null;
    this.#eventsHydrated = false;
  }

  async close() {
    // #drainWrites() flushes pending writes itself; no separate #flushPending().
    await this.#drainWrites();
  }

  /**
   * Force all buffered trace + event writes to disk and await them. Unlike
   * close() this does not tear down state, so the instance keeps accepting
   * writes. Useful when a caller needs durability at a checkpoint.
   */
  async flush() {
    await this.#drainWrites();
  }

  #getOrCreateRequest({ traceId, turnNumber, messageId, mode, sessionId, vpId, threadId, userPrompt, now, turnRowId }) {
    const normalizedSessionId = sessionId || null;
    const isUsableExisting = (t) => (
      t?.sessionId === normalizedSessionId
      && t?.traceId === traceId
      && !(turnNumber === 1 && (t.loops || []).some(l => l.loopNumber === 1))
    );
    // Cache-only: the write path must NEVER touch disk (that was the O(N^2)
    // event-loop stall). Every trace created in this process lives in
    // #requestCache; same-traceId reuse and the legacy-duplicate-Loop-1 split
    // both only concern traces opened in THIS run.
    const sameSession = Array.from(this.#requestCache.values())
      .filter(t => (t?.sessionId || null) === normalizedSessionId);
    const existing = sameSession
      .filter(isUsableExisting)
      .sort((a, b) => ((a.openedAt || 0) - (b.openedAt || 0)) || String(a.requestKey || '').localeCompare(String(b.requestKey || '')))
      .at(-1) || null;
    if (existing) {
      existing.updatedAt = now;
      this.#requestCache.set(existing.requestKey, existing);
      return existing;
    }
    const seq = (this.#sequence = (this.#sequence + 1) % 1_000_000);
    const requestKey = `${String(now).padStart(13, '0')}-${String(seq).padStart(6, '0')}-${safeDirComponent(traceId || turnRowId, 'request')}-${turnRowId.slice(0, 8)}`;
    const requestId = turnNumber === 1 && sameSession.some(t => t.traceId === traceId) ? turnRowId : traceId;
    const trace = {
      version: TRACE_VERSION,
      requestKey,
      requestId,
      traceId,
      messageId,
      mode,
      sessionId: normalizedSessionId,
      vpId: vpId || null,
      threadId: threadId || null,
      userPrompt: truncateText(userPrompt || '', MAX_TEXT_BYTES),
      openedAt: now,
      closedAt: null,
      updatedAt: now,
      active: true,
      baseRequest: null,
      loops: [],
      tools: [],
    };
    this.#requestCache.set(requestKey, trace);
    return trace;
  }

  #loadRequest(sessionId, requestKey) {
    // Cache-only by design: endTurn/logTool always run in the same turn that
    // startTurn minted the trace, so it is already resident. Never read disk
    // on the write path — that is the stall we are eliminating.
    return this.#requestCache.get(requestKey) || null;
  }

  #traceSummaries(sessionId = null) {
    // Cache-only: #ensureHydrated() has already merged every on-disk trace
    // into #requestCache exactly once, so we never touch disk here. This is
    // what turns the old O(N^2) per-query rescan into an in-memory filter.
    const out = [];
    for (const trace of this.#requestCache.values()) {
      if (sessionId && trace.sessionId !== sessionId) continue;
      if (!trace?.requestId || !trace?.requestKey) continue;
      out.push({
        trace,
        file: this.#traceFile(trace),
        openedAt: Number(trace.openedAt || 0),
      });
    }
    return out.sort((a, b) => ((a.openedAt || 0) - (b.openedAt || 0)) || String(a.trace?.requestKey || a.file).localeCompare(String(b.trace?.requestKey || b.file)));
  }

  /**
   * Load every on-disk trace into #requestCache exactly once. Live entries
   * (created by this process) always win over their disk copy — a flush may
   * be mid-flight, and the in-memory trace is the newer truth. Idempotent and
   * concurrency-safe: overlapping callers await the same promise.
   *
   * Footprint trade-off (deliberate): this pins every session's full trace
   * payload (systemPrompt + cumulative messages + rawRequest, each already
   * byte-bounded) in #requestCache for the instance's lifetime — O(retention ×
   * total sessions) memory instead of the old O(N²) per-query CPU rescan that
   * stalled the event loop. Retention (10/session) and the byte caps keep it
   * bounded, and the web path uses a single module-level instance. Follow-up if
   * footprint ever bites: hydrate per queried sessionId, or keep only a
   * lightweight summary resident and lazy-load full payloads on detailTurnId.
   */
  async #ensureHydrated() {
    if (this.#hydrated) return;
    if (this.#hydratePromise) return this.#hydratePromise;
    this.#hydratePromise = (async () => {
      const [summaries, storedEvents] = await Promise.all([
        readTraceSummaries(this.#rootDir),
        readJson(join(this.#rootDir, 'events.json')),
      ]);
      for (const { trace } of summaries) {
        if (!trace?.requestKey) continue;
        // Never clobber a live in-memory trace with its older disk snapshot.
        if (!this.#requestCache.has(trace.requestKey)) {
          this.#requestCache.set(trace.requestKey, trace);
        }
      }
      if (Array.isArray(storedEvents)) this.#mergeStoredEvents(storedEvents);
      this.#hydrated = true;
      this.#hydratePromise = null;
    })();
    return this.#hydratePromise;
  }

  /**
   * Fold on-disk events into the in-memory ring by id, preserving live order
   * and bounding to MAX_DREAM_EVENTS. Unseen disk records are prepended (they
   * are older); a live append therefore never erases prior-run history. Sets
   * #eventsHydrated so this runs at most once.
   */
  #mergeStoredEvents(stored) {
    if (this.#eventsHydrated) return;
    this.#eventsHydrated = true;
    if (!Array.isArray(stored) || stored.length === 0) return;
    const seen = new Set(this.#events.map(e => e?.id).filter(Boolean));
    const older = stored.filter(e => e && (!e.id || !seen.has(e.id)));
    if (older.length === 0) return;
    this.#events = [...older, ...this.#events].slice(-MAX_DREAM_EVENTS);
  }

  #traceWriteKey(trace) {
    return `${trace.sessionId || ''}::${trace.requestKey}`;
  }

  #traceFile(trace) {
    return tracePathFor(this.#rootDir, trace.sessionId || null, trace.requestKey);
  }

  #serializableTrace(trace) {
    const toWrite = { ...trace };
    delete toWrite._lastSnapshot;
    return toWrite;
  }

  #markDirty(trace, { dirtyLoops = 0, force = false } = {}) {
    if (!trace?.requestKey) return;
    const key = this.#traceWriteKey(trace);
    const existing = this.#pendingWrites.get(key);
    const now = Date.now();
    const item = existing || { trace, dirtyLoops: 0, firstDirtyAt: now };
    item.trace = trace;
    item.dirtyLoops += Math.max(0, Number(dirtyLoops) || 0);
    this.#pendingWrites.set(key, item);
    this.#requestCache.set(trace.requestKey, trace);

    if (force || item.dirtyLoops >= TRACE_FLUSH_DIRTY_LOOPS) {
      this.#flushPending();
      return;
    }
    this.#scheduleFlushTimer(now);
  }

  #scheduleFlushTimer(now = Date.now()) {
    if (this.#flushTimer || this.#pendingWrites.size === 0) return;
    const oldestDirtyAt = Math.min(...Array.from(this.#pendingWrites.values()).map(item => item.firstDirtyAt || now));
    const dueIn = Math.max(0, TRACE_FLUSH_INTERVAL_MS - (now - oldestDirtyAt));
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flushPending();
    }, dueIn);
    if (typeof this.#flushTimer.unref === 'function') this.#flushTimer.unref();
  }

  #scheduleEventFlush() {
    this.#eventsDirty = true;
    if (this.#eventFlushTimer) return;
    this.#eventFlushTimer = setTimeout(() => {
      this.#eventFlushTimer = null;
      this.#flushEvents();
    }, TRACE_FLUSH_INTERVAL_MS);
    if (typeof this.#eventFlushTimer.unref === 'function') this.#eventFlushTimer.unref();
  }

  /**
   * Drain pending trace writes synchronously-from-the-caller's-view: snapshot
   * each dirty trace to a JSON STRING now (so later in-place mutation of the
   * live `loops` array can't tear the payload), then chain the async writes
   * onto #flushChain. Returns nothing; callers that need durability await
   * #drainWrites().
   */
  #flushPending() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const entries = Array.from(this.#pendingWrites.values());
    if (entries.length === 0) {
      this.#flushEvents();
      return;
    }
    this.#pendingWrites.clear();
    // Capture point-in-time payloads synchronously (so later in-place mutation
    // of the live `loops` array can't tear a payload), but remember each
    // request key: a prune chained ahead of this write may evict the request
    // before the write runs, and we must NOT resurrect a pruned trace on disk.
    const jobs = entries.map(({ trace }) => ({
      requestKey: trace.requestKey,
      file: this.#traceFile(trace),
      text: JSON.stringify(this.#serializableTrace(trace)),
    }));
    this.#chain(async () => {
      for (const { requestKey, file, text } of jobs) {
        // Skip if an earlier chained prune already evicted this request.
        if (!this.#requestCache.has(requestKey)) continue;
        try { await atomicWriteText(file, text); }
        catch (err) { console.warn('[Yeaft] debug trace write failed:', err?.message || err); }
      }
      try { await this.#pruneAll(REQUEST_RETENTION); }
      catch (err) { console.warn('[Yeaft] debug trace prune failed:', err?.message || err); }
    });
    this.#flushEvents();
  }

  /**
   * Append `task` to the single-writer flush mutex. Each link is isolated:
   * a rejected predecessor can NEVER skip a later task (the classic
   * `chain = chain.then(task)` footgun, where one rejection poisons every
   * subsequent `.then(onFulfilled)` and silently stops all future writes).
   * Here we always `await prev` inside a swallowing try/catch before running
   * `task`, so the chain stays alive for the instance's lifetime.
   */
  #chain(task) {
    const prev = this.#flushChain;
    this.#flushChain = (async () => {
      try { await prev; } catch { /* predecessor errors already logged */ }
      await task();
    })();
    return this.#flushChain;
  }

  #flushEvents() {
    if (!this.#eventsDirty) return;
    this.#eventsDirty = false;
    if (this.#eventFlushTimer) {
      clearTimeout(this.#eventFlushTimer);
      this.#eventFlushTimer = null;
    }
    const file = join(this.#rootDir, 'events.json');
    this.#chain(async () => {
      // Fold in any prior-run events we haven't loaded yet BEFORE overwriting,
      // so a write that beats #ensureHydrated can't drop cross-restart history.
      if (!this.#eventsHydrated) {
        this.#mergeStoredEvents(await readJson(file));
      }
      const text = JSON.stringify(this.#events.slice(-MAX_DREAM_EVENTS));
      try { await atomicWriteText(file, text); }
      catch (err) { console.warn('[Yeaft] debug trace event write failed:', err?.message || err); }
    });
  }

  /** Await every scheduled write (and prune) to settle. Used by close()/queries. */
  async #drainWrites() {
    this.#flushPending();
    let prev = null;
    // The chain can grow while we await (a query's flush appends more); loop
    // until it stabilises so close() is a true barrier.
    while (this.#flushChain !== prev) {
      prev = this.#flushChain;
      try { await prev; } catch { /* per-write errors already logged */ }
    }
  }

  #reconstructLastSnapshot(trace) {
    let snapshot = null;
    for (const loop of Array.isArray(trace?.loops) ? trace.loops : []) {
      snapshot = applyRequestDelta(snapshot || trace.baseRequest || null, loop.requestDelta || {});
    }
    return snapshot;
  }

  #readDreamEvents({ sessionId = null, dreamLimit = 5 } = {}) {
    const limit = Number.isFinite(Number(dreamLimit)) ? Math.max(0, Math.min(50, Number(dreamLimit))) : 5;
    if (limit <= 0) return [];
    // In-memory ring (hydrated once); no disk read on the query path.
    const events = this.#events;
    const out = [];
    for (const event of events.slice().reverse()) {
      const data = isPlainObject(event.eventData) ? event.eventData : {};
      if (sessionId) {
        const evtSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
        const target = typeof data.target === 'string' ? data.target : '';
        const isBroadcast = !evtSessionId && !target;
        const isThisSession = evtSessionId === sessionId || target === `sessions/${sessionId}` || target === `group/${sessionId}`;
        if (!isBroadcast && !isThisSession) continue;
      }
      out.push({
        type: data.type || event.eventType || 'event',
        ...data,
        at: event.createdAt,
        ts: data.ts || data.at || event.createdAt,
      });
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  async #pruneAll(keep) {
    // Cache-only enumeration; rm the pruned request dirs async. No disk scan.
    const sessions = new Set([null]);
    for (const trace of this.#requestCache.values()) sessions.add(trace.sessionId || null);
    for (const sid of sessions) await this.#pruneSession(sid, keep);
  }

  async #pruneSession(sessionId, keep = REQUEST_RETENTION) {
    const traces = this.#traceSummaries(sessionId);
    const activeCutoff = Date.now() - 6 * 60 * 60 * 1000;
    const protectedItems = traces.filter(item => item.trace?.active && Number(item.trace?.updatedAt || 0) >= activeCutoff);
    const pruneCandidates = traces.filter(item => !protectedItems.includes(item));
    const stale = pruneCandidates.slice(0, Math.max(0, traces.length - protectedItems.length - keep));
    for (const item of stale) {
      // Drop from cache first so subsequent queries never resurface it, even
      // if the async rm is still in flight or fails.
      this.#requestCache.delete(item.trace.requestKey);
      try { await fsp.rm(dirname(item.file), { recursive: true, force: true }); }
      catch { /* ignore */ }
    }
  }

  #expandLegacy(traces) {
    const turns = [];
    const tools = [];
    const events = [];
    for (const trace of traces) {
      turns.push(...traceToLegacyRows(trace));
      for (const tool of Array.isArray(trace.tools) ? trace.tools : []) tools.push(traceToolToLegacy(trace, tool));
    }
    return { turns, tools, events };
  }
}

export class NullTrace {
  startTurn() { return 'null'; }
  endTurn() {}
  logTool() { return 'null'; }
  logEvent() { return 'null'; }
  event() { return 'null'; }
  async queryByMessage() { return { turns: [], tools: [], events: [] }; }
  async queryByTrace() { return { turns: [], tools: [], events: [] }; }
  async queryRecent() { return []; }
  async queryTools() { return []; }
  async search() { return []; }
  async stats() { return { turnCount: 0, toolCount: 0, eventCount: 0, dbSizeBytes: 0, fileSizeBytes: 0, requestCount: 0 }; }
  async cleanup() { return { deletedTurns: 0, deletedTools: 0, deletedEvents: 0, deletedRequests: 0 }; }
  async compact() { return { before: 0, after: 0 }; }
  async purge() {}
  async close() {}
  async flush() {}
  async fetchRecentDebugHistory() { return { loops: [], turns: [], dreamEvents: [] }; }
}

export function createTrace({ enabled, dbPath, dirPath }) {
  const path = dirPath || dbPath;
  if (!enabled || !path) return new NullTrace();
  return new DebugTrace(path);
}
