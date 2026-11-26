import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

test.use({ serverEnv: { SERVE_DIST: 'true', YEAFT_LOCAL_RUN: 'true' } });

test('failed native Yeaft Session turn retry status bar, retryToken fencing, resume, reconnect, keyboard and narrow layout', async ({ chatPage: page, mockAgent }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 840 });

  // Switch UI locale to zh-CN so we verify the exact Chinese action labels.
  await page.evaluate(() => {
    localStorage.setItem('locale', 'zh-CN');
  });
  await page.reload();
  await page.waitForSelector('.app-container, .chat-container, .yeaft-page', { timeout: 15_000 });

  const sessionA = { id: 'session_retry_a', name: 'Retry Session A', roster: ['vp-retry'], defaultVpId: 'vp-retry' };
  const sessionB = { id: 'session_retry_b', name: 'Retry Session B', roster: ['vp-retry'], defaultVpId: 'vp-retry' };
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [sessionA, sessionB] } });
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().sessionCatalog.some(row => row.routeRef.sessionId === id), sessionA.id)).toBe(true);

  await page.evaluate(({ agentId, sessionId }) => {
    const chat = window.Pinia.useChatStore();
    chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
    chat.closeSessionSidebar();
  }, { agentId: mockAgent.agentId, sessionId: sessionA.id });

  const conversationId = `yeaft-${randomUUID()}`;
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    event: { type: 'session_ready', conversationId, sessionId: sessionA.id, model: 'test-model' },
  });
  await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().yeaftConversationIdsByAgent[agentId], mockAgent.agentId)).toBe(conversationId);

  // Record outbound WS messages sent by the browser store without altering behavior.
  await page.evaluate(() => {
    const chat = window.Pinia.useChatStore();
    window.__sentWsFrames = [];
    const orig = chat.sendWsMessage.bind(chat);
    chat.sendWsMessage = (payload) => {
      window.__sentWsFrames.push(payload);
      return orig(payload);
    };
  });

  // Seed a user turn plus partial assistant text so we can verify resume retains existing text.
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    vpId: 'vp-retry',
    turnId: 'turn-1',
    data: { type: 'user', message: { id: 'u-1', content: 'Run the build check' } },
  });
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    vpId: 'vp-retry',
    turnId: 'turn-1',
    data: { type: 'assistant', message: { id: 'a-1', content: [{ type: 'text', text: 'Partial build output' }] } },
  });
  await expect(page.locator('.messages')).toContainText('Partial build output');

  // 1) Unknown error (no retryTurnId/retryToken) must NOT render retry controls.
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    vpId: 'vp-retry',
    turnId: 'turn-unknown',
    event: { type: 'error', message: 'Generic non-retryable error' },
  });
  await expect(page.locator('.yeaft-failed-turn-status-bar')).toHaveCount(0);

  // 2) Error with retryTurnId + retryToken waits for authoritative session_turns before showing buttons.
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    vpId: 'vp-retry',
    turnId: 'turn-1',
    event: { type: 'error', message: '上游连接中断', retryTurnId: 'turn-1', retryToken: 'tok-1', reason: 'stream_idle_timeout' },
  });
  await expect(page.locator('.yeaft-failed-turn-status-bar')).toHaveCount(0);

  // Authoritative session_turns publishes retryableTurns after terminal transition -> bar appears with error text.
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    event: {
      type: 'session_turns',
      sessionId: sessionA.id,
      turns: [],
      retryableTurns: [{ turnId: 'turn-1', vpId: 'vp-retry', threadId: 'main', retryToken: 'tok-1' }],
    },
  });
  const bar = page.locator('.messages .yeaft-failed-turn-status-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('上游连接中断');
  const banner = bar.locator('[data-retry-turn-id="turn-1"][data-retry-token="tok-1"]');
  const plainBtn = banner.locator('button[data-retry-mode="plain"]');
  const compactBtn = banner.locator('button[data-retry-mode="compact"]');
  await expect(plainBtn).toHaveText('重试');
  await expect(compactBtn).toHaveText('压缩工具结果后重试');

  // 3) Click plain retry -> single outbound frame echoing retryToken, buttons disabled, duplicate click suppressed.
  const msgCountBefore = await page.evaluate(cid => (window.Pinia.useChatStore().messagesMap[cid] || []).length, conversationId);
  await plainBtn.click();
  await expect(plainBtn).toBeDisabled();
  await expect(compactBtn).toBeDisabled();
  await plainBtn.click({ force: true });

  const retryFrames1 = await page.evaluate(() => window.__sentWsFrames.filter(f => f?.type === 'yeaft_session_retry'));
  expect(retryFrames1).toHaveLength(1);
  expect(retryFrames1[0]).toMatchObject({
    type: 'yeaft_session_retry',
    agentId: mockAgent.agentId,
    sessionId: sessionA.id,
    turnId: 'turn-1',
    retryToken: 'tok-1',
    mode: 'plain',
  });
  const badFrames = await page.evaluate(() => window.__sentWsFrames.filter(f => ['yeaft_session_send', 'chat', 'yeaft_load_history'].includes(f?.type)));
  expect(badFrames).toHaveLength(0);
  expect(await page.evaluate(cid => (window.Pinia.useChatStore().messagesMap[cid] || []).length, conversationId)).toBe(msgCountBefore);

  // 4) Standalone relay failure ok:false re-enables buttons and surfaces inline error string.
  const firstRelay = await mockAgent.waitForMessage('session_turn_retry_authorized');
  expect(firstRelay).toMatchObject({ ...retryFrames1[0], type: 'session_turn_retry_authorized', _requestClientId: expect.any(String) });
  mockAgent.send({ type: 'yeaft_session_retry_result', sessionId: firstRelay.sessionId,
    turnId: firstRelay.turnId, requestId: firstRelay.requestId, _requestClientId: firstRelay._requestClientId, _dispatchId: firstRelay._dispatchId,
    ok: false, error: 'relay_unavailable' });
  await expect(plainBtn).toBeEnabled();
  await expect(compactBtn).toBeEnabled();
  await expect(bar).toContainText('relay_unavailable');

  // 5) Keyboard activation on compact button sends mode:'compact' with retryToken, ack ok:true clears bar.
  await compactBtn.focus();
  await page.keyboard.press('Enter');
  const retryFrames2 = await page.evaluate(() => window.__sentWsFrames.filter(f => f?.type === 'yeaft_session_retry'));
  expect(retryFrames2).toHaveLength(2);
  expect(retryFrames2[1]).toMatchObject({
    type: 'yeaft_session_retry',
    agentId: mockAgent.agentId,
    sessionId: sessionA.id,
    turnId: 'turn-1',
    retryToken: 'tok-1',
    mode: 'compact',
  });
  const secondRelay = await mockAgent.waitForMessage('session_turn_retry_authorized');
  expect(secondRelay).toMatchObject({ ...retryFrames2[1], type: 'session_turn_retry_authorized', _requestClientId: firstRelay._requestClientId });
  mockAgent.send({ type: 'yeaft_session_retry_result', sessionId: secondRelay.sessionId,
    turnId: secondRelay.turnId, requestId: secondRelay.requestId, _requestClientId: secondRelay._requestClientId, _dispatchId: secondRelay._dispatchId, ok: true });
  await expect(bar).toHaveCount(0);

  // Resumed vp_turn_start with retry:true retains existing partial assistant text.
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    vpId: 'vp-retry',
    turnId: 'turn-1',
    event: { type: 'vp_turn_start', sessionId: sessionA.id, vpId: 'vp-retry', turnId: 'turn-1', threadId: 'main', retry: true },
  });
  await expect(page.locator('.messages')).toContainText('Partial build output');

  // 6) New attempt fails -> distinct retryToken restores same logical turnId + second parallel turn.
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    vpId: 'vp-retry',
    turnId: 'turn-1',
    event: { type: 'error', message: '再次尝试仍超时', retryTurnId: 'turn-1', retryToken: 'tok-2' },
  });
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    vpId: 'vp-retry',
    turnId: 'turn-2',
    event: { type: 'error', message: '第二轮失败', retryTurnId: 'turn-2', retryToken: 'tok-3' },
  });
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    event: {
      type: 'session_turns',
      sessionId: sessionA.id,
      turns: [],
      retryableTurns: [
        { turnId: 'turn-1', vpId: 'vp-retry', threadId: 'main', retryToken: 'tok-2' },
        { turnId: 'turn-2', vpId: 'vp-retry', threadId: 't-2', retryToken: 'tok-3' },
      ],
    },
  });
  await expect(page.locator('.yeaft-failed-turn-banner')).toHaveCount(2);
  await expect(page.locator('[data-retry-turn-id="turn-1"][data-retry-token="tok-2"]')).toBeVisible();

  // 7) Session scoping: switching to sessionB hides sessionA's retry bars.
  await page.evaluate(({ agentId, sessionId }) => {
    const chat = window.Pinia.useChatStore();
    chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
  }, { agentId: mockAgent.agentId, sessionId: sessionB.id });
  await expect(page.locator('.yeaft-failed-turn-banner')).toHaveCount(0);

  // Switch back to sessionA -> both bars still present.
  await page.evaluate(({ agentId, sessionId }) => {
    const chat = window.Pinia.useChatStore();
    chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
  }, { agentId: mockAgent.agentId, sessionId: sessionA.id });
  await expect(page.locator('.yeaft-failed-turn-banner')).toHaveCount(2);

  // 8) Reconnect hides stale bars until authoritative session_turns restores them without losing history.
  await page.evaluate(() => {
    const chat = window.Pinia.useChatStore();
    chat.connectionState = 'reconnecting';
    chat.chatHistoryConnectionGeneration += 1;
  });
  await expect(page.locator('.yeaft-failed-turn-banner')).toHaveCount(0);
  await page.evaluate(() => {
    window.Pinia.useChatStore().connectionState = 'connected';
  });
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    event: {
      type: 'session_turns',
      sessionId: sessionA.id,
      turns: [],
      retryableTurns: [{ turnId: 'turn-1', vpId: 'vp-retry', threadId: 'main', retryToken: 'tok-2' }],
    },
  });
  await expect(page.locator('.yeaft-failed-turn-banner')).toHaveCount(1);
  await expect(page.locator('[data-retry-turn-id="turn-1"][data-retry-token="tok-2"]')).toBeVisible();
  await expect(page.locator('.messages')).toContainText('Run the build check');

  // 9) Visual & layout verification at 320px narrow width in light and dark themes (no horizontal overflow).
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.locator('[data-retry-turn-id="turn-1"] button[data-retry-mode="compact"]')).toBeVisible();
  const lightOverflow = await page.locator('.yeaft-failed-turn-banner').first().evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(lightOverflow).toBe(false);
  await page.screenshot({ path: info.outputPath('failed-turn-retry-320-light.png') });

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  const darkOverflow = await page.locator('.yeaft-failed-turn-banner').first().evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(darkOverflow).toBe(false);
  await page.screenshot({ path: info.outputPath('failed-turn-retry-320-dark.png') });

  // 10) Authoritative empty retryableTurns clears the bar.
  mockAgent.send({
    type: 'yeaft_output',
    conversationId,
    sessionId: sessionA.id,
    event: {
      type: 'session_turns',
      sessionId: sessionA.id,
      turns: [],
      retryableTurns: [],
    },
  });
  await expect(page.locator('.yeaft-failed-turn-banner')).toHaveCount(0);
});
