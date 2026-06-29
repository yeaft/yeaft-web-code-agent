/**
 * dream/session-wiring.js wire-up for session.js.
 *
 * Bridges the framework-agnostic `runDream` orchestrator (dream/runner.js)
 * to the live yeaft session: groups store, conversation log, LLM adapter,
 * and the engine's progress event sink.
 *
 * Memory v2 is the only path. The legacy `config.memoryV2` opt-out flag was
 * retired (task-710) — the wiring is unconditional.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Wire contract — DreamEvent (consumed by web/components/YeaftDebugPanel.js)
 * ─────────────────────────────────────────────────────────────────────
 * The events persisted to trace_events with these event_type values are
 * load-bearing for the debug panel. Renaming a field on this side
 * silently degrades that UI to a generic JSON dump.
 *
 *   dream_turn_open:   { type:'turn_open',  turnId, userPrompt, vpId, sessionId, at }
 *   dream_loop:        { type:'loop',       turnId, loopNumber, pass, model,
 *                        systemPrompt: string,
 *                        messages: [{ role:'user', content:string }],
 *                        response: string,
 *                        toolCalls: [], usage: { inputTokens, outputTokens, totalTokens },
 *                        latencyMs, ttfbMs, stopReason, rawRequest, rawResponse }
 *   dream_turn_close:  { type:'turn_close', turnId, totalMs, totalTokens, loopCount,
 *                        metrics: { llmCallCount, inputTokens, outputTokens,
 *                                   totalTokens, durationMs, passBreakdown:{[pass]:{
 *                                     llmCallCount, inputTokens, outputTokens,
 *                                     totalTokens, durationMs }} } }
 *   dream_run:         { type:'dream_run',  turnId, phase:'result',
 *                        status:'done'|'error', metrics, resultSummary:{ groups,
 *                        targets, error, skipped, skippedReason } }
 *   dream_progress:    runner-emitted phase events (`start`/`load-diff`/`triage`/
 *                      `merge`/`apply`/`done`). The `apply/done` variant carries
 *                      `kind, memoryMdPreview, summaryMdPreview, memoryMdLength,
 *                      summaryMdLength` (see apply.js).
 *
 * `sessionId` may be inherited via `stampDreamScope()` when a scope is active.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { runDream } from './runner.js';
import { createDreamScheduler } from './schedule.js';
import { parseMessage, parseSeqFromId } from '../conversation/persist.js';
import { readSessionState } from './state.js';
import { DREAM_NUDGE_AFTER_MESSAGES, DREAM_INTERVAL_HOURS } from './limits.js';

/**
 * Build the per-call options for runDream. Pure: takes a session and returns
 * the closures runDream needs (listSessions, countMessages, loadGroupDiff, etc.).
 *
 * @param {Object} session  — the live Session object from loadSession()
 * @param {(event: object) => void} [onProgress]
 * @returns {Object}
 */
export function buildRunDreamOpts(session, onProgress) {
  const yeaftDir = session.yeaftDir;
  const memoryRoot = join(yeaftDir, 'memory');
  const sessionConversationsRoot = join(yeaftDir, 'sessions');
  // Legacy disk fallback for pre-session transcript directories. New writes and
  // Dream's primary source use `sessions/<sessionId>/conversation`.
  const legacySessionConversationsRoot = join(yeaftDir, 'groups');
  const loadSessionDiff = async (sessionId, sinceId) => {
    try {
      const messages = loadSessionConversationMessages([sessionConversationsRoot, legacySessionConversationsRoot], sessionId);
      const out = [];
      let started = !sinceId;
      for (const m of messages) {
        if (!started) {
          if (m.id === sinceId) started = true;
          continue;
        }
        out.push(translateSessionConversationMessage(m));
      }
      return out;
    } catch { return []; }
  };

  return {
    root: memoryRoot,
    language: session.config?.language || 'en',
    segmentIndex: session.memoryIndex || null,
    llm: makeLlm(session),
    listSessions: async () => {
      try { return listConversationSessions([sessionConversationsRoot, legacySessionConversationsRoot]); }
      catch { return []; }
    },
    countMessages: async (sessionId) => {
      try { return loadSessionConversationMessages([sessionConversationsRoot, legacySessionConversationsRoot], sessionId).length; }
      catch { return 0; }
    },
    loadSessionDiff,
    /** Legacy alias for older Dream runner callers; primary name is loadSessionDiff. */
    loadGroupDiff: loadSessionDiff,
    loadOverlapPreamble: async (sessionId, beforeId, n) => {
      try {
        const messages = loadSessionConversationMessages([sessionConversationsRoot, legacySessionConversationsRoot], sessionId);
        const buf = [];
        for (const m of messages) {
          if (m.id === beforeId) break;
          buf.push(m);
        }
        return buf.slice(-n).map(translateSessionConversationMessage);
      } catch { return []; }
    },
    onProgress,
  };
}

