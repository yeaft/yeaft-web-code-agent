/**
 * registry.js — Tool registration center for Yeaft Yeaft
 *
 * Manages tool registration and execution dispatch.
 * The engine uses this to get tool definitions for the LLM and to execute tool calls.
 *
 * NOTE (task-297): Mode-based filtering (chat/work) has been removed. Yeaft now runs as
 * a single unified mode where all registered tools are available. Tool definitions may
 * still carry a `modes` field, but the registry ignores it.
 */


/**
 * Collaboration tools are mutually exclusive per Yeaft group shape:
 * single-VP groups use sub-agents; multi-VP groups use VP-to-VP forwarding.
 * Keep the policy names close to the tool registry so LLM exposure and
 * execution gating use the same source of truth.
 */
export const COLLAB_TOOL_POLICY = Object.freeze({
  SINGLE_VP: 'single-vp',
  MULTI_VP: 'multi-vp',
});

export const SUB_AGENT_TOOL_NAMES = Object.freeze([
  'SpawnAgent',
  'PromptAgent',
  'WaitAgent',
  'CloseAgent',
  'ListAgents',
]);

export const FORWARD_TOOL_NAMES = Object.freeze(['RouteForward']);

/**
 * Convert a tool result into the exact string form stored in conversation
 * messages. This deliberately does not truncate: live LLM requests, debug
 * display, and persisted messages must preserve the full tool output. Any
 * shortening belongs to history display/replay surfaces.
 *
 * @param {unknown} output
 * @returns {string}
 */
