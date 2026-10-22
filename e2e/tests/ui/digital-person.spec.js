import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { personRecords } from '../../../test/fixtures/person-records.js';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// Use the production projection (also covered by digital-person-ui unit tests)
// to locate persisted groups that virtualization intentionally unmounts.
const projectPersonConversation = runInNewContext(readFileSync(resolve('web/utils/person-conversation.js'), 'utf8')
  .replaceAll('export function ', 'function ') + '\nprojectPersonConversation;');

const conversationRecords = new WeakMap();

// Real browser entry + WebSocket framing with an explicit mock Person runtime.
// This is not a model, SQLite or Server authorization integration test.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

async function mockPersonSocket(page, { conversationFlow = false, modelPreferences = false, initialMessages = [], olderMessages = [] } = {}) {
  await page.addInitScript(() => localStorage.setItem('digital-person-ui-enabled-by-agent',
    JSON.stringify({ 'person-a': true, 'person-b': true, 'old-agent': true })));
  const requests = [];
  const messages = initialMessages.map(message => ({ ...message }));
  const agentMessages = new Map([['person-a', messages], ['person-b', []]]);
  let viewedAgentId = 'person-a';
  conversationRecords.set(page, () => agentMessages.get(viewedAgentId) || []);
  let cancelReply;
  let holdCancel = false;
  let episodeNumber = 0;
  let userNumber = 0;
  const receipts = new Map();
  let activeEpisode = 'live-episode';
  let socket;
  let busy = false;
  let latestEpisode = null;
  let messageHistoryReply;
  let messageHistoryLoaded = false;
  let saveSettings;
  let models = [{ id: 'provider/model-a' }, { id: 'provider/model-b' }];
  let modelSettings = { modelCandidates: [], defaultModel: null };
  const effectiveCandidates = () => modelSettings.modelCandidates.length ? modelSettings.modelCandidates : models.slice(0, 8).map(model => model.id);
  const agents = [
    { id: 'person-a', name: 'Owner Agent A', online: true, capabilities: ['digital_person'] },
    { id: 'person-b', name: 'Owner Agent B', online: true, capabilities: ['digital_person'] },
    { id: 'old-agent', name: 'Old Agent', online: true, capabilities: [] },
  ];
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
      if (request.op === 'status') reply({ configured: true, renameSupported: true, reason: '', models,
        ...(modelPreferences ? { defaultModelSupported: true, ...modelSettings, agentDefaultModel: models[0]?.id || null,
          effectiveModelCandidates: effectiveCandidates(), effectiveDefaultModel: modelSettings.defaultModel || effectiveCandidates()[0] || null } : {}) });
      else if (request.op === 'open') reply({ person: { id: 'person-1' } });
      else if (request.op === 'snapshot') {
        viewedAgentId = request.agentId;
        reply({ person: { id: 'person-1', name: request.agentId === 'person-a' ? 'Ada' : 'Bea', ...(modelPreferences ? { settings: modelSettings } : {}) }, state: { version: 4, currentEpisodeId: 'episode-1', summary: '' }, messages: agentMessages.get(request.agentId) || [], busy, latestEpisode, episodeId: busy ? activeEpisode : null });
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
      } else if (request.op === 'turns') {
        reply({ items: [], nextCursor: null });
      } else if (request.op === 'traces') {
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
        reply({ items: [{ id: 'archived', role: 'user', text: 'A message from the durable archive. <img src=x>', createdAt: 1 }], nextCursor: null });
      } else if (['send', 'think', 'dream'].includes(request.op)) {
        if (conversationFlow && request.op === 'send') {
          if (receipts.has(request.payload.clientMessageId)) { reply(receipts.get(request.payload.clientMessageId)); return; }
          const admit = () => {
            const wasBusy = busy;
            if (!busy) activeEpisode = `conversation-${++episodeNumber}`;
            // Simulated 30–156s feedback is ahead of the real browser clock.
            // Keep the next user record after the completed episode, just as a
            // real runtime does, so timestamp sorting cannot interleave turns.
            const rows = agentMessages.get(request.agentId);
            const createdAt = new Date(Math.max(Date.now(), ...rows.map(row => new Date(row.createdAt).getTime() + 1))).toISOString();
            const messageId = `user-${++userNumber}`;
            const deliveryState = wasBusy ? 'queued' : 'received';
            rows.push({ id: messageId, role: 'user', text: request.payload.text, episodeId: activeEpisode, createdAt, deliveryState,
              attachments: (request.payload.attachments || []).map(file => ({ ...file, name: 'notes.txt' })) });
            busy = true;
            if (!wasBusy) latestEpisode = { id: activeEpisode, status: 'running', createdAt };
            const receipt = { episodeId: activeEpisode, messageId, deliveryState, status: deliveryState, kind: 'send', text: request.payload.text };
            receipts.set(request.payload.clientMessageId, receipt);
            reply(receipt);
          };
          admit();
          return;
        }
        if (request.op === 'send') messages.push({ id: 'm1', role: 'user', text: request.payload.text, attachments: (request.payload.attachments || []).map(a => ({ ...a, name: 'notes.txt' })), createdAt: 3 }, { id: 'm2', role: 'assistant', text: 'Recorded mock response.\n'.repeat(90), createdAt: 4 });
        busy = true; reply({ episodeId: 'live-episode' });
      } else if (request.op === 'receipt') reply({ found: receipts.has(request.payload.clientMessageId), ...receipts.get(request.payload.clientMessageId) });
      else if (request.op === 'settings') saveSettings = () => {
        if (modelPreferences) modelSettings = { ...modelSettings, ...request.payload };
        reply({ settings: modelPreferences ? modelSettings : request.payload });
      };
      else if (request.op === 'cancel') {
        const finish = () => {
          for (const row of agentMessages.get(request.agentId) || []) if (row.role === 'user' && row.episodeId === activeEpisode && row.deliveryState === 'queued') row.deliveryState = 'stopped';
          busy = false; latestEpisode = { ...latestEpisode, id: activeEpisode, status: 'cancelled' }; reply({ cancelled: true });
        };
        if (holdCancel) cancelReply = finish; else finish();
      }
    });
  });
  return { requests,
    pause() { latestEpisode = { ...latestEpisode, status: 'paused' }; },
    receive(messageId) { const row = messages.find(row => row.id === messageId); row.deliveryState = 'received'; row.receivedAt = new Date().toISOString(); },
    messageHistoryPending() { return !!messageHistoryReply; },
    finishMessageHistory() { messageHistoryReply(); messageHistoryReply = null; },
    reply(id, text, agentId = 'person-a', episodeId = activeEpisode, metadata = {}) {
      const rows = agentMessages.get(agentId);
      const existing = rows.find(row => row.id === id);
      if (existing) existing.text = text;
      else rows.push({ id, role: 'assistant', text, episodeId, createdAt: new Date(Math.max(Date.now(), ...rows.map(row => new Date(row.createdAt).getTime() + 1))).toISOString(), ...metadata });
    },
    waiting(phase, offset = 61000) {
      busy = true; latestEpisode = { ...latestEpisode, id: activeEpisode, status: 'running', feedback: { at: new Date(new Date(latestEpisode.createdAt).getTime() + offset).toISOString(), phase, capabilityId: 'PRIVATE_CAPABILITY' } };
    },
    replyAt(offset) { return new Date(new Date(latestEpisode.createdAt).getTime() + offset).toISOString(); },
    holdCancel() { holdCancel = true; }, cancelPending() { return !!cancelReply; }, finishCancel() { holdCancel = false; cancelReply(); cancelReply = null; },
    complete() { busy = false; latestEpisode = { id: activeEpisode, status: 'completed', endedAt: new Date().toISOString() }; },
    finishSettings() { saveSettings(); },
    disconnect() { socket.close({ code: 1000, reason: 'mock reconnect check' }); },
  };
}

