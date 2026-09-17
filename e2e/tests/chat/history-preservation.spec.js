/**
 * Chromium + test Server relay + on-disk ConversationStore regression.
 * Only Session catalog/runtime metadata is stubbed. Each history response uses
 * a fresh disk reader, never a complete hand-made replay. No live Agent/LLM.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { test as base } from '../../fixtures/test-server.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';

const SESSION_A = 'fold-history-A';
const SESSION_B = 'fold-history-B';
const TURN = 'long-tool-turn';
const CONVERSATION = 'fold-history-conversation';
const TOOL_COUNT = 120;
const OLDER_TURNS = 12;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function seedHistory(root) {
  const store = new ConversationStore(root);
  let clock = Date.UTC(2026, 8, 17);
  const append = message => store.append({
    sessionId: SESSION_A, speakerVpId: 'omni', turnId: TURN,
    time: new Date(clock += 1000).toISOString(), ...message,
  });
  for (let index = 0; index < OLDER_TURNS; index += 1) {
    append({ role: 'user', content: `Older prompt ${index}`, turnId: `older-${index}` });
    append({ role: 'assistant', content: `Older answer ${index}`, turnId: `older-${index}`, responseKind: 'result' });
  }
  append({ role: 'user', content: 'Run all 120 checks and keep the screenshots' });
  const folds = [];
  for (let batch = 0; batch < 6; batch += 1) {
    const rows = [append({
      role: 'assistant', content: `Checkpoint ${batch + 1}: checks ${batch * 20 + 1}–${(batch + 1) * 20}`,
      responseKind: 'progress',
      ...(batch === 0 ? { images: [{
        assetId: createHash('sha256').update(Buffer.from(PNG.split(',')[1], 'base64')).digest('hex'), sourceToolCallId: 'check-0', sourceImageIndex: 0,
        filename: 'folded-check.png', mimeType: 'image/png', src: PNG,
      }] } : {}),
    })];
    for (let index = batch * 20; index < (batch + 1) * 20; index += 1) {
      rows.push(append({ role: 'assistant', content: '', toolCalls: [{
        id: `check-${index}`, name: 'FileRead', input: { file_path: `checks/check-${index}.txt` },
      }] }));
      rows.push(append({ role: 'tool', toolCallId: `check-${index}`, content: `Check ${index} passed` }));
    }
    folds.push(store.foldMessages(rows, {
      role: 'user', content: `Internal fold ${batch + 1}`, _reflection: true,
      sessionId: SESSION_A, speakerVpId: 'omni', turnId: TURN,
    }));
  }
  append({ role: 'assistant', content: 'All 120 checks passed; screenshot retained.', responseKind: 'result' });
  append({ sessionId: SESSION_B, turnId: 'other-turn', role: 'user', content: 'Only Session B prompt' });
  append({ sessionId: SESSION_B, turnId: 'other-turn', role: 'assistant', content: 'Only Session B answer', responseKind: 'result' });
  return { folds, store };
}

const test = base.extend({
  persistedHistory: [async ({ mockAgent }, use) => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-e2e-fold-history-'));
    const { folds, store } = seedHistory(root);
    // Server intentionally replaces pending transcript images with confirmed,
    // owner-scoped assets. Exercise its real upload/ack and authenticated URL.
    mockAgent.send({
      type: 'yeaft_asset_put', deliveryId: 'folded-image-delivery',
      conversationId: CONVERSATION, sessionId: SESSION_A, turnId: TURN,
      vpId: 'omni', sourceToolCallId: 'check-0', sourceImageIndex: 0,
      image: { assetId: createHash('sha256').update(Buffer.from(PNG.split(',')[1], 'base64')).digest('hex'), filename: 'folded-check.png', mimeType: 'image/png',
        previewData: { data: PNG.split(',')[1], mimeType: 'image/png' } },
    });
    const assetAck = await mockAgent.waitForMessage('yeaft_asset_ack');
    expect(assetAck, JSON.stringify(assetAck)).toMatchObject({ ok: true });
    const responses = [];
    const handler = request => {
      if (!['yeaft_load_history', 'yeaft_load_more_history'].includes(request.type)
          || ![SESSION_A, SESSION_B].includes(request.sessionId)
          || request.limit === 0) return;
      // Reopen to exercise durable index/segment replay rather than writer state.
      const reader = new ConversationStore(root);
      const metadata = reader.getSessionHistoryMetadata(request.sessionId);
      const older = request.type === 'yeaft_load_more_history';
      const identityMatches = !request.streamId || (
        request.streamId === metadata.streamId && request.revision === metadata.revision
      );
      const delta = !older && identityMatches && Number.isFinite(request.afterSeq);
      const turns = older ? request.turns : (request.limit ?? 10);
      const page = delta
        ? reader.loadAfterSeqByGroup(request.sessionId, request.afterSeq)
        : reader.loadVisibleBySession(request.sessionId, older ? request.beforeSeq : null, turns,
          { stopAtSeq: request.gapStopAtSeq });
      const messages = page.messages.map(row => ({
        ...row, seq: reader.getMessageSeqById(row.id), ts: row.time,
        threadId: row.threadId || row.turnId || 'main',
      }));
      const response = {
        type: 'yeaft_history_chunk', conversationId: CONVERSATION,
        sessionId: request.sessionId, requestId: request.requestId,
        ...(request._requestClientId ? { _requestClientId: request._requestClientId } : {}),
        mode: delta ? 'delta' : older ? 'older' : 'recent',
        messages, oldestSeq: page.oldestSeq ?? null,
        nextBeforeSeq: page.nextBeforeSeq ?? page.oldestSeq ?? null,
        hasMore: !!page.hasMore, hasMoreAfter: !!page.hasMoreAfter,
        latestSeq: page.latestSeq ?? messages.at(-1)?.seq ?? null,
        afterSeq: delta ? request.afterSeq : null,
        streamId: metadata.streamId, revision: metadata.revision, turns,
        pageKind: request.pageKind, gapStopAtSeq: request.gapStopAtSeq, cacheEpoch: request.cacheEpoch,
      };
      responses.push(response);
      mockAgent.send(response);
    };
    mockAgent._messageHandlers.push(handler);
    try {
      await use({ root, store, folds, responses });
    } finally {
      mockAgent._messageHandlers = mockAgent._messageHandlers.filter(item => item !== handler);
      rmSync(root, { recursive: true, force: true });
    }
  }, { auto: true }],
});

// Give the test Agent the same durable owner as the local browser so asset
// confirmation and authenticated asset reads use the production ownership path.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

async function openSession(page, agentId, sessionId = SESSION_A) {
  await page.waitForFunction(() => window.Pinia?.useChatStore?.()?.connectionState === 'connected');
  await page.evaluate(({ agentId, sessionId, conversationId, sessionIds }) => {
    const store = window.Pinia.useChatStore();
    window.Pinia.useSessionsStore().applySnapshot(sessionIds.map(id => ({
      id, name: id, roster: ['omni'], defaultVpId: 'omni',
    })), agentId);
    store.currentAgent = agentId;
    store._hasHandledAgentList = true;
    store._hasHandledYeaftSessionHydrate = true;
    store.yeaftSessionHydrateError = null;
    store.yeaftHistoryLoadError = null;
    store.yeaftConversationId = conversationId;
    store.yeaftConversationIdsByAgent = { [agentId]: conversationId };
    store.currentView = 'yeaft';
    store.setActiveSessionFilter(sessionId, { agentId, force: true });
  }, { agentId, sessionId, conversationId: CONVERSATION, sessionIds: [SESSION_A, SESSION_B] });
}

async function expectLongTurn(page) {
  // A long turn itself can span bounded disk windows. Finish real pagination
  // before asserting complete replay; never replace it with synthetic rows.
  await loadAllOlder(page);
  // Revision replacement can preserve a top-of-list scroll anchor. Bring the
  // last (long) turn into the virtualized viewport before checking its DOM.
  await page.locator('.chat-container').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const turn = page.locator(`.turn-message-block[data-turn-id="${TURN}"]`);
  await expect(turn).toHaveCount(1);
  await expect(turn).toContainText('All 120 checks passed; screenshot retained.');
  await expect(turn.locator('.turn-response-progress')).toHaveCount(6);
  for (let batch = 1; batch <= 6; batch += 1) {
    await expect(turn.locator('.turn-response-progress').nth(batch - 1)).toContainText(`Checkpoint ${batch}:`);
  }
  // Tool groups may retain expansion after pagination, but remount on switching.
  if (await turn.locator('.tool-line').count() < TOOL_COUNT) await turn.locator('.turn-expand-btn').click();
  await expect(turn.locator('.tool-line')).toHaveCount(TOOL_COUNT);
  for (const [line, filename] of [[turn.locator('.tool-line').first(), 'check-0.txt'], [turn.locator('.tool-line').last(), 'check-119.txt']]) {
    if (!await line.evaluate(element => element.classList.contains('expanded'))) await line.click();
    await expect(line.locator('..').locator('.tool-expand')).toContainText(filename);
  }
  await expect.poll(() => page.evaluate(conversationId => (
    window.Pinia.useChatStore().messagesMap[conversationId] || []
  ).filter(row => row.type === 'chat-image').map(row => ({ filename: row.filename, src: row.src })), CONVERSATION)).toEqual([
    { filename: 'folded-check.png', src: expect.stringMatching(/^\/api\/yeaft\/assets\//) },
  ]);
  const image = turn.getByRole('img', { name: 'folded-check.png', exact: true });
  await expect(image).toHaveCount(1);
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByText('Internal fold', { exact: false })).toHaveCount(0);
}

async function loadAllOlder(page) {
  // Production request action, real relay and real turn-boundary cursors.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await expect.poll(() => page.evaluate(() => Object.values(window.Pinia.useChatStore().yeaftSessionHistoryState).every(state => !state.loading))).toBe(true);
    const started = await page.evaluate(() => window.Pinia.useChatStore().loadMoreYeaftHistory(5));
    if (!started) return;
    await expect.poll(() => page.evaluate(() => Object.values(window.Pinia.useChatStore().yeaftSessionHistoryState).every(state => !state.loading))).toBe(true);
  }
  throw new Error('Older history did not finish within ten pages');
}

async function expectOlderPrompts(page) {
  // Off-screen turns are virtualized; assert all loaded rows in the store rather
  // than requiring the DOM to render twelve distant turns simultaneously.
  await expect.poll(() => page.evaluate(({ conversationId, sessionId }) => (
    window.Pinia.useChatStore().messagesMap[conversationId] || []
  ).filter(row => row.sessionId === sessionId && row.type === 'user').map(row => row.content), {
    conversationId: CONVERSATION, sessionId: SESSION_A,
  })).toEqual([
    ...Array.from({ length: OLDER_TURNS }, (_, index) => `Older prompt ${index}`),
    'Run all 120 checks and keep the screenshots',
  ]);
}

async function durableIds(page) {
  return page.evaluate(({ conversationId, sessionId }) => (
    window.Pinia.useChatStore().messagesMap[conversationId] || []
  ).filter(row => row.sessionId === sessionId).map(row => row.id).sort(), {
    conversationId: CONVERSATION, sessionId: SESSION_A,
  });
}

test('preserves 120 folded tools, progress and image through Session switches and page.reload', async ({ chatPage, mockAgent, persistedHistory }) => {
  test.setTimeout(60000);
  expect(persistedHistory.folds).toHaveLength(6);
  expect(persistedHistory.folds.every(row => row?.foldedMessageIds.length === 41)).toBe(true);
  await openSession(chatPage, mockAgent.agentId);
  await expectLongTurn(chatPage);
  for (const [theme, width] of [['light', 1280], ['dark', 320]]) {
    await chatPage.setViewportSize({ width, height: 800 });
    await chatPage.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await openSession(chatPage, mockAgent.agentId, SESSION_B);
    await expect(chatPage.locator('.assistant-turn')).toContainText('Only Session B answer');
    await expect(chatPage.locator(`.turn-message-block[data-turn-id="${TURN}"]`)).toHaveCount(0);
    await openSession(chatPage, mockAgent.agentId);
    await expectLongTurn(chatPage);
    await expect(chatPage.getByText('Only Session B answer', { exact: true })).toHaveCount(0);
  }
  await expectOlderPrompts(chatPage);
  const beforeReloadIds = await durableIds(chatPage);
  const beforeReload = persistedHistory.responses.length;
  await chatPage.reload();
  await openSession(chatPage, mockAgent.agentId);
  await expectLongTurn(chatPage);
  await expectOlderPrompts(chatPage);
  expect(await durableIds(chatPage)).toEqual(beforeReloadIds);
  expect(persistedHistory.responses.slice(beforeReload).some(response => (
    response.sessionId === SESSION_A && response.mode === 'recent'
  ))).toBe(true);
});

test('recovers the same complete transcript by pagination after a real fold revision reset', async ({ chatPage, mockAgent, persistedHistory }) => {
  test.setTimeout(60000);
  await openSession(chatPage, mockAgent.agentId);
  await expectLongTurn(chatPage);
  await expectOlderPrompts(chatPage);
  const before = await durableIds(chatPage);
  expect(new Set(before).size).toBe(before.length);
  const oldMetadata = persistedHistory.store.getSessionHistoryMetadata(SESSION_A);
  // Recursive folding is a real revision mutation, not a fabricated wire value.
  // It changes model context again but must not change the visible transcript.
  persistedHistory.store.foldMessages(persistedHistory.folds, {
    role: 'user', content: 'Internal recursive fold', _reflection: true,
    sessionId: SESSION_A, speakerVpId: 'omni', turnId: TURN,
  });
  const metadata = new ConversationStore(persistedHistory.root).getSessionHistoryMetadata(SESSION_A);
  expect(metadata.streamId).toBe(oldMetadata.streamId);
  expect(metadata.revision).toBeGreaterThan(oldMetadata.revision);
  const responseCount = persistedHistory.responses.length;
  await chatPage.evaluate(({ agentId, sessionId }) => {
    const store = window.Pinia.useChatStore();
    const previous = Object.values(store.yeaftSessionHistoryState).find(state => state.streamId);
    const request = store.beginYeaftHistoryLoad({
      agentId, sessionId, mode: 'delta', preserveLoaded: true, latestSeq: previous.latestSeq,
    });
    store.sendWsMessage({
      type: 'yeaft_load_history', agentId, sessionId, requestId: request.requestId,
      afterSeq: previous.latestSeq, streamId: previous.streamId, revision: previous.revision, limit: 10,
    });
  }, { agentId: mockAgent.agentId, sessionId: SESSION_A });
  await expect.poll(() => persistedHistory.responses.length).toBeGreaterThan(responseCount);
  // The client may already have requested an automatic gap page by this point.
  expect(persistedHistory.responses[responseCount]).toMatchObject({ mode: 'recent', revision: metadata.revision, hasMore: true });
  // A reset may begin with the recent window; paging must recover everything.
  await expectLongTurn(chatPage);
  await expectOlderPrompts(chatPage);
  expect(await durableIds(chatPage)).toEqual(before);
  const resetPages = persistedHistory.responses.slice(responseCount);
  expect(resetPages.some(response => response.mode === 'older' && response.revision === metadata.revision)).toBe(true);
  expect(resetPages.at(-1).hasMore).toBe(false);
});
