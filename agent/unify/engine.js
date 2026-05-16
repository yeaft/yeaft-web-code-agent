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
 * Reference: yeaft-unify-implementation-plan.md §3.1, §4 (Phase 2)
 */

import { randomUUID } from 'crypto';
import { buildSystemPrompt, buildWorkerPrompt } from './prompts.js';
import { LLMContextError, LLMAbortError } from './llm/adapter.js';
import { runMemoryPreflow, buildRelevantScopes } from './groups/pre-flow.js';
import { shouldConsolidate, partitionMessages } from './memory/consolidate.js';
import { runCompact as runCompactOrchestrator } from './compact/orchestrator.js';
import { evaluateCompactTriggers } from './compact/triggers.js';
import { archiveTurn } from './archive/turn-archive.js';
import { archiveToolResults } from './archive/tool-results.js';
import { readSummary as readScopeSummary } from './memory/store-v2.js';
import { runAdjust } from './memory/adjust.js';
import { isVpSeedBackfillStub } from './memory/seed-backfill.js';
import { runStopHooks } from './stop-hooks.js';
// H2.f.5: threads/ retired. Persisted messages still carry a `threadId`
// field for back-compat with old conversation files; new writes always use
// the constant 'main'.
const MAIN_THREAD_ID = 'main';
import { pickEffort, parseEffortPrefix } from './effort.js';
import { normalizeEffort, resolveContextWindow } from './models.js';
import { attachRouterPlan, extractPriorPlan, stripMetaForWire } from './router/continuity.js';
import { resolveThinking } from './router/thinking.js';
import { approxTokens } from './memory/budget.js';
import { truncateToolResultIfNeeded } from './tools/registry.js';
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
 * conversations (user report: Unify loop errored at the cap). The engine
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
 * bound is per-loop-count (see `MAX_UNIFY_DEBUG_LOOPS` in
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
 *   groupId?: string|null,
 *   ownVpId?: string|null,
 *   summaries: { user?: string, group?: string, vp?: string }
 * }} args
 * @returns {Array<{scope: string, summary: string}>}
 */
