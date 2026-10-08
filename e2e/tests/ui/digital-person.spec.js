import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { personRecords } from '../../../test/fixtures/person-records.js';

// Real browser entry + WebSocket framing with an explicit mock Person runtime.
// This is not a model, MongoDB or Server authorization integration test.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

async function mockPersonSocket(page, { longReading = false, enableUi = true, activityFlow = false } = {}) {
  if (enableUi) await page.addInitScript(() => localStorage.setItem('digital-person-ui-enabled-by-agent',
    JSON.stringify({ 'person-a': true, 'person-b': true, 'old-agent': true })));
  const requests = [];
  const messages = [];
  let socket;
  let configured = true;
  let renameSupported = true;
  let busy = false;
  let activityRecords = [];
  let latestEpisode = null;
  let historyReply;
  let saveSettings;
  let failTraces = false;
  let unknownCommand = false;
  let models = [{ id: 'provider/model-a' }, { id: 'provider/model-b' }];
  const agents = [
    { id: 'person-a', name: 'Owner Agent A', online: true, capabilities: ['digital_person'] },
    { id: 'person-b', name: 'Owner Agent B', online: true, capabilities: ['digital_person'] },
    { id: 'old-agent', name: 'Old Agent', online: true, capabilities: [] },
  ];
  const agentList = () => socket.send(JSON.stringify({ type: 'agent_list', agents }));
  await page.routeWebSocket(/.*/, route => {
    socket = route;
    const server = route.connectToServer();
    server.onMessage(message => {
      const data = JSON.parse(String(message));
      if (data.type === 'agent_list') route.send(JSON.stringify({ ...data, agents }));
      else route.send(message);
    });
    route.onMessage(message => {
      const request = JSON.parse(String(message));
      if (request.type !== 'person_request') { server.send(message); return; }
      requests.push(request);
      const reply = (data, extra = {}) => route.send(JSON.stringify({ type: 'person_response', agentId: request.agentId, requestId: request.requestId, op: request.op, ok: true, data, ...extra }));
      if (request.op === 'status') reply({ configured, ...(renameSupported ? { renameSupported: true } : {}), reason: configured ? '' : 'MongoDB is not configured', models });
      else if (request.op === 'open') reply({ person: { id: 'person-1' } });
      else if (request.op === 'snapshot') {
        reply({ person: { id: 'person-1', name: request.agentId === 'person-a' ? 'Ada' : 'Bea' }, state: { version: 4, currentEpisodeId: 'episode-1', summary: longReading ? 'A considered understanding.\n'.repeat(100) : '' }, messages: request.agentId === 'person-a' ? messages : [], busy, latestEpisode, episodeId: busy ? (activityFlow ? 'episode-1' : 'live-episode') : null });
      } else if (request.op === 'messages') {
        reply({ items: request.payload.cursor ? [{ id: 'older', role: 'assistant', text: 'Older persisted message', createdAt: 1 }] : [], nextCursor: request.payload.cursor ? null : 'older-page' });
      } else if (request.op === 'traces') {
        if (failTraces) { failTraces = false; reply(null, { ok: false, error: 'Thought refresh failed' }); return; }
        if (activityFlow) {
          if (request.payload.cursor) historyReply = () => reply({ items: [], nextCursor: null });
          else reply({ items: activityRecords, nextCursor: 'trace-page-2' });
          return;
        }
        const capabilityRecords = [
          { id: 'script-publication', seq: 19, episodeId: 'script', callId: 'create-call', kind: 'capability_created', capabilityId: 'Script.sum',
            capabilityManifest: { id: 'Script.sum', version: 1, revision: 'private-revision' }, evidence: { testsPassed: 2 } },
          { id: 'script-created', seq: 20, episodeId: 'script', callId: 'create-call', kind: 'capability_result', capability: { id: 'Capability.create', args: { code: 'PRIVATE_CODE', tests: 'PRIVATE_TEST_INPUT' } },
            result: { ok: true, published: true, contract: { id: 'Script.sum', description: 'Sum numbers. <img src=x onerror="alert(1)">', version: 1 }, evidence: { testsPassed: 2 } } },
          { id: 'script-ran', seq: 21, episodeId: 'script', kind: 'capability_result', capability: { id: 'Script.sum', args: { input: 'PRIVATE_INPUT' } },
            result: { ok: true, id: 'Script.sum', version: 1, output: 'PRIVATE_OUTPUT', access: 'pure-computation' } },
          { id: 'script-failed', seq: 22, episodeId: 'script', kind: 'capability_failed', capabilityId: 'Script.sum', code: 'SCRIPT_TIMEOUT', result: { ok: false, message: 'PRIVATE_DIAGNOSTICS' } },
          { id: 'script-cancelled', seq: 23, episodeId: 'script', kind: 'cancelled' },
        ];
        reply({ items: request.payload.cursor ? [{ id: 'trace-older', seq: 0, episodeId: 'older', kind: 'accepted', trigger: { kind: 'think', text: 'Earlier question' }, createdAt: 1 }] : [...personRecords(), ...capabilityRecords], nextCursor: request.payload.cursor ? null : 'trace-page-2' });
      } else if (request.op === 'inspect') {
        reply({ items: request.payload.section === 'memory'
          ? [{ id: 'curiosity', kind: 'interest', statement: 'An interest saved in memory. <script>text only</script>', revision: 2, epistemicState: 'hypothesis', sourceRefs: ['message:older'] }]
          : [{ id: 'Script.sum', domain: 'script', description: 'Sum numbers', version: 1, code: 'return input.reduce((a,b)=>a+b,0)' }], nextCursor: null });
      } else if (request.op === 'search') {
        reply({ items: [{ id: 'archived', role: 'user', text: longReading ? 'A message from the durable archive.\n'.repeat(100) : 'A message from the durable archive. <img src=x>', createdAt: 1 }], nextCursor: null });
      } else if (['send', 'think', 'dream'].includes(request.op)) {
        if (unknownCommand) { unknownCommand = false; reply(null, { ok: false, error: 'Unknown outcome', errorCode: 'outcome_unknown' }); return; }
        if (request.op === 'send' && !activityFlow) messages.push({ id: 'm1', role: 'user', text: request.payload.text, attachments: (request.payload.attachments || []).map(a => ({ ...a, name: 'notes.txt' })), createdAt: 3 }, { id: 'm2', role: 'assistant', text: 'Recorded mock response.\n'.repeat(90), createdAt: 4 });
        busy = true; reply({ episodeId: activityFlow ? 'episode-1' : 'live-episode' });
      } else if (request.op === 'settings') saveSettings = () => reply({ settings: request.payload });
      else if (request.op === 'cancel') { busy = false; reply({ cancelled: true }); }
    });
  });
  return { requests, finishHistory() { historyReply(); historyReply = null; }, historyPending() { return !!historyReply; }, activity(records, status = 'running') { activityRecords = records; busy = status === 'running'; latestEpisode = { id: 'episode-1', status, ...(busy ? {} : { endedAt: new Date().toISOString() }) }; }, setRenameSupported(value) { renameSupported = value; }, failNextCommand() { unknownCommand = true; }, failTraceRequest() { failTraces = true; }, setModels(value) { models = value; }, finishSettings() { saveSettings(); }, configure(value) { configured = value; }, online(value) { agents[0].online = value; agentList(); }, disconnect() { socket.close({ code: 1000, reason: 'mock reconnect check' }); } };
}