/**
 * Translate a persisted session conversation message into the shape runDream
 * expects (id, role, body, vpId, author).
 *
 * (2026-05-13: legacy `m.meta.featureId` propagation was dropped along
 * with the Feature system. Historical messages on disk may still carry
 * it, but it no longer influences dream scoping.)
 *
 * @param {Object} m
 */
function translateSessionConversationMessage(m) {
  const role = m.role || 'assistant';
  const out = {
    id: m.id,
    role,
    body: m.content || m.text || '',
  };
  if (role === 'assistant' && m.speakerVpId) {
    out.vpId = m.speakerVpId;
  }
  return out;
}

/**
 * Enumerate session ids that have persisted conversation messages. `sessions/`
 * is the primary layout; `groups/` is read-only legacy fallback.
 *
 * @param {string[]} roots session transcript roots in priority order
 * @returns {string[]}
 */
function listConversationSessions(roots) {
  const out = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (name.startsWith('.')) continue;
      try {
        const dir = sessionDir(root, name);
        if (!hasReadableMessages(dir)) continue;
        out.add(name);
      } catch {
        // Ignore partial or old session directories. Dream only needs sessions
        // with readable conversation messages.
      }
    }
  }
  return [...out].sort();
}

/**
 * Load persisted conversation messages for one Yeaft Session. Supports both
 * projections currently present on disk:
 *   - ConversationStore markdown/jsonl under `conversation/`
 *   - Session append-only audit log under `messages/*.jsonl`
 *
 * @param {string[]} roots session transcript roots in priority order
 * @param {string} sessionId
 * @returns {object[]}
 */
function loadSessionConversationMessages(roots, sessionId) {
  const byId = new Map();
  for (const root of roots) {
    const dir = sessionDir(root, sessionId);
    for (const m of loadSessionDiskMessages(dir, sessionId)) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
  }
  return [...byId.values()].sort(compareMessagesBySeq);
}

function sessionDir(root, sessionId) {
  return join(root, safeDirComponent(sessionId));
}

function hasReadableMessages(dir) {
  const conversationDir = join(dir, 'conversation');
  if (hasMarkdownMessages(conversationDir)) return true;
  if (hasJsonlMessages(join(conversationDir, 'segments'))) return true;
  return hasJsonlMessages(join(dir, 'messages'));
}

function hasMarkdownMessages(conversationDir) {
  return ['messages', 'cold'].some(kind => {
    const dir = join(conversationDir, kind);
    try {
      return statSync(dir).isDirectory() && readdirSync(dir).some(f => f.endsWith('.md'));
    } catch {
      return false;
    }
  });
}

function hasJsonlMessages(dir) {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).some(f => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

function loadSessionDiskMessages(dir, sessionId) {
  const conversationDir = join(dir, 'conversation');
  return [
    // Prefer the canonical ConversationStore projection when it exists: it has
    // normalized role/content/tool metadata. The session append-only audit log
    // is still load-bearing for sessions created before/while conversation rows
    // were being migrated to JSONL.
    ...loadConversationDirMessages(conversationDir),
    ...loadSessionJsonlMessages(join(dir, 'messages'), sessionId),
  ];
}

function loadConversationDirMessages(conversationDir) {
  return [
    ...['cold', 'messages'].flatMap(kind => loadMessageDir(join(conversationDir, kind))),
    ...loadConversationJsonlMessages(join(conversationDir, 'segments')),
  ];
}

function loadMessageDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(file => {
      try { return parseMessage(readFileSync(join(dir, file), 'utf8')); }
      catch { return null; }
    })
    .filter(m => m && m.id);
}