export function stringifyToolOutput(output) {
  if (typeof output === 'string') return output;
  try {
    const json = JSON.stringify(output);
    return typeof json === 'string' ? json : String(output);
  } catch {
    return String(output);
  }
}
function normalizeLanguage(language) {
  return String(language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function localizeVisibleText(value, language, toolName) {
  const lang = normalizeLanguage(language);
  if (typeof value === 'function') return localizeVisibleText(value(lang), lang, toolName);
  if (value && typeof value === 'object') {
    const picked = value[lang] || value[lang === 'zh' ? 'zh-CN' : 'en-US'] || value.en || value.default;
    if (typeof picked === 'string') return picked;
  }
  const text = typeof value === 'string' ? value : String(value || '');
  if (lang !== 'zh') return text;
  if (!text.trim()) return text;
  return [
    `工具说明：${toolName || '该工具'}。请严格按照 schema 调用；工具名、参数名、JSON key 和枚举值保持英文，不要翻译。`,
    `原始协议说明（英文，供精确调用参考）：${text}`,
  ].join('\n');
}

/**
 * Walk a JSON Schema `parameters` object and localize the human-readable
 * `description` strings to the requested language. All other schema bits
 * (`type`, `enum`, `required`, `items`, nested `properties`, etc.) are
 * preserved by value.
 *
 * Critical correctness rule: a JSON Schema can have a *property named*
 * `description` whose value is itself a sub-schema (e.g.
 * `properties: { description: { type: 'string', description: 'Detailed...' }}`).
 * In that case the OUTER `description` key holds the sub-schema and must
 * be recursed into; only the INNER `description: 'Detailed...'` value
 * (which is a string) should be localized.
 *
 * Previous bug: this walker localized ANY value under a `description`
 * key, including sub-schema objects. `localizeVisibleText` then ran
 * `String(value)` on the object, producing the literal string
 * `'[object Object]'`. GPT-5's strict schema validator rejected the
 * resulting `{ description: '[object Object]' }` with
 * `"'[object Object]' is not of type 'object', 'boolean'"`. This made
 * FeatureCreate (and any tool whose schema contains a property named
 * `description`) unusable in zh locale on strict providers.
 *
 * The fix: only treat a `description` value as localizable text when it
 * is actually a string. Object/array values under a `description` key
 * are sub-schemas and must be recursed into normally.
 */
function localizeParameters(parameters, language, toolName) {
  const lang = normalizeLanguage(language);
  if (lang !== 'zh' || !parameters || typeof parameters !== 'object') return parameters;
  if (Array.isArray(parameters)) return parameters.map(v => localizeParameters(v, lang, toolName));
  const out = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key === 'description' && typeof value === 'string') {
      out[key] = localizeVisibleText(value, lang, toolName);
    } else if (value && typeof value === 'object') {
      out[key] = localizeParameters(value, lang, toolName);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Per-tool execution timeout (ms).
 *
 * Without a timeout, a tool whose `execute()` ignores `signal` (or hangs on
 * a network call that doesn't honor AbortSignal) blocks the engine
 * generator's `await this.#toolRegistry.execute(...)` forever. The for-await
 * in the bridge driver never advances → no further events emitted → no
 * `turn_end` → typing dots hang → user sees the conversation "halt" with
 * no terminal event. The bridge's 120s watchdog calls `vpAbort.abort()`
 * but a tool that ignores signal also ignores the abort, so the abort
 * does nothing.
 *
 * Fix: race the tool's promise against a timer. On timeout we throw a
 * loud error — the engine's existing catch (engine.js: tool-execute path)
 * emits `tool_end{isError:true}` and the loop continues normally. Loud
 * failure beats silent stall.
 *
 * 90s is comfortably above the typical tool budget (most tools complete
 * in <1s; bash and web-fetch can run tens of seconds; web-search is
 * usually <10s) but well below the 120s bridge-level watchdog so the
 * tool-level signal fires first and surfaces a useful per-tool diagnosis
 * rather than an opaque "VP stalled" log.
 *
 * Override per-tool by setting `tool.timeoutMs` on the ToolDef. Set to
 * 0 (or a negative number) to disable the timeout for that tool — only
 * use this for legitimately long-running internal tools.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

/**
 * Error thrown when a tool's execute() exceeds its timeout. Carries the
 * tool name + budget so the engine's catch path (and the resulting
 * `tool_end{isError:true}` event) can surface a precise diagnostic to
 * the user instead of a generic stall.
 */
export class ToolExecutionTimeoutError extends Error {
  constructor(toolName, timeoutMs) {
    super(`Tool "${toolName}" did not complete within ${timeoutMs}ms`);
    this.name = 'ToolExecutionTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a timer. If the promise resolves first, return its
 * value. If the timer wins, throw {@link ToolExecutionTimeoutError}. The
 * underlying tool promise is intentionally NOT cancelled — JS has no
 * cooperative promise cancellation, so a tool that ignores `signal` will
 * keep running in the background; we just stop waiting on it. The engine
 * sees a clean error and the user sees `tool_end{isError:true}` instead
 * of an indefinite hang.
 *
 * Internal helper — not exported. The default and overrides are managed
 * via {@link DEFAULT_TOOL_TIMEOUT_MS} and `tool.timeoutMs`.
 *
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @param {string} toolName
 * @returns {Promise<unknown>}
 */
function runWithTimeout(promise, timeoutMs, toolName) {
  let timer = null;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ToolExecutionTimeoutError(toolName, timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

export function normalizeCollabToolPolicy(policy) {
  if (policy === COLLAB_TOOL_POLICY.SINGLE_VP || policy === COLLAB_TOOL_POLICY.MULTI_VP) {
    return policy;
  }
  return null;
}

export function isToolHiddenByCollabPolicy(toolName, policy) {
  const normalized = normalizeCollabToolPolicy(policy);
  if (!normalized) return false;
  if (normalized === COLLAB_TOOL_POLICY.SINGLE_VP) return FORWARD_TOOL_NAMES.includes(toolName);
  return SUB_AGENT_TOOL_NAMES.includes(toolName);
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
    // Legacy-name aliases: keep historical jsonl tool_calls resolvable
    // after a rename. The alias entry shares the same tool object so
    // execute/has lookups succeed, but `getToolDefs()` dedupes by tool
    // identity so the LLM only sees the canonical name.
    if (Array.isArray(tool.aliases)) {
      for (const alias of tool.aliases) {
        if (typeof alias === 'string' && alias && alias !== tool.name) {
          this.#tools.set(alias, tool);
        }
      }
    }
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
   *
   * Dedupes alias entries — when a tool is registered with `aliases`,
   * the same ToolDef object lives at multiple Map keys. We return each
   * tool object at most once (under its canonical `tool.name`).
   * @returns {import('./types.js').ToolDef[]}
   */
  getAllTools() {
    const seen = new Set();
    const out = [];
    for (const tool of this.#tools.values()) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      out.push(tool);
    }
    return out;
  }

  /**
   * Get tool definitions for the LLM adapter.
   * Returns all registered tools unless a collaboration policy hides one of
   * the mutually-exclusive orchestration tool families.
   * @param {string} [language='en']
   * @param {{ collabToolPolicy?: string }} [opts]
   * @returns {{ name: string, description: string, parameters: object }[]}
   */
  getToolDefs(language = 'en', opts = {}) {
    const lang = normalizeLanguage(language);
    const collabToolPolicy = normalizeCollabToolPolicy(opts?.collabToolPolicy);
    return this.getAllTools()
      .filter(t => !isToolHiddenByCollabPolicy(t.name, collabToolPolicy))
      .map(t => ({
        name: t.name,
        description: localizeVisibleText(t.description, lang, t.name),
        parameters: localizeParameters(t.parameters, lang, t.name),
      }));
  }

  /**
   * Check whether a tool may be called under the current collaboration policy.
   * Unknown / absent policy keeps the historical behavior: all registered
   * tools remain callable.
   * @param {string} name
   * @param {{ collabToolPolicy?: string }} [opts]
   * @returns {boolean}
   */
  isAllowed(name, opts = {}) {
    const tool = this.#tools.get(name);
    if (!tool) return false;
    return !isToolHiddenByCollabPolicy(tool.name, opts?.collabToolPolicy);
  }

  /**
   * Get all registered tool names (canonical only — aliases are excluded
   * so debug surfaces like the tool-stats panel show one row per tool).
   * @returns {string[]}
   */
  getToolNames() {
    return this.getAllTools().map(t => t.name);
  }

  /**
   * Execute a tool by name.
   *
   * Tool results are returned in full. Live LLM requests, debug display, and
   * persisted conversation rows must not lose data; truncation belongs only
   * to history display/replay surfaces.
   *
   * @param {string} name
   * @param {object} input
   * @param {import('./types.js').ToolContext} [ctx={}]
   * @returns {Promise<string>}
   */
  async execute(name, input, ctx = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    // Per-tool timeout. A tool that ignores `signal` and never resolves
    // would otherwise hang the engine's `await this.#toolRegistry.execute(...)`
    // indefinitely — see DEFAULT_TOOL_TIMEOUT_MS docblock for the
    // motivating "silent turn stall" failure. The race throws a typed
    // error on timeout; the engine's existing catch turns it into
    // `tool_end{isError:true}` and the loop continues.
    const rawTimeout = Number.isFinite(tool.timeoutMs) ? tool.timeoutMs : DEFAULT_TOOL_TIMEOUT_MS;
    const useTimeout = rawTimeout > 0;

    const output = useTimeout
      ? await runWithTimeout(tool.execute(input, ctx), rawTimeout, name)
      : await tool.execute(input, ctx);

    return stringifyToolOutput(output);
  }

  /** Number of registered tools. */
  get size() {
    return this.getAllTools().length;
  }

  /** All registered tool names (canonical only; aliases excluded). */
  get names() {
    return this.getAllTools().map(t => t.name);
  }

  /**
   * Hot-swap the flattened MCP tool set.
   *
   * Removes every currently registered tool whose canonical name starts
   * with `mcp__` (the flattened MCP tool naming convention used by
   * `buildMcpFlattenedTools()`), then re-registers a fresh set built from
   * the live MCPManager. Called by the MCP web-bridge after a successful
   * connect/disconnect/reload so the running engine's next turn sees the
   * new tool catalogue without needing a full session restart.
   *
   * Why "starts with `mcp__`": that prefix is the canonical Claude Code
   * naming for flattened MCP tools. It cleanly distinguishes them from
   * built-in tools (Bash, FileRead, etc.) and from the legacy meta-tools
   * (`mcp_list_tools`, `mcp_call_tool` — single underscore, NOT removed
   * here) which a caller may still opt into.
   *
   * @param {import('../mcp.js').MCPManager} mcpManager
   * @param {(mgr: import('../mcp.js').MCPManager) => import('./types.js').ToolDef[]} buildFlattened
   *   — the builder from `./mcp-tools.js`. Injected so this registry file
   *   stays free of circular `import` to mcp-tools.js (mcp-tools imports
   *   `defineTool` from types.js, which lives alongside this file).
   * @returns {{ removed: number, added: number }}
   */
  replaceMcpTools(mcpManager, buildFlattened) {
    let removed = 0;
    for (const name of [...this.#tools.keys()]) {
      if (name.startsWith('mcp__')) {
        this.#tools.delete(name);
        removed += 1;
      }
    }
    let added = 0;
    if (typeof buildFlattened === 'function' && mcpManager) {
      const fresh = buildFlattened(mcpManager) || [];
      for (const tool of fresh) {
        this.register(tool);
        added += 1;
      }
    }
    return { removed, added };
  }
}

/**
 * Create an empty registry.
 * @returns {ToolRegistry}
 */
export function createEmptyRegistry() {
  return new ToolRegistry();
}