const responseScenarios = [
  { width: 1280, theme: 'light' }, { width: 320, theme: 'dark' },
];
const previousConversation = [
  { id: 'history-user', role: 'user', text: 'Previous question stays in the transcript.', createdAt: 1 },
  { id: 'history-reply', role: 'assistant', text: 'Previous answer stays in the transcript.\n'.repeat(35), createdAt: 2 },
];
// A group's article and its first section share an ID. Select the section for
// assistant content, or the article for system messages, never both at once.
const replySelector = id => `:is(.person-message:not(:has(.person-reply-part)), .person-reply-part)[data-message-id="${id}"]`;
const replyArticleSelector = id => `.person-message[data-message-id="${id}"]`;

async function expectReplyGroup(page, firstId, ids, { zh = false, kinds = [] } = {}) {
  const article = page.locator(replyArticleSelector(firstId));
  await expect(article).toHaveCount(1);
  const parts = article.locator('section.person-reply-part');
  await expect(parts).toHaveCount(ids.length);
  expect(await parts.evaluateAll(elements => elements.map(el => el.dataset.messageId))).toEqual(ids);
  await expect(article.locator('header.person-message-meta')).toHaveCount(1);
  await expect(article.locator('header.person-message-meta strong')).toHaveText('Ada');
  await expect(parts.locator('header.person-message-meta, .person-reply-part-meta strong')).toHaveCount(0);
  for (const [index, id] of ids.entries()) {
    const part = page.locator(replySelector(id));
    await expect(part).toHaveCount(1);
    const meta = part.locator('.person-reply-part-meta');
    await expect(meta).toHaveCount(1);
    await expect(meta.locator('time')).toHaveCount(1);
    await expect(meta.locator('time')).not.toHaveText('');
    if (index) {
      await expect(meta).toHaveClass(/person-reply-divider/);
      const divider = await meta.evaluate(el => {
        const style = getComputedStyle(el, '::before');
        return { width: parseFloat(style.flexBasis), border: parseFloat(style.borderTopWidth), content: style.content, partWidth: el.closest('.person-reply-part').clientWidth };
      });
      expect(divider.content).toBe('""');
      expect(divider.border).toBeGreaterThan(0);
      expect(divider.width).toBeGreaterThan(0);
      expect(divider.width).toBeLessThan(divider.partWidth / 2);
    } else await expect(meta).not.toHaveClass(/person-reply-divider/);
    const label = meta.locator('.person-reply-kind');
    if (kinds[index] === 'progress') await expect(label).toHaveText(zh ? '阶段回复' : 'Progress update');
    else if (kinds[index] === 'final') await expect(label).toHaveText(zh ? '最终回复' : 'Final response');
    else await expect(label).toHaveCount(0);
  }
  return article;
}

