import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { compile } from '@vue/compiler-dom';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const componentsDir = join(repoRoot, 'web/components');
const compileCoveredComponents = [
  'YeaftPage.js',
  'YeaftSidebar.js',
  'PaneTopBar.js',
  'VpTimelinePane.js',
  'SettingsPanel.js',
  'LlmTab.js',
  'VpCrudPanel.js',
  'AssistantTurn.js',
  'YeaftDebugPanel.js',
  'YeaftSessionActions.js',
];

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach(child => walkAst(child, visit));
    } else if (value && typeof value === 'object' && value.type) {
      walkAst(value, visit);
    }
  }
}

function extractTemplateLiterals(source) {
  const ast = parse(source, { sourceType: 'module' });
  const templates = [];
  walkAst(ast, (node) => {
    if (node.type !== 'ObjectProperty' || node.computed) return;
    const key = node.key.type === 'Identifier' ? node.key.name : node.key.value;
    if (key !== 'template') return;
    if (node.value.type === 'StringLiteral') {
      templates.push(node.value.value);
      return;
    }
    if (node.value.type === 'TemplateLiteral' && node.value.expressions.length === 0) {
      templates.push(node.value.quasis[0].value.cooked);
    }
  });
  return templates;
}

function compileTemplate(template) {
  const { code } = compile(template, {
    mode: 'function',
    prefixIdentifiers: false,
    onError(error) {
      throw error;
    },
  });
  // Vue's browser runtime compiles templates through new Function(). Catch the
  // same class of bad generated expressions before it reaches users.
  new Function('Vue', code);
}

describe('Vue component templates', () => {
  it.each(compileCoveredComponents)('compiles %s without runtime syntax errors', (fileName) => {
    const source = readFileSync(join(componentsDir, fileName), 'utf8');
    const templates = extractTemplateLiterals(source);
    expect(templates.length).toBeGreaterThan(0);
    templates.forEach(compileTemplate);
  });

  it('keeps Yeaft page tooltip translation out of the inline template without losing i18n', () => {
    const pageSource = readFileSync(join(componentsDir, 'YeaftPage.js'), 'utf8');
    const actionsSource = readFileSync(join(componentsDir, 'YeaftSessionActions.js'), 'utf8');
    expect(actionsSource).toContain(':title="dreamRunButtonTitle"');
    expect(pageSource).toContain('const $t = (inst && inst.appContext.config.globalProperties.$t)');
    expect(actionsSource).toContain("$t('yeaft.dream.runNow')");
    expect(pageSource).toContain("$t('yeaft.dream.lastRun', { ago: dreamLastRunRelative.value })");
    expect(pageSource).toContain("$t('yeaft.dream.lastRunNever')");
    expect(pageSource).not.toContain("$t('yeaft.dream.runNow') + '\\n'");
    expect(actionsSource).not.toContain("$t('yeaft.dream.runNow') + '\\n'");
    expect(pageSource).not.toContain('store.t?.(');
    expect(actionsSource).not.toContain('store.t?.(');
    expect(pageSource).not.toContain('Run Dream');
    expect(actionsSource).not.toContain('Run Dream');
    expect(pageSource).not.toContain('Never run');
    expect(pageSource).not.toContain('Last run ${dreamLastRunRelative.value} ago');
  });
});
