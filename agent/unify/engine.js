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
import { buildSystemPrompt } from './prompts.js';
import { LLMContextError, LLMAbortError } from './llm/adapter.js';
import { recall } from './memory/recall.js';
import { shouldConsolidate, consolidate } from './memory/consolidate.js';
import { buildMemoryInjection } from './memory/layout.js';
import { runStopHooks } from './stop-hooks.js';
import { getThreadStore, MAIN_THREAD_ID } from './threads/store.js';
import { pickEffort, parseEffortPrefix } from './effort.js';
import { normalizeEffort } from './models.js';

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
  constructor({ adapter, trace, config, conversationStore, memoryStore, toolRegistry, skillManager, mcpManager, yeaftDir }) {
    this.#adapter = adapter;
    this.#trace = trace;
    this.#config = config;
    this.#tools = new Map();
    this.#traceId = randomUUID();
    this.#conversationStore = conversationStore || null;
    this.#memoryStore = memoryStore || null;
    this.#toolRegistry = toolRegistry || null;
    this.#skillManager = skillManager || null;
    this.#mcpManager = mcpManager || null;
    this.#yeaftDir = yeaftDir || null;

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
   * Build the system prompt with memory, compact summary, and skill content.
   *
   * @param {{ profile?: string, entries?: object[] }} [memory]
   * @param {string} [compactSummary]
   * @param {string} [prompt] — user prompt (for skill relevance matching)
   * @param {string} [memoryInjection] — task-287: prebuilt memory block (index + prefs + project)
   * @returns {string}
   */
  #buildSystemPrompt(memory, compactSummary, prompt, memoryInjection) {
    // Get relevant skill content if SkillManager is wired
    let skillContent = '';
    if (this.#skillManager && prompt) {
      skillContent = this.#skillManager.getRelevantPromptContent(prompt);
    }

    // Get tool names from the appropriate source
    const toolNames = this.#toolRegistry
      ? this.#toolRegistry.getToolNames()
      : Array.from(this.#tools.keys());

    return buildSystemPrompt({
      language: this.#config.language || 'en',
      toolNames,
      memory,
      memoryInjection,
      compactSummary,
      skillContent,
    });
  }

  /**
   * Build the full tool context for Phase 5 tools.
   *
   * @param {AbortSignal} [signal]
   * @returns {object}
   */
  #buildToolContext(signal) {
    return {
      signal,
      yeaftDir: this.#yeaftDir,
      cwd: process.cwd(),
      mcpManager: this.#mcpManager,
      skillManager: this.#skillManager,
      memoryStore: this.#memoryStore,
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
    };
  }

  /**
   * Perform memory recall for a given prompt.
   *
   * @param {string} prompt
   * @returns {Promise<{ profile: string, entries: object[] }|null>}
   */
  async #recallMemory(prompt) {
    if (!this.#memoryStore) return null;

    const memory = { profile: '', entries: [] };

    // Read user profile
    memory.profile = this.#memoryStore.readProfile();

    // Recall relevant entries (uses fastModel for cheaper/faster side-queries)
    try {
      const result = await recall({
        prompt,
        adapter: this.#adapter,
        config: this.#fastConfig,
        memoryStore: this.#memoryStore,
      });
      memory.entries = result.entries;
    } catch {
      // Recall failure is non-critical
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
  #persistMessages(userContent, assistantContent, toolCalls) {
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
    });

    // Persist assistant message
    const assistantMsg = {
      role: 'assistant',
      content: assistantContent,
      model: this.#config.model,
      threadId,
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
    if (!shouldConsolidate(this.#conversationStore, budget)) return null;

    try {
      const result = await consolidate({
        conversationStore: this.#conversationStore,
        memoryStore: this.#memoryStore,
        adapter: this.#adapter,
        config: this.#fastConfig,
        budget,
      });
      return { archivedCount: result.archivedCount, extractedCount: result.extractedEntries.length };
    } catch {
      // Consolidation failure is non-critical
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
  async *query({ prompt, messages = [], signal, userEffort = null, scenario = 'chat' }) {
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
      yield* this.#runQuery({ prompt: effectivePrompt, messages, signal: runSignal, userEffort: effectiveUserEffort, scenario });
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
  async *#runQuery({ prompt, messages, signal, userEffort = null, scenario = 'chat' }) {

    // ─── Pre-query: Memory Injection (task-287) + Compact Summary ──
    // New layout: always inject Memory Index + user-preferences + project
    // header excerpt. No per-turn fuzzy recall — LLM calls memory_load /
    // memory_query on demand (memory_search still works as a deprecated alias).
    let memoryInjection = '';
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
    if (memoryInjection) {
      yield { type: 'recall', entryCount: 0, cached: false };
    }

    const compactSummary = this.#getCompactSummary();
    const systemPrompt = this.#buildSystemPrompt(undefined, compactSummary, prompt, memoryInjection);

    // Build conversation: existing messages + new user message
    const conversationMessages = [
      ...messages,
      { role: 'user', content: prompt },
    ];

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

      yield { type: 'turn_start', turnNumber };

      try {
        // task-327b: resolve effort per-turn so the long-loop auto-bump
        // kicks in once toolLoopTurns crosses the threshold.
        const resolvedEffort = pickEffort({ scenario, toolLoopTurns, userEffort });

        // Stream from adapter
        for await (const event of this.#adapter.stream({
          model: currentModel,
          system: systemPrompt,
          messages: [...conversationMessages],
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          maxTokens: this.#config.maxOutputTokens || 16384,
          effort: resolvedEffort,
          signal,
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
          });

          if (hookResult.consolidated) {
            yield { type: 'consolidate', archivedCount: 0, extractedCount: 0 };
          }
          if (hookResult.dreamTriggered) {
            yield { type: 'dream_triggered' };
          }
        } else {
          // Legacy path (no yeaftDir → use old behavior)
          this.#persistMessages(prompt, fullResponseText, assistantMsg.toolCalls);

          const consolidated = await this.#maybeConsolidate();
          if (consolidated && consolidated.archivedCount > 0) {
            yield { type: 'consolidate', archivedCount: consolidated.archivedCount, extractedCount: consolidated.extractedCount };
          }
        }

        break;
      }

      // Execute tool calls and feed results back
      const toolCtx = this.#buildToolContext(signal);

      // task-325a: track whether we aborted mid tool-loop so we can
      // break out of the outer while-loop cleanly once the current
      // tool batch finishes reporting.
      let abortedDuringTools = false;

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

  /** @returns {import('./tools/registry.js').ToolRegistry|null} */
  get toolRegistry() { return this.#toolRegistry; }

  /** @returns {import('./skills.js').SkillManager|null} */
  get skillManager() { return this.#skillManager; }

  /** @returns {import('./mcp.js').MCPManager|null} */
  get mcpManager() { return this.#mcpManager; }

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
