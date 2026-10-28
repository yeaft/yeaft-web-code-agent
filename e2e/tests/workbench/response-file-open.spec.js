import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestServer } from '../../fixtures/test-server.js';

// Browser component integration: production AssistantTurn, Pinia chat action,
// WorkbenchPanel, FilesTab, CodeMirror and route fencing all run unchanged.
// Authentication/server relay are replaced by an in-page transport so this test
// can deterministically exercise cold mounts and absolute response paths.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
function mountHarness() {
  const params = new URLSearchParams(location.search);
  const filePath = params.get('file') || 'docs/guide.txt';
  const TEXT_CONTENT = ['zero', 'one', 'target line', 'three'].join('\n');
  const CONTENT = params.get('content') || TEXT_CONTENT;
  // Reads and writes share one byte record after the UI canonicalizes the path.
  const canonicalPath = path => path.startsWith('/') ? path : `/fixture/project/${path}`;
  const fileContents = new Map([[canonicalPath(filePath), CONTENT]]);
  const { createApp, reactive } = Vue;
  const pinia = Pinia.createPinia();
  const sessions = reactive({
    activeSessionId: 'session-y', activeSessionKey: 'agent-b\u001fsession-y',
    sessions: {
      'agent-b\u001fsession-y': { id: 'session-y', agentId: 'agent-b', workDir: '/fixture/project' },
    },
    sessionById(id, agentId) {
      return Object.values(this.sessions).find(item => item.id === id && (!agentId || item.agentId === agentId)) || null;
    },
  });
  window.Pinia.useSessionsStore = () => sessions;
  window.Pinia.useChatStore = useChatStore;
  const store = useChatStore(pinia);
  Object.assign(store, {
    authenticated: true, connectionState: 'connected', currentView: 'yeaft',
    currentAgent: 'agent-a',
    currentAgentInfo: { id: 'agent-a', capabilities: ['terminal'] },
    agents: [
      { id: 'agent-a', capabilities: ['terminal'] },
      { id: 'agent-b', capabilities: ['terminal', 'file_editor', 'file_reference_resolution', 'workbench_session_routes'] },
    ],
    yeaftActiveSessionFilter: 'session-y',
    yeaftConversationId: 'wrong-page-conversation',
    yeaftConversationIdsByAgent: { 'agent-b': 'yeaft-agent-b' },
    workbenchRouteProtocolSupported: true,
    workbenchExpanded: false,
    currentWorkDir: '/wrong',
    theme: 'light',
  });
  document.documentElement.dataset.theme = params.get('theme') || 'light';
  store.theme = document.documentElement.dataset.theme;
  const requests = [];
  // Deliberately omit requestedFilePath and return the canonical absolute
  // path. The request id must correlate this response to the relative tab.
  const respondFile = message => {
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      type: 'file_content', requestId: message.requestId,
      filePath: canonicalPath(message.filePath), content: fileContents.get(canonicalPath(message.filePath)),
      agentId: message.agentId, conversationId: message.conversationId,
      workbenchRouteKey: message.workbenchRouteKey,
      workbenchWorkspaceGeneration: message.workbenchWorkspaceGeneration,
    } }));
  };
  // Writes are deliberately acknowledged by the test, allowing stale/foreign
  // file_saved messages and edits made while the save is pending to be tested.
  const respondSaved = (message, overrides = {}) => {
    if (!overrides.error && ['requestId', 'agentId', 'conversationId', 'workbenchRouteKey', 'workbenchWorkspaceGeneration']
      .every(key => overrides[key] === undefined || overrides[key] === message[key])) {
      fileContents.set(canonicalPath(message.filePath), message.content);
    }
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      ...message, type: 'file_saved', content: undefined, ...overrides,
    } }));
  };
  store.sendWsMessage = message => {
    requests.push(structuredClone(message));
    if (message.type === 'resolve_file_references') {
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
        type: 'file_references_resolved', requestId: message.requestId,
        references: message.references.map(requestedPath => ({ requestedPath, resolvedPath: requestedPath.split('#')[0] })),
      } })));
    } else if (message.type === 'read_file') {
      queueMicrotask(() => respondFile(message));
    }
    return true;
  };
  const turn = reactive({
    isStreaming: false,
    textSegments: [{
      key: 'result',
      kind: 'result',
      content: `[open guide](${filePath}#L3)`,
    }],
  });
  const app = createApp({
    components: { AssistantTurn, WorkbenchPanel },
    template: '<main><AssistantTurn :turn="turn" conversation-id="display-only"/><WorkbenchPanel/></main>',
    setup: () => ({ turn }),
  });
  app.use(pinia);
  app.provide('t', (key, values = {}) => String(key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? ''));
  app.config.globalProperties.$t = key => key;
  app.mount('#app');
  window.harness = {
    requests, respondSaved,
    setWorkDir(workDir) { sessions.sessions['agent-b\u001fsession-y'].workDir = workDir; },
  };
}