function loadConversationJsonlMessages(dir) {
  return loadJsonlDir(dir, normalizeConversationJsonlMessage);
}

function loadSessionJsonlMessages(dir, sessionId) {
  return loadJsonlDir(dir, row => normalizeSessionJsonlMessage(row, sessionId));
}

function loadJsonlDir(dir, normalize) {
  if (!existsSync(dir)) return [];
  let files = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    let raw = '';
    try { raw = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const msg = normalize(JSON.parse(line));
        if (msg && msg.id) out.push(msg);
      } catch {
        // Skip corrupt rows; one bad JSONL line must not make Dream blind.
      }
    }
  }
  return out;
}

function normalizeConversationJsonlMessage(row) {
  if (!row || typeof row !== 'object' || !row.id) return null;
  return {
    id: row.id,
    role: row.role || 'assistant',
    content: stringifyMessageBody(row.content ?? row.text ?? ''),
    time: row.time || row.ts || '',
    sessionId: row.sessionId || null,
    speakerVpId: row.speakerVpId || null,
  };
}

function normalizeSessionJsonlMessage(row, sessionId) {
  if (!row || typeof row !== 'object' || !row.id) return null;
  const role = row.role || (row.from === 'user' ? 'user' : 'assistant');
  const speakerVpId = role === 'assistant'
    ? (row.speakerVpId || row.meta?.senderVpId || (row.from && row.from !== 'user' ? row.from : null))
    : null;
  return {
    id: row.id,
    role,
    content: stringifyMessageBody(row.content ?? row.text ?? ''),
    time: row.time || row.ts || '',
    sessionId,
    speakerVpId,
  };
}

function stringifyMessageBody(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function compareMessagesBySeq(a, b) {
  const sa = parseSeqFromId(a?.id);
  const sb = parseSeqFromId(b?.id);
  if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
  return String(a?.time || '').localeCompare(String(b?.time || ''));
}

function safeDirComponent(s) {
  const safe = String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120).replace(/^\.+$/, '_');
  return safe || '_';
}

/**
 * Build the LLM callable that runDream's triage/apply prompts use.
 *
 * @param {Object} session
 */
function makeLlm(session) {
  return async ({ pass, prompt, system }) => {
    const adapter = session.adapter;
    const model = session.config?.fastModelId || session.config?.model;
    if (!adapter || typeof adapter.call !== 'function') {
      throw new Error(`dream: no adapter.call available (pass=${pass})`);
    }

    // Bug 2: emit loop event so the debug panel shows dream LLM API calls.
    const startedMs = Date.now();
    session._dreamLoopCounter = (session._dreamLoopCounter || 0) + 1;
    const loopNumber = session._dreamLoopCounter;
    const turnId = session._dreamTurnId || 'dream';
    const effectiveSystem = system || (String(session.config?.language || '').toLowerCase().startsWith('zh')
      ? `你是梦境流水线 — pass: ${pass}。请用中文生成自然语言内容；JSON key 保持英文。`
      : `You are the dream pipeline — pass: ${pass}.`);

    const r = await adapter.call({
      model,
      system: effectiveSystem,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
    });

    // Emit complete loop event (request + response) to the debug panel.
    const latencyMs = Date.now() - startedMs;
    const usage = normalizeDreamUsage(r?.usage || {});
    if (!session._dreamMetrics) session._dreamMetrics = createDreamMetrics({ turnId });
    session._dreamMetrics.llmCallCount += 1;
    session._dreamMetrics.inputTokens += usage.inputTokens;
    session._dreamMetrics.outputTokens += usage.outputTokens;
    session._dreamMetrics.totalTokens += usage.totalTokens;
    session._dreamMetrics.byPass[pass] = session._dreamMetrics.byPass[pass] || createDreamPassMetrics();
    session._dreamMetrics.byPass[pass].llmCallCount += 1;
    session._dreamMetrics.byPass[pass].inputTokens += usage.inputTokens;
    session._dreamMetrics.byPass[pass].outputTokens += usage.outputTokens;
    session._dreamMetrics.byPass[pass].totalTokens += usage.totalTokens;
    session._dreamMetrics.byPass[pass].durationMs += latencyMs;
    const loopEvent = stampDreamScope(session, {
      type: 'loop',
      turnId,
      loopNumber,
      pass,
      model: model || 'unknown',
      systemPrompt: effectiveSystem,
      messages: [{ role: 'user', content: prompt }],
      response: typeof r?.text === 'string' ? r.text : '',
      toolCalls: [],
      usage,
      latencyMs,
      ttfbMs: null,
      stopReason: 'end_turn',
      rawRequest: null,
      rawResponse: null,
    });
    persistDreamTrace(session, 'dream_loop', loopEvent);
    if (typeof session._dreamProgressSink === 'function') {
      session._dreamProgressSink(loopEvent);
    }

    return (r && r.text) ? r.text : '';
  };
}


