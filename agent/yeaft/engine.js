/**
 * engine.js — Yeaft query loop
 *
 * The engine is the core orchestrator:
 *   1. Before first turn: recall memories → inject into system prompt
 *   2. Build messages array (with compact summary if available)
 *   3. Call adapter.stream()
 *   4. Collect text + tool_calls from stream events
 *   5. If tool_calls → execute tools → append results → goto 3
 *   6. If end_turn → persist messages → check consolidation → done
 *   7. If max_tokens → auto-continue (up to maxContinueTurns)
 *   8. On LLMContextError → force compact → retry
 *   9. On retryable error with fallbackModel → switch model → retry
 *
 * Pattern derived from Claude Code's query loop (src/query.ts).
 *
 * Reference: yeaft-yeaft-implementation-plan.md §3.1, §4 (Phase 2)
 */

import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { buildSystemPrompt, buildWorkerPrompt } from './prompts.js';
import { LLMContextError, LLMAbortError } from './llm/adapter.js';
import { runMemoryPreflow, buildRelevantScopes } from './sessions/pre-flow.js';
import { readProjectDoc, pickProjectDocFile, DEFAULT_PROJECT_DOC_MAX_BYTES } from './sessions/project-doc.js';
import { partitionMessages } from './compact/partition.js';
import { runCompact as runCompactOrchestrator } from './compact/orchestrator.js';
import { evaluateCompactTriggers } from './compact/triggers.js';
import { archiveTurn } from './archive/turn-archive.js';
import { archiveToolResults } from './archive/tool-results.js';
import { readSummary as readScopeSummary } from './memory/store.js';
import { runAdjust } from './memory/adjust.js';
import { isVpSeedBackfillStub } from './memory/seed-backfill.js';
import { runStopHooks } from './stop-hooks.js';
// Default thread marker for legacy / non-group flows. Group VP runtime may
// pass a real threadId per (sessionId, vpId, threadId) engine instance.
const MAIN_THREAD_ID = 'main';
import { pickEffort, parseEffortPrefix } from './effort.js';
import { DEFAULT_CONTEXT_WINDOW, normalizeEffort, resolveContextWindow, resolveModel } from './models.js';
import { lookupModelLimitSync } from './llm/models-dev.js';
import { countTurns } from './turn-utils.js';
import { attachRouterPlan, extractPriorPlan, stripMetaForWire } from './router/continuity.js';
import { resolveThinking } from './router/thinking.js';
import { approxTokens } from './memory/budget.js';
import { COLLAB_TOOL_POLICY, truncateToolResultIfNeeded } from './tools/registry.js';
import { acknowledgePendingNotifications, formatNotificationsForPrompt, peekPendingNotifications } from './sub-agent/notifications.js';
import {
  TOOL_BATCH_SIZE,
  TURN_SUMMARY_THRESHOLD,
  DUP_TOOL_THRESHOLD,
  ExecLog,
  buildEntry as buildExecLogEntry,
  argsHashOf,
  runT1Reflection,
  runT2Reflection,
  buildFallbackStub,
  collapseRangeToReflection,
  buildDuplicateReminder,
  extractToolPairsFromRange,
} from './tool-folding/index.js';

/**
 * task-324 — Turn cap removed.
 *
 * Previously MAX_TURNS=25 broke the query loop out of long tool-driven
 * conversations (user report: Yeaft loop errored at the cap). The engine
 * now runs until the LLM itself returns stopReason='end_turn' or a
 * non-retryable error surfaces. Real runaway loops are still bounded by:
 *   • provider rate limits / context window (LLMContextError → compact)
 *   • user-initiated abort (AbortController / cancel)
 *   • MAX_CONTINUE_TURNS for the max_tokens auto-continue path
 */

/** Maximum auto-continue turns when stopReason is 'max_tokens'. */
const MAX_CONTINUE_TURNS = 3;

/**
 * task-331 — Map a conversationMessages entry into the snapshot shape used
 * by `debug_turn.messages`. Preserves the function-calling metadata that
 * the Debug panel needs to render:
 *   - `toolCalls` on assistant turns (the LLM's function_call requests)
 *   - `toolCallId` + `isError` on tool turns (the paired tool_result)
 *
 * Content is passed through verbatim — never truncated. Debug traces must
 * mirror exactly what we sent to the LLM; a truncated copy is misleading.
 * If the resulting payload is too large for the client debug store the
 * bound is per-loop-count (see `MAX_YEAFT_DEBUG_LOOPS` in
 * `web/stores/chat.js`), not per-payload mutilation here.
 *
 * Pure function — no side effects on the input message.
 *
 * @param {{ role: string, content?: any, toolCalls?: Array, toolCallId?: string, isError?: boolean }} m
 * @returns {{ role: string, content: any, toolCalls?: Array, toolCallId?: string, isError?: boolean }}
 */
export function mapDebugMessage(m) {
  const out = { role: m.role };
  out.content = m.content;
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    out.toolCalls = m.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
  }
  if (m.toolCallId) out.toolCallId = m.toolCallId;
  if (m.isError != null) out.isError = m.isError;
  return out;
}

/**
 * task-704b — estimate the total token cost of a system prompt + a
 * messages array. Used by the pre-flight guard before adapter.stream()
 * to decide whether to run an emergency archive sweep.
 *
 * Why estimate, not exact: a real tokenizer (tiktoken, claude-tokenizer)
 * adds a heavy dep + per-turn cost for what is fundamentally a guard
 * rail. `approxTokens` (char/4 with CJK weighting) is the same
 * estimator the AMS budget code uses; it is monotonic in payload size
 * and that is the only property the guard rail needs. False positives
 * cost an unnecessary archive sweep (cheap); false negatives let a
 * runaway request through (expensive — that is exactly the bug we are
 * fixing).
 *
 * Multi-modal messages: `content` may be an array of content parts
 * (Anthropic / OpenAI Responses shape). Text parts use approxTokens;
 * image parts get a fixed 1024-token estimate — a rough average across
 * vision pricing models. Exact pricing isn't the goal; "this is roughly
 * how much of the window the message will consume" is.
 *
 * @param {string} system
 * @param {Array<{role:string, content?:any, toolCalls?:Array}>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(system, messages) {
  let total = approxTokens(typeof system === 'string' ? system : '');
  if (!Array.isArray(messages)) return total;
  for (const m of messages) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === 'string') {
      total += approxTokens(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (!part) continue;
        if (part.type === 'text') {
          // Coerce defensively — a non-string `text` (number, Buffer,
          // object) would otherwise throw inside approxTokens and abort
          // the pre-flight estimate, defeating the guard rail.
          total += approxTokens(typeof part.text === 'string' ? part.text : '');
        } else if (part.type === 'image') {
          total += 1024;
        }
        // Other multi-modal parts (audio etc.) — skip; not produced today.
      }
    }
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        try {
          total += approxTokens(JSON.stringify(tc.input || {}));
        } catch { /* circular — ignore */ }
        total += approxTokens(typeof tc.name === 'string' ? tc.name : '');
      }
    }
  }
  return total;
}

export const GROUP_CONTEXT_PRESSURE_RATIO = 0.8;
export const GROUP_MIN_TURNS_FOR_COMPACT = 5;

export function shouldAllowGroupReflection({
  system = '',
  messages = [],
  model = null,
  config = {},
  sessionId = null,
} = {}) {
  if (!sessionId) {
    return {
      allowed: true,
      compactAllowed: true,
      tokenEstimate: estimateMessagesTokens(system, messages),
      threshold: 0,
      contextWindow: null,
      ratio: GROUP_CONTEXT_PRESSURE_RATIO,
      turnCount: countTurns(messages),
      usedFallbackContextWindow: false,
    };
  }
  const contextWindow = resolveContextWindow(model, config);
  // Telemetry: did the resolver hit either of its top non-default rungs?
  // Used by `usedFallbackContextWindow` below — if neither models.dev nor
  // the global config provided a number, we fell through to DEFAULT and
  // callers may want to surface that to the user.
  const hasModelsDevContext = !!lookupModelLimitSync(model, resolveModel(model)?.provider || null)?.context;
  const hasConfigContext = Number.isFinite(config?.maxContextTokens) && config.maxContextTokens > 0;
  const threshold = Math.floor(contextWindow * GROUP_CONTEXT_PRESSURE_RATIO);
  const tokenEstimate = estimateMessagesTokens(system, messages);
  const overThreshold = tokenEstimate >= threshold;
  const turnCount = countTurns(messages);
  return {
    // Group send defaults to no reflection. Trust the model until context
    // pressure says we are near the model window.
    allowed: overThreshold,
    // Durable compact is also protected for tiny histories: fewer than five
    // turns do not compact unless they already exceed the same 80% threshold.
    compactAllowed: overThreshold || turnCount >= GROUP_MIN_TURNS_FOR_COMPACT,
    tokenEstimate,
    threshold,
    contextWindow,
    ratio: GROUP_CONTEXT_PRESSURE_RATIO,
    turnCount,
    usedFallbackContextWindow: !hasModelsDevContext && !hasConfigContext && contextWindow === DEFAULT_CONTEXT_WINDOW,
  };
}

// ─── Engine Events (superset of adapter events) ──────────────────

/**
 * @typedef {{ type: 'turn_start', turnNumber: number }} TurnStartEvent
 * @typedef {{ type: 'turn_end', turnNumber: number, stopReason: string }} TurnEndEvent
 * @typedef {{ type: 'tool_start', id: string, name: string, input: object }} ToolStartEvent
 * @typedef {{ type: 'tool_end', id: string, name: string, output: string, isError: boolean }} ToolEndEvent
 * @typedef {{ type: 'consolidate', archivedCount: number, extractedCount: number }} ConsolidateEvent
 * @typedef {{ type: 'recall', entryCount: number, cached: boolean }} RecallEvent
 * @typedef {{ type: 'fallback', from: string, to: string, reason: string }} FallbackEvent
 *
 * @typedef {import('./llm/adapter.js').StreamEvent | TurnStartEvent | TurnEndEvent | ToolStartEvent | ToolEndEvent | ConsolidateEvent | RecallEvent | FallbackEvent} EngineEvent
 */

// ─── Engine ──────────────────────────────────────────────────────

/**
 * buildResidentEntries — pure helper that builds the AMS Resident entry
 * list from the per-turn Layer-A summaries.
 *
 * Encodes one non-trivial rule on top of "push if non-empty":
 *
 *   The `vp/<ownVpId>` summary is skipped when it carries the
 *   seed-backfill stub marker. The persona body is already rendered as
 *   Section 1 of the system prompt by `renderVpPersona`; surfacing the
 *   stub's `# Name / Role` line as a Resident entry would re-label the
 *   same identity in Section 6 ("Active Memory Set") with no added
 *   information — the visible follow-up to the persona-dup bug fixed in
 *   PR #722. Once Dream-v2 writes a real summary for this scope it
 *   lacks the marker and is surfaced normally.
 *
 * Other-VP entries (group collaborators) are NOT considered here — only
 * the local VP's summary is loaded into `summaries.vp` upstream by
 * `#loadLayerASummaries`. Cross-VP context flows through onDemand recall.
 *
 * @param {{
 *   sessionId?: string|null,
 *   ownVpId?: string|null,
 *   summaries: { user?: string, session?: string, vp?: string }
 * }} args
 * @returns {Array<{scope: string, summary: string}>}
 */
export function buildResidentEntries(args) {
  const summaries = (args && args.summaries) || {};
  const out = [];
  if (summaries.user) out.push({ scope: 'user', summary: summaries.user });
  if (args.sessionId && summaries.session) {
    out.push({ scope: `sessions/${args.sessionId}`, summary: summaries.session });
  }
  // VP per-session isolation (2026-06-09): the VP summary scope MUST be
  // session-qualified. The legacy bare `vp/<id>` scope was a structural
    // (see #loadLayerASummaries, kind:'group-vp'), so labelling it `vp/<id>`
  // in the Resident layer (a) collides with the ACL regex in store
  // (which only recognises `<root>/<sid>/vp/...`) and (b) makes the same
  // VP persona leak across DIFFERENT sessions whenever the AMS rehydrates
  // by id rather than by full scope path. The session-qualified form
  // makes the per-session boundary explicit and matches the on-disk
  // layout 1:1.
  if (args.sessionId && args.ownVpId && summaries.vp && !isVpSeedBackfillStub(summaries.vp)) {
    out.push({ scope: `sessions/${args.sessionId}/vp/${args.ownVpId}`, summary: summaries.vp });
  }
  return out;
}

function isZhRuntimeLanguage(language) {
  return String(language || '').toLowerCase().startsWith('zh');
}

export class Engine {
  /** @type {import('./llm/adapter.js').LLMAdapter} */
  #adapter;

  /** @type {import('./debug-trace.js').DebugTrace | import('./debug-trace.js').NullTrace} */
  #trace;

  /** @type {object} */
  #config;

  /** @type {Map<string, { name: string, description: string, parameters: object, execute: function }>} */
  #tools;

  /** @type {string} */
  #traceId;

  /** @type {import('./conversation/persist.js').ConversationStore|null} */
  #conversationStore;

  /** @type {import('./memory/index-db.js').SegmentIndex|null} — GC.1: SQLite FTS5 segment index */
  #memoryIndex;

  /** @type {import('./memory/ams-registry.js').AmsRegistry|null} — group-keyed AMS cache */
  #amsRegistry;

  /** @type {import('./tools/registry.js').ToolRegistry|null} */
  #toolRegistry;

  /** @type {import('./skills.js').SkillManager|null} */
  #skillManager;

  /** @type {import('./mcp.js').MCPManager|null} */
  #mcpManager;

  /** @type {string|null} */
  #yeaftDir;
  /** @type {string|null} — set when this engine is bound to a specific group (per-VP fan-out path). */
  #sessionId = null;
  /** @type {string|null} — set when this engine is bound to a specific VP (per-VP fan-out path). */
  #vpId = null;
  /** @type {string|null} — set when this engine is bound to a chat session (Chat Mode). */
  #chatId = null;

  /** @type {import('./stats/tool-usage.js').ToolUsageStats|null} — per-tool call/latency counters */
  #toolStats = null;

  /** @type {object|null} — Config override for internal tasks (recall, consolidation, dream) using fastModel */
  #fastConfig;

  /** @type {((agentId: string, evt: object) => void) | null} */
  #subAgentEventSink = null;

  // (removed 2026-05-13) `#currentFeatureIdAccessor` — sub-agent
  // feature-inheritance plumbing that went with the Feature system.

