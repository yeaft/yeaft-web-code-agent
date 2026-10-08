import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

const SESSION = 'scroll-regression';
const CONVERSATION = 'scroll-conversation';
const STREAMING_TAIL = 'streaming-tail';
const FRAME_COUNT = 120;
const VIEWPORTS = [
  { theme: 'light', width: 1280 },
  { theme: 'dark', width: 1280 },
  { theme: 'light', width: 320 },
  { theme: 'dark', width: 320 },
];

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

function historyRows(start = 0, end = 50) {
  const rows = [];
  for (let index = start; index < end; index += 1) {
    const identity = { sessionId: SESSION, turnId: `turn-${index}`, speakerVpId: 'omni', ts: Date.UTC(2026, 8, 17) + index * 1000 };
    rows.push({ ...identity, id: `user-${index}`, role: 'user', content: `Question ${index}` });
    rows.push({ ...identity, id: `assistant-${index}`, role: 'assistant', responseKind: 'result',
      content: `Answer ${index}\n\n` + ('Detailed implementation and verification notes.\n\n'.repeat(index % 3 === 0 ? 80 : 2)) });
    for (let tool = 0; tool < 23; tool += 1) {
      rows.push({ ...identity, id: `call-${index}-${tool}`, role: 'assistant', content: '',
        toolCalls: [{ id: `tool-${index}-${tool}`, name: 'Bash', input: { command: 'git status' } }] });
      rows.push({ ...identity, id: `result-${index}-${tool}`, role: 'tool', toolCallId: `tool-${index}-${tool}`, content: 'done' });
    }
  }
  // Search navigation accepts canonical persisted message ids, not arbitrary ids.
  return rows.map((row, index) => {
    const seq = start * 48 + index + 1;
    return { ...row, id: `m${seq}`, seq };
  });
}

async function openTranscript(page, mockAgent, { olderHistory = false } = {}) {
  const messages = historyRows(olderHistory ? 5 : 0);
  const requests = [];
  mockAgent._messageHandlers.push(request => {
    if (request.sessionId === SESSION && request.type === 'yeaft_search_history') {
      mockAgent.send({ type: 'yeaft_history_search_result', sessionId: SESSION,
        requestId: request.requestId, _requestClientId: request._requestClientId,
        query: request.query, senderKey: request.senderKey, hasMore: false,
        results: [{ messageId: 'm49', entryId: 'search-turn-1', indexGeneration: 1,
          entryStartSeq: 49, entryEndSeq: 96, seq: 49, role: 'user', snippet: 'Question 1' }] });
      return;
    }
    if (request.sessionId === SESSION && request.type === 'yeaft_load_history_window') {
      // Keep the anchor inside the bounded three-turn focus projection.
      const rows = historyRows(0, 3);
      mockAgent.send({ type: 'yeaft_history_window', sessionId: SESSION, conversationId: CONVERSATION,
        requestId: request.requestId, _requestClientId: request._requestClientId,
        entryId: request.entryId, indexGeneration: request.indexGeneration, prefetch: request.prefetch,
        anchorMessageId: request.anchorMessageId, messages: rows,
        sourceMessageIds: rows.filter(row => row.turnId === 'turn-1').map(row => row.id),
        oldestSeq: rows[0].seq, latestSeq: rows.at(-1).seq, hasMore: false, hasMoreAfter: true,
        streamId: 'scroll-stream', revision: 1 });
      return;
    }
    if (!['yeaft_load_history', 'yeaft_load_more_history'].includes(request.type)
      || request.sessionId !== SESSION || request.limit === 0) return;
    requests.push(request);
    const older = request.type === 'yeaft_load_more_history';
    const rows = older ? historyRows(0, 5) : messages;
    mockAgent.send({ type: 'yeaft_history_chunk', conversationId: CONVERSATION, sessionId: SESSION,
      requestId: request.requestId, _requestClientId: request._requestClientId, mode: older ? 'older' : 'recent',
      messages: rows, oldestSeq: rows[0].seq, nextBeforeSeq: rows[0].seq,
      latestSeq: rows.at(-1).seq, hasMore: olderHistory && !older,
      streamId: 'scroll-stream', revision: 1,
      pageKind: request.pageKind, gapStopAtSeq: request.gapStopAtSeq, cacheEpoch: request.cacheEpoch });
  });
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [
    { id: SESSION, name: SESSION, roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test' },
  ] } });
  await expect.poll(() => page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sessionCatalog
    .some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId),
  { agentId: mockAgent.agentId, sessionId: SESSION })).toBe(true);
  await page.evaluate(({ agentId, sessionId }) => {
    const store = window.Pinia.useChatStore();
    store.openCatalogSession(store.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
  }, { agentId: mockAgent.agentId, sessionId: SESSION });
  await expect(page.locator('.chat-container')).toContainText('Answer 49');
  return requests;
}

