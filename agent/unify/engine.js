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
import { LLMContextError } from './llm/adapter.js';
import { recall } from './memory/recall.js';
import { shouldConsolidate, consolidate } from './memory/consolidate.js';
import { runStopHooks } from './stop-hooks.js';

/** Maximum number of turns before the engine stops to prevent infinite loops. */
const MAX_TURNS = 25;

/** Maximum auto-continue turns when stopReason is 'max_tokens'. */
const MAX_CONTINUE_TURNS = 3;

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
   * Unregister a tool.
   *
   * @param {string} name
   */
  unregisterTool(name) {
    this.#tools.delete(name);
  }

  /**
   * Get the list of registered tool definitions (for passing to the adapter).
   * Prefers ToolRegistry (mode-aware) when available, falls back to legacy #tools Map.
   *
   * @param {string} [mode]
   * @returns {import('./llm/adapter.js').UnifiedToolDef[]}
   */
  #getToolDefs(mode) {
    if (this.#toolRegistry) {
      return this.#toolRegistry.getToolDefs(mode || 'chat');
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
   * @param {string} mode
   * @param {{ profile?: string, entries?: object[] }} [memory]
   * @param {string} [compactSummary]
   * @param {string} [prompt] — user prompt (for skill relevance matching)
   * @returns {string}
   */
  #buildSystemPrompt(mode, memory, compactSummary, prompt) {
    // Get relevant skill content if SkillManager is wired
    let skillContent = '';
    if (this.#skillManager && prompt) {
      skillContent = this.#skillManager.getRelevantPromptContent(prompt, mode);
    }

    // Get tool names from the appropriate source
    const toolNames = this.#toolRegistry
      ? this.#toolRegistry.getToolNames(mode || 'chat')
      : Array.from(this.#tools.keys());

    return buildSystemPrompt({
      language: this.#config.language || 'en',
      mode,
      toolNames,
      memory,
      compactSummary,
      skillContent,
    });
  }

  /**
   * Build the full tool context for Phase 5 tools.
   *
   * @param {AbortSignal} [signal]
   * @param {string} [mode]
   * @returns {object}
   */
  #buildToolContext(signal, mode) {
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
      mode,
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
   *
   * @param {string} userContent
   * @param {string} assistantContent
   * @param {string} mode
   * @param {object[]} [toolCalls]
   */
  #persistMessages(userContent, assistantContent, mode, toolCalls) {
    if (!this.#conversationStore) return;

    // Persist user message
    this.#conversationStore.append({
      role: 'user',
      content: userContent,
      mode,
    });

    // Persist assistant message
    const assistantMsg = {
      role: 'assistant',
      content: assistantContent,
      mode,
      model: this.#config.model,
    };
    if (toolCalls && toolCalls.length > 0) {
      assistantMsg.toolCalls = toolCalls;
    }
    this.#conversationStore.append(assistantMsg);
  }

  /**
   * Check and trigger consolidation if needed.
   *
   * @returns {Promise<{ archivedCount: number, extractedCount: number }|null>}
   */
  async #maybeConsolidate() {
    if (!this.#conversationStore || !this.#memoryStore) return null;

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
   * @param {{ prompt: string, mode?: string, messages?: Array, signal?: AbortSignal }} params
   * @yields {EngineEvent}
   */
  async *query({ prompt, mode = 'chat', messages = [], signal }) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      yield {
        type: 'error',
        error: new Error('prompt is required and must be a non-empty string'),
        retryable: false,
      };
      return;
    }

    // ─── Pre-query: Recall + Compact Summary ────────────────
    const memory = await this.#recallMemory(prompt);
    if (memory && memory.entries.length > 0) {
      yield { type: 'recall', entryCount: memory.entries.length, cached: false };
    }

    const compactSummary = this.#getCompactSummary();
    const systemPrompt = this.#buildSystemPrompt(mode, memory, compactSummary, prompt);

    // Build conversation: existing messages + new user message
    const conversationMessages = [
      ...messages,
      { role: 'user', content: prompt },
    ];

    const toolDefs = this.#getToolDefs(mode);
    let turnNumber = 0;
    let continueTurns = 0; // auto-continue counter
    let fullResponseText = '';
    let currentModel = this.#config.model;

    while (true) {
      turnNumber++;

      // Safety: prevent infinite loops
      if (turnNumber > MAX_TURNS) {
        yield {
          type: 'error',
          error: new Error(`Max turns (${MAX_TURNS}) reached — stopping to prevent infinite loop`),
          retryable: false,
        };
        break;
      }

      const turnId = this.#trace.startTurn({
        traceId: this.#traceId,
        mode,
        turnNumber,
      });

      const startTime = Date.now();
      let responseText = '';
      const toolCalls = [];
      let stopReason = 'end_turn';
      const totalUsage = { inputTokens: 0, outputTokens: 0 };

      yield { type: 'turn_start', turnNumber };

      try {
        // Stream from adapter
        for await (const event of this.#adapter.stream({
          model: currentModel,
          system: systemPrompt,
          messages: [...conversationMessages],
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          maxTokens: this.#config.maxOutputTokens || 16384,
          signal,
        })) {
          switch (event.type) {
            case 'text_delta':
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
          messages: conversationMessages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 50000) : m.content })),
          response: responseText || `Error: ${err.message}`,
          toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
          usage: { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens },
          latencyMs,
          stopReason: 'error',
        };

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
      yield {
        type: 'debug_turn',
        turnNumber,
        model: currentModel,
        systemPrompt,
        messages: conversationMessages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 50000) : m.content })),
        response: responseText,
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
        usage: { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens },
        latencyMs,
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
        if (this.#yeaftDir && this.#conversationStore) {
          // Full pipeline: persist + consolidate + dream gate
          // Note: stopHooks uses fastConfig for consolidation/dream (cheaper internal tasks)
          // but receives both configs — messages are persisted with primary model name
          const hookResult = await runStopHooks({
            yeaftDir: this.#yeaftDir,
            mode,
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
          this.#persistMessages(prompt, fullResponseText, mode, assistantMsg.toolCalls);

          const consolidated = await this.#maybeConsolidate();
          if (consolidated && consolidated.archivedCount > 0) {
            yield { type: 'consolidate', archivedCount: consolidated.archivedCount, extractedCount: consolidated.extractedCount };
          }
        }

        break;
      }

      // Execute tool calls and feed results back
      const toolCtx = this.#buildToolContext(signal, mode);

      for (const tc of toolCalls) {
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
          yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true };
        } else {
          try {
            yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input };
            if (this.#toolRegistry) {
              output = await this.#toolRegistry.execute(tc.name, tc.input, toolCtx);
            } else {
              const tool = this.#tools.get(tc.name);
              output = await tool.execute(tc.input, { signal });
            }
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: false };
          } catch (err) {
            output = `Error: ${err.message}`;
            isError = true;
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true };
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

      yield { type: 'turn_end', turnNumber, stopReason: 'tool_use' };

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

  /** @returns {string|null} */
  get yeaftDir() { return this.#yeaftDir; }

  /** @returns {object} — Config with fastModel as model (for internal tasks) */
  get fastConfig() { return this.#fastConfig; }
}
