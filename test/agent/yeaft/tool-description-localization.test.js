/**
 * tool-description-localization.test.js — Verify dual-language tool descriptions
 *
 * Tests that:
 * 1. Tools with {en, zh} description objects return the right language in getToolDefs
 * 2. String descriptions still work (backward compat fallback)
 * 3. Parameter descriptions with {en, zh} objects resolve correctly
 * 4. Mixed (object description + string params) works gracefully
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { allTools } from '../../../agent/yeaft/tools/index.js';

function makeRegistry() {
  const reg = new ToolRegistry();
  for (const t of allTools) {
    reg.register(t);
  }
  return reg;
}

describe('Tool description localization', () => {
  it('returns zh description when language is zh', () => {
    const reg = makeRegistry();
    const defs = reg.getToolDefs('zh');
    const bash = defs.find(d => d.name === 'Bash');
    expect(bash).toBeDefined();
    // Chinese description should contain Chinese characters, not the prefix wrapper
    expect(bash.description).toMatch(/执行 Shell 命令/);
    // Should NOT contain the legacy prefix pattern
    expect(bash.description).not.toMatch(/^工具说明：/);
  });

  it('returns en description when language is en', () => {
    const reg = makeRegistry();
    const defs = reg.getToolDefs('en');
    const bash = defs.find(d => d.name === 'Bash');
    expect(bash).toBeDefined();
    expect(bash.description).toMatch(/Execute a shell command/);
    expect(bash.description).not.toMatch(/执行 Shell 命令/);
  });

  it('returns en description by default (no language)', () => {
    const reg = makeRegistry();
    const defs = reg.getToolDefs();
    const bash = defs.find(d => d.name === 'Bash');
    expect(bash).toBeDefined();
    expect(bash.description).toMatch(/Execute a shell command/);
  });

  it('resolves parameter descriptions for zh', () => {
    const reg = makeRegistry();
    const defs = reg.getToolDefs('zh');
    const bash = defs.find(d => d.name === 'Bash');
    expect(bash.parameters.properties.command.description).toBe('要执行的 Shell 命令');
    expect(bash.parameters.properties.timeout_ms.description).toMatch(/超时时间/);
  });

  it('resolves parameter descriptions for en', () => {
    const reg = makeRegistry();
    const defs = reg.getToolDefs('en');
    const bash = defs.find(d => d.name === 'Bash');
    expect(bash.parameters.properties.command.description).toBe('The shell command to execute');
  });

  it('nested parameter descriptions resolve correctly for zh', () => {
    const reg = makeRegistry();
    const defs = reg.getToolDefs('zh');
    const todo = defs.find(d => d.name === 'TodoWrite');
    expect(todo).toBeDefined();
    const todosDesc = todo.parameters.properties.todos.description;
    expect(todosDesc).toMatch(/当前完整的待办清单/);

    // Check nested items properties
    const items = todo.parameters.properties.todos.items;
    expect(items.properties.content.description).toMatch(/步骤的命令式描述/);
    expect(items.properties.status.description).toMatch(/当前状态/);
  });

  it('tools with object descriptions coexist with tools that may have string descriptions', () => {
    const reg = new ToolRegistry();
    // Register a tool with string description (simulating legacy/unmigrated)
    reg.register({
      name: 'LegacyTool',
      description: 'A plain string description',
      parameters: {
        type: 'object',
        properties: {
          arg: { type: 'string', description: 'A plain arg description' },
        },
      },
      execute: async () => 'ok',
    });

    const defsZh = reg.getToolDefs('zh');
    const legacy = defsZh.find(d => d.name === 'LegacyTool');
    expect(legacy).toBeDefined();
    // For zh, string descriptions get the prefix fallback
    expect(legacy.description).toMatch(/^工具说明：LegacyTool/);
    expect(legacy.description).toMatch(/A plain string description/);

    const defsEn = reg.getToolDefs('en');
    const legacyEn = defsEn.find(d => d.name === 'LegacyTool');
    expect(legacyEn.description).toBe('A plain string description');
  });

  it('all 27+ built-in tools have valid zh descriptions', () => {
    const reg = makeRegistry();
    const defsZh = reg.getToolDefs('zh');
    const defsEn = reg.getToolDefs('en');

    expect(defsZh.length).toBeGreaterThanOrEqual(27);
    expect(defsZh.length).toBe(defsEn.length);

    for (const def of defsZh) {
      // Every zh description should be non-empty and contain CJK characters
      expect(def.description, `Tool ${def.name} zh description should be non-empty`).toBeTruthy();
      expect(typeof def.description, `Tool ${def.name} zh description should be string`).toBe('string');
      // Should contain at least some Chinese chars or be the legacy prefix (for unmigrated tools)
      const hasChinese = /[\u4e00-\u9fff]/.test(def.description);
      const isLegacyFallback = def.description.startsWith('工具说明：');
      expect(
        hasChinese || isLegacyFallback,
        `Tool ${def.name} zh description should have Chinese text or legacy fallback prefix`
      ).toBe(true);
    }
  });

  it('zh descriptions are semantically distinct from en (not just prefix)', () => {
    const reg = makeRegistry();
    const defsZh = reg.getToolDefs('zh');
    const defsEn = reg.getToolDefs('en');

    const zhBash = defsZh.find(d => d.name === 'Bash');
    const enBash = defsEn.find(d => d.name === 'Bash');

    // zh description should not contain the full en text as a substring
    // (this would indicate it's just prefix + en, not a real translation)
    expect(zhBash.description).not.toContain(enBash.description);

    // zh description should be roughly similar length (not 2x+ longer due to prefix)
    const zhLen = zhBash.description.length;
    const enLen = enBash.description.length;
    expect(zhLen).toBeLessThan(enLen * 1.5);
  });
});
