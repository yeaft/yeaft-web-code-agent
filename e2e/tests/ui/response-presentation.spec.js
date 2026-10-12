import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Real Vue, real marked and production CSS, served locally; no Agent, login, CDN or global app state.
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const types = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const presentation = {
  version: 1, title: 'A clearer path to launch', phase: 'final',
  summary: 'The pilot is ready for a staged rollout. Keep the measured latency improvement, ship the accessibility fixes, and use the two Bay Area offices for the first support rotation. The remaining risk is the unverified external image, not the release checks.',
  blocks: [
    { type: 'metrics', title: 'At a glance', items: [
      { label: 'Checks passing', value: '24 / 24', detail: 'Focused regression suite' },
      { label: 'Median latency', value: '142 ms', detail: 'Down from 218 ms in the pilot' },
      { label: 'Rollout scope', value: '2 offices', detail: 'San Francisco & Oakland' },
    ] },
    { type: 'cards', title: 'What matters next', items: [
      { label: '01 · Ship', title: 'Make the safe path the easy path', text: 'Start with a small cohort. Keep the text summary available on every screen, even if a chart or image cannot be shown.' },
      { label: '02 · Observe', title: 'Measure before expanding', text: 'Review the first support rotation and compare the same latency window before moving beyond the pilot.' },
    ] },
    { type: 'markdown', title: 'Decision notes', text: 'The recommendation is **staged delivery**, not a big-bang release.\n\n- Keep keyboard access and readable data tables.\n- Treat the chart as evidence, not proof of task success.\n\nUse `rollback --pilot` only after confirming the target environment.' },
    { type: 'table', title: 'Release evidence', columns: ['Area', 'Evidence', 'Decision'], rows: [
      ['Accessibility', 'Keyboard navigation and text alternatives verified', 'Ready'],
      ['Performance', 'Pilot latency measured on the same cohort', 'Monitor'],
      ['External content', 'Images load automatically without sending a referrer', 'Automatic preview'],
    ] },
    { type: 'chart', title: 'Pilot latency by day', style: 'line', unit: 'ms · lower is better', labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], series: [
      { label: 'Baseline', values: [218, 224, 210, 219, 216] }, { label: 'Pilot', values: [185, 170, 158, 149, 142] },
    ] },
    { type: 'chart', title: 'Daily resolved support requests', style: 'bar', unit: 'requests', labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], series: [
      { label: 'San Francisco', values: [12, 18, 15, 23, 21] }, { label: 'Oakland', values: [8, 11, 14, 16, 19] },
    ] },
    { type: 'timeline', title: 'A small, reversible rollout', items: [
      { label: 'Day 1', title: 'Start with the pilot', text: 'Enable the verified cohort. Keep the previous configuration ready.' },
      { label: 'Day 2', title: 'Review the same evidence', text: 'Compare latency, errors, and the support queue. Stop expansion if any guardrail fails.' },
      { label: 'Day 3', title: 'Expand only when justified', text: 'Use the review outcome, not an automatic completion signal.' },
    ] },
    { type: 'diagram', title: 'Where the responsibilities live', nodes: [
      { id: 'browser', label: 'Browser' }, { id: 'relay', label: 'Server relay' }, { id: 'agent', label: 'Agent instance' },
    ], edges: [{ from: 'browser', to: 'relay', label: 'owner-scoped request' }, { from: 'relay', to: 'agent', label: 'local execution' }] },
    { type: 'map', title: 'Pilot support locations', points: [
      { label: 'San Francisco · Civic Center', latitude: 37.7793, longitude: -122.4193, detail: 'First support rotation; coordinates identify the area, not a precise entrance.' },
      { label: 'Oakland · City Hall', latitude: 37.8051, longitude: -122.2724, detail: 'Second support rotation across the bay.' },
      { label: 'Berkeley · Downtown', latitude: 37.8701, longitude: -122.2681, detail: 'Potential follow-up location, not part of the initial rollout.' },
    ] },
    { type: 'image', title: 'Optional visual reference', url: 'https://images.example.test/pilot.png', alt: 'Pilot architecture reference', caption: 'External reference. It is not required to read this delivery.' },
    { type: 'link', title: 'Supporting source', url: 'https://example.test/release-evidence', text: 'Read the pilot evidence report' },
  ],
};

function html() {
  return `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/web/styles/index.css"><style>
      body { margin: 0; background: var(--bg-main); color: var(--text-primary); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      main { max-width: 820px; margin: 0 auto; padding: 40px 28px; }
      @media (max-width: 480px) { main { padding: 20px 14px; } }
    </style></head><body><main id="app"></main>
    <script src="/web/vendor/vue.global.prod.js"></script><script src="/web/vendor/marked.min.js"></script>
    <script type="module">
      const { default: ResponsePresentation } = await import('/web/components/ResponsePresentation.js');
      const { default: en } = await import('/web/i18n/en.js');
      const { default: zh } = await import('/web/i18n/zh-CN.js');
      window.__state = Vue.reactive({ presentation: ${JSON.stringify(presentation)}, locale: 'en' });
      const app = Vue.createApp({ components: { ResponsePresentation }, setup: () => window.__state,
        template: '<ResponsePresentation :presentation="presentation" />' });
      app.config.globalProperties.$t = key => (window.__state.locale === 'en' ? en : zh)[key] || key;
      app.mount('#app'); window.__ready = true;
    </script></body></html>`;
}

