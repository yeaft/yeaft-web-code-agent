import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { personRecords } from '../../../test/fixtures/person-records.js';

// Real browser entry + WebSocket framing with an explicit mock Person runtime.
// This is not a model, SQLite or Server authorization integration test.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

async function mockPersonSocket(page, { longReading = false, enableUi = true, activityFlow = false, conversationFlow = false, modelPreferences = false, initialMessages = [], olderMessages = [] } = {}) {
  if (enableUi) await page.addInitScript(() => localStorage.setItem('digital-person-ui-enabled-by-agent',
    JSON.stringify({ 'person-a': true, 'person-b': true, 'old-agent': true })));
  const requests = [];
  const messages = initialMessages.map(message => ({ ...message }));
  const agentMessages = new Map([['person-a', messages], ['person-b', []]]);
  let admissionReply;
  let holdAdmission = false;
  let cancelReply;
  let holdCancel = false;
  let commandError = null;
  let episodeNumber = 0;
  let activeEpisode = 'live-episode';
  let socket;
  let configured = true;
  let renameSupported = true;
  let busy = false;
  let activityRecords = [];
  let latestEpisode = null;
  let historyReply;
  let messageHistoryReply;
  let messageHistoryLoaded = false;
  let saveSettings;
  let failTraces = false;
  let unknownCommand = false;
  let models = [{ id: 'provider/model-a' }, { id: 'provider/model-b' }];
  let modelSettings = { modelCandidates: [], defaultModel: null };
  const effectiveCandidates = () => modelSettings.modelCandidates.length ? modelSettings.modelCandidates : models.slice(0, 8).map(model => model.id);
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
      if (request.op === 'status') reply({ configured, ...(renameSupported ? { renameSupported: true } : {}), reason: configured ? '' : 'Instance directory is not configured', models,
        ...(modelPreferences ? { defaultModelSupported: true, ...modelSettings, agentDefaultModel: models[0]?.id || null,
          effectiveModelCandidates: effectiveCandidates(), effectiveDefaultModel: modelSettings.defaultModel || effectiveCandidates()[0] || null } : {}) });
      else if (request.op === 'open') reply({ person: { id: 'person-1' } });
      else if (request.op === 'snapshot') {
        reply({ person: { id: 'person-1', name: request.agentId === 'person-a' ? 'Ada' : 'Bea', ...(modelPreferences ? { settings: modelSettings } : {}) }, state: { version: 4, currentEpisodeId: 'episode-1', summary: longReading ? 'A considered understanding.\n'.repeat(100) : '' }, messages: agentMessages.get(request.agentId) || [], busy, latestEpisode, episodeId: busy ? (activityFlow ? 'episode-1' : activeEpisode) : null });
      } else if (request.op === 'messages') {
        if (conversationFlow && request.payload.cursor && olderMessages.length) {
          messageHistoryReply = () => {
            agentMessages.get(request.agentId).unshift(...olderMessages.map(row => ({ ...row })));
            messageHistoryLoaded = true;
            reply({ items: olderMessages, nextCursor: null });
          };
          return;
        }
        reply({ items: conversationFlow ? (agentMessages.get(request.agentId) || []) : request.payload.cursor ? [{ id: 'older', role: 'assistant', text: 'Older persisted message', createdAt: 1 }] : [], nextCursor: request.payload.cursor || messageHistoryLoaded ? null : 'older-page' });
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
        if (commandError) { const error = commandError; commandError = null; reply(null, { ok: false, error: 'Admission rejected', errorCode: error }); return; }
        if (conversationFlow && request.op === 'send') {
          const admit = () => {
            activeEpisode = `conversation-${++episodeNumber}`;
            agentMessages.get(request.agentId).push({ id: `user-${episodeNumber}`, role: 'user', text: request.payload.text, episodeId: activeEpisode, createdAt: new Date().toISOString() });
            busy = true;
            latestEpisode = { id: activeEpisode, status: 'running', createdAt: new Date().toISOString() };
            reply({ episodeId: activeEpisode });
          };
          if (holdAdmission) admissionReply = admit;
          else admit();
          return;
        }
        if (unknownCommand) { unknownCommand = false; reply(null, { ok: false, error: 'Unknown outcome', errorCode: 'outcome_unknown' }); return; }
        if (request.op === 'send' && !activityFlow) messages.push({ id: 'm1', role: 'user', text: request.payload.text, attachments: (request.payload.attachments || []).map(a => ({ ...a, name: 'notes.txt' })), createdAt: 3 }, { id: 'm2', role: 'assistant', text: 'Recorded mock response.\n'.repeat(90), createdAt: 4 });
        busy = true; reply({ episodeId: activityFlow ? 'episode-1' : 'live-episode' });
      } else if (request.op === 'settings') saveSettings = () => {
        if (modelPreferences) modelSettings = { ...modelSettings, ...request.payload };
        reply({ settings: modelPreferences ? modelSettings : request.payload });
      };
      else if (request.op === 'cancel') {
        const finish = () => { busy = false; latestEpisode = { ...latestEpisode, id: activeEpisode, status: 'cancelled' }; reply({ cancelled: true }); };
        if (holdCancel) cancelReply = finish; else finish();
      }
    });
  });
  return { requests,
    messageHistoryPending() { return !!messageHistoryReply; },
    finishMessageHistory() { messageHistoryReply(); messageHistoryReply = null; },
    holdAdmission() { holdAdmission = true; },
    admissionPending() { return !!admissionReply; },
    admit() { holdAdmission = false; admissionReply(); admissionReply = null; },
    rejectNextSend(code = 'model_unavailable') { commandError = code; },
    messages(rows, agentId = 'person-a') { agentMessages.set(agentId, rows.map(row => ({ ...row }))); },
    reply(id, text, agentId = 'person-a', episodeId = activeEpisode, metadata = {}) {
      const rows = agentMessages.get(agentId);
      const existing = rows.find(row => row.id === id);
      if (existing) existing.text = text;
      else rows.push({ id, role: 'assistant', text, episodeId, createdAt: new Date().toISOString(), ...metadata });
    },
    waiting(phase, offset = 61000) {
      busy = true; latestEpisode = { ...latestEpisode, id: activeEpisode, status: 'running', feedback: { at: new Date(new Date(latestEpisode.createdAt).getTime() + offset).toISOString(), phase, capabilityId: 'PRIVATE_CAPABILITY' } };
    },
    replyAt(offset) { return new Date(new Date(latestEpisode.createdAt).getTime() + offset).toISOString(); },
    holdCancel() { holdCancel = true; }, cancelPending() { return !!cancelReply; }, finishCancel() { holdCancel = false; cancelReply(); cancelReply = null; },
    complete() { busy = false; latestEpisode = { id: activeEpisode, status: 'completed', endedAt: new Date().toISOString() }; },
    finishHistory() { historyReply(); historyReply = null; }, historyPending() { return !!historyReply; }, activity(records, status = 'running') { activityRecords = records; busy = status === 'running'; latestEpisode = { id: 'episode-1', status, ...(busy ? {} : { endedAt: new Date().toISOString() }) }; }, setRenameSupported(value) { renameSupported = value; }, failNextCommand() { unknownCommand = true; }, failTraceRequest() { failTraces = true; }, setModels(value) { models = value; }, finishSettings() { saveSettings(); }, configure(value) { configured = value; }, online(value) { agents[0].online = value; agentList(); }, disconnect() { socket.close({ code: 1000, reason: 'mock reconnect check' }); } };
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
    await expect(page.locator('.person-status, .person-status-dot, .person-connection-notice')).toHaveCount(0);
    const nameBounds = await page.locator('.person-identity').boundingBox();
    expect(Math.abs(nameBounds.x + nameBounds.width / 2 - scenario.width / 2)).toBeLessThan(1);
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
    // The waiting indicator is initially visible. Once the long reply arrives,
    // its start is pinned instead of chasing the indicator below the reply.
    await expect(loading).toHaveCount(1);
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveText('');
    await expect(page.locator('#person-conversation .person-activity, #person-conversation details')).toHaveCount(0);
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await dot.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('.person-messages')).toContainText('Recorded mock response.');
    await expect.poll(() => page.locator('.person-messages').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect.poll(() => page.locator('[data-message-id="m2"]').evaluate(el => {
      const pane = el.closest('.person-messages');
      return Math.abs(el.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop);
    })).toBeLessThanOrEqual(2);
    expect(await loading.evaluate(el => el.getBoundingClientRect().top >= el.closest('.person-messages').getBoundingClientRect().bottom)).toBe(true);
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
    await page.getByRole('combobox', { name: 'Agent', exact: true }).focus();
    await page.keyboard.press('Enter');
    const agentMenu = page.locator('.modern-select-menu');
    await expect(agentMenu).toHaveClass(/agent-select-menu/);
    const menuStyle = await agentMenu.evaluate(el => {
      const label = el.querySelector('.modern-select-option-label');
      const style = getComputedStyle(label);
      return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, radius: getComputedStyle(el).borderRadius };
    });
    const sessionMenuStyle = await page.evaluate(() => {
      const menu = document.createElement('div'); menu.className = 'agent-dropdown';
      const label = document.createElement('span'); label.className = 'agent-dropdown-name';
      menu.append(label); document.body.append(menu);
      const style = getComputedStyle(label);
      const result = { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, radius: getComputedStyle(menu).borderRadius };
      menu.remove(); return result;
    });
    expect(menuStyle).toEqual(sessionMenuStyle);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toBeFocused();
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await expect(agentMenu).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`person-agents-${scenario.width}-${scenario.theme}.png`) });
    await page.getByRole('option', { name: 'Owner Agent B', exact: true }).click();
    await expect(page.locator('.person-header h1')).toHaveText('Bea');
    await expect(page.locator('.person-messages')).not.toContainText('Hello Person');
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Old Agent', exact: true }).click();
    await expect(page.locator('.person-connection-notice')).toContainText('digital_person');
    await expect(input).toBeDisabled();
    mock.configure(false);
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Owner Agent A', exact: true }).click();
    await expect(page.locator('.person-configuration')).toBeVisible();
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
  test(`Digital Person animation only in conversation, activity only inside ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }, testInfo) => {
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
    const loading = page.locator('#person-conversation .person-response-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText('');
    await expect(page.locator('#person-conversation .person-activity')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`person-conversation-loading-${scenario.width}-${scenario.theme}.png`) });
    await page.locator('.person-thoughts-button').click();
    const activity = page.locator('#person-thoughts .person-activity');
    await expect(activity).toContainText(zh ? '正在查找相关记忆' : 'Looking up relevant memories');
    await expect(activity).not.toHaveAttribute('open', '');
    const details = activity.locator('summary');
    await details.focus(); await page.keyboard.press('Enter');
    await expect(activity).toHaveAttribute('open', '');
    // Paged journal remains readable while the live activity tail keeps polling.
    await page.getByRole('button', { name: zh ? '加载更早的思考' : 'Load earlier thoughts' }).click();
    await page.locator('.person-panel-header .header-action-btn').click();
    add('capability_result', { callId: 'a', capability: { id: 'Recall' }, result: { items: ['PRIVATE_MEMORY'] } });
    add('capability_started', { callId: 'b', capability: { id: 'Skill.reconsider' } });
    mock.activity(records);
    await expect(loading).toHaveText('');
    await expect(page.locator('#person-conversation .person-activity')).toHaveCount(0);
    await page.locator('.person-thoughts-button').click();
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
    await expect(loading).toHaveCount(0);
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
    await expect(loading).toHaveCount(0);
    await expect(page.locator('#person-conversation .person-activity')).toHaveCount(0);
    await expect(page.locator('#person-input')).toBeEnabled();
    if (!await activity.evaluate(el => el.open)) await activity.locator('summary').click();
    await expect(activity).toContainText(zh ? '失败' : 'Failed');
    await expect(activity.locator('pre, .tool-line, img, script')).toHaveCount(0);
    for (const text of ['PRIVATE_INPUT', 'PRIVATE_PROMPT', 'PRIVATE_QUERY', 'PRIVATE_OUTPUT', 'PRIVATE_MEMORY', 'PRIVATE_CODE', 'PRIVATE_DIAGNOSTICS']) await expect(activity).not.toContainText(text);
    expect(mock.requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(1);
    await page.locator('.person-panel-header .header-action-btn').click();
    await expect(page.locator('.person-activity, .person-response-loading')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`person-conversation-completed-${scenario.width}-${scenario.theme}.png`) });
  });
}
const responseScenarios = [
  { width: 1280, theme: 'light' }, { width: 1280, theme: 'dark' },
  { width: 320, theme: 'light' }, { width: 320, theme: 'dark' },
];
const previousConversation = [
  { id: 'history-user', role: 'user', text: 'Previous question stays in the transcript.', createdAt: 1 },
  { id: 'history-reply', role: 'assistant', text: 'Previous answer stays in the transcript.\n'.repeat(35), createdAt: 2 },
];
const replySelector = id => `.person-message[data-message-id="${id}"]`;

async function openResponseConversation(page, serverUrl, scenario) {
  await page.setViewportSize({ width: scenario.width, height: 800 });
  await page.addInitScript(s => { localStorage.setItem('locale', 'en'); localStorage.setItem('theme', s.theme); }, scenario);
  await page.goto(serverUrl);
  if (process.env.PERSON_UI_PRODUCTION === 'true') await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(1);
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
  await page.locator('.sidebar-person-trigger:visible').click();
  await expect(page.locator('#person-input')).toBeEnabled();
  await expect(page.locator(replySelector('history-reply'))).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme);
}

// Record every animation frame across wire updates, not just the final layout.
// A newly inserted target may need two frames for Vue's patch + scheduled layout.
// Growth and completion of an existing target get no settling allowance.
async function startResponseFrames(page, selector) {
  await page.evaluate(selector => {
    const recording = { samples: [], frame: null };
    window.personResponseFrames = recording;
    const sample = () => {
      const pane = document.querySelector('.person-messages');
      const target = document.querySelector(selector);
      if (pane && target) recording.samples.push({
        top: target.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop,
        scrollTop: pane.scrollTop,
      });
      recording.frame = requestAnimationFrame(sample);
    };
    recording.frame = requestAnimationFrame(sample);
  }, selector);
}

async function finishResponseFrames(page) {
  return page.evaluate(async () => {
    for (let i = 0; i < 16; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    const recording = window.personResponseFrames;
    cancelAnimationFrame(recording.frame);
    delete window.personResponseFrames;
    return recording.samples;
  });
}

function expectPinnedFrames(samples, { newTarget = false } = {}) {
  const settled = newTarget ? samples.slice(2) : samples;
  expect(settled.length).toBeGreaterThanOrEqual(12);
  expect(Math.max(...settled.map(sample => Math.abs(sample.top))), JSON.stringify(settled.filter(sample => Math.abs(sample.top) > 2))).toBeLessThanOrEqual(2);
  expect(Math.max(...settled.map(sample => sample.top)) - Math.min(...settled.map(sample => sample.top))).toBeLessThanOrEqual(2);
}

function expectScrollStable(samples, scrollTop) {
  expect(samples.length).toBeGreaterThanOrEqual(12);
  expect(Math.max(...samples.map(sample => Math.abs(sample.scrollTop - scrollTop))), 'No frame should jump away from the existing reading position').toBeLessThanOrEqual(2);
}

async function expectAbovePane(page, selector) {
  await expect(page.locator(selector)).toHaveCount(1);
  expect(await page.locator(selector).evaluate(el => {
    const pane = el.closest('.person-messages');
    return el.getBoundingClientRect().bottom <= pane.getBoundingClientRect().top + pane.clientTop + 2;
  })).toBe(true);
}

async function sendWaiting(page, mock, text) {
  mock.holdAdmission();
  await page.locator('#person-input').fill(text);
  await startResponseFrames(page, '.person-response-start');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => mock.admissionPending()).toBe(true);
  await expect(page.locator('#person-input')).toBeDisabled();
  await expect(page.locator('.person-response-loading')).toBeInViewport();
  expectPinnedFrames(await finishResponseFrames(page), { newTarget: true });
  await expectAbovePane(page, replySelector('history-reply'));
  await expectAbovePane(page, '[data-msg-id="history-user"]');
  await startResponseFrames(page, '.person-response-start');
  mock.admit();
  await expect(page.locator('.person-messages')).toContainText(text);
  expectPinnedFrames(await finishResponseFrames(page));
}

async function showReply(page, mock, id, text) {
  await startResponseFrames(page, replySelector(id));
  mock.reply(id, text);
  await expect(page.locator(replySelector(id))).toContainText(text.trim().split('\n').at(-1));
  expectPinnedFrames(await finishResponseFrames(page), { newTarget: true });
}

async function completePinnedReply(page, mock, id) {
  const scrollTop = await page.locator('.person-messages').evaluate(el => el.scrollTop);
  await startResponseFrames(page, replySelector(id));
  mock.complete();
  await expect(page.locator('.person-response-loading')).toHaveCount(0);
  await expect(page.locator('#person-input')).toBeEnabled();
  const samples = await finishResponseFrames(page);
  expectPinnedFrames(samples);
  expectScrollStable(samples, scrollTop);
}

async function userScrollResponse(page, width) {
  const pane = page.locator('.person-messages');
  const before = await pane.evaluate(el => el.scrollTop);
  const bounds = await pane.boundingBox();
  if (width === 320) {
    // Trusted touch input drives the browser's native scroller (not a synthetic
    // touchmove event or a direct scrollTop assignment).
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height * 0.75;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 24 }] });
      await page.waitForTimeout(30);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 220);
  }
  await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBeGreaterThan(before + 30);
  // Let native wheel/touch momentum settle before checking later wire updates.
  await page.waitForTimeout(400);
}

for (const scenario of responseScenarios) {
  test(`Digital Person local response focus survives growth and yields to user scroll ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }) => {
    test.setTimeout(60000);
    const mock = await mockPersonSocket(page, {
      conversationFlow: true, initialMessages: previousConversation,
      olderMessages: [{ id: 'prepended-reply', role: 'assistant', text: 'Earlier archived answer.\n'.repeat(45), createdAt: 0 }],
    });
    await openResponseConversation(page, serverUrl, scenario);

    await sendWaiting(page, mock, 'First local question');
    await showReply(page, mock, 'short-reply', 'A short first answer.');
    await expectAbovePane(page, '[data-msg-id="user-1"]');
    await completePinnedReply(page, mock, 'short-reply');

    await sendWaiting(page, mock, 'Second local question');
    await expectAbovePane(page, replySelector('short-reply'));
    await showReply(page, mock, 'growing-reply', 'The new answer starts here.');
    const pinnedScroll = await page.locator('.person-messages').evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('growing-reply'));
    mock.reply('growing-reply', 'The new answer starts here.\n' + 'A long response line.\n'.repeat(90) + 'Growth checkpoint.');
    await expect(page.locator(replySelector('growing-reply'))).toContainText('Growth checkpoint.');
    const growingFrames = await finishResponseFrames(page);
    expectPinnedFrames(growingFrames);
    expectScrollStable(growingFrames, pinnedScroll);
    await expectAbovePane(page, '[data-msg-id="user-2"]');
    await expect(page.locator('.person-response-loading')).not.toBeInViewport();
    await completePinnedReply(page, mock, 'growing-reply');

    await sendWaiting(page, mock, 'Third local question for free reading');
    await showReply(page, mock, 'free-reading-reply', 'Free reading starts here.\n' + 'A long response line.\n'.repeat(90));
    await userScrollResponse(page, scenario.width);
    const userScroll = await page.locator('.person-messages').evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('free-reading-reply'));
    mock.reply('free-reading-reply', 'Free reading starts here.\n' + 'A long response line.\n'.repeat(130) + 'After user scroll.');
    await expect(page.locator(replySelector('free-reading-reply'))).toContainText('After user scroll.');
    expectScrollStable(await finishResponseFrames(page), userScroll);
    await startResponseFrames(page, replySelector('free-reading-reply'));
    mock.complete();
    await expect(page.locator('#person-input')).toBeEnabled();
    expectScrollStable(await finishResponseFrames(page), userScroll);

    const releasedPane = page.locator('.person-messages');
    await expect(releasedPane).not.toHaveClass(/is-response-pinned/);
    expect(await releasedPane.evaluate(el => getComputedStyle(el).overflowAnchor)).toBe('auto');
    // Invoke the real history button without Playwright scrolling the offscreen
    // control into view: the reader must stay on the released response.
    await page.locator('.person-load-more').evaluate(button => button.click());
    await expect.poll(() => mock.messageHistoryPending()).toBe(true);
    await startResponseFrames(page, replySelector('free-reading-reply'));
    const anchorScroll = await releasedPane.evaluate(el => el.scrollTop);
    const anchorTop = await page.locator(replySelector('free-reading-reply')).evaluate(el => {
      const pane = el.closest('.person-messages');
      return el.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop;
    });
    mock.finishMessageHistory();
    await expect(page.locator(replySelector('prepended-reply'))).toHaveCount(1);
    const historyFrames = await finishResponseFrames(page);
    expect(historyFrames.length).toBeGreaterThanOrEqual(12);
    expect(Math.max(...historyFrames.map(sample => Math.abs(sample.top - anchorTop))), 'History prepend must preserve the visible reading position on every frame').toBeLessThanOrEqual(2);
    // scrollTop must compensate for the new history, unlike a disabled native
    // anchor that leaves scrollTop unchanged and moves the current answer down.
    expect(await releasedPane.evaluate(el => el.scrollTop)).toBeGreaterThan(anchorScroll + 500);
    await expectAbovePane(page, replySelector('prepended-reply'));

    await sendWaiting(page, mock, 'Fourth local question for keyboard reading');
    await expectAbovePane(page, replySelector('growing-reply'));
    await showReply(page, mock, 'keyboard-reply', 'Keyboard reading.\n' + 'Another long line.\n'.repeat(90));
    const pane = page.locator('.person-messages');
    const beforeKey = await pane.evaluate(el => el.scrollTop);
    await pane.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBeGreaterThan(beforeKey + 30);
    await page.waitForTimeout(400);
    const keyboardScroll = await pane.evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('keyboard-reply'));
    mock.reply('keyboard-reply', 'Keyboard reading.\n' + 'Another long line.\n'.repeat(130) + 'After keyboard scroll.');
    await expect(page.locator(replySelector('keyboard-reply'))).toContainText('After keyboard scroll.');
    expectScrollStable(await finishResponseFrames(page), keyboardScroll);
    mock.complete();
    await expect(page.locator('#person-input')).toBeEnabled();

    await sendWaiting(page, mock, 'Fifth local question refocuses');
    await expectAbovePane(page, replySelector('keyboard-reply'));
    await showReply(page, mock, 'final-reply', 'A final short answer.');
    await completePinnedReply(page, mock, 'final-reply');
    await expect(page.locator('.person-message')).toHaveCount(7);
    await expect(page.locator('.user-turn-block')).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const scenario of [{ width: 1280, theme: 'dark' }, { width: 320, theme: 'light' }]) {
  test(`Digital Person reconnect and Agent switch discard local response focus ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }) => {
    test.setTimeout(45000);
    const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: previousConversation });
    await openResponseConversation(page, serverUrl, scenario);
    await sendWaiting(page, mock, 'Send before reconnect');
    await showReply(page, mock, 'reconnect-reply', 'Reply before reconnect.\n' + 'Long persisted reply.\n'.repeat(90));
    const opens = mock.requests.filter(request => request.op === 'open').length;
    mock.disconnect();
    await expect.poll(() => mock.requests.filter(request => request.op === 'open').length).toBeGreaterThan(opens);
    await expect(page.locator(replySelector('reconnect-reply'))).toHaveCount(1);
    await expect(page.locator('.person-response-tail, .person-response-start')).toHaveCount(0);
    const pane = page.locator('.person-messages');
    // Programmatic movement without a user-intent event proves the old lock was
    // discarded by reconnect itself, rather than incidentally released by input.
    await pane.evaluate(el => { el.scrollTop = 100; });
    const reconnectScroll = await pane.evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('reconnect-reply'));
    mock.reply('reconnect-reply', 'Reply before reconnect.\n' + 'Long persisted reply.\n'.repeat(130) + 'Remote growth after reconnect.');
    await expect(page.locator(replySelector('reconnect-reply'))).toContainText('Remote growth after reconnect.');
    expectScrollStable(await finishResponseFrames(page), reconnectScroll);
    mock.complete();
    await expect(page.locator('#person-input')).toBeEnabled();
    await sendWaiting(page, mock, 'New local send after reconnect');
    await showReply(page, mock, 'switch-reply', 'Pinned before switching Agent.');
    mock.messages(previousConversation, 'person-b');
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Owner Agent B', exact: true }).click();
    await expect(page.locator('.person-header h1')).toHaveText('Bea');
    await expect(page.locator(replySelector('switch-reply'))).toHaveCount(0);
    await expect(page.locator('.person-response-tail, .person-response-start')).toHaveCount(0);
    await pane.evaluate(el => { el.scrollTop = 80; });
    const switchedScroll = await pane.evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('history-reply'));
    mock.reply('remote-b', 'Remote Agent B reply.\n'.repeat(90), 'person-b');
    await expect(page.locator(replySelector('remote-b'))).toHaveCount(1);
    expectScrollStable(await finishResponseFrames(page), switchedScroll);
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Owner Agent A', exact: true }).click();
    await expect(page.locator('.person-header h1')).toHaveText('Ada');
    await expect(page.locator(replySelector('switch-reply'))).toHaveCount(1);
    await expect(page.locator('.person-response-tail, .person-response-start')).toHaveCount(0);
    expect(await page.locator(replySelector('switch-reply')).evaluate(el => {
      const pane = el.closest('.person-messages');
      return el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    })).toBeGreaterThan(100);
  });
}

test('Digital Person rejected admission removes waiting focus and next Send starts a fresh reply', async ({ page, serverUrl }) => {
  const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: previousConversation });
  await openResponseConversation(page, serverUrl, { width: 320, theme: 'dark' });
  mock.rejectNextSend();
  await page.locator('#person-input').fill('Rejected local send');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.person-error')).toContainText('Admission rejected');
  await expect(page.locator('#person-input')).toBeEnabled();
  await expect(page.locator('#person-input')).toHaveValue('Rejected local send');
  await expect(page.locator('.person-response-start, .person-response-tail, .person-response-loading')).toHaveCount(0);
  await expect(page.locator('.user-turn-block')).toHaveCount(1);
  await sendWaiting(page, mock, 'Accepted local send');
  await showReply(page, mock, 'accepted-reply', 'Fresh accepted response.');
  await completePinnedReply(page, mock, 'accepted-reply');
});

for (const scenario of [{ width: 1280, theme: 'light', locale: 'en' }, { width: 320, theme: 'dark', locale: 'zh-CN' }]) {
  test(`Digital Person candidate and default model preferences ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }, testInfo) => {
    const mock = await mockPersonSocket(page, { modelPreferences: true });
    await page.setViewportSize({ width: scenario.width, height: 800 });
    await page.addInitScript(s => { localStorage.setItem('locale', s.locale); localStorage.setItem('theme', s.theme); }, scenario);
    await page.goto(serverUrl);
    if (process.env.PERSON_UI_PRODUCTION === 'true') await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(1);
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    const zh = scenario.locale === 'zh-CN';
    if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
    await page.locator('.sidebar-person-trigger:visible').click();
    await page.getByRole('button', { name: zh ? '配置' : 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const list = dialog.locator('.person-model-list input');
    await expect(list.nth(0)).toBeChecked();
    await expect(list.nth(1)).toBeChecked();
    await expect(list.nth(0)).toBeDisabled();
    await expect(dialog.locator('.person-model-summary')).toContainText('2');
    await expect(dialog.locator('.person-default-model-field')).toContainText('provider/model-a');
    const select = dialog.locator('#person-default-model');
    await select.selectOption('provider/model-b');
    await select.focus(); await expect(select).toBeFocused();
    await expect(dialog.locator('.person-model-role')).toContainText(zh ? '默认起始模型' : 'Default starting model');
    const follow = dialog.locator('.person-model-default input');
    await follow.uncheck();
    await list.nth(1).uncheck();
    await expect(dialog.locator('.btn-primary')).toBeDisabled();
    await expect(dialog.locator('.person-default-model-field [role="alert"]')).toBeVisible();
    await list.nth(1).check();
    await list.nth(0).uncheck();
    await expect(select.locator('option')).toHaveCount(2);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await dialog.locator('.person-settings-body').evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
    await page.screenshot({ path: testInfo.outputPath(`person-model-preferences-${scenario.width}-${scenario.theme}.png`) });
    await dialog.locator('.btn-primary').click();
    await expect(dialog).toBeFocused();
    mock.finishSettings();
    await expect(dialog).toHaveCount(0);
    expect(mock.requests.filter(r => r.op === 'settings').at(-1).payload).toEqual({ modelCandidates: ['provider/model-b'], defaultModel: 'provider/model-b' });
    await page.getByRole('button', { name: zh ? '配置' : 'Settings', exact: true }).click();
    await expect(select).toHaveValue('provider/model-b');
    await expect(list.nth(0)).not.toBeChecked();
    await expect(list.nth(1)).toBeChecked();
    await follow.check();
    await select.selectOption('');
    await dialog.locator('.btn-primary').click(); mock.finishSettings();
    await expect(dialog).toHaveCount(0);
    expect(mock.requests.filter(r => r.op === 'settings').at(-1).payload).toEqual({ modelCandidates: [], defaultModel: null });
    expect(mock.requests.filter(r => ['send', 'think', 'dream'].includes(r.op))).toHaveLength(0);
  });
}


