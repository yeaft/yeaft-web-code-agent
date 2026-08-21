/**
 * debug-trace.js — file-backed debug trace for Yeaft
 *
 * Stores bounded request traces on disk without SQLite. New requests use a
 * small `meta.json` plus append-only `events.jsonl` under:
 *   <yeaftDir>/sessions/<sessionId>/debug/requests/<requestKey>/
 *
 * Loop requests remain base-plus-delta records, so cumulative messages are not
 * repeated. Legacy `trace.json` requests stay readable. Debug history is
 * best-effort: failures are logged and never allowed to stop the agent.
 */

import { createReadStream, promises as fsp } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { truncateUtf8Text } from './perf-trace.js';

const TRACE_VERSION = 3;
const REQUEST_RETENTION = 10;
const MAX_HISTORY_LIMIT = 5;
const MAX_DREAM_EVENTS = 100;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOOL_INPUT = 10 * 1024;
const MAX_INLINE_VALUE_BYTES = 1024 * 1024;
const MAX_RAW_REQUEST_BYTES = 2 * 1024 * 1024;
// Raw provider responses are diagnostic duplicates of the normalized response,
// tool calls, usage and request delta already stored on each loop. Keeping up
// to 1 MiB per loop made long tool turns produce 100+ MiB trace files. Every
// buffered flush then JSON.stringify()'d and rewrote that entire file on the
// agent's single event loop, so several active Sessions appeared deadlocked.
// A 64 KiB prefix is enough to inspect provider envelopes without letting
// always-on diagnostics dominate runtime latency.
const MAX_RAW_RESPONSE_BYTES = 64 * 1024;
const TRACE_APPEND_BATCH_MS = 100;
const EVENT_FLUSH_INTERVAL_MS = 30_000;
const MAX_SEARCH_PATTERN_CHARS = 300;
const DEFAULT_TRACE_TEXT_MAX_BYTES = 256 * 1024;
// A turn detail is returned as one WebSocket message. Keep its UI projection
// comfortably below the Agent connection's 8 MiB outbound queue ceiling while
// preserving the canonical file-backed trace without any extra truncation.
const DEBUG_DETAIL_WIRE_MAX_BYTES = 6 * 1024 * 1024;

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTextMaxBytes(value, fallback = DEFAULT_TRACE_TEXT_MAX_BYTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(4 * 1024 * 1024, Math.max(0, Math.floor(parsed)));
}

function safeDirComponent(value, fallback = 'unknown') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || fallback;
}

