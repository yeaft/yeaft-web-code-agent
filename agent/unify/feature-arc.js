/**
 * feature-arc.js — Tracks a single VP turn's "is this heavy work?" arc.
 *
 * Design rationale
 * ----------------
 * The Unify group chat used to dump every tool call from every VP into
 * one scrolling feed, which made anything beyond a one-shot Q&A
 * unreadable. The fix is dual-layer:
 *
 *   group chat     → user prompt + a *pill* per heavy turn
 *                    (active: "🔧 [vp] doing X…", done: "✅ [vp] X — summary")
 *   detail panel   → the full unflattened timeline of whichever VP is
 *                    selected
 *
 * For pills to exist we need to know **which VP turns are heavy**. The
 * triage runs out of three signals (any-of):
 *
 *   1. Track A (quick-response) returned `intent: 'feature'`
 *   2. Track B (main engine) has cycled ≥ FEATURE_TURN_THRESHOLD loops
 *   3. Track B called any tool on KEY_TOOLS (work tools — bash, edits,
 *      sub-agent spawn, grep/find/glob — *not* pure read or web search)
 *
 * When any signal fires, this arc:
 *   - calls FeatureStore.create() with title := preview (or fallback)
 *   - stamps a `currentFeatureId` on the runVpTurn ctx so subsequent
 *     emits get featureId on their wire envelope
 *   - notifies the wire layer via a `feature_started` event so the
 *     frontend knows to fold prior messages into a pill
 *   - on turn close, runs a one-shot summarisation call against the
 *     accumulated assistant text, then writes status='completed' +
 *     result back through FeatureStore.update()
 *
 * The arc is **strictly additive** — it does not mutate engine state,
 * does not consume engine events the dispatcher needs, and silently
 * no-ops on any failure (logging only). A broken FeatureArc must never
 * break the user's turn.
 */

import { runQuickResponse } from './quick-response.js';

/**
 * Tools that strongly signal "doing real work". Single-file Read and
 * web search are intentionally excluded — they show up in trivial Q&A
 * (one quick lookup, one fact check) and would over-trigger the pill.
 *
 * Codebase grep/glob/find are *included* because they signal multi-file
 * investigation, which is exactly the "this got heavy" mode we want to
 * surface to the user.
 *
 * @type {Set<string>}
 */
export const KEY_TOOLS = new Set([
  'Bash',
  'FileEdit',
  'FileWrite',
  'FileCreate',
  'ApplyPatch',
  'NotebookEdit',
  'Agent',
  'Grep',
  'Glob',
  'Find',
  'JsRepl',
]);

/** Track-B loop count that on its own counts as "this got heavy". */
export const FEATURE_TURN_THRESHOLD = 3;

/** Cap title length we store on the Feature. */
const TITLE_MAX = 60;
/** Cap summary stored on completion. */
const SUMMARY_MAX = 600;

/**
 * Build a one-shot system prompt asking the LLM to summarise what it
 * just did in 1–3 sentences. Bilingual.
 *
 * @param {string} language
 */
function buildSummarySystem(language = 'en') {
  const isZh = String(language || '').toLowerCase().startsWith('zh');
  if (isZh) {
    return [
      '你刚刚完成了一段工作。请用中文写一条 1–3 句的总结，告诉用户你做了什么、关键结果是什么。',
      '只输出总结正文，不要 markdown，不要前缀（如「总结：」），不超过 600 字符。',
    ].join('\n');
  }
  return [
    'You just finished a piece of work. Write a 1–3 sentence summary in English describing what you did and the key outcome.',
    'Output only the summary prose. No markdown, no leading label like "Summary:", at most 600 characters.',
  ].join('\n');
}

/**
 * Drive one summary call. Fails-soft: returns '' on any error.
 *
 * @param {{
 *   adapter: object,
 *   model: string,
 *   prompt: string,           // user's original prompt — supplied as context
 *   assistantText: string,    // joined VP text output for this turn
 *   language?: string,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<string>}
 */
async function runSummaryCall({ adapter, model, prompt, assistantText, language, signal }) {
  if (!adapter || typeof adapter.stream !== 'function') return '';
  if (!model) return '';
  const text = (assistantText || '').trim();
  if (!text) return '';
  const system = buildSummarySystem(language);
  // We feed the model BOTH the user request and what we said back, so
  // a summary like "Looked at auth.js, found X, fixed it" is grounded.
  const userMsg = [
    'USER REQUEST:',
    String(prompt || '').slice(0, 4000),
    '',
    'WHAT YOU DID / SAID:',
    text.slice(0, 8000),
  ].join('\n');
  try {
    const parts = [];
    for await (const evt of adapter.stream({
      model,
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 400,
      signal,
    })) {
      if (evt && evt.type === 'text_delta' && typeof evt.text === 'string') {
        parts.push(evt.text);
      } else if (evt && evt.type === 'error') {
        return '';
      }
    }
    return parts.join('').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
  } catch {
    return '';
  }
}