function stampDreamScope(session, evt) {
  if (!evt || typeof evt !== 'object') return evt;
  if (evt.sessionId || !session?._dreamActiveGroupId) return evt;
  return { ...evt, sessionId: session._dreamActiveGroupId };
}

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeDreamUsage(usage = {}) {
  const inputTokens = finiteNumber(
    usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens,
  );
  const outputTokens = finiteNumber(
    usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens,
  );
  const explicitTotal = finiteNumber(usage.totalTokens ?? usage.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens,
  };
}

function createDreamPassMetrics() {
  return { llmCallCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 };
}

function createDreamMetrics({ turnId, startedAt = Date.now() } = {}) {
  return {
    turnId: turnId || 'dream',
    startedAt,
    durationMs: 0,
    llmCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    byPass: {},
  };
}

function finalizeDreamMetrics(metrics, durationMs) {
  const m = metrics || createDreamMetrics();
  return {
    turnId: m.turnId || 'dream',
    startedAt: m.startedAt || null,
    durationMs: finiteNumber(durationMs),
    llmCallCount: finiteNumber(m.llmCallCount),
    inputTokens: finiteNumber(m.inputTokens),
    outputTokens: finiteNumber(m.outputTokens),
    totalTokens: finiteNumber(m.totalTokens),
    passBreakdown: Object.fromEntries(Object.entries(m.byPass || {}).map(([pass, rec]) => [pass, {
      llmCallCount: finiteNumber(rec.llmCallCount),
      inputTokens: finiteNumber(rec.inputTokens),
      outputTokens: finiteNumber(rec.outputTokens),
      totalTokens: finiteNumber(rec.totalTokens),
      durationMs: finiteNumber(rec.durationMs),
    }])),
  };
}

function summarizeDreamResult(result = {}) {
  return {
    sessions: Array.isArray(result.sessions) ? result.sessions.length : 0,
    targets: Array.isArray(result.targets) ? result.targets.length : 0,
    error: result.error || null,
    skipped: !!result.skipped,
    skippedReason: result.skippedReason || null,
  };
}

function persistDreamTrace(session, eventType, eventData) {
  try {
    if (typeof session?.trace?.event === 'function') session.trace.event(eventType, eventData);
    else if (typeof session?.trace?.logEvent === 'function') {
      session.trace.logEvent({ traceId: String(eventData?.turnId || eventData?.runId || eventType), eventType, eventData });
    }
  } catch { /* trace must never break dream */ }
}

/**
 * Create a v2 dream scheduler bound to a session and wire its progress
 * events into the engine's sub-agent event sink (web-bridge translates
 * `dream_progress` into `yeaft_output` for the debug panel).
 *
 * @param {Object} session
 * @returns {Object}                   — scheduler (start/stop/triggerNow)
 */
