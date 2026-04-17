/**
 * types.js — Tool definition interface for Yeaft Unify
 *
 * All tools use the defineTool() function to create tool definitions.
 * This ensures consistent shape and API-format conversion.
 *
 * Reference: yeaft-unify-core-systems.md §3.1
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
 */

/**
 * @typedef {Object} ToolDef
 * @property {string} name — unique tool name (e.g. 'Bash', 'FileRead')
 * @property {string} description — LLM-facing description
 * @property {object} parameters — JSON Schema for input
 * @property {(input: object, ctx?: ToolContext) => Promise<string>} execute — execution function
 * @property {string[]} [modes] — @deprecated since task-297. Legacy mode filter (['chat', 'work']).
 *   Unify no longer has mode distinction; the ToolRegistry ignores this field and exposes every
 *   registered tool to the engine. Retained only so existing tool definitions keep loading.
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
 *   modes?: string[],  // @deprecated since task-297 — ignored by ToolRegistry
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
  modes = ['chat', 'work'],
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
    modes,
    isConcurrencySafe,
    isReadOnly,
    isDestructive,
  };
}
