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
const CONTENT = ['zero', 'one', 'target line', 'three'].join('\n');

function mountHarness() {
  const params = new URLSearchParams(location.search);
  const filePath = params.get('file') || 'docs/guide.txt';
  const TEXT_CONTENT = ['zero', 'one', 'target line', 'three'].join('\n');
  const CONTENT = params.get('content') || TEXT_CONTENT;
  const fileContents = new Map([[filePath, CONTENT]]);
  const { createApp, reactive, nextTick } = Vue;
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
  const failure = params.get('failure');
  const inlineFallback = params.get('source') === 'inline-fallback';
  if (inlineFallback) {
    store.agents[1].capabilities = store.agents[1].capabilities.filter(capability => capability !== 'file_reference_resolution');
  }
  let resolveAttempts = 0;
  let readAttempts = 0;
  // Deliberately omit requestedFilePath and return the canonical absolute
  // path. The request id must correlate this response to the relative tab.
  const respondFile = (message, result = { content: fileContents.get(message.filePath) || TEXT_CONTENT }) => {
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      type: 'file_content', requestId: message.requestId,
      filePath: `/fixture/project/${message.filePath}`, ...result,
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
      fileContents.set(message.filePath, message.content);
    }
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      ...message, type: 'file_saved', content: undefined, ...overrides,
    } }));
  };
  store.sendWsMessage = message => {
    requests.push(structuredClone(message));
    if (message.type === 'resolve_file_references') {
      const fail = ++resolveAttempts === 1 && failure === 'resolve-error';
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
        type: 'file_references_resolved', requestId: message.requestId,
        ...(fail ? { error: 'temporary resolver failure' } : {
          references: message.references.map(requestedPath => ({ requestedPath, resolvedPath: requestedPath.split('#')[0] })),
        }),
      } })));
    } else if (message.type === 'read_file') {
      const firstRead = ++readAttempts === 1;
      if (firstRead && ['read-send', 'restore-send'].includes(failure)) return false;
      if (firstRead && failure === 'read-disconnect') return true;
      const result = firstRead && failure === 'read-error' ? { error: 'temporary read failure' }
        : { content: fileContents.get(message.filePath) || TEXT_CONTENT };
      queueMicrotask(() => respondFile(message, result));
    } else if (message.type === 'restore_file_tabs' && (failure === 'restore-send' || params.has('restore'))) {
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
        type: 'file_tabs_restored', restoreRequestId: message.restoreRequestId,
        openFiles: [{ path: filePath }], activeIndex: 0,
        agentId: message.agentId, conversationId: message.conversationId,
        workbenchRouteKey: message.workbenchRouteKey,
        workbenchWorkspaceGeneration: message.workbenchWorkspaceGeneration,
      } })));
    }
    return true;
  };
  const turn = reactive({
    isStreaming: false,
    textSegments: [{
      key: 'result',
      kind: 'result',
      content: inlineFallback ? `Try \`${filePath}:3\`` : `[open guide](${filePath}#L3)`,
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
    store, requests, sessions, respondFile, respondSaved,
    async showReference(path) {
      turn.textSegments[0].content = `[open guide](${path}#L3)`;
      await nextTick();
    },
    async useCli() {
      store.currentView = 'chat';
      store.conversations = [{ id: 'cli-1', agentId: 'agent-b', provider: 'claude-code' }];
      store.activeConversations = ['cli-1'];
      store.currentWorkDir = '/fixture/project';
      await nextTick();
    },
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

function htmlHarnessUrl(harness, { file = 'docs/mockup.html', content = HTML_CONTENT, theme = 'light', restore = false } = {}) {
  const params = new URLSearchParams({ file, content, theme });
  if (restore) params.set('restore', '1');
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
  expect(write).toMatchObject({ filePath: file, content: '# Saved Markdown regression\n\nOriginal body.' });
  await page.evaluate(message => window.harness.respondSaved(message), write);
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
});
