/**
 * engine.js — Yeaft query loop
 *
 * The engine is the core orchestrator:
 *   1. Build messages array
 *   2. Call adapter.stream()
 *   3. Collect text + tool_calls from stream events
 *   4. If tool_calls → execute tools → append results → goto 2
 *   5. If end_turn → done
 *   6. If max_tokens → done (Phase 2: auto-continue)
 *
 * Pattern derived from Claude Code's query loop (src/query.ts).
 */

import { randomUUID } from 'crypto';

/** Maximum number of turns before the engine stops to prevent infinite loops. */
const MAX_TURNS = 25;

// ─── Engine Events (superset of adapter events) ──────────────────

/**
 * @typedef {{ type: 'turn_start', turnNumber: number }} TurnStartEvent
 * @typedef {{ type: 'turn_end', turnNumber: number, stopReason: string }} TurnEndEvent
 * @typedef {{ type: 'tool_start', id: string, name: string, input: object }} ToolStartEvent
 * @typedef {{ type: 'tool_end', id: string, name: string, output: string, isError: boolean }} ToolEndEvent
 *
 * @typedef {import('./llm/adapter.js').StreamEvent | TurnStartEvent | TurnEndEvent | ToolStartEvent | ToolEndEvent} EngineEvent
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

  /**
   * @param {{ adapter: import('./llm/adapter.js').LLMAdapter, trace: object, config: object }} params
   */
  constructor({ adapter, trace, config }) {
    this.#adapter = adapter;
    this.#trace = trace;
    this.#config = config;
    this.#tools = new Map();
    this.#traceId = randomUUID();
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
   *
   * @returns {import('./llm/adapter.js').UnifiedToolDef[]}
   */
  #getToolDefs() {
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
   * Build the system prompt.
   *
   * @param {string} mode — 'chat' | 'work' | 'dream'
   * @returns {string}
   */
  #buildSystemPrompt(mode) {
    const parts = [
      'You are Yeaft, a helpful AI assistant.',
      `Current mode: ${mode}`,
      `Date: ${new Date().toISOString().split('T')[0]}`,
    ];

    if (mode === 'work') {
      parts.push(
        'You are in work mode. Break tasks into steps, execute them using tools, and report progress.',
      );
    } else if (mode === 'dream') {
      parts.push(
        'You are in dream mode. Reflect on past conversations and consolidate memories.',
      );
    }

    // List available tools
    if (this.#tools.size > 0) {
      const toolNames = Array.from(this.#tools.keys()).join(', ');
      parts.push(`Available tools: ${toolNames}`);
    }

    return parts.join('\n\n');
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
    const systemPrompt = this.#buildSystemPrompt(mode);

    // Build conversation: existing messages + new user message
    const conversationMessages = [
      ...messages,
      { role: 'user', content: prompt },
    ];

    const toolDefs = this.#getToolDefs();
    let turnNumber = 0;

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
        // Note: pass a snapshot of messages so later mutations don't affect the adapter
        for await (const event of this.#adapter.stream({
          model: this.#config.model,
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
        // Adapter threw an exception (network, auth, etc.)
        const latencyMs = Date.now() - startTime;
        this.#trace.endTurn(turnId, {
          model: this.#config.model,
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          stopReason: 'error',
          latencyMs,
          responseText,
        });

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
        model: this.#config.model,
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        stopReason,
        latencyMs,
        responseText,
      });

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

      // If no tool calls, we're done
      if (stopReason !== 'tool_use' || toolCalls.length === 0) {
        yield { type: 'turn_end', turnNumber, stopReason };
        break;
      }

      // Execute tool calls and feed results back
      for (const tc of toolCalls) {
        const tool = this.#tools.get(tc.name);
        const toolStartTime = Date.now();

        let output;
        let isError = false;

        if (!tool) {
          output = `Error: unknown tool "${tc.name}"`;
          isError = true;
          yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true };
        } else {
          try {
            yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input };
            output = await tool.execute(tc.input, { signal });
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
    return Array.from(this.#tools.keys());
  }
}