export function createV2DreamScheduler(session) {
  const onProgress = (evt) => {
    try {
      const stampedEvt = stampDreamScope(session, evt);
      const sink = session.engine?.subAgentEventSink || null;
      // We don't have a sub-agent id; emit on the engine's standard
      // event channel instead. session.engine exposes setSubAgentEventSink
      // for nested events; for top-level dream, we route through trace.
      if (typeof session.trace?.event === 'function') {
        session.trace.event('dream_progress', stampedEvt);
      }
      if (typeof session._dreamProgressSink === 'function') {
        session._dreamProgressSink(stampedEvt);
      }
      // Best-effort console for debug builds.
      if (session.config?.debug) {
        // eslint-disable-next-line no-console
        console.log('[dream]', stampedEvt);
      }
    } catch { /* never let progress reporting kill the run */ }
  };

  let dreamTurnCounter = 0;

  const run = (opts = {}) => {
    // Bug 2: emit turn_open before the dream pass so the debug panel
    // can group all LLM loop events under a single dream "turn".
    dreamTurnCounter += 1;
    const turnId = `dream-${dreamTurnCounter}-${Date.now()}`;
    const startedAt = Date.now();
    session._dreamTurnId = turnId;
    session._dreamLoopCounter = 0;
    session._dreamMetrics = createDreamMetrics({ turnId, startedAt });

    const turnOpen = stampDreamScope(session, {
      type: 'turn_open',
      turnId,
      userPrompt: '[dream] automatic memory consolidation',
      vpId: null,
      sessionId: null,
      at: startedAt,
    });
    persistDreamTrace(session, 'dream_turn_open', turnOpen);
    if (typeof session._dreamProgressSink === 'function') {
      session._dreamProgressSink(turnOpen);
    }

    return runDream({
      ...buildRunDreamOpts(session, onProgress),
      manual: !!opts.manual,
      scopeFilter: Array.isArray(opts.scopeFilter) ? opts.scopeFilter : undefined,
    }).then(async (result) => {
      // Bug 2: emit turn_close when the dream pass completes.
      result.trigger = opts.manual ? 'manual' : 'auto';
      if (session._dreamActiveGroupId && !result.sessionId) result.sessionId = session._dreamActiveGroupId;
      const metrics = finalizeDreamMetrics(session._dreamMetrics, Date.now() - startedAt);
      result.metrics = metrics;
      result.durationMs = metrics.durationMs;
      result.llmCallCount = metrics.llmCallCount;
      result.inputTokens = metrics.inputTokens;
      result.outputTokens = metrics.outputTokens;
      result.totalTokens = metrics.totalTokens;
      result.passBreakdown = metrics.passBreakdown;
      const turnClose = stampDreamScope(session, {
        type: 'turn_close',
        turnId,
        totalMs: metrics.durationMs,
        totalTokens: metrics.totalTokens,
        loopCount: metrics.llmCallCount,
        metrics,
      });
      persistDreamTrace(session, 'dream_turn_close', turnClose);
      persistDreamTrace(session, 'dream_run', stampDreamScope(session, {
        type: 'dream_run',
        turnId,
        phase: 'result',
        status: result?.error ? 'error' : 'done',
        metrics,
        resultSummary: summarizeDreamResult(result),
      }));
      if (typeof session._dreamProgressSink === 'function') {
        session._dreamProgressSink(turnClose);
      }
      if (typeof session._dreamResultSink === 'function') {
        try {
          await session._dreamResultSink(result);
        } catch { /* dream result visibility must never fail the scheduler */ }
      }
      return result;
    });
  };

  const v2 = createDreamScheduler({
    run,
    // Server mode — the HTTP listener already pins the event loop, so the
    // ticker should be allowed to participate normally. Without this, on
    // some Node 22 builds the unref'd interval stops being scheduled and
    // dream effectively never fires (observed in production: 12 days
    // between ticks, see fix/dream-cadence-and-ui-trigger).
    keepAlive: !!session?.config?.serverMode,
    logger: session.config?.debug ? console : undefined,
  });
  // Auto-start the timer.
  v2.start();

  // task-710: wire `noteUserMessage` to a real per-session message
  // counter. When the count crosses DREAM_NUDGE_AFTER_MESSAGES (default
  // 50) we kick off a non-manual dream pass and reset the counter.
  // Non-manual still respects MIN_NEW_PER_GROUP per-group, so groups
  // below threshold are still skipped — the nudge just frees us from
  // waiting for the 1h timer when traffic is high.
  //
  // Counter resets on fire-attempt (not completion). If a pass is
  // already in flight when we hit threshold, we CLAMP at threshold
  // rather than letting the counter accumulate unbounded — otherwise
  // the first message after the in-flight pass settles would fire
  // immediately, defeating the 50-message guarantee.
  let messagesSinceLastNudgeFire = 0;
  function nudgeOnUserMessage() {
    messagesSinceLastNudgeFire += 1;
    if (messagesSinceLastNudgeFire < DREAM_NUDGE_AFTER_MESSAGES) return;
    if (v2.isRunning()) {
      // Clamp; don't accumulate. We want the next fire to wait another
      // full DREAM_NUDGE_AFTER_MESSAGES once the in-flight pass clears.
      messagesSinceLastNudgeFire = DREAM_NUDGE_AFTER_MESSAGES;
      return;
    }
    messagesSinceLastNudgeFire = 0;
    // Fire-and-forget; failure flows through the scheduler's catch.
    v2.nudge().catch(() => {});
  }

  // Adapter shim: legacy callers (web-bridge) call .noteUserMessage() and
  // .triggerDreamNow() / .shutdown(). Map them onto the v2 API.
  return {
    noteUserMessage: nudgeOnUserMessage,
    triggerDreamNow() { return v2.triggerNow(); },
    triggerDreamForScopes(scopeFilter) { return v2.triggerNow(scopeFilter); },
    /**
     * Non-manual catch-up fire. MIN_NEW_PER_GROUP still applies, so groups
     * below threshold are skipped — same shape as the interval timer
     * tick. Used by `bootCatchUpStaleDream`.
     */
    catchUpNudge() { return v2.nudge(); },
    shutdown() { v2.stop(); },
    get isRunning() { return v2.isRunning(); },
    // Preserve direct access for tests.
    _v2: v2,
  };
}

