import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const projectRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function debugPanelScript() {
  return `
    const store = Vue.reactive({
      yeaftDebugPanel: { open: true, status: 'ready', turnId: 'debug-turn', sessionId: 'debug-session' },
      yeaftDebugTurnsById: {
        'debug-turn': { turnId: 'debug-turn', detailsLoaded: true, loopCount: 2, tools: [
          { loopNumber: 1, callId: 'tool-1', name: 'Read', toolOutput: 'full result\\n'.repeat(3000) + 'RESULT_TAIL' },
          { loopNumber: 2, callId: 'tool-2', name: 'Read', toolOutput: 'second result' },
        ] },
      },
      yeaftDebugLoops: [1, 2].map(loopNumber => ({
        turnId: 'debug-turn', loopNumber, model: 'provider/model',
        systemPrompt: loopNumber === 2 ? 'LATEST_SYSTEM' : 'OLD_SYSTEM',
        rawRequest: { body: { input: loopNumber === 2 ? 'LATEST_BODY' + ' long request'.repeat(3000) : 'OLD_BODY' } },
        toolCalls: [{ id: 'tool-' + loopNumber, name: 'Read', input: { path: '/file-' + loopNumber } }],
      })),
    });
    window.Pinia = { defineStore: () => () => ({}), useChatStore: () => store };
    const { default: YeaftDebugPanel } = await import('/web/components/YeaftDebugPanel.js');
    const { default: en } = await import('/web/i18n/en.js');
    const { default: zh } = await import('/web/i18n/zh-CN.js');
    const app = Vue.createApp({ components: { YeaftDebugPanel }, template: '<YeaftDebugPanel />' });
    window.__locale = Vue.reactive({ value: 'en' });
    app.config.globalProperties.$t = key => (window.__locale.value === 'en' ? en : zh)[key] || key;
    app.mount('#app');
    window.__debugStore = store;
    window.__ready = true;
  `;
}

function askUserScript() {
  return `
    window.Pinia = { defineStore: () => () => ({}) };
    const { default: AskCard } = await import('/web/components/AskCard.js');
    const { answerUserQuestion } = await import('/web/stores/helpers/conversation.js');
    const { default: en } = await import('/web/i18n/en.js');
    const { default: zh } = await import('/web/i18n/zh-CN.js');
    const row = Vue.reactive({ type: 'tool-use', toolName: 'AskUserQuestion',
      toolId: 'call-ask', askRequestId: 'ask-browser', sessionId: 'session-original',
      vpId: 'vp-ask', turnId: 'turn-ask', threadId: 'branch-ask', agentId: 'agent-ask',
      askQuestions: [{ question: 'Continue after switching Sessions?', options: [{ label: 'Yes' }] }] });
    window.__sent = [];
    const store = { currentAgent: 'other-agent', yeaftActiveSessionFilter: 'other-session',
      messagesMap: { 'yeaft-browser': [row] }, processingConversations: {},
      sendWsMessage: frame => { window.__sent.push(frame); return true; } };
    const visible = Vue.ref(true);
    const app = Vue.createApp({ components: { AskCard },
      setup() { return { row, visible,
        submit: (id, answers) => answerUserQuestion(store, id, answers, 'yeaft-browser') }; },
      template: '<button class="btn-secondary" @click="visible = !visible">Switch Session</button><AskCard v-if="visible" :ask-msg="row" @submit="submit" />' });
    window.__locale = Vue.reactive({ value: 'en' });
    app.config.globalProperties.$t = key => (window.__locale.value === 'en' ? en : zh)[key] || key;
    app.mount('#app');
    window.__ask = row;
    window.__ready = true;
  `;
}