  /**
   * task-325a — abort state.
   *
   * The engine exposes a first-class abort surface: `engine.abort(reason)`
   * aborts the currently running `query()` loop. Internally we keep:
   *
   *   • `#currentAbortCtrl` — the per-query AbortController created (or
   *     reused from the caller's signal) when query() starts. Used to
   *     propagate abort to the LLM adapter stream and to tool execution.
   *   • `#abortReason`       — the reason string passed to abort(), surfaced
   *     on the emitted `aborted` event so the UI can render a meaningful
   *     stop banner (`user`, `timeout`, `thread_reset`, etc.).
   *
   * State machine convergence: when the signal fires, the loop catches the
   * LLMAbortError (or a synthetic abort check) and yields exactly one pair
   * of events — `{type:'aborted', reason}` followed by
   * `{type:'turn_end', stopReason:'aborted'}` — then returns without
   * persisting partial tool calls, consolidation, or stop-hook side-effects.
   *
   * @type {AbortController|null}
   */
  #currentAbortCtrl = null;

  /**
   * PR-L — V7 Tool History Reflection state. Owned per Engine instance.
   *
   *   • `#execLog` — append-only log of every tool execution, used for
   *     fallback-stub generation and duplicate-call detection. Persists
   *     to <yeaftDir>/tool-log/<traceId>/<turnIdx>.jsonl when yeaftDir
   *     is set; in-memory only otherwise.
   *   • `#pendingT2` — Map<turnNumber, { promise, loopRange, count, ... }>
   *     keyed by the turn number that triggered T2. The next query() call
   *     non-blocking-checks this map; if the promise has resolved, the
   *     prior turn's history is rewritten with the reflection. If still
   *     pending, the engine falls back to the exec-log stub.
   *   • `#reflectedTurns` — Set<turnNumber>; ensures T1 fires at most
   *     once per turn (when toolCount crosses TOOL_BATCH_SIZE).
   */
  #execLog = null;
  #pendingT2 = new Map();
  #reflectedTurns = new Set();
  #__queryCounter = 0;

  /** @type {string} */
  #currentThreadId = MAIN_THREAD_ID;

  /** @type {Array<{content:string|Array, preview:string}>} */
  #pendingUserMessages = [];

  /**
   * Per-group "adjust has run at least once this engine lifetime" flag.
   * Keyed by sessionId (or 'default'). The first turn always runs adjust;
   * subsequent turns only run on budget pressure or new memory.
   * @type {Map<string, boolean>}
   */
  #adjustRanBySession = new Map();

  /** @type {string|null} */
  #abortReason = null;

  /**
   * Per-engine cache of the resolved CLAUDE.md / AGENTS.md project doc.
   * Shape: `{ workDir, path, mtimeMs, text } | null`. A non-null record
   * means "for THIS workDir, the file at `path` with this `mtimeMs`
   * resolved to `text`" — when the next turn's stat returns the same
   * `(path, mtimeMs)` tuple, we skip the read entirely. mtime changes
   * (or a different picked file, e.g. user added AGENTS.md) invalidate
   * automatically because the `path`/`mtimeMs` comparison fails.
   * @type {{ workDir: string, path: string, mtimeMs: number, text: string }|null}
   */
  #projectDocCache = null;

