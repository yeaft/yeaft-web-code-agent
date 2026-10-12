import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestServer } from '../../fixtures/test-server.js';
import { handleListDirectory, handleReadFile, handleWriteFile } from '../../../agent/workbench/file-ops.js';
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
  let pending = Promise.resolve();
  store.sendWsMessage = message => {
    sent.push(structuredClone(message));
    // Preserve request ordering over the test-only HTTP transport. Responses
    // (including outside-workspace errors) are delivered verbatim to FilesTab.
    pending = pending.then(async () => {
      const response = await fetch('/bridge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(await response.text());
      for (const result of await response.json()) {
        received.push(result);
        window.dispatchEvent(new CustomEvent('workbench-message', { detail: result }));
      }
    }).catch(error => { bridgeErrors.push(String(error)); });
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
    async idle() { await pending; await nextTick(); },
  };
}

function html(config) {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/web/styles/variables.css"><link rel="stylesheet" href="/web/styles/workbench.css"><link rel="stylesheet" href="/web/styles/files.css"><link rel="stylesheet" href="/web/styles/chat-messages.css"><link rel="stylesheet" href="/web/vendor/codemirror.min.css">
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
    // outside this regression: no restore/success response is manufactured.
    if (['restore_file_tabs', 'update_file_tabs'].includes(message.type)) return [];
    const handler = { list_directory: handleListDirectory, read_file: handleReadFile, write_file: handleWriteFile }[message.type];
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
      response.end(html({ workDir: this.workDir, otherSessionDir: this.otherSessionDir, otherAgentDir: this.otherAgentDir }));
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
