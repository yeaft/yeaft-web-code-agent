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
  const CONTENT = ['zero', 'one', 'target line', 'three'].join('\n');
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
  const requests = [];
  const failure = new URLSearchParams(location.search).get('failure');
  let resolveAttempts = 0;
  let readAttempts = 0;
  // Deliberately omit requestedFilePath and return the canonical absolute
  // path. The request id must correlate this response to the relative tab.
  const respondFile = (message, result = { content: CONTENT }) => {
    window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
      type: 'file_content', requestId: message.requestId,
      filePath: '/fixture/project/docs/guide.txt', ...result,
      agentId: message.agentId, conversationId: message.conversationId,
      workbenchRouteKey: message.workbenchRouteKey,
      workbenchWorkspaceGeneration: message.workbenchWorkspaceGeneration,
    } }));
  };
  store.sendWsMessage = message => {
    requests.push(structuredClone(message));
    if (message.type === 'resolve_file_references') {
      const fail = ++resolveAttempts === 1 && failure === 'resolve-error';
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
        type: 'file_references_resolved', requestId: message.requestId,
        ...(fail ? { error: 'temporary resolver failure' } : {
          references: message.references.map(requestedPath => ({ requestedPath, resolvedPath: 'docs/guide.txt' })),
        }),
      } })));
    } else if (message.type === 'read_file') {
      const firstRead = ++readAttempts === 1;
      if (firstRead && ['read-send', 'restore-send'].includes(failure)) return false;
      if (firstRead && failure === 'read-disconnect') return true;
      const result = firstRead && failure === 'read-error' ? { error: 'temporary read failure' } : { content: CONTENT };
      queueMicrotask(() => respondFile(message, result));
    } else if (message.type === 'restore_file_tabs' && failure === 'restore-send') {
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('workbench-message', { detail: {
        type: 'file_tabs_restored', restoreRequestId: message.restoreRequestId,
        openFiles: [{ path: 'docs/guide.txt' }], activeIndex: 0,
        agentId: message.agentId, conversationId: message.conversationId,
        workbenchRouteKey: message.workbenchRouteKey,
        workbenchWorkspaceGeneration: message.workbenchWorkspaceGeneration,
      } })));
    }
    return true;
  };
  const turn = reactive({
    isStreaming: false,
    textSegments: [{ key: 'result', kind: 'result', content: '[open guide](docs/guide.txt#L3)' }],
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
    store, requests, sessions, respondFile,
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

async function clickResolvedReference(page) {
  const link = page.locator('.message-file-reference');
  await expect(link).toHaveAttribute('data-resolved-file-path', 'docs/guide.txt');
  await link.click();
  await expect(page.locator('.file-content-path strong')).toHaveText('guide.txt');
  await expect(page.locator('.CodeMirror')).toContainText('target line');
}

test('response links load real Files across cold/open/close, routes, line, mobile and theme', async ({ page, harness }) => {
  page.on('pageerror', error => console.error('PAGE ERROR', error));
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(harness.url);
  await expect(page.locator('.workbench-panel')).not.toHaveClass(/expanded/);

  // Cold Yeaft open uses the Session owner even though currentAgent and the
  // page-level conversation pointer intentionally disagree.
  await clickResolvedReference(page);
  await expect(page.locator('.files-tab')).toHaveClass(/mobile-editor-view/);
  await expect(page.locator('.file-two-col')).toHaveClass(/tree-collapsed/);
  await expect.poll(() => page.evaluate(() => document.querySelector('.CodeMirror')?.CodeMirror?.getCursor().line)).toBe(2);
  const firstRead = await page.evaluate(() => window.harness.requests.find(item => item.type === 'read_file'));
  expect(firstRead).toMatchObject({ agentId: 'agent-b', conversationId: '_workbench:yeaft:agent-b:session-y', filePath: 'docs/guide.txt' });

  // Collapse/reopen keeps the mounted Files capability and loaded content.
  await page.locator('.workbench-panel-close').click();
  await expect(page.locator('.workbench-panel')).not.toHaveClass(/expanded/);
  await page.locator('.message-file-reference').click();
  await expect(page.locator('.workbench-panel')).toHaveClass(/expanded/);
  await expect(page.locator('.CodeMirror')).toContainText('target line');

  // An already-open different capability is replaced by Files on click.
  await page.evaluate(() => {
    const store = window.harness.store;
    const routeKey = 'yeaft:agent-b:session-y';
    window.dispatchEvent(new CustomEvent('workbench-open-capability', { detail: { routeKey, capabilityId: 'terminal' } }));
  });
  await expect(page.locator('.workbench-item-tab.active')).toContainText('workbench.terminal');
  await page.locator('.workbench-panel-close').click();
  await page.locator('.message-file-reference').click();
  await expect(page.locator('.workbench-item-tab.active')).toContainText('guide.txt');
  await expect(page.locator('.file-content-path strong')).toHaveText('guide.txt');

  // Theme changes reach the real editor.
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.harness.store.theme = 'dark'; });
  await expect(page.locator('.CodeMirror')).toHaveClass(/cm-s-material-darker/);

  // Rebind the same production components to a CLI route and verify its
  // Workbench correlation id rather than the unrelated display conversation.
  await page.evaluate(() => window.harness.useCli());
  await expect(page.locator('.message-file-reference')).toHaveAttribute('data-resolved-file-path', 'docs/guide.txt');
  await page.locator('.message-file-reference').click();
  await expect(page.locator('.file-content-path strong')).toHaveText('guide.txt');
  const cliRead = await page.evaluate(() => window.harness.requests.filter(item => item.type === 'read_file').at(-1));
  expect(cliRead).toMatchObject({ agentId: 'agent-b', conversationId: '_workbench:claude-code:agent-b:cli-1', filePath: 'docs/guide.txt' });
});