async function openResponseConversation(page, serverUrl, scenario) {
  await page.setViewportSize({ width: scenario.width, height: 800 });
  await page.addInitScript(s => { localStorage.setItem('locale', 'en'); localStorage.setItem('theme', s.theme); }, scenario);
  await page.goto(serverUrl);
  if (process.env.PERSON_UI_PRODUCTION === 'true') await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(1);
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
  await page.locator('.sidebar-person-trigger:visible').click();
  await expect(page.locator('#person-input')).toBeEnabled();
  await expect.poll(() => page.locator('.person-messages .virtual-transcript-item').count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.person-messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
  await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme);
}

// Record every animation frame across wire updates, not just the final layout.
// Reply parts use their article as the stable anchor: appending a later part
// must not move the focus from the first reply to the new part's own top.
// A newly inserted target may need two frames for Vue's patch + scheduled layout.
// Growth and completion of an existing target get no settling allowance.
async function startResponseFrames(page, selector) {
  await page.evaluate(selector => {
    const recording = { samples: [], frame: null };
    window.personResponseFrames = recording;
    const sample = () => {
      const pane = document.querySelector('.person-messages');
      const selected = document.querySelector(selector);
      const target = selected?.closest('.person-message') || selected;
      if (pane && target) recording.samples.push({
        top: target.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop,
        scrollTop: pane.scrollTop,
      });
      else if (recording.samples.length) recording.samples.push({ missing: true });
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
  expect(settled.some(sample => sample.missing), 'The focused response must remain mounted on every frame').toBe(false);
  expect(Math.max(...settled.map(sample => Math.abs(sample.top))), JSON.stringify(settled.filter(sample => Math.abs(sample.top) > 2))).toBeLessThanOrEqual(2);
  expect(Math.max(...settled.map(sample => sample.top)) - Math.min(...settled.map(sample => sample.top))).toBeLessThanOrEqual(2);
}

function expectScrollStable(samples, scrollTop) {
  expect(samples.length).toBeGreaterThanOrEqual(12);
  expect(samples.some(sample => sample.missing), 'The reading anchor must remain mounted on every frame').toBe(false);
  expect(Math.max(...samples.map(sample => Math.abs(sample.scrollTop - scrollTop))), 'No frame should jump away from the existing reading position').toBeLessThanOrEqual(2);
}

// An unmounted row is above the reader only when its logical group precedes
// the mounted virtual window. A spacer alone would also accept a missing/below row.
async function expectAbovePane(page, selector) {
  const id = selector.match(/data-(?:message-id|msg-id)="([^"]+)"/)?.[1];
  const blocks = projectPersonConversation(conversationRecords.get(page)());
  const index = blocks.findIndex(block => block.id === id || block.parts?.some(part => part.id === id));
  expect(index, `Persisted reading row ${id}`).toBeGreaterThanOrEqual(0);
  await expect.poll(() => page.evaluate(({ selector, index }) => {
    const pane = document.querySelector('.person-messages');
    const element = pane.querySelector(selector);
    if (element) return element.getBoundingClientRect().bottom <= pane.getBoundingClientRect().top + pane.clientTop + 2;
    const entries = [...pane.querySelectorAll('.virtual-transcript-item')];
    return entries.length > 0 && entries.every(entry => Number(entry.dataset.virtualIndex) > index);
  }, { selector, index })).toBe(true);
}

// Traverse the real scroller to mount an archived group. Never use this while
// measuring local response focus or a reader's prepend anchor.

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

for (const scenario of [{ width: 320, theme: 'dark', locale: 'zh-CN' }]) {
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

for (const scenario of responseScenarios) {
  test(`Digital Person live inbox sends and stops the same execution ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }, testInfo) => {
    const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: previousConversation });
    await page.route('**/api/upload', route => route.fulfill({ json: { files: [{ fileId: 'busy-notes' }] } }));
    await openResponseConversation(page, serverUrl, scenario);
    const zh = scenario.theme === 'dark';
    if (zh) await page.evaluate(() => window.Pinia.useChatStore().changeLocale('zh-CN'));
    const input = page.locator('#person-input');
    await input.fill('First question'); await input.press('Enter');
    await expect(page.locator('.stop-btn')).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(page.locator('.person-delivery[data-delivery-state="received"]')).toHaveCount(1);
    mock.reply('initial-progress', 'Still checking the first question.', 'person-a', undefined, { replyToMessageIds: ['user-1'] });
    await expect(page.locator(replySelector('initial-progress'))).toBeAttached();
    await expect(page.locator('.person-inbox-hint')).toContainText(zh ? '暂停时发送不会恢复执行' : 'Sending while paused does not resume execution');
    await expect(page.getByRole('button', { name: zh ? '思考' : 'Think', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: zh ? '遐想' : 'Dream', exact: true })).toBeDisabled();
    await page.locator('.person-composer input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Additional evidence') });
    await input.fill('Second question');
    await expect(page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true })).toBeEnabled();
    await input.press('Enter');
    await expect(page.locator('.person-delivery[data-delivery-state="queued"]')).toHaveCount(1);
    await expect(input).toBeFocused();
    expect(mock.requests.filter(row => row.op === 'send')[1].payload.attachments).toEqual([{ fileId: 'busy-notes' }]);
    mock.receive('user-2');
    mock.reply('answer-one', 'Answer to the first question.', 'person-a', undefined, { replyToMessageIds: ['user-1'] });
    mock.reply('answer-two', 'Answer to the second question.', 'person-a', undefined, { replyToMessageIds: ['user-2'] });
    await expect(page.locator(replyArticleSelector('answer-one'))).toHaveCount(1);
    await expect(page.locator(replyArticleSelector('answer-two'))).toHaveCount(1);
    await expect(page.locator(replyArticleSelector('answer-two') + ' .person-reply-context')).toContainText('Second question');
    await expect(page.locator('.person-delivery[data-delivery-state="received"]')).toHaveCount(2);
    await expect(input).toBeFocused();
    mock.pause();
    const snapshots = mock.requests.filter(row => row.op === 'snapshot').length;
    await expect.poll(() => mock.requests.filter(row => row.op === 'snapshot').length).toBeGreaterThan(snapshots);
    await input.fill('While paused'); await input.press('Enter');
    await expect(page.locator('.person-delivery[data-delivery-state="queued"]')).toHaveCount(1);
    await expect(input).toBeEnabled();
    await expect(page.locator('.stop-btn')).toBeVisible();
    expect(mock.requests.some(row => row.op === 'resume')).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`person-live-inbox-${scenario.width}-${scenario.theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.stop-btn').click();
    await expect(page.locator('.stop-btn')).toHaveCount(0);
    await expect(page.locator('.person-delivery[data-delivery-state="stopped"]')).toHaveCount(1);
    expect(mock.requests.find(row => row.op === 'cancel').payload).toEqual({ episodeId: 'conversation-1' });
    expect(mock.requests.filter(row => row.op === 'send')).toHaveLength(3);
    const opens = mock.requests.filter(row => row.op === 'open').length;
    mock.disconnect();
    await expect.poll(() => mock.requests.filter(row => row.op === 'open').length).toBeGreaterThan(opens);
    await expect(page.locator('.person-delivery[data-delivery-state="stopped"]')).toHaveCount(1);
    expect(mock.requests.filter(row => row.op === 'send')).toHaveLength(3);
  });
}

for (const scenario of responseScenarios) {
  test(`Digital Person latest exits short reply reserve ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }) => {
    const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: previousConversation });
    await openResponseConversation(page, serverUrl, scenario);
    const input = page.locator('#person-input');
    await input.fill('A short answer, please'); await input.press('Enter');
    mock.reply('short-answer', 'Short verified answer.', 'person-a', undefined, { replyKind: 'final' });
    await expect(page.locator(replySelector('short-answer'))).toContainText('Short verified answer.');
    const tail = page.locator('.person-response-tail');
    await expect.poll(() => tail.evaluate(el => parseFloat(el.style.height))).toBeGreaterThan(0);
    const latest = page.getByRole('button', { name: '↓ Latest', exact: true });
    await expect(latest).toBeVisible();
    const scrollTop = await page.locator('.person-messages').evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('short-answer'));
    mock.complete();
    await expect(page.locator('.stop-btn')).toHaveCount(0);
    await expect(page.locator('.person-response-loading')).toHaveCount(0);
    expectPinnedFrames(await finishResponseFrames(page));
    await startResponseFrames(page, replySelector('short-answer'));
    expectScrollStable(await finishResponseFrames(page), scrollTop);
    await latest.focus(); await latest.press('Enter');
    await expect(tail).toHaveCount(0);
    await expect(latest).toHaveCount(0);
    await expect.poll(() => page.locator('.person-messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
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
    await expect(input).toBeEnabled();
    const feedback = page.locator('#person-conversation .person-wait-feedback');
    await expect(feedback).toHaveCount(0); // older servers / before any backend status
    await startResponseFrames(page, replySelector('progress-one'));
    mock.reply('progress-one', 'Verified finding at 31 seconds.', 'person-a', undefined,
      { replyKind: 'progress', callId: 'call-1', createdAt: mock.replyAt(31000) });
    await expect(page.locator(replySelector('progress-one'))).toContainText(zh ? '阶段回复' : 'Progress update');
    const group = await expectReplyGroup(page, 'progress-one', ['progress-one'], { zh, kinds: ['progress'] });
    expectPinnedFrames(await finishResponseFrames(page), { newTarget: true });
    const firstArticle = await group.elementHandle();
    await expect(input).toBeEnabled();
    await expect(page.locator('.person-response-loading')).toBeVisible();
    await expect(group.locator('.person-response-loading')).toHaveCount(1);
    const statusAt = mock.replyAt(91000);
    mock.waiting('model', 91000);
    await expect(feedback).toContainText(zh ? '仍在等待模型回复。' : 'Still waiting for the model response.');
    await expect(group.locator('.person-wait-feedback')).toHaveCount(1);
    await expect(feedback.locator('time')).toHaveAttribute('datetime', statusAt);
    await expect(feedback).not.toContainText('PRIVATE_CAPABILITY');
    await expect(feedback).toHaveCount(1);
    await startResponseFrames(page, replySelector('progress-one'));
    // Several polls replace one snapshot status, never add synthetic messages.
    const snapshots = mock.requests.filter(r => r.op === 'snapshot').length;
    await expect.poll(() => mock.requests.filter(r => r.op === 'snapshot').length).toBeGreaterThan(snapshots + 1);
    await expect(group.locator('section.person-reply-part')).toHaveCount(1);
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
    await expectReplyGroup(page, 'progress-one', ['progress-one', 'progress-two'], { zh, kinds: ['progress', 'progress'] });
    expect(await group.evaluate((el, original) => el === original, firstArticle)).toBe(true);
    expectPinnedFrames(await finishResponseFrames(page));
    await expect(input).toBeEnabled();
    await userScrollResponse(page, scenario.width);
    const scrollTop = await page.locator('.person-messages').evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('progress-one'));
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
    expectScrollStable(await finishResponseFrames(page), scrollTop);
    const currentTurn = page.getByRole('button', { name: zh ? '回到本轮开头' : 'Back to this turn’s beginning', exact: true });
    const latest = page.getByRole('button', { name: zh ? '↓ 最新' : '↓ Latest', exact: true });
    await expect(currentTurn).toBeVisible();
    await expect(latest).toBeVisible();
    await currentTurn.focus(); await expect(currentTurn).toBeFocused();
    await currentTurn.press('Enter');
    const question = page.locator('.virtual-transcript-item').filter({ hasText: 'Delayed verified work' });
    await expect(question).toBeInViewport();
    await expect.poll(() => question.evaluate(el => Math.abs(el.getBoundingClientRect().top - el.closest('.person-messages').getBoundingClientRect().top))).toBeLessThanOrEqual(2);
    await expect(currentTurn).toHaveCount(0);
    await latest.click();
    await expect.poll(() => page.locator('.person-messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
    await expect(latest).toHaveCount(0);
    await expect(page.locator('.person-response-tail')).toHaveCount(0);
    mock.reply('final-growth', 'Additional delivered evidence.\n\n'.repeat(15), 'person-a', undefined, { replyKind: 'progress' });
    await expect(page.locator(replySelector('final-growth'))).toContainText('Additional delivered evidence.');
    await expect.poll(() => page.locator('.person-messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
    await page.screenshot({ path: testInfo.outputPath(`person-navigation-${scenario.width}-${scenario.theme}.png`) });

    // After following growth, explicitly read upwards again. Completion must
    // preserve that unpinned reading position, not reclaim bottom ownership.
    await page.locator('.person-messages').hover(); await page.mouse.wheel(0, -220);
    await expect(latest).toBeVisible();
    await page.waitForTimeout(400);
    const completionScroll = await page.locator('.person-messages').evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('progress-one'));
    mock.complete();
    await expect(input).toBeEnabled();
    await expect(page.locator('.person-response-loading')).toHaveCount(0);
    const completedIds = ['progress-one', 'progress-two', 'progress-after-scroll', 'final-answer', 'final-growth'];
    const completedKinds = ['progress', 'progress', 'progress', 'final', 'progress'];
    await expectReplyGroup(page, 'progress-one', completedIds, { zh, kinds: completedKinds });
    expect(await group.evaluate((el, original) => el === original, firstArticle)).toBe(true);
    expectScrollStable(await finishResponseFrames(page), completionScroll);
    await expect(page.locator('.person-messages')).not.toHaveClass(/is-response-pinned/);
    await page.screenshot({ path: testInfo.outputPath(`person-grouped-completed-${scenario.width}-${scenario.theme}.png`) });

    // Replaying a completed snapshot must rebuild the same group, not duplicate
    // parts or depend on local send/focus state.
    const opens = mock.requests.filter(request => request.op === 'open').length;
    mock.disconnect();
    await expect.poll(() => mock.requests.filter(request => request.op === 'open').length).toBeGreaterThan(opens);
    await expect(input).toBeEnabled();
    await expectReplyGroup(page, 'progress-one', completedIds, { zh, kinds: completedKinds });
    await expect(page.locator('.person-response-loading')).toHaveCount(0);

    // Cancel immediately suppresses the confirmed line, and even an older
    // running snapshot after a reconnect cannot revive that episode's status.
    await input.fill('Cancel waiting work');
    await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
    await expect(input).toBeEnabled();
    mock.reply('next-episode-progress', 'A separate episode starts here.', 'person-a', undefined,
      { replyKind: 'progress', createdAt: mock.replyAt(31000) });
    const nextGroup = await expectReplyGroup(page, 'next-episode-progress', ['next-episode-progress'], { zh, kinds: ['progress'] });
    await expectAbovePane(page, replySelector('progress-one'));
    mock.waiting('model', 92000);
    await expect(feedback).toHaveCount(1);
    await expect(nextGroup.locator('.person-response-loading')).toHaveCount(1);
    await expect(nextGroup.locator('.person-wait-feedback')).toHaveCount(1);
    await expect.poll(() => page.locator(replyArticleSelector('next-episode-progress')).evaluate(el => Math.abs(el.getBoundingClientRect().top - el.closest('.person-messages').getBoundingClientRect().top))).toBeLessThanOrEqual(2);
    await page.waitForTimeout(100);
    mock.holdCancel();
    const cancelScroll = await page.locator('.person-messages').evaluate(el => el.scrollTop);
    await startResponseFrames(page, replySelector('next-episode-progress'));
    await page.locator('.stop-btn').click();
    await expect.poll(() => mock.cancelPending()).toBe(true);
    await expect(feedback).toHaveCount(0);
    await expect(page.locator('.stop-btn')).toBeDisabled();
    mock.finishCancel();
    await expect(input).toBeEnabled();
    const cancelFrames = await finishResponseFrames(page);
    expectPinnedFrames(cancelFrames);
    expectScrollStable(cancelFrames, cancelScroll);
    mock.waiting('model', 122000); // deliberately replay an older running status
    await page.locator('.person-header-actions button').first().click();
    await expect(input).toBeEnabled();
    await expect(feedback).toHaveCount(0);
    mock.disconnect();
    await expect(page.locator('.person-connection-notice')).toBeVisible();
    await expect(feedback).toHaveCount(0);
    await page.getByRole('button', { name: zh ? '重连' : 'Reconnect', exact: true }).click();
    await expect(page.locator('.person-connection-notice')).toHaveCount(0);
    await expectAbovePane(page, replySelector('progress-one'));
    await expectReplyGroup(page, 'next-episode-progress', ['next-episode-progress'], { zh, kinds: ['progress'] });
    await expect(feedback).toHaveCount(0);
    await expect(page.locator('.person-messages')).not.toHaveClass(/is-response-pinned/);
    expect(mock.requests.filter(r => r.op === 'send')).toHaveLength(2);
  });
}

for (const scenario of responseScenarios) {
  test(`Digital Person latest wins over pending history ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl }) => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, role: 'assistant', text: `Window item ${i}. ` + 'Readable content. '.repeat(15), createdAt: i + 101 }));
    const older = Array.from({ length: 50 }, (_, i) => ({ id: `old-${i}`, role: 'assistant', text: `Older item ${i}. ` + 'Earlier content. '.repeat(15), createdAt: i + 1 }));
    const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: rows, olderMessages: older });
    await openResponseConversation(page, serverUrl, scenario);
    const pane = page.locator('.person-messages');
    await page.locator('#person-input').fill('Continue after history');
    await page.locator('#person-input').press('Enter');
    mock.reply('new-tail', 'A new tail before history.\n\n'.repeat(50));
    await expect(pane.locator(replySelector('new-tail'))).toBeAttached();
    await pane.hover(); await page.mouse.wheel(0, -100000);
    await expect.poll(() => mock.messageHistoryPending()).toBe(true);
    await page.getByRole('button', { name: '↓ Latest', exact: true }).click();
    await expect(pane.locator(replySelector('new-tail'))).toBeInViewport();
    mock.finishMessageHistory();
    await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
    await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
    mock.reply('new-tail-two', 'More tail evidence.\n\n'.repeat(30));
    await expect(pane.locator(replySelector('new-tail-two'))).toBeAttached();
    await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
  });
}