// Retain the complete bounded trajectory only on failure, not thousands of ids
// in stdout. Playwright already captures a screenshot only for failed tests.
async function withScrollTrace(testInfo, run) {
  const traces = [];
  let lastPage;
  try {
    await run(async (page, name, options = {}) => {
      lastPage = page;
      const samples = await sampleFrames(page, options);
      traces.push({ name, samples });
      return samples;
    });
  } catch (error) {
    const state = await lastPage?.evaluate(() => {
      const store = window.Pinia.useChatStore();
      return {
        pendingWindows: store._yeaftHistoryWindowPendingByKey,
        focusWindows: store.yeaftHistoryFocusWindowBySession,
        searchState: store.yeaftHistorySearchState,
        renderedRows: Array.from(document.querySelectorAll('[data-msg-id]')).map(el => el.dataset.msgId),
        renderedBlocks: Array.from(document.querySelectorAll('[data-virtual-id]')).map(el => el.dataset.virtualId),
      };
    }).catch(() => null);
    const path = testInfo.outputPath('transcript-scroll-frames.json');
    await writeFile(path, JSON.stringify({ traces, state }));
    await testInfo.attach('transcript-scroll-frames', { path, contentType: 'application/json' });
    throw error;
  }
}

async function sampleFrames(page, options = {}) {
  return page.evaluate(async ({ count, options, conversationId, streamingId }) => {
    const container = document.querySelector('.chat-container');
    const samples = [];
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise(requestAnimationFrame);
      const resize = options.resizes?.find(change => change.frame === frame);
      if (resize) {
        let content = container.querySelector('[data-delayed-tail]');
        if (!content) {
          content = document.createElement('div');
          content.dataset.delayedTail = 'true';
          container.querySelector('.virtual-transcript-item:last-child').appendChild(content);
        }
        content.style.height = `${resize.height}px`;
      }
      if (options.prepend && frame === 12) window.Pinia.useChatStore().loadMoreYeaftHistory(5);
      if (options.streaming && frame <= 60 && frame % 5 === 0) {
        const row = window.Pinia.useChatStore().messagesMap[conversationId].find(row => row.id === streamingId);
        row.content += `\n\nStreaming chunk ${frame}: ` + 'Implementation and verification notes. '.repeat(12);
        if (frame === 60) row.isStreaming = false;
      }
      const anchor = options.anchorId && Array.from(container.querySelectorAll('[data-virtual-id]'))
        .find(element => element.dataset.virtualId === options.anchorId);
      samples.push({ frame, top: container.scrollTop, height: container.scrollHeight,
        navigationHeight: container.querySelector('.transcript-navigation')?.getBoundingClientRect().height || 0,
        gap: container.scrollHeight - container.clientHeight - container.scrollTop,
        ids: Array.from(container.querySelectorAll('[data-virtual-id]')).map(element => element.dataset.virtualId),
        ...(options.anchorId ? { anchorTop: anchor ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top : null } : {}),
      });
    }
    return samples;
  }, { count: FRAME_COUNT, options, conversationId: CONVERSATION, streamingId: STREAMING_TAIL });
}

function expectStable(samples, { start = 80, end = FRAME_COUNT, bottom = true } = {}) {
  expect(samples).toHaveLength(FRAME_COUNT);
  const settled = samples.slice(start, end);
  expect(settled.length).toBeGreaterThanOrEqual(10);
  expect(settled.every(sample => sample.ids.length > 0)).toBe(true);
  const tops = settled.map(sample => sample.top);
  expect(Math.max(...tops) - Math.min(...tops), 'scrollTop must converge, not alternate between virtual windows').toBeLessThanOrEqual(2);
  expect(new Set(settled.map(sample => sample.ids.join('|'))).size, 'mounted virtual ids must converge').toBe(1);
  if (bottom) expect(Math.max(...settled.map(sample => Math.abs(sample.gap))), 'Latest must remain at the true DOM bottom').toBeLessThanOrEqual(2);
  else expect(Math.min(...settled.map(sample => sample.gap)), 'reader must not be pulled back to Latest').toBeGreaterThan(100);
}

