import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

test.use({ serverEnv: { SERVE_DIST: 'true', YEAFT_LOCAL_RUN: 'true' } });
test('native Session progress is ephemeral, scoped and readable in light/dark at 320px', async ({ chatPage: page, mockAgent }, info) => {
  const session = { id: 'progress-session', name: 'Query progress', roster: ['progress-vp'], defaultVpId: 'progress-vp' };
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [session] } });
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().sessionCatalog.some(row => row.routeRef.sessionId === id), session.id)).toBe(true);
  const conversationId = await page.evaluate(({ agentId, sessionId }) => {
    const chat = window.Pinia.useChatStore();
    chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
    chat.closeSessionSidebar();
    return chat.yeaftConversationIdsByAgent[agentId];
  }, { agentId: mockAgent.agentId, sessionId: session.id });
  const event = { type: 'query_progress', sessionId: session.id, vpId: 'progress-vp', turnId: 'progress-turn', threadId: 'main',
    revision: 1, modelRequests: 2, toolExecutions: 3, reusedCalls: 1, repeatedCalls: 2, failedCalls: 0,
    stage: 'warning', reason: 'repeated_results', lastEvidenceAt: Date.now(), stagnantBatches: 2 };
  const send = e => mockAgent.send({ type: 'yeaft_output', conversationId, sessionId: session.id, event: e });
  send({ ...event, type: 'vp_turn_start' });
  send({ ...event, type: 'vp_status_changed', state: 'tool' });
  send({ ...event, text: 'PRIVATE_PROGRESS_TEXT', input: { secret: 'PRIVATE_PROGRESS_TEXT' } });
  const progress = page.locator('.yeaft-query-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toContainText('Requests 2');
  await expect(progress).toContainText('Repeated results');
  await expect(progress).toContainText('New evidence does not mean the task is complete.');
  await expect(page.locator('body')).not.toContainText('PRIVATE_PROGRESS_TEXT');
  send({ ...event, revision: 2, sessionId: 'another-session', modelRequests: 999 });
  send({ ...event, revision: 0, modelRequests: 999 });
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
  // A disconnect hides old observations immediately; a fresh snapshot does not invent counters.
  await page.evaluate(() => { const chat = window.Pinia.useChatStore(); chat.connectionState = 'reconnecting'; chat.chatHistoryConnectionGeneration++; });
  await expect(progress).toHaveCount(0);
  await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
  send({ type: 'vp_status_snapshot', sessionId: session.id, statuses: [{ sessionId: session.id, vpId: event.vpId, turnId: event.turnId, state: 'tool' }] });
  await expect(progress).toHaveCount(0);
  send({ ...event, revision: 3, stage: 'recovering', reason: 'repeated_failure' });
  await expect(progress).toContainText('Recovering');
  send({ ...event, type: 'vp_turn_end', reason: 'errored' });
  send({ ...event, revision: 4 });
  await expect(progress).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(window.Pinia.useChatStore().messagesMap))).not.toContain('query_progress');
});