for (const width of [320]) {
  test(`Digital Person starts at latest, windows long history and prepends on scroll ${width}px`, async ({ page, serverUrl }) => {
    const rows = Array.from({ length: 240 }, (_, i) => ({ id: `message-${i + 101}`, role: 'assistant', text: `Latest window item ${i + 101}. ` + 'Readable content. '.repeat(15), seq: i + 101, createdAt: i + 101 }));
    const older = Array.from({ length: 50 }, (_, i) => ({ id: `old-${i}`, role: 'assistant', text: `Historical item ${i}. ` + 'Earlier content. '.repeat(15), seq: i + 51, createdAt: i + 51 }));
    const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: rows, olderMessages: older });
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => { localStorage.setItem('locale', 'en'); localStorage.setItem('theme', 'dark'); });
    await page.goto(serverUrl);
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    if (width <= 768) await page.locator('.header-sidebar-toggle').click();
    await page.locator('.sidebar-person-trigger:visible').click();
    const pane = page.locator('.person-messages');
    await expect(pane.locator(replySelector('message-340'))).toBeInViewport();
    await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
    expect(await pane.locator('.person-message').count()).toBeLessThan(40);
    expect(mock.requests.filter(row => row.op === 'messages' && row.payload.cursor)).toHaveLength(0);
    await pane.hover(); await page.mouse.wheel(0, -100000);
    await page.waitForTimeout(400);
    await pane.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(() => mock.messageHistoryPending()).toBe(true);
    const before = await pane.locator('article.person-message').evaluateAll(elements => elements.find(el => {
      const pane = el.closest('.person-messages').getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return rect.bottom > pane.top && rect.top < pane.bottom;
    })?.dataset.messageId);
    expect(before).toBeTruthy();
    const anchor = pane.locator(replyArticleSelector(before));
    await expect(anchor).toBeInViewport();
    const topBefore = await anchor.evaluate(el => el.getBoundingClientRect().top);
    await startResponseFrames(page, replySelector(before));
    mock.finishMessageHistory();
    await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
    await expect(anchor).toBeInViewport();
    const frames = await finishResponseFrames(page);
    expect(frames.length).toBeGreaterThanOrEqual(12);
    expect(frames.some(sample => sample.missing), JSON.stringify(frames)).toBe(false);
    const paneTop = await pane.evaluate(el => el.getBoundingClientRect().top + el.clientTop);
    expect(Math.max(...frames.map(sample => Math.abs(sample.top + paneTop - topBefore)))).toBeLessThanOrEqual(2);
    expect(await pane.locator('.person-message').count()).toBeLessThan(40);
    await pane.hover(); await page.mouse.wheel(0, -100000);
    await page.waitForTimeout(400);
    await pane.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(pane).toContainText('Historical item 0');
    // The latest row is virtualized away; navigation must mount it, not query
    // an absent DOM row, and paging must not leave a stale history anchor.
    await page.getByRole('button', { name: '↓ Latest', exact: true }).click();
    await expect(pane.locator(replySelector('message-340'))).toBeInViewport();
    await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
    await page.locator('.person-thoughts-button').click();
    const thoughts = page.locator('#person-thoughts');
    // Journal rows group persisted traces by episode, newest sequence first.
    // Missing trigger evidence is an episode, not a synthetic cancelled row.
    const latest = thoughts.locator('.person-thought').first();
    await expect(latest).toHaveAttribute('data-episode-id', 'script');
    await expect(latest).toHaveAttribute('data-thought-kind', 'episode');
    await expect(latest.locator(':scope > header .person-thought-status')).toHaveText('Activity cancelled');
    await expect(thoughts.locator('.person-thought').nth(1)).toHaveAttribute('data-episode-id', 'episode-1');
    await expect(thoughts.locator('.person-thought').nth(1).locator(':scope > header .person-thought-status')).toHaveText('Adopted');
    await expect.poll(() => thoughts.locator('.person-thought').count()).toBeLessThan(30);
  });
}
