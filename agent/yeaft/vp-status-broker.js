/**
 * vp-status-broker.js — thread-aware source of truth for VP runtime status.
 *
 * Internally stores rows by (sessionId, vpId, threadId). The wire still emits
 * one aggregate row per (sessionId, vpId), with `threads[]` and
 * `runningThreadCount`, so old UI code that only reads `state` keeps working
 * while new UI can show concurrent threads.
 */

export const VALID_STATES = new Set([
  'idle',
  'typing',
  'thinking',
  'retrying',
  'streaming',
  'tool',
  'error',
]);

const RUNNING_STATES = new Set(['typing', 'thinking', 'retrying', 'streaming', 'tool']);

export function isVpStatusRunning(state) {
  return RUNNING_STATES.has(state || 'idle');
}

const STATE_PRIORITY = ['tool', 'streaming', 'retrying', 'thinking', 'typing', 'error', 'idle'];
const MAX_RETAINED_THREADS_PER_VP = 20;
const COMPLETED_TTL_MS = 30 * 60 * 1000;

/**
 * Retain only bounded, already user-visible diagnostics, never Error objects,
 * stacks, causes or provider payloads. Callers must supply the sanitized visible
 * message (in particular for content-policy failures), not a raw provider body.
 */
export function normalizeVpErrorDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const [key, limit] of Object.entries({ message: 2000, code: 128, reason: 128,
    errorName: 128, reasonCode: 128, provider: 128, model: 256 })) {
    if (typeof detail[key] === 'string' && detail[key].trim()) out[key] = detail[key].slice(0, limit);
  }
  for (const key of ['retryable', 'retryExhausted', 'credentialRefreshable']) {
    if (typeof detail[key] === 'boolean') out[key] = detail[key];
  }
  for (const key of ['retryAttempts', 'maxRetries']) {
    if (Number.isSafeInteger(detail[key]) && detail[key] >= 0) out[key] = detail[key];
  }
  if (Number.isInteger(detail.statusCode) && detail.statusCode >= 100 && detail.statusCode <= 599) {
    out.statusCode = detail.statusCode;
  }
  return Object.keys(out).length ? out : null;
}

