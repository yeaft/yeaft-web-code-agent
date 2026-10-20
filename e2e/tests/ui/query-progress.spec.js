import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { createVpStatusBroker } from '../../../agent/yeaft/vp-status-broker.js';

test.use({ serverEnv: { SERVE_DIST: 'true', YEAFT_LOCAL_RUN: 'true' } });
test('native Session progress is ephemeral, scoped and readable in light/dark at 320px', async ({ chatPage: page, mockAgent }, info) => {
  const session = { id: 'progress-session', name: 'Query progress', roster: ['progress-vp'], defaultVpId: 'progress-vp' };
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [session] } });
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().sessionCatalog.some(row => row.routeRef.sessionId === id), session.id)).toBe(true);
  await page.evaluate(({ agentId, sessionId }) => {
    const chat = window.Pinia.useChatStore();
    chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
    chat.closeSessionSidebar();
  }, { agentId: mockAgent.agentId, sessionId: session.id });
  // Real bridge identity, not the UI's cold-start yeaft-local placeholder.
  const conversationId = `yeaft-${randomUUID()}`;
  mockAgent.send({ type: 'yeaft_output', conversationId, sessionId: session.id,
    event: { type: 'session_ready', conversationId, sessionId: session.id, model: 'test-model' } });
  await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().yeaftConversationIdsByAgent[agentId], mockAgent.agentId)).toBe(conversationId);
  const event = { type: 'query_progress', sessionId: session.id, vpId: 'progress-vp', turnId: 'progress-turn', threadId: 'main',
    revision: 1, modelRequests: 2, toolExecutions: 3, reusedCalls: 1, repeatedCalls: 2, failedCalls: 0,
    stage: 'warning', reason: 'repeated_results', lastEvidenceAt: Date.now(), stagnantBatches: 2 };
  const send = e => mockAgent.send({ type: 'yeaft_output', conversationId, sessionId: session.id, event: e });
  let now = Date.now();
  const broker = createVpStatusBroker({ send, now: () => ++now });
  send({ ...event, type: 'vp_turn_start' });
  broker.transition({ sessionId: session.id, vpId: event.vpId, turnId: event.turnId, threadId: event.threadId, state: 'tool' });
  send({ ...event, text: 'PRIVATE_PROGRESS_TEXT', input: { secret: 'PRIVATE_PROGRESS_TEXT' } });
  const progress = page.locator('.yeaft-query-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('Requests 2');
  await expect(progress).toContainText('Repeated results');
  await expect(progress).toContainText('New evidence does not mean the task is complete.');
  await expect(page.locator('body')).not.toContainText('PRIVATE_PROGRESS_TEXT');
  send({ ...event, revision: 2, sessionId: 'another-session', modelRequests: 999 });
  send({ ...event, revision: 0, modelRequests: 999 });
  broker.broadcastSnapshot({ sessionId: session.id });
  broker.broadcastSnapshot();
  await expect(progress).toContainText('Requests 2');
  await page.screenshot({ path: info.outputPath('query-progress-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Show Session status', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('Requests 2');
    expect(await progress.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`query-progress-${theme}-320.png`), fullPage: true });
  }
  // Two live threads, followed by a completed latest thread: the aggregate
  // turnId is null, so recovery must consult the broker's threads[] owners.
  const parallel = { ...event, turnId: 'parallel-turn', threadId: 'parallel' };
  send({ ...parallel, type: 'vp_turn_start' });
  send(parallel);
  broker.transition({ ...parallel, state: 'tool' });
  broker.transition({ sessionId: session.id, vpId: event.vpId, threadId: 'finished', turnId: 'finished-turn', state: 'tool' });
  broker.settleIdle({ sessionId: session.id, vpId: event.vpId, threadId: 'finished' });
  broker.broadcastSnapshot();
  const liveOwners = () => page.evaluate(agentId => {
    const chat = window.Pinia.useChatStore();
    return Object.values(chat.activeVpTurns).filter(row => row.agentId === agentId).map(row => ({
      turnId: row.turnId, authorized: row.connectionGeneration === chat.chatHistoryConnectionGeneration,
      revision: row.queryProgress?.revision ?? null,
    })).sort((a, b) => a.turnId.localeCompare(b.turnId));
  }, mockAgent.agentId);
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: true, revision: 1 },
    { turnId: event.turnId, authorized: true, revision: 1 },
  ]);
  const generation = await page.evaluate(() => window.Pinia.useChatStore().chatHistoryConnectionGeneration);
  const agentId = mockAgent.agentId;
  await mockAgent.disconnect();
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(a => a.id === id && a.online), agentId)).toBe(false);
  await expect(progress).toHaveCount(0);
  expect(await page.evaluate(() => window.Pinia.useChatStore().connectionState)).toBe('connected');
  expect(await page.evaluate(() => window.Pinia.useChatStore().chatHistoryConnectionGeneration)).toBe(generation);
  await mockAgent.connect();
  expect(mockAgent.agentId).toBe(agentId);
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(a => a.id === id && a.online), agentId)).toBe(true);
  send({ ...event, revision: 2 });
  send({ ...parallel, revision: 2 });
  broker.transition({ ...event, state: 'streaming' });
  await expect(progress).toHaveCount(0);
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: false, revision: null },
    { turnId: event.turnId, authorized: false, revision: null },
  ]);
  broker.broadcastSnapshot();
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: true, revision: null },
    { turnId: event.turnId, authorized: true, revision: null },
  ]);
  await expect(progress).toHaveCount(0);
  send({ ...parallel, revision: 2 });
  send({ ...event, revision: 2, stage: 'recovering', reason: 'repeated_failure' });
  await expect(progress).toContainText('Recovering');
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: true, revision: 2 },
    { turnId: event.turnId, authorized: true, revision: 2 },
  ]);
  // Browser reconnect likewise needs a fresh snapshot, not old observations.
  await page.evaluate(() => { const chat = window.Pinia.useChatStore(); chat.connectionState = 'reconnecting'; chat.chatHistoryConnectionGeneration++; });
  await expect(progress).toHaveCount(0);
  await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
  broker.broadcastSnapshot({ sessionId: session.id });
  await expect(progress).toHaveCount(0);
  send({ ...event, revision: 3 });
  await expect(progress).toBeVisible();
  send({ ...parallel, type: 'vp_turn_end', reason: 'errored' });
  send({ ...event, type: 'vp_turn_end', reason: 'errored' });
  send({ ...event, revision: 4 });
  await expect(progress).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(window.Pinia.useChatStore().messagesMap))).not.toContain('query_progress');
});
