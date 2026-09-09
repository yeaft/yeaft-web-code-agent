import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let server;
let baseURL;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

function harness(production) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/web/${production ? 'dist/' : ''}vendor/katex/katex.min.css">
    <link rel="stylesheet" href="/web/${production ? 'dist/style.bundle.css' : 'styles/index.css'}">
    <style>body { margin: 0; padding: 16px; color: var(--text-primary); background: var(--bg-main); } #message { min-width: 0; }</style>
    </head><body><main id="message" class="markdown-body"></main>
    ${production ? '<script src="/web/dist/vendor.bundle.js"></script>' : '<script src="/web/vendor/vue.global.prod.js"></script><script src="/web/vendor/marked.min.js"></script><script src="/web/vendor/katex/katex.min.js"></script>'}
    <script type="module">
      window.Pinia = { defineStore: () => () => ({}), useChatStore: () => ({}) };
      const { default: AssistantTurn } = await import('/web/components/AssistantTurn.js');
      const turn = Vue.reactive({ textContent: '', isStreaming: true, toolMsgs: [], messages: [] });
      const app = Vue.createApp({ components: { AssistantTurn }, setup: () => ({ turn }),
        template: '<AssistantTurn :turn="turn" />' });
      app.config.globalProperties.$t = key => key;
      app.mount('#message');
      window.renderMessage = text => { turn.textContent = text; };
    </script></body></html>`;
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/production') {
      res.setHeader('Content-Type', 'text/html');
      res.end(harness(req.url === '/production'));
      return;
    }
    const path = resolve(root, '.' + new URL(req.url, 'http://local').pathname);
    if (!path.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
      res.end(readFileSync(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

for (const production of [false, true]) {
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 1280]) {
      test(`${production ? 'production assets' : 'development'} ${theme} ${width}px math and streaming`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        const failures = [];
        page.on('pageerror', error => failures.push(error.message));
        page.on('response', response => { if (response.status() >= 400) failures.push(response.url()); });
        await page.goto(baseURL + (production ? '/production' : '/'));
        await page.waitForFunction(() => typeof window.renderMessage === 'function');
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.evaluate(() => window.renderMessage(String.raw`Streaming \(x^2`));
        await expect(page.locator('#message')).toContainText(String.raw`\(x^2`);
        await expect(page.locator('.katex')).toHaveCount(0);
        const message = 'Inline $E=mc^2$ and \\(a_1+b_2\\).\n\n$$\n\\frac{1}{2}+' + 'x+'.repeat(100) + 'y\n$$\n\n`$code$`\n\n$\\unknown{<img>}$';
        await page.evaluate(text => window.renderMessage(text), message);
        await expect(page.locator('.katex')).toHaveCount(3);
        await expect(page.locator('math')).toHaveCount(3);
        await expect(page.locator('code')).toHaveText('$code$');
        await expect(page.locator('img')).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.evaluate(() => {
          const formula = document.querySelector('.math-display');
          return {
            pageWidth: document.documentElement.scrollWidth,
            viewport: innerWidth,
            scrollable: formula.scrollWidth > formula.clientWidth,
            fonts: [...document.fonts].some(font => font.family.startsWith('KaTeX') && font.status === 'loaded'),
            color: getComputedStyle(document.querySelector('.katex')).color,
            parentColor: getComputedStyle(document.querySelector('#message')).color,
          };
        });
        expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport);
        expect(layout.scrollable).toBe(true);
        expect(layout.fonts).toBe(true);
        // Theme switches animate; compare after the existing transition settles.
        await expect.poll(() => page.evaluate(() =>
          getComputedStyle(document.querySelector('.katex')).color
            === getComputedStyle(document.querySelector('#message')).color,
        )).toBe(true);
        expect(failures).toEqual([]);
      });
    }
  }
}
