import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestServer } from '../../fixtures/test-server.js';
import { handleCreateFile, handleListDirectory, handleReadFile, handleWriteFile } from '../../../agent/workbench/file-ops.js';
import { handleFileSearch } from '../../../agent/workbench/file-search.js';
import agentContext from '../../../agent/context.js';

// Component + Agent integration, not an authenticated Server/owner-relay test.
// Production WorkbenchPanel, FilesTab, chat/session stores and Agent handlers run
// unchanged. Only transport, Server-side preview storage and the session selector
// are a loopback harness. Fixtures live in a disposable tmpdir, never an instance.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OWNER = { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'session-y' };
const ROUTE = 'yeaft:agent-b:session-y';
const ORIGINAL_TEXT = 'Real file outside the session workspace.\nOriginal disk content.\n';
const EDITED_TEXT = 'Edited through the real Files editor.\nSaved outside the session workspace.\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function bitmap(width, height) {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * stride + x * 3;
      bytes[offset] = 0x33; bytes[offset + 1] = 0x66; bytes[offset + 2] = 0xcc;
    }
  }
  return bytes;
}

function mountHarness(config) {
  const { createApp, nextTick } = Vue;
  const pinia = Pinia.createPinia();
  Pinia.setActivePinia(pinia);
  window.Pinia.useChatStore = useChatStore;
  window.Pinia.useSessionsStore = useSessionsStore;
  const store = useChatStore(pinia);
  const sessions = useSessionsStore(pinia);
  Object.assign(sessions, {
    inventoryIdentityMode: 'agent-scoped',
    activeSessionId: 'session-y', activeSessionKey: 'agent-b\u001fsession-y',
    sessionOrder: ['agent-b\u001fsession-y', 'agent-b\u001fsession-z', 'agent-a\u001fsession-y'],
    sessions: {
      'agent-b\u001fsession-y': { id: 'session-y', agentId: 'agent-b', workDir: config.workDir },
      'agent-b\u001fsession-z': { id: 'session-z', agentId: 'agent-b', workDir: config.otherSessionDir },
      'agent-a\u001fsession-y': { id: 'session-y', agentId: 'agent-a', workDir: config.otherAgentDir },
    },
  });
  const capabilities = ['file_editor', 'workbench_session_routes'];
  Object.assign(store, {
    authenticated: !config.webSocket, connectionState: config.webSocket ? 'disconnected' : 'connected', currentView: 'yeaft',
    // Intentionally disagree with the selected Session owner.
    currentAgent: 'agent-a', currentAgentInfo: { id: 'agent-a', workDir: config.otherAgentDir, capabilities },
    agents: [
      { id: 'agent-a', workDir: config.otherAgentDir, capabilities },
      { id: 'agent-b', workDir: config.workDir, capabilities },
    ],
    yeaftActiveSessionFilter: 'session-y', yeaftConversationId: 'unrelated-page-conversation',
    yeaftConversationIdsByAgent: { 'agent-b': 'yeaft-agent-b', 'agent-a': 'yeaft-agent-a' },
    workbenchRouteProtocolSupported: config.webSocket ? null : true, workbenchExpanded: true,
    currentWorkDir: config.otherAgentDir, theme: 'light',
  });
  const sent = [];
  const received = [];
  const frames = [];
  const bridgeErrors = [];
  const pending = new Set();
  if (config.webSocket) {
    // Observe production message dispatch without replacing send/parse/handlers.
    window.addEventListener('workbench-message', event => received.push(event.detail));
    store.$onAction(({ name, args }) => {
      if (name === 'sendWsMessage') sent.push(structuredClone(args[0]));
      if (name === 'handleMessage') frames.push(structuredClone(args[0]));
    });
  } else store.sendWsMessage = message => {
    sent.push(structuredClone(message));
    // Agent dispatch is serialized, but replies may be delayed/reordered by a
    // test route without blocking independent requests from the real component.
    const request = (async () => {
      const response = await fetch('/bridge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(await response.text());
      for (const result of await response.json()) {
        received.push(result);
        window.dispatchEvent(new CustomEvent('workbench-message', { detail: result }));
      }
    })().catch(error => { bridgeErrors.push(String(error)); });
    pending.add(request);
    request.finally(() => pending.delete(request));
    return true;
  };
  const t = (key, values = {}) => (translations[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
  // Panel deliberately unmounts unavailable capabilities when connect() resets
  // protocol flags. Keep the real FilesTab mounted in socket mode to exercise
  // its interruption/resume contract rather than Panel's capability gate.
  const route = { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'session-y' };
  const routeKey = workbenchRouteKey(route);
  const app = createApp(config.webSocket && !config.panel ? {
    components: { FilesTab },
    setup: () => ({ mounted: Vue.ref(false), routeProps: Vue.reactive({
      ...route, routeKey, conversationId: `_workbench:${routeKey}`, workDir: config.workDir,
      workspaceGeneration: workbenchWorkspaceGeneration(routeKey, config.workDir),
    }) }),
    template: '<FilesTab v-if="mounted" v-bind="routeProps"/>',
  } : { components: { WorkbenchPanel }, template: '<WorkbenchPanel/>' });
  app.use(pinia);
  app.provide('t', t);
  app.config.globalProperties.$t = t;
  const root = app.mount('#app');
  window.harness = {
    async mountFiles(owner = route) {
      const key = workbenchRouteKey(owner);
      Object.assign(root.routeProps, owner, {
        routeKey: key, conversationId: `_workbench:${key}`,
        workspaceGeneration: workbenchWorkspaceGeneration(key, config.workDir),
      });
      root.mounted = true;
      await nextTick();
    },
    store, sessions, sent, received, frames, bridgeErrors,
    async selectSession(agentId, sessionId) {
      sessions.activeSessionKey = `${agentId}\u001f${sessionId}`;
      sessions.activeSessionId = sessionId;
      store.yeaftActiveSessionFilter = sessionId;
      await nextTick();
    },
    async idle() { while (pending.size) await Promise.all([...pending]); await nextTick(); },
    async openFile(path, ownerKey = 'yeaft:agent-b:session-y') {
      window.dispatchEvent(new CustomEvent('workbench-open-file-in-active-view', { detail: {
        filePath: path, workbenchRouteKey: ownerKey, hideTree: true,
      } }));
      await nextTick();
    },
  };
  if (config.webSocket) store.connect();
}

function html(config) {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/web/styles/variables.css"><link rel="stylesheet" href="/web/styles/workbench.css"><link rel="stylesheet" href="/web/styles/files.css"><link rel="stylesheet" href="/web/styles/terminal.css"><link rel="stylesheet" href="/web/styles/chat-messages.css"><link rel="stylesheet" href="/web/vendor/codemirror.min.css">
<script src="/web/vendor/vue.global.prod.js"></script><script src="/web/vendor/vue-demi.iife.js"></script><script src="/web/vendor/pinia.iife.prod.js"></script><script src="/web/vendor/codemirror.min.js"></script>
</head><body><div id="app"></div><script type="module">
import { useChatStore } from '/web/stores/chat.js';
import { useSessionsStore } from '/web/stores/sessions.js';
import WorkbenchPanel from '/web/components/WorkbenchPanel.js';
import FilesTab from '/web/components/FilesTab.js';
import { workbenchRouteKey, workbenchWorkspaceGeneration } from '/web/utils/workbench-route.js';
import translations from '/web/i18n/en.js';
(${mountHarness.toString()})(${JSON.stringify(config)});
</script></body></html>`;
}

class ExternalFilesServer {
  requests = [];
  results = [];
  previews = new Map();
  pending = Promise.resolve();
  sockets = [];
  socketFrames = [];
  socketErrors = [];
  heldListings = [];
  holdDirectories = new Set();

  constructor({ webSocket = false } = {}) { this.webSocket = webSocket; this.panel = false; }

  async start() {
    this.directory = await mkdtemp(join(tmpdir(), 'yeaft-external-files-e2e-'));
    this.workDir = join(this.directory, 'workspace');
    this.externalDir = join(this.directory, 'external');
    this.otherSessionDir = join(this.directory, 'other-session');
    this.otherAgentDir = join(this.directory, 'other-agent');
    for (const directory of [this.workDir, this.externalDir, this.otherSessionDir, this.otherAgentDir]) {
      await mkdir(directory);
    }
    this.textPath = join(this.externalDir, 'external.txt');
    this.imagePath = join(this.externalDir, 'external.bmp');
    this.deepDir = join(this.workDir, 'first-long-directory', 'second-long-directory', 'third-long-directory');
    this.deepPath = join(this.deepDir, 'deep-file.txt');
    await mkdir(this.deepDir, { recursive: true });
    await writeFile(this.deepPath, 'Deep file content.\n');
    this.image = bitmap(32, 24);
    await writeFile(this.textPath, ORIGINAL_TEXT);
    await writeFile(this.imagePath, this.image);
    await writeFile(join(this.workDir, 'workspace.txt'), 'Session workspace, not the external folder.\n');
    await writeFile(join(this.otherSessionDir, 'other-session.txt'), 'Another session.\n');
    await writeFile(join(this.otherAgentDir, 'other-agent.txt'), 'Same session id, another Agent.\n');
    this.server = createServer((request, response) => {
      this.serve(request, response).catch(error => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
    });
    if (this.webSocket) {
      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on('connection', (socket, request) => {
        this.sockets.push(socket);
        if (new URL(request.url, 'http://localhost').searchParams.get('type') !== 'web') {
          this.socketErrors.push('Expected production web socket URL');
        }
        socket.on('error', error => this.socketErrors.push(String(error)));
        socket.on('message', data => {
          const message = JSON.parse(data.toString());
          this.socketFrames.push({ connection: this.sockets.indexOf(socket), message });
          const result = this.pending.then(async () => {
            if (message.type === 'client_hello') return; // Handshake stages are controlled by the test.
            if (message.type === 'get_agents') {
              // Do not replace the selected Session or use Server inventory to
              // synthesize directory/file responses. Complete only the handshake side request.
              this.sendFrame({ type: 'yeaft_session_hydrate_complete', requestId: message.requestId, ok: false, error: 'harness_no_inventory' }, socket);
              return;
            }
            if (message.type === 'ping') { this.sendFrame({ type: 'pong', requestId: message.requestId }, socket); return; }
            const results = await this.dispatch(message);
            if (message.type === 'list_directory' && this.holdDirectories.delete(message.dirPath)) {
              this.heldListings.push({ message, results });
            } else for (const response of results) this.sendFrame(response, socket);
          });
          this.pending = result.catch(error => this.socketErrors.push(String(error)));
        });
      });
    }
    await new Promise((ok, fail) => {
      this.server.once('error', fail); this.server.listen(0, '127.0.0.1', ok);
    });
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  sendFrame(message, socket = this.sockets.at(-1)) {
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
    else throw new Error(`Cannot send ${message.type}: loopback socket is not open`);
  }

  authenticate() {
    this.sendFrame({ type: 'auth_result', success: true, acceptPlaintext: true, yeaftSessionInventoryComplete: true });
  }

  acknowledgeHello(workCenterWorkbenchProtocol = 1) {
    this.sendFrame({ type: 'client_hello_ack', workbenchRouteProtocol: 1, workCenterWorkbenchProtocol });
  }

  async dispatch(message) {
    this.requests.push(message);
    // Tab persistence belongs to Server, not these Agent file handlers. It is
    // synthesized only for the tab-restore test; file/directory replies are real.
    if (message.type === 'restore_file_tabs' && this.restoreFiles) return [{ ...message, type: 'file_tabs_restored', openFiles: this.restoreFiles.map(path => ({ path })), activeIndex: this.restoreIndex || 0 }];
    if (['restore_file_tabs', 'update_file_tabs'].includes(message.type)) return [];
    const handler = { create_file: handleCreateFile, list_directory: handleListDirectory, read_file: handleReadFile, write_file: handleWriteFile, file_search: handleFileSearch }[message.type];
    if (!handler) throw new Error(`Unexpected bridge request: ${message.type}`);
    const results = [];
    const previous = { sendToServer: agentContext.sendToServer, CONFIG: agentContext.CONFIG };
    try {
      agentContext.CONFIG = { workDir: this.workDir };
      agentContext.sendToServer = result => { results.push(result); return 'sent'; };
      await handler(message);
    } finally { Object.assign(agentContext, previous); }
    this.results.push(...results);
    return results.map(result => {
      // Mimic only Server preview storage, using bytes returned by the real
      // Agent. Never re-read the source or synthesize a successful file reply.
      const relayed = { ...result, agentId: message.agentId };
      if (result.type === 'file_content' && result.binary && !result.error) {
        const id = `asset-${this.previews.size + 1}`;
        this.previews.set(id, { bytes: Buffer.from(result.content, 'base64'), mimeType: result.mimeType });
        delete relayed.content;
        relayed.previewUrl = `/preview/${id}`;
      }
      return relayed;
    });
  }

  async serve(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/bridge' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      const result = this.pending.then(() => this.dispatch(message));
      this.pending = result.catch(() => {});
      const results = await result;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(results));
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(html({ workDir: this.browserWorkDir || this.workDir, otherSessionDir: this.otherSessionDir, otherAgentDir: this.otherAgentDir, webSocket: this.webSocket, panel: this.panel }));
      return;
    }
    if (url.pathname.startsWith('/preview/')) {
      const preview = this.previews.get(url.pathname.split('/').pop());
      if (!preview) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': preview.mimeType, 'Content-Length': preview.bytes.length });
      response.end(preview.bytes);
      return;
    }
    const file = resolve(ROOT, `.${url.pathname}`);
    if (!file.startsWith(join(ROOT, 'web') + sep)) { response.writeHead(404).end(); return; }
    try {
      // Optional read-only candidate used for red/green validation from an
      // independent test worktree; no production source is copied or modified.
      const body = await readFile(url.pathname === '/web/components/FilesTab.js'
        && process.env.E2E_FILES_TAB_SOURCE ? process.env.E2E_FILES_TAB_SOURCE : file);
      response.writeHead(200, { 'Content-Type': extname(file) === '.css' ? 'text/css' : 'text/javascript' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  }

  async stop() {
    if (this.wss) {
      for (const socket of this.wss.clients) socket.terminate();
      await new Promise(ok => this.wss.close(ok));
    }
    if (this.server) {
      this.server.closeIdleConnections();
      await new Promise(ok => this.server.close(ok));
    }
    await this.pending;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

const test = base.extend({ harness: async ({}, use) => useTestServer(new ExternalFilesServer(), use) });
const socketTest = test.extend({ harness: async ({}, use) => useTestServer(new ExternalFilesServer({ webSocket: true }), use) });

async function openFiles(page) {
  // Panel restores route-local expansion on mount/switch, just as the app does.
  await page.evaluate(() => { window.harness.store.workbenchExpanded = true; });
  await page.locator('[data-workbench-capability="files"]').click();
  await expect(page.locator('.files-tab')).toBeVisible();
}

async function selectExternalFolder(page, harness) {
  await page.goto(harness.url);
  await openFiles(page);
  await expect(page.locator('.vscode-folder-name')).toHaveAttribute('title', harness.workDir);
  await expect(page.locator('.tree-name').filter({ hasText: /^workspace\.txt$/ })).toBeVisible();
  await page.locator('.vscode-action-btn[title="Open Folder"]').click();
  await expect(page.locator('.folder-picker-current')).toHaveText(harness.workDir);
  // Both directories are siblings under the disposable root. Navigate the
  // real picker, rather than injecting an external path or file into a tab.
  await page.locator('.folder-picker-path button').click();
  await expect(page.locator('.folder-picker-current')).toHaveText(harness.directory);
  await page.locator('.folder-picker-item').filter({ hasText: /^external$/ }).click();
  await page.locator('.folder-picker-footer button').click();
  await expect(page.locator('.folder-picker-overlay')).toHaveCount(0);
  await expect(page.locator('.vscode-folder-name')).toHaveAttribute('title', harness.externalDir);
  await expect(page.locator('.tree-name').filter({ hasText: /^external\.txt$/ })).toBeVisible();
  const picker = harness.requests.filter(message => message.workbenchScope === 'files-folder-picker');
  expect(picker).toHaveLength(2);
  for (const message of picker) {
    expect(message).toMatchObject({
      agentId: OWNER.agentId, workbenchRoute: OWNER, workDir: harness.workDir,
      workbenchRouteKey: ROUTE, conversationId: `_workbench:${ROUTE}:files-folder-picker`,
    });
  }
}

async function expectRealRead(page, harness, path) {
  await expect.poll(() => harness.results.some(result => result.type === 'file_content' && result.requestedFilePath === path)).toBe(true);
  const result = harness.results.find(result => result.type === 'file_content' && result.requestedFilePath === path);
  await page.evaluate(() => window.harness.idle());
  expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
  // A baseline failure explicitly exposes the Agent error instead of timing out
  // on a missing editor/image or hiding the outside-workspace response.
  if (result.error) await expect(page.locator('.file-load-error')).toContainText(result.error);
  expect(result.error, JSON.stringify(result)).toBeFalsy();
  expect(result.filePath).toBe(path);
  expect(result.workbenchRouteKey).toBe(ROUTE);
  const request = harness.requests.find(message => message.type === 'read_file' && message.filePath === path);
  expect(request).toMatchObject({
    agentId: OWNER.agentId, workbenchRoute: OWNER, workDir: harness.workDir,
    workbenchRouteKey: ROUTE, conversationId: `_workbench:${ROUTE}`, workbenchScope: 'main',
  });
  expect(request.workbenchWorkspaceGeneration).toMatch(new RegExp(`^${ROUTE}@`));
  return result;
}

async function expectOriginalOwner(page, harness) {
  expect(await page.evaluate(() => ({
    route: window.harness.store.activeSessionRoute,
    workDir: window.harness.store.effectiveWorkDir,
    currentAgent: window.harness.store.currentAgent,
    session: window.harness.sessions.sessionById('session-y', 'agent-b'),
  }))).toMatchObject({
    route: OWNER, workDir: harness.workDir, currentAgent: 'agent-a',
    session: { id: 'session-y', agentId: 'agent-b', workDir: harness.workDir },
  });
}

test('ordinary Session Files selects, reads and saves outside workDir without moving Agent/session ownership', async ({ page, harness }) => {
  await selectExternalFolder(page, harness);
  await expectOriginalOwner(page, harness);
  await page.locator('.tree-name').filter({ hasText: /^external\.txt$/ }).click();
  const result = await expectRealRead(page, harness, harness.textPath);
  expect(result.content).toBe(ORIGINAL_TEXT);
  await expect(page.locator('.CodeMirror')).toContainText('Original disk content.');
  await page.locator('.CodeMirror').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(EDITED_TEXT);
  await expect(page.locator('.file-content-dirty')).toBeVisible();
  const save = page.locator('.file-content-actions button[title="Save (Ctrl+S)"]');
  await save.click();
  await expect.poll(() => readFile(harness.textPath, 'utf8')).toBe(EDITED_TEXT);
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
  await expect(save).toBeDisabled();
  expect(harness.requests.find(message => message.type === 'write_file')).toMatchObject({
    filePath: harness.textPath, content: EDITED_TEXT, workDir: harness.workDir,
    agentId: OWNER.agentId, workbenchRoute: OWNER, workbenchRouteKey: ROUTE,
    conversationId: `_workbench:${ROUTE}`,
  });
  expect(harness.results.find(message => message.type === 'file_saved')).toMatchObject({ success: true, filePath: harness.textPath });
  await expectOriginalOwner(page, harness);

  // The same mounted Panel must not expose this external tree/tab to another
  // Session, or to an identically named Session on another Agent.
  for (const [agentId, sessionId, directory, file] of [
    ['agent-b', 'session-z', harness.otherSessionDir, 'other-session.txt'],
    ['agent-a', 'session-y', harness.otherAgentDir, 'other-agent.txt'],
  ]) {
    await page.evaluate(([agentId, sessionId]) => window.harness.selectSession(agentId, sessionId), [agentId, sessionId]);
    await openFiles(page);
    await expect(page.locator('.vscode-folder-name')).toHaveAttribute('title', directory);
    await expect(page.locator('.tree-name').filter({ hasText: file })).toBeVisible();
    await expect(page.locator('.workbench-item-tab').filter({ hasText: 'external.txt' })).toHaveCount(0);
    await expect(page.locator('.CodeMirror')).toHaveCount(0);
    expect(harness.requests.some(message => message.type === 'list_directory' && message.dirPath === directory
      && message.agentId === agentId && message.workbenchRoute.sessionId === sessionId)).toBe(true);
  }
  await page.evaluate(() => window.harness.selectSession('agent-b', 'session-y'));
  await expect(page.locator('.vscode-folder-name')).toHaveAttribute('title', harness.externalDir);
  await expect(page.locator('.CodeMirror')).toContainText('Edited through the real Files editor.');
  await expect(page.locator('.file-content-dirty')).toHaveCount(0);
  await expectOriginalOwner(page, harness);
  expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
});

test('ordinary Session Files previews real external image bytes from the Agent', async ({ page, harness }) => {
  await selectExternalFolder(page, harness);
  await page.locator('.tree-name').filter({ hasText: /^external\.bmp$/ }).click();
  const result = await expectRealRead(page, harness, harness.imagePath);
  expect(result).toMatchObject({ binary: true, mimeType: 'image/bmp' });
  expect(sha256(Buffer.from(result.content, 'base64'))).toBe(sha256(await readFile(harness.imagePath)));
  const image = page.locator('.file-preview-image');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => [element.complete, element.naturalWidth, element.naturalHeight])).toEqual([true, 32, 24]);
  const rendered = await image.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    const context = canvas.getContext('2d'); context.drawImage(element, 0, 0);
    return Array.from(context.getImageData(16, 12, 1, 1).data);
  });
  expect(rendered).toEqual([0xcc, 0x66, 0x33, 255]);
  const previewUrl = await image.getAttribute('src');
  const preview = await page.request.get(previewUrl);
  expect(preview.ok()).toBe(true);
  expect(sha256(await preview.body())).toBe(sha256(harness.image));
  await expect(page.locator('.file-load-error')).toHaveCount(0);
  await expectOriginalOwner(page, harness);
});

function treeEntry(page, path) { return page.locator(`[data-tree-path=${JSON.stringify(path)}]`); }
function crumb(page, path) { return page.locator('.file-path-crumb').and(page.locator(`[title=${JSON.stringify(path)}]`)); }
async function expectLocated(page, path) {
  await expect(treeEntry(page, path)).toHaveClass(/tree-navigation-current/);
}

async function createAgentFile(page, harness, path) {
  // Simulate Agent-side creation after the browser cached a directory listing.
  // Do not deliver file_op_result to FilesTab (that UI action refreshes the tree).
  for (const data of [
    { type: 'create_file', filePath: path },
    { type: 'write_file', filePath: path, content: 'Created after the cached listing.\n' },
  ]) {
    const response = await page.request.post(`${harness.url}/bridge`, { data: {
      ...data, workDir: harness.workDir, agentId: OWNER.agentId,
      conversationId: `_workbench:${ROUTE}`, workbenchRoute: OWNER, workbenchRouteKey: ROUTE,
    } });
    expect(response.ok()).toBe(true);
    const results = await response.json();
    expect(results).toHaveLength(1);
    expect(results[0].success, JSON.stringify(results[0])).toBe(true);
  }
}

const directoryRequests = (harness, path) => harness.requests.filter(message => (
  message.type === 'list_directory' && message.dirPath === path
));

async function connect(page, state) {
  await page.evaluate(state => { window.harness.store.connectionState = state; }, state);
}

test('Agent-created directories and files after listing locate through references, reselect and breadcrumb retry', async ({ page, harness }) => {
  await page.goto(harness.url);
  await openFiles(page);
  await expect(treeEntry(page, join(harness.workDir, 'workspace.txt'))).toBeVisible();
  await page.evaluate(() => window.harness.idle());
  const generated = join(harness.workDir, 'generated');
  const first = join(generated, 'new.txt');
  await createAgentFile(page, harness, first);
  await page.evaluate(() => window.harness.openFile('generated/new.txt'));
  await expectRealRead(page, harness, first);
  await expectLocated(page, first);
  expect(directoryRequests(harness, harness.workDir)).toHaveLength(2);
  expect(directoryRequests(harness, generated)).toHaveLength(1);

  const second = join(generated, 'another.txt');
  await createAgentFile(page, harness, second);
  await page.evaluate(path => window.harness.openFile(path), second);
  await expectRealRead(page, harness, second);
  await expectLocated(page, second);
  expect(directoryRequests(harness, generated)).toHaveLength(2);

  // An accepted missing listing must stop, not fabricate a node or keep polling.
  await crumb(page, generated).click();
  await rm(second);
  await page.locator('.vscode-action-btn[title="Refresh"]').click();
  await page.evaluate(() => window.harness.idle());
  const beforeRetry = directoryRequests(harness, generated).length;
  await crumb(page, second).click();
  await page.evaluate(() => window.harness.idle());
  expect(directoryRequests(harness, generated)).toHaveLength(beforeRetry + 1);
  await expect(treeEntry(page, second)).toHaveCount(0);
  await createAgentFile(page, harness, second);
  await page.locator('.workbench-item-tab').filter({ hasText: 'another.txt' }).click();
  await expectLocated(page, second);
  expect(directoryRequests(harness, generated)).toHaveLength(beforeRetry + 2);
  await rm(second);
  await page.locator('.vscode-action-btn[title="Refresh"]').click();
  await page.evaluate(() => window.harness.idle());
  await createAgentFile(page, harness, second);
  await crumb(page, second).click();
  await expectLocated(page, second);
  await expectOriginalOwner(page, harness);
  expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
});

test('ENOENT-removed directories recover only from a new intent and real accepted Agent listings', async ({ page, harness }) => {
  await page.goto(harness.url);
  await openFiles(page);
  const first = join(harness.workDir, 'first-long-directory');
  await expect(treeEntry(page, first)).toBeVisible();
  await rm(first, { recursive: true });
  await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
  await page.evaluate(() => window.harness.idle());
  expect(harness.results.find(result => result.type === 'directory_listing' && result.dirPath === first).error).toMatch(/ENOENT/);
  await expect(treeEntry(page, first)).toHaveCount(0);
  expect(directoryRequests(harness, first)).toHaveLength(1);
  await createAgentFile(page, harness, harness.deepPath);
  // The cached file tab has a read error, but breadcrumb navigation is independent.
  await crumb(page, harness.deepPath).click();
  await expectLocated(page, harness.deepPath);
  expect(directoryRequests(harness, harness.workDir)).toHaveLength(2);
  expect(directoryRequests(harness, first)).toHaveLength(2);
  // Tree navigation is independent of the read-error tab's recovery lifecycle.
  expect(await readFile(harness.deepPath, 'utf8')).toBe('Created after the cached listing.\n');
  await expectOriginalOwner(page, harness);
  expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
});

test('FilesTab connection watcher retries lost root and ancestor responses with new request IDs', async ({ page, harness }) => {
  const held = [];
  const holdOnce = new Set([harness.workDir, join(harness.workDir, 'first-long-directory')]);
  await page.route('**/bridge', async route => {
    const message = route.request().postDataJSON();
    if (message.type === 'list_directory' && holdOnce.delete(message.dirPath)) {
      const response = await route.fetch();
      held.push({ message, release: () => route.fulfill({ response }) });
    } else await route.continue();
  });
  await page.goto(harness.url);
  await openFiles(page);
  await expect.poll(() => held.length).toBe(1);
  await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
  await connect(page, 'disconnected');
  await held[0].release();
  await connect(page, 'connected');
  await expect.poll(() => held.length).toBe(2);
  await connect(page, 'disconnected');
  await connect(page, 'connected');
  await expectLocated(page, harness.deepPath);
  await held[1].release();
  await page.evaluate(() => window.harness.idle());
  await expectLocated(page, harness.deepPath);
  for (const path of [harness.workDir, join(harness.workDir, 'first-long-directory')]) {
    const requests = directoryRequests(harness, path);
    expect(requests).toHaveLength(2);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    expect(requests[0].workbenchWorkspaceGeneration).toBe(requests[1].workbenchWorkspaceGeneration);
    expect(requests[1].workbenchRouteKey).toBe(ROUTE);
  }
  expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
});

for (const intent of ['breadcrumb', 'bulk']) {
  test(`reconnect and late real directory response preserve a newer ${intent} intent`, async ({ page, harness }) => {
    const first = join(harness.workDir, 'first-long-directory');
    let release;
    let hold = true;
    await page.route('**/bridge', async route => {
      const message = route.request().postDataJSON();
      if (hold && message.type === 'list_directory' && message.dirPath === first) {
        hold = false;
        const response = await route.fetch();
        release = () => route.fulfill({ response });
      } else await route.continue();
    });
    await page.goto(harness.url);
    await openFiles(page);
    await expect(treeEntry(page, first)).toBeVisible();
    await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
    await connect(page, 'disconnected');
    if (intent === 'breadcrumb') await crumb(page, harness.workDir).click();
    else {
      await crumb(page, harness.workDir).click();
      await treeEntry(page, join(harness.workDir, 'workspace.txt')).click({ modifiers: ['Control'] });
    }
    await connect(page, 'connected');
    await expect.poll(() => directoryRequests(harness, first).length).toBe(2);
    await release();
    await page.evaluate(() => window.harness.idle());
    if (intent === 'breadcrumb') await expect(page.locator('.file-tree-header')).toHaveClass(/tree-navigation-current/);
    else await expect(page.locator('.tree-navigation-current')).toHaveCount(0);
    await expect(treeEntry(page, harness.deepPath)).toHaveCount(0);
    await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
    await expect(page.locator('.file-ops-toolbar')).toHaveCount(intent === 'bulk' ? 1 : 0);
    if (intent === 'bulk') await expect(treeEntry(page, join(harness.workDir, 'workspace.txt'))).toHaveClass(/selected/);
    expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
  });
}

// A loopback frame barrier drains production onmessage + Vue's batched watchers,
// then the serialized Agent dispatcher. Negative assertions need not sleep for
// a reconnect timeout or mistake "not sent yet" for "never retried".
let socketBarrier = 0;
async function flushSocket(page, harness) {
  const requestId = `harness-barrier-${++socketBarrier}`;
  harness.sendFrame({ type: 'pong', requestId });
  await expect.poll(() => page.evaluate(id => window.harness.frames.some(frame => frame.requestId === id), requestId)).toBe(true);
  await page.evaluate(async id => {
    await Vue.nextTick();
    // A round trip queues behind every retry emitted by the previous frame.
    window.harness.store.sendWsMessage({ type: 'ping', requestId: `${id}-drained` });
  }, requestId);
  await expect.poll(() => page.evaluate(id => window.harness.frames.some(frame => frame.requestId === `${id}-drained`), requestId)).toBe(true);
  await harness.pending;
}

async function handshakeSocket(page, harness) {
  await page.goto(harness.url);
  await expect.poll(() => harness.socketFrames.filter(frame => frame.message.type === 'client_hello').length).toBe(1);
  expect(harness.socketFrames[0].message).toMatchObject({ type: 'client_hello', workbenchRouteProtocol: 1 });
  harness.authenticate();
  await flushSocket(page, harness);
  harness.acknowledgeHello();
  await flushSocket(page, harness);
}

async function openSocketFiles(page, harness, owner = OWNER) {
  await handshakeSocket(page, harness);
  await page.evaluate(route => window.harness.mountFiles(route), owner);
  await expect(page.locator('.files-tab')).toBeVisible();
}

async function reconnectSocket(page, harness) {
  const connections = harness.sockets.length;
  harness.sockets.at(-1).close(1012, 'Disposable harness reconnect');
  await expect.poll(() => page.evaluate(() => window.harness.store.authenticated)).toBe(false);
  // Let the production onclose/scheduleReconnect/connect/onopen path run.
  await expect.poll(() => harness.socketFrames.some(frame => frame.connection === connections && frame.message.type === 'client_hello')).toBe(true);
  await expect.poll(() => page.evaluate(() => window.harness.store.connectionState)).toBe('connected');
  await flushSocket(page, harness);
}

async function expectNoDirectoryRetry(page, harness, before) {
  await flushSocket(page, harness);
  expect(harness.requests.filter(message => message.type === 'list_directory')).toHaveLength(before);
  expect(await page.evaluate(() => window.harness.sent.filter(message => message.type === 'list_directory').length)).toBe(before);
}

for (const intent of ['breadcrumb', 'bulk']) {
  socketTest(`real WebSocket handshake gates lost ${intent} directory retries until auth and hello ack`, async ({ page, harness }) => {
    const first = join(harness.workDir, 'first-long-directory');
    const lostPath = first;
    const stalePath = join(lostPath, 'stale-before-reconnect.txt');
    const freshPath = join(lostPath, 'fresh-after-reconnect.txt');
    await writeFile(stalePath, 'Only the withheld Agent listing contains this file.\n');
    harness.holdDirectories.add(lostPath);
    await openSocketFiles(page, harness);
    await expect(treeEntry(page, first)).toBeVisible();
    await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
    await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
    await expect.poll(() => harness.heldListings.length).toBe(1);
    const held = harness.heldListings[0];
    expect(held.results[0].error).toBeFalsy(); // Captured from the real Agent handler.
    const before = harness.requests.filter(message => message.type === 'list_directory').length;
    await reconnectSocket(page, harness);
    expect(await page.evaluate(() => ({
      authenticated: window.harness.store.authenticated,
      protocol: window.harness.store.workbenchRouteProtocolSupported,
    }))).toEqual({ authenticated: false, protocol: null });
    await expectNoDirectoryRetry(page, harness, before);
    // A user may change navigation while the replacement socket is open but
    // unauthenticated. This must not lose the interrupted load or new intent.
    await crumb(page, harness.workDir).click();
    if (intent === 'bulk') await treeEntry(page, join(harness.workDir, 'workspace.txt')).click({ modifiers: ['Control'] });
    await expectNoDirectoryRetry(page, harness, before);
    harness.authenticate();
    await flushSocket(page, harness);
    expect(await page.evaluate(() => ({
      authenticated: window.harness.store.authenticated,
      protocol: window.harness.store.workbenchRouteProtocolSupported,
    }))).toEqual({ authenticated: true, protocol: false });
    await expectNoDirectoryRetry(page, harness, before);
    // Replay an old correlation ID through the NEW socket/real message handler.
    // Remove the captured entry from disk first: a newly accepted listing must
    // contain only the fresh file, so accepting the stale response is observable.
    await rm(stalePath);
    await writeFile(freshPath, 'Fresh directory listing.\n');
    for (const result of held.results) harness.sendFrame(result);
    await flushSocket(page, harness);
    expect(await page.evaluate(id => window.harness.received.some(result => result.requestId === id), held.message.requestId)).toBe(true);
    await expect(treeEntry(page, stalePath)).toHaveCount(0);
    await expectNoDirectoryRetry(page, harness, before);
    harness.acknowledgeHello();
    await expect.poll(() => directoryRequests(harness, lostPath).length).toBe(2);
    const [original, retry] = directoryRequests(harness, lostPath);
    expect(retry.requestId).not.toBe(original.requestId);
    expect(retry.workbenchWorkspaceGeneration).toBe(original.workbenchWorkspaceGeneration);
    expect(retry).toMatchObject({ workbenchRoute: OWNER, workbenchRouteKey: ROUTE, agentId: OWNER.agentId });
    await expect(treeEntry(page, freshPath)).toHaveCount(1);
    // Deliver stale bytes again AFTER retry acceptance; they cannot replace the
    // fresh listing, resume an obsolete reveal or clear newer bulk selection.
    for (const result of held.results) harness.sendFrame(result);
    await flushSocket(page, harness);
    await expect(treeEntry(page, freshPath)).toHaveCount(1);
    await expect(treeEntry(page, stalePath)).toHaveCount(0);
    if (intent === 'breadcrumb') await expect(page.locator('.file-tree-header')).toHaveClass(/tree-navigation-current/);
    if (intent === 'bulk') {
      await expect(page.locator('.tree-navigation-current')).toHaveCount(0);
      await expect(treeEntry(page, join(harness.workDir, 'workspace.txt'))).toHaveClass(/selected/);
    }
    await expect(page.locator('.file-ops-toolbar')).toHaveCount(intent === 'bulk' ? 1 : 0);
    await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
    await expectOriginalOwner(page, harness);
    expect(harness.socketErrors).toEqual([]);
    expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
  });
}

socketTest('real WebSocket WorkbenchPanel gates Files capability across the handshake and reconnect', async ({ page, harness }) => {
  harness.panel = true;
  await page.goto(harness.url);
  await expect.poll(() => harness.socketFrames.some(frame => frame.message.type === 'client_hello')).toBe(true);
  await expect(page.locator('[data-workbench-capability="files"]')).toHaveClass(/unavailable/);
  harness.authenticate();
  await flushSocket(page, harness);
  await expect(page.locator('[data-workbench-capability="files"]')).toHaveClass(/unavailable/);
  expect(directoryRequests(harness, harness.workDir)).toHaveLength(0);
  harness.acknowledgeHello();
  await flushSocket(page, harness);
  await openFiles(page);
  await expect(treeEntry(page, join(harness.workDir, 'workspace.txt'))).toBeVisible();
  await reconnectSocket(page, harness);
  // Panel intentionally unmounts unavailable tool capabilities; unlike the
  // direct FilesTab cases this validates its real remount, not retained intent.
  await expect(page.locator('.files-tab')).toHaveCount(0);
  const before = harness.requests.filter(message => message.type === 'list_directory').length;
  await expectNoDirectoryRetry(page, harness, before);
  harness.authenticate();
  await expectNoDirectoryRetry(page, harness, before);
  await expect(page.locator('.files-tab')).toHaveCount(0);
  harness.acknowledgeHello();
  await expect(page.locator('.files-tab')).toBeVisible();
  await expect(treeEntry(page, join(harness.workDir, 'workspace.txt'))).toBeVisible();
  // A new component resets its local counter; request-ID renewal is asserted
  // for interrupted loads in the continuously mounted FilesTab tests above.
  expect(directoryRequests(harness, harness.workDir)).toHaveLength(2);
  await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
  await expectLocated(page, harness.deepPath);
  await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
  await expectOriginalOwner(page, harness);
  expect(harness.socketErrors).toEqual([]);
});

socketTest('real WebSocket WorkItem retries also wait for the Work Center hello ack', async ({ page, harness }) => {
  const owner = { runtimeProvider: 'work-center', agentId: 'agent-b', workItemId: 'work-item-test' };
  const first = join(harness.workDir, 'first-long-directory');
  harness.holdDirectories.add(first);
  await openSocketFiles(page, harness, owner);
  await expect(treeEntry(page, first)).toBeVisible();
  await page.evaluate(path => window.harness.openFile(path, 'work-center:agent-b:work-item-test'), harness.deepPath);
  await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
  await expect.poll(() => harness.heldListings.length).toBe(1);
  const before = harness.requests.filter(message => message.type === 'list_directory').length;
  await reconnectSocket(page, harness);
  await expectNoDirectoryRetry(page, harness, before);
  harness.authenticate();
  await expectNoDirectoryRetry(page, harness, before);
  harness.acknowledgeHello(0);
  await flushSocket(page, harness);
  expect(await page.evaluate(() => ({
    route: window.harness.store.workbenchRouteProtocolSupported,
    workCenter: window.harness.store.workCenterWorkbenchProtocolSupported,
  }))).toEqual({ route: true, workCenter: false });
  await expectNoDirectoryRetry(page, harness, before);
  harness.acknowledgeHello();
  await expectLocated(page, harness.deepPath);
  const [original, retry] = directoryRequests(harness, first);
  expect(directoryRequests(harness, first)).toHaveLength(2);
  expect(retry.requestId).not.toBe(original.requestId);
  expect(retry).toMatchObject({ workbenchRoute: owner, workbenchRouteKey: 'work-center:agent-b:work-item-test' });
  expect(harness.socketErrors).toEqual([]);
});

socketTest('real auth_result batches a prior hello ack reset without transient directory retry', async ({ page, harness }) => {
  const first = join(harness.workDir, 'first-long-directory');
  harness.holdDirectories.add(first);
  await openSocketFiles(page, harness);
  await expect(treeEntry(page, first)).toBeVisible();
  await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
  await expect.poll(() => harness.heldListings.length).toBe(1);
  const before = harness.requests.filter(message => message.type === 'list_directory').length;
  await reconnectSocket(page, harness);
  // Legal wire reordering: ack can arrive before auth_result. The subsequent
  // auth handler sets authenticated=true before resetting protocol=false.
  harness.acknowledgeHello();
  await flushSocket(page, harness);
  expect(await page.evaluate(() => window.harness.store.workbenchRouteProtocolSupported)).toBe(true);
  await expectNoDirectoryRetry(page, harness, before);
  harness.authenticate();
  await flushSocket(page, harness);
  expect(await page.evaluate(() => window.harness.store.workbenchRouteProtocolSupported)).toBe(false);
  await expectNoDirectoryRetry(page, harness, before);
  harness.acknowledgeHello();
  await expectLocated(page, harness.deepPath);
  const requests = directoryRequests(harness, first);
  expect(requests).toHaveLength(2);
  expect(requests[1].requestId).not.toBe(requests[0].requestId);
  expect(harness.socketErrors).toEqual([]);
});

test('deep response reference, breadcrumbs, external rebasing and Workbench tab switches preserve edits and undo', async ({ page, harness }) => {
  await page.goto(harness.url);
  await openFiles(page);
  await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
  await expectRealRead(page, harness, harness.deepPath);
  await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
  // Reference entry keeps the tree collapsed; it still reveals every ancestor.
  await expect(page.locator('.files-tab')).toHaveClass(/tree-collapsed/);
  await expectLocated(page, harness.deepPath);
  const first = join(harness.workDir, 'first-long-directory');
  const second = join(first, 'second-long-directory');
  expect(harness.requests.filter(message => message.type === 'list_directory').map(message => message.dirPath))
    .toEqual([harness.workDir, first, second, harness.deepDir]);
  await page.locator('.CodeMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('unsaved local edit');
  await expect(page.locator('.file-content-dirty')).toBeVisible();
  await crumb(page, first).click();
  await expect(page.locator('.files-tab')).not.toHaveClass(/tree-collapsed/);
  await expectLocated(page, first);
  await expect(page.locator('.file-ops-toolbar')).toHaveCount(0);
  await expect(page.locator('.CodeMirror')).toContainText('unsaved local edit');
  await crumb(page, harness.workDir).click();
  await expect(page.locator('.file-tree-header')).toHaveClass(/tree-navigation-current/);
  // A normal tree click collapses a folder. Filename navigation reopens it.
  await treeEntry(page, first).click();
  await expect(treeEntry(page, harness.deepPath)).toHaveCount(0);
  await crumb(page, harness.deepPath).click();
  await expectLocated(page, harness.deepPath);
  // Bulk selections and path navigation are independent; a breadcrumb clears
  // existing destructive selections rather than selecting its folder for delete.
  await treeEntry(page, first).click({ modifiers: ['Control'] });
  await expect(page.locator('.file-ops-toolbar')).toBeVisible();
  await crumb(page, second).click();
  await expectLocated(page, second);
  await expect(page.locator('.file-ops-toolbar')).toHaveCount(0);
  await page.evaluate(path => window.harness.openFile(path), harness.textPath);
  await expectRealRead(page, harness, harness.textPath);
  await expectLocated(page, harness.textPath);
  await expect(page.locator('.vscode-folder-name')).toHaveAttribute('title', harness.externalDir);
  await page.locator('.workbench-item-tab').filter({ hasText: 'deep-file.txt' }).click();
  await expectLocated(page, harness.deepPath);
  await expect(page.locator('.vscode-folder-name')).toHaveAttribute('title', harness.deepDir);
  await expect(page.locator('.CodeMirror')).toContainText('unsaved local edit');
  await expect(page.locator('.file-content-dirty')).toBeVisible();
  await page.locator('.CodeMirror').click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.CodeMirror')).not.toContainText('unsaved local edit');
  expect(await readFile(harness.deepPath, 'utf8')).toBe('Deep file content.\n');
  expect(harness.requests.filter(message => message.type === 'read_file' && message.filePath === harness.deepPath)).toHaveLength(1);
  await expectOriginalOwner(page, harness);
});

test('Quick Open and restored active tabs locate deep files through the real tree', async ({ page, harness }) => {
  await page.goto(harness.url);
  await openFiles(page);
  await page.keyboard.press('Control+p');
  await page.locator('.quick-open-input').fill('deep-file');
  await expect(page.locator('.quick-open-item').filter({ hasText: 'deep-file.txt' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expectLocated(page, harness.deepPath);
  await expect(page.locator('.CodeMirror')).toContainText('Deep file content.');
  harness.restoreFiles = [harness.textPath, harness.deepPath];
  harness.restoreIndex = 1;
  await page.reload();
  await openFiles(page);
  await expectLocated(page, harness.deepPath);
  await expect(page.locator('.workbench-item-tab').filter({ hasText: 'external.txt' })).toBeVisible();
  await page.locator('.workbench-item-tab').filter({ hasText: 'external.txt' }).click();
  await expectLocated(page, harness.textPath);
  await expectOriginalOwner(page, harness);
});

test('late real directory/file responses cannot steal the current tab selection or resurrect an old root', async ({ page, harness }) => {
  const held = [];
  let captured;
  const capture = new Promise(ok => { captured = ok; });
  await page.route('**/bridge', async route => {
    const request = route.request().postDataJSON();
    if ((request.type === 'list_directory' && request.dirPath === join(harness.workDir, 'first-long-directory'))
      || (request.type === 'read_file' && request.filePath === harness.deepPath)) {
      const response = await route.fetch();
      held.push(() => route.fulfill({ response }));
      if (held.length === 2) captured();
    } else await route.continue();
  });
  await page.goto(harness.url);
  await openFiles(page);
  await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
  await capture;
  await page.evaluate(path => window.harness.openFile(path), harness.textPath);
  await expectLocated(page, harness.textPath);
  for (const release of held.reverse()) await release();
  await page.evaluate(() => window.harness.idle());
  await expectLocated(page, harness.textPath);
  await expect(page.locator('.vscode-folder-name')).toHaveAttribute('title', harness.externalDir);
  await expect(page.locator('.file-path-name')).toHaveText('external.txt');
  await expect(page.locator('.CodeMirror')).toContainText('Original disk content.');
  await expect(treeEntry(page, join(harness.workDir, 'first-long-directory'))).toHaveCount(0);
  expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
});

test('long breadcrumbs stay single-line, scrollable and keyboard-accessible in light/dark and 320px layouts', async ({ page, harness }) => {
  await page.goto(harness.url);
  await openFiles(page);
  await page.evaluate(path => window.harness.openFile(path), harness.deepPath);
  await expectRealRead(page, harness, harness.deepPath);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      window.harness.store.theme = theme;
    }, theme);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 720 });
      if (width === 320) await page.locator('.workbench-item-tab').filter({ hasText: 'deep-file.txt' }).click();
      const nav = page.locator('.file-content-path');
      await expect(nav).toBeVisible();
      const geometry = await nav.evaluate(element => ({
        width: element.clientWidth, scroll: element.scrollWidth,
        rows: new Set([...element.querySelectorAll('button')].map(button => Math.round(button.getBoundingClientRect().top))).size,
        right: element.getBoundingClientRect().right, viewport: window.innerWidth,
      }));
      expect(geometry.width).toBeGreaterThan(0);
      expect(geometry.rows).toBe(1);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      if (width === 320) expect(geometry.scroll).toBeGreaterThan(geometry.width);
      const folder = crumb(page, harness.deepDir);
      await folder.focus();
      await expect(folder).toBeFocused();
      await page.keyboard.press('Enter');
      await expectLocated(page, harness.deepDir);
      await expect(treeEntry(page, harness.deepDir)).toBeVisible();
      await expect(page.locator('.file-ops-toolbar')).toHaveCount(0);
      // Return to the editor on mobile without changing the active file.
      if (width === 320) await treeEntry(page, harness.deepPath).click();
    }
  }
});

for (const root of ['Q:/Work', '//Server/Share/Work']) {
  test(`Windows path casing reveals real Files tree and breadcrumbs under ${root}`, async ({ page, harness }) => {
    // Linux cannot host Windows paths. Only Windows transport replies are
    // modeled here; production FilesTab/fileTree and route handlers still run.
    // The POSIX tests above continue to exercise real Agent filesystem handlers.
    harness.browserWorkDir = root;
    const requests = [];
    const target = `${root.toLowerCase()}/deep/nested/file.txt`;
    const deep = `${root}/Deep`;
    const nested = `${deep}/Nested`;
    const located = `${nested}/File.txt`;
    const entries = {
      [root.toLowerCase()]: [{ name: 'Deep', type: 'directory' }, { name: 'Other.txt', type: 'file' }],
      [deep.toLowerCase()]: [{ name: 'Nested', type: 'directory' }],
      [nested.toLowerCase()]: [{ name: 'File.txt', type: 'file' }],
    };
    await page.route('**/bridge', async route => {
      const message = route.request().postDataJSON();
      requests.push(message);
      let results = [];
      if (message.type === 'list_directory') {
        const listing = entries[message.dirPath.toLowerCase()];
        expect(listing).toBeDefined();
        results = [{ ...message, type: 'directory_listing', dirPath: message.dirPath.toUpperCase(), entries: listing }];
      } else if (message.type === 'read_file') {
        results = [{ ...message, type: 'file_content', requestedFilePath: message.filePath,
          content: 'Windows case identity content.\n', binary: false }];
      } else expect(['restore_file_tabs', 'update_file_tabs']).toContain(message.type);
      await route.fulfill({ json: results });
    });
    await page.goto(harness.url);
    await openFiles(page);
    await expect(treeEntry(page, deep)).toBeVisible();
    await page.evaluate(path => window.harness.openFile(path), target);
    await expectLocated(page, located);
    await expect(page.locator('.CodeMirror')).toContainText('Windows case identity content.');
    expect(requests.filter(message => message.type === 'list_directory').map(message => message.dirPath))
      .toEqual([root, deep, nested]);
    await crumb(page, `${root.toLowerCase()}/deep`).click();
    await expectLocated(page, deep);
    await expect(treeEntry(page, nested)).toHaveClass(/tree-expanded/);
    await crumb(page, root.toLowerCase()).click();
    await expect(page.locator('.file-tree-header')).toHaveClass(/tree-navigation-current/);
    await treeEntry(page, deep).click();
    await expect(treeEntry(page, located)).toHaveCount(0);
    await crumb(page, target).click();
    await expectLocated(page, located);
    await expect(treeEntry(page, deep)).toHaveClass(/tree-expanded/);
    await expect(page.locator('.file-ops-toolbar')).toHaveCount(0);
    // A reference and a listing may spell the same Windows file differently.
    // Clicking the listing must keep the original dirty buffer and undo history.
    await page.locator('.CodeMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('unsaved Windows edit');
    await expect(page.locator('.file-content-dirty')).toBeVisible();
    await treeEntry(page, located).click();
    await expect(page.locator('.workbench-item-tab')).toHaveCount(1);
    await expect(page.locator('.CodeMirror')).toContainText('unsaved Windows edit');
    expect(requests.filter(message => message.type === 'read_file')).toHaveLength(1);
    await page.evaluate(path => window.harness.openFile(path), `${root.toUpperCase()}/OTHER.TXT`);
    await expectLocated(page, `${root}/Other.txt`);
    await page.getByRole('button', { name: 'Show folders', exact: true }).click();
    await treeEntry(page, located).click();
    await expect(page.locator('.workbench-item-tab')).toHaveCount(2);
    await expect(page.locator('.CodeMirror')).toContainText('unsaved Windows edit');
    await expect(page.locator('.file-content-dirty')).toBeVisible();
    expect(requests.filter(message => message.type === 'read_file')).toHaveLength(2);
    await page.locator('.CodeMirror').click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.CodeMirror')).not.toContainText('unsaved Windows edit');
    await expectLocated(page, located);
    expect(requests.filter(message => message.type === 'list_directory')).toHaveLength(3);
    expect(requests.every(message => message.workDir === root)).toBe(true);
    expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
  });
}
