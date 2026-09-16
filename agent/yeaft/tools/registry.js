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

import { formatSize } from '../archive/tool-results.js';

/**
 * Collaboration tools are gated only where the session shape makes a tool
 * invalid. Single-VP sessions cannot forward to peers because no peers exist.
 * Multi-VP sessions keep the full tool surface, including background tasks and
 * sub-agents, and additionally expose VP-to-VP forwarding.
 */
export const COLLAB_TOOL_POLICY = Object.freeze({
  SINGLE_VP: 'single-vp',
  MULTI_VP: 'multi-vp',
});

export const FORWARD_TOOL_NAMES = Object.freeze(['RouteForward']);

/**
 * Per-tool-result model-context cap.
 *
 * A single tool can return megabytes (a grep over a large repo, a large file
 * read, a paginated web fetch). If we forward that verbatim into the next LLM
 * request, it bloats context and makes every replay expensive. Keep the
 * boundary small and deterministic for LLM message history: one tool result
 * gets a bounded slice before a visible truncation marker is appended.
 *
 * Do NOT apply this at tool execution time. Debug events, exec logs, and
 * persisted transcripts need the raw result. The engine/history replay path
 * applies this only when building messages for the model.
 */
export const TOOL_RESULT_MAX_BYTES = 32 * 1024;

function normalizeLanguage(language) {
  return String(language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function isLocalizedTextObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['en', 'zh', 'zh-CN', 'en-US', 'default'].some(key => typeof value[key] === 'string' || typeof value[key] === 'function');
}

export function localizeVisibleText(value, language, toolName) {
  const lang = normalizeLanguage(language);
  if (typeof value === 'function') return localizeVisibleText(value(lang), lang, toolName);
  if (isLocalizedTextObject(value)) {
    const picked = value[lang] || value[lang === 'zh' ? 'zh-CN' : 'en-US'] || value.en || value.default;
    if (typeof picked === 'string') return picked;
    if (typeof picked === 'function') return localizeVisibleText(picked(lang), lang, toolName);
  }
  // Legacy single-string descriptions are already authored text. Return them
  // unchanged; do not synthesize zh-prefixed wrappers around English strings.
  return typeof value === 'string' ? value : String(value || '');
}

/**
 * Walk a JSON Schema `parameters` object and localize human-readable
 * `description` values to the requested language. All other schema bits
 * (`type`, `enum`, `required`, `items`, nested `properties`, etc.) are
 * preserved by value.
 *
 * Critical correctness rule: a JSON Schema can have a *property named*
 * `description` whose value is itself a sub-schema (e.g.
 * `properties: { description: { type: 'string', description: { en, zh } }}`).
 * In that case the OUTER `description` key holds the sub-schema and must
 * be recursed into; only the INNER bilingual `description` value should
 * be localized.
 */
function cloneSchema(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneSchema);
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = cloneSchema(child);
  return out;
}

function schemaAtPath(schema, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let node = schema;
  for (const rawPart of parts) {
    const part = rawPart.endsWith('[]') ? rawPart.slice(0, -2) : rawPart;
    node = node?.properties?.[part];
    if (!node) return null;
    if (rawPart.endsWith('[]')) node = node.items;
  }
  return node || null;
}

function applyParameterOverrides(parameters, overrides) {
  if (!overrides || !parameters || typeof parameters !== 'object') return parameters;
  const out = cloneSchema(parameters);
  for (const [path, description] of Object.entries(overrides)) {
    const schema = schemaAtPath(out, path);
    if (schema && typeof description === 'string') schema.description = description;
  }
  return out;
}

function localizeParameters(parameters, language, toolName, parameterOverrides = null) {
  const lang = normalizeLanguage(language);
  if (!parameters || typeof parameters !== 'object') return parameters;
  if (Array.isArray(parameters)) return parameters.map(v => localizeParameters(v, lang, toolName));
  const out = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key === 'description' && (typeof value === 'string' || typeof value === 'function' || isLocalizedTextObject(value))) {
      out[key] = localizeVisibleText(value, lang, toolName);
    } else if (value && typeof value === 'object') {
      out[key] = localizeParameters(value, lang, toolName, null);
    } else {
      out[key] = value;
    }
  }
  return applyParameterOverrides(out, parameterOverrides);
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
 * loud error and the engine emits `tool_end{isError:true}`. Read-only and
 * run-scoped failures can continue normally; an external side-effecting tool
 * is terminal because its detached promise may still be running and replaying
 * or continuing beside it is unsafe. Either way the query emits a diagnostic
 * terminal boundary instead of silently stalling.
 *
 * 90s is comfortably above the typical tool budget (most tools complete in
 * <1s; web-fetch can run tens of seconds; web-search is usually <10s). Tools
 * with a longer owned deadline, such as Bash and WaitAgent, override this so
 * their own cancellation/timeout result reaches the model first.
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
 * Truncate a tool result if it exceeds the per-result cap. Non-string
 * outputs are JSON-stringified first (matching what engine.js eventually
 * pushes into `content`), then capped by UTF-8 byte length.
 *
 * Edge cases handled:
 *   - `undefined` → `JSON.stringify(undefined)` returns `undefined`, not
 *     a string, so we coerce to `'undefined'` and let the cap apply.
 *   - circular refs / `JSON.stringify` throws → fall back to `String(...)`.
 *
 * @param {unknown} output
 * @param {{ toolName: string, language?: string }} opts
 * @returns {string}
 */
