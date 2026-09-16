import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderMarkdown, clearMarkdownCache } from '../../web/utils/markdown.js';

function vendor(path, name) {
  const context = {};
  runInNewContext(readFileSync(new URL(`../../web/vendor/${path}`, import.meta.url), 'utf8'), context);
  return context[name];
}

beforeAll(() => {
  vi.stubGlobal('marked', vendor('marked.min.js', 'marked'));
  vi.stubGlobal('katex', vendor('katex/katex.min.js', 'katex'));
});
afterAll(() => { vi.unstubAllGlobals(); clearMarkdownCache(); });

describe('shared Markdown LaTeX rendering with local vendors', () => {
  it.each(['$x^2 + y_1$', '\\(x^2 + y_1\\)', '$$x^2 + y_1$$', '\\[x^2 + y_1\\]'])(
    'renders %s as accessible math', formula => {
      const html = renderMarkdown(`公式：${formula}`);
      expect(html).toContain('class="katex"');
      expect(html).toContain('<math');
      expect(html).toContain('annotation encoding="application/x-tex"');
    },
  );
  it('keeps multiline equations intact before Markdown escapes and breaks', () => {
    const html = renderMarkdown(String.raw`Before

$$
\begin{aligned}
a_1 &= \frac{1}{2} \\
b_2 &= \sqrt{x}
\end{aligned}
$$

After`);
    expect(html).toContain('<div class="math-display">');
    expect(html).toContain('class="katex"');
    expect(html).toContain('<p>After</p>');
    expect(html).not.toContain('<em>');
  });
  it('supports formulas within lists, headings, tables and emphasis', () => {
    for (const text of ['- value $x^2$', '## value \\(x^2\\)', '**value $x^2$**', '| value |\n| --- |\n| $x^2$ |']) {
      expect(renderMarkdown(text)).toContain('class="katex"');
    }
  });
  it('does not interpret inline or fenced code, mermaid or escaped dollars', () => {
    for (const text of ['`$x^2$`', '```latex\n\\[x^2\\]\n```', '```mermaid\ngraph LR\nA["$x^2$"]\n```', String.raw`\$x^2\$`]) {
      expect(renderMarkdown(text)).not.toContain('class="katex"');
    }
  });
  it('preserves raw HTML code and mixed currency/code boundaries', () => {
    expect(renderMarkdown('<code>$x$</code>')).not.toContain('class="katex"');
    expect(renderMarkdown('cost $5 and `$x$`')).toContain('<code>$x$</code>');
    expect(renderMarkdown('cost $5 and `$x$`')).not.toContain('class="katex"');
    expect(renderMarkdown('$$x^2$')).not.toContain('class="katex"');
  });
  it('does not turn ordinary prices into formulas', () => {
    for (const text of ['$5 and $10', '$5, $10, and $20', 'cost $ 5 $', 'USD $10.00 each', '$5.00 to $10.00']) {
      expect(renderMarkdown(text)).not.toContain('class="katex"');
    }
  });
  it('preserves incomplete streaming formulas and renders the completed update', () => {
    for (const text of [String.raw`value \(x^2`, 'value $x^2', '$$\nx^2']) {
      expect(renderMarkdown(text)).not.toContain('class="katex"');
    }
    expect(renderMarkdown(String.raw`value \(x^2`)).toContain(String.raw`\(x^2`);
    expect(renderMarkdown(String.raw`value \(x^2\)`)).toContain('class="katex"');
  });
  it('escapes invalid TeX and disables trusted HTML, links and resource loading', () => {
    for (const source of [String.raw`$\unknown{<img src=x onerror=alert(1)>}$`, String.raw`$\href{javascript:alert(1)}{click}$`, String.raw`$\includegraphics{https://evil.invalid/x}$`, String.raw`$\htmlClass{bad}{x}$`]) {
      const html = renderMarkdown(source);
      expect(html).not.toMatch(/<img|<a\s|class="bad"|onerror="/);
    }
    expect(renderMarkdown(String.raw`$\unknown{<img>}$`)).toContain('&lt;img&gt;');
  });
  it('bounds TeX expansion and leaves oversized input readable', () => {
    expect(renderMarkdown('$' + 'x'.repeat(16_385) + '$')).not.toContain('class="katex"');
    expect(renderMarkdown(String.raw`$\def\a{\a}\a$`)).not.toContain('class="katex"');
    expect(renderMarkdown('$z^2$')).toContain('class="katex"');
  });
  it('does not share global macro definitions or mutate repeated output', () => {
    renderMarkdown(String.raw`$\gdef\mycommand{ABC}\mycommand$`);
    expect(renderMarkdown(String.raw`$\mycommand$`)).not.toContain('class="katex"');
    expect(renderMarkdown('$a+b$')).toBe(renderMarkdown('$a+b$'));
  });
});