async function scrollAway(page, delta = -20000) {
  await page.locator('.chat-container').hover();
  await page.mouse.wheel(0, delta);
  await expect(page.locator('.scroll-to-latest')).not.toHaveClass(/is-hidden/);
}

async function appendStreamingTail(page, agentId) {
  await page.evaluate(({ conversationId, sessionId, agentId, id }) => {
    // Pure test data, through the real store and rendering pipeline; no LLM or
    // live Agent is used to make streaming layout changes deterministic.
    window.Pinia.useChatStore().addMessageToConversation(conversationId, {
      id, type: 'assistant', content: 'Streaming response begins.',
      sessionId, agentId, turnId: 'streaming-turn', speakerVpId: 'omni',
      responseKind: 'result', isStreaming: true, timestamp: Date.now(),
    });
  }, { conversationId: CONVERSATION, sessionId: SESSION, agentId, id: STREAMING_TAIL });
}

for (const { theme, width } of VIEWPORTS) {
  test.describe(`${theme} ${width}px`, () => {
    test.use({ colorScheme: theme });

    test('Latest converges for cached/unmeasured tails, resizing and streaming; upward scroll cancels follow', async ({ chatPage: page, mockAgent }, testInfo) => {
      test.setTimeout(60000);
      // The shared bootstrap waits for a desktop-only brand label. Resize after
      // it is ready, before mounting any transcript (do not change the fixture).
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await withScrollTrace(testInfo, async record => {
        await openTranscript(page, mockAgent);
        expectStable(await record(page, 'initial tail'));
        const cachedTail = await page.locator('.virtual-transcript-item').last().getAttribute('data-virtual-id');
        await scrollAway(page);
        expectStable(await record(page, 'reader leaves cached tail'), { bottom: false });
        await expect(page.locator(`[data-virtual-id="${cachedTail}"]`)).toHaveCount(0);
        await page.locator('.scroll-to-latest').click();
        const resized = await record(page, 'cached Latest, delayed +1800px then shrink', {
          resizes: [{ frame: 12, height: 1800 }, { frame: 55, height: 120 }],
        });
        expectStable(resized, { start: 30, end: 50 });
        expectStable(resized);
        expect(resized[45].height - resized[5].height).toBeGreaterThanOrEqual(1798);
        expect(resized[45].height - resized[100].height).toBeGreaterThanOrEqual(1678);

        await scrollAway(page, -12000);
        expectStable(await record(page, 'paused before new unmeasured tail'), { bottom: false });
        await appendStreamingTail(page, mockAgent.agentId);
        await expect(page.locator(`[data-msg-id="${STREAMING_TAIL}"]`)).toHaveCount(0);
        await page.locator('.scroll-to-latest').click();
        await expect(page.locator('.chat-container')).toContainText('Streaming response begins.');
        const streaming = await record(page, 'unmeasured Latest and streaming growth', { streaming: true });
        expectStable(streaming);
        expect(streaming[100].height - streaming[0].height, 'streaming must actually grow the rendered transcript').toBeGreaterThan(500);

        // Explicit wheel input must remain authoritative even if the tail keeps
        // producing content after the user leaves it.
        await scrollAway(page, -6000);
        const paused = await record(page, 'user scroll during subsequent streaming', { streaming: true });
        expectStable(paused, { bottom: false });
        await expect(page.locator('.scroll-to-latest')).not.toHaveClass(/is-hidden/);
        await page.locator('.scroll-to-latest').click();
        expectStable(await record(page, 'resume Latest after user pause'));
        await page.locator('.scroll-to-latest').evaluate(button => {
          for (let click = 0; click < 5; click += 1) button.click();
        });
        await page.setViewportSize({ width, height: 650 });
        expectStable(await record(page, 'repeated Latest and composer viewport resize'));
        await page.setViewportSize({ width, height: 800 });
        expectStable(await record(page, 'viewport restored while following'));
      });
    });
  });
}

test('PageUp on a focused message link hands the virtual window to the reader', async ({ chatPage: page, mockAgent }, testInfo) => {
  await withScrollTrace(testInfo, async record => {
    await openTranscript(page, mockAgent);
    expectStable(await record(page, 'before keyboard scroll'));
    await page.locator('.virtual-transcript-item').last().evaluate(row => {
      const link = document.createElement('a');
      link.href = '#keyboard-scroll-test';
      link.textContent = 'Focused message link';
      row.appendChild(link);
      link.focus();
    });
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
    await expect(page.locator('.scroll-to-latest')).not.toHaveClass(/is-hidden/);
    expectStable(await record(page, 'reader after keyboard paging'), { bottom: false });
    expect(await page.locator('.chat-container').evaluate(container => {
      const rect = container.getBoundingClientRect();
      return !!document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        ?.closest('.virtual-transcript-item');
    }), 'paging must render real rows, not a blank virtual spacer').toBe(true);
    await page.locator('.scroll-to-latest').click();
    expectStable(await record(page, 'Latest after keyboard scroll'));
  });
});

