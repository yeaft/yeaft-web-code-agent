/**
 * mcp-flatten.test.js — MCP tool flattening + hot-swap registry
 *
 * Covers:
 *   (a) buildMcpFlattenedTools() shape & naming
 *       - one wrapper per MCP tool
 *       - canonical name `mcp__<server>__<tool>`
 *       - description truncated at MAX_DESCRIPTION_LENGTH
 *       - execute() routes through mcpManager.callTool(fullName, args)
 *       - errors are surfaced as JSON strings, not thrown
 *   (b) replaceMcpTools() hot-swap semantics
 *       - wipes only tools whose name starts with `mcp__`
 *       - leaves non-MCP tools alone
 *       - re-registers fresh from the injected builder
 *       - return shape {removed, added}
 *   (c) Disconnect path (manager returns fewer tools → swap drops them)
 */

import { describe, it, expect } from 'vitest';
import { buildMcpFlattenedTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';

/** Minimal mock that mimics the live `MCPManager.listTools()` contract. */
function makeMockManager(entries) {
  const calls = [];
  return {
    _calls: calls,
    listTools(filter) {
      const list = filter
        ? entries.filter(e => e.server === filter)
        : entries.slice();
      return list.map(e => ({
        name: `${e.server}__${e.tool}`,
        server: e.server,
        description: e.description,
        inputSchema: e.inputSchema,
      }));
    },
    async callTool(fullName, args) {
      calls.push({ fullName, args });
      const found = entries.find(e => `${e.server}__${e.tool}` === fullName);
      if (!found) throw new Error(`tool ${fullName} not found`);
      if (found.shouldThrow) throw new Error(found.shouldThrow);
      return found.returnValue ?? { content: [{ type: 'text', text: `ok:${fullName}` }] };
    },
    get hasServers() { return entries.length > 0; },
    get toolCount() { return entries.length; },
    status() { return []; },
  };
}

describe('buildMcpFlattenedTools — shape & naming', () => {
  it('produces one ToolDef per MCP tool with the mcp__server__tool name', () => {
    const mgr = makeMockManager([
      { server: 'github', tool: 'list_prs', description: 'List PRs', inputSchema: { type: 'object' } },
      { server: 'github', tool: 'create_issue', description: 'Open an issue', inputSchema: { type: 'object' } },
      { server: 'slack', tool: 'send_message', description: 'Send to a channel', inputSchema: { type: 'object' } },
    ]);

    const flat = buildMcpFlattenedTools(mgr);
    expect(flat).toHaveLength(3);
    const names = flat.map(t => t.name).sort();
    expect(names).toEqual([
      'mcp__github__create_issue',
      'mcp__github__list_prs',
      'mcp__slack__send_message',
    ]);
  });

  it('preserves the original inputSchema as the parameters field', () => {
    const mgr = makeMockManager([{
      server: 'srv',
      tool: 'foo',
      description: 'd',
      inputSchema: {
        type: 'object',
        required: ['target'],
        properties: { target: { type: 'string', description: 'where' } },
      },
    }]);
    const [tool] = buildMcpFlattenedTools(mgr);
    expect(tool.parameters).toEqual({
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string', description: 'where' } },
    });
  });

  it('truncates oversize descriptions at MAX_DESCRIPTION_LENGTH (256)', () => {
    const long = 'x'.repeat(1000);
    const mgr = makeMockManager([
      { server: 's', tool: 't', description: long, inputSchema: { type: 'object' } },
    ]);
    const [tool] = buildMcpFlattenedTools(mgr);
    // 256-cap with ellipsis marker — must NEVER exceed the cap length
    expect(tool.description.length).toBeLessThanOrEqual(256);
    expect(tool.description).toMatch(/…$/);
  });

  it('returns empty array when the manager is missing or has no listTools', () => {
    expect(buildMcpFlattenedTools(null)).toEqual([]);
    expect(buildMcpFlattenedTools({})).toEqual([]);
  });
});

describe('buildMcpFlattenedTools — execute() routing', () => {
  it('forwards calls to mcpManager.callTool with the full server__tool name', async () => {
    const mgr = makeMockManager([
      { server: 'github', tool: 'list_prs', description: 'd', inputSchema: { type: 'object' } },
    ]);
    const [tool] = buildMcpFlattenedTools(mgr);

    const result = await tool.execute({ owner: 'me', repo: 'r' });
    expect(mgr._calls).toEqual([{ fullName: 'github__list_prs', args: { owner: 'me', repo: 'r' } }]);
    expect(result).toBe('ok:github__list_prs');
  });

  it('throws so the engine can flag is_error=true on the tool_result', async () => {
    // Per Fowler review of PR #946: returning a JSON-stringified error
    // makes the LLM see a plausible-looking `{error: ...}` object as if it
    // were normal tool output. The engine catches throws (engine.js around
    // the tool execute call) and sets isError on the tool_result, which is
    // what the LLM actually pattern-matches on. So flattened tools throw.
    const mgr = makeMockManager([
      { server: 's', tool: 'boom', description: 'd', inputSchema: { type: 'object' }, shouldThrow: 'kaboom' },
    ]);
    const [tool] = buildMcpFlattenedTools(mgr);
    await expect(tool.execute({})).rejects.toThrow('kaboom');
  });

  it('throws the manager-not-available error if the manager loses callTool', async () => {
    // Build with a valid manager, then null out callTool after registration.
    const mgr = makeMockManager([
      { server: 's', tool: 'x', description: 'd', inputSchema: { type: 'object' } },
    ]);
    const [tool] = buildMcpFlattenedTools(mgr);
    mgr.callTool = null;
    await expect(tool.execute({})).rejects.toThrow(/MCP manager not available for mcp__s__x/);
  });
});

describe('ToolRegistry.replaceMcpTools — hot-swap semantics', () => {
  it('returns {removed, added} counts on first registration', () => {
    const reg = new ToolRegistry();
    const mgr = makeMockManager([
      { server: 'a', tool: 'one', description: 'd', inputSchema: { type: 'object' } },
      { server: 'b', tool: 'two', description: 'd', inputSchema: { type: 'object' } },
    ]);

    const result = reg.replaceMcpTools(mgr, buildMcpFlattenedTools);
    expect(result.removed).toBe(0);
    expect(result.added).toBe(2);
    expect(reg.has('mcp__a__one')).toBe(true);
    expect(reg.has('mcp__b__two')).toBe(true);
  });

  it('wipes ONLY tools whose name starts with mcp__ on swap', () => {
    const reg = new ToolRegistry();
    // Pre-register a non-MCP tool
    reg.register(defineTool({
      name: 'bash',
      description: 'shell',
      parameters: { type: 'object' },
      execute: async () => 'ok',
    }));

    const mgr = makeMockManager([
      { server: 'a', tool: 'one', description: 'd', inputSchema: { type: 'object' } },
    ]);
    reg.replaceMcpTools(mgr, buildMcpFlattenedTools);

    // Now disconnect everything and swap again with an empty manager.
    const empty = makeMockManager([]);
    const result = reg.replaceMcpTools(empty, buildMcpFlattenedTools);
    expect(result.removed).toBe(1);  // the mcp__a__one
    expect(result.added).toBe(0);

    // Non-MCP tool untouched
    expect(reg.has('bash')).toBe(true);
    expect(reg.has('mcp__a__one')).toBe(false);
  });

  it('reflects a connect→disconnect cycle on the live registry', () => {
    const reg = new ToolRegistry();
    const mgr = makeMockManager([
      { server: 'github', tool: 'a', description: 'd', inputSchema: { type: 'object' } },
      { server: 'github', tool: 'b', description: 'd', inputSchema: { type: 'object' } },
    ]);
    reg.replaceMcpTools(mgr, buildMcpFlattenedTools);
    expect(reg.getToolNames().filter(n => n.startsWith('mcp__'))).toHaveLength(2);

    // "Disconnect" → swap with empty manager
    const empty = makeMockManager([]);
    reg.replaceMcpTools(empty, buildMcpFlattenedTools);
    expect(reg.getToolNames().filter(n => n.startsWith('mcp__'))).toHaveLength(0);

    // Reconnect with a different shape
    const fresh = makeMockManager([
      { server: 'github', tool: 'a', description: 'd', inputSchema: { type: 'object' } },
      { server: 'slack', tool: 'send', description: 'd', inputSchema: { type: 'object' } },
    ]);
    reg.replaceMcpTools(fresh, buildMcpFlattenedTools);
    expect(reg.has('mcp__github__a')).toBe(true);
    expect(reg.has('mcp__slack__send')).toBe(true);
    expect(reg.has('mcp__github__b')).toBe(false);
  });

  it('handles a missing manager gracefully (removes existing, adds none)', () => {
    const reg = new ToolRegistry();
    reg.replaceMcpTools(makeMockManager([
      { server: 's', tool: 't', description: 'd', inputSchema: { type: 'object' } },
    ]), buildMcpFlattenedTools);
    expect(reg.has('mcp__s__t')).toBe(true);

    const result = reg.replaceMcpTools(null, buildMcpFlattenedTools);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(0);
    expect(reg.has('mcp__s__t')).toBe(false);
  });
});