export function normalizeToolOutput(output) {
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
  return text;
}

function parseToolErrorOutput(output) {
  const text = normalizeToolOutput(output).trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof parsed.error === 'string'
      && parsed.error.trim()
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function isToolErrorOutput(output) {
  return parseToolErrorOutput(output) !== null;
}

// Only an explicit, side-effect-free validation envelope qualifies. Runtime
// failures (network, tests, IO) must never be guessed to be invalid arguments.
export function toolValidationError(output) {
  const parsed = parseToolErrorOutput(output);
  return parsed?.code === 'invalid_arguments' && parsed.errorEffect === 'none'
    ? parsed.error : null;
}

export function toolErrorEffect(output) {
  return parseToolErrorOutput(output)?.errorEffect === 'none' ? 'none' : 'unknown';
}

function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function truncateToolResultIfNeeded(output, { toolName, language } = {}) {
  const text = normalizeToolOutput(output);
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= TOOL_RESULT_MAX_BYTES) return text;

  const markerFor = name => normalizeLanguage(language) === 'zh'
    ? `\n\n[已截断：${name} 返回 ${formatSize(originalBytes)}，上限为 ${formatSize(TOOL_RESULT_MAX_BYTES)}；原因：单个 tool result 超过 ${formatSize(TOOL_RESULT_MAX_BYTES)}，模型消息历史不会看到剩余内容]`
    : `\n\n[truncated: ${name} returned ${formatSize(originalBytes)}, capped at ${formatSize(TOOL_RESULT_MAX_BYTES)}; reason: single tool result exceeded ${formatSize(TOOL_RESULT_MAX_BYTES)}, the model message history will not see the rest]`;
  let marker = markerFor(String(toolName || 'tool'));
  if (Buffer.byteLength(marker, 'utf8') > TOOL_RESULT_MAX_BYTES) {
    const fixedMarker = markerFor('');
    const nameBudget = Math.max(0, TOOL_RESULT_MAX_BYTES - Buffer.byteLength(fixedMarker, 'utf8'));
    marker = markerFor(truncateUtf8(String(toolName || 'tool'), nameBudget));
  }
  marker = truncateUtf8(marker, TOOL_RESULT_MAX_BYTES);
  const contentBudget = Math.max(0, TOOL_RESULT_MAX_BYTES - Buffer.byteLength(marker, 'utf8'));
  if (toolName === 'Bash' && contentBudget > 256) {
    const omission = normalizeLanguage(language) === 'zh'
      ? '\n[中间输出省略；以下为末尾]\n' : '\n[Middle omitted; output tail follows]\n';
    const budget = contentBudget - Buffer.byteLength(omission, 'utf8');
    const headBudget = Math.floor(budget / 2);
    const buffer = Buffer.from(text, 'utf8');
    let start = buffer.length - (budget - headBudget);
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    return truncateUtf8(text, headBudget) + omission + buffer.subarray(start).toString('utf8') + marker;
  }
  return truncateUtf8(text, contentBudget) + marker;
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
  return normalized === COLLAB_TOOL_POLICY.SINGLE_VP && FORWARD_TOOL_NAMES.includes(toolName);
}

/**
 * Normalise an optional Agent-level plugin selection. Missing category fields
 * preserve historical behavior; explicit empty arrays disable that category.
 *
 * @param {object|null|undefined} plugins
 * @returns {{ tools: Set<string>|null, mcpServers: Set<string>|null }}
 */
export function normalizePluginToolPolicy(plugins) {
  const normalize = (value) => {
    if (!Array.isArray(value)) return null;
    return new Set(value
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => item.trim()));
  };
  return {
    tools: normalize(plugins?.tools),
    mcpServers: normalize(plugins?.mcpServers),
  };
}

