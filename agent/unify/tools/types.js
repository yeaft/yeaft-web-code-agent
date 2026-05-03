/**
 * types.js — Tool definition interface for Yeaft Unify
 *
 * All tools use the defineTool() function to create tool definitions.
 * This ensures consistent shape and API-format conversion.
 *
 * Reference: yeaft-unify-core-systems.md §3.1
 *
 * task-311: the legacy `modes` field (task-297 deprecated) is now fully
 * removed — Unify runs in a single unified mode.
 */

/**
 * @typedef {Object} ToolContext
 * @property {AbortSignal} [signal] — cancellation signal
 * @property {string} [yeaftDir] — Yeaft data directory
 * @property {string} [cwd] — working directory
 * @property {import('../mcp.js').MCPManager} [mcpManager] — MCP manager
 * @property {object} [skillManager] — Skill manager
 * @property {object} [trace] — debug trace
 * @property {object} [config] — engine config
 * @property {string} [currentVpId] — R6: VP id of the caller (set in multi-VP groups)
 * @property {string} [currentGroupId] — R6: group id of the caller's RoleInstance
 * @property {(groupId: string) => string[]|null} [getGroupRoster]
 *   — R6: resolve a group's roster (used by TaskCreate / route_forward to
 *   validate `members` ⊆ roster without importing group-store directly).
 * @property {number} [contextWindow] — current model's context window in
 *   tokens (used by ToolRegistry.execute to cap a single tool result at a
 *   fraction of the window so one runaway grep can't blow the wire).
 */

/**
 * @typedef {Object} ToolDef
 * @property {string} name — unique tool name (e.g. 'Bash', 'FileRead')
 * @property {string} description — LLM-facing description
 * @property {object} parameters — JSON Schema for input
 * @property {(input: object, ctx?: ToolContext) => Promise<string>} execute — execution function
 * @property {(input?: object) => boolean} [isConcurrencySafe] — can run in parallel?
 * @property {(input?: object) => boolean} [isReadOnly] — read-only operation?
 * @property {(input?: object) => boolean} [isDestructive] — destructive operation?
 */

/**
 * Define a tool with consistent defaults.
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: object,
 *   execute: (input: object, ctx?: ToolContext) => Promise<string>,
 *   isConcurrencySafe?: (input?: object) => boolean,
 *   isReadOnly?: (input?: object) => boolean,
 *   isDestructive?: (input?: object) => boolean,
 * }} def
 * @returns {ToolDef}
 */
export function defineTool({
  name,
  description,
  parameters,
  execute,
  isConcurrencySafe = () => false,
  isReadOnly = () => false,
  isDestructive = () => false,
}) {
  if (!name) throw new Error('Tool must have a name');
  if (!execute) throw new Error(`Tool "${name}" must have an execute function`);

  return {
    name,
    description: description || `Tool: ${name}`,
    parameters: parameters || { type: 'object', properties: {} },
    execute,
    isConcurrencySafe,
    isReadOnly,
    isDestructive,
  };
}
