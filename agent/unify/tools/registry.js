/**
 * registry.js — Tool registration center for Yeaft Unify
 *
 * Manages tool registration and execution dispatch.
 * The engine uses this to get tool definitions for the LLM and to execute tool calls.
 *
 * NOTE (task-297): Mode-based filtering (chat/work) has been removed. Unify now runs as
 * a single unified mode where all registered tools are available. Tool definitions may
 * still carry a `modes` field, but the registry ignores it.
 */

import { formatSize } from '../archive/tool-results.js';
import { DEFAULT_CONTEXT_WINDOW } from '../models.js';

/**
 * Per-tool-result hard cap.
 *
 * A single tool can return megabytes (a grep over a large repo, a large
 * file read, a paginated web fetch). If we forward that verbatim into the
 * next LLM request the model returns LLMContextError ("context_length_exceeded")
 * and the user sees a hard failure mid-turn. Cap at a fraction of the
 * model's context window so even a runaway tool can't kill the request.
 *
 * Cap = max(MIN_CAP, floor(contextWindow * RATIO))
 *   - RATIO = 10%: leaves 90% of context for system prompt, history, the
 *     model's own output, and other tools called this turn. Generous in
 *     absolute terms (25.6 KB on a 256 K window, ~20 K on a 200 K window),
 *     plenty for a real tool result; small enough that 5 such results
 *     still fit alongside everything else.
 *   - MIN_CAP = 8 KB: sanity floor for tiny test fixtures (4 K context
 *     models in tests would otherwise cap at 409 chars, defeating the
 *     test's purpose). Real production models all have ≥ 32 K context, so
 *     the floor never bites in practice.
 *
 * The truncation lands HERE (not in engine.js when pushing tool results
 * into messages) so the UI's `tool_end` event, the exec log, AND the
 * model all see the same truncated content. Truncating later would mean
 * the user sees the full 2 MB output but the model gets a stub —
 * confusing.
 */
const TOOL_RESULT_CAP_RATIO = 0.10;
const TOOL_RESULT_MIN_CAP = 8 * 1024;

/**
 * Truncate a tool result if it exceeds the per-result cap. Non-string
 * outputs are JSON-stringified first (matching what engine.js eventually
 * pushes into `content`), then capped.
 *
 * Edge cases handled:
 *   - `undefined` → `JSON.stringify(undefined)` returns `undefined`, not
 *     a string, so we coerce to `'undefined'` and let the cap apply.
 *   - circular refs / `JSON.stringify` throws → fall back to `String(...)`.
 *
 * @param {unknown} output
 * @param {{ contextWindow?: number, toolName: string }} opts
 * @returns {string}
 */
export function truncateToolResultIfNeeded(output, { contextWindow, toolName }) {
  let text;
  if (typeof output === 'string') {
    text = output;
  } else {
    try {
      const json = JSON.stringify(output);
      text = typeof json === 'string' ? json : String(output);
    } catch {
      text = String(output);
    }
  }
  const ctx = Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const cap = Math.max(TOOL_RESULT_MIN_CAP, Math.floor(ctx * TOOL_RESULT_CAP_RATIO));
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  const marker = `\n\n[truncated: ${toolName} returned ${formatSize(text.length)}, capped at ${formatSize(cap)}; the model will not see the rest of this output]`;
  return head + marker;
}

export class ToolRegistry {
  /** @type {Map<string, import('./types.js').ToolDef>} */
  #tools = new Map();

  /**
   * Register a single tool.
   * @param {import('./types.js').ToolDef} tool
   * @returns {ToolRegistry}
   */
  register(tool) {
    if (!tool || !tool.name) throw new Error('Tool must have a name');
    this.#tools.set(tool.name, tool);
    return this;
  }

  /**
   * Register multiple tools.
   * @param {import('./types.js').ToolDef[]} tools
   * @returns {ToolRegistry}
   */
  registerAll(tools) {
    for (const tool of tools) this.register(tool);
    return this;
  }

  /**
   * Unregister a tool by name.
   * @param {string} name
   * @returns {ToolRegistry}
   */
  unregister(name) {
    this.#tools.delete(name);
    return this;
  }

  /**
   * Get a tool by name.
   * @param {string} name
   * @returns {import('./types.js').ToolDef | null}
   */
  get(name) {
    return this.#tools.get(name) || null;
  }

  /**
   * Check if a tool is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#tools.has(name);
  }

  /**
   * Get all registered tools (unfiltered).
   * @returns {import('./types.js').ToolDef[]}
   */
  getAllTools() {
    return Array.from(this.#tools.values());
  }

  /**
   * Get tool definitions for the LLM adapter.
   * Returns all registered tools — mode filtering was removed in task-297.
   * @returns {{ name: string, description: string, parameters: object }[]}
   */
  getToolDefs() {
    return this.getAllTools().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Get all registered tool names.
   * @returns {string[]}
   */
  getToolNames() {
    return Array.from(this.#tools.keys());
  }

  /**
   * Execute a tool by name.
   *
   * The result is passed through {@link truncateToolResultIfNeeded} so that
   * a single tool can never blow the context window. The cap derives from
   * `ctx.contextWindow` (the live model's window, threaded by engine.js);
   * fall back to a 200K default for callers that don't supply it.
   *
   * @param {string} name
   * @param {object} input
   * @param {import('./types.js').ToolContext} [ctx={}]
   * @returns {Promise<string>}
   */
  async execute(name, input, ctx = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const output = await tool.execute(input, ctx);
    return truncateToolResultIfNeeded(output, {
      contextWindow: ctx.contextWindow,
      toolName: name,
    });
  }

  /** Number of registered tools. */
  get size() {
    return this.#tools.size;
  }

  /** All registered tool names. */
  get names() {
    return Array.from(this.#tools.keys());
  }
}

/**
 * Create an empty registry.
 * @returns {ToolRegistry}
 */
export function createEmptyRegistry() {
  return new ToolRegistry();
}