/**
 * Check a canonical ToolDef against the Agent-level plugin selection. MCP
 * tools are controlled by server name; built-ins use their canonical name.
 */
export function isToolHiddenByPluginPolicy(tool, plugins) {
  if (!tool) return true;
  const policy = normalizePluginToolPolicy(plugins);
  if (tool.mcpServer) {
    return policy.mcpServers !== null && !policy.mcpServers.has(tool.mcpServer);
  }
  return policy.tools !== null && !policy.tools.has(tool.name);
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
   *
   * Registration and exposure are separate: `activeToolNames` limits which
   * canonical schemas enter this provider request, while aliases remain
   * registered for replay compatibility. Collaboration policy is an additional
   * structural fence (for example, RouteForward is invalid in single-VP
   * Sessions).
   *
   * @param {string} [language='en']
   * @param {{ collabToolPolicy?: string, plugins?: object, activeToolNames?: Set<string>|string[] }} [opts]
   * @returns {{ name: string, description: string, parameters: object }[]}
   */
  getToolDefs(language = 'en', opts = {}) {
    const lang = normalizeLanguage(language);
    const collabToolPolicy = normalizeCollabToolPolicy(opts?.collabToolPolicy);
    const activeToolNames = opts?.activeToolNames instanceof Set
      ? opts.activeToolNames
      : (Array.isArray(opts?.activeToolNames) ? new Set(opts.activeToolNames) : null);
    return this.getAllTools()
      .filter(t => !activeToolNames || activeToolNames.has(t.name))
      .filter(t => !isToolHiddenByCollabPolicy(t.name, collabToolPolicy))
      .filter(t => !isToolHiddenByPluginPolicy(t, opts?.plugins))
      .map(t => {
        return {
          name: t.name,
          description: localizeVisibleText(t.description, lang, t.name),
          parameters: localizeParameters(t.parameters, lang, t.name),
        };
      });
  }

  /**
   * Check whether a tool may be called under the current exposure and
   * collaboration policies. Unknown / absent policies keep the historical
   * behavior for direct registry callers.
   *
   * Aliases inherit the canonical tool's activation: an old `Agent` tool call
   * may execute only when canonical `SpawnAgent` is active for this request.
   *
   * @param {string} name
   * @param {{ collabToolPolicy?: string, plugins?: object, activeToolNames?: Set<string>|string[] }} [opts]
   * @returns {boolean}
   */
  isAllowed(name, opts = {}) {
    const tool = this.#tools.get(name);
    if (!tool) return false;
    const activeToolNames = opts?.activeToolNames instanceof Set
      ? opts.activeToolNames
      : (Array.isArray(opts?.activeToolNames) ? new Set(opts.activeToolNames) : null);
    if (activeToolNames && !activeToolNames.has(tool.name)) return false;
    return !isToolHiddenByCollabPolicy(tool.name, opts?.collabToolPolicy)
      && !isToolHiddenByPluginPolicy(tool, opts?.plugins);
  }

  /**
   * Get registered canonical tool names under an optional policy. Aliases are
   * excluded so debug surfaces still show one row per real tool.
   * @param {{ collabToolPolicy?: string, plugins?: object, activeToolNames?: Set<string>|string[] }} [opts]
   * @returns {string[]}
   */
  getToolNames(opts = {}) {
    const collabToolPolicy = normalizeCollabToolPolicy(opts?.collabToolPolicy);
    const activeToolNames = opts?.activeToolNames instanceof Set
      ? opts.activeToolNames
      : (Array.isArray(opts?.activeToolNames) ? new Set(opts.activeToolNames) : null);
    return this.getAllTools()
      .filter(t => !activeToolNames || activeToolNames.has(t.name))
      .filter(t => !isToolHiddenByCollabPolicy(t.name, collabToolPolicy))
      .filter(t => !isToolHiddenByPluginPolicy(t, opts?.plugins))
      .map(t => t.name);
  }

  /**
   * Execute a tool by name.
   *
   * Returns the raw tool result as text. Do not truncate here: debug display,
   * exec logs, and persistence must retain the full result. The engine/history
   * replay path truncates only the copy inserted into model message history.
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

    let output;
    try {
      output = useTimeout
        ? await runWithTimeout(tool.execute(input, ctx), rawTimeout, name)
        : await tool.execute(input, ctx);
    } catch (error) {
      if (error instanceof ToolExecutionTimeoutError
          && tool.sideEffectScope !== 'run'
          && tool.isReadOnly?.(input) !== true) {
        error.fatalToolTimeout = true;
      }
      throw error;
    }

    return normalizeToolOutput(output);
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