const HTML = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/web/styles/variables.css"><link rel="stylesheet" href="/web/styles/workbench.css"><link rel="stylesheet" href="/web/styles/files.css"><link rel="stylesheet" href="/web/styles/chat-messages.css"><link rel="stylesheet" href="/web/vendor/codemirror.min.css">
<script src="/web/vendor/vue.global.prod.js"></script><script src="/web/vendor/vue-demi.iife.js"></script><script src="/web/vendor/pinia.iife.prod.js"></script><script src="/web/vendor/marked.min.js"></script><script src="/web/vendor/codemirror.min.js"></script></head>
<body><div id="app"></div><script type="module">
import { useChatStore } from '/web/stores/chat.js';
import AssistantTurn from '/web/components/AssistantTurn.js';
import WorkbenchPanel from '/web/components/WorkbenchPanel.js';
(${mountHarness.toString()})();
</script></body></html>`;

class HarnessServer {
  async start() {
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise((ok, fail) => { this.server.once('error', fail); this.server.listen(0, '127.0.0.1', ok); });
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }
  async serve(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(HTML); return; }
    const file = resolve(ROOT, `.${url.pathname}`);
    if (!file.startsWith(join(ROOT, 'web') + sep)) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': extname(file) === '.css' ? 'text/css' : 'text/javascript' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  }
  async stop() { if (this.server) await new Promise(resolve => this.server.close(resolve)); }
}

const test = base.extend({ harness: async ({}, use) => useTestServer(new HarnessServer(), use) });

const HTML_CONTENT = `<!doctype html>
<html lang="en" dir="ltr" class="workspace-design" style="font-size: 18px"><head><title>Workspace mockup</title><style>
  body { margin: 0; font: 16px sans-serif; }
  .mockup { padding: 24px; border-top: 8px solid rgb(25, 110, 85); }
  h1 { color: rgb(25, 110, 85); overflow-wrap: anywhere; }
</style></head><body><main class="mockup">
  <h1 id="preview-heading">HTML workbench mockup</h1>
  <p>Static workspace design, editable without saving.</p>
  <p>${'Long preview content remains scrollable. '.repeat(100)}</p>
</main></body></html>`;

function htmlHarnessUrl(harness, { file = 'docs/mockup.html', content = HTML_CONTENT, theme = 'light' } = {}) {
  const params = new URLSearchParams({ file, content, theme });
  return `${harness.url}/?${params}`;
}

async function openReference(page, filePath) {
  const link = page.locator('.message-file-reference');
  await expect(link).toHaveAttribute('data-resolved-file-path', filePath);
  await link.click();
  await expect(page.locator('.file-content-path [aria-current="location"]')).toHaveText(filePath.split('/').at(-1));
}

async function expectHtmlPreview(page, heading = 'HTML workbench mockup') {
  await expect(page.getByRole('button', { name: 'files.preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'files.edit', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.html-preview-iframe')).toBeVisible();
  await expect(page.frameLocator('.html-preview-iframe').locator('#preview-heading')).toHaveText(heading);
  await expect(page.locator('.CodeMirror')).toHaveCount(0);
}

const saveButton = page => page.locator('.file-content-actions button[title="common.save (Ctrl+S)"]');

const SECURITY_CONTENT = `<!doctype html><html><head>
  <base href="/\u005f\u005fhtml-preview-probe__/base/">
  <meta http-equiv="refresh" content="0;url=/__html-preview-probe__/refresh">
  <link rel="stylesheet" href="/__html-preview-probe__/style.css">
  <style>
    @import url('https://preview.invalid/__html-preview-probe__/import.css');
    #preview-heading { color: rgb(10, 120, 80); }
    #remote-css { background-image: url('https://preview.invalid/__html-preview-probe__/background.png'); }
    #local-css { background-image: url('/__html-preview-probe__/background.png'); }
  </style>
  <script>parent.__htmlPreviewTouched = true; parent.document.body.dataset.previewTouched = 'yes'; fetch('/__html-preview-probe__/script');</script>
  <script src="/__html-preview-probe__/script.js"></script>