for (const scenario of [{ width: 1280, theme: 'light', locale: 'en' }, { width: 1280, theme: 'dark', locale: 'zh-CN' }, { width: 320, theme: 'light', locale: 'en' }, { width: 320, theme: 'dark', locale: 'zh-CN' }, { width: 800, theme: 'light', locale: 'en' }]) {
  test(`Digital Person conversation / thoughts / debug / gating ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }, testInfo) => {
    const mock = await mockPersonSocket(page);
    await page.setViewportSize({ width: scenario.width, height: 800 });
    await page.addInitScript(s => { localStorage.setItem('locale', s.locale); localStorage.setItem('theme', s.theme); }, scenario);
    await page.goto(serverUrl);
    // Verify the served artifact, not just an environment variable on the test runner.
    if (process.env.PERSON_UI_PRODUCTION === 'true') await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(1);
    else await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(0);
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    const zh = scenario.locale === 'zh-CN';
    if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
    const entry = page.locator('.sidebar-person-trigger:visible');
    await entry.focus(); await entry.press('Enter');
    await expect(page.locator('.person-page')).toBeVisible();
    await expect(page.locator('.session-sidebar-shell')).toHaveCount(0);
    await expect(page.locator('.person-header h1')).toHaveText('Ada');
    await expect(page.locator('.person-page .theme-toggle')).toHaveCount(0);
    await expect(page.locator('.person-breadcrumb #person-agent')).toBeVisible();
    await expect(page.locator('.person-views, .person-page .session-tab-bar, .person-manual-hint, .person-attachment-policy')).toHaveCount(0);
    await expect(page.locator('.person-status')).toContainText(zh ? '等待你发起' : 'Waiting for you');
    expect(mock.requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
    const input = page.getByLabel(zh ? '消息或思考主题' : 'Message or thought topic', { exact: true });
    await expect(input).toBeEnabled();
    await input.focus(); await expect(input).toBeFocused();
    await expect(page.locator('.person-menu')).toHaveCount(0);
    await expect(page.locator('.person-page')).not.toContainText(zh ? '工作中心' : 'Work Center');
    await page.getByRole('button', { name: zh ? '配置' : 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await dialog.getByLabel(zh ? '沿用 Agent 默认模型范围' : 'Follow Agent model defaults').uncheck();
    await dialog.getByLabel('provider/model-b', { exact: true }).check();
    const save = dialog.getByRole('button', { name: zh ? '保存' : 'Save', exact: true });
    expect(await save.evaluate(el => parseFloat(getComputedStyle(el).borderRadius))).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath(`person-settings-${scenario.width}-${scenario.theme}.png`) });
    await save.click();
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(dialog).toBeFocused();
    mock.finishSettings();
    await expect(dialog).toHaveCount(0);
    expect(mock.requests.find(r => r.op === 'settings').payload).toEqual({ modelCandidates: ['provider/model-b'] });
    const composer = page.locator('.person-composer');
    await expect(composer.locator('.mobile-quick-send-bar, .yeaft-model-selector, select')).toHaveCount(0);
    const picker = page.waitForEvent('filechooser');
    await composer.getByRole('button', { name: zh ? '上传文件' : 'Upload file', exact: true }).focus();
    await page.keyboard.press('Enter');
    await (await picker).setFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('A small attachment with user-provided reference data.') },
      { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') },
    ]);
    await expect(composer.locator('.attachments-preview')).toContainText('notes.txt');
    await expect(composer.locator('.attachment-thumb')).toBeVisible();
    await expect(composer.locator('.attachment-item')).toHaveCount(2);
    await expect(page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true })).toBeEnabled();
    await input.fill('Hello Person');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`person-composer-${scenario.width}-${scenario.theme}.png`) });
    await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
    expect(mock.requests.find(r => r.op === 'send').payload.attachments).toEqual([{ fileId: expect.any(String) }, { fileId: expect.any(String) }]);
    await expect(page.locator('.attachments-preview')).toHaveCount(0);
    await expect(input).toBeDisabled();
    const loading = page.locator('.person-response-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(page.locator('.person-header')).not.toContainText(zh ? '处理中' : 'Processing');
    await expect(page.locator('.person-header')).not.toContainText(zh ? '取消' : 'Cancel');
    await expect(page.locator('.person-composer .message-composer-spinner')).toBeVisible();
    await expect(page.locator('.person-conversation .tool-line, .person-conversation .person-debug-row')).toHaveCount(0);
    const dot = loading.locator('.typing-indicator > span').first();
    expect(await dot.evaluate(el => getComputedStyle(el).animationName)).toBe('typing');
    expect(await dot.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await dot.evaluate(el => {
      const sample = document.createElement('div');
      sample.style.color = 'var(--text-secondary)';
      el.append(sample);
      const color = getComputedStyle(sample).color;
      sample.remove();
      return color;
    }));
    await page.screenshot({ path: testInfo.outputPath(`person-loading-${scenario.width}-${scenario.theme}.png`) });
    await expect(page.locator('.person-messages')).toContainText('Recorded mock response.');
    await expect.poll(() => page.locator('.person-messages').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.locator('.person-composer').getByRole('button', { name: zh ? '停止执行' : 'Stop execution', exact: true }).click();
    await expect(input).toBeEnabled();
    await expect(loading).toHaveCount(0);
    await expect(page.locator('.person-composer .stop-btn, .person-composer .message-composer-spinner')).toHaveCount(0);
    await page.getByRole('button', { name: zh ? '加载更早消息' : 'Load older messages' }).click();
    await expect(page.locator('.person-messages')).toContainText('Older persisted message');
    await page.screenshot({ path: testInfo.outputPath(`person-messages-${scenario.width}.png`) });
    await page.getByRole('button', { name: zh ? '数字人内核' : 'Inside the digital person', exact: true }).click();
    const thoughts = page.locator('#person-thoughts');
    await expect(page.locator('#person-conversation')).toBeVisible();
    if (scenario.width > 900) {
      const conversation = await page.locator('#person-conversation').boundingBox();
      const side = await page.locator('#person-side-panel').boundingBox();
      expect(side.x).toBeGreaterThanOrEqual(conversation.x + conversation.width - 1);
    } else {
      await expect(page.locator('#person-side-panel')).toHaveAttribute('aria-modal', 'true');
      await expect(page.locator('#person-conversation')).toHaveAttribute('inert', '');
      const first = page.locator('.person-panel-header .header-action-btn');
      const last = thoughts.getByRole('button', { name: zh ? '加载更早的思考' : 'Load earlier thoughts' });
      await first.focus(); await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused();
      await page.keyboard.press('Tab'); await expect(first).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#person-side-panel')).toHaveCount(0);
      await expect(page.locator('.person-thoughts-button')).toBeFocused();
      await page.locator('.person-thoughts-button').click();
    }
    await expect(thoughts).toContainText('Maybe the delay came from the final verification step.');
    await expect(thoughts).toContainText('A repeated guess is not new evidence.');
    await expect(thoughts).toContainText('<script>not HTML</script>');
    const publication = thoughts.locator('[data-thought-kind="capability_created"]');
    await expect(publication).toContainText('Script.sum');
    await expect(publication).toContainText(zh ? '能力已保存，不依赖思考结论是否被采纳' : 'Capability saved independently of thought adoption');
    await expect(publication).toContainText(zh ? '通过这些测试不代表在其他输入下也一定正确' : 'Passing these tests does not prove correctness for other inputs');
    await expect(publication.locator('.person-thought-status')).toHaveText(zh ? '已记录' : 'Recorded');
    await expect(thoughts.locator('[data-thought-kind="script_executed"]')).toContainText(zh ? '纯计算已完成' : 'Pure computation completed');
    await expect(thoughts.locator('[data-thought-kind="capability_failed"]')).toContainText(zh ? '已达脚本时间限制' : 'Script time limit reached');
    await expect(thoughts.locator('img, script, pre')).toHaveCount(0);
    for (const text of ['PRIVATE SYSTEM PROMPT', 'contextBytes', 'test/model', 'HIDDEN REASONING', 'PRIVATE_CODE', 'PRIVATE_TEST_INPUT', 'PRIVATE_INPUT', 'PRIVATE_OUTPUT', 'PRIVATE_DIAGNOSTICS']) await expect(thoughts).not.toContainText(text);
    await page.getByRole('button', { name: zh ? '加载更早的思考' : 'Load earlier thoughts' }).click();
    await expect(thoughts).toContainText('Earlier question');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`person-thoughts-${scenario.width}.png`) });
    await page.getByRole('button', { name: zh ? '调试日志' : 'Debug logs', exact: true }).click();
    await expect(thoughts).toHaveCount(0);
    await page.locator('.person-debug-row').filter({ hasText: 'call_started' }).locator('summary').click();
    await expect(page.locator('#person-debug')).toContainText('contextBytes');
    await page.getByRole('button', { name: zh ? '返回' : 'Back', exact: true }).click();
    await expect(page.locator('#person-debug')).toHaveCount(0);
    await expect(thoughts).toBeVisible();
    if (scenario.width <= 900) {
      mock.failTraceRequest();
      await thoughts.getByRole('button', { name: zh ? '刷新' : 'Refresh', exact: true }).click();
      await expect(page.locator('.person-panel-error')).toContainText('Thought refresh failed');
      const recovery = page.locator('.person-panel-error').getByRole('button', { name: zh ? '刷新' : 'Refresh', exact: true });
      await recovery.focus(); await recovery.press('Enter');
      await expect(page.locator('.person-panel-error')).toHaveCount(0);
      const closeDrawer = page.locator('.person-panel-header .header-action-btn');
      await expect(closeDrawer).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#person-side-panel')).toHaveCount(0);
      await expect(page.locator('.person-thoughts-button')).toBeFocused();
      await page.locator('.person-thoughts-button').click();
      await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'reconnecting'; });
      await expect(page.locator('.person-panel-notice')).toContainText(zh ? '连接' : 'Connection');
      await expect(page.locator('.person-panel-notice button')).toBeVisible();
      await page.locator('.person-panel-notice button').focus();
      await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
      await expect(page.locator('#person-conversation')).toHaveAttribute('inert', '');
      await expect.poll(() => mock.requests.filter(r => r.op === 'open').length).toBeGreaterThan(1);
      await expect(closeDrawer).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#person-side-panel')).toHaveCount(0);
      await expect(page.locator('.person-thoughts-button')).toBeFocused();
      await page.locator('.person-thoughts-button').click();
      if (scenario.width === 800) {
        await page.locator('.person-panel-backdrop').click({ position: { x: 5, y: 300 } });
        await expect(page.locator('.person-thoughts-button')).toBeFocused();
        await page.locator('.person-thoughts-button').click();
      }
    }
    const innerNav = page.locator('.person-inspector-nav');
    await innerNav.getByRole('button', { name: zh ? '记忆' : 'Memory', exact: true }).click();
    await expect(page.locator('.person-knowledge')).toContainText('An interest saved in memory.');
    await page.locator('.person-knowledge-item > summary').click();
    await expect(page.locator('.person-knowledge')).toContainText(zh ? '假设' : 'Hypothesis');
    await expect(page.locator('.person-knowledge script')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`person-memory-${scenario.width}-${scenario.theme}.png`) });
    await innerNav.getByRole('button', { name: zh ? '技能与能力' : 'Skills & capabilities', exact: true }).click();
    await expect(page.locator('.person-knowledge')).toContainText('Script.sum');
    await page.locator('.person-panel-header .header-action-btn').click();
    await input.fill('A preserved draft');
    await page.locator('.person-search-button').click();
    const searchInput = page.locator('.person-search-form input');
    await expect(searchInput).toBeFocused();
    await searchInput.fill('archive');
    await searchInput.press('Enter');
    await expect(page.locator('.person-search-result')).toContainText('A message from the durable archive.');
    await expect(page.locator('.person-search-result img')).toHaveCount(0);
    await expect(page.locator('.person-messages')).not.toContainText('durable archive');
    await page.screenshot({ path: testInfo.outputPath(`person-search-${scenario.width}-${scenario.theme}.png`) });
    await page.locator('.person-panel-header .header-action-btn').click();
    await expect(page.locator('.person-search-button')).toBeFocused();
    await expect(input).toHaveValue('A preserved draft');
    await input.fill('');
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-panel-header').getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: zh ? '数字人内核' : 'Inside the digital person', exact: true })).toBeFocused();
    await page.getByRole('button', { name: zh ? '思考' : 'Think', exact: true }).click();
    await expect.poll(() => mock.requests.filter(r => r.op === 'think').length).toBe(1);
    expect(mock.requests.find(r => r.op === 'think').payload.text).toBe('');
    await page.locator('.person-composer').getByRole('button', { name: zh ? '停止执行' : 'Stop execution', exact: true }).click();
    await expect(input).toBeEnabled();
    await page.getByRole('button', { name: zh ? '遐想' : 'Dream', exact: true }).click();
    await expect.poll(() => mock.requests.filter(r => r.op === 'dream').length).toBe(1);
    await page.locator('.person-composer').getByRole('button', { name: zh ? '停止执行' : 'Stop execution', exact: true }).click();
    await page.getByRole('combobox', { name: zh ? 'Agent' : 'Agent', exact: true }).click();
    const agentMenu = page.locator('.modern-select-menu');
    expect(await agentMenu.evaluate(el => parseFloat(getComputedStyle(el).borderRadius))).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath(`person-agents-${scenario.width}-${scenario.theme}.png`) });
    await page.getByRole('option', { name: 'Owner Agent B', exact: true }).click();
    await expect(page.locator('.person-header h1')).toHaveText('Bea');
    await expect(page.locator('.person-messages')).not.toContainText('Hello Person');
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Old Agent', exact: true }).click();
    await expect(page.locator('.person-status')).toContainText('digital_person');
    await expect(input).toBeDisabled();
    mock.configure(false);
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Owner Agent A', exact: true }).click();
    await expect(page.locator('.person-configuration')).toContainText('MongoDB');
    await expect(page.locator('.person-configuration')).toContainText(zh ? '不要将凭据' : 'Do not paste credentials');
    mock.configure(true);
    await page.locator('.person-header').getByRole('button', { name: zh ? '刷新' : 'Refresh', exact: true }).click();
    await expect(input).toBeEnabled();
    const opens = mock.requests.filter(r => r.op === 'open').length;
    mock.online(false); await expect(input).toBeDisabled();
    mock.online(true); await expect(input).toBeEnabled();
    expect(mock.requests.filter(r => r.op === 'open').length).toBeGreaterThan(opens);
    const connectionOpens = mock.requests.filter(r => r.op === 'open').length;
    mock.disconnect();
    await expect.poll(() => mock.requests.filter(r => r.op === 'open').length).toBeGreaterThan(connectionOpens);
    await expect(input).toBeEnabled();
    for (const op of ['send', 'think', 'dream']) expect(mock.requests.filter(r => r.op === op)).toHaveLength(1);
    expect(mock.requests.every(r => r.requestId && r.agentId && !r.sessionId && !r.ownerId)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`person-conversation-${scenario.width}.png`) });
    mock.failNextCommand();
    await input.fill('Retain this draft after an uncertain command');
    await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
    const retry = page.locator('.person-retry .btn-secondary');
    await expect(retry).toBeVisible();
    expect(await retry.evaluate(el => parseFloat(getComputedStyle(el).borderRadius))).toBeGreaterThan(0);
    expect((await retry.boundingBox()).height).toBeGreaterThanOrEqual(32);
    await expect(input).toHaveValue('Retain this draft after an uncertain command');
    await page.locator('.person-retry .btn-ghost').click();
    mock.setModels(Array.from({ length: 40 }, (_, i) => ({ id: 'provider/' + ('long-model-name-'.repeat(5)) + i })));
    await page.locator('.person-header').getByRole('button', { name: zh ? '刷新' : 'Refresh', exact: true }).click();
    await expect(input).toBeEnabled();
    await page.getByRole('button', { name: zh ? '配置' : 'Settings', exact: true }).click();
    const longDialog = page.getByRole('dialog');
    const body = longDialog.locator('.person-settings-body');
    await expect.poll(() => body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await longDialog.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(longDialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.person-settings-button')).toBeFocused();
    mock.setRenameSupported(false);
    await page.locator('.person-header').getByRole('button', { name: zh ? '刷新' : 'Refresh', exact: true }).click();
    await expect(input).toBeEnabled();
    await page.getByRole('button', { name: zh ? '配置' : 'Settings', exact: true }).click();
    await expect(page.getByLabel(zh ? '名字' : 'Name', { exact: true })).toBeDisabled();
    await expect(page.getByRole('dialog')).toContainText(zh ? '请升级 Agent' : 'Upgrade the Agent');
    await expect(page.locator('.person-model-default input')).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.locator('.person-navigation button').first().click();
    await expect(page.locator('.chat-page')).toBeVisible();
  });
}

// A last page of prose must remain reachable when there is no load-more button.
test('compact inner reading regions support keyboard scrolling and restore focus', async ({ page, serverUrl }) => {
  await mockPersonSocket(page, { longReading: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  await page.goto(serverUrl);
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  await page.locator('.header-sidebar-toggle').click();
  await page.locator('.sidebar-person-trigger:visible').click();
  await expect(page.locator('#person-input')).toBeEnabled();
  await page.locator('#person-input').fill('Keep this draft');
  const inside = page.locator('.person-thoughts-button');
  await inside.click();
  const nav = page.locator('.person-inspector-nav');
  await nav.getByRole('button', { name: 'Overview', exact: true }).click();
  const overview = page.getByRole('region', { name: 'Overview', exact: true });
  await expect(overview).toBeVisible();
  await nav.getByRole('button', { name: 'Skills & capabilities', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(overview).toBeFocused();
  expect(await overview.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.keyboard.press('PageDown');
  await expect.poll(() => overview.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(inside).toBeFocused();
  const search = page.locator('.person-search-button');
  await search.click();
  await page.locator('.person-search-form input').fill('archive');
  await page.locator('.person-search-form input').press('Enter');
  await expect(page.locator('.person-search-result')).toHaveCount(1);
  await expect(page.locator('.person-search .person-load-more')).toHaveCount(0);
  const results = page.getByRole('region', { name: 'Search messages', exact: true });
  await page.locator('.person-search-form button').focus();
  await page.keyboard.press('Tab');
  await expect(results).toBeFocused();
  expect(await results.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.keyboard.press('PageDown');
  await expect.poll(() => results.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await expect(page.locator('#person-input')).toHaveValue('Keep this draft');
});

// The UI preference never writes Agent runtime configuration or starts cognition.
test('Person entry is opt-in per Agent via Agent settings and survives reload', async ({ page, serverUrl }) => {
  const mock = await mockPersonSocket(page, { enableUi: false });
  await page.goto(serverUrl);
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  await expect(page.locator('.sidebar-person-trigger')).toHaveCount(0);
  expect(await page.evaluate(() => window.Pinia.useChatStore().enterDigitalPerson('person-a'))).toBe(false);
  await page.locator('.agent-dropdown-trigger:visible').click();
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const dialog = page.locator('.agent-settings-dialog');
  const toggle = dialog.getByRole('switch', { name: 'Digital Person', exact: true });
  await expect(toggle).not.toBeChecked();
  await dialog.locator('.agent-settings-person-row .agent-settings-switch').click();
  await expect(toggle).toBeChecked();
  await dialog.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'Owner Agent B' }).click();
  await expect(toggle).not.toBeChecked();
  await dialog.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'Owner Agent A' }).click();
  await expect(toggle).toBeChecked();
  await dialog.locator('.agent-settings-close').click();
  await expect(page.locator('.sidebar-person-trigger:visible')).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  await expect(page.locator('.sidebar-person-trigger:visible')).toBeVisible();
  await page.locator('.sidebar-person-trigger:visible').click();
  await expect(page.locator('#person-input')).toBeEnabled();
  await page.locator('#person-agent').click();
  await expect(page.getByRole('option', { name: 'Owner Agent B', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const before = mock.requests.length;
  await page.evaluate(() => window.Pinia.useChatStore().setDigitalPersonUiEnabled(false, 'person-a'));
  await expect(page.locator('.person-page')).toHaveCount(0);
  await expect(page.locator('.sidebar-person-trigger')).toHaveCount(0);
  expect(mock.requests.slice(before)).toEqual([]);
  expect(mock.requests.filter(r => ['send', 'think', 'dream', 'settings'].includes(r.op))).toEqual([]);
});

for (const scenario of [{ width: 1280, theme: 'light', locale: 'en' }, { width: 320, theme: 'dark', locale: 'zh-CN' }]) {
  test(`Digital Person live activity stays truthful ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }, testInfo) => {
    test.setTimeout(60000);
    const mock = await mockPersonSocket(page, { activityFlow: true });
    await page.setViewportSize({ width: scenario.width, height: 800 });
    await page.addInitScript(s => { localStorage.setItem('locale', s.locale); localStorage.setItem('theme', s.theme); }, scenario);
    await page.goto(serverUrl);
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
    await page.locator('.sidebar-person-trigger:visible').click();
    const zh = scenario.locale === 'zh-CN';
    await page.getByRole('button', { name: zh ? '思考' : 'Think', exact: true }).click();
    const records = [];
    const add = (kind, extra = {}) => records.push({ id: `live-${records.length}`, seq: records.length + 1, episodeId: 'episode-1', createdAt: new Date().toISOString(), kind, ...extra });
    add('accepted', { trigger: { kind: 'think', text: 'PRIVATE_INPUT' } });
    add('call_started', { callId: 'a', request: { system: 'PRIVATE_PROMPT' } });
    add('call_output', { callId: 'a', output: { text: 'PRIVATE_OUTPUT' } });
    add('capability_started', { callId: 'a', capability: { id: 'Recall', args: { query: 'PRIVATE_QUERY' } } });
    mock.activity(records);
    const activity = page.locator('.person-activity');
    await expect(activity).toContainText(zh ? '正在查找相关记忆' : 'Looking up relevant memories');
    await expect(activity).not.toHaveAttribute('open', '');
    const details = activity.locator('summary');
    await details.focus(); await page.keyboard.press('Enter');
    await expect(activity).toHaveAttribute('open', '');
    // Paged journal remains readable while the live activity tail keeps polling.
    await page.locator('.person-thoughts-button').click();
    await page.getByRole('button', { name: zh ? '加载更早的思考' : 'Load earlier thoughts' }).click();
    await page.locator('.person-panel-header .header-action-btn').click();
    add('capability_result', { callId: 'a', capability: { id: 'Recall' }, result: { items: ['PRIVATE_MEMORY'] } });
    add('capability_started', { callId: 'b', capability: { id: 'Skill.reconsider' } });
    mock.activity(records);
    await expect(activity).toContainText(zh ? '正在查看思考方法' : 'Reading a thinking method');
    expect(mock.historyPending()).toBe(true);
    mock.finishHistory();
    add('capability_result', { callId: 'b', capability: { id: 'Skill.reconsider' } });
    add('capability_started', { callId: 'c', capability: { id: `Script.${'a'.repeat(48)}`, args: 'PRIVATE_CODE' } });
    mock.activity(records);
    await expect(activity).toContainText(`Script.${'a'.repeat(48)}`);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`person-activity-${scenario.width}-${scenario.theme}.png`) });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await activity.locator('.typing-indicator > span').first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'reconnecting'; });
    await expect(activity).toContainText(zh ? '暂时无法确认进展' : 'cannot confirm progress');
    await expect(activity.locator('.person-response-loading')).toHaveCount(0);
    await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
    await expect(activity.locator('.person-response-loading')).toBeVisible();
    // A capability failure is not necessarily an episode failure; the model may continue.
    add('capability_failed', { callId: 'c', capabilityId: `Script.${'a'.repeat(48)}`, result: { message: 'PRIVATE_DIAGNOSTICS' } });
    add('call_started', { callId: 'd' });
    mock.activity(records);
    await expect(activity).toContainText(zh ? '正在思考' : 'Thinking');
    add('call_output', { callId: 'd' });
    add('committed');
    mock.activity(records, 'completed');
    await expect(activity.locator('.person-response-loading')).toHaveCount(0);
    await expect(activity).toContainText(zh ? '本次活动已完成' : 'This activity is complete');
    await expect(page.locator('#person-input')).toBeEnabled();
    if (!await activity.evaluate(el => el.open)) await activity.locator('summary').click();
    await expect(activity).toContainText(zh ? '失败' : 'Failed');
    await expect(activity.locator('pre, .tool-line, img, script')).toHaveCount(0);
    for (const text of ['PRIVATE_INPUT', 'PRIVATE_PROMPT', 'PRIVATE_QUERY', 'PRIVATE_OUTPUT', 'PRIVATE_MEMORY', 'PRIVATE_CODE', 'PRIVATE_DIAGNOSTICS']) await expect(activity).not.toContainText(text);
    expect(mock.requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(1);
  });
}
