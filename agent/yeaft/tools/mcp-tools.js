/**
 * mcp-tools.js — MCP (Model Context Protocol) tool bridge
 *
 * Provides TWO surfaces for exposing MCP tools to the LLM:
 *
 *   1. **Flattened tools (preferred)** — every MCP tool is registered as a
 *      first-class entry in the ToolRegistry under the canonical
 *      `mcp__<server>__<originalToolName>` name (Claude Code convention).
 *      The LLM sees these in its tool catalogue and can call them in a
 *      single turn — no `mcp_list_tools` / `mcp_call_tool` indirection.
 *      Use `buildMcpFlattenedTools(mcpManager)` to obtain the registration
 *      array, then `toolRegistry.registerAll(...)`. Hot-reload after a
 *      server connect/disconnect via `toolRegistry.replaceMcpTools(mcpManager)`.
 *
 *   2. **Meta tools (back-compat / fallback)** — `mcp_list_tools` and
 *      `mcp_call_tool` are still exported as standalone ToolDefs. They are
 *      NOT in the default tool registry anymore; a caller can opt them
 *      back in by importing and registering them explicitly. Kept for any
 *      external integration that depends on the old indirection shape.
 *
 * Reference: yeaft-yeaft-design.md §8
 */

import { defineTool } from './types.js';

// ─── Constants ─────────────────────────────────────────────

/**
 * Cap each flattened MCP tool's description at this many characters when
 * registering. The system-prompt tool catalogue inflates linearly with
 * description length and the LLM doesn't need 2KB of vendor-prose per
 * tool — the inputSchema is what tells it how to call. 256 is enough to
 * communicate intent for ~all real-world MCP tools and bounds worst-case
 * prompt growth at `256 * num_mcp_tools` chars.
 */
const MAX_DESCRIPTION_LENGTH = 256;

/**
 * Truncate a description for the tool catalogue.
 * @param {string} desc
 * @returns {string}
 */
function truncateDescription(desc) {
  const s = String(desc || '');
  if (s.length <= MAX_DESCRIPTION_LENGTH) return s;
  return s.slice(0, MAX_DESCRIPTION_LENGTH - 1) + '…';
}

/**
 * Best-effort serialize an MCP tool result into a string the engine can
 * forward as a tool_result message. MCP's standard `content` array of
 * `{type:'text', text}` parts is concatenated; anything else falls back
 * to JSON.
 *
 * @param {unknown} result
 * @returns {string}
 */
function formatMcpResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    const textParts = result.content
      .filter(c => c && c.type === 'text')
      .map(c => c.text);
    if (textParts.length > 0) return textParts.join('\n');
  }
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// ─── Flatten builder (preferred surface) ───────────────────

/**
 * Build a `defineTool(...)` registration for every tool exposed by the
 * given MCPManager. Tools are named `mcp__<server>__<originalName>`
 * matching Claude Code's convention so an LLM that's seen this pattern
 * before treats them identically across hosts.
 *
 * The execute function captures the MANAGER reference (not the individual
 * server / tool entry) so that even if the user disconnects and
 * reconnects the underlying server between registration and call, the
 * lookup goes through `mcpManager.callTool(fullName, ...)` and finds the
 * fresh connection.
 *
 * Token-budget note: descriptions are truncated to MAX_DESCRIPTION_LENGTH
 * chars before being attached. The full description stays accessible to
 * code via mcpManager.listTools() if a future feature wants it.
 *
 * @param {import('../mcp.js').MCPManager} mcpManager
 * @returns {import('./types.js').ToolDef[]}
 */
export function buildMcpFlattenedTools(mcpManager) {
  if (!mcpManager || typeof mcpManager.listTools !== 'function') {
    return [];
  }

  const tools = mcpManager.listTools();
  return tools.map(t => {
    // mcpManager.listTools() returns entries shaped as
    //   { name: '<server>__<tool>', server: '<server>', description, inputSchema }
    // Pull the original tool name from the suffix; the manager's callTool
    // expects the full `server__tool` name.
    const fullName = t.name;
    const flattenedName = `mcp__${fullName}`;

    return defineTool({
      name: flattenedName,
      description: truncateDescription(
        t.description || `MCP tool ${fullName.split('__').slice(1).join('__')} from server ${t.server}`
      ),
      parameters: t.inputSchema || { type: 'object', properties: {} },
      async execute(input = {}, _ctx) {
        // Look up the manager fresh on each call. We deliberately don't
        // close over a server reference — hot-reload may have replaced
        // the connection since registration.
        //
        // Errors are THROWN, not stringified into the result. The engine's
        // tool-execution catch (engine.js: `catch (err) { output = 'Error: …';
        // isError = true; }`) turns thrown errors into a `tool_result` with
        // `is_error: true` so the LLM sees an error signal rather than a
        // plausible-looking JSON blob it might mistake for normal output.
        if (!mcpManager || typeof mcpManager.callTool !== 'function') {
          throw new Error(`MCP manager not available for ${flattenedName}`);
        }
        const result = await mcpManager.callTool(fullName, input || {});
        return formatMcpResult(result);
      },
    });
  });
}

