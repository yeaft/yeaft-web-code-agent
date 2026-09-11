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
    if (pathname === '/__turn-response' || pathname === '/__debug-panel' || pathname === '/__ask-user') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(harnessHtml(pathname === '/__ask-user' ? 'ask' : pathname === '/__debug-panel'));
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

test('debug panel keeps one latest request and full loop tools across themes and mobile', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/__debug-panel`);
  await expect.poll(() => page.evaluate(() => window.__ready === true).then(ready => ready ? 'ready' : pageErrors.join('\n'))).toBe('ready');
  await page.locator('.yeaft-debug-turn-header').click();
  const request = page.locator('.yeaft-debug-latest-request');
  const system = page.locator('.yeaft-debug-latest-system-prompt');
  await expect(request).toHaveCount(1);
  await expect(system).toHaveCount(1);
  await request.getByRole('button', { name: 'show', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(request.locator('pre')).toContainText('LATEST_BODY');
  await request.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).input).toMatch(/^LATEST_BODY/);
  await system.getByRole('button', { name: 'show', exact: true }).click();
  await system.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('LATEST_SYSTEM');
  for (const header of await page.locator('.yeaft-debug-loop-header').all()) await header.click();
  await expect(page.locator('.yeaft-debug-loop-body').getByText('copy req', { exact: true })).toHaveCount(0);
  for (const row of await page.locator('.yeaft-debug-tool-row').all()) await row.getByRole('button', { name: 'show', exact: true }).click();
  const result = page.locator('.yeaft-debug-tool-detail').first().locator('pre').last();
  await expect(result).toContainText('RESULT_TAIL');
  await expect(page.locator('.yeaft-debug-tool-detail').first().locator('pre').first()).toContainText('/file-1');
  await page.locator('.yeaft-debug-turn-copy').click();
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown.match(/LATEST_BODY/g)).toHaveLength(1);
  expect(markdown).not.toMatch(/OLD_BODY|OLD_SYSTEM/);

  await page.evaluate(() => {
    window.__debugStore.yeaftDebugLoops.push({ turnId: 'debug-turn', loopNumber: 3 });
  });
  await expect(request.locator('pre')).toContainText('LATEST_BODY');
  await expect(request.locator('.yeaft-debug-section-meta')).toHaveText('Loop 2');
  await expect(system.locator('.yeaft-debug-section-meta')).toHaveText('Loop 2');

  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(request).toBeVisible();
      await expect(system).toBeVisible();
      const layout = await request.locator('pre').evaluate(pre => ({
        clientHeight: pre.clientHeight, scrollHeight: pre.scrollHeight,
        right: pre.getBoundingClientRect().right,
        viewport: window.innerWidth,
        color: getComputedStyle(pre).color,
        background: getComputedStyle(pre).backgroundColor,
      }));
      expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
      expect(layout.right).toBeLessThanOrEqual(layout.viewport);
      expect(layout.color).not.toBe(layout.background);
    }
  }
  await page.evaluate(() => {
    window.__debugStore.yeaftDebugLoops[1].rawRequest = null;
    window.__locale.value = 'zh';
  });
  await expect(request.locator('pre')).toContainText('OLD_BODY');
  await expect(request).toContainText('最近可用请求体');
  await expect(request.locator('.yeaft-debug-section-meta')).toHaveText('Loop 1');
  await expect(system.locator('pre')).toHaveText('LATEST_SYSTEM');
  await expect(system.locator('.yeaft-debug-section-meta')).toHaveText('Loop 2');
  await request.getByRole('button', { name: '复制', exact: true }).click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).input).toBe('OLD_BODY');
  await page.evaluate(() => {
    for (const loop of window.__debugStore.yeaftDebugLoops) {
      loop.rawRequest = null;
      loop.systemPrompt = '';
    }
  });
  await expect(request.locator('pre')).toHaveCount(0);
  await expect(request.getByRole('button', { name: '复制', exact: true })).toBeDisabled();
  await expect(request).toContainText('此 Turn 暂无可用请求体。');
  await expect(system).toContainText('此 Turn 暂无可用系统提示。');
  await expect(result).toContainText('RESULT_TAIL');
});

test('keeps progress visible and distinct from the final result across themes and mobile', async ({ page }) => {
  await page.goto(`${baseUrl}/__turn-response`);
  await page.waitForFunction(() => window.__ready === true);

  const progress = page.locator('.turn-progress-group');
  const progressList = page.locator('.turn-progress-list');
  const progressLink = progressList.locator('a');
  const result = page.locator('.turn-response-result');
  const todos = page.locator('.vp-turn-block-body-expanded .turn-todos');
  await expect(progress).toBeVisible();
  await expect(progressList).toBeVisible();
  await expect(page.locator('.turn-progress-toggle')).toHaveCount(0);
  await expect(page.locator('.turn-response-label')).toHaveCount(0);
  await expect(result.locator('h2')).toHaveText('改动');
  await expect(page.locator('.turn-response-progress')).toBeVisible();
  await expect(todos).toBeVisible();
  const tool = page.locator('.turn-actions');
  const elapsed = page.locator('.vp-turn-block-elapsed').first();
  const footer = page.locator('.turn-footer');
  await expect(tool).toBeVisible();
  await expect(elapsed).toHaveText('15s');
  await expect(footer).toContainText('model-v2');
  await expect(footer).not.toContainText('provider/');
  await expect(footer).not.toContainText('high');
  await expect(footer).toContainText('3 LLM calls');
  await expect(page.locator('.turn-token-meta')).toContainText('Total 1,234 · Input 1,200 · Output 34');

  await page.evaluate(() => {
    const contradictoryMessage = {
      type: 'assistant', content: '## Partial failure', responseKind: 'result',
      incomplete: true, stopReason: 'error', isStreaming: false,
    };
    window.__turn.textSegments = [{
      key: 'contradictory', content: contradictoryMessage.content,
      kind: 'result', explicitKind: true, isStreaming: false,
    }];
    window.__turn.messages = [contradictoryMessage];
    window.__turn.textContent = contradictoryMessage.content;
    window.__finalizeTurnResponseSegments(window.__turn);
  });
  await expect(result).toHaveCount(0);
  await expect(page.locator('.turn-response-progress h2')).toHaveText('Partial failure');

  await page.evaluate(() => {
    window.__turn.textSegments = [
      { key: 'progress', content: '[Inspect files](#details)', kind: 'progress', explicitKind: true, isStreaming: false },
      { key: 'result', content: '## 改动', kind: 'result', explicitKind: true, isStreaming: false },
    ];
    window.__turn.messages = [];
    window.__turn.textContent = '[Inspect files](#details)\n\n## 改动';
  });
  await expect(result.locator('h2')).toHaveText('改动');

  await page.locator('.turn-content .copy-btn').focus();
  await page.keyboard.press('Tab');
  await expect(progressLink).toBeFocused();
  const fontSizes = await page.evaluate(() => ({
    progress: parseFloat(getComputedStyle(document.querySelector('.turn-response-progress')).fontSize),
    result: parseFloat(getComputedStyle(document.querySelector('.turn-response-result .markdown-body')).fontSize),
  }));
  expect(fontSizes.progress).toBeLessThan(fontSizes.result);
  const readLayout = () => page.evaluate(() => {
    const contentRect = document.querySelector('.turn-content').getBoundingClientRect();
    const todo = document.querySelector('.vp-turn-block-body-expanded .turn-todos');
    const todoRect = todo.getBoundingClientRect();
    const todoStyle = getComputedStyle(todo);
    const progressListStyle = getComputedStyle(document.querySelector('.turn-progress-list'));
    return {
      gap: todoRect.top - contentRect.bottom,
      todoBorderTopWidth: todoStyle.borderTopWidth,
      todoPaddingLeft: parseFloat(todoStyle.paddingLeft),
      todoPaddingRight: parseFloat(todoStyle.paddingRight),
      progressPaddingLeft: parseFloat(progressListStyle.paddingLeft),
    };
  });
  const layout = await readLayout();
  expect(layout.gap).toBeGreaterThanOrEqual(16);
  expect(layout.todoBorderTopWidth).toBe('0px');
  expect(layout.todoPaddingLeft).toBe(16);
  expect(layout.todoPaddingRight).toBe(16);
  expect(layout.progressPaddingLeft).toBe(0);

  await page.evaluate(() => {
    window.__turn.totalMs = null;
    window.__turn.startedAt = Date.now() - 21_000;
    window.__turn.isActive = true;
    window.__turn.isStreaming = false;
    window.__turn.toolMsgs[0].hasResult = false;
    window.__turn.toolMsgs[0].toolResult = null;
    window.__turn.toolMsgs[0].startTime = Date.now();
    window.__nowMs.value = Date.now();
  });
  await expect(elapsed).toHaveText(/2[01]s/);
  await expect(elapsed).toHaveClass(/is-live/);
  await page.evaluate(() => {
    window.__nowMs.value += 2_000;
  });
  await expect(elapsed).toHaveText(/2[23]s/);
  await page.evaluate(() => {
    window.__turn.isActive = false;
    window.__turn.totalMs = 21_000;
    window.__turn.toolMsgs[0].hasResult = true;
    window.__turn.toolMsgs[0].toolResult = 'read complete';
  });
  await expect(elapsed).toHaveText('21s');
  await page.waitForTimeout(1_100);
  await expect(elapsed).toHaveText('21s');
  await expect(elapsed).not.toHaveClass(/is-live/);
  await expect(progress).toBeVisible();
  await expect(progressList).toBeVisible();

  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    const colors = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      progress: getComputedStyle(document.querySelector('.turn-response-progress')).color,
      result: getComputedStyle(document.querySelector('.turn-response-result')).color,
    }));
    expect(colors.progress).not.toBe(colors.result);
    expect(colors.result).not.toBe(colors.background);
  }

  await page.setViewportSize({ width: 720, height: 800 });
  expect(await page.locator('.turn-content').evaluate(element => (
    parseFloat(getComputedStyle(element).paddingRight)
  ))).toBe(40);

  await page.evaluate(() => {
    document.body.style.padding = '0';
    const app = document.querySelector('#app');
    app.classList.add('chat-container');
    Object.assign(app.style, { width: '100%', maxWidth: 'none', height: '400px', margin: '0' });
    const shell = document.createElement('div');
    shell.className = 'yeaft-page';
    app.before(shell);
    shell.append(app);
    const turn = app.querySelector(':scope > .vp-turn-block');
    const messages = document.createElement('div');
    messages.className = 'messages';
    turn.before(messages);
    messages.append(turn);
    const overflow = document.createElement('div');
    overflow.style.height = '800px';
    messages.append(overflow);
  });
  const readMobileGeometry = () => page.evaluate(() => {
    const scroller = document.querySelector('.chat-container');
    const content = document.querySelector('.turn-content');
    const toolRow = document.querySelector('.turn-actions');
    const scrollerRect = scroller.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const toolRect = toolRow.getBoundingClientRect();
    const contentStyle = getComputedStyle(content);
    return {
      contentLeft: contentRect.left,
      contentRight: contentRect.right,
      toolLeft: toolRect.left,
      toolRight: toolRect.right,
      contentPaddingLeft: parseFloat(contentStyle.paddingLeft),
      contentPaddingRight: parseFloat(contentStyle.paddingRight),
      responseLeftGutter: contentRect.left - scrollerRect.left + parseFloat(contentStyle.paddingLeft),
      responseRightGutter: scrollerRect.right - contentRect.right + parseFloat(contentStyle.paddingRight),
      scrollbarGutter: getComputedStyle(scroller).scrollbarGutter,
    };
  });
  for (const width of [720, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const mobileGeometry = await readMobileGeometry();
    expect(mobileGeometry.contentLeft).toBeCloseTo(mobileGeometry.toolLeft, 0);
    expect(mobileGeometry.contentRight).toBeCloseTo(mobileGeometry.toolRight, 0);
    expect(mobileGeometry.contentPaddingLeft).toBe(mobileGeometry.contentPaddingRight);
    expect(mobileGeometry.scrollbarGutter).toBe('stable both-edges');
    expect(mobileGeometry.responseLeftGutter).toBeCloseTo(mobileGeometry.responseRightGutter, 0);
  }
  expect(await readLayout()).toMatchObject({
    todoBorderTopWidth: '0px',
    todoPaddingLeft: 16,
    todoPaddingRight: 16,
  });
  await expect(page.locator('.turn-token-meta')).toBeHidden();
  await expect(footer).toContainText('model-v2');
  await expect(footer).toContainText('3 LLM calls');
  await expect(result.locator('h2')).toBeVisible();

  // The gallery interaction below retains its original tablet-size pointer
  // geometry; the response layout itself has already been verified at 320px.
  await page.setViewportSize({ width: 430, height: 800 });
  await page.evaluate(() => {
    window.__turn.imageMsgs = [
      { id: 'gallery-a', src: '/gallery-a.png', filename: 'Gallery A' },
      { id: 'gallery-b', src: '/gallery-b.png', filename: 'Gallery B' },
    ];
  });
  const thumbnails = page.locator('.turn-image-item');
  await expect(thumbnails).toHaveCount(2);
  await expect.poll(() => thumbnails.locator('img').evaluateAll(images => (
    images.every(image => image.complete && image.naturalWidth === 960 && image.naturalHeight === 640)
  ))).toBe(true);
  await thumbnails.first().click();
  const preview = page.locator('.image-preview-overlay');
  await expect(preview).toBeVisible();
  const previewImage = preview.locator('.image-preview-img');
  await expect(previewImage).toHaveAttribute('src', '/gallery-a.png');
  await expect(preview.locator('.image-preview-position')).toHaveText('Image 1 of 2');
  await previewImage.hover({ position: { x: 300, y: 200 } });
  await page.mouse.wheel(0, -100);
  await expect.poll(() => previewImage.evaluate(image => image.style.transform)).toContain('scale(1.25)');
  await expect(previewImage).toHaveClass(/is-zoomed/);
  await preview.locator('.image-preview-next').click();
  await expect(previewImage).toHaveAttribute('src', '/gallery-b.png');
  await expect(previewImage).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(preview.locator('.image-preview-position')).toHaveText('Image 2 of 2');
  await page.keyboard.press('ArrowLeft');
  await expect(preview.locator('.image-preview-img')).toHaveAttribute('src', '/gallery-a.png');
  await expect(preview.locator('.image-preview-position')).toHaveText('Image 1 of 2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.turn-image-item').first()).toBeFocused();
});