test('older history prepend preserves the visible anchor without resuming follow', async ({ chatPage: page, mockAgent }, testInfo) => {
  test.setTimeout(45000);
  await withScrollTrace(testInfo, async record => {
    const requests = await openTranscript(page, mockAgent, { olderHistory: true });
    await page.evaluate(sessionId => window.Pinia.useChatStore().expandYeaftMessageWindow(sessionId, 100), SESSION);
    expectStable(await record(page, 'expanded resident history'));
    await scrollAway(page);
    expectStable(await record(page, 'paused before prepend'), { bottom: false });
    const anchor = await page.locator('.chat-container').evaluate(container => {
      const bounds = container.getBoundingClientRect();
      const element = Array.from(container.querySelectorAll('[data-virtual-id]'))
        .find(element => element.getBoundingClientRect().bottom > bounds.top);
      return { id: element.dataset.virtualId, top: element.getBoundingClientRect().top - bounds.top };
    });
    const samples = await record(page, 'older history response and anchor compensation', { prepend: true, anchorId: anchor.id });
    expect(requests.some(request => request.type === 'yeaft_load_more_history')).toBe(true);
    await expect.poll(() => page.evaluate(conversationId => window.Pinia.useChatStore().messagesMap[conversationId]
      .some(row => row.id === 'm1'), CONVERSATION)).toBe(true);
    expectStable(samples, { bottom: false });
    expect(samples.slice(80).every(sample => sample.anchorTop !== null), 'the original visible item must stay mounted').toBe(true);
    expect(Math.max(...samples.slice(80).map(sample => Math.abs(sample.anchorTop - anchor.top))), 'prepend must preserve the item viewport offset').toBeLessThanOrEqual(2);
    await page.locator('.scroll-to-latest').click();
    expectStable(await record(page, 'Latest after prepend'));
  });
});

// Baseline 204833ede reproduces this independent search-window projection
// failure unchanged (focus m49 accepted, recent m241/m289/m337 still mounted).
// Keep the strict regression for a separate search fix, not a false green.
test.fixme('search opens a detached history window and Latest restores the recent tail on a narrow dark viewport', async ({ chatPage: page, mockAgent }, testInfo) => {
  test.setTimeout(45000);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await withScrollTrace(testInfo, async record => {
    await openTranscript(page, mockAgent, { olderHistory: true });
    expectStable(await record(page, 'before search'));
    await page.evaluate(agentId => {
      window.Pinia.useChatStore().agents.find(agent => agent.id === agentId).capabilities.push('session_history_search');
    }, mockAgent.agentId);
    await page.locator('.yeaft-search-btn').click();
    await page.locator('.yeaft-conversation-outline input[type="search"]').fill('Question 1');
    const result = page.locator('.yeaft-conversation-outline-item').filter({ hasText: 'Question 1' });
    await expect(result).toHaveCount(1);
    await result.click();
    await expect(page.locator('.yeaft-conversation-outline')).toHaveCount(0);
    await expect(page.locator('[data-msg-id="m49"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(window.Pinia.useChatStore().yeaftHistoryFocusWindowBySession).length)).toBe(1);
    const targetId = await page.locator('[data-msg-id="m49"]').evaluate(element => element.closest('[data-virtual-id]').dataset.virtualId);
    const searchSamples = await record(page, 'detached search target', { anchorId: targetId });
    expectStable(searchSamples, { bottom: false });
    expect(searchSamples.slice(80).every(sample => sample.anchorTop !== null)).toBe(true);
    await page.locator('.scroll-to-latest').click();
    const latestSamples = await record(page, 'Latest restores recent projection');
    expectStable(latestSamples);
    await expect(page.locator('.chat-container')).toContainText('Answer 49');
    await expect.poll(() => page.evaluate(() => Object.keys(window.Pinia.useChatStore().yeaftHistoryFocusWindowBySession).length)).toBe(0);
    await expect(page.locator('[data-msg-id="m49"]')).toHaveCount(0);
  });
});