/**
 * task-710: walk every group on disk, find the ones that have user messages
 * but zero memory segments in the FTS index, and trigger an immediate dream
 * pass scoped to those groups. Used at session boot so a freshly opened
 * agent doesn't have to wait an hour (or for traffic to cross the nudge
 * threshold) before its first memory write.
 *
 * Pure side-effect, fire-and-forget. Failure logs at debug only — never
 * blocks session load.
 *
 * @param {{ yeaftDir: string, memoryIndex: import('../memory/index-db.js').SegmentIndex|null, dreamScheduler: { triggerDreamForScopes: (s:string[]) => Promise<any> }, config?: { debug?: boolean } }} args
 * @returns {Promise<{ triggered: string[] }>}
 */
export async function bootInitEmptyGroups(args) {
  const out = { triggered: [] };
  if (!args || !args.memoryIndex || !args.dreamScheduler) return out;
  const sessionsRoot = join(args.yeaftDir, 'sessions');
  let ids;
  try { ids = listSessions(sessionsRoot).map(g => g.id); }
  catch { return out; }
  const empty = [];
  for (const gid of ids) {
    let segCount;
    try { segCount = args.memoryIndex.listByScope(`sessions/${gid}`).length; }
    catch { continue; }
    if (segCount > 0) continue;
    let hasMessages = false;
    try {
      const h = openSession(sessionsRoot, gid);
      // Any message at all is enough — pull the first record off the
      // iterator and stop.
      const first = h.streamMessages().next();
      hasMessages = !first.done;
    } catch { continue; }
    if (!hasMessages) continue;
    empty.push(`sessions/${gid}`);
  }
  if (empty.length === 0) return out;
  if (args.config?.debug) {
    // eslint-disable-next-line no-console
    console.log(`[dream] boot init: triggering empty-AMS dream for ${empty.length} group(s):`, empty);
  }
  // Fire-and-forget; the scheduler swallows its own failures.
  Promise.resolve(args.dreamScheduler.triggerDreamForScopes(empty)).catch(() => {});
  out.triggered = empty;
  return out;
}

