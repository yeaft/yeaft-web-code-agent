// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSafeMessageMarkdown } from '../../web/utils/safe-message-markdown.js';
const context = {};
runInNewContext(readFileSync(resolve(process.cwd(), 'web/vendor/marked.min.js'), 'utf8'), context);
afterEach(() => vi.unstubAllGlobals());
const render = text => { const el = document.createElement('div'); el.innerHTML = renderSafeMessageMarkdown(text); return el; };

describe('read-only message Markdown', () => {
  it('uses the bundled parser for message typography without Session actions', () => {
    vi.stubGlobal('marked', context.marked);
    const el = render('# Title\n\n**Hello**\n\n- one\n- two\n\n```js\nconst n = 1;\n```\n\n[Docs](https://example.com)');
    expect(el.querySelector('h1').textContent).toBe('Title');
    expect(el.querySelector('strong').textContent).toBe('Hello');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('pre code').textContent).toContain('const n = 1;');
    expect(el.querySelector('a').getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('keeps HTML literal and prevents image fetches, executable and local links', () => {
    vi.stubGlobal('marked', context.marked);
    const el = render('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n![tracking](https://example.com/pixel)\n\n[evil](javascript:alert%281%29) [data](data:text/html,evil) [local](file:///etc/passwd)\n\n[encoded](java&#x73;cript:evil)');
    expect(el.querySelector('img, script, a')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain('tracking');
    expect(el.textContent).toContain('encoded');
  });
  it('has a safe plain-text fallback and does not configure the shared renderer', () => {
    vi.stubGlobal('marked', undefined);
    expect(render('<svg onload=alert(1)>\nhello').querySelector('svg')).toBeNull();
    expect(render('<svg onload=alert(1)>\nhello').textContent).toContain('<svg onload=alert(1)>');
    vi.stubGlobal('marked', context.marked);
    const before = context.marked.parse('<b>shared</b>');
    render('<b>ours</b>');
    expect(context.marked.parse('<b>shared</b>')).toBe(before);
  });
});
