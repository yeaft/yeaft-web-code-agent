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
import { persistYeaftAttachments, projectSessionHistoryAttachments } from '../../../agent/yeaft/attachments.js';
import { readSessionAttachmentChunk } from '../../../agent/yeaft/session-attachment-read.js';

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
  append({ role: 'user', content: 'Legacy prompt without a tool owner', turnId: undefined });
  // Pre-turn-ID rows: their synthetic UI IDs must not create two separate
  // executions or attach either call to the surrounding labelled prompt.
  for (const path of ['old-a.txt', 'old-b.txt']) {
    append({ role: 'assistant', content: '', turnId: undefined, toolCalls: [{ id: path, name: 'Read', input: { file_path: path } }] });
  }
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
    // Register the fixture's Sessions with the real Server, not only Pinia.
    // Ownership-checked read receipts must not manufacture local error rows
    // that change identity across reload and pollute the durable-ID assertion.
    mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [SESSION_A, SESSION_B]
      .map(id => ({ id, name: id, roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test' })) } });
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
        ...row, ...(row.attachments ? { attachments: projectSessionHistoryAttachments(row) } : {}),
        seq: reader.getMessageSeqById(row.id), ts: row.time,
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
  // After reload, wait for initial inventory before installing fixture Sessions;
  // otherwise the in-flight empty catalog can overwrite this seeded snapshot.
  await page.waitForFunction(agentId => {
    const store = window.Pinia?.useChatStore?.();
    return store?.connectionState === 'connected' && store._hasHandledAgentList
      && store._hasHandledYeaftSessionHydrate
      && store.agents.some(agent => agent.id === agentId && agent.online && agent.status === 'ready');
  }, agentId);
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
  // History is still recovered into the transcript model, but cannot open a
  // runtime details dropdown (not even for rows with durable Turn IDs).
  const toggle = page.locator('.yeaft-session-status-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.getByRole('button', { name: 'Tool call details', exact: true })).toHaveCount(0);
  await expect(turn.locator('.tool-line')).toHaveCount(0);
  await expect.poll(() => page.evaluate(({ conversationId, sessionId }) => {
    const tools = (window.Pinia.useChatStore().messagesMap[conversationId] || [])
      .filter(row => row.sessionId === sessionId && row.type === 'tool-use');
    return tools.map(row => row.toolInput.file_path);
  }, { conversationId: CONVERSATION, sessionId: SESSION_A })).toEqual([
    'old-a.txt', 'old-b.txt', ...Array.from({ length: TOOL_COUNT }, (_, index) => `checks/check-${index}.txt`),
  ]);
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
  // Production request action and real relay. A tool-heavy turn can span many
  // bounded disk windows, followed by a resident-gap traversal. Do not rely on
  // MessageList's layout changes to start additional pages for this helper.
  const readState = () => page.evaluate(() => window.Pinia.useChatStore().activeYeaftHistoryState);
  const waitForIdle = async () => {
    await expect.poll(async () => {
      const state = await readState();
      return !!state?.loaded && !state.loading;
    }).toBe(true);
    return readState();
  };
  const nextWork = state => state.serverHasMore !== false
    ? { kind: 'server', beforeSeq: state.serverOldestFetchedSeq ?? state.oldestSeq }
    : state.gapQueue[0];
  let state = await waitForIdle();
  // Each traversal must retire at least one durable seq per request. Two passes
  // (server frontier, then resident gaps) give a finite fixture-derived bound.
  const maxPages = 2 * Math.max(state.latestSeq || 0, state.serverOldestFetchedSeq || 0,
    ...(state.gapQueue || []).map(gap => gap.beforeSeq));
  for (let attempt = 0; attempt <= maxPages; attempt += 1) {
    const detail = JSON.stringify(state);
    expect(state.error, detail).toBeNull();
    expect(state.paginationError || null, detail).toBeNull();
    if (!state.hasMore) return;
    expect(attempt, `History exceeded ${maxPages} descending pages: ${detail}`).toBeLessThan(maxPages);
    const before = nextWork(state);
    expect(Number.isFinite(before?.beforeSeq), detail).toBe(true);
    const started = await page.evaluate(() => window.Pinia.useChatStore().loadMoreYeaftHistory(5));
    expect(started, `History request did not start: ${detail}`).toBe(true);
    state = await waitForIdle();
    if (state.hasMore) {
      const after = nextWork(state);
      if (before.kind === 'gap') expect(after?.kind, JSON.stringify(state)).toBe('gap');
      if (after?.kind === before.kind) {
        expect(after.beforeSeq, `History cursor did not advance: ${JSON.stringify(state)}`).toBeLessThan(before.beforeSeq);
      }
    }
  }
}

async function expectOlderPrompts(page) {
  // Off-screen turns are virtualized; assert all loaded rows in the store rather
  // than requiring the DOM to render twelve distant turns simultaneously.
  await expect.poll(() => page.evaluate(({ conversationId, sessionId }) => (
    window.Pinia.useChatStore().messagesMap[conversationId] || []
  ).filter(row => row.sessionId === sessionId && row.type === 'user').map(row => row.content), {
    conversationId: CONVERSATION, sessionId: SESSION_A,
  })).toEqual([
    'Legacy prompt without a tool owner',
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

test('relays uploaded images directly and rejects missing uploads without a text-only send', async ({ chatPage, mockAgent, persistedHistory }) => {
  const agentId = mockAgent.agentId;
  const capabilities = await chatPage.evaluate(id => window.Pinia.useChatStore().agents
    .find(agent => agent.id === id).capabilities, agentId);
  mockAgent.send({ type: 'agent_capabilities_updated', capabilities: [...capabilities, 'session_attachment_refs'] });
  await chatPage.waitForFunction(id => window.Pinia.useChatStore().agents
    .find(agent => agent.id === id)?.capabilities?.includes('session_attachment_refs'), agentId);

  const previewPath = `/api/yeaft/session-attachments/${encodeURIComponent(agentId)}/${SESSION_B}/`;
  const attachmentGets = [];
  chatPage.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith(previewPath)) {
      attachmentGets.push(url.pathname.slice(previewPath.length) + url.search);
    }
  });
  // Large enough to exceed the Agent's old 8 MiB history queue when encoded.
  const bytes = Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(6 * 1024 * 1024)]);
  const persisted = persistYeaftAttachments([{ name: 'direct-image.png', mimeType: 'image/png', data: bytes.toString('base64') }],
    { yeaftDir: persistedHistory.root, sessionId: SESSION_B }).promptAttachments[0];
  const readAttachment = incoming => {
    const { type, requestId, sessionId, attachmentId, offset } = incoming;
    if (type !== 'session_attachment_read_authorized' || sessionId !== SESSION_B) return;
    mockAgent.send({ type: 'yeaft_session_attachment_chunk', requestId, sessionId, attachmentId, offset,
      ...readSessionAttachmentChunk(incoming, persistedHistory.root) });
  };
  mockAgent._messageHandlers.push(readAttachment);
  await openSession(chatPage, mockAgent.agentId, SESSION_B);
  await expect(chatPage.locator('.assistant-turn')).toContainText('Only Session B answer');
  const upload = await chatPage.evaluate(async png => {
    const blob = await (await fetch(png)).blob();
    const form = new FormData();
    form.append('files', blob, 'direct-image.png');
    const response = await fetch('/api/upload', { method: 'POST', body: form });
    if (!response.ok) throw new Error(`upload ${response.status}`);
    return (await response.json()).files[0];
  }, PNG);
  const send = async (attachment, text) => chatPage.evaluate(({ attachment, text, sessionId, conversationId }) => {
    const store = window.Pinia.useChatStore();
    store.sendYeaftSessionMessage({ groupId: sessionId, text, attachments: [{ ...attachment, isImage: true }] });
    return store.messagesMap[conversationId].filter(m => m.type === 'user').at(-1).clientMessageId;
  }, { attachment, text, sessionId: SESSION_B, conversationId: CONVERSATION });
  await send(upload, 'Inspect the uploaded picture directly');
  const relayed = await mockAgent.waitForMessage('yeaft_session_send');
  expect(relayed.files).toEqual([expect.objectContaining({ name: 'direct-image.png', mimeType: 'image/png', data: PNG.split(',')[1], isImage: true })]);
  expect(relayed.attachments).toBeUndefined();
  // MockAgent replays the accepted row from disk through the real Server's
  // history relay. No inline attachment bytes or browser URLs on the wire.
  const persistedRow = persistedHistory.store.append({
    role: 'user', sessionId: SESSION_B, content: relayed.text, clientMessageId: relayed.id,
    attachments: [
      persisted,
      { ...persisted, name: 'missing-image.png', path: join(persistedHistory.root, 'sessions', SESSION_B, 'attachments', 'absent.png') },
    ],
  });
  const availableId = `${persistedRow.id}.0`;
  const missingId = `${persistedRow.id}.1`;
  await chatPage.evaluate(({ agentId, sessionId }) => {
    const store = window.Pinia.useChatStore();
    const afterSeq = store.activeYeaftHistoryState.latestSeq;
    store.continueYeaftHistoryDelta(sessionId, agentId, afterSeq);
  }, { agentId, sessionId: SESSION_B });
  const message = chatPage.locator('.message.user').filter({ hasText: relayed.text });
  const badge = message.locator('.attachments-badge');
  await expect(badge).toHaveText(/2 image/);
  await expect(badge).toHaveAttribute('aria-expanded', 'false');
  await expect(message.locator('img')).toHaveCount(0);
  expect(attachmentGets).toEqual([]);
  expect(mockAgent.messages('session_attachment_read_authorized')).toHaveLength(0);

  const preview = chatPage.waitForResponse(response => new URL(response.url()).pathname === `${previewPath}${availableId}`);
  await badge.click();
  const previewResponse = await preview;
  expect(previewResponse.status()).toBe(200);
  expect(previewResponse.headers()['content-type']).toBe('image/png');
  const previewBytes = await previewResponse.body();
  expect(previewBytes.length).toBe(bytes.length);
  expect(createHash('sha256').update(previewBytes).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(mockAgent.messages('session_attachment_read_authorized').filter(read => read.attachmentId === availableId)
    .map(read => read.offset)).toEqual(Array.from({ length: 7 }, (_, index) => index * 1024 * 1024));
  const image = message.getByRole('img', { name: 'direct-image.png' });
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(message.getByText('The image preview could not be loaded.')).toBeVisible();
  await expect(message.getByText(relayed.text)).toBeVisible();
  await expect(message.getByRole('button', { name: 'missing-image.png' })).toHaveCount(0);
  expect([...attachmentGets].sort()).toEqual([availableId, missingId]);

  await message.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => attachmentGets.filter(path => path === missingId).length).toBe(2);
  await expect(message.getByText('The image preview could not be loaded.')).toBeVisible();
  await image.click();
  const gallery = chatPage.locator('.image-preview-overlay');
  await expect(gallery.getByRole('img', { name: 'direct-image.png' })).toBeVisible();
  await expect(gallery.locator('.image-preview-next')).toHaveCount(0);
  await chatPage.keyboard.press('Escape');
  await expect(gallery).toHaveCount(0);

  expect(mockAgent.messages('session_attachment_read_authorized').some(request => request.download)).toBe(false);
  const download = chatPage.waitForEvent('download');
  await message.getByRole('link', { name: 'Download' }).first().click();
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toBe('direct-image.png');
  const downloadUrl = new URL(downloaded.url());
  expect(downloadUrl.pathname + downloadUrl.search).toBe(`${previewPath}${availableId}?download=1`);
  expect(await downloaded.failure()).toBeNull();
  expect(mockAgent.messages('session_attachment_read_authorized').filter(request => request.download)
    .map(request => [request.sessionId, request.attachmentId, request.offset])).toEqual(
    Array.from({ length: 7 }, (_, index) => [SESSION_B, availableId, index * 1024 * 1024]));

  // No running VP in the fixture; close the accepted turn so the next send
  // independently exercises rejection cleanup.
  await chatPage.evaluate(() => {
    const store = window.Pinia.useChatStore();
    store.yeaftProcessingSessions = {};
    store.processingConversations = {};
  });
  const rejectedId = await send({ ...upload, fileId: 'expired-image' }, 'Reject an expired image');
  await expect.poll(() => chatPage.evaluate(({ id, conv }) =>
    window.Pinia.useChatStore().messagesMap[conv].find(m => m.clientMessageId === id)?.status,
  { id: rejectedId, conv: CONVERSATION })).toBe('error');
  await expect(chatPage.getByText(/Session message was not sent: an attachment/).first()).toBeVisible();
  expect(mockAgent._messageHistory.filter(msg => msg.type === 'yeaft_session_send')).toHaveLength(1);
  await expect.poll(() => chatPage.evaluate(({ agentId, sessionId }) =>
    !!window.Pinia.useChatStore().yeaftProcessingSessions[`${agentId}\u001f${sessionId}`],
  { agentId: mockAgent.agentId, sessionId: SESSION_B })).toBe(false);
});
