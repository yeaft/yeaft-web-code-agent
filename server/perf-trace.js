import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_QUEUE_SIZE = 5000;
const MAX_STRING_LENGTH = 512;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_TRACE_DIR = join(__dirname, 'data', 'perf-traces');

let flushTimer = null;
const queue = [];

function enabled() {
  return process.env.PERF_TRACE_DISABLED !== 'true';
}

function traceDir() {
  return process.env.PERF_TRACE_DIR || DEFAULT_TRACE_DIR;
}

function nowWall() {
  return Date.now();
}

function sanitizeString(value, max = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}...[truncated]` : value;
}

function sanitizeValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= 4) return `[array:${value.length}]`;
    return value.slice(0, 50).map(v => sanitizeValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 4) return '[object]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'text' || key === 'prompt' || key === 'content' || key === 'data' || key === 'apiKey' || key === 'token') continue;
      out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function normalizeEvent(event = {}) {
  const traceId = typeof event.traceId === 'string' && event.traceId.trim()
    ? event.traceId.trim()
    : (typeof event.perfTraceId === 'string' && event.perfTraceId.trim() ? event.perfTraceId.trim() : null);
  const phase = typeof event.phase === 'string' && event.phase.trim() ? event.phase.trim() : 'unknown';
  const source = typeof event.source === 'string' && event.source.trim() ? event.source.trim() : 'unknown';
  return {
    traceId,
    source,
    phase,
    at: Number.isFinite(event.at) ? event.at : nowWall(),
    monotonicMs: Number.isFinite(event.monotonicMs) ? event.monotonicMs : null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    userId: event.userId || null,
    agentId: event.agentId || null,
    sessionId: event.sessionId || null,
    vpId: event.vpId || null,
    turnId: event.turnId || null,
    threadId: event.threadId || null,
    messageType: event.messageType || null,
    bytes: Number.isFinite(event.bytes) ? event.bytes : null,
    ok: typeof event.ok === 'boolean' ? event.ok : null,
    detail: sanitizeValue(event.detail || null),
    createdAt: new Date().toISOString(),
  };
}

function scheduleFlush() {
  if (flushTimer || !enabled()) return;
  const delay = Number(process.env.PERF_TRACE_FLUSH_INTERVAL_MS || DEFAULT_FLUSH_INTERVAL_MS);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { flushPerfTraceEvents(); }
    catch (err) { console.warn('[PerfTrace] flush failed:', err?.message || err); }
  }, Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

export function recordPerfTraceEvent(event) {
  if (!enabled()) return false;
  const normalized = normalizeEvent(event);
  if (!normalized.traceId) return false;
  if (queue.length >= MAX_QUEUE_SIZE) queue.shift();
  queue.push(normalized);
  scheduleFlush();
  return true;
}

export function flushPerfTraceEvents() {
  if (!enabled() || queue.length === 0) return 0;
  const batch = queue.splice(0, queue.length);
  const day = new Date().toISOString().slice(0, 10);
  const dir = traceDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}.jsonl`);
  appendFileSync(file, batch.map(row => JSON.stringify(row)).join('\n') + '\n');
  return batch.length;
}

export async function closePerfTraceStore() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try { flushPerfTraceEvents(); } catch { /* best-effort */ }
}

export const __perfTraceForTest = {
  normalizeEvent,
  sanitizeValue,
  queue,
  traceDir,
};
