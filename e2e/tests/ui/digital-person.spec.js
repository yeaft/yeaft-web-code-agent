import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { personRecords } from '../../../test/fixtures/person-records.js';

// Real browser entry + WebSocket framing with an explicit mock Person runtime.
// This is not a model, MongoDB or Server authorization integration test.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

async function mockPersonSocket(page) {
  const requests = [];
  const messages = [];
  let socket;
  let configured = true;
  let busy = false;
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
      if (request.op === 'status') reply({ configured, reason: configured ? '' : 'MongoDB is not configured', models });
      else if (request.op === 'open') reply({ person: { id: 'person-1' } });
      else if (request.op === 'snapshot') {
        reply({ person: { id: 'person-1', name: request.agentId === 'person-a' ? 'Ada' : 'Bea' }, state: { version: 4, currentEpisodeId: 'episode-1' }, messages: request.agentId === 'person-a' ? messages : [], busy, episodeId: busy ? 'episode-1' : null });
      } else if (request.op === 'messages') {
        reply({ items: request.payload.cursor ? [{ id: 'older', role: 'assistant', text: 'Older persisted message', createdAt: 1 }] : [], nextCursor: request.payload.cursor ? null : 'older-page' });
      } else if (request.op === 'traces') {
        if (failTraces) { failTraces = false; reply(null, { ok: false, error: 'Thought refresh failed' }); return; }
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
      } else if (['send', 'think', 'dream'].includes(request.op)) {
        if (unknownCommand) { unknownCommand = false; reply(null, { ok: false, error: 'Unknown outcome', errorCode: 'outcome_unknown' }); return; }
        if (request.op === 'send') messages.push({ id: 'm1', role: 'user', text: request.payload.text, attachments: (request.payload.attachments || []).map(a => ({ ...a, name: 'notes.txt' })), createdAt: 3 }, { id: 'm2', role: 'assistant', text: 'Recorded mock response.\n'.repeat(90), createdAt: 4 });
        busy = true; reply({ episodeId: 'episode-1' });
      } else if (request.op === 'settings') saveSettings = () => reply({ settings: request.payload });
      else if (request.op === 'cancel') { busy = false; reply({ cancelled: true }); }
    });
  });
  return { requests, failNextCommand() { unknownCommand = true; }, failTraceRequest() { failTraces = true; }, setModels(value) { models = value; }, finishSettings() { saveSettings(); }, configure(value) { configured = value; }, online(value) { agents[0].online = value; agentList(); }, disconnect() { socket.close({ code: 1000, reason: 'mock reconnect check' }); } };
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
    await expect(page.locator('.person-messages')).toContainText('Recorded mock response.');
    await expect.poll(() => page.locator('.person-messages').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
    await expect(input).toBeEnabled();
    await page.getByRole('button', { name: zh ? '加载更早消息' : 'Load older messages' }).click();
    await expect(page.locator('.person-messages')).toContainText('Older persisted message');
    await page.screenshot({ path: testInfo.outputPath(`person-messages-${scenario.width}.png`) });
    await page.getByRole('button', { name: zh ? '思考记录' : 'Thought journal', exact: true }).click();
    const thoughts = page.locator('#person-thoughts');
    await expect(page.locator('#person-conversation')).toBeVisible();
    if (scenario.width > 900) {
      const conversation = await page.locator('#person-conversation').boundingBox();
      const side = await page.locator('#person-side-panel').boundingBox();
      expect(side.x).toBeGreaterThanOrEqual(conversation.x + conversation.width - 1);
    } else {
      await expect(page.locator('#person-side-panel')).toHaveAttribute('aria-modal', 'true');
      await expect(page.locator('#person-conversation')).toHaveAttribute('inert', '');
      const first = page.locator('.person-debug-link');
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
      await page.locator('.person-panel-error').getByRole('button', { name: zh ? '刷新' : 'Refresh', exact: true }).click();
      await expect(page.locator('.person-panel-error')).toHaveCount(0);
      await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'reconnecting'; });
      await expect(page.locator('.person-panel-notice')).toContainText(zh ? '连接' : 'Connection');
      await expect(page.locator('.person-panel-notice button')).toBeVisible();
      await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
      await expect(page.locator('#person-conversation')).toHaveAttribute('inert', '');
      await expect.poll(() => mock.requests.filter(r => r.op === 'open').length).toBeGreaterThan(1);
      if (scenario.width === 800) {
        await page.locator('.person-panel-backdrop').click({ position: { x: 5, y: 300 } });
        await expect(page.locator('.person-thoughts-button')).toBeFocused();
        await page.locator('.person-thoughts-button').click();
      }
    }
    await page.locator('.person-panel-header').getByRole('button', { name: zh ? '关闭' : 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: zh ? '思考记录' : 'Thought journal', exact: true })).toBeFocused();
    await page.getByRole('button', { name: zh ? '思考' : 'Think', exact: true }).click();
    await expect.poll(() => mock.requests.filter(r => r.op === 'think').length).toBe(1);
    expect(mock.requests.find(r => r.op === 'think').payload.text).toBe('');
    await page.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
    await expect(input).toBeEnabled();
    await page.getByRole('button', { name: zh ? '遐想' : 'Dream', exact: true }).click();
    await expect.poll(() => mock.requests.filter(r => r.op === 'dream').length).toBe(1);
    await page.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
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
    await page.locator('.person-navigation button').first().click();
    await expect(page.locator('.chat-page')).toBeVisible();
  });
}
