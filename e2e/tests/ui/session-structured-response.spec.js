import { expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../../fixtures/test-server.js';
import ctx from '../../../agent/context.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { __testHandleEngineEvent, __testHooks, __testSetSession } from '../../../agent/yeaft/web-bridge.js';

// Production browser + server relay + real Engine/tool/strict storage/bridge.
// Only provider inference and Agent registration/catalog are scripted.
test.use({ serverEnv: { SERVE_DIST: 'true', YEAFT_LOCAL_RUN: 'true' } });
test('native Session rich delivery stays nonterminal, deduplicates and replays with ordinary prose', async ({ chatPage: page, mockAgent }, info) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'session-rich-response-'));
  const previous = { ws: ctx.ws, CONFIG: ctx.CONFIG, sessionKey: ctx.sessionKey, serverEncryptionRequired: ctx.serverEncryptionRequired };
  ctx.ws = mockAgent.ws; ctx.CONFIG = { yeaftDir: dir, workDir: dir };
  ctx.sessionKey = null; ctx.serverEncryptionRequired = false;
  const session = { id: 'rich-session', name: 'Structured Session', roster: ['rich-vp'], defaultVpId: 'rich-vp', workDir: dir };
  const store = new ConversationStore(dir);
  const input = { title: 'Verified delivery', summary: 'Reuse the shared renderer.', phase: 'final', blocks: [
    { type: 'cards', items: [{ title: 'Reuse', label: 'Recommended', text: 'One renderer for both runtimes.',
      image: { url: 'https://example.test/team-logo.png', alt: 'Supplied team logo', fit: 'contain' }, url: 'https://example.test/card-source' }] },
    { type: 'map', title: 'Verified location', points: [{ label: 'Beijing', latitude: 39.9075, longitude: 116.39723 }], embed: { provider: 'openstreetmap' } },
    { type: 'chart', style: 'bar', labels: ['A', 'B'], series: [{ label: 'Fixture checks', values: [2, 3] }] },
    { type: 'link', url: 'https://example.test/report', text: 'Source report' },
    { type: 'markdown', text: '[Related source](https://example.test/related)' },
  ] };
  let calls = 0, resume;
  const boundary = new Promise(resolve => { resume = resolve; });
  const adapter = { async *stream() {
    if (++calls === 1) {
      yield { type: 'tool_call', id: 'rich-call', name: 'PresentResponse', input };
      yield { type: 'stop', stopReason: 'tool_use' };
    } else {
      await boundary;
      yield { type: 'stop', stopReason: 'end_turn' };
    }
  } };
  const engine = new Engine({ adapter, trace: new NullTrace(), config: { model: 'test-model', maxOutputTokens: 1024, maxRetries: 0 },
    conversationStore: store, toolRegistry: createFullRegistry(), yeaftDir: dir, vpId: 'rich-vp' });
  const history = request => {
    const rows = __testHooks.projectVisibleHistoryChunkMessages(store.loadVisibleBySession(session.id, Infinity, 100).messages);
    const metadata = { sessionId: session.id, requestId: request.requestId, oldestSeq: rows[0]?.seq, latestSeq: rows.at(-1)?.seq, hasMore: false, mode: 'recent' };
    mockAgent.send({ type: 'yeaft_history_chunk', ...metadata, messages: rows });
    mockAgent.send({ type: 'yeaft_output', event: { type: 'history_loaded', ...metadata, count: rows.length } });
  };
  const listener = request => { if (request.type === 'yeaft_load_history' && request.sessionId === session.id) history(request); };
  mockAgent._messageHandlers.push(listener);
  const open = async () => {
    mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [session] } });
    await expect.poll(() => page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sessionCatalog.some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId), { agentId: mockAgent.agentId, sessionId: session.id })).toBe(true);
    await page.evaluate(({ agentId, sessionId }) => {
      const chat = window.Pinia.useChatStore();
      chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
      chat.sessionSidebarOpen = false;
    }, { agentId: mockAgent.agentId, sessionId: session.id });
    await expect.poll(() => mockAgent._messageHistory.filter(row => row.type === 'yeaft_load_history' && row.sessionId === session.id).length).toBeGreaterThan(0);
  };
  let running;
  try {
    await page.context().route('https://example.test/**', route => route.request().url().endsWith('.png')
      ? route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') })
      : route.fulfill({ contentType: 'text/html', body: '<h1>Embedded evidence fixture</h1>' }));
    await page.context().route('https://www.openstreetmap.org/export/embed.html?**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Official map embed fixture</h1>' }));
    await open();
    const hctx = { sessionId: session.id, vpId: 'rich-vp', turnId: 'rich-turn', threadId: 'main', resetQueryTimer() {},
      assistantTextParts: [], toolCallsAccum: [], toolResultsAccum: [], thinkingBlocksAccum: [] };
    mockAgent.send({ type: 'yeaft_output', sessionId: session.id, vpId: 'rich-vp', turnId: 'rich-turn', event: { type: 'vp_turn_start', sessionId: session.id, vpId: 'rich-vp', turnId: 'rich-turn', threadId: 'main' } });
    running = (async () => {
      for await (const event of engine.query({ prompt: 'Show the verified results', sessionId: session.id, vpTurnId: 'rich-turn', threadId: 'main' })) {
        __testHandleEngineEvent(event, hctx);
        // Duplicate transport/event delivery must not create a second visible reply.
        if (event.type === 'response_presentation') __testHandleEngineEvent(event, hctx);
      }
    })();
    await expect(page.locator('.assistant-turn .response-presentation')).toHaveCount(1);
    await expect(page.locator('.response-cards')).toContainText('One renderer for both runtimes.');
    await expect(page.locator('.response-chart svg')).toBeVisible();
    await expect(page.getByAltText('Supplied team logo')).toBeVisible();
    await expect(page.locator('.response-map iframe')).toHaveAttribute('src', /\/export\/embed\.html\?/);
    const storedMedia = store.loadAllBySession(session.id).find(row => row.presentation).presentation.blocks;
    expect(storedMedia[0].items[0].image.fit).toBe('contain');
    expect(storedMedia[1].embed.provider).toBe('openstreetmap');
    expect(store.loadAllBySession(session.id).find(row => row.presentation).responseKind).toBe('progress');
    await page.getByRole('link', { name: 'View source', exact: true }).click();
    await expect(page.locator('.workbench-panel .browser-frame')).toHaveAttribute('src', 'https://example.test/card-source');
    await page.locator('.workbench-panel-close').click();
    await page.locator('a.response-link').click();
    await expect(page.locator('.workbench-panel .browser-frame')).toHaveAttribute('src', 'https://example.test/report');
    expect(page.context().pages()).toHaveLength(1);
    await page.locator('.response-markdown a:not([data-response-external])').click();
    await expect(page.locator('.workbench-panel .browser-frame')).toHaveAttribute('src', 'https://example.test/related');
    await page.locator('.workbench-panel-close').click();
    const popupPromise = page.waitForEvent('popup');
    await page.locator('.response-link-row [data-response-external]').click();
    const popup = await popupPromise; await popup.waitForLoadState();
    expect(popup.url()).toBe('https://example.test/report'); await popup.close();
    resume(); await running;
    expect(calls).toBe(2);
    expect(store.loadAllBySession(session.id).filter(row => row.presentation)).toHaveLength(1);
    expect(store.loadAllBySession(session.id).find(row => row.presentation).responseKind).toBe('result');
    await page.screenshot({ path: info.outputPath('session-rich-live.png'), fullPage: true });
    // Ordinary persisted replies use the original text path, alongside the rich delivery.
    store.append({ role: 'user', sessionId: session.id, content: 'A follow-up question' });
    store.append({ role: 'assistant', sessionId: session.id, speakerVpId: 'rich-vp', threadId: 'main', turnId: 'plain-turn', content: 'An ordinary text answer still works.' });
    await page.reload();
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(row => row.id === id && row.status === 'ready'), mockAgent.agentId);
    await open();
    await expect(page.locator('.assistant-turn .response-presentation')).toHaveCount(1);
    await expect(page.locator('.response-summary')).toHaveText(input.summary);
    await expect(page.getByAltText('Supplied team logo')).toBeVisible();
    await expect(page.locator('.response-map iframe')).toHaveAttribute('src', /marker=39\.9075%2C116\.39723/);
    await expect(page.locator('.assistant-turn', { hasText: 'An ordinary text answer still works.' })).toBeVisible();
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.setViewportSize({ width: 320, height: 800 });
    await page.evaluate(() => window.Pinia.useChatStore().closeSessionSidebar());
    // Wait for the responsive sidebar transition before judging the real layout.
    await expect.poll(() => page.locator('.yeaft-sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    await expect.poll(() => page.locator('.response-presentation').evaluate(el => {
      const { left, right, width } = el.getBoundingClientRect();
      return left >= 0 && right <= innerWidth && width >= 250;
    })).toBe(true);
    await page.locator('.response-summary').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('session-rich-replay-mobile.png'), fullPage: true });
    expect(calls).toBe(2);
  } finally {
    resume(); await running;
    mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
    __testSetSession(null);
    Object.assign(ctx, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