</head><body>
  <h1 id="preview-heading">HTML workbench mockup</h1>
  <img id="data-image" alt="Data pixel" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=">
  <img id="error-image" src="data:image/png;base64,broken" onerror="document.body.dataset.handlerRan = 'yes'; parent.__htmlPreviewTouched = true; parent.document.body.dataset.previewTouched = 'yes'; fetch('/__html-preview-probe__/onerror')">
  <img src="https://preview.invalid/__html-preview-probe__/remote.png"><img src="/__html-preview-probe__/root.png"><img src="__html-preview-probe__/relative.png">
  <div id="remote-css">Remote CSS asset</div><div id="local-css">Local CSS asset</div>
  <a id="remote-link" href="https://preview.invalid/__html-preview-probe__/link" target="_top" ping="/__html-preview-probe__/ping">Remote link</a>
  <a id="local-link" href="/__html-preview-probe__/link">Local link</a>
  <a id="anchor-link" href="#preview-heading">In-document link</a>
  <svg width="250" height="100" xmlns:xlink="http://www.w3.org/1999/xlink">
    <a id="svg-xlink" xlink:href="/__html-preview-probe__/xlink"><rect width="100" height="100" fill="green"/></a>
    <a id="svg-smil" href="#preview-heading"><set attributeName="href" to="/__html-preview-probe__/smil" begin="0s"/>
      <animate attributeName="xlink:href" to="/__html-preview-probe__/animate" begin="0s" dur="1s" fill="freeze"/>
      <rect x="120" width="100" height="100" fill="blue"/></a>
  </svg>
  <div id="shadow-open"><template shadowrootmode="open"><a href="/__html-preview-probe__/shadow-open">Open shadow link</a>
    <div><template shadowrootmode="closed"><svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="/__html-preview-probe__/shadow-nested"><set attributeName="href" to="/__html-preview-probe__/shadow-smil" begin="0s"/><rect width="50" height="50"/></a></svg></template></div>
  </template></div>
  <div id="shadow-closed"><template shadowrootmode="closed"><a href="/__html-preview-probe__/shadow-closed">Closed shadow link</a></template></div>
  <math><mtext id="math-link" href="/__html-preview-probe__/math-link">Math link</mtext></math>
  <form action="/__html-preview-probe__/form" method="post"><input name="secret" value="preview-only"><button type="submit">Submit form</button></form>
  <iframe src="/__html-preview-probe__/frame"></iframe><object data="/__html-preview-probe__/object"></object>