/**
 * Make a feature title from preview / prompt. Strips trailing
 * punctuation and clamps length.
 */
function makeTitle({ preview, prompt }) {
  const src = (preview || prompt || '').replace(/\s+/g, ' ').trim();
  if (!src) return '(untitled task)';
  const clipped = src.slice(0, TITLE_MAX);
  return clipped.replace(/[.!?。！？…]+$/u, '').trim() || clipped;
}

/**
 * @typedef {Object} FeatureArcEmits
 * @property {(payload:{intent:'quick'|'feature', preview:string})=>void}
 *           [quickPreview]    — Track A finished
 * @property {(payload:{featureId:string, title:string, trigger:'quick'|'turns'|'tool', toolName?:string})=>void}
 *           [featureStarted]  — auto-create fired, frontend should fold
 * @property {(payload:{featureId:string, summary:string, status:'completed'|'aborted'|'error'})=>void}
 *           [featureCompleted] — turn ended, pill becomes done state
 *
 * @typedef {Object} FeatureArcDeps
 * @property {object|null} adapter       — LLMAdapter (session.adapter)
 * @property {string|null} model         — primaryModel
 * @property {object|null} featureStore  — FeatureStore instance (singleton)
 * @property {string} prompt             — user prompt that opened the turn
 * @property {string} vpId
 * @property {string|null} groupId
 * @property {string} turnId
 * @property {string} [vpDisplayName]
 * @property {string} [language]
 * @property {AbortSignal} [signal]
 * @property {FeatureArcEmits} [emit]
 * @property {Set<string>} [keyTools]    — override for tests
 * @property {number} [turnThreshold]    — override for tests
 */

/**
 * Create a per-VP-turn arc tracker. Caller MUST:
 *   - call `arc.startTrackA()` once at the very beginning of runVpTurn
 *     (returns a Promise that backgrounds; do NOT await)
 *   - call `arc.observeEvent(event)` for every engine event before
 *     dispatching it to the existing handleEngineEvent
 *   - call `arc.collectAssistantText(chunk)` whenever a text_delta is
 *     forwarded (lets us seed the summary call without re-aggregating)
 *   - call `await arc.finalize({status})` AFTER the engine query
 *     generator drains, before sending the final 'result'.
 *
 * The arc is opinionated about ordering: featureId is published only
 * once, the first time any signal fires. Subsequent fires are no-ops.
 *
 * @param {FeatureArcDeps} deps
 */