test('completed response links recover from a temporary resolver error', async ({ page, harness }) => {
  await page.goto(`${harness.url}/?failure=resolve-error`);
  await clickResolvedReference(page);
  const resolves = await page.evaluate(() => window.harness.requests.filter(msg => msg.type === 'resolve_file_references'));
  expect(resolves).toHaveLength(2);
  expect(resolves[0].requestId).not.toBe(resolves[1].requestId);
});

for (const failure of ['read-send', 'read-error', 'read-disconnect', 'restore-send']) {
  test(`clicking a response link retries ${failure} and rejects the old read`, async ({ page, harness }) => {
    await page.goto(`${harness.url}/?failure=${failure}`);
    const link = page.locator('.message-file-reference');
    await expect(link).toHaveAttribute('data-resolved-file-path', 'docs/guide.txt');
    if (failure === 'restore-send') {
      // Open Files without a link click so the restored tab owns the first read.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('workbench-open-capability', {
        detail: { routeKey: 'yeaft:agent-b:session-y', capabilityId: 'files' },
      })));
    } else {
      await link.click();
    }
    if (failure === 'read-disconnect') {
      await expect(page.locator('.file-load-state')).toBeVisible();
      await page.evaluate(() => { window.harness.store.connectionState = 'disconnected'; });
      await expect(page.locator('.file-load-error')).toContainText('files.readInterrupted');
      await page.evaluate(() => { window.harness.store.connectionState = 'connected'; });
    }
    await expect(page.locator('.file-load-error')).toBeVisible();
    const oldRead = await page.evaluate(() => window.harness.requests.find(msg => msg.type === 'read_file'));
    await clickResolvedReference(page);
    await expect.poll(() => page.evaluate(() => document.querySelector('.CodeMirror')?.CodeMirror?.getCursor().line)).toBe(2);
    const reads = await page.evaluate(() => window.harness.requests.filter(msg => msg.type === 'read_file'));
    expect(reads).toHaveLength(2);
    expect(reads[1].requestId).not.toBe(oldRead.requestId);
    expect(reads[1]).toMatchObject({ agentId: 'agent-b', filePath: 'docs/guide.txt', workbenchRouteKey: 'yeaft:agent-b:session-y' });

    // A delayed old request must not replace the recovered editor content.
    await page.evaluate(message => window.harness.respondFile(message, { content: 'STALE FILE CONTENT' }), oldRead);
    await expect(page.locator('.CodeMirror')).toContainText('target line');
    await expect(page.locator('.CodeMirror')).not.toContainText('STALE FILE CONTENT');
    await link.click();
    expect(await page.evaluate(() => window.harness.requests.filter(msg => msg.type === 'read_file').length)).toBe(2);
  });
}
