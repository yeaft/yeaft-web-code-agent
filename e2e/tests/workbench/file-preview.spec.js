import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { useTestServer } from '../../fixtures/test-server.js';
import { handleReadFile, MAX_WORKBENCH_PREVIEW_BYTES } from '../../../agent/workbench/file-ops.js';
import agentContext from '../../../agent/context.js';

// Component-boundary browser tests, not an authenticated app/WS relay test.
// The media/load-error/operation-feedback markup is taken from FilesTab.template
// at runtime. Its production handlers, download composable, translations and CSS
// run unchanged; only the surrounding shell and message transport are a harness.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LIMIT = 20 * 1024 * 1024;

function bitmap(width, height, pixelOffset = 54) {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(pixelOffset + stride * height);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(pixelOffset, 10);
  bytes.writeUInt32LE(40, 14); // BITMAPINFOHEADER, uncompressed 24-bit BGR
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34);
  bytes.fill(0x6b, pixelOffset);
  return bytes;
}

// A legal gap before the pixel array makes the file EXACTLY 20 MiB. Unlike a
// fake image or arbitrary trailing bytes, every pixel row is present and valid.
const LARGE_IMAGE = bitmap(3200, 2184, 5120);
const SMALL_IMAGE = bitmap(32, 24);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function createWebmFixture(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => recorder.onstop = resolve);
    recorder.start();
    for (let frame = 0; frame < 8; frame += 1) {
      context.fillStyle = frame % 2 ? '#3178c6' : '#26a69a';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      context.fillRect(6 + frame * 4, 16, 12, 12);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach(track => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

function mountPreviewHarness() {
  const { ref, computed, createApp, nextTick } = Vue;
  const t = (key, values = {}) => (translations[key] || key)
    .replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`);
  function section(start, end) {
    const from = FilesTab.template.indexOf(start);
    const to = FilesTab.template.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`FilesTab template boundary missing: ${start}`);
    return FilesTab.template.slice(from, to);
  }
  function previewSection(type, nextType) {
    const marker = FilesTab.template.indexOf(`<div v-else-if="activeFile.fileType === '${type}'"`);
    const nextMarker = nextType
      ? FilesTab.template.indexOf(`<div v-else-if="activeFile.fileType === '${nextType}'"`, marker)
      : -1;
    const to = nextMarker >= 0
      ? nextMarker
      : FilesTab.template.indexOf('\n        </template>', marker);
    if (marker < 0 || to < 0) throw new Error(`FilesTab preview boundary missing: ${type}`);
    return FilesTab.template.slice(marker, to).replace('v-else-if=', 'v-if=');
  }
  const loadingTemplate = section('<div v-if="activeFile?.loading"', '<template v-else-if="activeFile">');
  const imageTemplate = previewSection('image', 'video');
  const videoTemplate = previewSection('video');
  const videoDownloadTemplate = section('<button\n              v-if="activeFile.fileType === \'video\'"', '\n            <button type="button" class="file-action-btn"');
  const feedbackTemplate = section('<div v-if="fileOpFeedback"', '</div>') + '</div>';
  const app = createApp({
    template: `<main class="preview-test-shell files-tab mobile-editor-view">
      <nav aria-label="Open media"><button v-for="(file, index) in openFiles" :key="file.path"
        @click="activeFileIndex = index" :aria-pressed="activeFileIndex === index">{{ file.name }}</button>${videoDownloadTemplate}</nav>
      ${feedbackTemplate}
      <section class="file-col-content">
        ${loadingTemplate}<template v-else-if="activeFile">${imageTemplate}${videoTemplate}</template>
      </section>
    </main>`,
    setup() {
      const openFiles = ref([]);
      const activeFileIndex = ref(0);
      const activeFile = computed(() => openFiles.value[activeFileIndex.value]);
      const sent = [];
      const store = {
        currentConversation: 'preview-conversation', currentAgent: 'preview-agent',
        clientId: 'preview-client', sendWsMessage: message => sent.push(message),
      };
      const ops = createFileOperations(store, {
        getEffectiveWorkDir: () => '/fixture', treePath: ref('/fixture'),
      });
      const { handleWorkbenchMessage } = createWsHandler({
        store, normalizePath: path => path?.replace(/\\/g, '/'),
        getEffectiveWorkDir: () => '/fixture', openFiles, activeFileIndex, activeFile,
        fileSaving: ref(false), saveTabsState() {}, createEditor() {}, openFileInTab() {},
        tree: {}, fp: {}, qo: {}, ops, mdPreviewMode: ref(false),
        renderOfficeLocal() {}, editorContainer: ref(null), t,
      });
      window.previewHarness = {
        openFiles, activeFile, sent,
        open(path, fileType = 'image') {
          openFiles.value.push({
            path, name: path.split('/').pop(), fileType,
            requestId: `preview-${openFiles.value.length}`, loading: true,
            loadError: null, blobUrl: null, previewLoading: true, previewError: null,
          });
          activeFileIndex.value = openFiles.value.length - 1;
        },
        receive(message) { handleWorkbenchMessage({ detail: message }); },
        openVideo(path, previewUrl) {
          this.open(path, 'video');
          this.receive({
            type: 'video_metadata', requestedFilePath: path,
            requestId: this.activeFile.value.requestId, videoStream: true, previewUrl,
          });
        },
        download(path) {
          ops.contextMenu.entry = { path, type: 'file' };
          ops.ctxDownload();
          return sent.at(-1);
        },
        // Save the ORIGINAL listener, not a copied state transition. A queued
        // event on the old element can target the newly active file through
        // the template's activeFile closure. Retain its URL on a detached img
        // to deterministically exercise that browser race even if Vue reuses
        // the visible img node during tab switching.
        captureLateEvents() {
          const img = document.querySelector('.file-preview-image');
          const oldTarget = img.cloneNode();
          const listeners = Object.getOwnPropertySymbols(img)
            .map(symbol => img[symbol]).find(value => value?.onLoad && value?.onError);
          if (!listeners) throw new Error('Expected real Vue image event listeners');
          oldTarget.addEventListener('load', listeners.onLoad);
          oldTarget.addEventListener('error', listeners.onError);
          this.lateTarget = oldTarget;
        },
        async fireLate(type) {
          this.lateTarget.dispatchEvent(new Event(type));
          await nextTick();
        },
      };
      window.addEventListener('pagehide', () => ops.cleanup(), { once: true });
      return {
        openFiles, activeFileIndex, activeFile, fileOpFeedback: ops.fileOpFeedback,
        onImagePreviewLoad: (file, event) => updateImagePreviewState(file, event),
        onImagePreviewError: (file, event) => updateImagePreviewState(file, event, t('files.previewLoadFailed')),
        onVideoPreviewLoad: (file, event) => updateMediaPreviewState(file, event),
        onVideoPreviewError: (file, event) => updateMediaPreviewState(file, event, t('files.videoPreviewLoadFailed')),
        downloadActiveFile: () => {
          const file = activeFile.value;
          if (!file?.blobUrl) return;
          const a = document.createElement('a');
          a.href = file.blobUrl + '&download=1';
          a.download = file.name;
          document.body.append(a); a.click(); a.remove();
        },
        openActiveImagePreview: trigger => {
          if (!activeFile.value?.blobUrl) return;
          openImagePreview(activeFile.value.blobUrl, {
            alt: activeFile.value.name,
            closeLabel: 'Close', zoomOutLabel: 'Zoom out',
            zoomInLabel: 'Zoom in', resetZoomLabel: 'Reset image zoom', trigger,
          });
        },
      };
    },
  });
  app.config.globalProperties.$t = t;
  app.mount('#app');
}

const HTML = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/web/styles/variables.css">
<link rel="stylesheet" href="/web/styles/files.css">
<link rel="stylesheet" href="/web/styles/workbench.css">
<link rel="stylesheet" href="/web/styles/chat-messages.css">
<style>
  .preview-test-shell { height: 100dvh; display: flex; flex-direction: column; background: var(--bg-workbench); color: var(--text-primary); }
  .preview-test-shell nav { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; }
  .preview-test-shell nav button { max-width: 100%; overflow-wrap: anywhere; }
</style>
<script src="/web/vendor/vue.global.prod.js"></script></head><body><div id="app"></div>
<script type="module">
import FilesTab, { updateImagePreviewState, updateMediaPreviewState } from '/web/components/FilesTab.js';
import { createWsHandler } from '/web/components/files/wsHandler.js';
import { createFileOperations } from '/web/components/files/fileOperations.js';
import { openImagePreview } from '/web/utils/imagePreview.js';
import translations from '/web/i18n/en.js';
(${mountPreviewHarness.toString()})();
</script></body></html>`;

class PreviewServer {
  requests = [];
  gates = new Map();

  async start() {
    this.directory = await mkdtemp(join(tmpdir(), 'yeaft-image-e2e-'));
    this.video = null;
    // Exercise the real Agent stat/limit/error contract, without starting an
    // Agent or touching any live instance. The sparse file has an actual +1 size.
    const oversized = await open(join(this.directory, 'too-large.bmp'), 'w');
    try { await oversized.truncate(LIMIT + 1); } finally { await oversized.close(); }
    const originalSend = agentContext.sendToServer;
    try {
      agentContext.sendToServer = message => { this.agentError = message; };
      await handleReadFile({
        filePath: 'too-large.bmp', workDir: this.directory,
        conversationId: 'preview-conversation', requestId: 'preview-0',
      });
    } finally { agentContext.sendToServer = originalSend; }
    this.server = createServer((request, response) => {
      this.serve(request, response).catch(error => {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  async serve(request, response) {
    const url = new URL(request.url, 'http://localhost');
    this.requests.push(url.pathname + url.search);
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(HTML);
      return;
    }
    if (url.pathname.startsWith('/api/preview/')) {
      const id = url.pathname.split('/').pop();
      const body = id === 'missing' ? Buffer.from('Preview not found') : id === 'bad' ? Buffer.from('not an image')
        : id === 'large' ? LARGE_IMAGE : id === 'video' ? (this.video || Buffer.alloc(0)) : SMALL_IMAGE;
      const send = () => {
        if (id === 'video') {
          const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range || ''));
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
          const content = body.subarray(start, end + 1);
          response.writeHead(range ? 206 : 200, {
            'Content-Type': 'video/webm', 'Content-Length': content.length,
            'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
            ...(url.searchParams.has('download') ? { 'Content-Disposition': 'attachment; filename="fixture.webm"' } : {}),
          });
          response.end(content);
          return;
        }
        response.writeHead(id === 'missing' ? 404 : 200, {
          'Content-Type': 'image/bmp', 'Content-Length': body.length,
          'Cache-Control': 'no-store',
          ...(url.searchParams.has('download') ? { 'Content-Disposition': 'attachment; filename="large.bmp"' } : {}),
        });
        response.end(body);
      };
      const gate = url.searchParams.get('gate');
      if (gate) this.gates.set(gate, send);
      else send();
      return;
    }
    const file = resolve(ROOT, `.${url.pathname}`);
    if (!file.startsWith(join(ROOT, 'web') + sep)) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': extname(file) === '.css' ? 'text/css' : 'text/javascript' });
    response.end(body);
  }

  release(gate) {
    const send = this.gates.get(gate);
    if (!send) throw new Error(`HTTP gate not reached: ${gate}`);
    this.gates.delete(gate);
    send();
  }

  async stop() {
    if (this.server?.listening) {
      const closed = new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
      this.server.closeAllConnections();
      await closed;
    }
    this.gates.clear();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

const test = base.extend({
  previewServer: async ({}, use) => useTestServer(new PreviewServer(), use),
});

async function openImage(page, id, { gate, path = `/fixture/${id}.bmp` } = {}) {
  await page.evaluate(({ id, gate, path }) => {
    const harness = window.previewHarness;
    harness.open(path);
    harness.receive({
      type: 'file_content', filePath: path, requestId: harness.activeFile.value.requestId,
      binary: true, fileId: id, previewToken: 'test-token',
      ...(gate ? { previewUrl: `/api/preview/${id}?token=test-token&gate=${gate}` } : {}),
    });
  }, { id, gate, path });
}

async function expectDecoded(page, width) {
  const image = page.locator('.file-preview-image');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(width);
  await expect(page.locator('.preview-loading, .file-load-state')).toHaveCount(0);
  await expect(page.locator('.preview-error')).toHaveCount(0);
  expect(await image.evaluate(img => ({ complete: img.complete, http: /^http:\/\//.test(img.src) })))
    .toEqual({ complete: true, http: true });
}

async function expectFitsViewport(page) {
  const dimensions = await page.evaluate(() => {
    const target = document.querySelector('.file-preview-image, .preview-error, .file-load-error');
    const rect = target.getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom,
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.height);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
}

test.describe('production video preview', () => {
  test.beforeEach(async ({ page, previewServer }) => {
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('preview page error:', error.message); });
    await page.goto(previewServer.url);
    await page.waitForFunction(() => window.previewHarness);
    expect(errors).toEqual([]);
  });

  test('loads metadata through HTTP ranges, exposes controls, and downloads identical bytes', async ({ page, previewServer }) => {
    previewServer.video = await createWebmFixture(page);
    expect(previewServer.video.length).toBeGreaterThan(0);
    const rangeResponse = page.waitForResponse(response => (
      response.url().includes('/api/preview/video') && response.status() === 206
    ));
    await page.evaluate(() => window.previewHarness.openVideo(
      '/fixture/video.webm', '/api/preview/video?token=test-token',
    ));
    const video = page.locator('.file-preview-video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('controls', '');
    const response = await rangeResponse;
    expect(response.headers()['accept-ranges']).toBe('bytes');
    await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.preview-loading')).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('fixture.webm');
    expect(await download.failure()).toBeNull();
    const downloaded = await readFile(await download.path());
    expect(sha256(downloaded)).toBe(sha256(previewServer.video));
  });
});

for (const theme of ['light', 'dark']) {
  for (const viewport of [{ width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    test.describe(`${theme} ${viewport.width}px production image preview`, () => {
      test.use({ viewport });
      test.beforeEach(async ({ page, previewServer }) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(previewServer.url);
        await page.waitForFunction(() => window.previewHarness);
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        expect(errors).toEqual([]);
      });

      test('decodes exactly 20 MiB over direct HTTP, finishes spinner, and downloads identical bytes', async ({ page, previewServer }) => {
        expect(LARGE_IMAGE.length).toBe(LIMIT);
        expect(MAX_WORKBENCH_PREVIEW_BYTES).toBe(LIMIT);
        await openImage(page, 'large', { gate: 'large-load' });
        await expect(page.locator('.preview-loading')).toBeVisible();
        await expect(page.locator('.preview-loading .spinner-mini')).toHaveCount(1);
        await expect(page.locator('.file-preview-image')).toBeHidden();
        await expect.poll(() => previewServer.gates.has('large-load')).toBe(true);
        const responsePromise = page.waitForResponse(response => response.url().includes('gate=large-load'));
        previewServer.release('large-load');
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        expect(response.headers()['content-length']).toBe(String(LIMIT));
        await expectDecoded(page, 3200);
        await expectFitsViewport(page);
        const before = await page.evaluate(() => JSON.stringify(window.previewHarness.openFiles.value));
        const downloadPromise = page.waitForEvent('download');
        await page.evaluate(() => {
          const harness = window.previewHarness;
          const request = harness.download('/fixture/large.bmp');
          harness.receive({ ...request, type: 'file_content', binary: true, fileId: 'large', previewToken: 'test-token' });
        });
        const download = await downloadPromise;
        expect(download.url()).toBe(`${previewServer.url}/api/preview/large?token=test-token&download=1`);
        expect(download.suggestedFilename()).toBe('large.bmp');
        expect(await download.failure()).toBeNull();
        const downloaded = await readFile(await download.path());
        expect(downloaded.length).toBe(LIMIT);
        expect(sha256(downloaded)).toBe(sha256(LARGE_IMAGE));
        expect(await page.evaluate(() => JSON.stringify(window.previewHarness.openFiles.value))).toBe(before);
      });

      for (const id of ['bad', 'missing']) {
        test(`${id === 'bad' ? 'invalid image bytes' : 'HTTP 404'} ends loading and displays production error`, async ({ page, previewServer }) => {
          await openImage(page, id, { gate: 'failed-load' });
          await expect(page.locator('.preview-loading')).toBeVisible();
          await expect.poll(() => previewServer.gates.has('failed-load')).toBe(true);
          const responsePromise = page.waitForResponse(response => response.url().includes('gate=failed-load'));
          previewServer.release('failed-load');
          expect((await responsePromise).status()).toBe(id === 'missing' ? 404 : 200);
          await expect(page.locator('.preview-error')).toHaveText('The image preview could not be loaded.');
          await expect(page.locator('.preview-loading, .file-preview-image')).toHaveCount(0);
          expect(await page.evaluate(() => window.previewHarness.activeFile.value.previewLoading)).toBe(false);
          await expectFitsViewport(page);
        });
      }

      test('real Agent 20 MiB+1 error projects to alert before any HTTP image request', async ({ page, previewServer }) => {
        expect(previewServer.agentError.errorCode).toBe('FILE_PREVIEW_TOO_LARGE');
        expect(previewServer.agentError.errorDetails).toEqual({ sizeBytes: LIMIT + 1, limitBytes: LIMIT });
        await page.evaluate(() => window.previewHarness.open('too-large.bmp'));
        await expect(page.locator('.file-load-state[role="status"]')).toBeVisible();
        await page.evaluate(message => window.previewHarness.receive(message), previewServer.agentError);
        await expect(page.getByRole('alert')).toHaveText('This file is 20.0 MB and exceeds the 20 MB preview and download limit.');
        await expect(page.locator('.spinner-mini, .file-preview-image')).toHaveCount(0);
        expect(previewServer.requests.filter(url => url.startsWith('/api/preview/'))).toEqual([]);
        await expectFitsViewport(page);
      });

      test('opens the shared viewer with visible zoom and reset controls', async ({ page }) => {
        await openImage(page, 'small');
        await expectDecoded(page, 32);
        await page.locator('.file-preview-image-button').click();
        const overlay = page.locator('.image-preview-overlay');
        await expect(overlay).toBeVisible();
        await expect(overlay.locator('.image-preview-zoom-reset')).toHaveText('100%');
        await overlay.getByRole('button', { name: 'Zoom in' }).click();
        await expect(overlay.locator('.image-preview-zoom-reset')).toHaveText('125%');
        await overlay.getByRole('button', { name: 'Reset image zoom' }).click();
        await expect(overlay.locator('.image-preview-zoom-reset')).toHaveText('100%');
        await overlay.getByRole('button', { name: 'Close' }).click();
        await expect(overlay).toBeHidden();
      });

      test('a separate failed download for the open path does not poison preview state', async ({ page }) => {
        await openImage(page, 'small');
        await expectDecoded(page, 32);
        const before = await page.evaluate(() => JSON.stringify(window.previewHarness.openFiles.value));
        await page.evaluate(() => {
          const harness = window.previewHarness;
          const request = harness.download('/fixture/small.bmp');
          if (!request.download || request.requestId === harness.activeFile.value.requestId) {
            throw new Error('Download must have independent request correlation');
          }
          harness.receive({ ...request, type: 'file_content', error: 'Download transfer failed', binary: false });
        });
        await expect(page.locator('.file-op-feedback.error')).toHaveText('Download transfer failed');
        expect(await page.evaluate(() => JSON.stringify(window.previewHarness.openFiles.value))).toBe(before);
        await expectDecoded(page, 32);
      });

      test('switching files fences late load/error listeners by HTTP URL', async ({ page, previewServer }) => {
        await openImage(page, 'small', { gate: 'old-image' });
        await expect.poll(() => previewServer.gates.has('old-image')).toBe(true);
        await page.evaluate(() => window.previewHarness.captureLateEvents());
        await openImage(page, 'large', { gate: 'current-image' });
        await expect.poll(() => previewServer.gates.has('current-image')).toBe(true);
        await expect(page.getByRole('button', { name: 'large.bmp', exact: true })).toHaveAttribute('aria-pressed', 'true');
        for (const type of ['error', 'load']) {
          await page.evaluate(type => window.previewHarness.fireLate(type), type);
          await expect(page.locator('.preview-loading')).toBeVisible();
          await expect(page.locator('.preview-error')).toHaveCount(0);
          expect(await page.evaluate(() => window.previewHarness.activeFile.value.previewLoading)).toBe(true);
        }
        previewServer.release('old-image');
        previewServer.release('current-image');
        await expectDecoded(page, 3200);
        await page.evaluate(() => window.previewHarness.fireLate('error'));
        await expectDecoded(page, 3200);
        await page.getByRole('button', { name: 'small.bmp', exact: true }).click();
        await expectDecoded(page, 32);
        await expectFitsViewport(page);
      });
    });
  }
}
