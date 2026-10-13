import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
let server, url;
const presentation = {
  version: 1, title: '交付结果 · Release evidence', phase: 'final',
  summary: 'Use the smaller design first. Chart values below are fixture data, not measured production performance.',
  blocks: [
    { type: 'markdown', title: 'Scope', text: '## Verified\n**Shared rendering** preserves _plain text_.\n\n- Live reply\n- History replay\n\n`const result = true`' },
    { type: 'metrics', items: [{ label: 'Verified checks', value: '24', detail: 'Fixture data' }, { label: 'Options', value: '2' }] },
    { type: 'cards', items: [{ title: 'Reuse the current path', label: 'Recommended', text: 'One shared presentation; ownership stays in each runtime.' }, { title: 'Separate implementations', text: 'More duplication and regression risk.' }] },
    { type: 'table', title: 'Comparison', columns: ['Option', 'Implementation', 'Evidence'], rows: [['Shared', 'Small complete change', 'Focused tests'], ['Separate', 'Higher maintenance', 'More validation needed']] },
    { type: 'chart', title: 'Validation scope', style: 'bar', labels: ['A', 'B', 'C'], unit: 'checks', series: [{ label: 'Core', values: [12, 8, -2] }, { label: 'Browser', values: [4, 6, 0] }] },
    { type: 'chart', title: 'Example trend', style: 'line', labels: ['Mon', 'Tue', 'Wed'], series: [{ label: 'Completed', values: [1, 5, 8] }] },
    { type: 'timeline', items: [{ label: 'First', title: 'Validate', text: 'Run focused tests.' }, { label: 'Then', title: 'Review', text: 'Check complete integration.' }] },
    { type: 'diagram', title: 'Ownership', nodes: [{ id: 'browser', label: 'Browser' }, { id: 'server', label: 'Server' }, { id: 'agent', label: 'Agent' }], edges: [{ from: 'browser', to: 'server', label: 'Authenticated relay' }, { from: 'server', to: 'agent' }] },
    { type: 'map', points: [{ label: 'Shanghai', latitude: 31.2304, longitude: 121.4737, detail: 'Known coordinate fixture' }, { label: 'Hangzhou', latitude: 30.2741, longitude: 120.1551 }] },
    { type: 'image', url: 'https://external.example.test/preview.png', alt: 'Output preview', caption: 'Automatic image loading without a referrer' },
    { type: 'link', url: 'https://example.test/report', text: 'Verification report' },
  ],
};
function html() {
  return `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/web/dist/style.bundle.css"><style>body{margin:0;background:var(--bg-main);color:var(--text-primary)}#app{max-width:920px;margin:auto;padding:24px;box-sizing:border-box}@media(max-width:480px){#app{padding:12px}}</style></head><body><main id="app"></main><script src="/web/vendor/vue.global.prod.js"></script><script src="/web/vendor/marked.min.js"></script><script type="module">
  const {default:ResponsePresentation}=await import('/web/components/ResponsePresentation.js');
  const {default:en}=await import('/web/i18n/en.js');const {default:zh}=await import('/web/i18n/zh-CN.js');
  window.__state=Vue.reactive({presentation:${JSON.stringify(presentation)},locale:'en'});
  const app=Vue.createApp({components:{ResponsePresentation},setup:()=>window.__state,template:'<ResponsePresentation :presentation="presentation" />'});
  app.config.globalProperties.$t=key=>(window.__state.locale==='zh'?zh:en)[key]||key;
  app.mount('#app');window.__ready=true;
  </script></body></html>`;
}
test.beforeAll(async () => {
  execFileSync(process.execPath, ['web/build.js'], { cwd: root, stdio: 'pipe' });
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end(html()); return; }
    const path = resolve(root, '.' + decodeURIComponent(pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try { res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream' }).end(readFileSync(path)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolveClose => server?.close(resolveClose)); });

test('external images load automatically and retry; untrusted markdown cannot execute or request images', async ({ page }) => {
  let requests = 0;
  await page.route('https://external.example.test/**', async route => {
    requests++;
    if (requests === 1) await route.abort();
    else await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7Z0AAAAASUVORK5CYII=', 'base64') });
  });
  await page.goto(url); await page.waitForFunction(() => window.__ready);
  await page.evaluate(() => {
    window.__state.presentation.blocks[0].text = '<img src="https://external.example.test/secret.png" onerror="window.__bad=true">\n\n![Tracking](https://external.example.test/tracker.png)\n\n[Run](javascript:alert(1))';
  });
  await expect(page.locator('.response-markdown')).toContainText('onerror');
  await expect(page.locator('.response-markdown img')).toHaveCount(0);
  await expect(page.locator('.response-markdown a')).toHaveCount(0);
  await expect(page.locator('.response-image .btn-secondary')).toHaveText('Retry image');
  expect(requests).toBe(1);
  await page.locator('.response-image .btn-secondary').click();
  await expect(page.locator('.response-image img')).toBeVisible();
  expect(requests).toBe(2);
  expect(await page.evaluate(() => window.__bad)).toBeUndefined();
});
