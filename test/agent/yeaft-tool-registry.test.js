import { describe, it, expect } from 'vitest';

/**
 * Tests for task-262: Yeaft session built-in tools not registered.
 *
 * Bug: session.js used createEmptyRegistry() and only manually registered
 * 5 tools (mcpTools[2] + skillTool + enterWorktree + exitWorktree).
 * All other built-in tools were missing from the registry.
 *
 * Fix: Created tools/index.js with createFullRegistry() that registers
 * all built-in tools, and session.js now uses it.
 */

describe('tools/index.js createFullRegistry', () => {
  it('createFullRegistry returns a registry with all built-in tools', async () => {
    const { createFullRegistry } = await import('../../agent/yeaft/tools/index.js');
    const registry = createFullRegistry();

    // Post H2-AMS rip + Feature system removal + TodoWrite addition.
    expect(registry.size).toBeGreaterThanOrEqual(28);
  });

  it('allTools array contains all built-in tools', async () => {
    const { allTools } = await import('../../agent/yeaft/tools/index.js');

    expect(allTools.length).toBeGreaterThanOrEqual(28);

    const names = allTools.map(t => t.name);
    // MCP meta-tools (`mcp_list_tools` / `mcp_call_tool`) were removed from
    // the default tool set in the Claude-Code-style MCP rework — they're
    // replaced by flattened `mcp__<server>__<tool>` tools registered at
    // session start (see session.js + tools/mcp-tools.js). The meta-tool
    // exports still live in tools/mcp-tools.js for back-compat callers,
    // they're just no longer part of the default registry.
    expect(names).not.toContain('mcp_list_tools');
    expect(names).not.toContain('mcp_call_tool');
    expect(names).toContain('Skill');
    expect(names).toContain('EnterWorktree');
    expect(names).toContain('ExitWorktree');
    expect(names).toContain('TodoWrite');
  });

  it('createFullRegistry no longer includes mcp meta-tools (replaced by flatten)', async () => {
    // The legacy `mcp_list_tools` / `mcp_call_tool` meta-tools forced a
    // two-call LLM dance per MCP tool invocation. They've been replaced by
    // flattened `mcp__<server>__<tool>` tools that the engine registers
    // at session bootstrap (after MCPManager.connectAll). The default
    // registry no longer carries them; session.js calls
    // ToolRegistry.replaceMcpTools(mcpManager, buildMcpFlattenedTools) to
    // populate them dynamically.
    const { createFullRegistry } = await import('../../agent/yeaft/tools/index.js');
    const registry = createFullRegistry();

    expect(registry.has('mcp_list_tools')).toBe(false);
    expect(registry.has('mcp_call_tool')).toBe(false);
  });

  it('createFullRegistry includes skill tool', async () => {
    const { createFullRegistry } = await import('../../agent/yeaft/tools/index.js');
    const registry = createFullRegistry();

    expect(registry.has('Skill')).toBe(true);
  });

  it('createFullRegistry includes worktree tools', async () => {
    const { createFullRegistry } = await import('../../agent/yeaft/tools/index.js');
    const registry = createFullRegistry();

    expect(registry.has('EnterWorktree')).toBe(true);
    expect(registry.has('ExitWorktree')).toBe(true);
  });

  it('extra tools can be added to the full registry', async () => {
    const { createFullRegistry } = await import('../../agent/yeaft/tools/index.js');
    const { defineTool } = await import('../../agent/yeaft/tools/types.js');

    const registry = createFullRegistry();
    const baseSz = registry.size;

    const customTool = defineTool({
      name: 'custom_test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
      modes: ['chat'],
      execute: async () => 'ok',
    });

    registry.register(customTool);
    expect(registry.size).toBe(baseSz + 1);
    expect(registry.has('custom_test_tool')).toBe(true);
  });
});

describe('session.js uses createFullRegistry', () => {
  it('session.js imports createFullRegistry from tools/index.js', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const rootDir = join(import.meta.dirname, '..', '..');
    const sessionJs = readFileSync(join(rootDir, 'agent/yeaft/session.js'), 'utf8');

    // Should import createFullRegistry from tools/index.js
    expect(sessionJs).toContain("import { createFullRegistry } from './tools/index.js'");

    // Should NOT import createEmptyRegistry
    expect(sessionJs).not.toContain("import { createEmptyRegistry }");

    // Should NOT import individual tools
    expect(sessionJs).not.toContain("import mcpTools from");
    expect(sessionJs).not.toContain("import skillTool from");
    expect(sessionJs).not.toContain("import enterWorktree from");
    expect(sessionJs).not.toContain("import exitWorktree from");
  });

  it('session.js calls createFullRegistry() not createEmptyRegistry()', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const rootDir = join(import.meta.dirname, '..', '..');
    const sessionJs = readFileSync(join(rootDir, 'agent/yeaft/session.js'), 'utf8');

    expect(sessionJs).toContain('createFullRegistry()');
    expect(sessionJs).not.toContain('createEmptyRegistry()');
  });

  it('session.js does not manually register built-in tools', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const rootDir = join(import.meta.dirname, '..', '..');
    const sessionJs = readFileSync(join(rootDir, 'agent/yeaft/session.js'), 'utf8');

    // Should NOT have manual registration of individual tools
    expect(sessionJs).not.toContain('toolRegistry.register(skillTool)');
    expect(sessionJs).not.toContain('toolRegistry.register(enterWorktree)');
    expect(sessionJs).not.toContain('toolRegistry.register(exitWorktree)');
    expect(sessionJs).not.toMatch(/for\s*\(\s*const\s+tool\s+of\s+mcpTools\s*\)/);
  });

  it('session.js still supports extraTools registration', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const rootDir = join(import.meta.dirname, '..', '..');
    const sessionJs = readFileSync(join(rootDir, 'agent/yeaft/session.js'), 'utf8');

    expect(sessionJs).toContain('extraTools');
    expect(sessionJs).toMatch(/for\s*\(\s*const\s+tool\s+of\s+extraTools\s*\)/);
  });
});

describe('agent/yeaft/index.js exports createFullRegistry', () => {
  it('index.js re-exports createFullRegistry', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const rootDir = join(import.meta.dirname, '..', '..');
    const indexJs = readFileSync(join(rootDir, 'agent/yeaft/index.js'), 'utf8');

    expect(indexJs).toContain('createFullRegistry');
    expect(indexJs).toContain("from './tools/index.js'");
  });
});
