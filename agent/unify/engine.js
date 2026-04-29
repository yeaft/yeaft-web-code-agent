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
import { recallR6, formatForInjection } from './memory/recall-r6.js';
import { recallV2 } from './memory/recall-v2.js';
import { partitionMessages } from './memory/consolidate.js';
import { extractMemories } from './memory/extract.js';
import { runCompact as runCompactOrchestrator } from './compact/orchestrator.js';
import { evaluateCompactTriggers } from './compact/triggers.js';
import { archiveTurn } from './archive/turn-archive.js';
import { archiveToolResults } from './archive/tool-results.js';
import { buildMemoryInjection } from './memory/layout.js';
import { buildUserProfile } from './memory/user-memory-store.js';
import { readSummary as readScopeSummary } from './memory/store-v2.js';
import { runStopHooks } from './stop-hooks.js';
import { getThreadStore, MAIN_THREAD_ID } from './threads/store.js';
import { pickEffort, parseEffortPrefix } from './effort.js';
import { normalizeEffort } from './models.js';
import { attachRouterPlan, extractPriorPlan, stripMetaForWire } from './router/continuity.js';
import { resolveThinking } from './router/thinking.js';
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
 * Content is truncated at 50000 chars; each tool_call input is JSON-stringified
 * + sliced at 10000 chars before being re-parsed, so a runaway `input` blob
 * can't blow past the WebSocket frame budget. Unknown roles pass through
 * unchanged.
 *
 * Pure function — no side effects on the input message.
 *
 * @param {{ role: string, content?: any, toolCalls?: Array, toolCallId?: string, isError?: boolean }} m
 * @returns {{ role: string, content: any, toolCalls?: Array, toolCallId?: string, isError?: boolean }}
 */