export function createVpStatusBroker({ send, now = Date.now } = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createVpStatusBroker: `send` callback is required');
  }

  /** @type {Map<string, any>} */
  const threads = new Map();
  // Date.now() can tie across concurrent thread transitions. Keep selection
  // deterministic without changing the public wall-clock timestamps.
  let sequence = 0;

  const vpKeyOf = (sessionId, vpId) => `${sessionId || ''}::${vpId}`;
  const threadKeyOf = (sessionId, vpId, threadId) => `${sessionId || ''}::${vpId}::${threadId || 'main'}`;

  // Identity and error time are broker-owned, not caller-provided diagnostics.
  // Project them inside the detail so consumers need not infer its owner from
  // the aggregate's currently selected/running thread.
  function errorDetailFor(row) {
    return { ...row.errorDetail, at: row.errorAt, turnId: row.turnId || null, threadId: row.threadId };
  }

  function aggregateFor(sessionId, vpId) {
    const rows = [];
    for (const row of threads.values()) {
      if ((row.sessionId || null) === (sessionId || null) && row.vpId === vpId) rows.push(row);
    }
    rows.sort((a, b) => (b.updatedAt || b.since || 0) - (a.updatedAt || a.since || 0) || b.sequence - a.sequence);

    let state = 'idle';
    for (const candidate of STATE_PRIORITY) {
      if (rows.some(r => (r.state || 'idle') === candidate)) {
        state = candidate;
        break;
      }
    }
    if (rows.some(r => RUNNING_STATES.has(r.state))) {
      for (const candidate of ['tool', 'streaming', 'retrying', 'thinking', 'typing']) {
        if (rows.some(r => r.state === candidate)) { state = candidate; break; }
      }
    }

    const runningThreadCount = rows.filter(r => isVpStatusRunning(r.state)).length;
    const latest = rows[0] || null;
    // An idle sibling can be newer than the failure. Error identity must come
    // from the selected error row, not whichever thread happened to settle last.
    const source = state === 'error' ? rows.find(r => r.state === 'error') : latest;
    return {
      sessionId: sessionId || null,
      vpId,
      state,
      since: source ? source.since : now(),
      turnId: source ? source.turnId || null : null,
      threadId: source ? source.threadId || 'main' : null,
      ...(state === 'error' && source?.errorDetail ? { errorDetail: errorDetailFor(source) } : {}),
      runningThreadCount,
      threads: rows.map(r => ({
        threadId: r.threadId,
        state: r.state,
        status: r.state,
        title: r.title || '',
        since: r.since,
        turnId: r.turnId || null,
        createdAt: r.createdAt || r.since,
        updatedAt: r.updatedAt || r.since,
        messageCount: r.messageCount || 0,
        ...(r.state === 'error' && r.errorDetail ? { errorDetail: errorDetailFor(r) } : {}),
      })),
    };
  }

  function prune(sessionId, vpId) {
    const rows = [];
    for (const [key, row] of threads.entries()) {
      if ((row.sessionId || null) === (sessionId || null) && row.vpId === vpId) rows.push([key, row]);
    }
    const cutoff = now() - COMPLETED_TTL_MS;
    for (const [key, row] of rows) {
      if (isVpStatusRunning(row.state)) continue;
      if ((row.updatedAt || row.since || 0) < cutoff) threads.delete(key);
    }
    const remaining = rows
      .filter(([key]) => threads.has(key))
      .sort((a, b) => (b[1].updatedAt || b[1].since || 0) - (a[1].updatedAt || a[1].since || 0)
        || b[1].sequence - a[1].sequence);
    for (const [key, row] of remaining.slice(MAX_RETAINED_THREADS_PER_VP)) {
      if (!isVpStatusRunning(row.state)) threads.delete(key);
    }
  }

  function emitAggregate(sessionId, vpId) {
    prune(sessionId, vpId);
    send({ type: 'vp_status_changed', ...aggregateFor(sessionId, vpId) });
  }

  /**
   * errorDetail is a safe visible diagnostic owned by this thread/turn. Omitting
   * it on an otherwise identical error preserves the diagnostic; a new turn,
   * explicit null or any non-error state clears it. The detail carries broker-owned
   * at (epoch milliseconds), turnId and threadId; at remains stable for the same
   * failed turn across metadata updates/corrections. Returned wire rows are copies.
   */
  function transition({ sessionId, vpId, state, turnId = null, threadId = 'main', title = '', messageCount, errorDetail } = {}) {
    if (!vpId) return false;
    if (!VALID_STATES.has(state)) {
      throw new RangeError(`vp-status-broker: invalid state '${state}'`);
    }
    const tid = threadId || 'main';
    const key = threadKeyOf(sessionId, vpId, tid);
    const prev = threads.get(key);
    const nextErrorDetail = state === 'error'
      ? (errorDetail === undefined && prev?.state === 'error' && prev.turnId === turnId
          ? prev.errorDetail || null : normalizeVpErrorDetail(errorDetail))
      : null;
    if (prev && prev.state === state && prev.turnId === turnId && (!title || prev.title === title)
        && (!Number.isFinite(messageCount) || prev.messageCount === messageCount)
        && JSON.stringify(prev.errorDetail || null) === JSON.stringify(nextErrorDetail)) {
      return false;
    }
    const ts = now();
    const row = {
      ...(prev || {}),
      sessionId: sessionId || null,
      vpId,
      threadId: tid,
      state,
      since: prev && prev.state === state ? prev.since : ts,
      updatedAt: ts,
      sequence: ++sequence,
      createdAt: prev?.createdAt || ts,
      turnId,
      errorDetail: nextErrorDetail,
      errorAt: state === 'error'
        ? (prev?.state === 'error' && prev.turnId === turnId && prev.errorAt != null ? prev.errorAt : ts)
        : null,
      title: title || prev?.title || '',
      messageCount: Number.isFinite(messageCount) ? messageCount : (prev?.messageCount || 0),
    };
    threads.set(key, row);
    emitAggregate(sessionId, vpId);
    return true;
  }

  function settleIdle({ sessionId, vpId, threadId = 'main', title = '', messageCount } = {}) {
    return transition({ sessionId, vpId, threadId, state: 'idle', turnId: null, title, messageCount });
  }

  function snapshot(sessionId) {
    const seen = new Set();
    const out = [];
    for (const row of threads.values()) {
      if (sessionId !== undefined && sessionId !== null && row.sessionId !== sessionId) continue;
      const key = vpKeyOf(row.sessionId, row.vpId);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(aggregateFor(row.sessionId, row.vpId));
    }
    return out;
  }

  function broadcastSnapshot({ sessionId } = {}) {
    send({
      type: 'vp_status_snapshot',
      sessionId: sessionId === undefined ? null : sessionId,
      statuses: snapshot(sessionId),
    });
  }

  function forget({ sessionId, vpId, threadId } = {}) {
    if (threadId) {
      threads.delete(threadKeyOf(sessionId, vpId, threadId));
    } else {
      for (const key of Array.from(threads.keys())) {
        if (key.startsWith(`${sessionId || ''}::${vpId}::`)) threads.delete(key);
      }
    }
  }

  function reset() { threads.clear(); }
  function __testReset() { threads.clear(); }

  return { transition, settleIdle, snapshot, broadcastSnapshot, forget, reset, __testReset };
}