</body></html>`;

test('HTML static sandbox renders inline styles/data images but cannot execute or contact app/server', async ({ page, context, harness }, testInfo) => {
  const attempts = [];
  const routed = [];
  const failures = [];
  // Match the path, not the harness query string containing the source fixture.
  const isProbe = url => url.pathname.includes('__html-preview-probe__');
  context.on('request', request => { if (isProbe(new URL(request.url()))) attempts.push(request.url()); });
  context.on('requestfailed', request => { if (isProbe(new URL(request.url()))) failures.push({ url: request.url(), error: request.failure()?.errorText }); });
  // Abort any regression attempt before it can actually reach a server.
  await context.route(isProbe, route => { routed.push(route.request().url()); return route.abort(); });
  await page.goto(htmlHarnessUrl(harness, { content: SECURITY_CONTENT }));
  await page.evaluate(() => { window.__htmlPreviewTouched = false; });
  await openReference(page, 'docs/mockup.html');
  await expectHtmlPreview(page);
  const iframe = page.locator('.html-preview-iframe');
  const frame = page.frameLocator('.html-preview-iframe');
  await expect(iframe).toHaveAttribute('sandbox', '');
  await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await iframe.evaluate(el => el.contentDocument)).toBeNull(); // opaque, not same-origin
  await expect(frame.locator('#preview-heading')).toHaveCSS('color', 'rgb(10, 120, 80)');
  await expect.poll(() => frame.locator('#data-image').evaluate(el => el.complete && el.naturalWidth)).toBe(1);
  await expect.poll(() => frame.locator('#error-image').evaluate(el => el.complete && el.naturalWidth === 0)).toBe(true);
  await expect(frame.locator('script, base, link, meta[http-equiv="refresh"], iframe, object')).toHaveCount(0);
  await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /default-src 'none'.*script-src 'none'.*img-src data:.*form-action 'none'/);
  await expect(frame.locator('#remote-link')).not.toHaveAttribute('href');
  await expect(frame.locator('#remote-link')).not.toHaveAttribute('target');
  await expect(frame.locator('#remote-link')).not.toHaveAttribute('ping');
  await expect(frame.locator('#local-link')).not.toHaveAttribute('href');
  await expect(frame.locator('#anchor-link')).not.toHaveAttribute('href');
  await expect(frame.locator('#svg-xlink')).not.toHaveAttribute('xlink:href');
  await expect(frame.locator('#svg-smil')).not.toHaveAttribute('href');
  await expect(frame.locator('set, animate, template')).toHaveCount(0);
  await expect(frame.locator('#shadow-open')).toBeEmpty();
  await expect(frame.locator('#shadow-closed')).toBeEmpty();
  expect(await frame.locator('#shadow-open').evaluate(el => el.shadowRoot)).toBeNull();
  await expect(frame.locator('#math-link')).not.toHaveAttribute('href');
  await frame.locator('#math-link').click();
  await frame.locator('#svg-xlink rect').click();
  await frame.locator('#svg-smil rect').click();
  await frame.locator('#remote-link').click();
  await frame.locator('#local-link').click();
  await frame.locator('#anchor-link').click();
  await frame.getByRole('button', { name: 'Submit form' }).click();
  // This is a bounded observation window for blocked asynchronous asset loads,
  // form submission and refresh, not a sleep used to make UI assertions pass.
  await page.waitForTimeout(250);
  // Chromium reports request/requestfailed even for CSP-blocked CSS loads;
  // every such event must fail with CSP before reaching the network interceptor.
  expect(routed).toEqual([]);
  expect(failures.map(item => item.url).sort()).toEqual([...attempts].sort());
  for (const failure of failures) expect(failure.error).toMatch(/csp/i);
  expect(page.url()).toBe(htmlHarnessUrl(harness, { content: SECURITY_CONTENT }));
  await expectHtmlPreview(page);
  await expect(frame.locator('body')).not.toHaveAttribute('data-handler-ran');
  expect(await page.evaluate(() => ({ touched: window.__htmlPreviewTouched, marker: document.body.dataset.previewTouched }))).toEqual({ touched: false, marker: undefined });
  expect(await iframe.evaluate(el => el.contentWindow.location.href).catch(error => error.message)).toMatch(/cross-origin|SecurityError|Blocked a frame/i);
  await testInfo.attach('html-static-sandbox', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Markdown retains default Preview, unsaved rendering, undo and correlated saves', async ({ page, harness }) => {
  const file = 'docs/README.md';
  await page.goto(htmlHarnessUrl(harness, { file, content: '# Markdown regression\n\nOriginal body.' }));
  await openReference(page, file);
  await expect(page.getByRole('button', { name: 'files.preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.md-file-preview h1')).toHaveText('Markdown regression');
  await expect(page.locator('.html-preview-iframe, .CodeMirror')).toHaveCount(0);
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await expect(page.locator('.CodeMirror')).toBeVisible();
  // A normal edit (not setValue) preserves CodeMirror undo semantics.
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.replaceRange('\n\nUnsaved addition.', { line: 2, ch: 14 }));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.md-file-preview')).toContainText('Unsaved addition.');
  await expect(page.locator('.CodeMirror')).toHaveCount(0);
  await expect(page.locator('.file-content-dirty')).toBeVisible();
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await expect(page.locator('.CodeMirror')).toBeVisible();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.undo());
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.replaceRange('Saved ', { line: 0, ch: 2 }));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.md-file-preview h1')).toHaveText('Saved Markdown regression');
  await saveButton(page).click();
  const write = await page.evaluate(() => window.harness.requests.find(msg => msg.type === 'write_file'));
  expect(write).toMatchObject({ filePath: `/fixture/project/${file}`, content: '# Saved Markdown regression\n\nOriginal body.' });
  await page.evaluate(message => window.harness.respondSaved(message), write);
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
});

const SVG_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 240 120">
  <defs><linearGradient id="paint"><stop stop-color="#067a68"/><stop offset="1" stop-color="#75e3c1"/></linearGradient>
    <filter id="shadow"><feGaussianBlur stdDeviation="1"/></filter><path id="shape" d="M0 0h30v30H0z"/></defs>
  <rect width="240" height="120" fill="#f3f4f6"/>
  <use xlink:href="#shape" x="180" y="20" fill="url(#paint)" filter="url(#shadow)"/>
  <rect x="10" y="25" width="40" height="40" fill="#067a68"><animate attributeName="x" values="10;110;10" dur="1s" repeatCount="indefinite"/></rect>
  <style>@keyframes fade { from { opacity: .2 } to { opacity: 1 } } .css-motion { animation: fade .5s infinite alternate; }</style>
  <circle class="css-motion" cx="200" cy="85" r="12" fill="#067a68"/>
  <text x="10" y="100" font-size="16">SVG preview 中文</text>
</svg>`;