export function mapDebugMessage(m) {
  const out = { role: m.role };
  out.content = typeof m.content === 'string' ? m.content.slice(0, 50000) : m.content;
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    out.toolCalls = m.toolCalls.map(tc => {
      let input = tc.input;
      try {
        const s = JSON.stringify(input);
        if (typeof s === 'string' && s.length > 10000) {
          input = { __truncated: true, preview: s.slice(0, 10000) };
        }
      } catch {
        // Non-serializable input — fall through with raw reference; the
        // frontend's JSON.stringify will hit the same failure and replace
        // it with a placeholder string.
      }
      return { id: tc.id, name: tc.name, input };
    });
  }
  if (m.toolCallId) out.toolCallId = m.toolCallId;
  if (m.isError != null) out.isError = m.isError;
  return out;
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

  /** @type {import('./memory/store.js').MemoryStore|null} */
  #memoryStore;

  /** @type {object|null} — R6 memory shard store (task-334f) */
  #memoryShardStore;

  /** @type {import('./tools/registry.js').ToolRegistry|null} */
  #toolRegistry;

  /** @type {import('./skills.js').SkillManager|null} */
  #skillManager;

  /** @type {import('./mcp.js').MCPManager|null} */
  #mcpManager;

  /** @type {string|null} */
  #yeaftDir;

  /** @type {object|null} — Config override for internal tasks (recall, consolidation, dream) using fastModel */
  #fastConfig;

  /** @type {((agentId: string, evt: object) => void) | null} */
  #subAgentEventSink = null;

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

  /** @type {string|null} */
  #abortReason = null;

  /**
   * @param {{
   *   adapter: import('./llm/adapter.js').LLMAdapter,
   *   trace: object,
   *   config: object,
   *   conversationStore?: import('./conversation/persist.js').ConversationStore,
   *   memoryStore?: import('./memory/store.js').MemoryStore,
   *   toolRegistry?: import('./tools/registry.js').ToolRegistry,
   *   skillManager?: import('./skills.js').SkillManager,
   *   mcpManager?: import('./mcp.js').MCPManager,
   *   yeaftDir?: string,
   * }} params
   */
  constructor({ adapter, trace, config, conversationStore, memoryStore, memoryShardStore, toolRegistry, skillManager, mcpManager, yeaftDir }) {
    this.#adapter = adapter;
    this.#trace = trace;
    this.#config = config;
    this.#tools = new Map();
    this.#traceId = randomUUID();
    this.#conversationStore = conversationStore || null;
    this.#memoryStore = memoryStore || null;
    this.#memoryShardStore = memoryShardStore || null;
    this.#toolRegistry = toolRegistry || null;
    this.#skillManager = skillManager || null;
    this.#mcpManager = mcpManager || null;
    this.#yeaftDir = yeaftDir || null;

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
      return this.#toolRegistry.getToolDefs();
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
   * Build the system prompt with memory, compact summary, skill content,
   * and (Phase 8 wire-up) Layer-A scope summaries.
   *
   * Routes through `buildWorkerPrompt`, which:
   *   - Lays in the persona-as-identity block (or Yeaft identity fallback)
   *   - Concatenates Layer A summaries (`user/group/vp/summary.md`)
   *   - Reserves Layer B / C / D placeholders for future wiring (router
   *     preselected memory, task scope, turn scope)
   *
   * @param {{ profile?: string, entries?: object[] }} [memory]
   * @param {string} [compactSummary]
   * @param {string} [prompt] — user prompt (for skill relevance matching)
   * @param {string} [memoryInjection] — task-287: prebuilt memory block
   * @param {string} [userProfile] — user profile from user-memory shard store
   * @param {object} [vpPersona]
   * @param {{user?:string, group?:string, vp?:string}} [summaries]
   * @returns {string}
   */
  #buildSystemPrompt(memory, compactSummary, prompt, memoryInjection, userProfile, vpPersona, summaries) {
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
      memory,
      memoryInjection,
      compactSummary,
      skillContent,
      userProfile,
      vpPersona,
      summaries,
      // Worker-shape harness is descriptive metadata for human inspection;
      // production prompts skip it to save tokens. Re-enable via env when
      // diagnosing prompt structure issues.
      includeShape: process.env.UNIFY_PROMPT_INCLUDE_SHAPE === '1',
      // task-334f: memory_trace tool is now registered (49 → 51 tools), so
      // unlock the core_memory meta-line behind 334e's feature flag.
      memoryTraceAvailable: true,
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
      memoryStore: this.#memoryStore,
      memoryShardStore: this.#memoryShardStore,
      conversationStore: this.#conversationStore,
      adapter: this.#adapter,
      config: this.#config,
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
      inboundEnvelope: vpCtx?.inboundEnvelope,
      taskId: vpCtx?.taskId,
      taskMembers: vpCtx?.taskMembers,
      // Sub-agent plumbing — Agent tool needs these to spawn a child
      // Engine that inherits the parent's adapter / stores / toolset.
      parentEngineDeps: {
        adapter: this.#adapter,
        trace: this.#trace,
        config: this.#config,
        memoryStore: this.#memoryStore,
        memoryShardStore: this.#memoryShardStore,
        parentToolRegistry: this.#toolRegistry,
        skillManager: this.#skillManager,
        mcpManager: this.#mcpManager,
        yeaftDir: this.#yeaftDir,
        parentName: vpCtx?.senderVpId || 'parent',
        parentVpId: vpCtx?.senderVpId || null,
        parentVpPersona: vpCtx?.vpPersona || null,
        onEvent: this.#subAgentEventSink || null,
        language: this.#config?.language || 'en',
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
   * Routes:
   *   - config.memoryV2 === true → recall-v2 (per-scope memory.md + summary.md)
   *   - else → R6 shard-based recall (legacy)
   *
   * @param {string} prompt
   * @param {{ groupId?: string, vpId?: string, featureId?: string }} [ctx]
   * @returns {Promise<{ profile: string, entries: object[], formatted: string }|null>}
   */
  async #recallMemory(prompt, ctx = {}) {
    const memory = { profile: '', entries: [], formatted: '' };

    // ─── v2 path (DESIGN-v2) ───────────────────────────────────
    if (this.#config && this.#config.memoryV2 && this.#yeaftDir) {
      try {
        const result = await recallV2({
          prompt,
          root: `${this.#yeaftDir}/memory`,
          groupId: ctx.groupId,
          vpId: ctx.vpId,
          featureId: ctx.featureId,
        });
        memory.entries = result.sections || [];
        memory.formatted = result.formatted || '';
        // Profile concept: in v2 the user/memory.md IS the profile.
        const userSec = (result.sections || []).find(s => s.kind === 'user');
        memory.profile = userSec ? (userSec.summary || '') : '';
      } catch {
        // Fail soft — empty injection.
      }
      return memory;
    }

    // ─── R6 legacy path ────────────────────────────────────────
    // Build user profile from user-memory shard store (R6 path),
    // falling back to legacy readProfile if shard store unavailable.
    try {
      const profile = buildUserProfile(this.#memoryShardStore);
      if (profile) {
        memory.profile = profile;
      } else if (this.#memoryStore) {
        memory.profile = this.#memoryStore.readProfile();
      }
    } catch {
      // Non-critical — fall through to legacy
      if (this.#memoryStore) {
        try { memory.profile = this.#memoryStore.readProfile(); } catch { /* */ }
      }
    }

    // R6 shard-based recall (preferred path)
    if (this.#memoryShardStore) {
      try {
        const result = await recallR6({
          prompt,
          memoryShardStore: this.#memoryShardStore,
          adapter: this.#adapter,
          fastModel: this.#fastConfig?.model,
        });
        memory.entries = result.entries;
        memory.formatted = formatForInjection(result.entries);
      } catch {
        // Recall failure is non-critical
      }
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
   * @param {string} userContent
   * @param {string} assistantContent
   * @param {object[]} [toolCalls]
   */
  #persistMessages(userContent, assistantContent, toolCalls, groupId) {
    if (!this.#conversationStore) return;
    if (this.#config._readOnly) return;

    // task-299 Phase 1: tag persisted messages with the current thread.
    // getThreadStore() lazily seeds a default 'main' thread if not yet init'd.
    let threadId = MAIN_THREAD_ID;
    let threadStore = null;
    try {
      threadStore = getThreadStore();
      threadId = threadStore.currentId || MAIN_THREAD_ID;
    } catch {
      // Defensive: any store failure falls back to 'main' so persistence
      // never breaks because of thread bookkeeping.
    }

    // Persist user message
    this.#conversationStore.append({
      role: 'user',
      content: userContent,
      threadId,
      // Bug 6: stamp groupId so history replay can route by group.
      ...(groupId ? { groupId } : {}),
    });

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

    // task-299 Phase 1 cached-field update: bump thread counters twice
    // (once for user, once for assistant). Any exception is swallowed so
    // bookkeeping never blocks the main persist path.
    try {
      if (threadStore) {
        threadStore.noteMessage(threadId);
        threadStore.noteMessage(threadId);
      }
    } catch {
      // Non-critical; counters can be rebuilt via rebuildFromMessages().
    }
  }

  /**
   * Check and trigger consolidation if needed.
   * Skipped in read-only mode.
   *
   * @returns {Promise<{ archivedCount: number, extractedCount: number }|null>}
   */
  async #maybeConsolidate() {
    if (!this.#conversationStore || !this.#memoryStore) return null;
    if (this.#config._readOnly) return null;

    const budget = this.#config.messageTokenBudget || 8192;
    const compactCfg = (this.#config && this.#config.compact) || {};

    // Phase 8 PR-H followup: orchestrator is the only path. The legacy
    // shouldConsolidate / consolidate fallback was removed once parity
    // testing concluded. evaluateCompactTriggers (DESIGN §4.1) and
    // runCompact (DESIGN §4.2) own the live path.
    return this.#runOrchestratorCompact(budget, compactCfg);
  }

  /**
   * Phase 8 PR-D: run compact via the new orchestrator (DESIGN §4.2).
   * Hooks adapt the orchestrator's injectable contract to the existing
   * conversationStore / memoryStore primitives, so behaviour matches
   * the legacy `consolidate` path 1:1 while exercising the new
   * triggers / turn-group / orchestrator code on the live path.
   *
   * @param {number} budget
   * @param {object} compactCfg
   * @returns {Promise<{archivedCount:number, extractedCount:number}|null>}
   */
  async #runOrchestratorCompact(budget, _compactCfg) {
    const conversationStore = this.#conversationStore;
    const memoryStore = this.#memoryStore;
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

    // Use partitionMessages (the legacy primitive) to decide what is
    // "cooling": orchestrator's own keepHot is a count, but we want to
    // honour the token-budget partitioning the rest of the system uses.
    const { toArchive } = partitionMessages(messages, budget);
    if (toArchive.length === 0) return null;

    const archiveIds = [];

    const hooks = {
      summarise: async () => {
        // Reuse the legacy consolidate path's summary technique by
        // invoking adapter directly with a fresh prompt. We keep the
        // orchestrator's contract honoured: it takes the cooling slice
        // and returns a string.
        try {
          const result = await adapter.call({
            model: fastConfig.model,
            system: 'You are a conversation summarizer. Summarize concisely in 2–3 paragraphs, preserving decisions, facts, and context.',
            messages: [{ role: 'user', content: `Summarize:\n\n${toArchive.map(m => `[${m.role}] ${(m.content || '').slice(0, 500)}`).join('\n\n')}` }],
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
        // Phase 8 PR-E: persist the cooling turn to
        // <yeaftDir>/memory/archive/<turnId>.md so message_trace can
        // replay it later. Scope is "user/" by default — group/task
        // scoping is a follow-up that will arrive with multi-VP archive
        // routing. Best-effort: archive failure must not abort compact.
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
      extract: async (coolingMessages) => {
        try {
          const extracted = await extractMemories({
            messages: coolingMessages, adapter, config: fastConfig,
          });
          for (const e of extracted) memoryStore.writeEntry(e);
          if (extracted.length > 0) memoryStore.rebuildScopes();
          return { written: extracted.length };
        } catch {
          return { written: 0 };
        }
      },
    };

    try {
      const out = await runCompactOrchestrator({
        messages, keepHot: 10, hooks,
      });
      // Apply side effects to the conversation store: move archived
      // ids to cold, persist compact summary, update index.
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
   * @yields {EngineEvent}
   */
  async *query({ prompt, messages = [], signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId, vpPlan } = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      yield {
        type: 'error',
        error: new Error('prompt is required and must be a non-empty string'),
        retryable: false,
      };
      return;
    }

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
      yield* this.#runQuery({ prompt: effectivePrompt, messages, signal: runSignal, userEffort: effectiveUserEffort, scenario, vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId, vpPlan });
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
  async *#runQuery({ prompt, messages, signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, groupId, vpPlan }) {

    // ─── Pre-query: Memory Injection (task-287) + Compact Summary ──
    // Two-layer recall:
    //   1. Static memory index injection (buildMemoryInjection — always)
    //   2. R6 shard-based recall (recallR6 — when memoryShardStore is wired)
    // No per-turn fuzzy recall via old recall.js — LLM calls memory_load /
    // memory_query on demand (memory_search still works as a deprecated alias).
    let memoryInjection = '';
    let recallEntryCount = 0;
    if (this.#yeaftDir) {
      try {
        const entryCount = this.#memoryStore?.stats?.().entryCount ?? 0;
        memoryInjection = buildMemoryInjection({
          yeaftDir: this.#yeaftDir,
          cwd: process.cwd(),
          entryCount,
          language: this.#config.language || 'en',
        });
      } catch {
        // Injection failure is non-critical — fall back to empty.
      }
    }

    // R6 recall: append shard-based recall results to memory injection
    const recallResult = await this.#recallMemory(prompt, {
      groupId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
      featureId: typeof inboundEnvelope === 'object' && inboundEnvelope
        ? inboundEnvelope.featureId
        : undefined,
    });
    if (recallResult && recallResult.formatted) {
      memoryInjection = memoryInjection
        ? memoryInjection + '\n\n' + recallResult.formatted
        : recallResult.formatted;
      recallEntryCount = recallResult.entries.length;
    }

    if (memoryInjection) {
      yield { type: 'recall', entryCount: recallEntryCount, cached: false };
    }

    const compactSummary = this.#getCompactSummary();
    const userProfile = recallResult?.profile || '';

    // Phase 8 wire-up — Layer A scope summaries
    // Load `summary.md` for the user / addressed group / addressed VP from
    // the scoped memory tree (DESIGN.md §2). This is the rolling synopsis a
    // dream tick maintains; we surface it to the worker prompt so the LLM
    // has cheap, persistent context without paying the recall cost on every
    // turn. Failures are non-fatal (cold-start / no memory dir).
    const summaries = await this.#loadLayerASummaries({
      groupId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
    });

    const systemPrompt = this.#buildSystemPrompt(undefined, compactSummary, prompt, memoryInjection, userProfile, vpPersona, summaries);

    // Build conversation: existing messages + new user message
    const conversationMessages = [
      ...messages,
      { role: 'user', content: prompt },
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
    // we may collapse spans (turnStartIdx + 1 .. last assistant/tool).
    const turnStartIdx = conversationMessages.length - 1;
    let queryToolCount = 0;
    let t1Fired = false;
    const queryNumber = (this.#__queryCounter = (this.#__queryCounter || 0) + 1);

    const toolDefs = this.#getToolDefs();
    let turnNumber = 0;
    let continueTurns = 0; // auto-continue counter
    let toolLoopTurns = 0; // task-327b: tool-use turns for long-loop auto-bump
    let fullResponseText = '';
    let currentModel = this.#config.model;

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

        // Emit debug_turn for error path too
        yield {
          type: 'debug_turn',
          turnNumber,
          model: currentModel,
          systemPrompt,
          messages: conversationMessages.map(mapDebugMessage),
          response: responseText || `Error: ${err.message}`,
          toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
          usage: { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens },
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
        if (err instanceof LLMContextError && this.#conversationStore && this.#memoryStore) {
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

      // Emit debug_turn event for web UI debug panel
      // (conversationMessages does NOT yet include the assistant response at this point)
      // task-331: preserve toolCalls / toolCallId / isError on each message so
      // the Debug panel can render function_call requests and their paired
      // tool_result responses across turns.
      yield {
        type: 'debug_turn',
        turnNumber,
        model: currentModel,
        systemPrompt,
        messages: conversationMessages.map(mapDebugMessage),
        response: responseText,
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
        usage: { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens },
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
            memoryStore: this.#memoryStore,
            adapter: this.#adapter,
            config: this.#fastConfig,
            primaryModel: this.#config.model,
            messages: conversationMessages,
            trace: this.#trace,
            // Bug 6: tag persisted messages with the originating group so
            // history replay can re-stamp them on reload.
            groupId,
          });

          if (hookResult.consolidated) {
            yield { type: 'consolidate', archivedCount: 0, extractedCount: 0 };
          }
          if (hookResult.dreamTriggered) {
            yield { type: 'dream_triggered' };
          }
        } else {
          // Legacy path (no yeaftDir → use old behavior)
          this.#persistMessages(prompt, fullResponseText, assistantMsg.toolCalls, groupId);

          const consolidated = await this.#maybeConsolidate();
          if (consolidated && consolidated.archivedCount > 0) {
            yield { type: 'consolidate', archivedCount: consolidated.archivedCount, extractedCount: consolidated.extractedCount };
          }
        }

        // PR-L: T2 end-of-turn (asynchronous) reflection. Fires when the
        // total tool count for this query() exceeds TURN_SUMMARY_THRESHOLD
        // (5) AND T1 didn't already collapse the arc. Kicks off the
        // primary-model call without await; the next query()'s
        // `#applyPendingT2Reflections` carries the result forward.
        if (queryToolCount > TURN_SUMMARY_THRESHOLD && !t1Fired) {
          const arcStart = turnStartIdx + 1;
          const arcEnd = conversationMessages.length - 1;
          if (arcEnd > arcStart) {
            const { pairs, assistantText } = extractToolPairsFromRange(
              conversationMessages, arcStart, arcEnd,
            );
            yield {
              type: 'reflection',
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
      const toolCtx = this.#buildToolContext(signal, { router, senderVpId, inboundEnvelope, taskId, taskMembers, vpPersona });

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
              output = await tool.execute(tc.input, { signal });
            }
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: false, threadId: this.currentThreadId };
          } catch (err) {
            output = `Error: ${err.message}`;
            isError = true;
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true, threadId: this.currentThreadId };
          }
        }

        const toolDurationMs = Date.now() - toolStartTime;

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

      // PR-L: T1 in-turn (synchronous) reflection. Fires exactly once per
      // query() lifetime, the moment queryToolCount crosses
      // TOOL_BATCH_SIZE (13). Generates a markdown reflection over the
      // assistant+tool arc since the user prompt and rewrites the history
      // in place — collapsing it to a SINGLE assistant message — before
      // the next adapter.stream() runs.
      if (!t1Fired
          && queryToolCount >= TOOL_BATCH_SIZE
          && !this.#reflectedTurns.has(`${queryNumber}:t1`)
          && !abortedDuringTools && !signal?.aborted) {
        t1Fired = true;
        this.#reflectedTurns.add(`${queryNumber}:t1`);
        try {
          const arcStart = turnStartIdx + 1;
          const arcEnd = conversationMessages.length - 1;
          const { pairs, assistantText } = extractToolPairsFromRange(
            conversationMessages, arcStart, arcEnd,
          );
          yield {
            type: 'reflection',
            trigger: 't1',
            status: 'pending',
            loopRange: [arcStart, arcEnd],
            toolCount: pairs.length,
          };
          const { content, durationMs } = await runT1Reflection({
            adapter: this.#adapter,
            model: this.#config.model,
            originalUserMsg: prompt,
            toolPairs: pairs,
            assistantText,
            signal,
          });
          const next = collapseRangeToReflection(
            conversationMessages, arcStart, arcEnd, content,
          );
          conversationMessages.length = 0;
          for (const m of next) conversationMessages.push(m);
          yield {
            type: 'reflection',
            trigger: 't1',
            // PR-L bug fix: keep the same loopRange as the `pending` event
            // so the frontend key stays stable across pending → ready and
            // the spinner card is replaced in place (no orphan).
            status: 'ready',
            loopRange: [arcStart, arcEnd],
            toolCount: pairs.length,
            content,
            durationMs,
          };
        } catch (err) {
          // Best-effort. On failure leave history unchanged so the loop
          // continues normally — never block the turn.
          yield {
            type: 'reflection',
            trigger: 't1',
            status: 'error',
            error: err && err.message || String(err),
          };
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

  /**
   * Get the memory store (for external access, e.g., CLI commands).
   * @returns {import('./memory/store.js').MemoryStore|null}
   */
  get memoryStore() {
    return this.#memoryStore;
  }

  /** @returns {object|null} — R6 memory shard store (task-334f) */
  get memoryShardStore() {
    return this.#memoryShardStore;
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
    try {
      return getThreadStore().currentId || MAIN_THREAD_ID;
    } catch {
      return MAIN_THREAD_ID;
    }
  }

  /** @returns {string|null} */
  get yeaftDir() { return this.#yeaftDir; }

  /** @returns {object} — Config with fastModel as model (for internal tasks) */
  get fastConfig() { return this.#fastConfig; }
}
