/**
 * dream-v2/session-wiring.js wire-up for session.js.
 *
 * Bridges the framework-agnostic `runDream` orchestrator (dream-v2/runner.js)
 * to the live yeaft session: groups store, conversation log, LLM adapter,
 * and the engine's progress event sink.
 *
 * Memory v2 is the only path. The legacy `config.memoryV2` opt-out flag was
 * retired (task-710) — the wiring is unconditional.
 */

import { join } from 'path';
import { runDream } from './runner.js';
import { createDreamScheduler } from './schedule.js';
import { listGroups, openGroup } from '../groups/group-store.js';
import { readGroupState } from './state.js';
import { DREAM_NUDGE_AFTER_MESSAGES, DREAM_INTERVAL_HOURS } from './limits.js';

/**
 * Build the per-call options for runDream. Pure: takes a session and returns
 * the closures runDream needs (listGroups, countMessages, loadGroupDiff, etc.).
 *
 * @param {Object} session  — the live Session object from loadSession()
 * @param {(event: object) => void} [onProgress]
 * @returns {Object}
 */
export function buildRunDreamOpts(session, onProgress) {
  const yeaftDir = session.yeaftDir;
  const memoryRoot = join(yeaftDir, 'memory');
  const groupsRoot = join(yeaftDir, 'groups');

  return {
    root: memoryRoot,
    language: session.config?.language || 'en',
    llm: makeLlm(session),
    listGroups: async () => {
      try { return listGroups(groupsRoot).map(g => g.id); }
      catch { return []; }
    },
    countMessages: async (gid) => {
      try {
        const h = openGroup(groupsRoot, gid);
        let n = 0;
        for (const _m of h.streamMessages()) n += 1;
        return n;
      } catch { return 0; }
    },
    loadGroupDiff: async (gid, sinceId) => {
      try {
        const h = openGroup(groupsRoot, gid);
        const out = [];
        let started = !sinceId;
        for (const m of h.streamMessages()) {
          if (!started) {
            if (m.id === sinceId) started = true;
            continue;
          }
          out.push(translateGroupMessage(m));
        }
        return out;
      } catch { return []; }
    },
    loadOverlapPreamble: async (gid, beforeId, n) => {
      try {
        const h = openGroup(groupsRoot, gid);
        const buf = [];
        for (const m of h.streamMessages()) {
          if (m.id === beforeId) break;
          buf.push(m);
        }
        return buf.slice(-n).map(translateGroupMessage);
      } catch { return []; }
    },
    onProgress,
  };
}

/**
 * Translate a group-store message record (id, from, role, text, ...) into
 * the shape runDream expects (id, role, body, vpId, author).
 *
 * (2026-05-13: legacy `m.meta.featureId` propagation was dropped along
 * with the Feature system. Historical messages on disk may still carry
 * it, but it no longer influences dream scoping.)
 *
 * @param {Object} m
 */
function translateGroupMessage(m) {
  const role = m.role || (m.from === 'user' ? 'user' : 'assistant');
  const out = {
    id: m.id,
    role,
    body: m.text || '',
  };
  if (role === 'assistant' && m.from && m.from !== 'user') {
    out.vpId = m.from;
  }
  return out;
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
      throw new Error(`dream-v2: no adapter.call available (pass=${pass})`);
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
    if (typeof session._dreamProgressSink === 'function') {
      session._dreamProgressSink({
        type: 'loop',
        turnId,
        loopNumber,
        model: model || 'unknown',
        systemPrompt: effectiveSystem,
        messages: [{ role: 'user', content: prompt }],
        response: typeof r?.text === 'string' ? r.text : '',
        toolCalls: [],
        usage: r?.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: Date.now() - startedMs,
        ttfbMs: null,
        stopReason: 'end_turn',
        rawRequest: null,
        rawResponse: null,
      });
    }

    return (r && r.text) ? r.text : '';
  };
}