  /**
   * @param {{
   *   adapter: import('./llm/adapter.js').LLMAdapter,
   *   trace: object,
   *   config: object,
   *   conversationStore?: import('./conversation/persist.js').ConversationStore,
   *   memoryIndex?: import('./memory/index-db.js').SegmentIndex,
   *   amsRegistry?: object,
   *   toolRegistry?: import('./tools/registry.js').ToolRegistry,
   *   skillManager?: import('./skills.js').SkillManager,
   *   mcpManager?: import('./mcp.js').MCPManager,
   *   yeaftDir?: string,
   *   toolStats?: import('./stats/tool-usage.js').ToolUsageStats,
   * }} params
   */
  constructor({ adapter, trace, config, conversationStore, memoryIndex, amsRegistry, toolRegistry, skillManager, mcpManager, yeaftDir, toolStats = null, sessionId = null, vpId = null, chatId = null }) {
    this.#adapter = adapter;
    this.#trace = trace;
    this.#config = config;
    this.#tools = new Map();
    this.#traceId = randomUUID();
    this.#conversationStore = conversationStore || null;
    this.#memoryIndex = memoryIndex || null;
    this.#amsRegistry = amsRegistry || null;
    this.#toolRegistry = toolRegistry || null;
    this.#skillManager = skillManager || null;
    this.#mcpManager = mcpManager || null;
    this.#yeaftDir = yeaftDir || null;
    this.#toolStats = toolStats || null;
    // Per-VP fan-out (2026-06-01): engine instances in the group path are
    // keyed by ${sessionId}::${vpId}::${threadId}, so binding the engine to
    // its (sessionId, vpId) pair at construction lets post-turn compact
    // scope its read/write to THIS VP's view of the conversation instead
    // of clobbering a session-global compact.md. Legacy / sub-agent
    // callers leave both null → fall back to the global file.
    this.#sessionId = (typeof sessionId === 'string' && sessionId) ? sessionId : null;
    this.#vpId = (typeof vpId === 'string' && vpId) ? vpId : null;
    this.#chatId = (typeof chatId === 'string' && chatId) ? chatId : null;

    // PR-L: tool history reflection log. Keyed by traceId so distinct
    // engine instances don't stomp on each other's jsonl files. When
    // yeaftDir is null the ExecLog still works — purely in-memory.
    this.#execLog = new ExecLog({
      yeaftDir: this.#yeaftDir,
      conversationId: this.#traceId,
    });

    // Build fast config: uses fastModelId for internal tasks (recall, consolidation, dream)
    // Falls back to primary model if no fastModel configured
    const fastModelId = config.fastModelId || config.model;
    if (fastModelId !== config.model) {
      this.#fastConfig = { ...config, model: fastModelId };
    } else {
      this.#fastConfig = config;
    }
  }

  /**
   * Register a tool that the LLM can call.
   *
   * @param {{ name: string, description: string, parameters: object, execute: (input: object, ctx?: { signal?: AbortSignal }) => Promise<string> }} tool
   */
  registerTool(tool) {
    this.#tools.set(tool.name, tool);
  }

  /**
   * task-325a — abort the currently running query().
   *
   * Idempotent and safe to call when no query is in flight (no-op).
   * The abort is cooperative: the in-flight adapter stream receives the
   * signal immediately (fetch aborts), the tool loop checks the signal
   * between invocations, and the loop emits a typed `aborted` event
   * before returning so the caller can distinguish "user stopped" from
   * "LLM returned end_turn".
   *
   * @param {string} [reason='user'] — Human-tagged reason surfaced on the
   *   emitted `aborted` event. Common values: `'user'`, `'timeout'`,
   *   `'thread_reset'`, `'session_reset'`.
   * @returns {boolean} true if an in-flight query was aborted, false if
   *   nothing was running (no-op).
   */
  abort(reason = 'user') {
    if (!this.#currentAbortCtrl) return false;
    if (this.#currentAbortCtrl.signal.aborted) return false;
    this.#abortReason = reason || 'user';
    try {
      this.#currentAbortCtrl.abort();
    } catch {
      // AbortController.abort never throws in practice, but swallow
      // defensively so abort() never takes down the caller.
    }
    return true;
  }

  /**
   * task-325a — whether there is an in-flight query that has NOT been
   * aborted. Useful for callers that want to know "is this engine busy?"
   * without racing on the signal.
   * @returns {boolean}
   */
  get isRunning() {
    return !!this.#currentAbortCtrl && !this.#currentAbortCtrl.signal.aborted;
  }

  /**
   * Mutate the engine's effective language at runtime. The next call to
   * #buildSystemPrompt reads this.#config.language live, so the very next
   * turn renders in the new language without reconstructing the engine.
   *
   * Used by the live-locale broadcast path: when the user flips the UI
   * language dropdown, web → server → message-router calls
   * broadcastLanguageChange(lang) (web-bridge.js) which fans out to every
   * Engine in the per-VP pool plus the 1:1-chat session engine.
   *
   * @param {string} lang — 'en' | 'zh'
   */
  setLanguage(lang) {
    if (typeof lang !== 'string' || !lang) return;
    this.#config.language = lang;
  }

  /**
   * Unregister a tool.
   *
   * @param {string} name
   */
  unregisterTool(name) {
    this.#tools.delete(name);
  }

  /**
   * Get the list of registered tool definitions (for passing to the adapter).
   * Prefers ToolRegistry when available, falls back to legacy #tools Map.
   *
   * task-297: mode-based filtering was removed — all registered tools are
   * always exposed to the LLM.
   *
   * @returns {import('./llm/adapter.js').UnifiedToolDef[]}
   */
  #getToolDefs(collabToolPolicy = null) {
    if (this.#toolRegistry) {
      return this.#toolRegistry.getToolDefs(this.#config?.language || 'en', { collabToolPolicy });
    }
    // Legacy path: no mode filtering
    const defs = [];
    for (const [, tool] of this.#tools) {
      defs.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
    return defs;
  }

  /**
   * Load Layer A scope summaries from `<memoryRoot>/<scope>/summary.md`.
   *
   * Scopes:
   *   - user           → `user/summary.md`            (always attempted)
   *   - session <sid>  → `sessions/<sid>/summary.md`   (if sessionId)
   *   - session-vp     → `sessions/<sid>/vp/<vpId>/summary.md` (if vpId)
   *
   * Each fetch is best-effort — missing files / read errors return ''. The
   * dream tick (Phase 6) is what populates these; on a fresh install they
   * all return ''.
   *
   * @param {{sessionId?: string, vpId?: string, language?: string}} ctx
   * @returns {Promise<{user:string, session:string, vp:string}>}
   */
  async #loadLayerASummaries({ sessionId, vpId, language } = {}) {
    if (!this.#yeaftDir) return { user: '', session: '', vp: '' };
    const memoryRoot = `${this.#yeaftDir}/memory`;
    const tasks = [
      readScopeSummary({ kind: 'user' }, { root: memoryRoot, language }).catch(() => ''),
      sessionId
        ? readScopeSummary({ kind: 'session', id: sessionId }, { root: memoryRoot, language }).catch(() => '')
        : Promise.resolve(''),
      vpId && sessionId
        ? readScopeSummary({ kind: 'session-vp', sessionId, id: vpId }, { root: memoryRoot, language }).catch(() => '')
        : Promise.resolve(''),
    ];
    const [user, session, vp] = await Promise.all(tasks);
    return { user: user || '', session: session || '', vp: vp || '' };
  }

  async #loadSessionTopicLabels(sessionId, limit = 8) {
    if (!this.#yeaftDir || !sessionId) return [];
    const topicRoot = join(this.#yeaftDir, 'memory', 'sessions', sessionId, 'topic');
    const labels = [];
    await collectTopicLabels(topicRoot, '', labels, limit).catch(() => {});
    return labels;
  }

  /**
   * Prepare the per-turn AMS for the active group. Idempotent and safe
   * to call when the AMS registry isn't wired (returns null).
   *
   * @param {{
   *   sessionId?: string,
   *   ownVpId?: string|null,
   *   summaries: { user?: string, session?: string, vp?: string },
   *   recallEntries: object[],
   * }} args
   * @returns {{
   *   ams: import('./memory/ams.js').ActiveMemorySet,
   *   sessionKey: string,
   *   ownVpId: string|null,
   *   scopes: string[],
   *   snapshotBlock: string,
 *   residentEntries: Array<{scope:string, summary:string}>,
   * } | null}
   */
  #prepareAms(args) {
    if (!this.#amsRegistry) return null;
    const sessionKey = args.sessionId || 'default';
    const ownVpId = args.ownVpId || null;
    const ams = this.#amsRegistry.getOrCreate(sessionKey, { ownVpId });

    // Prime #adjustRanBySession from disk-hydrated state on first access:
    // a reactivated group resumes with whatever adjustRanThisSession bit
    // it had on disconnect, so we don't burn a fresh adjust on every
    // reload. Once set true in this session we never clear it.
    if (!this.#adjustRanBySession.has(sessionKey)
        && this.#amsRegistry.adjustRanThisSession(sessionKey)) {
      this.#adjustRanBySession.set(sessionKey, true);
    }

    // (a) Resident: rebuild from the same scope summaries the worker
    // prompt is already going to see.
    const residentEntries = buildResidentEntries({
      sessionId: args.sessionId,
      ownVpId,
      summaries: args.summaries || {},
    });
    ams.setResident(residentEntries);

    // (b) onDemand: replace with this turn's FTS hits.
    const segs = Array.isArray(args.recallEntries) ? args.recallEntries : [];
    ams.setOnDemand(segs);

    // (c) Snapshot — render the AMS layers as a single prompt block.
    const snapshotBlock = this.#renderAmsSnapshot(ams, this.#config.language || 'en');

    const scopes = buildRelevantScopes({
      sessionId: args.sessionId,
      vpId: ownVpId,
    });

    return { ams, sessionKey, ownVpId, scopes, snapshotBlock, residentEntries };
  }

  /**
   * Render an AMS snapshot as a markdown block suitable for prompt
   * injection. Mirrors the heading style of the existing memory blocks
   * so the LLM sees a consistent layout.
   *
   * @param {import('./memory/ams.js').ActiveMemorySet} ams
   * @param {string} [language]
   * @returns {string}
   */
  #renderAmsSnapshot(ams, language = 'en') {
    const snap = ams.snapshot();
    if (!snap) return '';
    const parts = [];
    if (snap.resident.length === 0 && snap.recent.length === 0 && snap.onDemand.length === 0) {
      return '';
    }
    const zh = isZhRuntimeLanguage(language);
    parts.push(zh ? '## 活跃记忆集' : '## Active Memory Set');
    parts.push(zh
      ? '以下记忆按当前用户语言呈现；如果个别历史摘要仍是其他语言，请只把它当作事实来源，回答和新增记忆应使用中文。'
      : 'Memory is presented for the current user language; if an older summary is in another language, treat it as factual context and continue in English.');
    if (snap.resident.length > 0) {
      parts.push(zh ? '### 常驻记忆' : '### Resident');
      for (const r of snap.resident) {
        parts.push(`- **${r.scope}**: ${r.summary}`);
      }
    }
    if (snap.recent.length > 0) {
      parts.push(zh ? '### 最近记忆' : '### Recent');
      for (const s of snap.recent) {
        parts.push(`- (${s.scope}) ${(s.body || '').trim()}`);
      }
    }
    if (snap.onDemand.length > 0) {
      parts.push(zh ? '### 按需记忆' : '### OnDemand');
      for (const s of snap.onDemand) {
        parts.push(`- (${s.scope}) ${(s.body || '').trim()}`);
      }
    }
    return parts.join('\n');
  }

  /**
   * Post-turn AMS correction. Decides whether to run via
   * `shouldRunAdjust`, then drives the LLM round-trip through
   * `runAdjust`. Persists the AMS to disk if membership changed.
   *
   * Failure here is intentionally swallowed — adjust is a best-effort
   * memory-quality step; a parse failure or LLM blip should never
   * surface as a turn failure.
   *
   * @param {{
   *   amsContext: { ams: import('./memory/ams.js').ActiveMemorySet, sessionKey: string, ownVpId: string|null, scopes: string[] }|null,
   *   userMsg: string,
   *   assistantReply: string,
   *   turnTokenUsage: number,
   * }} args
   * @returns {Promise<{ ran: boolean, added: number, evicted: number, reason: string } | null>}
   */
  async #runAdjustHook(args) {
    const ctx = args.amsContext;
    if (!ctx || !this.#amsRegistry || !this.#memoryIndex) return null;
    const totalBudget = ctx.ams.budget?.total || 0;
    if (!totalBudget) return null;

    const adjustRanThisSession = this.#adjustRanBySession.get(ctx.sessionKey) === true;
    try {
      const result = await runAdjust({
        trigger: {
          turnTokenUsage: args.turnTokenUsage,
          totalBudget,
          adjustRanThisSession,
        },
        ams: ctx.ams,
        index: this.#memoryIndex,
        scopes: ctx.scopes,
        ownVpId: ctx.ownVpId,
        userMsg: args.userMsg,
        assistantReply: args.assistantReply,
        runLLM: async (prompt) => {
          const out = await this.#adapter.call({
            model: this.#fastConfig.model,
            system: (String(this.#config?.language || '').toLowerCase().startsWith('zh')
          ? '你是记忆管理子程序。请按要求只回复一个 JSON 对象，不要输出额外说明。'
          : 'You are a memory-management subroutine. Reply with a single JSON object as instructed.'),
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 1024,
          });
          return out?.text || '';
        },
      });
      if (result?.ran) {
        this.#adjustRanBySession.set(ctx.sessionKey, true);
        // Always persist when we ran — even with no membership change,
        // the adjustRanThisSession bit is part of the on-disk state we
        // want to preserve.
        this.#amsRegistry.markDirty(ctx.sessionKey);
        this.#amsRegistry.persist(ctx.sessionKey, {
          adjustRanThisSession: true,
        });
      }
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Build the system prompt with the AMS-rendered Memory block, the
   * Active Scope block, and skill content. The legacy multi-path
   * Memory injection (FTS-formatted + AMS snapshot + Layer-A summaries +
   * userProfile + coreMemory) was retired in DESIGN-PROMPT v1; callers
   * now thread a single `memoryInjection` string composed upstream from
   * the AMS snapshot.
   *
   * Routes through `buildWorkerPrompt`, which:
   *   - Lays in the persona-as-identity block (or Yeaft identity fallback)
   *   - Adds the Memory section (passed in as `memoryInjection`)
   *   - Adds the structured Active Scope block (`activeScope`)
   *   - Forwards optional `taskCtx` for the legacy task-context sub-block
   *
   * @param {object} args
   * @param {string} args.prompt — user prompt (for skill relevance matching)
   * @param {string} args.memoryInjection — prebuilt Memory block from AMS
   * @param {object} [args.vpPersona]
   * @param {object} [args.activeScope] — DESIGN-PROMPT §3 ④ structured scope summary
   * @param {string} [args.sessionAnnouncement]
   * @param {string} [args.projectDoc] — resolved CLAUDE.md / AGENTS.md text (already truncated)
   * @param {object} [args.taskCtx] — legacy task-context sub-block (optional)
   * @returns {string}
   */
  #buildSystemPrompt({ prompt, memoryInjection, vpPersona, activeScope, sessionAnnouncement, projectDoc, taskCtx } = {}) {
    // Get relevant skill content if SkillManager is wired
    let skillContent = '';
    if (this.#skillManager && prompt) {
      skillContent = this.#skillManager.getRelevantPromptContent(prompt);
    }

    // Get tool names from the appropriate source
    const toolNames = this.#toolRegistry
      ? this.#toolRegistry.getToolNames()
      : Array.from(this.#tools.keys());

    return buildWorkerPrompt({
      language: this.#config.language || 'en',
      toolNames,
      memoryInjection,
      skillContent,
      vpPersona,
      activeScope,
      sessionAnnouncement,
      projectDoc,
      taskCtx,
      // Worker-shape harness is descriptive metadata for human inspection;
      // production prompts skip it to save tokens. Re-enable via env when
      // diagnosing prompt structure issues.
      includeShape: process.env.YEAFT_PROMPT_INCLUDE_SHAPE === '1',
    });
  }

  /**
   * Resolve the CLAUDE.md / AGENTS.md project doc text for the current
   * group's working directory. mtime-cached on the engine so we only
   * re-read the file when the user actually edited it.
   *
   * Cache strategy:
   *   1. Cheap path: `pickProjectDocFile` (two stats, no read).
   *   2. If the picked `(path, mtimeMs)` matches the cache → return
   *      cached text. No disk read, no UTF-8 decode, no truncation work.
   *   3. Cache miss → call `readProjectDoc` (bounded `readSync` into a
   *      pre-sized buffer), refresh the cache, return the fresh text.
   *
   * Returns '' when:
   *   - workDir is empty / not a string
   *   - config.projectDocMaxBytes === 0 (feature disabled)
   *   - neither CLAUDE.md nor AGENTS.md exists in workDir
   *   - the picked file is empty after trim
   *
   * @param {string|undefined} workDir
   * @returns {string}
   */
  #getProjectDocBlock(workDir) {
    if (typeof workDir !== 'string' || !workDir.trim()) {
      this.#projectDocCache = null;
      return '';
    }
    const maxBytes = Number.isFinite(this.#config?.projectDocMaxBytes)
      ? this.#config.projectDocMaxBytes
      : DEFAULT_PROJECT_DOC_MAX_BYTES;
    if (maxBytes === 0) {
      this.#projectDocCache = null;
      return '';
    }

    // Step 1 — stat-only check. Cheap (two `statSync` calls) and lets
    // us short-circuit the read when the file hasn't moved.
    const picked = pickProjectDocFile(workDir);
    if (!picked) {
      this.#projectDocCache = null;
      return '';
    }

    // Step 2 — cache hit? Same workDir, same picked file, same mtime
    // ⇒ the previously decoded text is still authoritative. Skip the
    // file read entirely.
    const cache = this.#projectDocCache;
    if (
      cache
      && cache.workDir === workDir
      && cache.path === picked.path
      && cache.mtimeMs === picked.mtimeMs
    ) {
      return cache.text;
    }

    // Step 3 — cache miss. Read + decode, then refresh the cache.
    const doc = readProjectDoc(workDir, { maxBytes });
    if (!doc) {
      this.#projectDocCache = null;
      return '';
    }
    this.#projectDocCache = {
      workDir,
      path: doc.path,
      mtimeMs: doc.mtimeMs,
      text: doc.text,
    };
    return doc.text;
  }

  /**
   * Build the full tool context for Phase 5 tools.
   *
   * @param {AbortSignal} [signal]
   * @returns {object}
   */
  #buildToolContext(signal, vpCtx) {
    return {
      signal,
      yeaftDir: this.#yeaftDir,
      // Group-scoped working directory. Threaded from #runQuery({ workDir })
      // → set by web-bridge runVpTurn from sessionMeta.workDir. Tools read
      // `ctx.cwd` and resolve relative paths against it. Always absolute
      // (path.resolve normalizes relative inputs + trailing slashes) so
      // tools that string-concatenate don't accidentally walk from
      // process.cwd(). Falls back to process.cwd() in non-group / test
      // contexts.
      cwd: (() => {
        const raw = typeof vpCtx?.workDir === 'string' ? vpCtx.workDir.trim() : '';
        return raw ? resolvePath(raw) : process.cwd();
      })(),
      mcpManager: this.#mcpManager,
      skillManager: this.#skillManager,
      conversationStore: this.#conversationStore,
      adapter: this.#adapter,
      config: this.#config,
      // task-704b: per-tool-result hard cap derives from this. Threaded
      // from the live model (resolveModel(currentModel)) every turn so
      // fallbackModel switches see the new window. Falls back to
      // config.maxContextTokens, then 200K, in registry.js.
      contextWindow: vpCtx?.contextWindow,
      // ViewImage (task-333b PR-B rev-3 P1-A): expose size cap + allowlist
      // via tool ctx so hosts can override via ~/.yeaft/config.json without
      // touching the tool impl.
      maxImageBytes: this.#config?.yeaft?.maxImageBytes,
      imageAllowlist: Array.isArray(this.#config?.yeaft?.imageAllowlist)
        ? this.#config.yeaft.imageAllowlist
        : [],
      // Bug 4 fix — VP / routing context for RouteForward (and any other
      // VP-aware tool). Undefined when running in non-group / no-VP flows.
      router: vpCtx?.router,
      senderVpId: vpCtx?.senderVpId,
      // Active VP persona — surfaced so tools like `StartPlan` can read
      // the optional `planInstruction` override without re-reading
      // role.md. Mirrors the symmetry already present in
      // `parentEngineDeps.parentVpPersona` below — sub-agents inherit it
      // through the parent deps; tools at this level read it directly.
      // Null in non-VP / test contexts.
      vpPersona: vpCtx?.vpPersona || null,
      inboundEnvelope: vpCtx?.inboundEnvelope,
      taskId: vpCtx?.taskId,
      taskMembers: vpCtx?.taskMembers,
      // TodoWrite per-VP cache hooks. Threaded from web-bridge so each
      // VP keeps its own todo list (see todo-write.js, web-bridge.js).
      // Null in non-VP / test contexts — tools tolerate missing slots.
      getCurrentTodos: vpCtx?.getCurrentTodos || null,
      setCurrentTodos: vpCtx?.setCurrentTodos || null,
      // task-707: tool-callable end-turn signal. The engine threads this
      // setter when constructing toolCtx so a tool (e.g. route_forward)
      // can mark "after this batch, end the turn — do NOT call adapter
      // again". Honored at the top of the tool-loop continuation.
      requestEndTurn: vpCtx?.requestEndTurn,
      // Sub-agent plumbing — Agent tool needs these to spawn a child
      // Engine that inherits the parent's adapter / stores / toolset.
      parentEngineDeps: {
        adapter: this.#adapter,
        trace: this.#trace,
        config: this.#config,
        parentToolRegistry: this.#toolRegistry,
        skillManager: this.#skillManager,
        mcpManager: this.#mcpManager,
        yeaftDir: this.#yeaftDir,
        parentName: vpCtx?.senderVpId || 'parent',
        parentVpId: vpCtx?.senderVpId || null,
        parentVpPersona: vpCtx?.vpPersona || null,
        parentSessionId: vpCtx?.sessionId || null,
        onEvent: this.#subAgentEventSink || null,
        language: this.#config?.language || 'en',
        // Forward the session-shared ToolUsageStats so sub-agent
        // engines record tool calls into the same on-disk snapshot
        // (~/.yeaft/stats/tool-usage.json) the parent engine writes
        // to. Null when the parent has no stats wired (e.g. tests).
        toolStats: this.#toolStats || null,
      },
    };
  }

  /**
   * Set a sub-agent event sink. Called by web-bridge so every event
   * yielded by a sub-engine gets surfaced to the frontend tagged with
   * the parent's conversation/turn so the UI can render it inside the
   * spawning sub-agent card.
   *
   * @param {(agentId: string, evt: object) => void} sink
   */
  setSubAgentEventSink(sink) {
    this.#subAgentEventSink = typeof sink === 'function' ? sink : null;
  }

  /**
   * Perform memory recall for a given prompt.
   *
   * Single path (GC.1 follow-up): SQLite FTS5 pre-flow via
   * `groups/pre-flow.js` → `memory/preflow.js`. When the index isn't
   * wired (e.g. read-only sessions or pre-FTS yeaft dirs) recall is
   * skipped and an empty memory shape is returned — engine continues
   * without injection.
   *
   * @param {string} prompt
   * @param {{ sessionId?: string, vpId?: string }} [ctx]
   * @returns {Promise<{ profile: string, entries: object[], formatted: string }|null>}
   */
  async #recallMemory(prompt, ctx = {}) {
    const memory = { profile: '', entries: [], formatted: '' };
    if (!this.#memoryIndex) return memory;
    try {
      const result = runMemoryPreflow(this.#memoryIndex, {
        userMsg: prompt,
        sessionId: ctx.sessionId,
        chatId: ctx.chatId || this.#chatId,
        vpId: ctx.vpId,
      });
      memory.profile = result.profile || '';
      memory.entries = result.entries || [];
      memory.formatted = result.formatted || '';
    } catch {
      // Fail soft — empty injection.
    }
    return memory;
  }

  /**
   * Read compact summary from conversation store.
   *
   * @returns {string}
   */
  #getCompactSummary() {
    if (!this.#conversationStore) return '';
    // Per-(group, vp) scoping: when this engine is bound to a fan-out VP,
    // read ONLY its own summary file. Falling back to legacy compact.md here
    // leaks another group/VP's summary into every new group turn after one
    // post-turn compact writes the session-global file.
    if (this.#chatId && this.#vpId
        && typeof this.#conversationStore.readCompactSummaryForChat === 'function') {
      return this.#conversationStore.readCompactSummaryForChat(this.#chatId, this.#vpId);
    }
    if (this.#sessionId && this.#vpId
        && typeof this.#conversationStore.readCompactSummaryFor === 'function') {
      return this.#conversationStore.readCompactSummaryFor(this.#sessionId, this.#vpId);
    }
    return this.#conversationStore.readCompactSummary();
  }

  /**
   * Persist user message and assistant response to conversation store.
   * Skipped in read-only mode (config._readOnly).
   *
   * Multi-VP fan-out (Bug 1): when several engines run the same user
   * prompt in parallel, we must NOT each write our own copy of the user
   * message — `coord.ingest`/the orchestrator already wrote it once. Pass
   * `userAlreadyPersisted: true` from the caller to skip the user-row
   * append while still persisting the assistant + tool rows.
   *
   * @param {string} userContent
   * @param {string} assistantContent
   * @param {object[]} [toolCalls]
   * @param {string} [sessionId]
   * @param {boolean} [userAlreadyPersisted]
   */
  #persistMessages(userContent, assistantContent, toolCalls, sessionId, userAlreadyPersisted = false) {
    if (!this.#conversationStore) return;
    if (this.#config._readOnly) return;

    // Persist with the active runtime thread. Legacy / non-group flows use
    // MAIN_THREAD_ID; group VP flows pass their classified threadId.
    const threadId = this.#currentThreadId || MAIN_THREAD_ID;

    // Persist user message — unless an upstream caller (e.g. the group
    // coordinator) has already done so for this turn.
    if (!userAlreadyPersisted) {
      this.#conversationStore.append({
        role: 'user',
        content: userContent,
        threadId,
        // Bug 6: stamp sessionId/chatId so history replay can route by container.
        ...(sessionId ? { sessionId } : {}),
        ...(this.#chatId ? { chatId: this.#chatId } : {}),
      });
    }

    // Persist assistant message
    const assistantMsg = {
      role: 'assistant',
      content: assistantContent,
      model: this.#config.model,
      threadId,
      ...(sessionId ? { sessionId } : {}),
      ...(this.#chatId ? { chatId: this.#chatId } : {}),
    };
    if (toolCalls && toolCalls.length > 0) {
      assistantMsg.toolCalls = toolCalls;
    }
    this.#conversationStore.append(assistantMsg);
  }

  /**
   * Check and trigger consolidation if needed.
   * Skipped in read-only mode.
   *
   * @returns {Promise<{ archivedCount: number, extractedCount: number }|null>}
   */
  async #maybeConsolidate() {
    if (!this.#conversationStore) return null;
    if (this.#config._readOnly) return null;

    const budget = this.#config.messageTokenBudget || 32768;
    const compactCfg = (this.#config && this.#config.compact) || {};
    return this.#runOrchestratorCompact(budget, compactCfg);
  }

  /**
   * Run compact via the orchestrator (DESIGN §4.2).
   *
   * PR-B rip: the legacy entries-based extract hook is gone — Dream V2
   * owns durable memory extraction now. The orchestrator runs Track 1
   * (compaction + summary) and Track 2 (task summary refresh, when wired);
   * Track 3 (extract) is intentionally omitted.
   *
   * @param {number} budget
   * @param {object} compactCfg
   * @returns {Promise<{archivedCount:number, extractedCount:number}|null>}
   */
  async #runOrchestratorCompact(budget, _compactCfg) {
    const conversationStore = this.#conversationStore;
    const adapter = this.#adapter;
    const fastConfig = this.#fastConfig;

    // Per-(group, vp) scoping: when this engine is bound to a fan-out VP
    // (the common case in group mode), load only the rows THIS VP saw in
    // its context — user prompts + every VP's assistant text, with other
    // VPs' tool calls/results stripped (see persist.loadSessionHistoryForVp).
    //
    // Legacy / sub-agent callers (no sessionId/vpId pair) keep the global
    // loadAll() behaviour so we don't break those flows.
    let messages;
    const scopedChat = !!(this.#chatId && this.#vpId
      && typeof conversationStore.loadChatHistoryForVp === 'function');
    const scoped = !scopedChat && !!(this.#sessionId && this.#vpId
      && typeof conversationStore.loadSessionHistoryForVp === 'function');
    try {
      messages = scopedChat
        ? conversationStore.loadChatHistoryForVp(this.#chatId, this.#vpId)
        : scoped
          ? conversationStore.loadSessionHistoryForVp(this.#sessionId, this.#vpId)
          : conversationStore.loadAll();
    } catch { return null; }
    if (!Array.isArray(messages) || messages.length === 0) return null;

    const tokenCount = conversationStore.hotTokens();
    // In the scoped path, sessionId is the engine's binding (authoritative).
    // In the legacy path, fall back to scanning the messages (best-effort,
    // used only for the group context-window gate).
    const sessionId = this.#sessionId
      || messages.find(m => m && typeof m.sessionId === 'string' && m.sessionId)?.sessionId
      || null;
    const groupContextGate = shouldAllowGroupReflection({
      system: '',
      messages,
      model: this.#config.model,
      config: this.#config,
      sessionId,
    });
    if (sessionId && groupContextGate?.usedFallbackContextWindow) {
      this.#trace.log?.('group_context_window_fallback', {
        sessionId,
        model: this.#config.model,
        contextWindow: groupContextGate.contextWindow,
        threshold: groupContextGate.threshold,
      });
    }
    if (sessionId && !groupContextGate.compactAllowed) return null;

    const trig = evaluateCompactTriggers({
      messages,
      tokenCount,
      contextLimit: this.#config.maxContextTokens || 200000,
      tokenRatio: sessionId ? GROUP_CONTEXT_PRESSURE_RATIO : undefined,
      maxMessages: sessionId ? Number.POSITIVE_INFINITY : undefined,
    });
    if (!trig.trigger) return null;

    // Use partitionMessages to decide what is "cooling": orchestrator's
    // own keepHot is a count, but we want to honour the token-budget
    // partitioning the rest of the system uses.
    const { toArchive } = partitionMessages(messages, budget);
    if (toArchive.length === 0) return null;

    const archiveIds = [];

    // Language-aware summarizer prompts. The orchestrator-track summary
    // ends up in the system prompt as a "previous conversation summary"
    // block, so it needs to match the user's preferred language to avoid
    // a jarring locale flip mid-context.
    const isZh = String(this.#config.language || '').toLowerCase().startsWith('zh');
    const summariserSystem = isZh
      ? '你是对话摘要器。下面包含「先前累计摘要」（可能为空）与「新待压缩对话」。请融合两者，输出一份「重写后的累计摘要」——不要分段罗列日期、不要保留 "## 2026-..." 等历史分节，直接产出一份连贯、可被下一轮直接重新注入 prompt 的摘要。保留关键决策、事实、上下文与人物意图。'
      : 'You are a conversation summarizer. The input contains a "previous cumulative summary" (may be empty) plus a "new conversation to absorb". Merge them into ONE rewritten cumulative summary — do NOT keep dated section headers or any historical log structure. Output a single coherent summary suitable to be re-injected into the next turn\'s prompt as-is. Preserve key decisions, facts, context, and intent.';
    const summariserPromptPrefix = isZh ? '请概括：\n\n' : 'Summarize:\n\n';

    const hooks = {
      summarise: async () => {
        try {
          // Read prior summary at call time, not at orchestrator setup,
          // so the merge always sees the freshest on-disk state even if
          // future orchestrator changes invoke summarise more than once.
          const priorSummary = this.#getCompactSummary() || '';
          const priorBlock = priorSummary
            ? (isZh
                ? `【先前累计摘要】\n${priorSummary}\n\n【新待压缩对话】\n`
                : `[Previous cumulative summary]\n${priorSummary}\n\n[New conversation to absorb]\n`)
            : '';
          const result = await adapter.call({
            model: fastConfig.model,
            system: summariserSystem,
            messages: [{ role: 'user', content: `${summariserPromptPrefix}${priorBlock}${toArchive.map(m => `[${m.role}] ${(m.content || '').slice(0, 500)}`).join('\n\n')}` }],
            // 10k output budget: the running summary is the engine's
            // long-term memory of cold turns, so it deserves room to
            // actually preserve detail. We rewrite-in-place each round,
            // so size stays bounded by maxTokens regardless of how many
            // compact passes have run.
            maxTokens: 10240,
          });
          return (result.text || '').trim();
        } catch {
          return '';
        }
      },
      archive: async (_groupIdx, groupMsgs) => {
        // Only collect archive ids when we'll actually use them. In the
        // scoped (per-VP) path we never call moveToColdBatch — those
        // rows are shared with sibling VPs in this group — so leaving
        // the push in would be dead state a future reader has to chase.
        if (!scoped) {
          for (const m of groupMsgs) if (m.id) archiveIds.push(m.id);
        }
        const turnId = groupMsgs[0]?.id || `g_${Date.now()}`;
        if (this.#yeaftDir) {
          try {
            await archiveTurn({
              root: `${this.#yeaftDir}/memory`,
              scopeDir: 'user',
              turnId,
              messages: groupMsgs,
            });
          } catch { /* best-effort */ }
        }
        return { turnId };
      },
    };

    try {
      const out = await runCompactOrchestrator({
        messages, keepHot: 10, hooks,
      });
      // Scoped path (per-(group, vp)): do NOT moveToColdBatch — those
      // archive ids include user rows and other VPs' assistant rows that
      // sibling VPs in this group still need in their hot context. The
      // per-VP summary written below is the durable win; physical
      // cold-archival across shared rows is the dream-level orchestrator's
      // job, not post-turn compact's.
      if (!scoped && !scopedChat && archiveIds.length > 0) {
        conversationStore.moveToColdBatch(archiveIds);
      }
      if (out.compactSummary) {
        if (scopedChat && typeof conversationStore.replaceCompactSummaryForChat === 'function') {
          conversationStore.replaceCompactSummaryForChat(this.#chatId, this.#vpId, out.compactSummary);
        } else if (scoped && typeof conversationStore.replaceCompactSummaryFor === 'function') {
          conversationStore.replaceCompactSummaryFor(this.#sessionId, this.#vpId, out.compactSummary);
        } else {
          conversationStore.replaceCompactSummary(out.compactSummary);
        }
      }
      // Index update only makes sense for the legacy path that actually
      // moved rows to cold. In the scoped path, nothing on disk changed.
      if (!scoped) {
        const lastKept = messages[messages.length - 1];
        conversationStore.updateIndex({ lastMessageId: lastKept?.id || null });
      }

      return {
        archivedCount: out.archivedMessages,
        extractedCount: out.extractedCount,
      };
    } catch {
      return null;
    }
  }

  #drainPendingUserMessages(drainPendingUserMessages) {
    const pending = [];
    if (typeof drainPendingUserMessages === 'function') {
      try {
        const drained = drainPendingUserMessages();
        if (Array.isArray(drained)) pending.push(...drained);
      } catch {
        // Best-effort hook; a bad bridge callback must not kill the engine loop.
      }
    }
    if (this.#pendingUserMessages.length > 0) {
      pending.push(...this.#pendingUserMessages.splice(0));
    }
    return pending
      .map((item) => {
        if (typeof item === 'string') return { content: item, preview: item };
        if (!item || typeof item !== 'object') return null;
        const content = item.content ?? item.text;
        if (typeof content !== 'string' && !Array.isArray(content)) return null;
        const preview = typeof item.preview === 'string'
          ? item.preview
          : (typeof content === 'string' ? content : '[content blocks]');
        return { content, preview };
      })
      .filter(Boolean);
  }

  /**
   * Run a query — the main loop.
   *
   * Yields EngineEvent objects that the caller (CLI, web) can consume
   * to render output in real-time.
   *
   * @param {object} params
   * @param {string} params.prompt - The user prompt (required, non-empty).
   * @param {Array} [params.messages] - Prior conversation messages.
   * @param {AbortSignal} [params.signal] - Abort signal.
   * @param {'low'|'medium'|'high'|'max'|null} [params.userEffort] -
   *   task-327b: explicit per-query effort override (from Settings or
   *   API caller). `/max`/`/high`/`/medium`/`/low` prefixes in prompt
   *   also set this. Null/invalid → scenario decision tree decides.
   * @param {string} [params.scenario='chat'] - task-327b: scenario tag
   *   forwarded to the effort decision tree. See effort.js
   *   SCENARIO_EFFORT. Unknown values fall through to 'high'.
   * @param {Array<{type:string, source?:object, text?:string}>} [params.promptParts] -
   *   PR #721: optional content-array form of the user message used
   *   when attachments are present. Each entry is either an
   *   `{type:'image', source:{type:'base64', media_type, data}}` block
   *   (one per uploaded image) or a `{type:'text', text}` block (the
   *   text prompt body, including any [Uploaded files] suffix). When
   *   supplied and non-empty, the LLM call uses this array as the
   *   user-message content; the string `prompt` is then only used for
   *   logging / history. When omitted the engine falls back to the
   *   string-prompt shape (no regression for existing callers).
   * @yields {EngineEvent}
   */
  async *query({ prompt, promptParts = null, messages = [], signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, sessionId, sessionMembers, sessionTopics = null, vpPlan, sessionAnnouncement, workDir, userAlreadyPersisted = false, getCurrentTodos = null, setCurrentTodos = null, threadId = MAIN_THREAD_ID, drainPendingUserMessages = null, collabToolPolicy = null } = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      yield {
        type: 'error',
        error: new Error('prompt is required and must be a non-empty string'),
        retryable: false,
      };
      return;
    }
    // promptParts (optional): a content-array form of the user message
    // (e.g. [{type:'image',source:{...}}, {type:'text',text:'@vp-x ...'}]).
    // When supplied, it REPLACES the trailing `{role:'user',content:prompt}`
    // entry built into conversationMessages — the string `prompt` is still
    // used for memory recall, system prompt rendering, and turn previews
    // because those layers all need plain text. Adapter side already
    // accepts content arrays for user messages (anthropic.js:72,
    // openai-responses.js:#translateUserContent).

    // task-327b: `/max` / `/high` / `/medium` / `/low` prefix override.
    // Explicit caller-supplied userEffort wins over the prefix.
    // task-327c nit: defensively normalize caller-supplied userEffort BEFORE
    // the merge, so an invalid caller value (e.g. 'ULTRA') does not shadow a
    // valid prompt prefix.
    const parsed = parseEffortPrefix(prompt);
    const effectivePrompt = parsed.cleanedPrompt;
    const effectiveUserEffort = normalizeEffort(userEffort) || parsed.effort || null;
    const effectiveCollabToolPolicy = collabToolPolicy === COLLAB_TOOL_POLICY.SINGLE_VP || collabToolPolicy === COLLAB_TOOL_POLICY.MULTI_VP
      ? collabToolPolicy
      : null;

    // ─── task-325a: engine-owned AbortController ─────────────
    // We create our own controller for this query run so `engine.abort()`
    // can trigger cancellation without requiring the caller to hand in a
    // signal. If the caller DID provide a signal, we mirror its state onto
    // our controller (honouring both entry points). The linked signal
    // forwarded to the adapter/tools is always `abortCtrl.signal`, so
    // there is exactly one place that actually stops work in flight.
    const abortCtrl = new AbortController();
    this.#currentAbortCtrl = abortCtrl;
    this.#abortReason = null;

    const onExternalAbort = () => {
      if (!abortCtrl.signal.aborted) {
        // Tag the reason so the emitted `aborted` event reflects the
        // external trigger. Callers that pass a signal without invoking
        // engine.abort() get the neutral tag 'external'.
        if (!this.#abortReason) this.#abortReason = 'external';
        try { abortCtrl.abort(); } catch { /* ignore */ }
      }
    };
    if (signal) {
      if (signal.aborted) {
        this.#abortReason = 'external';
        try { abortCtrl.abort(); } catch { /* ignore */ }
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    // The signal passed down to adapter.stream() + tool execution.
    const runSignal = abortCtrl.signal;

    try {
      this.#currentThreadId = threadId || MAIN_THREAD_ID;
      yield* this.#runQuery({ prompt: effectivePrompt, promptParts, messages, signal: runSignal, userEffort: effectiveUserEffort, scenario, vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, sessionId, sessionMembers, sessionTopics, vpPlan, sessionAnnouncement, workDir, userAlreadyPersisted, getCurrentTodos, setCurrentTodos, threadId: this.#currentThreadId, drainPendingUserMessages, collabToolPolicy: effectiveCollabToolPolicy });
    } finally {
      if (signal) {
        try { signal.removeEventListener('abort', onExternalAbort); } catch { /* ignore */ }
      }
      // Clear current-run state so engine.isRunning flips back to false
      // and a subsequent query() starts with a clean slate.
      this.#currentAbortCtrl = null;
      this.#abortReason = null;
      this.#currentThreadId = MAIN_THREAD_ID;
      this.#pendingUserMessages.length = 0;
    }
  }

  /**
   * Internal: the original query loop body. Split out of `query()` so the
   * public method can own the per-run AbortController + abort lifecycle
   * in a try/finally without indenting the whole loop.
   * @private
   */
  async *#runQuery({ prompt, promptParts = null, messages, signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, sessionId, sessionMembers, sessionTopics = null, vpPlan, sessionAnnouncement, workDir, userAlreadyPersisted = false, getCurrentTodos = null, setCurrentTodos = null, threadId = MAIN_THREAD_ID, drainPendingUserMessages = null, collabToolPolicy = null }) {

    const effectiveCollabToolPolicy = collabToolPolicy === COLLAB_TOOL_POLICY.SINGLE_VP || collabToolPolicy === COLLAB_TOOL_POLICY.MULTI_VP
      ? collabToolPolicy
      : null;
    const runtimeSessionId = (typeof sessionId === 'string' && sessionId.trim())
      ? sessionId.trim()
      : this.#sessionId;
    const runtimeThreadId = (typeof threadId === 'string' && threadId.trim())
      ? threadId.trim()
      : MAIN_THREAD_ID;

    // ─── Pre-query: FTS5 Memory Recall + AMS snapshot ─────
    // Memory has a SINGLE render outlet now (DESIGN-PROMPT §3 ③):
    //   1. FTS5 pre-flow recall produces a list of segments;
    //   2. those segments are pushed into AMS OnDemand;
    //   3. AMS renders a budget-aware snapshot (Resident + Recent +
    //      OnDemand) — that snapshot IS `memoryInjection`.
    // The legacy second path (`recallResult.formatted` concatenated
    // directly into `memoryInjection`) was a duplicate render of the
    // same segments AMS would also surface, so it's gone.
    let memoryInjection = '';
    let recallEntryCount = 0;

    const recallResult = await this.#recallMemory(prompt, {
      sessionId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
    });
    recallEntryCount = recallResult && Array.isArray(recallResult.entries)
      ? recallResult.entries.length
      : 0;
    if (recallEntryCount > 0) {
      yield { type: 'recall', entryCount: recallEntryCount, cached: false, threadId };
    }

    // Layer-A summaries — same scopes AMS Resident will surface, loaded
    // here so we can pass them into #prepareAms. (Rolling per-scope
    // synopsis maintained by the dream tick.) Failures are non-fatal.
    const summaries = await this.#loadLayerASummaries({
      sessionId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
      language: this.#config.language || 'en',
    });

    // ─── AMS: populate + snapshot ───────────────────────────────
    // Group-keyed and persisted across session deactivation. Each turn:
    //   (a) resident layer is rebuilt from <scope>/summary.md;
    //   (b) onDemand is replaced with this turn's FTS hits;
    //   (c) we render a budget-aware snapshot block — this is the SOLE
    //       Memory section in the system prompt. Adjust runs post-turn
    //       (see end_turn below).
    const ownVpIdForAms = vpPersona && typeof vpPersona === 'object'
      && typeof vpPersona.vpId === 'string'
      ? vpPersona.vpId
      : (typeof senderVpId === 'string' ? senderVpId : null);
    const amsContext = this.#prepareAms({
      sessionId,
      ownVpId: ownVpIdForAms,
      summaries,
      recallEntries: recallResult ? (recallResult.entries || []) : [],
    });
    if (amsContext && amsContext.snapshotBlock) {
      memoryInjection = amsContext.snapshotBlock;
    }

    // Diagnostic payload for the Dream debug panel. The full AMS Resident
    // layer can include user and per-VP summaries, but the browser-facing
    // Dream prompt-load view only needs to prove the active session Dream
    // summary entered `system_prompt.memory`. Keep the payload scoped to the
    // exact session resident to avoid leaking unrelated resident summaries into
    // frontend state. The full system prompt remains visible in the existing
    // debug-only system-prompt panel.
    const activeGroupDreamScope = sessionId ? `sessions/${sessionId}` : null;
    const dreamResidentLoaded = amsContext && Array.isArray(amsContext.residentEntries)
      ? amsContext.residentEntries
        .filter(e => e && e.scope === activeGroupDreamScope && e.summary)
        .map(e => ({
          scope: e.scope,
          summary: String(e.summary).slice(0, 4000),
          truncated: String(e.summary).length > 4000,
          source: 'resident-summary',
        }))
      : [];

    // ─── Active Scope (DESIGN-PROMPT §3 ④) ──────────────────────
    // Structured per-turn scope summary: session + vp + members + envelope routing
    // info. Long-form scope content lives in AMS — this block carries
    // only IDs + tiny labels. (Feature scope retired 2026-05-13.)
    const activeSessionTopics = Array.isArray(sessionTopics)
      ? sessionTopics
      : await this.#loadSessionTopicLabels(sessionId);
    const activeScope = {
      sessionId: sessionId || '',
      sessionMember: ownVpIdForAms || '',
      sessionMembers: Array.isArray(sessionMembers) ? sessionMembers : [],
      sessionTopics: activeSessionTopics,
      envelope: inboundEnvelope || null,
    };

    const projectDoc = this.#getProjectDocBlock(workDir);

    const systemPrompt = this.#buildSystemPrompt({
      prompt,
      memoryInjection,
      vpPersona,
      activeScope,
      sessionAnnouncement,
      projectDoc,
    });

    // ─── HARD INVARIANT: Compact ≠ Dream (read DESIGN-COMPACT-VS-DREAM.md) ─
    // Compact summary (this block) ONLY lands in the messages array head as
    // a `<conversation_summary>` user/assistant pair. It MUST NEVER appear
    // in the system prompt — that was the bug DESIGN-PROMPT §4.3 banned.
    //
    // Inversely: Dream V2's output (per-scope `memory.md` / `summary.md`)
    // flows exclusively through `prompts.js#buildSystemPrompt`'s §6 Memory
    // section via the AMS Resident layer (see `engine.js#buildResidentEntries`).
    // It MUST NEVER appear in the messages array.
    //
    // Two write roots, two scheduler triggers, two prompt slots — never
    // mixed. Anyone touching this section must read
    // `agent/yeaft/DESIGN-COMPACT-VS-DREAM.md` before changing the wiring;
    // the boundary has been violated twice in this codebase's history and
    // each time it took an LLM cache-thrash + persona-dup follow-up PR to
    // unwind.
    //
    // ─── Compact summary as messages-array head (DESIGN-PROMPT §4.3) ─
    // The previous code placed the compact summary inside the system
    // prompt; that broke prompt-cache hit-rate (any compact update
    // invalidated the entire system) and conflated identity/rules with
    // dialogue history. The compact summary is the product of compressing
    // older turns, so it belongs at the head of the messages array.
    //
    // Note: this is a separate mechanism from `history-compact.js`'s
    // `_compactSummary`-tagged user message. They never collide:
    //   • THIS path injects a `<conversation_summary>` pair on every
    //     query when conversationStore.readCompactSummary() returns text
    //     (i.e. when a previous T1 run wrote one to disk). Engine reads,
    //     does not produce.
    //   • history-compact.js#compactHistory rewrites the in-memory
    //     `messages` array, replacing cold messages with a single
    //     `_compactSummary`-tagged user message. That path runs at a
    //     different layer (web-bridge during a manual /compact) and never
    //     touches `compactMessages` here.
    // The two would only overlap if a tagged `_compactSummary` user
    // message also matched the `<conversation_summary>` template — they
    // don't, so duplication is impossible by construction.
    const compactSummaryRaw = this.#getCompactSummary();
    const compactSummary = typeof compactSummaryRaw === 'string'
      ? compactSummaryRaw.trim() : '';
    const compactMessages = compactSummary
      ? [
          { role: 'user', content: `<conversation_summary>\n${compactSummary}\n</conversation_summary>` },
          { role: 'assistant', content: 'Acknowledged.' },
        ]
      : [];

    // Build conversation: optional compact head + existing messages + new user message.
    // If `promptParts` was supplied (image/file attachments), use the array form
    // so the adapter sees image content blocks alongside the text. Otherwise the
    // legacy string form keeps prompt-cache behavior identical.
    //
    // Sub-agent re-entry: before constructing the user message, drain any
    // terminal sub-agent notifications that landed for this parent VP
    // while it was idle. If any are present we prepend an XML-tagged
    // block to the user prompt so the parent model sees the sub-agent
    // result(s) even if it forgot to call WaitAgent. See
    // sub-agent/notifications.js for the bucketing + format.
    const parentVpIdForNotif = (vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string')
      ? vpPersona.vpId
      : (typeof senderVpId === 'string' ? senderVpId : null);
    const isSubAgentTurn = !!(vpPersona && typeof vpPersona === 'object' && vpPersona.subAgent);
    const notifScope = {
      sessionId: runtimeSessionId,
      parentVpId: parentVpIdForNotif,
      threadId: runtimeThreadId,
    };
    const pendingSubAgentNotifs = isSubAgentTurn ? [] : peekPendingNotifications(notifScope);
    const subAgentNotifBlock = formatNotificationsForPrompt(pendingSubAgentNotifs);

    let finalUserContent;
    if (Array.isArray(promptParts) && promptParts.length > 0) {
      // Multimodal prompt — prepend the notification block as a leading
      // text part so the adapter still sees image content blocks intact.
      finalUserContent = subAgentNotifBlock
        ? [{ type: 'text', text: subAgentNotifBlock + '\n\n' }, ...promptParts]
        : promptParts;
    } else {
      finalUserContent = subAgentNotifBlock
        ? `${subAgentNotifBlock}\n\n${prompt || ''}`
        : prompt;
    }
    const conversationMessages = [
      ...compactMessages,
      ...messages,
      { role: 'user', content: finalUserContent },
    ];

    const groupReflectionGate = shouldAllowGroupReflection({
      system: systemPrompt,
      messages: conversationMessages,
      model: this.#config.model,
      config: this.#config,
      sessionId,
    });
    const groupReflectionAllowed = groupReflectionGate.allowed === true;
    if (sessionId && groupReflectionGate?.usedFallbackContextWindow) {
      this.#trace.log?.('group_context_window_fallback', {
        sessionId,
        model: this.#config.model,
        contextWindow: groupReflectionGate.contextWindow,
        threshold: groupReflectionGate.threshold,
      });
    }

    // PR-L: T2 carry-forward. If a previous query()'s end-of-turn
    // reflection has resolved, rewrite that turn's range in
    // `conversationMessages` to a single assistant reflection message.
    // If still pending, fall back to the exec-log stub — non-blocking,
    // never wait. This runs BEFORE the first adapter.stream so the
    // upcoming call sees the rewritten history. Group send defaults to no
    // reflection; only high context pressure (>=80% of model window)
    // enables the carry-forward rewrite.
    if (groupReflectionAllowed) {
      yield* this.#applyPendingT2Reflections(conversationMessages, prompt);
    }

    // PR-L: track this query()'s tool-arc for reflection.
    // `turnStartIdx` is where the current user message lives; the arc
    // we may collapse spans (arcStartIdx .. last assistant/tool).
    //
    // Periodic-T1 fix: T1 must fire EVERY TOOL_BATCH_SIZE (30) tool
    // calls, not just the first batch. So instead of a one-shot boolean,
    // track:
    //   • `lastT1AtToolCount` — toolCount snapshot at the last T1
    //     ATTEMPT (success OR error). Trigger when
    //     `queryToolCount - lastT1AtToolCount >= TOOL_BATCH_SIZE`.
    //   • `arcStartIdx` — first index of the current (uncollapsed)
    //     tool arc. Initialised to turnStartIdx + 1; reset after each
    //     successful T1 collapse to `conversationMessages.length`
    //     (i.e. the slot the next assistant message will land in).
    //   • `t1CollapsesDone` — count of T1 firings that ACTUALLY
    //     rewrote history. Distinct from `lastT1AtToolCount` because
    //     the catch block bumps the latter to back off after a
    //     transient reflector error WITHOUT having collapsed
    //     anything. The T2 schedule check below is gated on this
    //     counter (==0 means "no T1 ever rewrote the arc, T2 may
    //     fall back at end_turn").
    const turnStartIdx = conversationMessages.length - 1;
    let queryToolCount = 0;
    let lastT1AtToolCount = 0;
    let arcStartIdx = turnStartIdx + 1;
    let t1CollapsesDone = 0;
    const queryNumber = (this.#__queryCounter = (this.#__queryCounter || 0) + 1);

    // feat-6af5f9f1 PR B: a Turn = one user prompt + all AI responses.
    // `queryTurnId` is the wire-level turn identifier; every event emitted
    // during this query() carries it as `turnId`. Each LLM call inside
    // the loop is a `loopNumber` (was wire field `turnNumber`).
    const queryTurnId = randomUUID();
    const queryStartedAt = Date.now();
    const userQuestionPreview = String(prompt || '').slice(0, 200);
    const queryVpId = vpPersona && typeof vpPersona === 'object'
      && typeof vpPersona.vpId === 'string'
      ? vpPersona.vpId
      : (typeof senderVpId === 'string' ? senderVpId : null);

    yield {
      type: 'turn_open',
      turnId: queryTurnId,
      threadId,
      userPrompt: userQuestionPreview,
      vpId: queryVpId,
      sessionId: sessionId || null,
      at: queryStartedAt,
    };

    // Surface memory recall to the debug panel right after turn_open.
    // recallResult was loaded above; emit a structured `memory_used`
    // event so the UI can show "loaded N segments" without parsing
    // the legacy `recall` event (which only carried entryCount).
    if (recallResult && Array.isArray(recallResult.entries) && recallResult.entries.length > 0) {
      yield {
        type: 'memory_used',
        turnId: queryTurnId,
        loaded: recallResult.entries.map(e => ({
          id: e && e.id || null,
          score: e && typeof e.score === 'number' ? e.score : null,
          kind: e && e.kind || null,
        })),
      };
    }

    if (dreamResidentLoaded.length > 0) {
      yield {
        type: 'dream_memory_loaded',
        turnId: queryTurnId,
        vpId: queryVpId,
        sessionId: sessionId || null,
        loadedInto: 'system_prompt.memory',
        resident: dreamResidentLoaded,
      };
    }

    const toolDefs = this.#getToolDefs(effectiveCollabToolPolicy);
    let turnNumber = 0;
    let continueTurns = 0; // auto-continue counter
    let toolLoopTurns = 0; // task-327b: tool-use turns for long-loop auto-bump
    let fullResponseText = '';
    let currentModel = this.#config.model;
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    // task-707: tool-callable end-turn signal. Tools (currently only
    // `route_forward`) can set this via toolCtx.requestEndTurn(reason)
    // to break out of the tool-loop after the current batch finishes
    // — without invoking another adapter.stream(). Used to hand off
    // control to other VPs cleanly. Reset to null at the top of every
    // outer-loop iteration so the flag never carries across turns.
    let endTurnRequested = null;

    while (true) {
      turnNumber++;

      // task-324: no hard MAX_TURNS cap. Loop terminates on end_turn,
      // non-retryable error, LLMContextError (after compact retry), or
      // caller abort. Keeping this comment so the removal is traceable.

      // task-325a: check for user abort at the top of every turn so a
      // signal that fires between turns (e.g. during tool execution in
      // the previous iteration) cleanly ends the loop instead of
      // launching another adapter stream.
      if (signal?.aborted) {
        yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
        yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId };
        break;
      }

      const turnId = this.#trace.startTurn({
        traceId: this.#traceId,
        turnNumber,
        // fix-vp-multi-thread (bug 4): stamp routing context so the
        // debug-trace SQL row carries enough info to be filtered by
        // group / thread / VP later when the panel hydrates from disk.
        sessionId: sessionId || null,
        vpId: queryVpId || null,
        threadId: threadId || null,
        // Persist the user prompt EXPLICITLY rather than reconstruct it
        // post-hoc from `messages_json` — every tool-loop iteration
        // writes the *cumulative* messages array, so deriving the prompt
        // from `messages.find(role==='user')` would always return turn
        // 1's prompt and mislabel every subsequent Turn header.
        userPrompt: userQuestionPreview,
      });

      const startTime = Date.now();
      let ttfbMs = null;  // Time to first token
      let responseText = '';
      const toolCalls = [];
      const thinkingBlocks = []; // task-327d: collected from adapter for round-trip
      let stopReason = 'end_turn';
      const totalUsage = { inputTokens: 0, outputTokens: 0 };
      // task-344: capture redacted raw request / raw response for debug panel.
      let rawRequest = null;
      let rawResponse = null;
      const captureRawExchange = (exchange) => {
        if (exchange?.rawRequest) rawRequest = exchange.rawRequest;
        if (exchange?.rawResponse) rawResponse = exchange.rawResponse;
      };

      // task-704b: resolve the live model's context window for this turn.
      // Used by the per-tool-result cap (passed via toolCtx) and the
      // pre-flight total-token guard inside the try-block. Hoisted out of
      // the try so toolCtx (built after the adapter stream) can see it.
      // Re-resolved every turn because fallbackModel switches change
      // `currentModel` mid query() — the cap MUST track the model we're
      // actually about to call. Single resolver in models.js owns the
      // fallback ladder (registry → config → default) so engine.js and
      // tools/registry.js can never disagree.
      const currentContextWindow = resolveContextWindow(currentModel, this.#config);

      yield { type: 'turn_start', turnNumber, threadId };

      const appendedBeforeStream = this.#drainPendingUserMessages(drainPendingUserMessages);
      if (appendedBeforeStream.length > 0) {
        for (const item of appendedBeforeStream) {
          conversationMessages.push({ role: 'user', content: item.content });
          yield {
            type: 'user_append',
            turnId: queryTurnId,
            loopNumber: turnNumber,
            threadId,
            preview: String(item.preview || '').slice(0, 200),
          };
        }
      }

      try {
        // task-327b: resolve effort per-turn so the long-loop auto-bump
        // kicks in once toolLoopTurns crosses the threshold.
        let resolvedEffort = pickEffort({ scenario, toolLoopTurns, userEffort });

        // DESIGN.md §9.16: thinking-mode precedence chain. When a VP
        // persona is active, the router/continuity bookkeeping has more
        // signal than the raw scenario tag — the prior assistant turn's
        // routerPlan, the VP's role default, and the global config all
        // outrank the scenario picker for `'high'|'max'`. UI/userEffort
        // is already honoured by pickEffort (highest precedence).
        if (vpPersona && vpPersona.vpId) {
          const priorPlan = extractPriorPlan(conversationMessages, vpPersona.vpId);
          const thinkingCfg = (this.#config && this.#config.thinking) || {};
          // PR-I: live routerPlan.thinking — when the dispatcher passes
          // `vpPlan` for this turn (per-VP plan from the V2 router) and its
          // `vpId` matches the active persona, surface its `thinking` field
          // to resolveThinking. Mismatched vpId means the plan addresses a
          // different VP — ignore it for this VP's thinking decision.
          const liveRouterThinking = (vpPlan && typeof vpPlan === 'object'
            && typeof vpPlan.vpId === 'string' && vpPlan.vpId === vpPersona.vpId
            && (vpPlan.thinking === 'high' || vpPlan.thinking === 'max'))
            ? vpPlan.thinking
            : null;
          const resolved = resolveThinking({
            uiOverride: (userEffort === 'max' || userEffort === 'high') ? userEffort : null,
            routerPlan: liveRouterThinking,
            priorPlan: priorPlan && priorPlan.thinking ? priorPlan.thinking : null,
            vpDefault: typeof vpPersona.thinking === 'string' ? vpPersona.thinking : null,
            globalDefault: typeof thinkingCfg.default === 'string' ? thinkingCfg.default : null,
            allowRouterEscalate: thinkingCfg.allowRouterEscalate !== false,
          });
          // Only adopt the chain's choice when it strengthens the
          // baseline. We never weaken below pickEffort (e.g. consolidate
          // = 'max' must not be downgraded to 'high' just because the VP
          // default is 'high').
          if (resolved.value === 'max' || (resolved.value === 'high' && resolvedEffort === 'low')) {
            resolvedEffort = resolved.value;
          }
        }

        // Phase 8 PR-E: archive bulky tool results before they go on the
        // wire. archiveToolResults walks the messages array and replaces
        // any `role:'tool'` body older than turnAgeMin AND larger than
        // lengthMin with a small stub, persisting the original to
        // <yeaftDir>/memory/<scopeDir>/archive/tool-results/<id>.md so
        // message_trace can fetch it on demand. The stub keeps the
        // OpenAI/Anthropic toolCallId pairing intact.
        let wireMessages = stripMetaForWire([...conversationMessages]);

        if (this.#yeaftDir && (this.#config?.archive?.toolResults !== false)) {
          try {
            const swept = await archiveToolResults({
              root: `${this.#yeaftDir}/memory`,
              scopeDir: 'user',
              messages: wireMessages,
              turnAgeMin: this.#config?.archive?.turnAgeMin,
              lengthMin: this.#config?.archive?.lengthMin,
            });
            wireMessages = swept.nextMessages;
            // Mutate the in-memory conversation array so subsequent turns
            // see the stub too — without this, the next turn re-archives
            // the same body.
            if (swept.archivedCount > 0) {
              for (let i = 0; i < conversationMessages.length; i += 1) {
                conversationMessages[i] = wireMessages[i];
              }
            }
          } catch { /* best-effort */ }
        }

        // task-704b: pre-flight total-token guard. Even with the per-tool
        // cap (registry.js: 10% of contextWindow per result), N tool
        // results plus history can still breach the wire limit before we
        // ever call adapter.stream(). Estimate the total token cost; if
        // it exceeds PREFLIGHT_RATIO of the live context window, run an
        // emergency archive sweep with `turnAgeMin: 0` so even
        // current-turn-but-not-this-call bulky results get stubbed. The
        // normal sweep above only stubs results older than 5 user turns
        // — that's the wrong cadence when the *current* turn already has
        // 4 large grep results.
        //
        // PREFLIGHT_RATIO = 0.85 leaves ~15% of the window for the model's
        // own output tokens + tools metadata + light future history.
        // The estimator (`estimateMessagesTokens`) is approxTokens
        // (char/4 with CJK weighting) — good enough for a guard rail; a
        // real tokenizer would be exact but adds a heavy dep.
        if (this.#yeaftDir && (this.#config?.archive?.toolResults !== false)) {
          const PREFLIGHT_RATIO = 0.85;
          const threshold = Math.floor(currentContextWindow * PREFLIGHT_RATIO);
          const estimate = estimateMessagesTokens(systemPrompt, wireMessages);
          if (estimate > threshold) {
            try {
              const sweep = await archiveToolResults({
                root: `${this.#yeaftDir}/memory`,
                scopeDir: 'user',
                messages: wireMessages,
                turnAgeMin: 0,
                lengthMin: this.#config?.archive?.lengthMin ?? 2000,
              });
              wireMessages = sweep.nextMessages;
              if (sweep.archivedCount > 0) {
                for (let i = 0; i < conversationMessages.length; i += 1) {
                  conversationMessages[i] = wireMessages[i];
                }
                this.#trace.log?.('preflight_sweep', {
                  archivedCount: sweep.archivedCount,
                  archivedBytes: sweep.archivedBytes,
                  estimateBefore: estimate,
                  threshold,
                  contextWindow: currentContextWindow,
                });
              }
            } catch { /* best-effort */ }
          }
        }

        // Stream from adapter
        for await (const event of this.#adapter.stream({
          model: currentModel,
          system: systemPrompt,
          messages: wireMessages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          maxTokens: this.#config.maxOutputTokens || 16384,
          effort: resolvedEffort,
          signal,
          onRawExchange: captureRawExchange,
        })) {
          switch (event.type) {
            case 'text_delta':
              if (ttfbMs === null) ttfbMs = Date.now() - startTime;
              responseText += event.text;
              yield event;
              break;
            case 'thinking_delta':
              yield event;
              break;
            case 'thinking_block_end':
              // task-327d: collect server-signed thinking block for
              // round-trip replay. Anthropic 400s the next turn if a
              // thinking block (regular or redacted) was emitted but not
              // echoed back with its original signature. Drop blocks
              // missing a signature — replay-without-sig 400s identically.
              if (event.signature) {
                if (event.redacted) {
                  thinkingBlocks.push({ redacted: true, data: event.data, signature: event.signature });
                } else {
                  thinkingBlocks.push({ thinking: event.thinking, signature: event.signature });
                }
              } else {
                console.warn('[Engine] thinking block missing signature — dropping; next turn would 400 on replay');
              }
              break;
            case 'tool_call':
              toolCalls.push(event);
              yield event;
              break;
            case 'usage':
              totalUsage.inputTokens += event.inputTokens;
              totalUsage.outputTokens += event.outputTokens;
              cumulativeInputTokens += event.inputTokens || 0;
              cumulativeOutputTokens += event.outputTokens || 0;
              yield event;
              break;
            case 'stop':
              stopReason = event.stopReason;
              yield event;
              break;
            case 'error':
              yield event;
              break;
          }
        }
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        this.#trace.endTurn(turnId, {
          model: currentModel,
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          stopReason: 'error',
          latencyMs,
          responseText,
          // fix-vp-multi-thread (bug 4): persist the snapshot on the
          // error path too — failure traces are the most valuable for
          // hydration.
          systemPrompt,
          messages: conversationMessages.map(mapDebugMessage),
          toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
          usage: {
            inputTokens: totalUsage.inputTokens || 0,
            outputTokens: totalUsage.outputTokens || 0,
            totalTokens: (totalUsage.inputTokens || 0) + (totalUsage.outputTokens || 0),
          },
          ttfbMs,
          rawRequest,
          rawResponse,
        });

        // Emit `loop` event for error path too (was `debug_turn`).
        const errLoopInputTokens = totalUsage.inputTokens || 0;
        const errLoopOutputTokens = totalUsage.outputTokens || 0;
        yield {
          type: 'loop',
          turnId: queryTurnId,
          threadId,
          loopNumber: turnNumber,
          model: currentModel,
          systemPrompt,
          messages: conversationMessages.map(mapDebugMessage),
          response: responseText || `Error: ${err.message}`,
          toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
          usage: {
            inputTokens: errLoopInputTokens,
            outputTokens: errLoopOutputTokens,
            totalTokens: errLoopInputTokens + errLoopOutputTokens,
          },
          latencyMs,
          ttfbMs,
          stopReason: 'error',
          rawRequest,
          rawResponse,
        };

        // ─── task-325a: abort short-circuit ────────────────
        // If the adapter threw LLMAbortError, or the signal fired during
        // stream() (fetch throws AbortError / DOMException), we converge
        // the state machine on the 'aborted' terminal state — no retry,
        // no fallback, no persistence. One `aborted` event + one
        // `turn_end` with stopReason='aborted' and we're done.
        const isAbort = err instanceof LLMAbortError
          || err?.name === 'AbortError'
          || err?.name === 'LLMAbortError'
          || (signal?.aborted && /abort/i.test(err?.message || ''));
        if (isAbort || signal?.aborted) {
          yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
          yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId };
          break;
        }

        // ─── LLMContextError → force compact → retry ──────
        if (err instanceof LLMContextError && this.#conversationStore) {
          const consolidated = await this.#maybeConsolidate();
          if (consolidated && consolidated.archivedCount > 0) {
            yield { type: 'consolidate', archivedCount: consolidated.archivedCount, extractedCount: consolidated.extractedCount };
            yield { type: 'turn_end', turnNumber, stopReason: 'context_overflow_retry', threadId };
            continue; // retry with fewer messages
          }
        }

        // ─── Fallback model ──────────────────────────────
        const fallbackModel = this.#config.fallbackModel;
        if (fallbackModel && fallbackModel !== currentModel &&
            (err.name === 'LLMRateLimitError' || err.name === 'LLMServerError')) {
          yield { type: 'fallback', from: currentModel, to: fallbackModel, reason: err.message };
          currentModel = fallbackModel;
          yield { type: 'turn_end', turnNumber, stopReason: 'fallback_retry', threadId };
          continue; // retry with fallback model
        }

        yield {
          type: 'error',
          error: err,
          retryable: err.name === 'LLMRateLimitError' || err.name === 'LLMServerError',
        };
        yield { type: 'turn_end', turnNumber, stopReason: 'error', threadId };
        break;
      }

      const latencyMs = Date.now() - startTime;

      // Record turn in debug trace
      this.#trace.endTurn(turnId, {
        model: currentModel,
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        stopReason,
        latencyMs,
        responseText,
        // fix-vp-multi-thread (bug 4): persist the full per-loop
        // snapshot. The frontend debug panel only renders what it has
        // in-memory — without these columns the user can never see
        // history from before the panel was opened.
        systemPrompt,
        messages: conversationMessages.map(mapDebugMessage),
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
        usage: {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
          totalTokens: (totalUsage.inputTokens || 0) + (totalUsage.outputTokens || 0),
        },
        ttfbMs,
        rawRequest,
        rawResponse,
      });

      // Emit `loop` event for the debug panel.
      // feat-6af5f9f1 PR B: a Loop is one LLM call inside a Turn. The wire
      // event was historically named `debug_turn` and carried `turnNumber`,
      // which is misleading — it's per-LLM-call, not per-user-prompt.
      // We emit the new shape (turnId + loopNumber) and keep totalTokens
      // pre-computed so the UI doesn't have to.
      // task-331: preserve toolCalls / toolCallId / isError on each message
      // so the panel can render function_call requests and their paired
      // tool_result responses across loops.
      const loopInputTokens = totalUsage.inputTokens || 0;
      const loopOutputTokens = totalUsage.outputTokens || 0;
      yield {
        type: 'loop',
        turnId: queryTurnId,
        loopNumber: turnNumber,
        model: currentModel,
        systemPrompt,
        messages: conversationMessages.map(mapDebugMessage),
        response: responseText,
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
        usage: {
          inputTokens: loopInputTokens,
          outputTokens: loopOutputTokens,
          totalTokens: loopInputTokens + loopOutputTokens,
        },
        latencyMs,
        ttfbMs,
        stopReason,
        rawRequest,
        rawResponse,
      };

      // Append assistant message to conversation
      const assistantMsg = { role: 'assistant', content: responseText };
      if (toolCalls.length > 0) {
        assistantMsg.toolCalls = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        }));
      }
      // task-327d: persist thinking blocks for the next turn's replay.
      // Anthropic requires assistant.thinking blocks to be echoed back
      // verbatim (text + signature) when the previous turn used extended
      // thinking — see translateMessages in anthropic.js.
      if (thinkingBlocks.length > 0) {
        assistantMsg.thinkingBlocks = thinkingBlocks.map(tb => (
          tb.redacted
            ? { redacted: true, data: tb.data, signature: tb.signature }
            : { thinking: tb.thinking, signature: tb.signature }
        ));
      }
      // Phase 8 (DESIGN.md §9.15): carry the router plan back on the
      // assistant message that produced it. Stripped at the wire by
      // stripMetaForWire — pure bookkeeping for priorPlan continuity.
      if (vpPersona && vpPersona.vpId) {
        // PR-I: when the dispatcher hands us a per-VP plan whose vpId matches
        // the active persona, persist its `forwardQuery`, `preselect`, and
        // `thinking` on the assistant message so the next turn's
        // priorPlan continuity (DESIGN.md §9.15) sees the live router's
        // decision — not a synthetic stub.
        const planForThisVp = (vpPlan && typeof vpPlan === 'object'
          && typeof vpPlan.vpId === 'string' && vpPlan.vpId === vpPersona.vpId)
          ? vpPlan
          : null;
        attachRouterPlan(assistantMsg, {
          vpId: vpPersona.vpId,
          forwardQuery: planForThisVp && planForThisVp.forwardQuery
            ? planForThisVp.forwardQuery
            : { userOriginal: prompt || '', intent: '' },
          preselect: planForThisVp && planForThisVp.preselect
            ? planForThisVp.preselect
            : undefined,
          thinking: planForThisVp && (planForThisVp.thinking === 'high' || planForThisVp.thinking === 'max')
            ? planForThisVp.thinking
            : null,
          thinkingReason: planForThisVp && typeof planForThisVp.thinkingReason === 'string'
            ? planForThisVp.thinkingReason
            : '',
        });
      }
      conversationMessages.push(assistantMsg);
      fullResponseText += responseText;

      // ─── Handle max_tokens → auto-continue ────────────
      if (stopReason === 'max_tokens' && continueTurns < MAX_CONTINUE_TURNS) {
        continueTurns++;
        // Append a "Continue" user message
        conversationMessages.push({ role: 'user', content: 'Continue' });
        yield { type: 'turn_end', turnNumber, stopReason: 'max_tokens_continue', threadId };
        continue; // loop back to call adapter again
      }

      // If new user input was appended while this loop was streaming and
      // there are no tools to force another loop, splice it now and continue
      // instead of ending the thread. This preserves token streaming and
      // still only mutates messages at a clean loop boundary.
      const appendedAfterAssistant = this.#drainPendingUserMessages(drainPendingUserMessages);
      if (appendedAfterAssistant.length > 0) {
        for (const item of appendedAfterAssistant) {
          conversationMessages.push({ role: 'user', content: item.content });
          yield {
            type: 'user_append',
            turnId: queryTurnId,
            loopNumber: turnNumber,
            threadId,
            preview: String(item.preview || '').slice(0, 200),
          };
        }
        yield { type: 'turn_end', turnNumber, stopReason: 'user_append_continue', threadId };
        continue;
      }

      // If no tool calls, we're done
      if (stopReason !== 'tool_use' || toolCalls.length === 0) {
        if (pendingSubAgentNotifs.length > 0) {
          acknowledgePendingNotifications(notifScope, pendingSubAgentNotifs.map(n => n.id));
        }
        yield { type: 'turn_end', turnNumber, stopReason, threadId };

        // ─── Post-query: StopHooks or Legacy ─────────────
        if (this.#config._readOnly) {
          // Read-only mode: skip all persistence operations
        } else if (this.#yeaftDir && this.#conversationStore) {
          // Full pipeline: persist + consolidate + dream gate
          // Note: stopHooks uses fastConfig for consolidation/dream (cheaper internal tasks)
          // but receives both configs — messages are persisted with primary model name
          const hookResult = await runStopHooks({
            yeaftDir: this.#yeaftDir,
            conversationStore: this.#conversationStore,
            adapter: this.#adapter,
            config: this.#fastConfig,
            primaryModel: this.#config.model,
            messages: conversationMessages,
            // Reflect-persist fix: tell stop-hooks the EXACT turn boundary
            // instead of letting it heuristically scan back to the last
            // role:'user'. With T1/T2 reflection collapse, the last
            // role:'user' is the synthetic reflection message — not the
            // original user prompt — so the heuristic was dropping
            // earlier reflection messages and the original prompt off
            // the persistence window. `turnStartIdx` is the index of
            // the original user prompt (set at query() entry); slicing
            // from there persists the full collapsed turn including all
            // reflection messages and the trailing assistant response.
            turnStartIdx,
            trace: this.#trace,
            // Bug 6: tag persisted messages with the originating group so
            // history replay can re-stamp them on reload.
            sessionId,
            threadId,
            vpId: this.#vpId,
            // Multi-VP fan-out (history-dedup): skip the user-row append
            // in stop-hooks when the orchestrator already wrote it once
            // for this turn. The hook still persists assistant + tool
            // rows for THIS VP's contribution.
            userAlreadyPersisted,
          });

          if (hookResult.consolidated) {
            yield { type: 'consolidate', archivedCount: 0, extractedCount: 0 };
          }
        } else {
          // Legacy path (no yeaftDir → use old behavior)
          this.#persistMessages(prompt, fullResponseText, assistantMsg.toolCalls, sessionId, userAlreadyPersisted);

          const consolidated = await this.#maybeConsolidate();
          if (consolidated && consolidated.archivedCount > 0) {
            yield { type: 'consolidate', archivedCount: consolidated.archivedCount, extractedCount: consolidated.extractedCount };
          }
        }

        // ─── Post-turn AMS adjust ────────────────────────────────
        // shouldRunAdjust gates the LLM round-trip so most turns are
        // free; first turn always runs, plus on budget pressure.
        if (amsContext) {
          const adjustResult = await this.#runAdjustHook({
            amsContext,
            userMsg: prompt,
            assistantReply: fullResponseText,
            turnTokenUsage: cumulativeInputTokens + cumulativeOutputTokens,
          });
          if (adjustResult && adjustResult.ran) {
            yield {
              type: 'memory_adjust',
              turnId: queryTurnId,
              threadId,
              sessionKey: amsContext.sessionKey,
              added: adjustResult.added,
              evicted: adjustResult.evicted,
              skipped: adjustResult.skipped || 0,
              reason: adjustResult.reason,
            };
          }
        }

        // PR-L: T2 end-of-turn (asynchronous) reflection. Fires when the
        // total tool count for this query() exceeds TURN_SUMMARY_THRESHOLD
        // (8) AND no T1 has actually rewritten the arc yet. Kicks off the
        // primary-model call without await; the next query()'s
        // `#applyPendingT2Reflections` carries the result forward.
        //
        // Periodic-T1 fix: gate on `t1CollapsesDone === 0`, NOT
        // `lastT1AtToolCount === 0`. The catch block of T1 bumps
        // `lastT1AtToolCount` after a reflector error to avoid
        // tight-loop retries — but no collapse happened, so T2 should
        // still be allowed to fall back at end_turn. Fowler-review
        // critical finding.
        if (groupReflectionAllowed && queryToolCount > TURN_SUMMARY_THRESHOLD && t1CollapsesDone === 0) {
          const arcStart = turnStartIdx + 1;
          const arcEnd = conversationMessages.length - 1;
          if (arcEnd > arcStart) {
            const { pairs, assistantText } = extractToolPairsFromRange(
              conversationMessages, arcStart, arcEnd,
            );
            yield {
              type: 'reflection',
              turnId: queryTurnId,
              loopNumber: turnNumber,
              trigger: 't2',
              status: 'pending',
              loopRange: [arcStart, arcEnd],
              toolCount: pairs.length,
            };
            const promise = runT2Reflection({
              adapter: this.#adapter,
              model: this.#config.model,
              originalUserMsg: prompt,
              toolPairs: pairs,
              assistantText,
              language: this.#config.language,
              signal,
            });
            // Detach: never await. The promise outlives this query() and
            // the next call will pick it up (or use the fallback stub if
            // it hasn't resolved by then).
            // PR-L follow-up: latch a synchronously-readable ready flag
            // and result on the info record so `#applyPendingT2Reflections`
            // can decide ready-vs-pending without racing microtasks.
            const info = {
              promise,
              loopRange: [arcStart, arcEnd],
              count: pairs.length,
              originalUserMsg: prompt,
              originatingTurnId: queryTurnId,
              ready: false,
              result: null,
              error: null,
            };
            promise.then(
              (v) => { info.ready = true; info.result = v; },
              (err) => { info.ready = true; info.error = err; },
            );
            this.#pendingT2.set(queryNumber, info);
          }
        }

        break;
      }

      // Execute tool calls and feed results back
      // task-707: requestEndTurn is a per-batch closure that lets a tool
      // signal "end this turn after the current batch — no adapter retry".
      // We re-create the closure each iteration because endTurnRequested
      // is a per-query local (reset implicitly at the top of #runQuery).
      const toolCtx = this.#buildToolContext(signal, {
        router,
        senderVpId,
        sessionId: runtimeSessionId,
        threadId: runtimeThreadId,
        inboundEnvelope,
        taskId,
        taskMembers,
        vpPersona,
        contextWindow: currentContextWindow,
        getCurrentTodos,
        setCurrentTodos,
        workDir,
        requestEndTurn: (reason) => {
          // First call wins — preserve the kind/reason of the first tool
          // that asked to end the turn. Late callers (a second
          // route_forward in the same batch) keep dispatching but don't
          // overwrite the recorded reason.
          if (endTurnRequested == null) {
            endTurnRequested = reason || { kind: 'tool_handoff' };
          }
        },
      });

      // task-325a: track whether we aborted mid tool-loop so we can
      // break out of the outer while-loop cleanly once the current
      // tool batch finishes reporting.
      let abortedDuringTools = false;
      /** @type {string[]} */
      const pendingDupReminders = [];

      for (const tc of toolCalls) {
        // task-325a: honour abort between tools. We don't cancel a tool
        // that's already running (the signal is passed in, tools decide
        // themselves whether to bail early), but we stop dispatching
        // any remaining tools the moment abort fires.
        if (signal?.aborted) {
          abortedDuringTools = true;
          break;
        }

        const toolStartTime = Date.now();

        // PR-L: duplicate-call detection. If this exact (toolName,
        // argsHash) pair has already been executed DUP_TOOL_THRESHOLD
        // (3) times within the current turn + last 2 turns, queue a
        // system reminder. We push the reminder AFTER the tool batch
        // completes (not now) so the
        // assistant(tool_use) → user(tool_result, …) pairing demanded
        // by the Anthropic / OpenAI Responses APIs stays intact. We
        // don't block the call — the LLM still decides.
        const dupHash = argsHashOf(tc.input);
        // PR-L follow-up: lookback is by user-conversation turn
        // (`queryNumber`), NOT by inner adapter loop iteration. Each call
        // to query() bumps queryNumber once, so "last 2 turns" means the
        // current user turn + the previous two user turns — the natural
        // semantic for "the model is stuck in a loop across the
        // conversation."
        const dupInfo = this.#execLog.dupInfo({
          toolName: tc.name,
          argsHash: dupHash,
          currentTurn: queryNumber,
          lookbackTurns: 2,
        });
        if (dupInfo.count + 1 >= DUP_TOOL_THRESHOLD) {
          pendingDupReminders.push(buildDuplicateReminder({
            toolName: tc.name,
            count: dupInfo.count + 1,
            lastResultBrief: dupInfo.lastResultBrief,
          }));
        }

        let output;
        let isError = false;

        // Resolve tool: prefer ToolRegistry, fallback to legacy #tools Map
        const hasTool = this.#toolRegistry
          ? this.#toolRegistry.isAllowed(tc.name, { collabToolPolicy: effectiveCollabToolPolicy })
          : this.#tools.has(tc.name);

        if (!hasTool) {
          output = `Error: unknown tool "${tc.name}"`;
          isError = true;
          yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true, threadId: this.currentThreadId };
        } else {
          try {
            yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input, threadId: this.currentThreadId };
            if (this.#toolRegistry) {
              output = await this.#toolRegistry.execute(tc.name, tc.input, toolCtx);
            } else {
              const tool = this.#tools.get(tc.name);
              // Pass the full toolCtx (cwd, workDir, signal, …) — not just
              // `{ signal }`. Legacy registerTool() callers historically got
              // a 1-field ctx, but that means tools like bash/file-read run
              // in the agent process cwd instead of the group's workDir.
              // Real production goes through #toolRegistry; the legacy path
              // is exercised by tests and a few standalone tools. Aligning
              // both paths keeps `ctx.cwd` semantics consistent.
              const rawOutput = await tool.execute(tc.input, toolCtx);
              // Legacy #tools branch must apply the same per-tool cap as
              // ToolRegistry.execute. Otherwise a deployment using the legacy
              // registration path bypasses the defense entirely.
              output = truncateToolResultIfNeeded(rawOutput, {
                toolName: tc.name,
                language: this.#config?.language,
              });
            }
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: false, threadId: this.currentThreadId };
          } catch (err) {
            output = `Error: ${err.message}`;
            isError = true;
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true, threadId: this.currentThreadId };
          }
        }

        const toolDurationMs = Date.now() - toolStartTime;

        // feat-6af5f9f1 PR B: emit a structured `tool_exec` event for the
        // debug panel. Args/output are already in `conversationMessages`
        // and will be visible in the next loop's snapshot, so we don't
        // duplicate them here — only the per-tool timing + status.
        yield {
          type: 'tool_exec',
          turnId: queryTurnId,
          threadId,
          loopNumber: turnNumber,
          callId: tc.id,
          name: tc.name,
          durationMs: toolDurationMs,
          isError,
        };

        // 2026-05-13: feed the per-tool counters. Stays best-effort — a
        // stats sink that throws shouldn't crash the engine. `record`
        // already swallows internal write errors.
        if (this.#toolStats && typeof this.#toolStats.record === 'function') {
          try {
            this.#toolStats.record({
              name: tc.name,
              durationMs: toolDurationMs,
              isError,
              errorMessage: isError && typeof output === 'string' ? output.slice(0, 500) : null,
            });
          } catch { /* swallow */ }
        }

        // Log tool to debug trace
        this.#trace.logTool(turnId, {
          toolName: tc.name,
          toolInput: JSON.stringify(tc.input),
          toolOutput: output,
          durationMs: toolDurationMs,
          isError,
        });

        // Append tool result to conversation
        conversationMessages.push({
          role: 'tool',
          toolCallId: tc.id,
          content: output,
          isError,
        });

        // PR-L: persist this execution to the exec-log for fallback-stub
        // and duplicate-call detection. Best-effort — disk failures are
        // swallowed inside ExecLog.append.
        // PR-L follow-up: persist under `queryNumber` (one entry-key per
        // user-conversation turn), not the inner loop's turnNumber.
        // Aligns exec-log layout with dup detection lookback and the
        // T2 fallback-stub readTurn() call below.
        this.#execLog.append(queryNumber, buildExecLogEntry({
          loopIdx: queryToolCount,
          toolName: tc.name,
          args: tc.input,
          output,
          isError,
        }));
        queryToolCount += 1;
      }

      // PR-L: flush any duplicate-call reminders queued during the batch.
      // Pushed AFTER the for-loop so the tool_use → tool_result pairing
      // is intact; the next adapter.stream() will see the reminder as a
      // user message immediately after the last tool result.
      for (const reminder of pendingDupReminders) {
        conversationMessages.push({ role: 'user', content: reminder });
      }

      // task-707: tool-callable end-turn signal. If a tool in this batch
      // called toolCtx.requestEndTurn(reason), break out of the outer
      // while-loop now — DON'T call adapter.stream() again. The
      // assistant(tool_use)+tool(tool_result) pairs are already in
      // conversationMessages, so the next user-initiated turn sees a
      // clean wire shape. Used by `route_forward` to hand off control
      // to other VPs without continuing to generate.
      //
      // Order matters: this runs BEFORE T1 reflection (which would
      // collapse the arc into a summary that's only valuable across
      // multi-iteration tool loops) and BEFORE the abortedDuringTools
      // check (so a clean handoff doesn't get reported as 'aborted').
      if (endTurnRequested) {
        if (pendingSubAgentNotifs.length > 0) {
          acknowledgePendingNotifications(notifScope, pendingSubAgentNotifs.map(n => n.id));
        }
        const handoffDetail = typeof endTurnRequested === 'object'
          ? endTurnRequested
          : { kind: 'tool_handoff', reason: String(endTurnRequested) };
        yield {
          type: 'turn_end',
          turnNumber,
          stopReason: 'tool_handoff',
          detail: handoffDetail,
          threadId,
        };
        break;
      }

      // PR-L: T1 in-turn (synchronous) reflection. Fires once per
      // adapter loop iteration where ≥ TOOL_BATCH_SIZE (30) tool
      // calls have accumulated since the last T1 firing — not just
      // the first batch of the query(). Generates a markdown reflection
      // over the assistant+tool arc since the last T1 firing (or
      // since the user prompt for the first batch) and rewrites that
      // range to a SINGLE synthetic user message before the next
      // adapter.stream() runs.
      //
      // Loop semantics:
      //   - First batch: arcStartIdx = turnStartIdx + 1, fires when
      //     queryToolCount reaches TOOL_BATCH_SIZE.
      //   - Each subsequent batch: arcStartIdx is updated to the slot
      //     right after the just-inserted reflection message; fires
      //     again whenever TOOL_BATCH_SIZE more tools have run since
      //     lastT1AtToolCount.
      //   - The dedup Set key includes `lastT1AtToolCount` so each
      //     batch within the same query gets a distinct entry — without
      //     this the second batch would be silently skipped.
      const t1BatchDue = queryToolCount - lastT1AtToolCount >= TOOL_BATCH_SIZE;
      if (groupReflectionAllowed && t1BatchDue && !abortedDuringTools && !signal?.aborted) {
        const t1DedupKey = `${queryNumber}:t1:${queryToolCount}`;
        if (this.#reflectedTurns.has(t1DedupKey)) {
          // Defensive: should never hit since t1BatchDue gates re-entry
          // and queryNumber namespaces queries. Kept as belt-and-
          // suspenders against any future external mutation of the
          // cursor (or a re-entrant query() that this code doesn't
          // anticipate).
        } else {
          this.#reflectedTurns.add(t1DedupKey);
        const batchStart = arcStartIdx;
        const batchEnd = conversationMessages.length - 1;
        try {
          const { pairs, assistantText } = extractToolPairsFromRange(
            conversationMessages, batchStart, batchEnd,
          );
          yield {
            type: 'reflection',
            turnId: queryTurnId,
            threadId,
            loopNumber: turnNumber,
            trigger: 't1',
            status: 'pending',
            loopRange: [batchStart, batchEnd],
            toolCount: pairs.length,
          };
          const { content, durationMs } = await runT1Reflection({
            adapter: this.#adapter,
            model: this.#config.model,
            originalUserMsg: prompt,
            toolPairs: pairs,
            assistantText,
            language: this.#config.language,
            signal,
          });
          const next = collapseRangeToReflection(
            conversationMessages, batchStart, batchEnd, content,
          );
          conversationMessages.length = 0;
          for (const m of next) conversationMessages.push(m);
          // After collapse: the just-inserted reflection lives at
          // index `batchStart`. The next tool arc therefore starts
          // immediately after it, i.e. at conversationMessages.length
          // (the next assistant message will land here).
          arcStartIdx = conversationMessages.length;
          lastT1AtToolCount = queryToolCount;
          // Bump the success counter — used by the T2 schedule check
          // to decide whether T2 still has work to do at end_turn.
          // Distinct from lastT1AtToolCount which the catch block
          // also bumps (but without rewriting history).
          t1CollapsesDone += 1;
          yield {
            type: 'reflection',
            turnId: queryTurnId,
            threadId,
            loopNumber: turnNumber,
            trigger: 't1',
            // PR-L bug fix: keep the same loopRange as the `pending` event
            // so the frontend key stays stable across pending → ready and
            // the spinner card is replaced in place (no orphan).
            status: 'ready',
            loopRange: [batchStart, batchEnd],
            toolCount: pairs.length,
            content,
            durationMs,
          };
        } catch (err) {
          // Best-effort. On failure leave history unchanged so the loop
          // continues normally — never block the turn.
          yield {
            type: 'reflection',
            turnId: queryTurnId,
            threadId,
            loopNumber: turnNumber,
            trigger: 't1',
            status: 'error',
            error: err && err.message || String(err),
          };
          // Advance lastT1AtToolCount past this batch so we don't
          // tight-loop on a hiccuping reflector. The next attempt is
          // TOOL_BATCH_SIZE tools from now, not immediately. arcStartIdx is
          // left alone because history wasn't rewritten — the tail still
          // begins where it did. The trade-off: the next batch's
          // reflection will cover the tools that just failed too,
          // which is fine (they're still in conversationMessages).
          //
          // We do NOT bump t1CollapsesDone — see the variable's
          // declaration comment. This keeps the T2 fallback path live
          // when every T1 attempt has errored.
          lastT1AtToolCount = queryToolCount;
        }
        }
      }

      // task-325a: if abort fired between tools, converge now — emit
      // the typed `aborted` event + a final turn_end with stopReason
      // 'aborted' instead of looping back to a new adapter call.
      if (abortedDuringTools || signal?.aborted) {
        yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
        yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId };
        break;
      }

      yield { type: 'turn_end', turnNumber, stopReason: 'tool_use', threadId };

      // task-327b: count this as a tool-loop turn. Next iteration's
      // pickEffort() will see the bumped counter and upgrade to 'max'
      // once LONG_LOOP_TURN_THRESHOLD is reached.
      toolLoopTurns++;

      // Loop back to call adapter again with tool results
    }

    // feat-6af5f9f1 PR B: turn closed. Emits final totals so the debug
    // panel can show "Turn done · 4 loops · 12.4s · 5.0k tok" without
    // having to reduce the loops itself. Always fires (every break path
    // above falls through here).
    yield {
      type: 'turn_close',
      turnId: queryTurnId,
      threadId,
      totalMs: Date.now() - queryStartedAt,
      totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
      loopCount: turnNumber,
    };
  }

  /**
   * Get the trace ID for this engine instance.
   * @returns {string}
   */
  get traceId() {
    return this.#traceId;
  }

  /**
   * Get registered tool names.
   * @returns {string[]}
   */
  get toolNames() {
    if (this.#toolRegistry) return this.#toolRegistry.names;
    return Array.from(this.#tools.keys());
  }

  /**
   * Get the conversation store (for external access, e.g., CLI commands).
   * @returns {import('./conversation/persist.js').ConversationStore|null}
   */
  get conversationStore() {
    return this.#conversationStore;
  }

  /** @returns {import('./tools/registry.js').ToolRegistry|null} */
  get toolRegistry() { return this.#toolRegistry; }

  /** @returns {import('./skills.js').SkillManager|null} */
  get skillManager() { return this.#skillManager; }

  /** @returns {import('./mcp.js').MCPManager|null} */
  get mcpManager() { return this.#mcpManager; }

  /**
   * PR-L — V7 Tool History Reflection helpers.
   *
   * `#applyPendingT2Reflections` is called at the start of every
   * `#runQuery` to carry forward any prior turn's async reflection. It is
   * a generator so it can yield reflection events to the engine consumer.
   * Non-blocking: never awaits a pending promise.
   *
   * @param {Array} conversationMessages
   * @param {string} originalUserMsg
   */
  async *#applyPendingT2Reflections(conversationMessages, originalUserMsg) {
    if (this.#pendingT2.size === 0) return;
    // Drain in insertion order (Map preserves it). We process all entries
    // because the user could send multiple prompts back-to-back before
    // the engine resumes — each historical turn gets its rewrite.
    const drained = [...this.#pendingT2.entries()];
    this.#pendingT2.clear();

    for (const [turnNumber, info] of drained) {
      const range = info.loopRange;
      if (!Array.isArray(range) || range.length !== 2) continue;
      const [startIdx, endIdx] = range;
      if (startIdx < 0 || endIdx < startIdx || endIdx >= conversationMessages.length) {
        continue;
      }

      // PR-L follow-up: deterministic readiness check. The info record
      // carries `ready / result / error` flags that are flipped from the
      // promise's then/catch handler; reading them here is purely
      // synchronous bookkeeping — no microtask race.
      let content;
      let trigger;
      let durationMs = 0;
      if (!info.ready) {
        // Still in flight — fall back to the exec-log stub. Detach the
        // unresolved promise so we don't leak it (handlers above already
        // swallow rejection by routing into info.error).
        const entries = this.#execLog ? this.#execLog.readTurn(turnNumber) : [];
        content = buildFallbackStub({ execLogEntries: entries, originalUserMsg: info.originalUserMsg || originalUserMsg });
        trigger = 't2-fallback';
      } else if (info.error) {
        // Promise rejected — leave history unchanged, no event.
        continue;
      } else if (info.result && typeof info.result.content === 'string' && info.result.content) {
        content = info.result.content;
        trigger = 't2';
        durationMs = info.result.durationMs || 0;
      } else {
        // Resolved but with no usable content — defensively skip.
        continue;
      }

      // Rewrite history.
      const next = collapseRangeToReflection(conversationMessages, startIdx, endIdx, content);
      // Mutate in place so caller's reference stays valid.
      conversationMessages.length = 0;
      for (const m of next) conversationMessages.push(m);

      yield {
        type: 'reflection',
        turnId: info.originatingTurnId || null,
        trigger,
        status: 'ready',
        loopRange: [startIdx, endIdx],
        toolCount: info.count || 0,
        content,
        durationMs,
      };
    }
  }

  /**
   * PR-L — read-only accessor for tests.
   */
  get _execLog() { return this.#execLog; }

  /**
   * task-299 Phase 1: the engine's current thread marker.
   * Defaults to 'main' if the thread store is unreachable for any reason.
   * @returns {string}
   */
  get currentThreadId() {
    return this.#currentThreadId || MAIN_THREAD_ID;
  }

  /**
   * Append a user message into the currently running query. The loop consumes
   * it only at adapter boundaries, never mid-token and never between an
   * assistant tool_use and its paired tool_result messages.
   * @param {string|Array} content
   * @returns {boolean}
   */
  appendUserMessage(content) {
    if (typeof content !== 'string' && !Array.isArray(content)) return false;
    if (typeof content === 'string' && !content.trim()) return false;
    const preview = typeof content === 'string' ? content : '[content blocks]';
    this.#pendingUserMessages.push({ content, preview });
    return true;
  }

  /** @returns {string|null} */
  get yeaftDir() { return this.#yeaftDir; }

  /** @returns {object} — Config with fastModel as model (for internal tasks) */
  get fastConfig() { return this.#fastConfig; }

  /**
   * Run a one-shot fast-model call to produce a compact summary.
   * Used by the web bridge's in-memory history compactor
   * (`agent/yeaft/history-compact.js`) — kept on the engine so callers
   * don't reach into the private adapter field.
   *
   * @param {{system: string, prompt: string, maxTokens?: number}} args
   * @returns {Promise<string>} — summary text (trimmed); '' on failure
   */
  async summarizeForCompact({ system, prompt, maxTokens = 1024 } = {}) {
    if (!system || !prompt) return '';
    try {
      const out = await this.#adapter.call({
        model: this.#fastConfig.model,
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
      });
      return (out?.text || '').trim();
    } catch (err) {
      console.warn('[Engine] summarizeForCompact failed:', err?.message || err);
      return '';
    }
  }
}

async function collectTopicLabels(dir, prefix, labels, limit) {
  if (labels.length >= limit) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const hasMemory = entries.some(entry => entry.isFile() && entry.name === 'memory.md');
  const hasSummary = entries.some(entry => entry.isFile() && entry.name === 'summary.md');
  if (prefix && (hasMemory || hasSummary)) labels.push(prefix);
  if (labels.length >= limit) return;
  const dirs = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
  for (const name of dirs) {
    const nextPrefix = prefix ? `${prefix}/${name}` : name;
    await collectTopicLabels(join(dir, name), nextPrefix, labels, limit);
    if (labels.length >= limit) return;
  }
}
