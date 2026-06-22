import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const MAX_DETAIL_STRING = 512;

function sanitizeString(value, max = MAX_DETAIL_STRING) {
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

export function perfNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

export function recordAgentPerfTrace(config, event = {}) {
  const traceId = typeof event.traceId === 'string' && event.traceId.trim()
    ? event.traceId.trim()
    : (typeof event.perfTraceId === 'string' && event.perfTraceId.trim() ? event.perfTraceId.trim() : null);
  if (!traceId) return false;
  const yeaftDir = config?.yeaftDir;
  if (typeof yeaftDir !== 'string' || !yeaftDir.trim()) return false;
  const root = join(yeaftDir.trim(), 'perf-traces');
  const day = new Date().toISOString().slice(0, 10);
  const row = {
    traceId,
    source: 'agent',
    phase: event.phase || 'unknown',
    at: Date.now(),
    monotonicMs: Number.isFinite(event.monotonicMs) ? event.monotonicMs : perfNowMs(),
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    sessionId: event.sessionId || null,
    vpId: event.vpId || null,
    turnId: event.turnId || null,
    threadId: event.threadId || null,
    messageType: event.messageType || null,
    bytes: Number.isFinite(event.bytes) ? event.bytes : null,
    ok: typeof event.ok === 'boolean' ? event.ok : null,
    detail: sanitizeValue(event.detail || null),
  };
  try {
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, `${day}.jsonl`), `${JSON.stringify(row)}\n`);
    return true;
  } catch (err) {
    if (process.env.YEAFT_PERF_TRACE_DEBUG === '1') {
      console.warn('[Yeaft] perf trace write failed:', err?.message || err);
    }
    return false;
  }
}

export const __perfTraceForTest = {
  sanitizeValue,
};