function storageDirComponent(value, fallback = 'unknown') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^[a-zA-Z0-9._-]+$/.test(raw) && Buffer.byteLength(raw, 'utf8') <= 200) return raw;
  const prefix = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || fallback;
  const digest = createHash('sha256').update(raw).digest('hex');
  return `${prefix}-${digest}`;
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
  const toolNames = [
    ...tools.map(t => t?.toolName || t?.name || '').filter(Boolean),
    ...(Array.isArray(trace?.toolNames) ? trace.toolNames : []),
  ].join(' ');
  const loopModels = [
    ...loops.map(l => l?.model || '').filter(Boolean),
    ...(Array.isArray(trace?.loopModels) ? trace.loopModels : []),
  ].join(' ');
  const stopReasons = [
    ...loops.map(l => l?.stopReason || '').filter(Boolean),
    ...(Array.isArray(trace?.stopReasons) ? trace.stopReasons : []),
    trace?.finalStopReason || '',
  ].filter(Boolean).join(' ');
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
  const budget = Math.max(0, Number(maxBytes) || 0);
  if (Buffer.byteLength(str, 'utf8') <= budget) return str;
  if (budget <= 0) return '';
  const marker = `\n... [truncated to ${budget} bytes]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= budget) return truncateUtf8Text(str, budget).value;
  return `${truncateUtf8Text(str, budget - markerBytes).value}${marker}`;
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
    const originalBytes = Buffer.byteLength(json, 'utf8');
    if (originalBytes <= maxBytes) return JSON.parse(json);
    // A bounded raw-exchange sentinel already carries the useful preview.
    // Preserve a re-bounded preview rather than reducing persisted history to
    // metadata after an outer trace record crosses its storage budget.
    if (value && typeof value === 'object' && value.__truncated === true
      && typeof value.preview === 'string') {
      const previewBudget = Math.max(0, maxBytes - 512);
      const preview = truncateText(value.preview, previewBudget);
      return {
        __truncated: true,
        ...(value.reason ? { reason: value.reason } : {}),
        originalBytes: Number.isFinite(Number(value.originalBytes))
          ? Number(value.originalBytes)
          : originalBytes,
        maxBytes,
        ...(preview ? { preview } : {}),
      };
    }
    return { __truncated: true, originalBytes, maxBytes };
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
  const previewSource = typeof value === 'string'
    ? value
    : (() => { try { return JSON.stringify(value); } catch { return null; } })();
  const preview = typeof previewSource === 'string'
    ? truncateText(previewSource, Math.min(64 * 1024, maxBytes))
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

function buildRawMessagesDelta(previousMessages, nextMessages) {
  if (!Array.isArray(nextMessages)) return null;
  const priorMessages = Array.isArray(previousMessages) ? previousMessages : [];
  const prefix = messagesPrefixLength(priorMessages, nextMessages);
  if (prefix === priorMessages.length && prefix <= nextMessages.length) {
    return { messagesFrom: prefix, messagesAppend: boundRawValue(nextMessages.slice(prefix), 'raw_request_messages_append_budget') };
  }
  return { messagesFrom: 0, messagesAppend: boundRawValue(nextMessages, 'raw_request_messages_append_budget') };
}

function rawRequestMessageKey(body) {
  if (!isPlainObject(body)) return null;
  if (Array.isArray(body.messages)) return 'messages';
  if (Array.isArray(body.input)) return 'input';
  return null;
}

function buildInitialRawRequestDelta(value) {
  if (value == null) return null;
  if (typeof value === 'string') return { replacement: rawRequestSentinel('raw_request_string_replaced', value) };
  if (!isPlainObject(value)) return { replacement: boundRawValue(value) };
  const delta = { set: {}, body: {} };
  for (const [key, item] of Object.entries(value)) {
    if (key === 'body') continue;
    delta.set[key] = boundRawValue(item, `raw_request_${key}_budget`);
  }
  const body = isPlainObject(value.body) ? value.body : null;
  if (body) {
    for (const [key, bodyValue] of Object.entries(body)) {
      if (key === 'messages' || key === 'input') continue;
      delta.body[key] = boundRawValue(bodyValue, `raw_request_body_${key}_budget`);
    }
    const messageKey = rawRequestMessageKey(body);
    if (messageKey) {
      delta.body.messagesKey = messageKey;
      Object.assign(delta.body, buildRawMessagesDelta([], body[messageKey]) || {});
    }
  } else if (Object.prototype.hasOwnProperty.call(value, 'body')) {
    delta.set.body = rawRequestSentinel('raw_request_body_replaced');
  }
  if (Object.keys(delta.set).length === 0) delete delta.set;
  if (Object.keys(delta.body).length === 0) delete delta.body;
  if (!delta.set && !delta.body) return null;
  if (jsonByteLength(delta) > MAX_RAW_REQUEST_BYTES) return { replacement: rawRequestSentinel('raw_request_delta_budget') };
  return delta;
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
  if (previous == null) return buildInitialRawRequestDelta(next);
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
      if (key === 'messagesFrom' || key === 'messagesAppend' || key === 'messages' || key === 'messagesKey') continue;
      body[key] = cloneJsonValue(value) ?? value;
    }
    const messageKey = delta.body.messagesKey === 'messages' || delta.body.messagesKey === 'input'
      ? delta.body.messagesKey
      : (Array.isArray(body.messages) || Object.prototype.hasOwnProperty.call(delta.body, 'messages') ? 'messages' : 'input');
    if (Array.isArray(delta.body.messages)) {
      body[messageKey] = cloneJsonValue(delta.body.messages) || [];
    } else if (Array.isArray(delta.body.messagesAppend)) {
      const existing = Array.isArray(body[messageKey]) ? body[messageKey] : [];
      const from = Number.isFinite(Number(delta.body.messagesFrom)) ? Number(delta.body.messagesFrom) : existing.length;
      body[messageKey] = existing.slice(0, from).concat(cloneJsonValue(delta.body.messagesAppend) || []);
    } else if (Object.prototype.hasOwnProperty.call(delta.body, 'messagesAppend')) {
      // A huge append is represented by a bounded raw-request sentinel, not
      // an array. Preserve that sentinel rather than silently dropping the
      // entire request body during hydration.
      body[messageKey] = cloneJsonValue(delta.body.messagesAppend) ?? delta.body.messagesAppend;
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

function snapshotTruncation(path, maxBytes, originalBytes) {
  return { __truncated: true, path, maxBytes, originalBytes };
}

function boundedSnapshotString(value, maxBytes, path) {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= maxBytes) return value;
  const marker = snapshotTruncation(path, maxBytes, originalBytes);
  if (jsonByteLength(marker) > maxBytes) return null;
  const markerText = `\n... [truncated to ${maxBytes} bytes]`;
  const markerBytes = Buffer.byteLength(markerText, 'utf8');
  if (markerBytes >= maxBytes) return marker;
  return truncateUtf8Text(value, maxBytes - markerBytes).value + markerText;
}

function boundSnapshotValue(value, maxBytes, path = 'messages') {
  if (maxBytes <= 0) return null;
  const sourceBytes = jsonByteLength(value);
  if (sourceBytes <= maxBytes) return cloneJsonValue(value);
  const marker = snapshotTruncation(path, maxBytes, sourceBytes);
  if (jsonByteLength(marker) > maxBytes) return null;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return marker;
  if (typeof value === 'string') return boundedSnapshotString(value, maxBytes, path);

  // Account JSON framing incrementally. The old clone-and-stringify-prefix
  // loop reserialized the full growing array/object per member and blocked
  // DebugTrace.endTurn for tens of seconds on a large provider history.
  if (Array.isArray(value)) {
    const out = [];
    let usedBytes = 2; // []
    for (let index = 0; index < value.length; index += 1) {
      const separatorBytes = out.length > 0 ? 1 : 0;
      const remaining = Math.max(0, maxBytes - usedBytes - separatorBytes);
      const candidate = boundSnapshotValue(value[index], remaining, `${path}[${index}]`);
      if (candidate == null) break;
      let encoded;
      try { encoded = JSON.stringify(candidate); } catch { break; }
      const candidateBytes = Buffer.byteLength(encoded, 'utf8');
      if (usedBytes + separatorBytes + candidateBytes > maxBytes) break;
      out.push(candidate);
      usedBytes += separatorBytes + candidateBytes;
    }
    return out.length > 0 ? out : marker;
  }
  if (typeof value === 'object') {
    const out = {};
    let usedBytes = 2; // {}
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      let keyJson;
      try { keyJson = JSON.stringify(key); } catch { break; }
      const keyBytes = Buffer.byteLength(keyJson, 'utf8');
      const separatorBytes = count > 0 ? 1 : 0;
      const remaining = Math.max(0, maxBytes - usedBytes - separatorBytes - keyBytes - 1);
      const candidate = boundSnapshotValue(item, remaining, `${path}.${key}`);
      if (candidate == null) break;
      let encoded;
      try { encoded = JSON.stringify(candidate); } catch { break; }
      const candidateBytes = Buffer.byteLength(encoded, 'utf8');
      if (usedBytes + separatorBytes + keyBytes + 1 + candidateBytes > maxBytes) break;
      out[key] = candidate;
      usedBytes += separatorBytes + keyBytes + 1 + candidateBytes;
      count += 1;
    }
    return count > 0 ? out : marker;
  }
  return marker;
}

function buildRequestSnapshot(info = {}, textMaxBytes = DEFAULT_TRACE_TEXT_MAX_BYTES) {
  const messageBudget = normalizeTextMaxBytes(textMaxBytes);
  return {
    systemPrompt: truncateText(info.systemPrompt || '', messageBudget),
    messages: Array.isArray(info.messages)
      ? boundSnapshotValue(info.messages, messageBudget, 'messages')
      : [],
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
      rawRequest: Object.prototype.hasOwnProperty.call(delta, 'rawRequest') ? delta.rawRequest : null,
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
  if (sessionId) return join(rootDir, 'sessions', storageDirComponent(sessionId, 'session'), 'debug', 'requests');
  return join(rootDir, 'debug', 'requests');
}

function legacySessionRequestsDir(rootDir, sessionId) {
  if (sessionId) return join(rootDir, 'sessions', safeDirComponent(sessionId), 'debug', 'requests');
  return join(rootDir, 'debug', 'requests');
}

function sessionRequestDirs(rootDir, sessionId) {
  const current = sessionRequestsDir(rootDir, sessionId);
  const legacy = legacySessionRequestsDir(rootDir, sessionId);
  return current === legacy ? [current] : [current, legacy];
}

function requestFilePath(requestDir) {
  return join(requestDir, 'trace.json');
}

function requestMetaPath(requestDir) {
  return join(requestDir, 'meta.json');
}

function requestEventsPath(requestDir) {
  return join(requestDir, 'events.jsonl');
}

function requestDirFor(rootDir, sessionId, requestKey) {
  return join(sessionRequestsDir(rootDir, sessionId), storageDirComponent(requestKey, 'request'));
}

function tracePathFor(rootDir, sessionId, requestKey) {
  return requestFilePath(requestDirFor(rootDir, sessionId, requestKey));
}

function turnLocatorName(turnId) {
  const raw = String(turnId || 'turn');
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `${safeDirComponent(raw, 'turn')}-${digest}.json`;
}

function turnLocatorPath(rootDir, sessionId, turnId) {
  return join(sessionRequestsDir(rootDir, sessionId), '..', 'turns', turnLocatorName(turnId));
}

function serializableTraceMeta(trace) {
  const loops = Array.isArray(trace?.loops) ? trace.loops : [];
  const tools = Array.isArray(trace?.tools) ? trace.tools : [];
  const usage = loops.reduce((acc, loop) => {
    const normalized = normalizeUsage(loop?.usage || {});
    acc.totalMs += Number(loop?.latencyMs || 0);
    acc.totalTokens += Number(normalized.totalTokens || 0);
    acc.summaryInputTokens += Number(normalized.totalInputTokens || 0);
    acc.summaryOutputTokens += Number(normalized.outputTokens || 0);
    return acc;
  }, { totalMs: 0, totalTokens: 0, summaryInputTokens: 0, summaryOutputTokens: 0 });
  const meta = {
    ...trace,
    loopCount: loops.length,
    toolCount: tools.length,
    ...usage,
    loopModels: [...new Set(loops.map(loop => loop?.model).filter(Boolean))],
    stopReasons: [...new Set(loops.map(loop => loop?.stopReason).filter(Boolean))],
    toolNames: [...new Set(tools.map(tool => tool?.toolName || tool?.name).filter(Boolean))],
  };
  delete meta._lastSnapshot;
  delete meta._persistedFormat;
  delete meta._persistedRequestDir;
  delete meta.baseRequest;
  delete meta.loops;
  delete meta.tools;
  return meta;
}

function traceMatchesIdentity(trace, sessionId, turnId) {
  return !!trace
    && trace.sessionId === sessionId
    && (trace.requestId === turnId || trace.traceId === turnId);
}

async function prepareJsonlAppend(filePath) {
  let text;
  try { text = await fsp.readFile(filePath, 'utf8'); }
  catch { return; }
  if (!text || text.endsWith('\n')) return;
  const lastNewline = text.lastIndexOf('\n');
  const tail = text.slice(lastNewline + 1);
  try {
    JSON.parse(tail);
    await fsp.appendFile(filePath, '\n', 'utf8');
  } catch {
    const validPrefix = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    await fsp.truncate(filePath, Buffer.byteLength(validPrefix, 'utf8'));
  }
}

async function readJsonLines(filePath) {
  let text;
  try { text = await fsp.readFile(filePath, 'utf8'); }
  catch { return []; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { /* A process can leave one torn final append; prior records remain valid. */ }
  }
  return records;
}

async function countRequestEvents(requestDir) {
  const meta = await readJson(requestMetaPath(requestDir));
  if (!meta?.requestId) {
    const legacy = await readJson(requestFilePath(requestDir));
    return {
      loopCount: Array.isArray(legacy?.loops) ? legacy.loops.length : 0,
      toolCount: Array.isArray(legacy?.tools) ? legacy.tools.length : 0,
    };
  }
  let loopCount = 0;
  let toolCount = 0;
  const stream = createReadStream(requestEventsPath(requestDir), { encoding: 'utf8' });
  stream.on('error', () => {});
  try {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === 'loop' && event.record) loopCount += 1;
        else if (event?.type === 'tool' && event.record) toolCount += 1;
      } catch { /* Ignore one torn final append. */ }
    }
  } catch { /* Missing/unreadable event file counts as empty. */ }
  return { loopCount, toolCount };
}

async function readRequestDir(requestDir) {
  const meta = await readJson(requestMetaPath(requestDir));
  if (!meta?.requestId) {
    const legacy = await readJson(requestFilePath(requestDir));
    return legacy ? { ...legacy, _persistedFormat: 'legacy', _persistedRequestDir: requestDir } : null;
  }
  const trace = { ...meta, _persistedFormat: 'events', _persistedRequestDir: requestDir, baseRequest: meta.legacyBaseRequest || null, loops: [], tools: [] };
  delete trace.legacyBaseRequest;
  const loopById = new Map();
  const toolById = new Map();
  for (const event of await readJsonLines(requestEventsPath(requestDir))) {
    const record = event?.record;
    if (event?.type === 'loop' && record) {
      const key = record.turnRowId || record.loopInstanceId || `${record.loopNumber || 0}`;
      loopById.set(key, record);
    } else if (event?.type === 'tool' && record) {
      const key = record.id || `${record.turnRowId || ''}:${record.toolCallId || ''}`;
      toolById.set(key, record);
    }
  }
  trace.loops = Array.from(loopById.values()).sort((a, b) => (a.loopNumber || 0) - (b.loopNumber || 0) || String(a.turnRowId || '').localeCompare(String(b.turnRowId || '')));
  trace.tools = Array.from(toolById.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (trace.loops.length > 0) {
    const last = trace.loops.at(-1);
    trace.closedAt = meta.closedAt || last.at || null;
    trace.updatedAt = Math.max(Number(meta.updatedAt || 0), Number(last.at || 0));
  }
  return trace;
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
    totalMs: loops.length > 0 ? usage.totalMs : Number(trace?.totalMs || 0),
    totalTokens: loops.length > 0 ? usage.totalTokens : Number(trace?.totalTokens || 0),
    summaryInputTokens: loops.length > 0 ? usage.summaryInputTokens : Number(trace?.summaryInputTokens || 0),
    summaryOutputTokens: loops.length > 0 ? usage.summaryOutputTokens : Number(trace?.summaryOutputTokens || 0),
    loopCount: loops.length > 0 ? loops.length : Number(trace?.loopCount || 0),
    memoryLoaded: Array.isArray(trace?.memoryLoaded) ? cloneJsonValue(trace.memoryLoaded) : null,
    memoryLoadedMeta: trace?.memoryLoadedMeta && typeof trace.memoryLoadedMeta === 'object'
      ? cloneJsonValue(trace.memoryLoadedMeta)
      : null,
    memoryAdjust: trace?.memoryAdjust && typeof trace.memoryAdjust === 'object'
      ? cloneJsonValue(trace.memoryAdjust)
      : null,
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
  let rawRequest = trace?.baseRequest?.rawRequest ?? null;
  const loops = [];
  for (const loop of Array.isArray(trace?.loops) ? trace.loops : []) {
    snapshot = applyRequestDelta(snapshot || trace.baseRequest || null, loop.requestDelta || {});
    if (loop?.requestDelta && Object.prototype.hasOwnProperty.call(loop.requestDelta, 'rawRequestDelta')) {
      rawRequest = reconstructDebugRawRequest(rawRequest, loop.requestDelta);
    }
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
      rawRequest,
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

function debugDetailTextSentinel(value, maxBytes, path, originalBytes = jsonByteLength(value)) {
  const text = value == null ? '' : String(value);
  const budget = Math.max(2, Math.floor(Number(maxBytes) || 0));
  if (originalBytes <= budget) return text;
  const marker = `\n... [wire truncated ${path}; original ${originalBytes} bytes]`;
  const rawBytes = Math.max(1, Buffer.byteLength(text, 'utf8'));
  const expansion = Math.max(1, originalBytes / rawBytes);
  const markerBytes = jsonByteLength(marker) - 2;
  let previewBytes = Math.max(0, Math.floor((budget - markerBytes - 2) / expansion));
  let projected = `${truncateUtf8Text(text, previewBytes).value}${marker}`;
  let projectedBytes = jsonByteLength(projected);
  if (projectedBytes > budget && previewBytes > 0) {
    previewBytes = Math.max(0, Math.floor(previewBytes * (budget / projectedBytes)) - 8);
    projected = `${truncateUtf8Text(text, previewBytes).value}${marker}`;
    projectedBytes = jsonByteLength(projected);
  }
  if (projectedBytes <= budget) return projected;
  if (jsonByteLength(marker) <= budget) return marker;
  return '';
}

function debugDetailJsonSentinel(value, maxBytes, path, originalBytes = jsonByteLength(value)) {
  if (value == null) return value;
  const budget = Math.max(0, Math.floor(Number(maxBytes) || 0));
  if (originalBytes <= budget) return value;
  const base = {
    __truncated: true,
    reason: 'debug_detail_wire_budget',
    path,
    originalBytes,
    maxBytes: budget,
  };
  const baseBytes = jsonByteLength(base);
  if (baseBytes > budget) return budget >= 4 ? null : '';
  let preview = '';
  try {
    const encoded = JSON.stringify(value);
    preview = debugDetailTextSentinel(
      encoded,
      Math.max(2, budget - baseBytes - 16),
      path,
      jsonByteLength(encoded),
    );
  } catch { /* metadata-only sentinel below */ }
  const projected = preview ? { ...base, preview } : base;
  return jsonByteLength(projected) <= budget ? projected : base;
}

function allocateDebugCandidateBudgets(candidates, totalBytes) {
  const sorted = [...candidates].sort((a, b) => a.originalBytes - b.originalBytes || a.path.localeCompare(b.path));
  let remainingBytes = Math.max(0, Math.floor(totalBytes));
  let remainingCount = sorted.length;
  for (let index = 0; index < sorted.length; index += 1) {
    const candidate = sorted[index];
    const fairShare = remainingCount > 0 ? Math.floor(remainingBytes / remainingCount) : 0;
    if (candidate.originalBytes <= fairShare) {
      candidate.budget = candidate.originalBytes;
      remainingBytes -= candidate.budget;
      remainingCount -= 1;
      continue;
    }
    for (let tail = index; tail < sorted.length; tail += 1) {
      const count = sorted.length - tail;
      const budget = count > 0 ? Math.floor(remainingBytes / count) : 0;
      sorted[tail].budget = budget;
      remainingBytes -= budget;
    }
    break;
  }
}

export function projectDebugDetailForWire(detail, maxBytes = DEBUG_DETAIL_WIRE_MAX_BYTES) {
  // `fetchTurnDebug()` hands us a freshly expanded response object; mutate that
  // disposable projection rather than cloning tens or hundreds of cumulative
  // request snapshots. Canonical file records and the request cache are separate.
  const wire = detail && typeof detail === 'object'
    ? detail
    : { loops: [], turns: [], dreamEvents: [] };
  const payloadBudget = Math.max(0, maxBytes - 2048);
  const candidates = [];
  const addCandidate = (container, field, path) => {
    if (!container || container[field] == null) return;
    const value = container[field];
    candidates.push({
      container,
      field,
      path,
      value,
      originalBytes: jsonByteLength(value),
      budget: 0,
    });
    // Measure the non-candidate envelope exactly once without serializing every
    // cumulative request again after each replacement.
    container[field] = null;
  };

  const loopFields = ['rawRequest', 'rawResponse', 'messages', 'requestBase', 'requestDelta', 'toolCalls', 'response', 'systemPrompt'];
  for (const [loopIndex, loop] of (Array.isArray(wire.loops) ? wire.loops : []).entries()) {
    if (!loop || typeof loop !== 'object') continue;
    for (const field of loopFields) addCandidate(loop, field, `loops[${loopIndex}].${field}`);
  }
  for (const [turnIndex, turn] of (Array.isArray(wire.turns) ? wire.turns : []).entries()) {
    if (!turn || typeof turn !== 'object') continue;
    for (const field of ['userPrompt', 'memoryLoaded', 'memoryLoadedMeta', 'memoryAdjust']) {
      addCandidate(turn, field, `turns[${turnIndex}].${field}`);
    }
    for (const [toolIndex, tool] of (Array.isArray(turn.tools) ? turn.tools : []).entries()) {
      if (!tool || typeof tool !== 'object') continue;
      addCandidate(tool, 'toolInput', `turns[${turnIndex}].tools[${toolIndex}].toolInput`);
      addCandidate(tool, 'toolOutput', `turns[${turnIndex}].tools[${toolIndex}].toolOutput`);
    }
  }
  for (const [eventIndex] of (Array.isArray(wire.dreamEvents) ? wire.dreamEvents : []).entries()) {
    addCandidate(wire.dreamEvents, eventIndex, `dreamEvents[${eventIndex}]`);
  }

  const skeletonBytes = jsonByteLength(wire);
  const candidateBytes = candidates.reduce((sum, candidate) => sum + candidate.originalBytes, 0);
  const originalBytes = skeletonBytes - (4 * candidates.length) + candidateBytes;
  if (originalBytes <= payloadBudget) {
    for (const candidate of candidates) candidate.container[candidate.field] = candidate.value;
    return wire;
  }
  if (candidates.length === 0 || skeletonBytes > payloadBudget) {
    throw new Error(`Debug detail metadata exceeds the ${maxBytes}-byte wire budget`);
  }

  // Each candidate currently occupies JSON `null` (4 bytes) in the skeleton.
  // Water-fill the exact value budget: small fields stay complete, while large
  // cumulative requests and tool outputs receive fair, independently bounded
  // previews. This is O(total input bytes + candidates log candidates), with
  // one final whole-envelope serialization rather than one per candidate.
  const valueBudget = payloadBudget - skeletonBytes + (4 * candidates.length);
  allocateDebugCandidateBudgets(candidates, valueBudget);
  let truncatedFields = 0;
  for (const candidate of candidates) {
    if (candidate.originalBytes <= candidate.budget) {
      candidate.container[candidate.field] = candidate.value;
      continue;
    }
    const fieldBudget = candidate.budget;
    candidate.container[candidate.field] = typeof candidate.value === 'string'
      ? debugDetailTextSentinel(candidate.value, fieldBudget, candidate.path, candidate.originalBytes)
      : debugDetailJsonSentinel(candidate.value, fieldBudget, candidate.path, candidate.originalBytes);
    truncatedFields += 1;
  }

  wire.projection = {
    truncated: true,
    reason: 'debug_detail_wire_budget',
    maxBytes,
    truncatedFields,
  };
  const projectedBytesBase = jsonByteLength(wire);
  let projectedBytes = projectedBytesBase + Buffer.byteLength(`,\"projectedBytes\":${projectedBytesBase}`, 'utf8');
  projectedBytes = projectedBytesBase + Buffer.byteLength(`,\"projectedBytes\":${projectedBytes}`, 'utf8');
  wire.projection.projectedBytes = projectedBytes;
  if (projectedBytes > maxBytes) {
    throw new Error(`Debug detail projection still exceeds the ${maxBytes}-byte wire budget`);
  }
  return wire;
}