/**
 * fix/dream-cadence-and-ui-trigger: stale-cadence catch-up.
 *
 * Walks every group on disk and reads the per-group `.dream-state`
 * `lastDreamAt`. The newest of those is the effective "session was last
 * cleanly Dream-processed at" timestamp. If that's older than
 * `DREAM_INTERVAL_HOURS` (or there's no record at all and at least one
 * group has user traffic), schedule a non-manual catch-up tick.
 *
 * Why this matters: the only thing previously triggering dream on a
 * long-lived server was `setInterval(...).unref()` plus the user-traffic
 * nudge. In practice (production: 12 days idle), neither fired reliably.
 * This boot-time catch-up gives us a deterministic "if we were stale at
 * boot, run once" guarantee that's independent of timer behaviour.
 *
 * MIN_NEW_PER_GROUP still gates per-group writes inside `runDream` —
 * non-manual catch-up will not produce empty segment churn for groups
 * that haven't crossed threshold.
 *
 * Pure side-effect, fire-and-forget.
 *
 * @param {{
 *   yeaftDir: string,
 *   dreamScheduler: { catchUpNudge?: () => Promise<any> },
 *   intervalHours?: number,
 *   now?: number,
 *   config?: { debug?: boolean },
 * }} args
 * @returns {Promise<{ stale: boolean, lastDreamAt: string|null, ageMs: number|null, fired: boolean }>}
 */
export async function bootCatchUpStaleDream(args) {
  const out = { stale: false, lastDreamAt: null, ageMs: null, fired: false };
  if (!args || !args.dreamScheduler) return out;

  const memoryRoot = join(args.yeaftDir, 'memory');
  const sessionsRoot = join(args.yeaftDir, 'sessions');
  const intervalMs = (args.intervalHours ?? DREAM_INTERVAL_HOURS) * 60 * 60 * 1000;
  const now = args.now ?? Date.now();

  let sessionIds;
  try { sessionIds = listSessions(sessionsRoot).map(g => g.id); }
  catch { return out; }

  // Find the newest lastDreamAt across all groups.
  let newestAt = null;
  let anyTraffic = false;
  for (const gid of sessionIds) {
    let st;
    try { st = await readSessionState(memoryRoot, gid); }
    catch { continue; }
    if (st.lastDreamAt) {
      const t = Date.parse(st.lastDreamAt);
      if (Number.isFinite(t) && (newestAt === null || t > newestAt)) newestAt = t;
    }
    if (!anyTraffic) {
      try {
        const h = openSession(sessionsRoot, gid);
        const first = h.streamMessages().next();
        if (!first.done) anyTraffic = true;
      } catch { /* keep going */ }
    }
  }

  // No groups, no traffic, nothing to catch up.
  if (!anyTraffic) return out;

  out.lastDreamAt = newestAt === null ? null : new Date(newestAt).toISOString();
  out.ageMs = newestAt === null ? null : (now - newestAt);
  out.stale = (newestAt === null) || (now - newestAt > intervalMs);
  if (!out.stale) return out;

  if (args.config?.debug) {
    // eslint-disable-next-line no-console
    console.log(`[dream] boot catch-up: stale (lastDreamAt=${out.lastDreamAt}, ageMs=${out.ageMs}); firing one non-manual tick.`);
  }

  // Non-manual: MIN_NEW_PER_GROUP still applies. Use the public
  // `catchUpNudge()` adapter — same dedupe path as the interval timer
  // (both go through `fire({ manual: false })`), so a concurrent timer
  // tick will be coalesced by the existing in-flight guard.
  //
  // Fail closed if the scheduler shim doesn't expose `catchUpNudge`:
  // the previous `triggerDreamForScopes()` fallback routed through
  // `v2.triggerNow()` which sets `manual: true` and bypasses
  // MIN_NEW_PER_GROUP — directly contradicting the contract documented
  // above. Better to skip than to silently fire a different semantic.
  // PR #743 review feedback (Martin).
  try {
    if (typeof args.dreamScheduler.catchUpNudge === 'function') {
      Promise.resolve(args.dreamScheduler.catchUpNudge()).catch(() => {});
      out.fired = true;
    } else {
      // Shim does not expose the non-manual catch-up path. Refuse to
      // substitute a manual fire — the caller should upgrade the shim.
      out.fired = false;
    }
  } catch {
    out.fired = false;
  }
  return out;
}
