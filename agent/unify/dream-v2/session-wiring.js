/**
 * dream-v2/session-wiring.js — DESIGN-v2 §13 wire-up for session.js.
 *
 * Bridges the framework-agnostic `runDream` orchestrator (dream-v2/runner.js)
 * to the live yeaft session: groups store, conversation log, LLM adapter,
 * and the engine's progress event sink.
 *
 * The dream pipeline only activates when `config.memoryV2 === true`. When
 * the flag is off, this module is a no-op — the legacy R6 dream-scheduler
 * keeps running as before (session.js still wires it).
 */

import { join } from 'path';
import { runDream } from './runner.js';
import { createDreamScheduler } from './schedule.js';
import { listGroups, openGroup } from '../groups/group-store.js';

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
 * the shape runDream expects (id, role, body, vpId, author, featureId).
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
  if (m.meta && typeof m.meta === 'object' && m.meta.featureId) {
    out.featureId = m.meta.featureId;
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
    const r = await adapter.call({
      model,
      system: system || `You are the dream pipeline — pass: ${pass}.`,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
    });
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

  const run = (opts = {}) => runDream({
    ...buildRunDreamOpts(session, onProgress),
    manual: !!opts.manual,
    scopeFilter: Array.isArray(opts.scopeFilter) ? opts.scopeFilter : undefined,
  });

  const v2 = createDreamScheduler({
    run,
    logger: session.config?.debug ? console : undefined,
  });
  // Auto-start the timer.
  v2.start();
  // Adapter shim: legacy callers (web-bridge) call .noteUserMessage() and
  // .triggerDreamNow() / .shutdown(). Map them onto the v2 API.
  return {
    noteUserMessage() { /* v2 doesn't gate on user-message count */ },
    triggerDreamNow() { return v2.triggerNow(); },
    shutdown() { v2.stop(); },
    get isRunning() { return v2.isRunning(); },
    // Preserve direct access for tests.
    _v2: v2,
  };
}