let server, origin;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html()); return; }
    const path = resolve(root, '.' + pathname);
    if (!path.startsWith(root + sep) || !pathname.startsWith('/web/')) { response.writeHead(404).end(); return; }
    try {
      if (!statSync(path).isFile()) throw new Error('not a file');
      response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
      response.end(readFileSync(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function open(page) {
  // Tests stay offline: even an accidental external request is intercepted and recorded.
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin);
  await page.waitForFunction(() => window.__ready);
}

for (const scenario of [
  { name: 'light-desktop', theme: 'light', width: 1100, locale: 'en' },
  { name: 'dark-desktop', theme: 'dark', width: 1100, locale: 'en' },
  { name: 'light-mobile', theme: 'light', width: 320, locale: 'en' },
  { name: 'dark-mobile-zh', theme: 'dark', width: 320, locale: 'zh-CN' },
]) {
  test(`isolated rich response ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const external = [];
    page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
    await open(page);
    await page.evaluate(({ theme, locale }) => { document.documentElement.dataset.theme = theme; window.__state.locale = locale; }, scenario);
    await expect(page.locator('.response-block')).toHaveCount(11);
    await expect(page.locator('.response-map-list li')).toHaveCount(3);
    await expect(page.locator('svg')).toHaveCount(4);
    await expect(page.getByRole('button', { name: scenario.locale === 'en' ? 'Retry image' : '重试图片' })).toBeVisible();
    expect(external).toEqual(['https://images.example.test/pilot.png']);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Fractional SVG sizing can round the document height by one blank bottom pixel.
    // Stabilize only the empty page extent; every component pixel is still compared.
    await page.evaluate(() => { document.body.style.minHeight = `${Math.ceil(document.documentElement.scrollHeight / 8) * 8}px`; });
    await expect(page).toHaveScreenshot(`${scenario.name}.png`, { fullPage: true, animations: 'disabled' });
    const summary = page.locator('.response-chart .response-data summary').first();
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.response-chart .response-data').first()).toHaveAttribute('open', '');
    await expect(page.locator('.response-chart table').first()).toBeVisible();
    const scroll = page.locator('.response-block-table .response-table-scroll');
    await scroll.focus();
    await page.keyboard.press('ArrowRight');
    await expect(scroll).toBeFocused();
    if (scenario.width === 320) expect(await scroll.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  });
}

test('automatic image loading, no-referrer, error/retry, preview and URL replacement', async ({ page }) => {
  let attempts = 0;
  // Install interception before mounting: no external resource is contacted.
  await page.route('https://images.example.test/**', async route => {
    attempts++;
    expect(route.request().headers().referer).toBeUndefined();
    if (attempts === 1) return route.fulfill({ status: 404, body: 'missing' });
    await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') });
  });
  await page.goto(origin); await page.waitForFunction(() => window.__ready);
  await expect(page.getByRole('button', { name: 'Retry image' })).toBeVisible();
  expect(attempts).toBe(1);
  await expect(page.locator('.response-image-placeholder')).toContainText('Pilot architecture reference');
  await page.getByRole('button', { name: 'Retry image' }).click();
  await expect(page.locator('.response-image img')).toBeVisible();
  await page.getByRole('button', { name: 'Expand image preview' }).click();
  await expect(page.getByRole('button', { name: 'Collapse image preview' })).toHaveAttribute('aria-expanded', 'true');
  expect(attempts).toBe(2);
  await page.evaluate(() => { window.__state.presentation = { ...window.__state.presentation, blocks: window.__state.presentation.blocks.map(b => b.type === 'image' ? { ...b, url: 'https://images.example.test/replaced.png' } : b) }; });
  await expect(page.locator('.response-image img')).toHaveAttribute('src', 'https://images.example.test/replaced.png');
  await expect(page.locator('.response-image img')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand image preview' })).toHaveAttribute('aria-expanded', 'false');
  expect(attempts).toBe(3);
});

test('malicious markup/URLs never execute or request; clipboard denied retains selectable summary', async ({ page }) => {
  await open(page);
  const external = [];
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  await page.evaluate(() => {
    window.__pwned = false;
    window.__state.presentation = { version: 1, summary: 'Readable, copyable fallback.', blocks: [
      { type: 'markdown', text: '**Safe** <img src="https://track.example/x" onerror="window.__pwned=true"><svg onload="window.__pwned=true"></svg> [bad](javascript:alert(1)) [secret](https://user:pass@example.com) ![tracking](https://track.example/pixel)\n\n<script>window.__pwned=true</script>' },
      { type: 'link', url: 'javascript:alert(1)', text: 'Unsafe' },
      { type: 'image', url: 'https://user:pass@example.com/x', alt: 'Unsafe image' },
      { type: 'chart', style: 'line', labels: ['Broken'], series: [{ label: 'Invalid', values: [Infinity] }] },
      { type: 'unknown', html: '<script>window.__pwned=true</script>' },
    ] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
  });
  await expect(page.locator('.response-markdown strong')).toHaveText('Safe');
  await expect(page.locator('.response-presentation img, .response-presentation svg, .response-presentation script, .response-presentation a')).toHaveCount(0);
  await expect(page.locator('.response-notice')).toHaveCount(4);
  expect(await page.evaluate(() => window.__pwned)).toBe(false);
  expect(external).toEqual([]);
  await page.getByRole('button', { name: 'Copy summary' }).click();
  await expect(page.getByRole('status')).toContainText('copy it manually');
  expect(await page.evaluate(() => getSelection().toString())).toBe('Readable, copyable fallback.');
  await page.evaluate(() => { window.__state.presentation = { version: 99, summary: 'Still readable in older clients.', blocks: [] }; });
  await expect(page.locator('.response-summary')).toHaveText('Still readable in older clients.');
  await expect(page.locator('.response-notice')).toContainText('cannot be displayed');
});
