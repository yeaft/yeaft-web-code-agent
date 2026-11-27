import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { clickPersonAction } from '../../helpers/person-actions.js';
import { personRecords } from '../../../test/fixtures/person-records.js';

async function submitPersonDraft(page, scenario) {
  if (scenario.width <= 768) await page.locator('.person-composer .send-btn:not(.stop-btn)').click();
  else await page.locator('#person-input').press('Enter');
}

// Real browser entry + WebSocket framing with an explicit mock Person runtime.
// This is not a model, SQLite or Server authorization integration test.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

async function mockPersonSocket(page, { conversationFlow = false, modelPreferences = false, initialMessages = [], olderMessages = [], personName = 'Ada', agentName = 'Owner Agent A', searchResults } = {}) {
  await page.addInitScript(() => localStorage.setItem('digital-person-ui-enabled-by-agent',
    JSON.stringify({ 'person-a': true, 'person-b': true, 'old-agent': true })));
  const requests = [];
  const messages = initialMessages.map(message => ({ ...message }));
  const agentMessages = new Map([['person-a', messages], ['person-b', []]]);
  let episodeNumber = 0;
  let userNumber = 0;
  const receipts = new Map();
  let activeEpisode = 'live-episode';
  let busy = false;
  let latestEpisode = null;
  let messageHistoryReply;
  let messageHistoryLoaded = false;
  let saveSettings;
  let models = [{ id: 'provider/model-a' }, { id: 'provider/model-b' }];
  let modelSettings = { modelCandidates: [], defaultModel: null };
  let modelReady = true;
  const effectiveCandidates = () => modelSettings.modelCandidates.length ? modelSettings.modelCandidates : models.slice(0, 8).map(model => model.id);
  const agents = [
    { id: 'person-a', name: agentName, online: true, capabilities: ['digital_person'] },
    { id: 'person-b', name: 'Owner Agent B', online: true, capabilities: ['digital_person'] },
    { id: 'old-agent', name: 'Old Agent', online: true, capabilities: [] },
  ];
  await page.routeWebSocket(/.*/, route => {
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
      if (request.op === 'status') {
        reply({ configured: true, renameSupported: true, outputsSupported: true, modelReady,
          reason: modelReady ? '' : 'The requested model or effort is not in the permitted catalog.', models,
          ...(modelPreferences ? { defaultModelSupported: true, ...modelSettings, agentDefaultModel: models[0]?.id || null,
            effectiveModelCandidates: effectiveCandidates(), effectiveDefaultModel: modelSettings.defaultModel || effectiveCandidates()[0] || null } : {}) });
      }
      else if (request.op === 'open') reply({ person: { id: 'person-1' } });
      else if (request.op === 'snapshot') {
        reply({ person: { id: 'person-1', name: request.agentId === 'person-a' ? personName : 'Bea', ...(modelPreferences ? { settings: modelSettings } : {}) }, state: { version: 4, currentEpisodeId: 'episode-1', summary: '' }, messages: agentMessages.get(request.agentId) || [], busy, latestEpisode, episodeId: busy ? activeEpisode : null });
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
        reply({ items: [{ id: 'enhance-turn', seq: 1, kind: 'send', status: 'completed', createdAt: 1, loopCount: 1,
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, complete: true }, models: ['configured/reviewer'],
          calls: [{ callId: 'parent', index: 1, status: 'completed', dispatched: { model: 'configured/reviewer' },
            usage: { inputTokens: 20, outputTokens: 8, complete: true }, capabilities: [{ callId: 'enhance-call', id: 'ResponseEnhance', status: 'completed',
              modelCall: { model: 'configured/reviewer', elapsedMs: 1250, completed: true, usage: { inputTokens: 30, outputTokens: 12, complete: true } } }] }] }], nextCursor: null });
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
      } else if (request.op === 'outputs') {
        reply({ items: [], nextCursor: null });
      } else if (request.op === 'search') {
        reply(searchResults?.(request.payload) ?? { items: [{ id: 'archived', role: 'user', text: 'A message from the durable archive. <img src=x>', createdAt: 1 }], nextCursor: null });
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
        finish();
      }
    });
  });
  return { requests,
    reply(id, text, agentId = 'person-a', episodeId = activeEpisode, metadata = {}) {
      const rows = agentMessages.get(agentId);
      const existing = rows.find(row => row.id === id);
      if (existing) existing.text = text;
      else rows.push({ id, role: 'assistant', text, episodeId, createdAt: new Date(Math.max(Date.now(), ...rows.map(row => new Date(row.createdAt).getTime() + 1))).toISOString(), ...metadata });
    },
  };
}