export function createFeatureArc(deps = {}) {
  const {
    adapter = null,
    model = null,
    featureStore = null,
    prompt = '',
    vpId,
    groupId = null,
    turnId,
    vpDisplayName,
    language,
    signal,
    emit = {},
    keyTools = KEY_TOOLS,
    turnThreshold = FEATURE_TURN_THRESHOLD,
  } = deps;

  let trackAResult = null;            // {intent, preview} | null
  let trackADone = false;
  let featureId = null;
  let featureTitle = null;
  let assistantText = '';             // accumulated for summary call
  let loopCount = 0;                  // 'turn_open'/'loop'/'reflection' increments
  let _finalised = false;

  /** Internal: try to fire the auto-create. Idempotent. */
  function maybeCreateFeature(signalKind, extra = {}) {
    // Race guard: Track A is fire-and-forget, so it can resolve AFTER
    // the engine generator has drained and finalize() has already
    // closed the arc. Without this guard a late Track A would publish
    // `feature_started` *after* `feature_completed` (or worse, with
    // no `feature_completed` at all), leaving a dangling-active pill
    // on the frontend.
    if (_finalised) return;
    if (featureId) return;            // already created
    if (!featureStore || typeof featureStore.create !== 'function') {
      // No store — at least publish a synthetic id so the frontend can
      // still render a pill. Use a deterministic prefix so it's obvious
      // when something is wrong.
      featureId = `feat-local-${turnId}`;
    } else {
      try {
        // Use the FULL UUID / random-string. A previous version
        // sliced to 8 chars (32 bits of entropy) — collisions in a
        // multi-VP group ingest were observed because the
        // Date.now()/random fallback's first chars are dominated by
        // the ms-precision timestamp, so two VPs in the same
        // millisecond would hash to the same 8-char prefix and the
        // frontend's featureId-keyed map would silently overwrite.
        const rand = globalThis.crypto?.randomUUID?.()
          || (Date.now().toString(36) + Math.random().toString(36).slice(2));
        const id = `feat-${rand}`;
        const title = makeTitle({ preview: trackAResult?.preview, prompt });
        featureTitle = title;
        const record = {
          id,
          title,
          description: prompt ? prompt.slice(0, 500) : '',
          priority: 'medium',
          status: 'in_progress',
          parentId: null,
          parentTaskId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        if (groupId) {
          record.groupId = groupId;
          record.members = [vpId];
          record.initiator = vpId;
        }
        featureStore.create(record);
        featureId = id;
      } catch (err) {
        console.warn('[FeatureArc] create failed:', err?.message || err);
        // Fallback: still publish a synthetic id so the UI gets a pill
        // (matches the no-store branch above — a broken store should
        // not silently disable the feature folding UX).
        featureId = `feat-local-${turnId}`;
        featureTitle = makeTitle({ preview: trackAResult?.preview, prompt });
      }
    }
    if (typeof emit.featureStarted === 'function') {
      try {
        emit.featureStarted({
          featureId,
          title: featureTitle || makeTitle({ preview: trackAResult?.preview, prompt }),
          trigger: signalKind,
          toolName: extra.toolName,
        });
      } catch (err) {
        console.warn('[FeatureArc] featureStarted emit failed:', err?.message || err);
      }
    }
  }

  /**
   * Launch Track A in the background. Returns the promise so callers can
   * await it during shutdown if they need to (tests). In the hot path
   * runVpTurn fires-and-forgets.
   */
  async function startTrackA() {
    try {
      const result = await runQuickResponse({
        adapter,
        model,
        prompt,
        language,
        vpDisplayName,
        signal,
      });
      trackAResult = result;
      trackADone = true;
      if (result && typeof emit.quickPreview === 'function') {
        try {
          emit.quickPreview({ intent: result.intent, preview: result.preview });
        } catch (err) {
          console.warn('[FeatureArc] quickPreview emit failed:', err?.message || err);
        }
      }
      if (result && result.intent === 'feature') {
        maybeCreateFeature('quick');
      }
    } catch (err) {
      // runQuickResponse already swallows most things; log + continue.
      trackADone = true;
      console.warn('[FeatureArc] Track A failed:', err?.message || err);
    }
  }

  /**
   * Observe one engine event, mutating internal counters and possibly
   * firing the auto-create. Always called BEFORE the existing
   * handleEngineEvent dispatch so the featureId is set in time for
   * the wire envelope to pick it up.
   *
   * @param {{type:string, name?:string, text?:string}} event
   */
  function observeEvent(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      // Only `loop` counts toward the heavy-turn threshold. The engine
      // emits exactly one `turn_open` per turn (the bookkeeping marker
      // that the turn started); `loop` is the per-iteration event.
      // Counting both inflates by one and would cause
      // FEATURE_TURN_THRESHOLD = 3 to fire after only 2 real loops.
      case 'loop':
        loopCount += 1;
        if (loopCount >= turnThreshold) maybeCreateFeature('turns');
        break;
      case 'tool_call':
        if (event.name && keyTools.has(event.name)) {
          maybeCreateFeature('tool', { toolName: event.name });
        }
        break;
      case 'text_delta':
        if (typeof event.text === 'string') {
          // Soft cap so a runaway VP doesn't balloon memory before
          // summarisation. 50 KB is enough context for any 1–3 sentence
          // summary.
          if (assistantText.length < 50_000) {
            assistantText += event.text;
          }
        }
        break;
      default:
        break;
    }
  }

  /**
   * Run summary + FeatureStore.update. Idempotent. Caller passes a
   * status hint so we know whether to write 'completed' / 'aborted' /
   * 'error'.
   *
   * @param {{status?:'completed'|'aborted'|'error'}} [opts]
   */
  async function finalize(opts = {}) {
    if (_finalised) return;
    _finalised = true;
    if (!featureId) return;           // never escalated; nothing to close

    const status = opts.status || 'completed';
    let summary = '';
    if (status === 'completed') {
      summary = await runSummaryCall({
        adapter, model, prompt, assistantText, language, signal,
      });
    } else if (status === 'aborted') {
      summary = '(turn aborted)';
    } else {
      summary = '(turn ended with error)';
    }

    if (!summary) {
      // Fallback to a truncated tail of the assistant text so the pill
      // is never a blank "✅ — ".
      summary = (assistantText || '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(no summary)';
    }

    // Skip the persistence call for synthetic ids — those exist
    // precisely because the store was unavailable or threw on create,
    // so any update against them would also throw on the unknown id
    // (and the catch would silently swallow it). Wire emits still
    // happen so the frontend gets a consistent close.
    const isSynthetic = featureId.startsWith('feat-local-');
    if (!isSynthetic && featureStore && typeof featureStore.update === 'function') {
      try {
        featureStore.update(featureId, {
          status,
          result: summary,
        });
      } catch (err) {
        console.warn('[FeatureArc] update failed:', err?.message || err);
      }
    }

    if (typeof emit.featureCompleted === 'function') {
      try {
        emit.featureCompleted({ featureId, summary, status });
      } catch (err) {
        console.warn('[FeatureArc] featureCompleted emit failed:', err?.message || err);
      }
    }
  }

  return {
    startTrackA,
    observeEvent,
    finalize,
    /** Mostly for tests / wire-tagging in the hot path. */
    getFeatureId: () => featureId,
    getTitle: () => featureTitle,
    getTrackAResult: () => trackAResult,
    isTrackADone: () => trackADone,
    getLoopCount: () => loopCount,
  };
}

// Test seams.
export const __test = {
  makeTitle,
  buildSummarySystem,
};
