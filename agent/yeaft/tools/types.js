/**
 * types.js — Tool definition interface for Yeaft Yeaft
 *
 * All tools use the defineTool() function to create tool definitions.
 * This ensures consistent shape and API-format conversion.
 *
 * Reference: yeaft-yeaft-core-systems.md §3.1
 *
 * task-311: the legacy `modes` field (task-297 deprecated) is now fully
 * removed — Yeaft runs in a single unified mode.
 */

/**
 * @typedef {Object} ToolContext
 * @property {AbortSignal} [signal] — cancellation signal
 * @property {string} [yeaftDir] — Yeaft data directory
 * @property {Promise<Array> & {toolReady?: Record<string, Promise<object>>}} [managedCliReady] — resolves after optional managed CLI setup; toolReady exposes per-command readiness
 * @property {ReturnType<import('../runtime-platform.js').getRuntimePlatformInfo>} [runtimePlatform]
 *   — runtime OS/shell facts for platform-aware tools
 * @property {string} [cwd] — working directory
 * @property {import('../mcp.js').MCPManager} [mcpManager] — MCP manager
 * @property {object} [skillManager] — Skill manager
 * @property {object} [trace] — debug trace
 * @property {object} [config] — engine config
 * @property {(input: {query:string, cursor?:number, maxResults?:number}) => Promise<object>|object} [discoverTools] — page through hidden registered tool capabilities and activate returned entries for the next provider loop
 * @property {import('../tasks/manager.js').TaskManager} [taskManager] — Session task manager
 * @property {string} [sessionId] — current Session id
 * @property {string} [queryTurnId] — unique identity of the owning Engine query
 * @property {number} [historyBeforeSeq] — durable current-user boundary; default history recall excludes this sequence and later
 * @property {string[]} [projectSessionIds] — same-Agent sibling Session ids in the current Project
 * @property {string} [threadId] — current Session thread id
 * @property {string} [currentVpId] — R6: VP id of the caller (set in multi-VP groups)
 * @property {string} [currentGroupId] — R6: group id of the caller's RoleInstance
 * @property {(sessionId: string) => string[]|null} [getGroupRoster]
 *   — R6: resolve a group's roster (used by TaskCreate / route_forward to
 *   validate `members` ⊆ roster without importing group-store directly).
 * @property {number} [contextWindow] — current model's context window in
 *   tokens (used by ToolRegistry.execute to cap a single tool result at a
 *   fraction of the window so one runaway grep can't blow the wire).
 * @property {(input: {question:string, options?:string[]}, toolCall?: {id?:string, name?:string}|null) => Promise<object>} [askUser]
 *   — host-provided interactive prompt. Resolves only after the user answers.
 * @property {(reason?: string|object) => void} [requestEndTurn]
 *   — tool-callable signal that the current engine turn should end after
 *   this batch of tool calls completes (no follow-up adapter.stream call).
 *   Used by `route_forward` to hand off control to other VPs without
 *   continuing to generate. The engine wires this when it builds toolCtx
 *   and yields a `turn_end` event with `stopReason: 'tool_handoff'` and
 *   the supplied reason as `detail`. `reason` may be a structured object
 *   `{kind, ...}` so downstream observers (web-bridge) can render UI hints
 *   (e.g. "↪ 已转交给 @vp-b") without re-parsing strings.
 * @property {(reason?: string|object) => void} [requestToolBatchBarrier]
 *   — stop executing the remaining calls in the current assistant tool batch
 *   while still pairing each call with an explicit skipped tool result. The
 *   engine then returns those results to the provider before accepting another
 *   plan. Used when a completed tool result invalidates the rest of the batch.
 * @property {string} [senderVpId] — id of the VP whose turn is currently
 *   running. Used by `route_forward` to stamp the forwarded message and
 *   by the loop guard to key per-sender throttling.
 * @property {object} [inboundEnvelope] — the envelope that triggered this
 *   turn (sessionId / msgId / causedBy chain). Threaded into route_forward
 *   so causedBy chains extend correctly.
 * @property {object} [router] — per-group router (createRouter() output)
 *   for VP-to-VP forwarding. Set by the bridge when running inside a group.
 */

