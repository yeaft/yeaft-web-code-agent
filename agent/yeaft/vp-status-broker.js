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
  'streaming',
  'tool',
  'error',
]);

const RUNNING_STATES = new Set(['typing', 'thinking', 'streaming', 'tool']);
const STATE_PRIORITY = ['tool', 'streaming', 'thinking', 'typing', 'error', 'idle'];
const MAX_RETAINED_THREADS_PER_VP = 20;
const COMPLETED_TTL_MS = 30 * 60 * 1000;

export function createVpStatusBroker({ send, now = Date.now } = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createVpStatusBroker: `send` callback is required');
  }

  /** @type {Map<string, any>} */
  const threads = new Map();

  const vpKeyOf = (sessionId, vpId) => `${sessionId || ''}::${vpId}`;
  const threadKeyOf = (sessionId, vpId, threadId) => `${sessionId || ''}::${vpId}::${threadId || 'main'}`;

  function aggregateFor(sessionId, vpId) {
    const rows = [];
    for (const row of threads.values()) {
      if ((row.sessionId || null) === (sessionId || null) && row.vpId === vpId) rows.push(row);
    }
    rows.sort((a, b) => (b.updatedAt || b.since || 0) - (a.updatedAt || a.since || 0));

    let state = 'idle';
    for (const candidate of STATE_PRIORITY) {
      if (rows.some(r => (r.state || 'idle') === candidate)) {
        state = candidate;
        break;
      }
    }
    if (rows.some(r => RUNNING_STATES.has(r.state))) {
      for (const candidate of ['tool', 'streaming', 'thinking', 'typing']) {
        if (rows.some(r => r.state === candidate)) { state = candidate; break; }
      }
    }

    const runningThreadCount = rows.filter(r => RUNNING_STATES.has(r.state)).length;
    const latest = rows[0] || null;
    return {
      sessionId: sessionId || null,
      vpId,
      state,
      since: latest ? latest.since : now(),
      turnId: latest ? latest.turnId || null : null,
      threadId: latest ? latest.threadId || 'main' : null,
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
      if (RUNNING_STATES.has(row.state)) continue;
      if ((row.updatedAt || row.since || 0) < cutoff) threads.delete(key);
    }
    const remaining = rows
      .filter(([key]) => threads.has(key))
      .sort((a, b) => (b[1].updatedAt || b[1].since || 0) - (a[1].updatedAt || a[1].since || 0));
    for (const [key, row] of remaining.slice(MAX_RETAINED_THREADS_PER_VP)) {
      if (!RUNNING_STATES.has(row.state)) threads.delete(key);
    }
  }

  function emitAggregate(sessionId, vpId) {
    prune(sessionId, vpId);
    send({ type: 'vp_status_changed', ...aggregateFor(sessionId, vpId) });
  }

  function transition({ sessionId, vpId, state, turnId = null, threadId = 'main', title = '', messageCount } = {}) {
    if (!vpId) return false;
    if (!VALID_STATES.has(state)) {
      throw new RangeError(`vp-status-broker: invalid state '${state}'`);
    }
    const tid = threadId || 'main';
    const key = threadKeyOf(sessionId, vpId, tid);
    const prev = threads.get(key);
    if (prev && prev.state === state && prev.turnId === turnId && (!title || prev.title === title)) {
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
      createdAt: prev?.createdAt || ts,
      turnId,
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
