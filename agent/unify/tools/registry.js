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
   * @param {string} name
   * @param {object} input
   * @param {import('./types.js').ToolContext} [ctx={}]
   * @returns {Promise<string>}
   */
  async execute(name, input, ctx = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(input, ctx);
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