async function expectSvgPreview(page) {
  await expect(page.getByRole('button', { name: 'files.preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const image = page.locator('.svg-preview-image');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.CodeMirror, .svg-preview-container iframe, .svg-preview-container svg')).toHaveCount(0);
  return image;
}

// Returns pixels from the image renderer, not an inline SVG DOM. This verifies
// real gradients/filter/use and animation rendering in the image security mode.
async function svgPixels(image) {
  return image.evaluate(el => {
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(el, 0, 0, 240, 120);
    return Array.from(ctx.getImageData(0, 0, 240, 120).data);
  });
}

test('SVG opens visually on desktop/narrow light/dark, zooms and preserves unsaved source/undo/save', async ({ page, harness }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const file = 'docs/场景.SVG';
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(htmlHarnessUrl(harness, { file, content: SVG_CONTENT, theme }));
      await openReference(page, file);
      const image = await expectSvgPreview(page);
      const bounds = await image.boundingBox();
      expect(bounds.width).toBeGreaterThan(20);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      // Local fragment references and filters must still paint in image mode.
      const pixels = await svgPixels(image);
      const pixel = (x, y) => pixels.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 4);
      expect(pixel(195, 35)).not.toEqual(pixel(230, 35));
      await testInfo.attach(`svg-${theme}-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
      await page.getByRole('button', { name: 'message.imagePreview', exact: true }).click();
      await expect(page.locator('.image-preview-overlay')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.image-preview-overlay')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'message.imagePreview', exact: true })).toBeFocused();
    }
  }
  // Unsaved edits render immediately; returning to Edit retains undo history.
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await expect(page.locator('.CodeMirror')).toBeVisible();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.replaceRange('<!-- unsaved -->\n', { line: 0, ch: 0 }));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  const image = await expectSvgPreview(page);
  expect(await image.evaluate(async el => (await fetch(el.src)).text())).toContain('<!-- unsaved -->');
  await expect(page.locator('.file-content-dirty')).toBeVisible();
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.undo());
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.replaceRange('<!-- saved -->\n', { line: 0, ch: 0 }));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expectSvgPreview(page);
  await saveButton(page).click();
  const write = await page.evaluate(() => window.harness.requests.find(msg => msg.type === 'write_file'));
  expect(write).toMatchObject({ filePath: `/fixture/project/${file}`, content: `<!-- saved -->\n${SVG_CONTENT}` });
  await page.evaluate(message => window.harness.respondSaved(message), write);
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
  // Workspace changes deactivate the previous KeepAlive host while zoom is open.
  await page.getByRole('button', { name: 'message.imagePreview', exact: true }).click();
  await expect(page.locator('.image-preview-overlay')).toBeVisible();
  await page.evaluate(() => window.harness.setWorkDir('/fixture/other-project'));
  await expect(page.locator('.image-preview-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const key = new KeyboardEvent('keydown', { key: '+', cancelable: true });
    document.dispatchEvent(key);
    return key.defaultPrevented;
  })).toBe(false);
  expect(errors).toEqual([]);
});

test('SVG image mode animates but never runs scripts, navigates or fetches linked resources', async ({ page, context, harness }) => {
  const attempts = [];
  const isProbe = url => url.pathname.includes('__svg-preview-probe__');
  context.on('request', request => { if (isProbe(new URL(request.url()))) attempts.push(request.url()); });
  await context.route(isProbe, route => route.abort());
  const content = SVG_CONTENT.replace('</svg>', `
    <script>parent.__svgPreviewTouched = true;
      try { localStorage.setItem('__svgPreviewTouched', 'owned'); document.documentElement.setAttribute('data-storage', 'allowed'); }
      catch { document.documentElement.setAttribute('data-storage', 'denied'); }
    </script>
    <script href="/__svg-preview-probe__/script.js"/>
    <style>@import url('https://preview.invalid/__svg-preview-probe__/style.css'); text { font-family: probe; }
      @font-face { font-family: probe; src: url('/__svg-preview-probe__/font.woff2'); }</style>
    <image href="https://preview.invalid/__svg-preview-probe__/image.png" width="10" height="10"/>
    <use href="/__svg-preview-probe__/other.svg#shape"/>
    <a href="/__svg-preview-probe__/navigate" target="_top"><rect width="240" height="120" fill="transparent"/>
      <set attributeName="href" to="/__svg-preview-probe__/smil" begin="0s"/></a>
    <foreignObject width="240" height="120"><div xmlns="http://www.w3.org/1999/xhtml">
      <img src="/__svg-preview-probe__/html.png" onerror="parent.__svgPreviewTouched = true"/>
      <iframe src="/__svg-preview-probe__/frame"/>
    </div></foreignObject>
  </svg>`).replace('viewBox="0 0 240 120"', 'viewBox="0 0 240 120" onload="parent.__svgPreviewTouched = true"');
  await page.goto(htmlHarnessUrl(harness, { file: 'scene.svg', content: SVG_CONTENT }));
  await openReference(page, 'scene.svg');
  const image = await expectSvgPreview(page);
  const firstPixels = await svgPixels(image);
  // A positive rendered-pixel change proves declarative animation survives.
  await expect.poll(async () => JSON.stringify(await svgPixels(image)) !== JSON.stringify(firstPixels)).toBe(true);
  // foreignObject deliberately taints canvas reads, so probe its security with
  // real request/navigation/parent-DOM observation instead of canvas pixels.
  await page.goto(htmlHarnessUrl(harness, { file: 'scene.svg', content }));
  await page.evaluate(() => { window.__svgPreviewTouched = false; });
  await openReference(page, 'scene.svg');
  await expectSvgPreview(page);
  await page.getByRole('button', { name: 'message.imagePreview', exact: true }).click();
  await expect(page.locator('.image-preview-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__svgPreviewTouched)).toBe(false);
  expect(attempts).toEqual([]);
  expect(page.url()).toBe(htmlHarnessUrl(harness, { file: 'scene.svg', content }));
  // The exact image URL can be opened as an active SVG document through native
  // browser UI. It must never inherit Yeaft's origin or access its credentials.
  const source = await page.locator('.svg-preview-image').getAttribute('src');
  expect(source).toMatch(/^data:image\/svg\+xml;/);
  const direct = await context.newPage();
  await direct.goto(source);
  await expect(direct.locator('svg')).toHaveAttribute('data-storage', 'denied');
  expect(await direct.evaluate(() => window.origin)).toBe('null');
  expect(await page.evaluate(() => localStorage.getItem('__svgPreviewTouched'))).toBeNull();
  await direct.close();
});

test('invalid or empty SVG exposes an error and can be repaired from Edit without saving', async ({ page, harness }) => {
  await page.goto(htmlHarnessUrl(harness, { file: 'broken.svg', content: '<svg>malformed' }));
  await openReference(page, 'broken.svg');
  await expect(page.locator('.svg-preview-container [role="alert"]')).toHaveText('files.svgPreviewLoadFailed');
  await expect(page.locator('.svg-preview-container [role="status"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue(''));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.svg-preview-container [role="alert"]')).toHaveText('files.svgPreviewLoadFailed');
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await page.evaluate(content => document.querySelector('.CodeMirror').CodeMirror.setValue(content), SVG_CONTENT);
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expectSvgPreview(page);
  await expect(page.locator('.file-content-dirty')).toBeVisible();
});

test('CSV table previews are inert, responsive, paginated and retain unsaved edit/undo/save', async ({ page, harness }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const file = 'docs/数据.CSV';
  const content = '\ufeff名称,备注,数量\r\n"A,B","line 1\nline ""2""",001\r\n' +
    '"<img src=x onerror=alert(1)>","=SUM(A1:A2)",\r\n' +
    Array.from({ length: 60 }, (_, i) => `row-${i},${'long content '.repeat(15)},${i}`).join('\r\n');
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(htmlHarnessUrl(harness, { file, content, theme }));
      await openReference(page, file);
      await expect(page.getByRole('button', { name: 'files.preview', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.CodeMirror')).toHaveCount(0);
      await expect(page.locator('.csv-preview-table thead th').nth(1)).toHaveText('名称');
      await expect(page.locator('.csv-preview-table tbody tr')).toHaveCount(50);
      const firstRow = page.locator('.csv-preview-table tbody tr').first();
      await expect(firstRow.locator('td').nth(0)).toHaveText('A,B');
      await expect(firstRow.locator('td').nth(1)).toHaveText('line 1\nline "2"');
      await expect(firstRow.locator('td').nth(2)).toHaveText('001');
      await expect(page.locator('.csv-preview-table tbody tr').nth(1)).toContainText('<img src=x onerror=alert(1)>');
      await expect(page.locator('.csv-preview-container img, .csv-preview-container script, .csv-preview-container iframe')).toHaveCount(0);
      const scroll = page.locator('.csv-preview-scroll');
      await scroll.focus();
      await expect(scroll).toBeFocused();
      const bounds = await scroll.boundingBox();
      expect(bounds.width).toBeGreaterThan(20);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      await scroll.evaluate(el => { el.scrollTop = 500; el.scrollLeft = 100; });
      const header = await page.locator('.csv-preview-table thead th').first().boundingBox();
      expect(Math.abs(header.y - bounds.y)).toBeLessThan(2);
      await testInfo.attach(`csv-${theme}-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
      await page.getByRole('button', { name: 'files.csvNext', exact: true }).click();
      await expect(page.locator('.csv-preview-table tbody tr')).toHaveCount(12);
      await expect(page.locator('.csv-preview-table tbody tr').first().locator('td').first()).toHaveText('row-48');
      await expect(page.getByRole('button', { name: 'files.csvNext', exact: true })).toBeDisabled();
      await page.locator('.csv-preview-toolbar input').uncheck();
      await expect(page.locator('.csv-preview-table tbody tr').first().locator('td').first()).toHaveText('名称');
      await page.locator('.csv-preview-toolbar input').check();
    }
  }
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await expect(page.locator('.CodeMirror')).toBeVisible();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.replaceRange('Changed ', { line: 0, ch: 0 }));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.csv-preview-table thead th').nth(1)).toContainText('Changed');
  await expect(page.locator('.file-content-dirty')).toBeVisible();
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.undo());
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('"bad'));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.csv-preview-container [role="alert"]')).toHaveText('files.csvInvalid');
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue(''));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.csv-preview-container [role="status"]')).toHaveText('files.csvEmpty');
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  const large = 'name,value\n' + Array.from({ length: 1001 }, (_, i) => `${i},${i}`).join('\n');
  await page.evaluate(value => document.querySelector('.CodeMirror').CodeMirror.setValue(value), large);
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.csv-preview-notice')).toHaveText('files.csvLimited');
  await expect(page.locator('.csv-preview-table tbody tr')).toHaveCount(50);
  await saveButton(page).click();
  const write = await page.evaluate(() => window.harness.requests.find(msg => msg.type === 'write_file'));
  expect(write.content).toBe(large); // preview limits must never truncate the saved file.
  await page.evaluate(message => window.harness.respondSaved(message), write);
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
  // A multiline or very long sticky header must never cover the data viewport.
  const longHeader = '"' + 'long header\n'.repeat(800) + '",value\nAlice,001\nBob,002';
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await page.evaluate(value => document.querySelector('.CodeMirror').CodeMirror.setValue(value), longHeader);
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  const header = page.locator('.csv-header-content').first();
  expect((await header.boundingBox()).height).toBeLessThan(150);
  await header.focus();
  await expect(header).toBeFocused();
  await header.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('.csv-preview-table tbody tr').first().locator('td').first()).toHaveText('Alice');
  const data = await page.locator('.csv-preview-table tbody tr').first().boundingBox();
  const heading = await page.locator('.csv-preview-table thead').boundingBox();
  expect(data.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
  await page.getByRole('button', { name: 'files.edit', exact: true }).click();
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('"' + 'x'.repeat(1000000) + '"'));
  await page.getByRole('button', { name: 'files.preview', exact: true }).click();
  await expect(page.locator('.csv-preview-container')).toContainText('files.csvNoCompleteRecords');
  await expect(page.locator('.csv-preview-container')).not.toContainText('files.csvEmpty');
  expect(errors).toEqual([]);
});