function originNavigationHarnessHtml() {
  return `<!doctype html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/web/dist/style.bundle.css">
  <style>
    html, body, #app { height: 100%; margin: 0; }
    body { background: var(--bg-main); color: var(--text-primary); }
    .origin-harness { height: 100%; display: flex; flex-direction: column; }
    .origin-harness .chat-container { flex: 1; padding: 0; }
    .origin-question, .origin-short-question, .origin-next { padding: 20px 0; }
    .origin-long-response .assistant-turn { min-height: 1500px; }
    .origin-next { min-height: 900px; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script src="/web/vendor/vue.global.prod.js"></script>
  <script type="module">
    window.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({ answerUserQuestion() {}, cancelVpTurn() {} }),
    };
    window.marked = {
      setOptions() {},
      parse(text) { return '<p>' + String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</p>'; },
    };
    window.hljs = undefined;
    const { default: VpTurnBlock } = await import('/web/components/VpTurnBlock.js');
    const { resolveLongResponseOrigin } = await import('/web/utils/response-origin-navigation.js');
    const shortText = 'A concise response should not receive its own navigation action.';
    const responseText = Array.from({ length: 90 }, (_, index) => 'Response section ' + (index + 1) + ' explains the implementation and verification details.').join(' ');
    const makeTurn = (id, text) => Vue.reactive({
      id, turnId: id, textContent: text,
      textSegments: [{ key: 'result', content: text, kind: 'result', explicitKind: true, isStreaming: false }],
      toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, messages: [],
      isStreaming: false, isActive: false, speakerVpId: 'vp-origin', speakerTimestamp: Date.now(),
    });
    const shortTurn = makeTurn('turn-short', shortText);
    const turn = makeTurn('turn-origin', responseText);
    const scroller = Vue.ref(null);
    const activeOriginId = Vue.ref('');
    const jumpCount = Vue.ref(0);
    let updateRaf = null;
    const updateNavigation = () => {
      updateRaf = null;
      const viewport = scroller.value.getBoundingClientRect();
      activeOriginId.value = resolveLongResponseOrigin({
        viewportTop: viewport.top,
        viewportHeight: scroller.value.clientHeight,
        responses: Array.from(scroller.value.querySelectorAll('[data-response-origin-id]')).map(element => {
          const rect = element.getBoundingClientRect();
          return { originMessageId: element.dataset.responseOriginId, top: rect.top, bottom: rect.bottom, height: rect.height };
        }),
      });
    };
    const scheduleNavigation = () => {
      if (updateRaf != null) return;
      updateRaf = requestAnimationFrame(updateNavigation);
    };
    const jumpToQuestion = () => {
      jumpCount.value += 1;
      activeOriginId.value = '';
      scroller.value.scrollTo({ top: 0, behavior: 'instant' });
      document.querySelector('.origin-question')?.classList.add('msg-flash');
    };
    const app = Vue.createApp({
      components: { VpTurnBlock },
      setup() {
        Vue.onMounted(() => { scroller.value.addEventListener('scroll', scheduleNavigation, { passive: true }); scheduleNavigation(); });
        Vue.onUnmounted(() => scroller.value?.removeEventListener('scroll', scheduleNavigation));
        return { shortTurn, turn, scroller, activeOriginId, jumpCount, jumpToQuestion };
      },
      template: ` + "`" + `<div class="yeaft-page origin-harness">
        <main ref="scroller" class="chat-container">
          <div class="messages">
            <section class="origin-short-question msg-row">Short question</section>
            <VpTurnBlock :turn="shortTurn" display-name-override="Yeaft" :interactive-speaker="false" origin-message-id="question-short" />
            <section class="origin-question msg-row" data-msg-id="question-origin">How should this feature work?</section>
            <div class="virtual-transcript-item origin-long-response" data-response-boundary>
              <VpTurnBlock :turn="turn" display-name-override="Yeaft" :interactive-speaker="false" origin-message-id="question-origin" />
            </div>
            <section class="origin-next">Following conversation</section>
          </div>
          <nav class="transcript-navigation" aria-label="Conversation navigation">
            <button v-if="activeOriginId" type="button" class="transcript-navigation-btn response-origin-btn"
              aria-label="Back to this turn’s question" title="Back to this turn’s question" @click="jumpToQuestion">↑ Turn</button>
            <button type="button" class="transcript-navigation-btn scroll-to-latest">↓ Latest</button>
          </nav>
        </main>
        <output data-jump-count>{{ jumpCount }}</output>
      </div>` + "`" + `,
    });
    const translate = key => ({ 'message.backToCurrentTurn': 'Back to this turn’s question' })[key] || key;
    app.config.globalProperties.$t = translate;
    app.provide('t', translate);
    app.mount('#app');
    window.__ready = true;
  </script>
</body>
</html>`;
}