export function buildResidentEntries(args) {
  const summaries = (args && args.summaries) || {};
  const out = [];
  if (summaries.user) out.push({ scope: 'user', summary: summaries.user });
  if (args.groupId && summaries.group) {
    out.push({ scope: `group/${args.groupId}`, summary: summaries.group });
  }
  if (args.ownVpId && summaries.vp && !isVpSeedBackfillStub(summaries.vp)) {
    out.push({ scope: `vp/${args.ownVpId}`, summary: summaries.vp });
  }
  return out;
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

  /**
   * Per-group "adjust has run at least once this engine lifetime" flag.
   * Keyed by groupId (or 'default'). The first turn always runs adjust;
   * subsequent turns only run on budget pressure or new memory.
   * @type {Map<string, boolean>}
   */
  #adjustRanByGroup = new Map();

  /** @type {string|null} */
  #abortReason = null;

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
  constructor({ adapter, trace, config, conversationStore, memoryIndex, amsRegistry, toolRegistry, skillManager, mcpManager, yeaftDir, toolStats = null }) {
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
  #getToolDefs() {
    if (this.#toolRegistry) {
      return this.#toolRegistry.getToolDefs(this.#config?.language || 'en');
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
   *   - group <gid>    → `groups/<gid>/summary.md`    (if groupId)
   *   - vp <vpId>      → `vp/<vpId>/summary.md`       (if vpId)
   *
   * Each fetch is best-effort — missing files / read errors return ''. The
   * dream tick (Phase 6) is what populates these; on a fresh install they
   * all return ''.
   *
   * @param {{groupId?: string, vpId?: string}} ctx
   * @returns {Promise<{user:string, group:string, vp:string}>}
   */
  async #loadLayerASummaries({ groupId, vpId } = {}) {
    if (!this.#yeaftDir) return { user: '', group: '', vp: '' };
    const memoryRoot = `${this.#yeaftDir}/memory`;
    const tasks = [
      readScopeSummary({ kind: 'user' }, { root: memoryRoot }).catch(() => ''),
      groupId
        ? readScopeSummary({ kind: 'group', id: groupId }, { root: memoryRoot }).catch(() => '')
        : Promise.resolve(''),
      vpId
        ? readScopeSummary({ kind: 'vp', id: vpId }, { root: memoryRoot }).catch(() => '')
        : Promise.resolve(''),
    ];
    const [user, group, vp] = await Promise.all(tasks);
    return { user: user || '', group: group || '', vp: vp || '' };
  }

  /**
   * Prepare the per-turn AMS for the active group. Idempotent and safe
   * to call when the AMS registry isn't wired (returns null).
   *
   * @param {{
   *   groupId?: string,
   *   ownVpId?: string|null,
   *   summaries: { user?: string, group?: string, vp?: string },
   *   recallEntries: object[],
   * }} args
   * @returns {{
   *   ams: import('./memory/ams.js').ActiveMemorySet,
   *   groupKey: string,
   *   ownVpId: string|null,
   *   scopes: string[],
   *   snapshotBlock: string,
   * } | null}
   */
  #prepareAms(args) {
    if (!this.#amsRegistry) return null;
    const groupKey = args.groupId || 'default';
    const ownVpId = args.ownVpId || null;
    const ams = this.#amsRegistry.getOrCreate(groupKey, { ownVpId });

    // Prime #adjustRanByGroup from disk-hydrated state on first access:
    // a reactivated group resumes with whatever adjustRanThisSession bit
    // it had on disconnect, so we don't burn a fresh adjust on every
    // reload. Once set true in this session we never clear it.
    if (!this.#adjustRanByGroup.has(groupKey)
        && this.#amsRegistry.adjustRanThisSession(groupKey)) {
      this.#adjustRanByGroup.set(groupKey, true);
    }

    // (a) Resident: rebuild from the same scope summaries the worker
    // prompt is already going to see.
    const residentEntries = buildResidentEntries({
      groupId: args.groupId,
      ownVpId,
      summaries: args.summaries || {},
    });
    ams.setResident(residentEntries);

    // (b) onDemand: replace with this turn's FTS hits.
    const segs = Array.isArray(args.recallEntries) ? args.recallEntries : [];
    ams.setOnDemand(segs);

    // (c) Snapshot — render the AMS layers as a single prompt block.
    const snapshotBlock = this.#renderAmsSnapshot(ams);

    const scopes = buildRelevantScopes({
      groupId: args.groupId,
      vpId: ownVpId,
    });

    return { ams, groupKey, ownVpId, scopes, snapshotBlock };
  }

  /**
   * Render an AMS snapshot as a markdown block suitable for prompt
   * injection. Mirrors the heading style of the existing memory blocks
   * so the LLM sees a consistent layout.
   *
   * @param {import('./memory/ams.js').ActiveMemorySet} ams
   * @returns {string}
   */
  #renderAmsSnapshot(ams) {
    const snap = ams.snapshot();
    if (!snap) return '';
    const parts = [];
    if (snap.resident.length === 0 && snap.recent.length === 0 && snap.onDemand.length === 0) {
      return '';
    }
    parts.push('## Active Memory Set');
    if (snap.resident.length > 0) {
      parts.push('### Resident');
      for (const r of snap.resident) {
        parts.push(`- **${r.scope}**: ${r.summary}`);
      }
    }
    if (snap.recent.length > 0) {
      parts.push('### Recent');
      for (const s of snap.recent) {
        parts.push(`- (${s.scope}) ${(s.body || '').trim()}`);
      }
    }
    if (snap.onDemand.length > 0) {
      parts.push('### OnDemand');
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
   *   amsContext: { ams: import('./memory/ams.js').ActiveMemorySet, groupKey: string, ownVpId: string|null, scopes: string[] }|null,
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

    const adjustRanThisSession = this.#adjustRanByGroup.get(ctx.groupKey) === true;
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
        this.#adjustRanByGroup.set(ctx.groupKey, true);
        // Always persist when we ran — even with no membership change,
        // the adjustRanThisSession bit is part of the on-disk state we
        // want to preserve.
        this.#amsRegistry.markDirty(ctx.groupKey);
        this.#amsRegistry.persist(ctx.groupKey, {
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
   * @param {string} [args.groupAnnouncement]
   * @param {object} [args.taskCtx] — legacy task-context sub-block (optional)
   * @returns {string}
   */
  #buildSystemPrompt({ prompt, memoryInjection, vpPersona, activeScope, groupAnnouncement, taskCtx } = {}) {
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
      groupAnnouncement,
      taskCtx,
      // Worker-shape harness is descriptive metadata for human inspection;
      // production prompts skip it to save tokens. Re-enable via env when
      // diagnosing prompt structure issues.
      includeShape: process.env.UNIFY_PROMPT_INCLUDE_SHAPE === '1',
    });
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
      cwd: process.cwd(),
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
      maxImageBytes: this.#config?.unify?.maxImageBytes,
      imageAllowlist: Array.isArray(this.#config?.unify?.imageAllowlist)
        ? this.#config.unify.imageAllowlist
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
   * @param {{ groupId?: string, vpId?: string }} [ctx]
   * @returns {Promise<{ profile: string, entries: object[], formatted: string }|null>}
   */
  async #recallMemory(prompt, ctx = {}) {
    const memory = { profile: '', entries: [], formatted: '' };
    if (!this.#memoryIndex) return memory;
    try {
      const result = runMemoryPreflow(this.#memoryIndex, {
        userMsg: prompt,
        groupId: ctx.groupId,
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
   * @param {string} [groupId]
   * @param {boolean} [userAlreadyPersisted]
   */
  #persistMessages(userContent, assistantContent, toolCalls, groupId, userAlreadyPersisted = false) {
    if (!this.#conversationStore) return;
    if (this.#config._readOnly) return;

    // H2.f.5: threads retired. Persisted messages still carry threadId
    // for back-compat with old conversation files; new writes always use 'main'.
    const threadId = MAIN_THREAD_ID;

    // Persist user message — unless an upstream caller (e.g. the group
    // coordinator) has already done so for this turn.
    if (!userAlreadyPersisted) {
      this.#conversationStore.append({
        role: 'user',
        content: userContent,
        threadId,
        // Bug 6: stamp groupId so history replay can route by group.
        ...(groupId ? { groupId } : {}),
      });
    }

    // Persist assistant message
    const assistantMsg = {
      role: 'assistant',
      content: assistantContent,
      model: this.#config.model,
      threadId,
      ...(groupId ? { groupId } : {}),
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

    const budget = this.#config.messageTokenBudget || 8192;
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

    let messages;
    try {
      messages = conversationStore.loadAll();
    } catch { return null; }
    if (!Array.isArray(messages) || messages.length === 0) return null;

    const tokenCount = conversationStore.hotTokens();
    const trig = evaluateCompactTriggers({
      messages,
      tokenCount,
      contextLimit: this.#config.maxContextTokens || 200000,
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
      ? '你是对话摘要器。请用中文写出 2–3 段简明摘要，保留决策、事实与上下文。'
      : 'You are a conversation summarizer. Summarize concisely in 2–3 paragraphs, preserving decisions, facts, and context.';
    const summariserPromptPrefix = isZh ? '请概括：\n\n' : 'Summarize:\n\n';

    const hooks = {
      summarise: async () => {
        try {
          const result = await adapter.call({
            model: fastConfig.model,
            system: summariserSystem,
            messages: [{ role: 'user', content: `${summariserPromptPrefix}${toArchive.map(m => `[${m.role}] ${(m.content || '').slice(0, 500)}`).join('\n\n')}` }],
            maxTokens: 1024,
          });
          return (result.text || '').trim();
        } catch {
          return '';
        }
      },
      archive: async (_groupIdx, groupMsgs) => {
        for (const m of groupMsgs) if (m.id) archiveIds.push(m.id);
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
      if (archiveIds.length > 0) conversationStore.moveToColdBatch(archiveIds);
      if (out.compactSummary) conversationStore.updateCompactSummary(out.compactSummary);
      const lastKept = messages[messages.length - 1];
      conversationStore.updateIndex({ lastMessageId: lastKept?.id || null });

      return {
        archivedCount: out.archivedMessages,
        extractedCount: out.extractedCount,
      };
    } catch {
      return null;
    }
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
  async *query({ prompt, promptParts = null, messages = [], signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId, vpPlan, groupAnnouncement, userAlreadyPersisted = false, getCurrentTodos = null, setCurrentTodos = null } = {}) {
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
      yield* this.#runQuery({ prompt: effectivePrompt, promptParts, messages, signal: runSignal, userEffort: effectiveUserEffort, scenario, vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId, vpPlan, groupAnnouncement, userAlreadyPersisted, getCurrentTodos, setCurrentTodos });
    } finally {
      if (signal) {
        try { signal.removeEventListener('abort', onExternalAbort); } catch { /* ignore */ }
      }
      // Clear current-run state so engine.isRunning flips back to false
      // and a subsequent query() starts with a clean slate.
      this.#currentAbortCtrl = null;
      this.#abortReason = null;
    }
  }

  /**
   * Internal: the original query loop body. Split out of `query()` so the
   * public method can own the per-run AbortController + abort lifecycle
   * in a try/finally without indenting the whole loop.
   * @private
   */
  async *#runQuery({ prompt, promptParts = null, messages, signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId, vpPlan, groupAnnouncement, userAlreadyPersisted = false, getCurrentTodos = null, setCurrentTodos = null }) {

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
      groupId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
    });
    recallEntryCount = recallResult && Array.isArray(recallResult.entries)
      ? recallResult.entries.length
      : 0;
    if (recallEntryCount > 0) {
      yield { type: 'recall', entryCount: recallEntryCount, cached: false };
    }

    // Layer-A summaries — same scopes AMS Resident will surface, loaded
    // here so we can pass them into #prepareAms. (Rolling per-scope
    // synopsis maintained by the dream tick.) Failures are non-fatal.
    const summaries = await this.#loadLayerASummaries({
      groupId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
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
      groupId,
      ownVpId: ownVpIdForAms,
      summaries,
      recallEntries: recallResult ? (recallResult.entries || []) : [],
    });
    if (amsContext && amsContext.snapshotBlock) {
      memoryInjection = amsContext.snapshotBlock;
    }

    // ─── Active Scope (DESIGN-PROMPT §3 ④) ──────────────────────
    // Structured per-turn scope summary: group + vp + envelope routing
    // info. Long-form scope content lives in AMS — this block carries
    // only IDs + tiny labels. (Feature scope retired 2026-05-13.)
    const activeScope = {
      groupId: groupId || '',
      vpId: ownVpIdForAms || '',
      envelope: inboundEnvelope || null,
    };

    const systemPrompt = this.#buildSystemPrompt({
      prompt,
      memoryInjection,
      vpPersona,
      activeScope,
      groupAnnouncement,
    });

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
    const finalUserContent = (Array.isArray(promptParts) && promptParts.length > 0)
      ? promptParts
      : prompt;
    const conversationMessages = [
      ...compactMessages,
      ...messages,
      { role: 'user', content: finalUserContent },
    ];

    // PR-L: T2 carry-forward. If a previous query()'s end-of-turn
    // reflection has resolved, rewrite that turn's range in
    // `conversationMessages` to a single assistant reflection message.
    // If still pending, fall back to the exec-log stub — non-blocking,
    // never wait. This runs BEFORE the first adapter.stream so the
    // upcoming call sees the rewritten history.
    yield* this.#applyPendingT2Reflections(conversationMessages, prompt);

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
      userPrompt: userQuestionPreview,
      vpId: queryVpId,
      groupId: groupId || null,
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

    const toolDefs = this.#getToolDefs();
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
        yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber };
        yield { type: 'turn_end', turnNumber, stopReason: 'aborted' };
        break;
      }

      const turnId = this.#trace.startTurn({
        traceId: this.#traceId,
        turnNumber,
      });

      const startTime = Date.now();
      let ttfbMs = null;  // Time to first token
      let responseText = '';
      const toolCalls = [];
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

      yield { type: 'turn_start', turnNumber };

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
        });

        // Emit `loop` event for error path too (was `debug_turn`).
        const errLoopInputTokens = totalUsage.inputTokens || 0;
        const errLoopOutputTokens = totalUsage.outputTokens || 0;
        yield {
          type: 'loop',
          turnId: queryTurnId,
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
          yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber };
          yield { type: 'turn_end', turnNumber, stopReason: 'aborted' };
          break;
        }

        // ─── LLMContextError → force compact → retry ──────
        if (err instanceof LLMContextError && this.#conversationStore) {
          const consolidated = await this.#maybeConsolidate();
          if (consolidated && consolidated.archivedCount > 0) {
            yield { type: 'consolidate', archivedCount: consolidated.archivedCount, extractedCount: consolidated.extractedCount };
            yield { type: 'turn_end', turnNumber, stopReason: 'context_overflow_retry' };
            continue; // retry with fewer messages
          }
        }

        // ─── Fallback model ──────────────────────────────
        const fallbackModel = this.#config.fallbackModel;
        if (fallbackModel && fallbackModel !== currentModel &&
            (err.name === 'LLMRateLimitError' || err.name === 'LLMServerError')) {
          yield { type: 'fallback', from: currentModel, to: fallbackModel, reason: err.message };
          currentModel = fallbackModel;
          yield { type: 'turn_end', turnNumber, stopReason: 'fallback_retry' };
          continue; // retry with fallback model
        }

        yield {
          type: 'error',
          error: err,
          retryable: err.name === 'LLMRateLimitError' || err.name === 'LLMServerError',
        };
        yield { type: 'turn_end', turnNumber, stopReason: 'error' };
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
        yield { type: 'turn_end', turnNumber, stopReason: 'max_tokens_continue' };
        continue; // loop back to call adapter again
      }

      // If no tool calls, we're done
      if (stopReason !== 'tool_use' || toolCalls.length === 0) {
        yield { type: 'turn_end', turnNumber, stopReason };

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
            groupId,
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
          this.#persistMessages(prompt, fullResponseText, assistantMsg.toolCalls, groupId, userAlreadyPersisted);

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
              groupKey: amsContext.groupKey,
              added: adjustResult.added,
              evicted: adjustResult.evicted,
              skipped: adjustResult.skipped || 0,
              reason: adjustResult.reason,
            };
          }
        }

        // PR-L: T2 end-of-turn (asynchronous) reflection. Fires when the
        // total tool count for this query() exceeds TURN_SUMMARY_THRESHOLD
        // (5) AND no T1 has actually rewritten the arc yet. Kicks off the
        // primary-model call without await; the next query()'s
        // `#applyPendingT2Reflections` carries the result forward.
        //
        // Periodic-T1 fix: gate on `t1CollapsesDone === 0`, NOT
        // `lastT1AtToolCount === 0`. The catch block of T1 bumps
        // `lastT1AtToolCount` after a reflector error to avoid
        // tight-loop retries — but no collapse happened, so T2 should
        // still be allowed to fall back at end_turn. Fowler-review
        // critical finding.
        if (queryToolCount > TURN_SUMMARY_THRESHOLD && t1CollapsesDone === 0) {
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
        inboundEnvelope,
        taskId,
        taskMembers,
        vpPersona,
        contextWindow: currentContextWindow,
        getCurrentTodos,
        setCurrentTodos,
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
          ? this.#toolRegistry.has(tc.name)
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
              const rawOutput = await tool.execute(tc.input, { signal });
              // task-704b: legacy #tools branch must apply the same per-tool
              // cap as ToolRegistry.execute. Otherwise a deployment using
              // the legacy registration path bypasses the defense entirely.
              output = truncateToolResultIfNeeded(rawOutput, {
                contextWindow: currentContextWindow,
                toolName: tc.name,
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
        const handoffDetail = typeof endTurnRequested === 'object'
          ? endTurnRequested
          : { kind: 'tool_handoff', reason: String(endTurnRequested) };
        yield {
          type: 'turn_end',
          turnNumber,
          stopReason: 'tool_handoff',
          detail: handoffDetail,
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
      if (t1BatchDue && !abortedDuringTools && !signal?.aborted) {
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
        yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber };
        yield { type: 'turn_end', turnNumber, stopReason: 'aborted' };
        break;
      }

      yield { type: 'turn_end', turnNumber, stopReason: 'tool_use' };

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
    return MAIN_THREAD_ID;
  }

  /** @returns {string|null} */
  get yeaftDir() { return this.#yeaftDir; }

  /** @returns {object} — Config with fastModel as model (for internal tasks) */
  get fastConfig() { return this.#fastConfig; }

  /**
   * Run a one-shot fast-model call to produce a compact summary.
   * Used by the web bridge's in-memory history compactor
   * (`agent/unify/history-compact.js`) — kept on the engine so callers
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