const previousConversation = [
  { id: 'history-user', role: 'user', text: 'Previous question stays in the transcript.', createdAt: 1 },
  { id: 'history-reply', role: 'assistant', text: 'Previous answer stays in the transcript.\n'.repeat(35), createdAt: 2 },
];
// A group's article and its first section share an ID. Select the section for
// assistant content, or the article for system messages, never both at once.
const replySelector = id => `:is(.person-message:not(:has(.person-reply-part)), .person-reply-part)[data-message-id="${id}"]`;

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

async function expectSessionWidthConversation(page, { width, theme }, testInfo) {
  await page.setViewportSize({ width, height: 800 });
  await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
  const expectSessionWidth = async () => {
    await expect.poll(() => page.evaluate(() => {
      const reading = document.querySelector('.person-reading-column');
      const pane = document.querySelector('.person-messages');
      const composer = document.querySelector('.person-composer');
      const input = composer.querySelector('.input-wrapper');
      const hint = composer.querySelector('.person-inbox-hint');
      const narrow = document.querySelector('#person-conversation').clientWidth <= 768;
      const ratio = narrow ? 1 : parseFloat(getComputedStyle(reading).getPropertyValue('--session-content-width')) / 100;
      const gutter = narrow ? 10 : 16;
      const rect = reading.getBoundingClientRect(), container = pane.getBoundingClientRect();
      const centered = element => {
        const bounds = element.getBoundingClientRect();
        const parent = element.parentElement.getBoundingClientRect();
        return Math.abs(bounds.left + bounds.width / 2 - parent.left - parent.width / 2) <= 1;
      };
      const inputRect = input.getBoundingClientRect();
      const replies = [...reading.querySelectorAll('.person-reply, .person-reply .person-message-text')];
      return Math.abs(rect.width - pane.clientWidth * ratio) <= 1 && centered(reading)
        && Math.abs(parseFloat(getComputedStyle(reading).paddingLeft) - gutter) <= 1
        && Math.abs(inputRect.width - (composer.clientWidth - gutter * 2) * ratio) <= 1 && centered(input)
        && !!hint && centered(hint) && Math.abs(hint.getBoundingClientRect().width - inputRect.width) <= 1
        && replies.length > 0 && replies.every(element => Math.abs(element.getBoundingClientRect().width - rect.width + gutter * 2) <= 1)
        && rect.left >= container.left;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await page.locator('.person-messages').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
    await expectPersonTitleCentered(page);
  };
  await expectSessionWidth();
  // Person follows the same content-width token as Session, with no fixed 880px cap.
  await page.locator('.person-page').evaluate(el => el.style.setProperty('--session-content-width', '80%'));
  await expectSessionWidth();
  await page.locator('.person-page').evaluate(el => el.style.removeProperty('--session-content-width'));
  if (width > 768) {
    for (const action of ['outputs', 'search', 'inside']) {
      await clickPersonAction(page, action);
      const panel = page.locator('#person-side-panel');
      await expect(panel).toHaveAttribute('role', 'complementary');
      await expectSessionWidth();
      expect(await page.locator('.person-reading-column').evaluate(el => el.clientWidth)).toBeGreaterThan(880);
      if (action === 'outputs') {
        const handle = page.getByRole('separator', { name: 'Resize output panel', exact: true });
        await handle.focus();
        await handle.press('ArrowLeft');
        await expectSessionWidth();
        await page.screenshot({ path: testInfo.outputPath(`person-session-width-split-${theme}.png`) });
      }
      await panel.getByRole('button', { name: action === 'outputs' ? 'Close reader' : 'Close', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expectSessionWidth();
    }
  }
  await page.screenshot({ path: testInfo.outputPath(`person-session-width-${width}-${theme}.png`) });
}

// Record every animation frame across wire updates, not just the final layout.
// Reply parts use their article as the stable anchor: appending a later part
// must not move the focus from the first reply to the new part's own top.
// A newly inserted target may need two frames for Vue's patch + scheduled layout.
// Growth and completion of an existing target get no settling allowance.

// An unmounted row is above the reader only when its logical group precedes
// the mounted virtual window. A spacer alone would also accept a missing/below row.

// Traverse the real scroller to mount an archived group. Never use this while
// measuring local response focus or a reader's prepend anchor.

// Delays are authoritative backend timestamps, not a browser-generated timer.
// Only the wire runtime is scripted; rendering, polling, input and scrolling are real.
async function expectPersonFits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.person-header').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

async function expectPersonTitleCentered(page) {
  await expect.poll(() => page.locator('.person-identity h1').evaluate(title => {
    const centerX = el => { const bounds = el.getBoundingClientRect(); return bounds.left + bounds.width / 2; };
    return Math.abs(centerX(title) - centerX(title.closest('#person-conversation')));
  })).toBeLessThanOrEqual(1);
  await expect(page.locator('.person-identity h1')).toHaveCSS('text-align', 'center');
}

async function expectBorderlessPersonAgent(picker) {
  await expect(picker).toHaveCSS('border-top-width', '0px');
  await expect(picker).toHaveCSS('box-shadow', 'none');
}

async function expectInspectorScroller(page) {
  const nav = page.locator('.person-inspector-nav');
  expect(await nav.evaluate(el => getComputedStyle(el).overflowX)).toBe('auto');
  expect(await nav.locator('button').evaluateAll(elements => {
    const tops = elements.map(el => el.getBoundingClientRect().top);
    return Math.max(...tops) - Math.min(...tops);
  })).toBeLessThanOrEqual(1);
  // Keyboard activation must reveal the active item, not rely on a click's
  // implicit scrollIntoView. Reset the scroller after focus to distinguish the
  // component's active-item scrolling from native browser focus scrolling.
  const sections = nav.locator('button');
  await sections.first().focus();
  for (let i = 1; i < await sections.count(); i++) await page.keyboard.press('Tab');
  await nav.evaluate(el => { el.scrollLeft = 0; });
  await page.keyboard.press('Enter');
  await expect(sections.last()).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => sections.last().evaluate(el => {
    const item = el.getBoundingClientRect(), nav = el.parentElement.getBoundingClientRect();
    return item.left >= nav.left - 1 && item.right <= nav.right + 1;
  })).toBe(true);
  // Reopen the first section through the keyboard too; both scroll directions
  // must reveal the active item without introducing a second row.
  await sections.last().focus();
  for (let i = 1; i < await sections.count(); i++) await page.keyboard.press('Shift+Tab');
  await nav.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.keyboard.press('Enter');
  await expect(sections.first()).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => sections.first().evaluate(el => {
    const item = el.getBoundingClientRect(), nav = el.parentElement.getBoundingClientRect();
    return item.left >= nav.left - 1 && item.right <= nav.right + 1;
  })).toBe(true);
}

test('Digital Person shares Session reading gutters, keeps desktop actions and changes sheets at the 600px breakpoint', async ({ page, serverUrl }, testInfo) => {
  test.setTimeout(60000);
  const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: previousConversation });
  await openResponseConversation(page, serverUrl, { width: 1920, theme: 'light' });
  await page.locator('#person-input').fill('Keep the conversation and composer aligned.');
  await submitPersonDraft(page, { width: 1920 });
  await expect(page.locator('.person-inbox-hint')).toBeVisible();
  mock.reply('session-width-answer', '## A clear recommendation\n\nMatch Session reading gutters for the conversation and composer.\n\n- Messages follow the available space.\n- Opening the reader preserves proportional breathing room.', 'person-a', undefined, { replyToMessageIds: ['user-1'], replyKind: 'progress' });
  await expect(page.locator(replySelector('session-width-answer'))).toBeVisible();
  for (const width of [1920, 320]) {
    for (const theme of ['light', 'dark']) await expectSessionWidthConversation(page, { width, theme }, testInfo);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  const picker = page.locator('#person-agent .modern-select-trigger');
  await expectBorderlessPersonAgent(picker);
  await picker.hover();
  await expectBorderlessPersonAgent(picker);
  await picker.click();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await expectBorderlessPersonAgent(picker);
  await picker.press('Escape');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  const more = page.locator('.person-more-button');
  await expect(more).not.toBeVisible();
  for (const action of ['search', 'outputs', 'inside']) {
    await clickPersonAction(page, action);
    const panel = page.locator('#person-side-panel');
    await expect(panel).toHaveAttribute('role', 'complementary');
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.keyboard.press('Escape');
    // A non-modal desktop drawer only handles Escape while focus is inside it.
    await expect(panel).toHaveCount(0);
  }
  await page.setViewportSize({ width: 900, height: 800 });
  await clickPersonAction(page, 'inside');
  await expectInspectorScroller(page);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(more).toBeVisible(); await more.click();
  await expect(page.locator('#person-actions-sheet')).toBeVisible();
  await page.setViewportSize({ width: 601, height: 800 });
  await expect(page.locator('#person-actions-sheet')).not.toBeVisible();
  await expect(more).not.toBeVisible();
  await expect(page.locator('.person-header')).not.toHaveAttribute('inert', '');
  await expect(page.locator('.person-search-button')).toBeVisible();
  await expect(page.locator('#person-input')).toBeEnabled();
  await expectPersonFits(page);
});

test('Digital Person search previews keep deep matches visible and preserve rich messages and paging', async ({ page, serverUrl }, testInfo) => {
  // Exercise the non-native grapheme segmentation path in the actual bundle.
  await page.addInitScript(() => Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true }));
  const keyword = '部署策略';
  const longPhrase = '接口变更顺序'.repeat(8);
  const emoji = '👍🏽';
  const leadingContext = `${emoji}${'x'.repeat(19)}<img src=x> `;
  const oversizedPhrase = '数据库迁移发布方案'.repeat(20);
  const longContext = '这段很长的前文不应该把搜索词挤出结果。'.repeat(6);
  const text = `Hidden beginning. ${'A long archived paragraph that should not fill the result.\n'.repeat(25)}${leadingContext}${keyword} ${'随后说明'.repeat(60)} Hidden ending.`;
  const pages = [
    { items: [{ id: 'deep', role: 'assistant', text, createdAt: 2,
      presentation: { version: 1, title: 'Archived report', summary: text, blocks: [{ type: 'markdown', text: 'Full report detail' }] } }], nextCursor: 'page-two' },
    { items: [{ id: 'short', role: 'user', text: keyword + ' update', createdAt: 1 }], nextCursor: null },
  ];
  const mock = await mockPersonSocket(page, { conversationFlow: true, initialMessages: previousConversation,
    searchResults: ({ query, cursor }) => query === keyword ? pages[cursor == null ? 0 : 1] : {
      items: [1, 2].map(id => ({ id: `phrase-${id}`, role: 'user', text: `${longContext} ${query} 后续内容`, createdAt: id })), nextCursor: null,
    },
  });
  await openResponseConversation(page, serverUrl, { width: 1280, theme: 'light' });
  for (const [width, theme] of [[1280, 'light'], [320, 'dark']]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await clickPersonAction(page, 'search');
    const input = page.locator('.person-search-form input');
    await input.fill(keyword); await input.press('Enter');
    const results = page.locator('.person-search-result');
    const first = results.first();
    const preview = first.locator('.person-search-snippet');
    await expect(preview).toHaveText(/^…👍🏽x+<img src=x> 部署策略 .*…$/s);
    await expect(preview).not.toContainText('Hidden beginning');
    await expect(preview).not.toContainText('Hidden ending');
    await expect(preview.locator('img')).toHaveCount(0);
    await expect(preview.locator('mark')).toHaveText(keyword);
    const measure = el => {
      const style = getComputedStyle(el), line = parseFloat(style.lineHeight), rect = el.getBoundingClientRect();
      const hit = el.querySelector('mark').getBoundingClientRect();
      return { lines: Math.round(rect.height / line), maxLines: Number(style.webkitLineClamp),
        showsHit: hit.top < rect.bottom, fullHit: hit.bottom <= rect.bottom + 1 };
    };
    expect(await preview.evaluate(measure)).toEqual({ lines: 5, maxLines: 5, showsHit: true, fullHit: true });
    await expect(first.locator('.response-presentation')).toHaveCount(0);
    await expectPersonFits(page);
    await page.screenshot({ path: testInfo.outputPath(`person-search-${width}-${theme}.png`) });
    const details = first.getByRole('button', { name: 'View full message' });
    await details.focus(); await page.keyboard.press('Enter');
    await expect(first.getByRole('button', { name: 'Hide full message' })).toHaveAttribute('aria-expanded', 'true');
    await expect(first.locator('.response-presentation')).toContainText('Full report detail');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(results).toHaveCount(2);
    await expect(first.locator('.response-presentation')).toContainText('Full report detail');
    await first.getByRole('button', { name: 'Hide full message' }).click();
    await expect(first.locator('.response-presentation')).toHaveCount(0);
    expect(await preview.evaluate(measure)).toEqual({ lines: 3, maxLines: 3, showsHit: true, fullHit: true });
    await expect(results.last().locator('.person-search-snippet')).toHaveText(keyword + ' update');
    await expect(results.last().locator('mark')).toHaveText(keyword);
    expect(mock.requests.filter(r => r.op === 'search').at(-1).payload).toMatchObject({ query: keyword, cursor: 'page-two' });
    await page.screenshot({ path: testInfo.outputPath(`person-search-multiple-${width}-${theme}.png`) });
    if (width === 320) {
      // A pasted CJK phrase fits once the leading prose yields its line budget.
      await input.fill(longPhrase); await input.press('Enter');
      await expect(results).toHaveCount(2);
      await expect(preview.locator('mark')).toHaveText(longPhrase);
      expect(await preview.evaluate(measure)).toEqual({ lines: 3, maxLines: 3, showsHit: true, fullHit: true });
      // For a phrase longer than the entire card, show its highlighted start and
      // keep the exact original content accessible without expanding its sibling.
      await input.fill(oversizedPhrase); await input.press('Enter');
      await expect(preview.locator('mark')).toHaveText(oversizedPhrase);
      expect(await preview.evaluate(measure)).toEqual({ lines: 3, maxLines: 3, showsHit: true, fullHit: false });
      await expectPersonFits(page);
      await first.getByRole('button', { name: 'View full message' }).click();
      await expect(first.locator('.person-prose')).toHaveText(`${longContext} ${oversizedPhrase} 后续内容`);
      await expect(results.last().getByRole('button', { name: 'View full message' })).toHaveAttribute('aria-expanded', 'false');
    }
    await page.locator('.person-panel-header .header-action-btn').click();
    await expect(page.locator('#person-side-panel')).toHaveCount(0);
  }
});
