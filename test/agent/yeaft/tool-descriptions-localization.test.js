import { describe, expect, it } from 'vitest';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { BUILTIN_TOOL_LOCALIZED_DESCRIPTIONS } from '../../../agent/yeaft/tools/localized-descriptions.js';

function collectDescriptions(schema, out = []) {
  if (!schema || typeof schema !== 'object') return out;
  if (typeof schema.description === 'string') out.push(schema.description);
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) collectDescriptions(child, out);
  }
  if (schema.items) collectDescriptions(schema.items, out);
  return out;
}

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

describe('built-in tool description localization', () => {
  it('exports complete Chinese descriptions for every built-in tool without changing schema keys', () => {
    const registry = createFullRegistry();
    const englishDefs = registry.getToolDefs('en');
    const chineseDefs = registry.getToolDefs('zh-CN');
    const englishByName = new Map(englishDefs.map(tool => [tool.name, tool]));

    expect(Object.keys(BUILTIN_TOOL_LOCALIZED_DESCRIPTIONS.zh).sort()).toEqual(
      englishDefs.map(tool => tool.name).sort(),
    );

    for (const tool of chineseDefs) {
      const english = englishByName.get(tool.name);
      expect(english).toBeTruthy();
      expect(tool.name).toBe(english.name);
      expect(stripDescriptions(tool.parameters)).toEqual(stripDescriptions(english.parameters));
      expect(tool.description).not.toContain('原始协议说明');
      expect(tool.description).not.toContain('工具说明：');
      expect(/[\u4e00-\u9fff]/.test(tool.description)).toBe(true);

      for (const description of collectDescriptions(tool.parameters)) {
        expect(description).not.toContain('原始协议说明');
        expect(description).not.toContain('工具说明：');
        expect(/[\u4e00-\u9fff]/.test(description)).toBe(true);
      }
    }
  });

  it('keeps English tool definitions in English', () => {
    const registry = createFullRegistry();
    const bash = registry.getToolDefs('en').find(tool => tool.name === 'Bash');
    const routeForward = registry.getToolDefs('en').find(tool => tool.name === 'RouteForward');

    expect(bash.description).toContain('Execute a shell command');
    expect(bash.description).not.toContain('在 shell 中执行');
    expect(routeForward.description).toContain('Use this tool — NOT free-text @mentions');
    expect(routeForward.description).not.toContain('必须调用这个工具');
  });

  it('strengthens key Chinese workflow and safety descriptions', () => {
    const registry = createFullRegistry();
    const defs = new Map(registry.getToolDefs('zh').map(tool => [tool.name, tool]));

    const routeForward = defs.get('RouteForward');
    expect(routeForward.description).toContain('多 VP 场景');
    expect(routeForward.description).toContain('必须调用这个工具');
    expect(routeForward.description).toContain('写 @名字 不会真正路由');
    expect(routeForward.parameters.properties.to.description).toContain('不能填自己');

    const fileEdit = defs.get('FileEdit');
    expect(fileEdit.description).toContain('使用前必须读取文件');
    expect(fileEdit.parameters.properties.old_string.description).toContain('完全一致');
    expect(fileEdit.parameters.properties.replace_all.description).toContain('避免误改');

    const bash = defs.get('Bash');
    expect(bash.description).toContain('非交互式命令');
    expect(bash.description).toContain('破坏性命令');

    const askUser = defs.get('AskUser');
    expect(askUser.description).toContain('真正阻塞');
    expect(askUser.description).toContain('不要把它当作普通说明');

    const todoWrite = defs.get('TodoWrite');
    expect(todoWrite.description).toContain('3 个以上');
    expect(todoWrite.parameters.properties.todos.items.properties.status.description).toContain('最多只能有一个 in_progress');
  });
});
