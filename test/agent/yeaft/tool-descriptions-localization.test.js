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

function collectParameterDescriptions(schema, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => collectParameterDescriptions(item, `${path}[${index}]`));
  }
  const descriptions = [];
  for (const [key, child] of Object.entries(schema)) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === 'description') {
      descriptions.push({ path: childPath, value: child });
      continue;
    }
    descriptions.push(...collectParameterDescriptions(child, childPath));
  }
  return descriptions;
}

function toolByName(defs, name) {
  return defs.find(tool => tool.name === name);
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

      for (const { path, value } of collectParameterDescriptions(tool.parameters)) {
        expect(value, `${tool.name}.${path}`).toEqual(expect.any(Object));
        expect(value.en, `${tool.name}.${path}.en`).toEqual(expect.any(String));
        expect(value.zh, `${tool.name}.${path}.zh`).toEqual(expect.any(String));
        expect(value.en.trim(), `${tool.name}.${path}.en`).not.toEqual('');
        expect(value.zh.trim(), `${tool.name}.${path}.zh`).not.toEqual('');
        expect(value.zh, `${tool.name}.${path}.zh`).toMatch(/[\u4e00-\u9fff]/);
      }
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

      for (const { path, value } of collectParameterDescriptions(tool.parameters)) {
        expect(value, `${tool.name}.${path}`).toEqual(expect.any(String));
        expect(value, `${tool.name}.${path}`).toMatch(/[\u4e00-\u9fff]/);
        expect(value, `${tool.name}.${path}`).not.toContain('Path to the file');
        expect(value, `${tool.name}.${path}`).not.toContain('The shell command');
        expect(value, `${tool.name}.${path}`).not.toContain('Target vpId');
      }
    }

    const fileRead = toolByName(chineseDefs, 'FileRead');
    expect(fileRead.parameters.properties.file_path.description).toBe('要读取的文件路径（绝对路径或相对于当前工作目录）');

    const bash = toolByName(chineseDefs, 'Bash');
    expect(bash.parameters.properties.command.description).toBe('要使用 Agent 操作系统默认 shell 执行的命令');

    const routeForward = toolByName(chineseDefs, 'RouteForward');
    expect(routeForward.parameters.properties.to.description).toBe('目标 vpId，或 "all" 广播给所有人');
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

  it('keeps schema properties named description as schemas, not localized text blobs', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'NestedDescriptionTool',
      description: { en: 'Nested description test.', zh: '嵌套 description 测试。' },
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'object',
            properties: {
              detail: {
                type: 'string',
                description: { en: 'Detailed text', zh: '详细文本' },
              },
            },
            description: { en: 'Description payload', zh: '描述载荷' },
          },
        },
      },
      execute: async () => 'ok',
    });

    const [tool] = registry.getToolDefs('zh-CN');
    expect(tool.parameters.properties.description).toEqual({
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          description: '详细文本',
        },
      },
      description: '描述载荷',
    });
  });
});