// ─── Meta tools (legacy / fallback surface) ────────────────

export const mcpListTools = defineTool({
  name: 'mcp_list_tools',
  description: {
    en: `List all tools available from connected MCP (Model Context Protocol) servers.

Usage guidelines:
- Use to discover what MCP tools are available in the current session
- Returns tool names, descriptions, and parameter schemas from all connected MCP servers
- Each tool is prefixed with the server name (e.g. "github__list_prs", "slack__send_message")
- Use this before mcp_call_tool to understand available capabilities
- MCP servers are configured by the user — if none are connected, returns an empty list`,
    zh: `列出所有已连接 MCP（Model Context Protocol）服务器上可用的工具。

使用指南：
- 用于发现当前 session 中可用的 MCP 工具
- 返回所有已连接 MCP 服务器的工具名称、描述和参数 schema
- 每个工具以服务器名称为前缀（如 "github__list_prs"、"slack__send_message"）
- 在调用 mcp_call_tool 之前先用此工具了解可用能力
- MCP 服务器由用户配置 — 如果没有连接任何服务器，返回空列表`,
  },
  parameters: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: {
          en: 'Filter tools from a specific MCP server (optional)',
          zh: '按特定 MCP 服务器过滤工具（可选）',
        },
      },
    },
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const mcpManager = ctx?.mcpManager;

    if (!mcpManager || !mcpManager.hasServers) {
      return JSON.stringify({
        tools: [],
        message: 'No MCP servers are connected. Configure MCP servers in ~/.yeaft/config.json',
      });
    }

    const tools = mcpManager.listTools(input?.server || undefined);

    return JSON.stringify({
      tools: tools.map(t => ({
        name: t.name,
        server: t.server,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      totalCount: tools.length,
      servers: mcpManager.status(),
    }, null, 2);
  },
});

export const mcpCallTool = defineTool({
  name: 'mcp_call_tool',
  description: {
    en: `Call a tool on a connected MCP (Model Context Protocol) server.

Usage guidelines:
- Use after discovering tools via mcp_list_tools
- Provide the full tool name including server prefix (e.g. "github__create_issue")
- Arguments must match the tool's parameter schema exactly
- The tool executes on the MCP server and returns the result
- Timeouts depend on the MCP server — use timeout_ms if the operation is slow
- Errors from the MCP server are returned as structured error objects`,
    zh: `调用已连接 MCP（Model Context Protocol）服务器上的工具。

使用指南：
- 在通过 mcp_list_tools 发现工具后使用
- 提供完整的工具名称，包括服务器前缀（如 "github__create_issue"）
- 参数必须精确匹配工具的参数 schema
- 工具在 MCP 服务器上执行并返回结果
- 超时取决于 MCP 服务器 — 如果操作较慢可使用 timeout_ms
- MCP 服务器的错误以结构化错误对象返回`,
  },
  parameters: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: {
          en: 'Full tool name including server prefix (e.g. "github__list_prs")',
          zh: '完整工具名称，包括服务器前缀（如 "github__list_prs"）',
        },
      },
      arguments: {
        type: 'object',
        description: {
          en: 'Arguments to pass to the MCP tool (must match its schema)',
          zh: '传递给 MCP 工具的参数（必须匹配其 schema）',
        },
      },
      timeout_ms: {
        type: 'number',
        description: {
          en: 'Timeout in milliseconds (default: 30000)',
          zh: '超时时间，单位毫秒（默认 30000）',
        },
      },
    },
    required: ['tool_name'],
  },
  async execute(input, ctx) {
    const mcpManager = ctx?.mcpManager;

    if (!mcpManager || !mcpManager.hasServers) {
      // Same shape used by the meta tools historically — kept as a JSON
      // payload (NOT throw) because callers of `mcp_call_tool` already pattern-
      // match on the `error` field. Flattened tools (the preferred surface)
      // throw instead; see buildMcpFlattenedTools above.
      return JSON.stringify({
        error: 'No MCP servers are connected. Configure MCP servers in ~/.yeaft/config.json',
      });
    }

    const { tool_name, arguments: args = {}, timeout_ms } = input || {};

    if (!tool_name) {
      return JSON.stringify({ error: 'tool_name is required' });
    }

    try {
      const result = await mcpManager.callTool(tool_name, args, timeout_ms || 30000);
      return formatMcpResult(result);
    } catch (err) {
      return JSON.stringify({
        error: err.message,
        tool: tool_name,
      });
    }
  },
});

/**
 * Legacy default export: the meta tools as an array. Kept so any existing
 * caller doing `import mcpTools from './mcp-tools.js'` still works, but
 * `tools/index.js` no longer ships these in `createFullRegistry()`.
 * Flattened tools (preferred) are registered by `session.js` after the
 * MCPManager has connected to its servers.
 */
export default [mcpListTools, mcpCallTool];