// Delays are authoritative backend timestamps, not a browser-generated timer.
// Only the wire runtime is scripted; rendering, polling, input and scrolling are real.
for (const scenario of responseScenarios) {
  test(`Digital Person adaptive progress and waiting feedback ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }, testInfo) => {
    test.setTimeout(60000);
    const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: previousConversation });
    await openResponseConversation(page, serverUrl, scenario);
    const zh = scenario.theme === 'dark';
    if (zh) await page.evaluate(() => window.Pinia.useChatStore().changeLocale('zh-CN'));
    const input = page.locator('#person-input');
    await input.fill('Delayed verified work');
    await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
    await expect(input).toBeDisabled();
    const feedback = page.locator('#person-conversation .person-wait-feedback');
    await expect(feedback).toHaveCount(0); // older servers / before any backend status
    await startResponseFrames(page, replySelector('progress-one'));
    mock.reply('progress-one', 'Verified finding at 31 seconds.', 'person-a', undefined,
      { replyKind: 'progress', callId: 'call-1', createdAt: mock.replyAt(31000) });
    await expect(page.locator(replySelector('progress-one'))).toContainText(zh ? '阶段回复' : 'Progress update');
    expectPinnedFrames(await finishResponseFrames(page), { newTarget: true });
    await expect(input).toBeDisabled();
    await expect(page.locator('.person-response-loading')).toBeVisible();
    const rows = await page.locator('.person-message').count();
    const statusAt = mock.replyAt(91000);
    mock.waiting('model', 91000);
    await expect(feedback).toContainText(zh ? '仍在等待模型回复。' : 'Still waiting for the model response.');
    await expect(feedback.locator('time')).toHaveAttribute('datetime', statusAt);
    await expect(feedback).not.toContainText('PRIVATE_CAPABILITY');
    await expect(feedback).toHaveCount(1);
    await startResponseFrames(page, replySelector('progress-one'));
    // Several polls replace one snapshot status, never add synthetic messages.
    const snapshots = mock.requests.filter(r => r.op === 'snapshot').length;
    await expect.poll(() => mock.requests.filter(r => r.op === 'snapshot').length).toBeGreaterThan(snapshots + 1);
    await expect(page.locator('.person-message')).toHaveCount(rows);
    expectPinnedFrames(await finishResponseFrames(page));
    mock.waiting('capability', 92000);
    await expect(feedback).toContainText(zh ? '仍在等待能力执行结束。' : 'Still waiting for the capability to finish.');
    await page.screenshot({ path: testInfo.outputPath(`person-feedback-${scenario.width}-${scenario.theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Adding a later reply supersedes status but leaves the first reply focused.
    await startResponseFrames(page, replySelector('progress-one'));
    mock.reply('progress-two', 'A later verified finding.\n' + 'Readable evidence.\n'.repeat(90), 'person-a', undefined,
      { replyKind: 'progress', callId: 'call-2', createdAt: mock.replyAt(93000) });
    await expect(page.locator(replySelector('progress-two'))).toContainText('A later verified finding.');
    await expect(feedback).toHaveCount(0);
    expectPinnedFrames(await finishResponseFrames(page));
    await expect(input).toBeDisabled();
    await userScrollResponse(page, scenario.width);
    const scrollTop = await page.locator('.person-messages').evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('progress-two'));
    mock.waiting('preparing', 154000);
    await expect(feedback).toContainText(zh ? '正在准备下一次回复。' : 'Preparing the next response.');
    mock.reply('progress-after-scroll', 'Another verified finding after scrolling.', 'person-a', undefined,
      { replyKind: 'progress', callId: 'call-3', createdAt: mock.replyAt(155000) });
    await expect(page.locator(replySelector('progress-after-scroll'))).toBeAttached();
    await expect(feedback).toHaveCount(0);
    await expect(page.locator('.person-response-loading')).toBeAttached();
    await expect(page.locator('.person-messages')).not.toHaveClass(/is-response-pinned/);
    mock.reply('final-answer', 'The final verified result.', 'person-a', undefined,
      { replyKind: 'final', createdAt: mock.replyAt(156000) });
    await expect(page.locator(replySelector('final-answer'))).toBeAttached();
    await expect(feedback).toHaveCount(0);
    mock.complete();
    await expect(input).toBeEnabled();
    await expect(page.locator('.person-response-loading')).toHaveCount(0);
    await expect(page.locator(`${replySelector('final-answer')} .person-reply-kind`)).toHaveCount(0);
    expectScrollStable(await finishResponseFrames(page), scrollTop);
    await expect(page.locator('.person-messages')).not.toHaveClass(/is-response-pinned/);

    // Cancel immediately suppresses the confirmed line, and even an older
    // running snapshot after a reconnect cannot revive that episode's status.
    await input.fill('Cancel waiting work');
    await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
    mock.waiting('model');
    await expect(feedback).toHaveCount(1);
    mock.holdCancel();
    await page.locator('.stop-btn').click();
    await expect.poll(() => mock.cancelPending()).toBe(true);
    await expect(feedback).toHaveCount(0);
    await expect(page.locator('.stop-btn')).toBeDisabled();
    mock.finishCancel();
    await expect(input).toBeEnabled();
    mock.waiting('model', 122000); // deliberately replay an older running status
    await page.locator('.person-header-actions button').first().click();
    await expect(input).toBeDisabled();
    await expect(feedback).toHaveCount(0);
    mock.disconnect();
    await expect(page.locator('.person-connection-notice')).toBeVisible();
    await expect(feedback).toHaveCount(0);
    await page.getByRole('button', { name: zh ? '重连' : 'Reconnect', exact: true }).click();
    await expect(page.locator('.person-connection-notice')).toHaveCount(0);
    await expect(page.locator(`${replySelector('progress-one')} .person-reply-kind`)).toContainText(zh ? '阶段回复' : 'Progress update');
    await expect(feedback).toHaveCount(0);
    await expect(page.locator('.person-messages')).not.toHaveClass(/is-response-pinned/);
    expect(mock.requests.filter(r => r.op === 'send')).toHaveLength(2);
  });
}