/**
 * Create a v2 dream scheduler bound to a session and wire its progress
 * events into the engine's sub-agent event sink (web-bridge translates
 * `dream_progress` into `unify_output` for the debug panel).
 *
 * @param {Object} session
 * @returns {Object}                   — scheduler (start/stop/triggerNow)
 */
export function createV2DreamScheduler(session) {
  const onProgress = (evt) => {
    try {
      const sink = session.engine?.subAgentEventSink || null;
      // We don't have a sub-agent id; emit on the engine's standard
      // event channel instead. session.engine exposes setSubAgentEventSink
      // for nested events; for top-level dream, we route through trace.
      if (typeof session.trace?.event === 'function') {
        session.trace.event('dream_progress', evt);
      }
      if (typeof session._dreamProgressSink === 'function') {
        session._dreamProgressSink(evt);
      }
      // Best-effort console for debug builds.
      if (session.config?.debug) {
        // eslint-disable-next-line no-console
        console.log('[dream-v2]', evt);
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

    if (typeof session._dreamProgressSink === 'function') {
      session._dreamProgressSink({
        type: 'turn_open',
        turnId,
        userPrompt: '[dream] automatic memory consolidation',
        vpId: null,
        groupId: null,
        at: startedAt,
      });
    }

    return runDream({
      ...buildRunDreamOpts(session, onProgress),
      manual: !!opts.manual,
      scopeFilter: Array.isArray(opts.scopeFilter) ? opts.scopeFilter : undefined,
    }).then((result) => {
      // Bug 2: emit turn_close when the dream pass completes.
      if (typeof session._dreamProgressSink === 'function') {
        session._dreamProgressSink({
          type: 'turn_close',
          turnId,
          totalMs: Date.now() - startedAt,
          totalTokens: 0,
          loopCount: session._dreamLoopCounter || 0,
        });
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
  const groupsRoot = join(args.yeaftDir, 'groups');
  let ids;
  try { ids = listGroups(groupsRoot).map(g => g.id); }
  catch { return out; }
  const empty = [];
  for (const gid of ids) {
    let segCount;
    try { segCount = args.memoryIndex.listByScope(`group/${gid}`).length; }
    catch { continue; }
    if (segCount > 0) continue;
    let hasMessages = false;
    try {
      const h = openGroup(groupsRoot, gid);
      // Any message at all is enough — pull the first record off the
      // iterator and stop.
      const first = h.streamMessages().next();
      hasMessages = !first.done;
    } catch { continue; }
    if (!hasMessages) continue;
    empty.push(`group/${gid}`);
  }
  if (empty.length === 0) return out;
  if (args.config?.debug) {
    // eslint-disable-next-line no-console
    console.log(`[dream-v2] boot init: triggering empty-AMS dream for ${empty.length} group(s):`, empty);
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
  const groupsRoot = join(args.yeaftDir, 'groups');
  const intervalMs = (args.intervalHours ?? DREAM_INTERVAL_HOURS) * 60 * 60 * 1000;
  const now = args.now ?? Date.now();

  let groupIds;
  try { groupIds = listGroups(groupsRoot).map(g => g.id); }
  catch { return out; }

  // Find the newest lastDreamAt across all groups.
  let newestAt = null;
  let anyTraffic = false;
  for (const gid of groupIds) {
    let st;
    try { st = await readGroupState(memoryRoot, gid); }
    catch { continue; }
    if (st.lastDreamAt) {
      const t = Date.parse(st.lastDreamAt);
      if (Number.isFinite(t) && (newestAt === null || t > newestAt)) newestAt = t;
    }
    if (!anyTraffic) {
      try {
        const h = openGroup(groupsRoot, gid);
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
    console.log(`[dream-v2] boot catch-up: stale (lastDreamAt=${out.lastDreamAt}, ageMs=${out.ageMs}); firing one non-manual tick.`);
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
