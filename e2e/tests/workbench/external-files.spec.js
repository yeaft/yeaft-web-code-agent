import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { WebSocketServer } from 'ws';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestServer } from '../../fixtures/test-server.js';
import { handleCreateFile, handleListDirectory, handleReadFile, handleWriteFile } from '../../../agent/workbench/file-ops.js';
import { handleFileSearch } from '../../../agent/workbench/file-search.js';
import { handleGitStatus } from '../../../agent/workbench/git-ops.js';
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
<link rel="stylesheet" href="/styles/variables.css"><link rel="stylesheet" href="/styles/workbench.css"><link rel="stylesheet" href="/styles/files.css"><link rel="stylesheet" href="/styles/terminal.css"><link rel="stylesheet" href="/styles/chat-messages.css"><link rel="stylesheet" href="/vendor/codemirror.min.css">
<style>html,body,#app{height:100%;margin:0}#app{display:flex}.workbench-panel{height:100%}</style>
<script src="/vendor/vue.global.prod.js"></script><script src="/vendor/vue-demi.iife.js"></script><script src="/vendor/pinia.iife.prod.js"></script><script src="/vendor/codemirror.min.js"></script>
</head><body><div id="app"></div><script type="module">
import { useChatStore } from '/stores/chat.js';
import { useSessionsStore } from '/stores/sessions.js';
import WorkbenchPanel from '/components/WorkbenchPanel.js';
import FilesTab from '/components/FilesTab.js';
import { workbenchRouteKey, workbenchWorkspaceGeneration } from '/utils/workbench-route.js';
import translations from '/i18n/en.js';
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
    const handler = { create_file: handleCreateFile, list_directory: handleListDirectory, read_file: handleReadFile, write_file: handleWriteFile, file_search: handleFileSearch, git_status: handleGitStatus }[message.type];
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
    // Match server/index.js: web/ is the static root, not a URL prefix.
    const file = resolve(ROOT, 'web', `.${url.pathname}`);
    if (!file.startsWith(join(ROOT, 'web') + sep)) { response.writeHead(404).end(); return; }
    try {
      // Optional read-only candidate used for red/green validation from an
      // independent test worktree; no production source is copied or modified.
      const body = await readFile(url.pathname === '/components/FilesTab.js'
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

function treeEntry(page, path) { return page.locator(`[data-tree-path=${JSON.stringify(path)}]`); }

async function expectLocated(page, path) {
  await expect(treeEntry(page, path)).toHaveClass(/tree-navigation-current/);
}

// A loopback frame barrier drains production onmessage + Vue's batched watchers,
// then the serialized Agent dispatcher. Negative assertions need not sleep for
// a reconnect timeout or mistake "not sent yet" for "never retried".

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

// One real Files -> Agent bytes -> worker -> shared table workflow, across themes
// and narrow layouts. This is not a mocked sheet_to_html/component harness.
test('local Excel previews scroll, select, copy, sort and filter without writing source files', async ({ page, context, harness }, testInfo) => {
  const sandbox = {};
  runInNewContext(await readFile(join(ROOT, 'web/vendor/xlsx.min.js'), 'utf8'), sandbox);
  const XLSX = sandbox.XLSX;
  const book = XLSX.utils.book_new();
  const values = Array.from({ length: 81 }, (_, r) => Array.from({ length: 24 }, (_, c) =>
    r === 0 ? `Heading ${c}` : c === 0 ? `row-${r}` : c === 1 ? 82 - r : `${r}:${c} long cell content`));
  values[1][2] = '<img src=x onerror=alert(1)>';
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), '<svg onload=alert(1)>');
  XLSX.utils.book_append_sheet(book, {}, 'Empty');
  XLSX.utils.book_append_sheet(book, { A1500: { t: 's', v: 'Data outside preview' }, '!ref': 'A1500' }, 'Sparse');
  const bytes = Buffer.from(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
  const path = join(harness.workDir, 'sheet.xlsx');
  await writeFile(path, bytes);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = [];
  const workerUrls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => workerUrls.push(worker.url()));
  for (const [theme, width] of [['light', 1280], ['dark', 320]]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(harness.url);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; localStorage.setItem('officePreviewMode', 'local'); }, theme);
    await openFiles(page);
    await page.evaluate(path => window.harness.openFile(path), path);
    await expect(page.locator('.spreadsheet-preview tbody tr')).toHaveCount(50);
    await expect(page.locator('.xlsx-sheet-tab').first()).toHaveText('<svg onload=alert(1)>');
    await expect(page.locator('.spreadsheet-preview img, .spreadsheet-preview svg, .spreadsheet-preview a')).toHaveCount(0);
    const scroll = page.locator('.csv-preview-scroll');
    const bounds = await scroll.boundingBox();
    expect(bounds.width).toBeGreaterThan(20);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    await scroll.evaluate(el => { el.scrollTop = 300; el.scrollLeft = 600; });
    expect(await scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    expect(await scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const corner = await page.locator('thead .csv-row-number').boundingBox();
    expect(Math.abs(corner.x - bounds.x)).toBeLessThan(2);
    expect(Math.abs(corner.y - bounds.y)).toBeLessThan(2);
    const rowNumber = await page.locator('tbody .csv-row-number').nth(15).boundingBox();
    expect(Math.abs(rowNumber.x - bounds.x)).toBeLessThan(2);
    await testInfo.attach(`sheet-${theme}-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
    await scroll.evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
    await page.locator('input[type=checkbox]').check();
    const cells = page.locator('tbody tr').first().locator('td');
    await cells.nth(0).click();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.locator('.table-cell-selected')).toHaveCount(2);
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('row-1\t81');
    await page.locator('.table-sort').nth(1).click();
    await expect(page.locator('tbody tr').first().locator('td').first()).toHaveText('row-80');
    await expect(page.locator('tbody th').first()).toHaveText('81');
    await page.locator('input[type=search]').fill('row-80');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.locator('select').selectOption('1');
    await expect(page.getByText('No matching rows.', { exact: true })).toBeVisible();
    await page.locator('.xlsx-sheet-tab').nth(1).click();
    await expect(page.getByText('No data in the preview range', { exact: false })).toBeVisible();
    await expect(page.getByText('This worksheet is empty.', { exact: true })).toHaveCount(0);
    await page.locator('.xlsx-sheet-tab').nth(2).click();
    await expect(page.getByText('No data in the preview range', { exact: false })).toBeVisible();
    await expect(page.getByText('This worksheet is empty.', { exact: true })).toHaveCount(0);
    await page.locator('.xlsx-sheet-tab').first().click();
    await expect(page.locator('tbody tr')).toHaveCount(50);
    await expect(page.locator('input[type=search]')).toHaveValue('');
    await page.locator('tbody tr').nth(49).locator('td').first().click();
    await expect(page.locator('.table-cell-selected')).toHaveCount(1);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(31);
    await expect(page.locator('.table-copy')).toBeDisabled();
  }
  expect(workerUrls.length).toBeGreaterThanOrEqual(2);
  expect(workerUrls.every(url => url === `${harness.url}/spreadsheet-worker.js`)).toBe(true);
  // The old URL must not be a harness alias that could mask a source-app 404.
  expect((await page.request.get(`${harness.url}/web/spreadsheet-worker.js`)).status()).toBe(404);
  expect(await readFile(path)).toEqual(bytes);
  expect(harness.requests.some(message => message.type === 'write_file')).toBe(false);
  expect(errors).toEqual([]);
});
