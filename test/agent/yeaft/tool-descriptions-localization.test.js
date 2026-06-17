import { describe, expect, it } from 'vitest';
import { allTools, createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { mcpCallTool, mcpListTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';

function stripDescriptions(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripDescriptions);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'description') continue;
    out[key] = stripDescriptions(child);
  }
  return out;
}

function registeredToolSet() {
  return [...allTools, mcpListTools, mcpCallTool];
}

describe('built-in tool description localization', () => {
  it('keeps complete English and Chinese descriptions on each built-in tool definition', () => {
    for (const tool of registeredToolSet()) {
      expect(tool.description, `${tool.name} description`).toEqual(expect.any(Object));
      expect(tool.description.en, `${tool.name} English description`).toEqual(expect.any(String));
      expect(tool.description.zh, `${tool.name} Chinese description`).toEqual(expect.any(String));
      expect(tool.description.en.trim(), `${tool.name} English description`).not.toEqual('');
      expect(tool.description.zh.trim(), `${tool.name} Chinese description`).not.toEqual('');
      expect(tool.description.zh, `${tool.name} Chinese description`).toMatch(/[\u4e00-\u9fff]/);
      expect(tool.description.zh, `${tool.name} Chinese description`).not.toContain('原始协议说明');
      expect(tool.description.zh, `${tool.name} Chinese description`).not.toContain('工具说明：');
    }
  });

  it('selects tool-owned localized descriptions without changing parameter schema shape', () => {
    const registry = createFullRegistry();
    const englishDefs = registry.getToolDefs('en');
    const chineseDefs = registry.getToolDefs('zh-CN');
    const englishByName = new Map(englishDefs.map(tool => [tool.name, tool]));

    expect(chineseDefs.map(tool => tool.name).sort()).toEqual(englishDefs.map(tool => tool.name).sort());

    for (const tool of chineseDefs) {
      const english = englishByName.get(tool.name);
      expect(english).toBeTruthy();
      expect(tool.name).toBe(english.name);
      expect(stripDescriptions(tool.parameters)).toEqual(stripDescriptions(english.parameters));
      expect(tool.description).not.toContain('原始协议说明');
      expect(tool.description).not.toContain('工具说明：');
      expect(tool.description).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('passes legacy single-string descriptions through unchanged', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'LegacyTool',
      description: 'Legacy English description only.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Legacy parameter description only.',
          },
        },
      },
      execute: async () => 'ok',
    });

    const [tool] = registry.getToolDefs('zh-CN');
    expect(tool.description).toBe('Legacy English description only.');
    expect(tool.description).not.toContain('工具说明：');
    expect(tool.description).not.toContain('原始协议说明');
    expect(tool.parameters.properties.text.description).toBe('Legacy parameter description only.');
  });
});
