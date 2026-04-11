/**
 * registry.js — Tool registration center for Yeaft Unify
 *
 * Manages tool registration, mode-based filtering, and execution dispatch.
 * The engine uses this to get tool definitions for the LLM and to execute tool calls.
 */

/**
 * Mode normalization map.
 * 'coordinator' and 'worker' inherit 'work' tools.
 * 'dream' has no tools by design (returns empty).
 */
const MODE_ALIASES = {
  coordinator: 'work',
  worker: 'work',
};

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
   * Resolve a mode to its effective tool mode.
   * @param {string} mode
   * @returns {string}
   */
  static resolveMode(mode) {
    return MODE_ALIASES[mode] || mode;
  }

  /**
   * Get all tools available in a given mode.
   * @param {string} mode
   * @returns {import('./types.js').ToolDef[]}
   */
  getToolsForMode(mode) {
    const effectiveMode = ToolRegistry.resolveMode(mode);
    const result = [];
    for (const [, tool] of this.#tools) {
      if (tool.modes.includes(effectiveMode)) result.push(tool);
    }
    return result;
  }

  /**
   * Get tool definitions for the LLM adapter.
   * @param {string} mode
   * @returns {{ name: string, description: string, parameters: object }[]}
   */
  getToolDefs(mode) {
    return this.getToolsForMode(mode).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Get tool names available in a given mode.
   * @param {string} mode
   * @returns {string[]}
   */
  getToolNames(mode) {
    return this.getToolsForMode(mode).map(t => t.name);
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