function harnessHtml(debug = false) {
  if (debug === 'ask') return harnessHtml()
    .replace(/<script type="module">[\s\S]*?<\/script>/, () => '<script type="module">' + askUserScript() + '</script>');
  if (debug) return harnessHtml()
    .replace(/<script type="module">[\s\S]*?<\/script>/, () => '<script type="module">' + debugPanelScript() + '</script>');
  return `<!doctype html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/web/dist/style.bundle.css">
  <style>
    body { margin: 0; padding: 24px; background: var(--bg-main); color: var(--text-primary); }
    #app { width: min(760px, 100%); margin: 0 auto; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script src="/web/vendor/vue.global.prod.js"></script>
  <script type="module">
    window.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({ answerUserQuestion() {}, cancelVpTurn() {} }),
    };
    window.marked = {
      setOptions() {},
      parse(text) {
        const escaped = String(text)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        if (escaped.startsWith('## ')) return '<h2>' + escaped.slice(3) + '</h2>';
        const linked = escaped.replace(/\\[([^\\]]+)\\]\\((#[^)]+)\\)/g, '<a href="$2">$1</a>');
        return '<p>' + linked + '</p>';
      },
    };
    window.hljs = undefined;
    const { default: VpTurnBlock } = await import('/web/components/VpTurnBlock.js');
    const { finalizeTurnResponseSegments } = await import('/web/utils/turn-response.js');
    const turn = Vue.reactive({
      id: 'turn-ui', turnId: 'turn-ui', textContent: '[Inspect files](#details)\\n\\n## 改动',
      textSegments: [
        { key: 'progress', content: '[Inspect files](#details)', kind: 'progress', explicitKind: true, isStreaming: false },
        { key: 'result', content: '## 改动', kind: 'result', explicitKind: true, isStreaming: false },
      ],
      toolMsgs: [{
        toolName: 'FileRead', toolInput: { file_path: 'README.md' },
        toolResult: 'read complete', hasResult: true, startTime: Date.now() - 500,
      }], imageMsgs: [],
      todoMsg: { toolInput: { todos: [{ content: 'Verify spacing', status: 'pending' }] } },
      askMsg: null, messages: [], isStreaming: false, isActive: false,
      speakerVpId: 'vp-ui', speakerTimestamp: Date.now() - 15_000,
      startedAt: Date.now() - 15_000, totalMs: 15_000,
      model: 'provider/model-v2', effort: 'high', llmCallCount: 3,
      inputTokens: 1_200, outputTokens: 34, totalTokens: 1_234,
    });
    const nowMs = Vue.ref(Date.now());
    const app = Vue.createApp({
      components: { VpTurnBlock },
      setup() { return { turn, nowMs }; },
      template: '<VpTurnBlock :turn="turn" :now-ms="nowMs" display-name-override="Yeaft" :interactive-speaker="false" />',
    });
    const translate = (key, params = {}) => {
      const labels = {
        'common.close': 'Close',
        'message.imagePreview': 'Image preview',
        'message.previousImage': 'Previous image',
        'message.nextImage': 'Next image',
      };
      if (key === 'message.imagePosition') return 'Image ' + params.current + ' of ' + params.total;
      if (key === 'yeaft.message.llmCalls') return params.count + ' LLM calls';
      if (key === 'yeaft.message.tokenUsage') return 'Total ' + params.total + ' · Input ' + params.input + ' · Output ' + params.output;
      return labels[key] || key;
    };
    app.config.globalProperties.$t = translate;
    app.provide('t', translate);
    app.mount('#app');
    window.__turn = turn;
    window.__nowMs = nowMs;
    window.__finalizeTurnResponseSegments = finalizeTurnResponseSegments;
    window.__ready = true;
  </script>
</body>
</html>`;
}

