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

function askUserHarnessHtml() {
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
  <script type="module">${askUserScript()}</script>
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
    if (pathname === '/__ask-user') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(askUserHarnessHtml());
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