/**
 * @typedef {Object} ToolDef
 * @property {string} name — unique tool name (e.g. 'Bash', 'FileRead')
 * @property {string | { en: string, zh: string, default?: string }} description — LLM-facing localized description
 * @property {object} parameters — JSON Schema for input
 * @property {(input: object, ctx?: ToolContext) => Promise<string>} execute — execution function
 * @property {(input?: object) => boolean} [isConcurrencySafe] — can run in parallel?
 * @property {(input?: object) => boolean} [isReadOnly] — read-only operation?
 * @property {boolean | ((input?: object) => boolean)} [cacheWithinQuery] — explicitly safe to reuse for identical calls in one query
 * @property {boolean | ((input?: object) => boolean)} [mayMutateWorkspaceAfterReturn] — may keep changing the workspace after execute() resolves; disables same-query read reuse
 * @property {(input?: object) => boolean} [isDestructive] — destructive operation?
 * @property {(input?: object) => 'allow' | 'warn' | 'suppress'} [duplicateCallPolicy]
 *   — repeated exact-call policy for one query. Use `allow` for polling/time-varying
 *   tools and `suppress` only when the result is stable for the whole query.
 *   Errors are never counted as successful duplicates.
 * @property {'json-error-envelope' | null} [errorOutput] — explicit returned-output error contract; null means only thrown errors fail
 * @property {string} [mcpServer] — owning MCP server for flattened MCP tools
 * @property {'external' | 'run'} [sideEffectScope] — whether mutations escape the current Run collector
 */

/**
 * Define a tool with consistent defaults.
 *
 * @param {{
 *   name: string,
 *   description: string | { en: string, zh: string, default?: string },
 *   parameters: object,
 *   execute: (input: object, ctx?: ToolContext) => Promise<string>,
 *   isConcurrencySafe?: (input?: object) => boolean,
 *   isReadOnly?: (input?: object) => boolean,
 *   cacheWithinQuery?: boolean | ((input?: object) => boolean),
 *   mayMutateWorkspaceAfterReturn?: boolean | ((input?: object) => boolean),
 *   isDestructive?: (input?: object) => boolean,
 *   duplicateCallPolicy?: (input?: object) => 'allow' | 'warn' | 'suppress',
 *   errorOutput?: 'json-error-envelope' | null,
 *   mcpServer?: string,
 *   sideEffectScope?: 'external' | 'run',
 *   timeoutMs?: number,
 * }} def
 * @returns {ToolDef}
 */
export function defineTool({
  name,
  aliases,
  description,
  parameters,
  execute,
  isConcurrencySafe = () => false,
  isReadOnly = () => false,
  cacheWithinQuery = false,
  mayMutateWorkspaceAfterReturn = false,
  isDestructive = () => false,
  duplicateCallPolicy = () => 'warn',
  errorOutput = 'json-error-envelope',
  mcpServer,
  sideEffectScope = 'external',
  timeoutMs,
}) {
  if (!name) throw new Error('Tool must have a name');
  if (!execute) throw new Error(`Tool "${name}" must have an execute function`);

  const def = {
    name,
    description: description || `Tool: ${name}`,
    parameters: parameters || { type: 'object', properties: {} },
    execute,
    isConcurrencySafe,
    isReadOnly,
    cacheWithinQuery,
    mayMutateWorkspaceAfterReturn,
    isDestructive,
    duplicateCallPolicy,
    errorOutput,
    sideEffectScope,
  };
  // Legacy tool-name aliases. Registered as extra lookup keys so old
  // jsonl tool_calls (e.g. `SendMessage` → `PromptAgent`) keep resolving,
  // but excluded from the LLM-visible catalogue.
  if (Array.isArray(aliases) && aliases.length > 0) {
    def.aliases = aliases.slice();
  }
  if (typeof mcpServer === 'string' && mcpServer.trim()) {
    def.mcpServer = mcpServer.trim();
  }
  // Only attach `timeoutMs` when the tool author opts in. Leaving it
  // unset means ToolRegistry.execute uses DEFAULT_TOOL_TIMEOUT_MS — set
  // to <= 0 to disable the per-tool timeout entirely.
  if (Number.isFinite(timeoutMs)) {
    def.timeoutMs = timeoutMs;
  }
  return def;
}