let server;
let baseUrl;

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve(projectRoot, 'web/build.js')], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/__turn-response' || pathname === '/__debug-panel' || pathname === '/__ask-user' || pathname === '/__origin-navigation') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(pathname === '/__origin-navigation'
        ? originNavigationHarnessHtml()
        : harnessHtml(pathname === '/__ask-user' ? 'ask' : pathname === '/__debug-panel'));
      return;
    }
    if (pathname === '/gallery-a.png' || pathname === '/gallery-b.png') {
      const first = pathname.includes('-a.');
      const label = first ? 'A' : 'B';
      const title = first ? 'Architecture overview' : 'Release checklist';
      const accent = first ? '#2563eb' : '#b45309';
      const surface = first ? '#dbeafe' : '#fef3c7';
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
        <rect width="960" height="640" fill="#f8fafc"/>
        <rect x="48" y="48" width="864" height="544" rx="32" fill="${surface}"/>
        <circle cx="144" cy="144" r="52" fill="${accent}"/>
        <text x="144" y="166" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="700" fill="#ffffff">${label}</text>
        <text x="224" y="132" font-family="sans-serif" font-size="34" font-weight="700" fill="#172033">${title}</text>
        <text x="224" y="174" font-family="sans-serif" font-size="22" fill="#475569">Yeaft visual verification fixture</text>
        <rect x="104" y="252" width="216" height="204" rx="22" fill="#ffffff" stroke="${accent}" stroke-width="5"/>
        <rect x="372" y="252" width="216" height="204" rx="22" fill="#ffffff" stroke="${accent}" stroke-width="5"/>
        <rect x="640" y="252" width="216" height="204" rx="22" fill="#ffffff" stroke="${accent}" stroke-width="5"/>
        <path d="M320 354h52M588 354h52" stroke="${accent}" stroke-width="10" stroke-linecap="round"/>
      </svg>`);
      return;
    }
    const filePath = resolve(projectRoot, `.${decodeURIComponent(pathname)}`);
    if (!filePath.startsWith(`${projectRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(filePath).isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
      response.end(readFileSync(filePath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (!server) return;
  await new Promise(resolveClose => server.close(resolveClose));
});

test('AskUser waits for confirmation after Session switching and allows an explicit retry', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.clock.install();
  await page.goto(`${baseUrl}/__ask-user`);
  await expect.poll(() => page.evaluate(() => window.__ready === true).then(ready => ready ? 'ready' : pageErrors.join('\n'))).toBe('ready');
  const switchSession = page.getByRole('button', { name: 'Switch Session' });
  await switchSession.click();
  await page.clock.fastForward(3 * 60_000);
  await switchSession.click();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await page.getByRole('button', { name: 'Submit Answer' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ask-summary')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Waiting for Agent confirmation');
  expect(await page.evaluate(() => window.__sent[0])).toMatchObject({
    type: 'yeaft_ask_user_answer', agentId: 'agent-ask', sessionId: 'session-original', threadId: 'branch-ask',
  });
  await switchSession.click();
  await page.clock.fastForward(16_000);
  await switchSession.click();
  await expect(page.getByRole('status')).toContainText('No confirmation yet');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => { window.__ask.pendingAnswers = { q: 'Long answer '.repeat(70) }; });
      await expect(page.getByRole('button', { name: 'Resend answer' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.getByRole('button', { name: 'Resend answer' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Waiting for Agent confirmation');
  expect(await page.evaluate(() => window.__sent.length)).toBe(2);
  await page.evaluate(() => {
    window.__locale.value = 'zh';
    window.__ask.askPending = false;
    window.__ask.askRequestId = null;
    window.__ask.askExpired = true;
    window.__ask.askError = 'unavailable';
  });
  await expect(page.locator('.ask-expired-hint')).toContainText('已失效');
  await expect(page.getByRole('button', { name: 'Yes', exact: true })).toBeDisabled();
  await expect(page.locator('.ask-summary')).toHaveCount(0);
  await page.evaluate(() => { window.__ask.askExpired = false; window.__ask.askAnswered = true; window.__ask.selectedAnswers = { q: 'Yes' }; });
  await expect(page.locator('.ask-summary')).toContainText('Yes');
  expect(pageErrors).toEqual([]);
});
