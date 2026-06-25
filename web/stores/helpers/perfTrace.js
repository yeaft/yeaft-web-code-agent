const MAX_PENDING_TRACES = 200;
const FLUSH_DELAY_MS = 250;

function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function wallNow() {
  return Date.now();
}

function makeTraceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `pt_${crypto.randomUUID()}`;
  return `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function boundedString(value, max = 160) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}...[truncated]` : value;
}

function sanitizeDetail(detail) {
  if (!detail || typeof detail !== 'object') return detail || null;
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'text' || key === 'prompt' || key === 'content' || key === 'data') continue;
    out[key] = typeof value === 'string' ? boundedString(value) : value;
  }
  return out;
}

export function createPerfTraceId() {
  return makeTraceId();
}

export function recordPerfTrace(store, event = {}) {
  if (!store || !event.traceId) return;
  if (!Array.isArray(store._perfTraceQueue)) store._perfTraceQueue = [];
  store._perfTraceQueue.push({
    traceId: event.traceId,
    source: 'web',
    phase: event.phase || 'unknown',
    at: wallNow(),
    monotonicMs: now(),
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    agentId: event.agentId || null,
    sessionId: event.sessionId || null,
    vpId: event.vpId || null,
    turnId: event.turnId || null,
    threadId: event.threadId || null,
    messageType: event.messageType || null,
    bytes: Number.isFinite(event.bytes) ? event.bytes : null,
    ok: typeof event.ok === 'boolean' ? event.ok : null,
    detail: sanitizeDetail(event.detail),
  });
  if (store._perfTraceQueue.length > MAX_PENDING_TRACES) {
    store._perfTraceQueue.splice(0, store._perfTraceQueue.length - MAX_PENDING_TRACES);
  }
  schedulePerfTraceFlush(store);
}

export function schedulePerfTraceFlush(store) {
  if (!store || store._perfTraceFlushTimer) return;
  store._perfTraceFlushTimer = setTimeout(() => flushPerfTrace(store), FLUSH_DELAY_MS);
}

export function flushPerfTrace(store) {
  if (!store || !Array.isArray(store._perfTraceQueue) || store._perfTraceQueue.length === 0) {
    if (store) store._perfTraceFlushTimer = null;
    return;
  }
  const events = store._perfTraceQueue.splice(0, store._perfTraceQueue.length);
  store._perfTraceFlushTimer = null;
  if (typeof store.sendWsMessage !== 'function') return;
  store.sendWsMessage({
    type: 'perf_trace_events',
    events,
  });
}

export function measureNextPaint(store, baseEvent = {}) {
  if (typeof requestAnimationFrame !== 'function') return;
  const start = now();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      recordPerfTrace(store, {
        ...baseEvent,
        phase: baseEvent.phase || 'render.next_paint',
        durationMs: now() - start,
      });
    });
  });
}
