/**
 * mcp-tools.js — MCP (Model Context Protocol) tool bridge
 *
 * Provides two tools for interacting with MCP servers:
 * - mcp_list_tools: Discover available MCP tools from connected servers
 * - mcp_call_tool: Invoke an MCP tool by name with arguments
 *
 * These are exported as an array (unlike other tool files that export a single tool).
 *
 * Reference: yeaft-yeaft-design.md §8
 */

import { defineTool } from './types.js';

export const mcpListTools = defineTool({
  name: 'mcp_list_tools',
  description: `List all tools available from connected MCP (Model Context Protocol) servers.

Usage guidelines:
- Use to discover what MCP tools are available in the current session
- Returns tool names, descriptions, and parameter schemas from all connected MCP servers
- Each tool is prefixed with the server name (e.g. "github__list_prs", "slack__send_message")
- Use this before mcp_call_tool to understand available capabilities
- MCP servers are configured by the user — if none are connected, returns an empty list`,
  parameters: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'Filter tools from a specific MCP server (optional)',
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
        message: 'No MCP servers are connected. Configure MCP servers in ~/.yeaft/config.md',
      });
    }

    const tools = mcpManager.listTools(input.server || undefined);

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
  description: `Call a tool on a connected MCP (Model Context Protocol) server.

Usage guidelines:
- Use after discovering tools via mcp_list_tools
- Provide the full tool name including server prefix (e.g. "github__create_issue")
- Arguments must match the tool's parameter schema exactly
- The tool executes on the MCP server and returns the result
- Timeouts depend on the MCP server — use timeout_ms if the operation is slow
- Errors from the MCP server are returned as structured error objects`,
  parameters: {
    type: 'object',
    properties: {
      tool_name: {
        type: 'string',
        description: 'Full tool name including server prefix (e.g. "github__list_prs")',
      },
      arguments: {
        type: 'object',
        description: 'Arguments to pass to the MCP tool (must match its schema)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['tool_name'],
  },
  async execute(input, ctx) {
    const mcpManager = ctx?.mcpManager;

    if (!mcpManager || !mcpManager.hasServers) {
      return JSON.stringify({
        error: 'No MCP servers are connected. Configure MCP servers in ~/.yeaft/config.md',
      });
    }

    const { tool_name, arguments: args = {}, timeout_ms } = input;

    if (!tool_name) {
      return JSON.stringify({ error: 'tool_name is required' });
    }

    try {
      const result = await mcpManager.callTool(tool_name, args, timeout_ms || 30000);

      // Format MCP result
      if (result?.content) {
        // MCP standard response format
        const textParts = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text);
        if (textParts.length > 0) {
          return textParts.join('\n');
        }
      }

      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);

    } catch (err) {
      return JSON.stringify({
        error: err.message,
        tool: tool_name,
      });
    }
  },
});

// Default export as array for compatibility with bulk registration
export default [mcpListTools, mcpCallTool];
