import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Real Vue and production CSS. Provider/image requests are always intercepted, never live.
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const points = [
  { label: 'Civic Center', latitude: 37.7793, longitude: -122.4193, detail: 'Verified coordinates, not an entrance.' },
  { label: 'Oakland', latitude: 37.8051, longitude: -122.2724, detail: 'Second support rotation.' },
];
const presentation = { version: 1, summary: 'Only supplied imagery and verified map sources.', blocks: [
  { type: 'cards', items: [
    { title: 'Weather report', text: 'Supplied observation, no invented icon.', image: { url: 'https://images.example.test/weather.png', alt: 'Supplied weather station logo', fit: 'contain' }, url: 'https://example.test/weather' },
    { title: 'NBA report', text: 'A supplied photo, not a generated team logo.', image: { url: 'https://images.example.test/nba.png', alt: 'Supplied basketball photo', fit: 'cover' } },
    { title: 'Text only', text: 'No image was supplied.' },
  ] },
  { type: 'map', title: 'Support locations', points, embed: { provider: 'openstreetmap' } },
] };

function html() {
  return `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/web/styles/index.css"><style>
    body { margin: 0; background: var(--bg-main); color: var(--text-primary); font-family: sans-serif; }
    main { max-width: 820px; margin: 0 auto; padding: 20px 14px; }
    </style></head><body><main id="app"></main><script src="/web/vendor/vue.global.prod.js"></script>
    <script type="module">
      const { default: ResponsePresentation } = await import('/web/components/ResponsePresentation.js');
      const { default: en } = await import('/web/i18n/en.js');
      const { default: zh } = await import('/web/i18n/zh-CN.js');
      window.__opened = []; window.__state = Vue.reactive({ presentation: ${JSON.stringify(presentation)}, locale: 'en' });
      const app = Vue.createApp({ components: { ResponsePresentation }, setup: () => ({ ...Vue.toRefs(window.__state), openLink: url => { window.__opened.push(url); return true; } }),
        template: '<ResponsePresentation :presentation="presentation" :open-link="openLink" />' });
      app.config.globalProperties.$t = key => (window.__state.locale === 'en' ? en : zh)[key] || key;
      app.mount('#app'); window.__ready = true;
    </script></body></html>`;
}
let server, origin;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html()); return; }
    const path = resolve(root, '.' + pathname);
    if (!pathname.startsWith('/web/') || !path.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    try {
      if (!statSync(path).isFile()) throw new Error('not a file');
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream');
      res.end(readFileSync(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
async function open(page, provider = route => route.fulfill({ contentType: 'text/html', body: '<html><body><button>Provider map control</button></body></html>' })) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    expect(route.request().headers().referer).toBeUndefined();
    if (url.hostname === 'images.example.test') return route.fulfill({ contentType: 'image/png', body: png });
    if (url.hostname === 'www.openstreetmap.org' || url.hostname === 'www.google.com') return provider(route);
    return route.abort();
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.__ready);
}

test('card errors/retry, reserved image slot and URL replacement ignore stale events', async ({ page }) => {
  await open(page);
  const image = page.getByAltText('Supplied weather station logo');
  await expect(image).toBeVisible();
  const height = await page.locator('.response-card-image').first().evaluate(el => el.getBoundingClientRect().height);
  await page.evaluate(() => {
    window.__oldImage = document.querySelector('.response-cards img');
    window.__state.presentation.blocks[0].items[0].image.url = 'https://images.example.test/replaced.png';
  });
  await expect(image).toHaveAttribute('src', 'https://images.example.test/replaced.png');
  await expect(image).toBeVisible();
  await page.evaluate(() => window.__oldImage.dispatchEvent(new Event('error')));
  await expect(image).toBeVisible();
  await page.route('https://images.example.test/missing.png', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.evaluate(() => { window.__state.presentation.blocks[0].items[0].image.url = 'https://images.example.test/missing.png'; });
  await expect(page.getByRole('button', { name: 'Retry image' })).toBeVisible();
  expect(await page.locator('.response-card-image').first().evaluate(el => el.getBoundingClientRect().height)).toBe(height);
  await page.unroute('https://images.example.test/missing.png');
  await page.getByRole('button', { name: 'Retry image' }).click();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  await page.evaluate(() => {
    window.__state.presentation.blocks[0].items[0].image = { url: 'https://user:pass@images.example.test/secret.png', alt: 'Unsafe image' };
    window.__state.presentation.blocks[0].items[0].url = 'javascript:alert(1)';
  });
  await expect(page.locator('.response-cards li').first().locator('img, a')).toHaveCount(0);
  await expect(page.locator('.response-cards li').first()).toContainText('Weather report');
});

test('verified Google share embed, not a homepage, API key, arbitrary iframe or HTML', async ({ page }) => {
  await open(page);
  await page.evaluate(points => {
    window.__state.presentation.blocks = [{ type: 'map', points, embed: { provider: 'google', url: 'https://www.google.com/maps/embed?pb=!1m18!2m3!3d37.7793' } }];
  }, points);
  await expect(page.locator('.response-map iframe')).toHaveAttribute('src', /https:\/\/www\.google\.com\/maps\/embed\?pb=/);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('.response-map')).toContainText('shared view');
  for (const embed of [
    { provider: 'google', url: 'https://www.google.com/maps/' },
    { provider: 'google', url: 'https://www.google.com/maps/embed/v1/place?key=secret&q=Paris' },
    { provider: 'google', url: 'https://evil.example/maps/embed?pb=abc' },
    { provider: 'google', url: 'https://www.google.com/maps/embed?pb=abc&key=secret' },
    { provider: 'other', url: 'https://evil.example/map' },
    { provider: 'openstreetmap', url: 'https://evil.example/map' },
  ]) {
    await page.evaluate(({ embed, points }) => { window.__state.presentation.blocks = [{ type: 'map', points, embed }]; }, { embed, points });
    await expect(page.locator('.response-presentation iframe')).toHaveCount(0);
  }
  await page.evaluate(() => { window.__state.presentation.blocks = [{ type: 'markdown', text: '<iframe src="https://evil.example"></iframe><script>window.__pwned=true</script>' }]; });
  await expect(page.locator('.response-presentation iframe, .response-presentation script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});
