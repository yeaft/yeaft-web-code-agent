import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

function themeBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing selector: ${selector}`);

  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }

  throw new Error(`Unclosed selector: ${selector}`);
}

function cssVar(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS variable: ${name}`);
  return match[1].trim();
}

function hexToRgb(hex) {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`Expected hex color, got: ${hex}`);
  const value = match[1];
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function ruleBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing rule: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('chat code block syntax theme', () => {
  it('keeps light code blocks on the light surface', () => {
    const variables = read('styles/variables.css');
    const light = themeBlock(variables, ':root');

    expect(cssVar(light, '--code-bg')).toBe('var(--bg-sidebar)');
    expect(cssVar(light, '--code-header-bg')).toBe('var(--bg-input-wrapper)');
    expect(cssVar(light, '--code-text')).toBe('var(--text-primary)');
  });

  it('defines readable syntax colors for both themes', () => {
    const variables = read('styles/variables.css');
    const light = themeBlock(variables, ':root');
    const dark = themeBlock(variables, '[data-theme="dark"]');
    const syntaxVars = [
      '--syntax-comment',
      '--syntax-keyword',
      '--syntax-string',
      '--syntax-number',
      '--syntax-title',
      '--syntax-variable',
      '--syntax-attribute',
      '--syntax-meta',
    ];

    for (const name of syntaxVars) {
      expect(cssVar(light, name)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(cssVar(dark, name)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastRatio(cssVar(light, name), cssVar(light, '--bg-sidebar'))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(cssVar(dark, name), cssVar(dark, '--bg-sidebar'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('overrides Highlight.js token colors through syntax tokens', () => {
    const css = read('styles/chat-messages.css');

    expect(ruleBlock(css, '.hljs-comment')).toContain('color: var(--syntax-comment) !important');
    expect(ruleBlock(css, '.hljs-keyword')).toContain('color: var(--syntax-keyword) !important');
    expect(ruleBlock(css, '.hljs-string')).toContain('color: var(--syntax-string) !important');
    expect(ruleBlock(css, '.hljs-number')).toContain('color: var(--syntax-number) !important');
    expect(ruleBlock(css, '.hljs-title')).toContain('color: var(--syntax-title) !important');
    expect(ruleBlock(css, '.hljs-variable')).toContain('color: var(--syntax-variable) !important');
    expect(ruleBlock(css, '.hljs-built_in')).toContain('color: var(--syntax-attribute) !important');
    expect(ruleBlock(css, '.hljs-meta')).toContain('color: var(--syntax-meta) !important');
  });
});
