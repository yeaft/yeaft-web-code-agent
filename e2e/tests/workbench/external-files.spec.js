import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestServer } from '../../fixtures/test-server.js';
import { handleListDirectory, handleReadFile, handleWriteFile } from '../../../agent/workbench/file-ops.js';
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
    authenticated: true, connectionState: 'connected', currentView: 'yeaft',
    // Intentionally disagree with the selected Session owner.
    currentAgent: 'agent-a', currentAgentInfo: { id: 'agent-a', workDir: config.otherAgentDir, capabilities },
    agents: [
      { id: 'agent-a', workDir: config.otherAgentDir, capabilities },
      { id: 'agent-b', workDir: config.workDir, capabilities },
    ],
    yeaftActiveSessionFilter: 'session-y', yeaftConversationId: 'unrelated-page-conversation',
    yeaftConversationIdsByAgent: { 'agent-b': 'yeaft-agent-b', 'agent-a': 'yeaft-agent-a' },
    workbenchRouteProtocolSupported: true, workbenchExpanded: true,
    currentWorkDir: config.otherAgentDir, theme: 'light',
  });
  const sent = [];
  const received = [];
  const bridgeErrors = [];
  const pending = new Set();
  store.sendWsMessage = message => {
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
  const app = createApp({ components: { WorkbenchPanel }, template: '<WorkbenchPanel/>' });
  app.use(pinia);
  app.provide('t', t);
  app.config.globalProperties.$t = t;
  app.mount('#app');
  window.harness = {
    store, sessions, sent, received, bridgeErrors,
    async selectSession(agentId, sessionId) {
      sessions.activeSessionKey = `${agentId}\u001f${sessionId}`;
      sessions.activeSessionId = sessionId;
      store.yeaftActiveSessionFilter = sessionId;
      await nextTick();
    },
    async idle() { while (pending.size) await Promise.all([...pending]); await nextTick(); },
    async openFile(path) {
      window.dispatchEvent(new CustomEvent('workbench-open-file-in-active-view', { detail: {
        filePath: path, workbenchRouteKey: 'yeaft:agent-b:session-y', hideTree: true,
      } }));
      await nextTick();
    },
  };
}

function html(config) {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/web/styles/variables.css"><link rel="stylesheet" href="/web/styles/workbench.css"><link rel="stylesheet" href="/web/styles/files.css"><link rel="stylesheet" href="/web/styles/terminal.css"><link rel="stylesheet" href="/web/styles/chat-messages.css"><link rel="stylesheet" href="/web/vendor/codemirror.min.css">
<script src="/web/vendor/vue.global.prod.js"></script><script src="/web/vendor/vue-demi.iife.js"></script><script src="/web/vendor/pinia.iife.prod.js"></script><script src="/web/vendor/codemirror.min.js"></script>
</head><body><div id="app"></div><script type="module">
import { useChatStore } from '/web/stores/chat.js';
import { useSessionsStore } from '/web/stores/sessions.js';
import WorkbenchPanel from '/web/components/WorkbenchPanel.js';
import translations from '/web/i18n/en.js';
(${mountHarness.toString()})(${JSON.stringify(config)});
</script></body></html>`;
}

class ExternalFilesServer {
  requests = [];
  results = [];
  previews = new Map();
  pending = Promise.resolve();

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
    await new Promise((ok, fail) => {
      this.server.once('error', fail); this.server.listen(0, '127.0.0.1', ok);
    });
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  async dispatch(message) {
    this.requests.push(message);
    // Tab persistence belongs to Server, not these Agent file handlers. It is
    // synthesized only for the tab-restore test; file/directory replies are real.
    if (message.type === 'restore_file_tabs' && this.restoreFiles) return [{ ...message, type: 'file_tabs_restored', openFiles: this.restoreFiles.map(path => ({ path })), activeIndex: this.restoreIndex || 0 }];
    if (['restore_file_tabs', 'update_file_tabs'].includes(message.type)) return [];
    const handler = { list_directory: handleListDirectory, read_file: handleReadFile, write_file: handleWriteFile, file_search: handleFileSearch }[message.type];
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
      response.end(html({ workDir: this.browserWorkDir || this.workDir, otherSessionDir: this.otherSessionDir, otherAgentDir: this.otherAgentDir }));
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
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': extname(file) === '.css' ? 'text/css' : 'text/javascript' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  }

  async stop() {
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
    await page.evaluate(path => window.harness.openFile(path), `${root.toUpperCase()}/OTHER.TXT`);
    await expectLocated(page, `${root}/Other.txt`);
    await page.getByRole('tab', { name: 'file.txt', exact: true }).click();
    await expectLocated(page, located);
    expect(requests.filter(message => message.type === 'list_directory')).toHaveLength(3);
    expect(requests.every(message => message.workDir === root)).toBe(true);
    expect(await page.evaluate(() => window.harness.bridgeErrors)).toEqual([]);
  });
}