function traceToLegacyRows(trace) {
  let snapshot = null;
  let rawRequest = trace?.baseRequest?.rawRequest ?? null;
  return (Array.isArray(trace?.loops) ? trace.loops : []).map((loop) => {
    snapshot = applyRequestDelta(snapshot || trace.baseRequest || null, loop.requestDelta || {});
    if (loop?.requestDelta && Object.prototype.hasOwnProperty.call(loop.requestDelta, 'rawRequestDelta')) {
      rawRequest = reconstructDebugRawRequest(rawRequest, loop.requestDelta);
    }
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
      raw_request: rawRequest == null ? null : JSON.stringify(rawRequest),
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

async function collectRequestDirs(rootDir, sessionId = null) {
  const dirs = [];
  const addFromRequestsDir = async (requestsDir) => {
    for (const entry of await readdirSafe(requestsDir)) {
      if (entry.isDirectory()) dirs.push(join(requestsDir, entry.name));
    }
  };
  if (sessionId) {
    for (const requestsDir of sessionRequestDirs(rootDir, sessionId)) {
      await addFromRequestsDir(requestsDir);
    }
    return dirs;
  }
  await addFromRequestsDir(sessionRequestsDir(rootDir, null));
  const sessionsRoot = join(rootDir, 'sessions');
  for (const entry of await readdirSafe(sessionsRoot)) {
    if (!entry.isDirectory()) continue;
    await addFromRequestsDir(join(sessionsRoot, entry.name, 'debug', 'requests'));
  }
  return dirs;
}

async function readTraceSummaries(rootDir, sessionId = null) {
  const traces = [];
  for (const requestDir of await collectRequestDirs(rootDir, sessionId)) {
    const trace = await readRequestDir(requestDir);
    if (!trace || !trace.requestId) continue;
    if (sessionId && trace.sessionId !== sessionId) continue;
    const file = requestFilePath(requestDir);
    traces.push({ trace, file, requestDir, openedAt: Number(trace.openedAt || 0) });
  }
  traces.sort((a, b) => ((a.openedAt || 0) - (b.openedAt || 0)) || String(a.trace?.requestKey || a.file).localeCompare(String(b.trace?.requestKey || b.file)));
  return traces;
}

async function readTraceIdentity(requestDir) {
  const meta = await readJson(requestMetaPath(requestDir));
  if (meta?.requestId) return meta;
  return readJson(requestFilePath(requestDir));
}

function sameTraceIdentity(trace, expected) {
  return !!trace && !!expected
    && trace.sessionId === expected.sessionId
    && trace.requestKey === expected.requestKey
    && trace.requestId === expected.requestId;
}

async function removeRequestDirIfIdentityMatches(requestDir, expected) {
  const identity = await readTraceIdentity(requestDir);
  if (!sameTraceIdentity(identity, expected)) return false;
  try {
    await fsp.rm(requestDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function readTraceHeaders(rootDir, sessionId) {
  const traces = [];
  const requestDirs = await collectRequestDirs(rootDir, sessionId);
  for (const requestDir of requestDirs) {
    const meta = await readJson(requestMetaPath(requestDir));
    const stored = meta?.requestId ? meta : await readJson(requestFilePath(requestDir));
    if (!stored?.requestId || !stored?.requestKey) continue;
    if (sessionId != null && stored.sessionId !== sessionId) continue;
    const trace = meta?.requestId ? { ...meta } : serializableTraceMeta(stored);
    trace._persistedFormat = meta?.requestId ? 'events' : 'legacy';
    trace._persistedRequestDir = requestDir;
    traces.push({
      trace,
      file: requestFilePath(requestDir),
      requestDir,
      openedAt: Number(trace.openedAt || 0),
    });
  }
  return traces.sort((a, b) => ((a.openedAt || 0) - (b.openedAt || 0)) || String(a.trace.requestKey).localeCompare(String(b.trace.requestKey)));
}

async function readHeaderDetail(rootDir, header) {
  const requestDir = header?._persistedRequestDir
    || requestDirFor(rootDir, header?.sessionId || null, header?.requestKey);
  const trace = await readRequestDir(requestDir);
  return sameTraceIdentity(trace, header) ? trace : null;
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
  /** @type {Array<{ trace: object, type: 'loop'|'tool', record: object, initialize: boolean, writeMeta: boolean }>} */
  #pendingWrites = [];
  /** @type {Set<string>} */
  #initializedRequestKeys = new Set();
  /** @type {Set<string>} */
  #reconciledRetentionSessions = new Set();
  /** @type {Map<string, object>} Lightweight persisted metadata by request key. */
  #diskHeaders = new Map();
  /** @type {Map<string, Map<string, { trace: object, requestDirs: Set<string>, openedAt: number }>>} */
  #retentionIndex = new Map();
  /** @type {NodeJS.Timeout|null} */
  #appendTimer = null;
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
   * One-time metadata hydrate guard. Reads/maintenance keep only bounded
   * request headers resident. Full loop/tool payloads are loaded for one
   * selected request at a time and are never installed in #requestCache.
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
  /** @type {number} */
  #textMaxBytes = DEFAULT_TRACE_TEXT_MAX_BYTES;
  /** @type {boolean} */
  #acceptingWrites = true;

  /**
   * @param {string} tracePath — Back-compatible path. If it looks like a DB
   * file, traces are stored in a sibling `debug/` directory.
   */
  constructor(tracePath, options = {}) {
    const rootDir = fileTraceRoot(tracePath);
    if (!rootDir) throw new Error('DebugTrace requires a storage path');
    this.#rootDir = rootDir;
    this.#textMaxBytes = normalizeTextMaxBytes(options?.textMaxBytes);
    // Best-effort, fire-and-forget: atomicWriteText re-ensures the request
    // subdir before every write, so a missed mkdir here is harmless.
    ensureDir(rootDir).catch(() => {});
  }

  refreshConfig(config = {}) {
    const nextValue = config && typeof config === 'object'
      ? config.traceTextMaxBytes
      : config;
    this.#textMaxBytes = normalizeTextMaxBytes(nextValue, this.#textMaxBytes);
  }

  startTurn({ traceId, messageId = null, mode = null, turnNumber = null, sessionId = null, vpId = null, threadId = null, userPrompt = null, memoryLoaded = null, memoryLoadedMeta = null } = {}) {
    if (!this.#acceptingWrites) return 'null';
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
      memoryLoaded,
      memoryLoadedMeta,
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
    const snapshot = buildRequestSnapshot({
      ...info,
      // An explicit null describes this loop: no provider raw request was
      // captured. Do not inherit a previous loop's body and falsely attribute
      // it to a transport failure or another uncaptured attempt.
      rawRequest: Object.prototype.hasOwnProperty.call(info, 'rawRequest')
        ? info.rawRequest
        : (trace.baseRequest?.rawRequest ?? null),
    }, this.#textMaxBytes);
    const previousSnapshot = trace._lastSnapshot || this.#reconstructLastSnapshot(trace);
    if (!trace.baseRequest) {
      trace.baseRequest = {
        systemPrompt: snapshot.systemPrompt,
        messages: Array.isArray(snapshot.messages) ? cloneJsonValue(snapshot.messages) : [],
        rawRequest: snapshot.rawRequest ?? null,
      };
    }
    const loopIndex = (trace.loops || []).findIndex(l => l.turnRowId === turnId);
    const loop = {
      loopInstanceId: turnId,
      turnRowId: turnId,
      loopNumber,
      startedAt: trace.openedAt || Date.now(),
      model: info.model || null,
      response: truncateText(info.responseText || '', this.#textMaxBytes),
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
        ? truncateText(info.rawResponse, Math.min(this.#textMaxBytes, MAX_RAW_RESPONSE_BYTES))
        : safeJsonValue(info.rawResponse, Math.min(this.#textMaxBytes, MAX_RAW_RESPONSE_BYTES)),
      // Raw request is canonical base-plus-delta data. Persisting the full
      // snapshot on every loop made a 512 KiB request consume N × 512 KiB for
      // an N-loop trace and kept the same duplication in the hydrated cache.
      rawRequest: null,
      requestDelta: buildRequestDelta(previousSnapshot, snapshot),
    };
    if (loopIndex >= 0) trace.loops[loopIndex] = loop;
    else trace.loops.push(loop);
    trace.loops.sort((a, b) => (a.loopNumber || 0) - (b.loopNumber || 0) || String(a.turnRowId || '').localeCompare(String(b.turnRowId || '')));
    trace.closedAt = loop.at;
    trace.updatedAt = loop.at;
    trace.active = info.stopReason ? !['end_turn', 'error', 'aborted'].includes(String(info.stopReason)) : false;
    trace._lastSnapshot = snapshot;
    this.#appendTraceRecord(trace, 'loop', loop, { writeMeta: !trace.active });
  }

  logTool(turnId, { toolName, toolCallId = null, toolInput = null, toolOutput = null, durationMs = null, isError = false } = {}) {
    const id = randomUUID();
    const ctx = this.#turnIndex.get(turnId);
    if (!ctx) return id;
    const trace = this.#loadRequest(ctx.sessionId, ctx.requestKey);
    if (!trace) return id;
    if (!Array.isArray(trace.tools)) trace.tools = [];
    const tool = {
      id,
      turnRowId: turnId,
      loopNumber: ctx.loopNumber || 0,
      toolName: toolName || '?',
      toolCallId,
      toolInput: truncateText(toolInput == null ? null : String(toolInput), MAX_TOOL_INPUT),
      toolOutput: truncateText(toolOutput == null ? null : String(toolOutput), this.#textMaxBytes),
      durationMs: Number(durationMs || 0),
      isError: !!isError,
      createdAt: Date.now(),
    };
    trace.tools.push(tool);
    trace.updatedAt = tool.createdAt;
    this.#appendTraceRecord(trace, 'tool', tool, { writeMeta: false });
    return id;
  }

  logEvent({ traceId, eventType, eventData = null } = {}) {
    const id = randomUUID();
    if (!this.#acceptingWrites) return id;
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
    await this.#drainWrites();
    const traces = (await readTraceSummaries(this.#rootDir)).map(item => item.trace)
      .filter(trace => trace.messageId === messageId);
    return this.#expandLegacy(traces);
  }

  async queryByTrace(traceId) {
    await this.#drainWrites();
    const traces = (await readTraceSummaries(this.#rootDir)).map(item => item.trace)
      .filter(trace => trace.traceId === traceId || trace.requestId === traceId);
    return this.#expandLegacy(traces);
  }

  async queryRecent(limit = 20) {
    await this.#drainWrites();
    const lim = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Number(limit) || MAX_HISTORY_LIMIT));
    return (await readTraceSummaries(this.#rootDir))
      .slice(-lim)
      .reverse()
      .flatMap(({ trace }) => traceToLegacyRows(trace));
  }

  finalizeQuery(traceId, { sessionId = null, stopReason = 'end_turn' } = {}) {
    for (const trace of this.#requestCache.values()) {
      if (trace.traceId !== traceId || (sessionId != null && trace.sessionId !== sessionId)) continue;
      trace.active = false;
      trace.closedAt ||= Date.now();
      trace.updatedAt = Date.now();
      trace.finalStopReason = stopReason;
      this.#appendTraceRecord(trace, 'finalize', { at: trace.updatedAt, stopReason }, { writeMeta: true, evictAfterWrite: true });
    }
  }

  async fetchTurnDebug({ sessionId, turnId, dreamLimit = 0 } = {}) {
    const requestedSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    const requestedTurnId = typeof turnId === 'string' && turnId ? turnId : null;
    if (!requestedSessionId || !requestedTurnId) {
      return { loops: [], turns: [], dreamEvents: [], detailTurnId: requestedTurnId };
    }
    await this.#drainWrites();

    let trace = Array.from(this.#requestCache.values()).find(item => (
      item?.sessionId === requestedSessionId
      && (item.requestId === requestedTurnId || item.traceId === requestedTurnId)
    )) || null;
    if (!trace) {
      const locator = await readJson(turnLocatorPath(this.#rootDir, requestedSessionId, requestedTurnId));
      if (locator?.requestKey && locator.sessionId === requestedSessionId && locator.requestId === requestedTurnId) {
        const located = await readRequestDir(requestDirFor(this.#rootDir, requestedSessionId, locator.requestKey));
        if (traceMatchesIdentity(located, requestedSessionId, requestedTurnId)) trace = located;
      }
    }
    if (!trace) {
      // Legacy v2 traces have no locator. Scan only as a compatibility fallback;
      // every v3 trace takes the direct sessionId + turnId path above.
      for (const item of await readTraceSummaries(this.#rootDir, requestedSessionId)) {
        if (traceMatchesIdentity(item.trace, requestedSessionId, requestedTurnId)) {
          trace = item.trace;
          break;
        }
      }
    }
    const dreamEvents = this.#readDreamEvents({ sessionId: requestedSessionId, dreamLimit });
    if (!trace) return { loops: [], turns: [], dreamEvents, detailTurnId: requestedTurnId };
    const expanded = expandTrace(trace);
    return projectDebugDetailForWire({ ...expanded, dreamEvents, detailTurnId: requestedTurnId });
  }

  async fetchRecentDebugHistory({ limit = MAX_HISTORY_LIMIT, dreamLimit = 5, sessionId = null, threadId = null, indexOnly = false, detailTurnId = null, search = '' } = {}) {
    const requestedDetailTurnId = typeof detailTurnId === 'string' && detailTurnId ? detailTurnId : null;
    if (requestedDetailTurnId && sessionId) {
      const detail = await this.fetchTurnDebug({ sessionId, turnId: requestedDetailTurnId, dreamLimit });
      return { ...detail, hasMore: false, limit: detail.loops.length, indexOnly: false };
    }
    await this.#drainWrites();
    const lim = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Number(limit) || MAX_HISTORY_LIMIT));
    const searchRegex = requestedDetailTurnId ? null : compileTraceSearchRegex(search);
    const traces = (await readTraceHeaders(this.#rootDir, sessionId))
      .map(({ trace }) => trace)
      .filter(trace => !threadId || trace.threadId === threadId)
      .filter(trace => requestedDetailTurnId || traceMatchesRegex(trace, searchRegex));
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
        turns: selected.map(trace => ({
          ...summarizeTrace(trace, false),
          loopCount: Number(trace.loopCount || 0),
          tools: [],
        })),
        dreamEvents,
        hasMore: traces.length > selected.length,
        limit: lim,
        indexOnly: true,
      };
    }
    const selectedKeys = new Set(selected.map(trace => trace.requestKey));
    const detailed = (await readTraceSummaries(this.#rootDir, sessionId))
      .map(({ trace }) => trace)
      .filter(trace => selectedKeys.has(trace.requestKey));
    const expanded = detailed.reduce((acc, trace) => {
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
    for (const { trace: header } of this.#traceSummaries().slice().reverse()) {
      const trace = this.#requestCache.get(header.requestKey)
        || await readHeaderDetail(this.#rootDir, header);
      if (!trace) continue;
      for (const tool of Array.isArray(trace.tools) ? trace.tools : []) {
        const row = traceToolToLegacy(trace, tool);
        if (name && row.tool_name !== name) continue;
        if (since && row.created_at < since) continue;
        tools.push(row);
      }
      tools.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      if (tools.length > 100) tools.length = 100;
    }
    return tools;
  }

  async search(keyword) {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const needle = String(keyword || '').toLowerCase();
    if (!needle) return [];
    const results = [];
    for (const { trace: header } of this.#traceSummaries().slice().reverse()) {
      const trace = this.#requestCache.get(header.requestKey)
        || await readHeaderDetail(this.#rootDir, header);
      if (!trace || !JSON.stringify(trace).toLowerCase().includes(needle)) continue;
      results.push(...traceToLegacyRows(trace));
      if (results.length >= 50) break;
    }
    return results.slice(0, 50);
  }

  async stats() {
    await this.#ensureHydrated();
    await this.#drainWrites();
    const traces = this.#traceSummaries().map(({ trace }) => trace);
    let turnCount = 0;
    let toolCount = 0;
    for (const header of traces) {
      const live = this.#requestCache.get(header.requestKey);
      if (live) {
        turnCount += Array.isArray(live.loops) ? live.loops.length : Number(live.loopCount || 0);
        toolCount += Array.isArray(live.tools) ? live.tools.length : Number(live.toolCount || 0);
        continue;
      }
      if (Number.isFinite(Number(header.loopCount)) && Number.isFinite(Number(header.toolCount))) {
        turnCount += Number(header.loopCount);
        toolCount += Number(header.toolCount);
        continue;
      }
      const counts = await countRequestEvents(
        header._persistedRequestDir
          || requestDirFor(this.#rootDir, header.sessionId || null, header.requestKey),
      );
      turnCount += counts.loopCount;
      toolCount += counts.toolCount;
    }
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
    this.#acceptingWrites = false;
    await this.#drainWrites();
    try { await fsp.rm(this.#rootDir, { recursive: true, force: true }); }
    catch { /* ignore */ }
    await ensureDir(this.#rootDir);
    this.#turnIndex.clear();
    this.#requestCache.clear();
    this.#diskHeaders.clear();
    this.#initializedRequestKeys.clear();
    this.#reconciledRetentionSessions.clear();
    this.#retentionIndex.clear();
    this.#events = [];
    this.#hydrated = false;
    this.#hydratePromise = null;
    this.#eventsHydrated = false;
    this.#acceptingWrites = true;
  }

  async close() {
    this.#acceptingWrites = false;
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

  #getOrCreateRequest({ traceId, turnNumber, messageId, mode, sessionId, vpId, threadId, userPrompt, memoryLoaded, memoryLoadedMeta, now, turnRowId }) {
    const normalizedSessionId = sessionId || null;
    const isUsableExisting = (t) => (
      t?.sessionId === normalizedSessionId
      && t?.traceId === traceId
      && t.active !== false
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
      if (!Array.isArray(existing.memoryLoaded) && Array.isArray(memoryLoaded)) {
        existing.memoryLoaded = cloneJsonValue(memoryLoaded);
      }
      if (!existing.memoryLoadedMeta && memoryLoadedMeta && typeof memoryLoadedMeta === 'object') {
        existing.memoryLoadedMeta = cloneJsonValue(memoryLoadedMeta);
      }
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
      userPrompt: truncateText(userPrompt || '', this.#textMaxBytes),
      memoryLoaded: Array.isArray(memoryLoaded) ? cloneJsonValue(memoryLoaded) : null,
      memoryLoadedMeta: memoryLoadedMeta && typeof memoryLoadedMeta === 'object'
        ? cloneJsonValue(memoryLoadedMeta)
        : null,
      memoryAdjust: null,
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

  async resumeTrace({ sessionId, turnId } = {}) {
    if (!sessionId || !turnId) return false;
    const locator = await readJson(turnLocatorPath(this.#rootDir, sessionId, turnId));
    let trace = null;
    if (locator?.requestKey && locator.sessionId === sessionId) {
      trace = await readRequestDir(requestDirFor(this.#rootDir, sessionId, locator.requestKey));
    }
    if (!traceMatchesIdentity(trace, sessionId, turnId)) {
      trace = (await readTraceSummaries(this.#rootDir, sessionId))
        .map(item => item.trace)
        .find(item => traceMatchesIdentity(item, sessionId, turnId)) || null;
    }
    if (!trace) return false;
    this.#requestCache.set(trace.requestKey, trace);
    return true;
  }

  #traceSummaries(sessionId = null) {
    const merged = new Map(this.#diskHeaders);
    for (const trace of this.#requestCache.values()) merged.set(trace.requestKey, trace);
    const out = [];
    for (const trace of merged.values()) {
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
   * Load lightweight persisted metadata once. Active requests stay in
   * #requestCache; completed payloads remain on disk and are lazy-loaded only
   * for detail/search/tool queries. This prevents retained debug history from
   * expanding into a process-lifetime multi-gigabyte object graph.
   */
  async #ensureHydrated() {
    if (this.#hydrated) return;
    if (this.#hydratePromise) return this.#hydratePromise;
    this.#hydratePromise = (async () => {
      const [headers, storedEvents] = await Promise.all([
        readTraceHeaders(this.#rootDir, null),
        readJson(join(this.#rootDir, 'events.json')),
      ]);
      for (const { trace } of headers) {
        if (!trace?.requestKey || this.#requestCache.has(trace.requestKey)) continue;
        this.#diskHeaders.set(trace.requestKey, trace.active
          ? { ...trace, active: false, interrupted: true }
          : trace);
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

  #traceFile(trace) {
    return tracePathFor(this.#rootDir, trace.sessionId || null, trace.requestKey);
  }

  #appendTraceRecord(trace, type, record, { writeMeta = false, evictAfterWrite = false } = {}) {
    if (!this.#acceptingWrites || !trace?.requestKey || !record) return;
    this.#requestCache.set(trace.requestKey, trace);
    const initialize = !this.#initializedRequestKeys.has(trace.requestKey);
    if (initialize) this.#initializedRequestKeys.add(trace.requestKey);
    this.#pendingWrites.push({
      trace,
      type,
      record: cloneJsonValue(record),
      initialize,
      writeMeta: !!writeMeta,
      evictAfterWrite: !!evictAfterWrite,
    });
    if (writeMeta) {
      this.#flushPending();
      return;
    }
    if (this.#appendTimer) return;
    this.#appendTimer = setTimeout(() => {
      this.#appendTimer = null;
      this.#flushPending();
    }, TRACE_APPEND_BATCH_MS);
    if (typeof this.#appendTimer.unref === 'function') this.#appendTimer.unref();
  }

  #scheduleEventFlush() {
    this.#eventsDirty = true;
    if (this.#eventFlushTimer) return;
    this.#eventFlushTimer = setTimeout(() => {
      this.#eventFlushTimer = null;
      this.#flushEvents();
    }, EVENT_FLUSH_INTERVAL_MS);
    if (typeof this.#eventFlushTimer.unref === 'function') this.#eventFlushTimer.unref();
  }

  /** Queue append-only loop/tool records onto the single-writer chain. */
  #flushPending() {
    if (this.#appendTimer) {
      clearTimeout(this.#appendTimer);
      this.#appendTimer = null;
    }
    const entries = this.#pendingWrites.splice(0);
    if (entries.length === 0) {
      this.#flushEvents();
      return;
    }
    this.#chain(async () => {
      const batches = new Map();
      for (const entry of entries) {
        if (!this.#requestCache.has(entry.trace.requestKey)) continue;
        const requestDir = requestDirFor(this.#rootDir, entry.trace.sessionId || null, entry.trace.requestKey);
        const batch = batches.get(requestDir) || { trace: entry.trace, initialize: false, writeMeta: false, evictAfterWrite: false, lines: [] };
        batch.trace = entry.trace;
        batch.initialize ||= entry.initialize;
        batch.writeMeta ||= entry.writeMeta;
        batch.evictAfterWrite ||= entry.evictAfterWrite;
        batch.lines.push(`${JSON.stringify({ type: entry.type, record: entry.record })}\n`);
        batches.set(requestDir, batch);
      }
      for (const [requestDir, batch] of batches) {
        const { trace, initialize, writeMeta, evictAfterWrite } = batch;
        const lines = [...batch.lines];
        const legacyRequestDir = trace._persistedFormat === 'legacy'
          ? trace._persistedRequestDir || null
          : null;
        try {
          const metaPath = requestMetaPath(requestDir);
          if (initialize) {
            const meta = serializableTraceMeta(trace);
            if (legacyRequestDir) {
              meta.legacyBaseRequest = cloneJsonValue(trace.baseRequest);
              const legacyLines = [];
              for (const loop of Array.isArray(trace.loops) ? trace.loops : []) {
                legacyLines.push(`${JSON.stringify({ type: 'loop', record: loop })}\n`);
              }
              for (const tool of Array.isArray(trace.tools) ? trace.tools : []) {
                legacyLines.push(`${JSON.stringify({ type: 'tool', record: tool })}\n`);
              }
              lines.unshift(...legacyLines);
            }
            await atomicWriteText(metaPath, JSON.stringify(meta));
            await atomicWriteText(
              turnLocatorPath(this.#rootDir, trace.sessionId || null, trace.requestId),
              JSON.stringify({ requestKey: trace.requestKey, requestId: trace.requestId, sessionId: trace.sessionId || null })
            );
          }
          await ensureDir(requestDir);
          const eventPath = requestEventsPath(requestDir);
          if (initialize) await prepareJsonlAppend(eventPath);
          await fsp.appendFile(eventPath, lines.join(''), 'utf8');
          if (writeMeta) {
            const meta = serializableTraceMeta(trace);
            await atomicWriteText(metaPath, JSON.stringify(meta));
            this.#diskHeaders.set(trace.requestKey, meta);
          }
          trace._persistedFormat = 'events';
          trace._persistedRequestDir = requestDir;
          if (legacyRequestDir && legacyRequestDir !== requestDir) {
            await removeRequestDirIfIdentityMatches(legacyRequestDir, trace);
          }
          if (evictAfterWrite) {
            this.#requestCache.delete(trace.requestKey);
            this.#initializedRequestKeys.delete(trace.requestKey);
            for (const [turnId, ctx] of this.#turnIndex) {
              if (ctx.requestKey === trace.requestKey) this.#turnIndex.delete(turnId);
            }
          }
        } catch (err) {
          console.warn('[Yeaft] debug trace append failed:', err?.message || err);
        }
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
    const sessions = new Set();
    for (const trace of this.#diskHeaders.values()) sessions.add(trace.sessionId || null);
    for (const trace of this.#requestCache.values()) sessions.add(trace.sessionId || null);
    for (const sessionId of sessions) await this.#pruneSession(sessionId, keep);
  }

  async #pruneSession(sessionId, keep = REQUEST_RETENTION) {
    const sessionKey = sessionId || '';
    let index = this.#retentionIndex.get(sessionKey);
    if (!this.#reconciledRetentionSessions.has(sessionKey)) {
      index = new Map();
      for (const item of await readTraceHeaders(this.#rootDir, sessionId)) {
        const existing = index.get(item.trace.requestKey);
        if (existing) {
          existing.requestDirs.add(item.requestDir);
          const currentDir = requestDirFor(this.#rootDir, sessionId, item.trace.requestKey);
          if (item.requestDir === currentDir || existing.trace?._persistedFormat === 'legacy') {
            existing.trace = item.trace;
          }
          existing.openedAt = Math.min(existing.openedAt, item.openedAt);
        } else {
          index.set(item.trace.requestKey, {
            trace: item.trace,
            requestDirs: new Set([item.requestDir]),
            openedAt: item.openedAt,
          });
        }
      }
      this.#retentionIndex.set(sessionKey, index);
      this.#reconciledRetentionSessions.add(sessionKey);
    }
    for (const trace of this.#requestCache.values()) {
      if ((trace.sessionId || null) !== sessionId) continue;
      const requestDir = requestDirFor(this.#rootDir, sessionId, trace.requestKey);
      const existing = index.get(trace.requestKey);
      index.set(trace.requestKey, {
        trace,
        requestDirs: new Set([...(existing?.requestDirs || []), requestDir]),
        openedAt: Math.min(Number(trace.openedAt || 0), existing?.openedAt ?? Infinity),
      });
    }
    const traces = Array.from(index.values()).sort((a, b) => (
      (a.openedAt || 0) - (b.openedAt || 0)
      || String(a.trace.requestKey).localeCompare(String(b.trace.requestKey))
    ));
    const activeCutoff = Date.now() - 6 * 60 * 60 * 1000;
    const protectedItems = traces.filter(item => item.trace?.active && Number(item.trace?.updatedAt || 0) >= activeCutoff);
    const pruneCandidates = traces.filter(item => !protectedItems.includes(item));
    const stale = pruneCandidates.slice(0, Math.max(0, traces.length - protectedItems.length - keep));
    for (const item of stale) {
      this.#requestCache.delete(item.trace.requestKey);
      this.#diskHeaders.delete(item.trace.requestKey);
      this.#initializedRequestKeys.delete(item.trace.requestKey);
      index.delete(item.trace.requestKey);
      for (const requestDir of item.requestDirs) {
        await removeRequestDirIfIdentityMatches(requestDir, item.trace);
      }
      const locatorPaths = new Set(sessionRequestDirs(this.#rootDir, sessionId).map(requestsDir => (
        join(requestsDir, '..', 'turns', turnLocatorName(item.trace.requestId))
      )));
      for (const locatorPath of locatorPaths) {
        const locator = await readJson(locatorPath);
        if (locator?.sessionId === sessionId
          && locator.requestId === item.trace.requestId
          && locator.requestKey === item.trace.requestKey) {
          try { await fsp.rm(locatorPath, { force: true }); }
          catch { /* ignore */ }
        }
      }
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
  finalizeQuery() {}
  async resumeTrace() { return false; }
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
  refreshConfig() {}
  async flush() {}
  async fetchTurnDebug() { return { loops: [], turns: [], dreamEvents: [] }; }
  async fetchRecentDebugHistory() { return { loops: [], turns: [], dreamEvents: [] }; }
}

export function createTrace({ enabled, dbPath, dirPath, textMaxBytes }) {
  const path = dirPath || dbPath;
  if (!enabled || !path) return new NullTrace();
  return new DebugTrace(path, { textMaxBytes });
}
