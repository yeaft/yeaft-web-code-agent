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
    revision: 1, modelRequests: 2, toolExecutions: 3, reusedCalls: 1, repeatedCalls: 2, failedCalls: 2,
    inputTokens: 1234567, outputTokens: 98765,
    toolStats: [{ name: 'Bash', executions: 2, failedCalls: 2, blockedCalls: 1 }, { name: 'FileRead', executions: 1, failedCalls: 0, blockedCalls: 0 }], toolStatsTruncated: false,
    stage: 'warning', reason: 'repeated_results', lastEvidenceAt: Date.now(), stagnantBatches: 2 };
  const send = e => mockAgent.send({ type: 'yeaft_output', conversationId, sessionId: session.id, event: e });
  let now = Date.now();
  const broker = createVpStatusBroker({ send, now: () => ++now });
  send({ ...event, type: 'vp_turn_start' });
  broker.transition({ sessionId: session.id, vpId: event.vpId, turnId: event.turnId, threadId: event.threadId, state: 'tool' });
  send({ ...event, stage: 'running', reason: null, failedCalls: 0, toolStats: [] });
  const progresses = page.locator('.yeaft-query-progress');
  const progress = progresses.filter({ hasText: '1,234,567' }).first();
  await expect(progress).toBeVisible();
  await expect(progress.locator('.yeaft-query-progress-failures-toggle')).toHaveCount(0);
  await expect(progress.locator('.yeaft-query-progress-state')).toHaveCount(0);
  event.revision++;
  send({ ...event, text: 'PRIVATE_PROGRESS_TEXT', input: { secret: 'PRIVATE_PROGRESS_TEXT' } });
  await page.evaluate(agentId => window.Pinia.useVpStore().applySnapshot({ vps: [{
    vpId: 'progress-vp', displayName: 'Software assistant', displayNameZh: '软件全能助手',
    description: 'End-to-end software product, engineering, quality, release and operations',
    descriptionZh: '端到端的软件产品、工程、质量、发布与运行能力',
  }] }, agentId), mockAgent.agentId);
  await expect(progress).toContainText('Requests 2');
  await expect(progress).toContainText('1,234,567');
  await expect(progress).toContainText('98,765');
  await expect(page.locator('.yeaft-session-status-pane')).not.toContainText('Software assistant');
  await expect(page.locator('.yeaft-session-activity-elapsed')).toContainText(/Elapsed .+s/);
  await expect(progress.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0);
  await expect(progress.getByRole('status')).toHaveText('Progress warning · Repeated tool results');
  const usage = progress.getByRole('group', { name: 'This turn · current thread' });
  await expect(usage).toHaveAccessibleDescription(/not context size/);
  await expect(usage.getByText('1,234,567', { exact: true })).toHaveCSS('font-size', '12px');
  await progress.getByRole('button', { name: 'Failed 2, show tool breakdown' }).focus();
  await page.keyboard.press('Enter');
  await expect(progress.locator('.yeaft-query-progress-failures')).toContainText('Bash');
  await expect(progress.locator('.yeaft-query-progress-failures')).not.toContainText('FileRead');
  await expect(progress.locator('.yeaft-query-progress-tool-row').last()).toHaveAccessibleName('Bash: 2 runs, 2 failed calls, 1 blocked calls');
  await expect(progress.getByRole('button', { name: 'Failed 2, show tool breakdown' })).toHaveAttribute('aria-expanded', 'true');
  const assertHeader = async () => {
    const bounds = await page.locator('.yeaft-vp-timeline-row-header').first().evaluate(el => {
      const header = el.getBoundingClientRect();
      const abort = el.querySelector('.yeaft-vp-timeline-abort').getBoundingClientRect();
      return { headerTop: header.top, headerBottom: header.bottom, abortTop: abort.top, abortBottom: abort.bottom };
    });
    expect(bounds.abortTop).toBe(bounds.headerTop);
    expect(bounds.abortBottom).toBeLessThanOrEqual(bounds.headerBottom);
  };
  await assertHeader();
  await expect(page.locator('body')).not.toContainText('PRIVATE_PROGRESS_TEXT');
  send({ ...event, revision: 3, sessionId: 'another-session', modelRequests: 999 });
  send({ ...event, revision: 0, modelRequests: 999 });
  broker.broadcastSnapshot({ sessionId: session.id });
  broker.broadcastSnapshot();
  await expect(progress).toContainText('Requests 2');
  await progress.getByRole('button', { name: 'Failed 2, show tool breakdown' }).click();
  await page.screenshot({ path: info.outputPath('query-progress-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Show Session status', exact: true }).click();
  // Mobile mounts its own pane, so disclosure starts closed rather than
  // inheriting ephemeral desktop component state.
  await progress.getByRole('button', { name: 'Failed 2, show tool breakdown' }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('Requests 2');
    await assertHeader();
    expect(await progress.locator('.yeaft-query-progress-failures').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await progress.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`query-progress-${theme}-320.png`), fullPage: true });
  }
  await page.evaluate(() => window.Pinia.useChatStore().changeLocale('zh-CN'));
  await expect(progress.getByRole('group', { name: '当前线程 · 本轮累计' })).toContainText('输入 token');
  await expect(progress.getByRole('status')).toHaveText('进度警告 · 工具结果重复');
  await expect(progress.getByRole('button', { name: '运行详情', exact: true })).toHaveCount(0);
  await expect(progress).toContainText('执行');
  await assertHeader();
  expect(await progress.locator('.yeaft-query-progress-failures').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('query-progress-zh-dark-320.png'), fullPage: true });
  await page.evaluate(() => window.Pinia.useChatStore().changeLocale('en'));
  // Two live threads, followed by a completed latest thread: the aggregate
  // turnId is null, so recovery must consult the broker's threads[] owners.
  const parallel = { ...event, revision: 1, turnId: 'parallel-turn', threadId: 'parallel', modelRequests: 7 };
  send({ ...parallel, type: 'vp_turn_start' });
  send(parallel);
  broker.transition({ ...parallel, state: 'tool' });
  await expect(progresses.filter({ hasText: 'Requests 7' })).toBeVisible();
  await expect(progress).toBeVisible();
  broker.transition({ sessionId: session.id, vpId: event.vpId, threadId: 'finished', turnId: 'finished-turn', state: 'tool' });
  broker.settleIdle({ sessionId: session.id, vpId: event.vpId, threadId: 'finished' });
  broker.broadcastSnapshot();
  await expect(progress).toBeVisible();
  await expect(progresses.filter({ hasText: 'Requests 7' })).toBeVisible();
  await expect(progress).toBeVisible();
  const liveOwners = () => page.evaluate(agentId => {
    const chat = window.Pinia.useChatStore();
    return Object.values(chat.activeVpTurns).filter(row => row.agentId === agentId).map(row => ({
      turnId: row.turnId, authorized: row.connectionGeneration === chat.chatHistoryConnectionGeneration,
      revision: row.queryProgress?.revision ?? null,
    })).sort((a, b) => a.turnId.localeCompare(b.turnId));
  }, mockAgent.agentId);
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: true, revision: 1 },
    { turnId: event.turnId, authorized: true, revision: 2 },
  ]);
  const generation = await page.evaluate(() => window.Pinia.useChatStore().chatHistoryConnectionGeneration);
  const agentId = mockAgent.agentId;
  await mockAgent.disconnect();
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(a => a.id === id && a.online), agentId)).toBe(false);
  await expect(progresses).toHaveCount(0);
  expect(await page.evaluate(() => window.Pinia.useChatStore().connectionState)).toBe('connected');
  expect(await page.evaluate(() => window.Pinia.useChatStore().chatHistoryConnectionGeneration)).toBe(generation);
  await mockAgent.connect();
  expect(mockAgent.agentId).toBe(agentId);
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(a => a.id === id && a.online), agentId)).toBe(true);
  send({ ...event, revision: 3 });
  send({ ...parallel, revision: 2 });
  broker.transition({ ...event, state: 'streaming' });
  await expect(progresses).toHaveCount(0);
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: false, revision: null },
    { turnId: event.turnId, authorized: false, revision: null },
  ]);
  broker.broadcastSnapshot();
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: true, revision: null },
    { turnId: event.turnId, authorized: true, revision: null },
  ]);
  await expect(progresses).toHaveCount(0);
  send({ ...parallel, revision: 2 });
  send({ ...event, revision: 3, stage: 'recovering', reason: 'repeated_failure' });
  await expect(progress.getByRole('status')).toHaveText('Recovering · Repeated tool failures');
  await expect(progresses).toHaveCount(2);
  await expect.poll(liveOwners).toEqual([
    { turnId: parallel.turnId, authorized: true, revision: 2 },
    { turnId: event.turnId, authorized: true, revision: 3 },
  ]);
  // Browser reconnect likewise needs a fresh snapshot, not old observations.
  await page.evaluate(() => { const chat = window.Pinia.useChatStore(); chat.connectionState = 'reconnecting'; chat.chatHistoryConnectionGeneration++; });
  await expect(progresses).toHaveCount(0);
  await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
  broker.broadcastSnapshot({ sessionId: session.id });
  await expect(progresses).toHaveCount(0);
  send({ ...event, revision: 4 });
  await expect(progress).toBeVisible();
  send({ ...parallel, type: 'vp_turn_end', reason: 'errored' });
  send({ ...event, type: 'vp_turn_end', reason: 'errored' });
  send({ ...event, revision: 4 });
  await expect(progresses).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(window.Pinia.useChatStore().messagesMap))).not.toContain('query_progress');
});

test('terminal frames and reconnect snapshots settle sidebar animation and response styling independently', async ({ chatPage: page, mockAgent }, info) => {
  const session = { id: 'terminal-session', name: 'Terminal status', roster: ['terminal-vp'], defaultVpId: 'terminal-vp' };
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [session] } });
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().sessionCatalog.some(row => row.routeRef.sessionId === id), session.id)).toBe(true);
  await page.evaluate(id => {
    const chat = window.Pinia.useChatStore();
    chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.sessionId === id));
  }, session.id);
  const conversationId = `yeaft-${randomUUID()}`;
  const owner = { sessionId: session.id, vpId: 'terminal-vp', threadId: 'main' };
  const send = event => mockAgent.send({ type: 'yeaft_output', conversationId, sessionId: session.id, event });
  const output = (turnId, data) => mockAgent.send({ type: 'yeaft_output', conversationId, ...owner, turnId, data });
  send({ type: 'session_ready', conversationId, sessionId: session.id, model: 'test-model' });
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().yeaftConversationIdsByAgent[id], mockAgent.agentId)).toBe(conversationId);
  const broker = createVpStatusBroker({ send });
  const sidebarRow = page.locator('.session-item').filter({ hasText: session.name });
  const response = text => page.locator('.assistant-turn').filter({ hasText: text });
  const start = (turnId, text) => {
    send({ ...owner, turnId, type: 'vp_turn_start' });
    broker.transition({ ...owner, turnId, state: 'streaming' });
    output(turnId, { type: 'assistant', message: { content: text } });
  };
  start('metadata-only', 'Metadata completion');
  await expect(sidebarRow.locator('.processing-dot')).toHaveCount(1);
  await expect(response('Metadata completion')).toHaveClass(/streaming/);
  send({ ...owner, type: 'vp_turn_end', turnId: 'metadata-only', reason: 'end_turn' });
  await expect(sidebarRow.locator('.processing-dot')).toHaveCount(0);
  await expect(response('Metadata completion')).not.toHaveClass(/streaming/);
  await expect(response('Metadata completion').locator('.turn-response-result')).toBeVisible();
  start('result-only', 'Result completion');
  output('result-only', { type: 'result', result_text: '' });
  await expect(sidebarRow.locator('.processing-dot')).toHaveCount(0);
  await expect(response('Result completion').locator('.turn-response-result')).toBeVisible();
  start('missed-terminal', 'Interrupted without terminal evidence');
  await expect(sidebarRow.locator('.processing-dot')).toHaveCount(1);
  // Reconnect's current broker snapshot must drain an orphan even when both
  // result and metadata were missed. It does not claim that work succeeded.
  send({ type: 'vp_status_snapshot', sessionId: session.id, statuses: [] });
  await expect(sidebarRow.locator('.processing-dot')).toHaveCount(0);
  await expect(response('Interrupted without terminal evidence')).not.toHaveClass(/streaming/);
  await expect(response('Interrupted without terminal evidence').locator('.turn-response-result')).toHaveCount(0);
  send({ ...owner, type: 'vp_turn_end', turnId: 'missed-terminal', reason: 'end_turn' });
  await expect(response('Interrupted without terminal evidence').locator('.turn-response-result')).toBeVisible();
  for (const [theme, width] of [['light', 1280], ['dark', 320]]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { window.Pinia.useChatStore().sessionSidebarOpen = true; });
    await expect(sidebarRow.locator('.processing-dot')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`session-terminal-${theme}-${width}.png`), fullPage: true });
  }
});

test('execution error disclosure survives Session navigation and snapshot-only reconnect, including legacy Agents', async ({ chatPage: page, mockAgent }, info) => {
  const sessions = [
    { id: 'error-session', name: 'Failed turn Session', roster: ['error-vp'], defaultVpId: 'error-vp' },
    { id: 'other-session', name: 'Another Session', roster: ['error-vp'], defaultVpId: 'error-vp' },
  ];
  const conversationId = `yeaft-${randomUUID()}`;
  const send = event => mockAgent.send({ type: 'yeaft_output', conversationId, event });
  mockAgent._messageHandlers.push(request => {
    if (request.type !== 'yeaft_load_history' || request.limit === 0) return;
    mockAgent.send({ type: 'yeaft_history_chunk', sessionId: request.sessionId, requestId: request.requestId,
      mode: 'recent', messages: [], oldestSeq: 0, latestSeq: 0, hasMore: false });
  });
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions } });
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().sessionCatalog.filter(row => row.routeRef.sessionId === 'error-session').length)).toBe(1);
  const open = async id => {
    await page.evaluate(id => {
      const chat = window.Pinia.useChatStore();
      chat.openCatalogSession(chat.sessionCatalog.find(row => row.routeRef.sessionId === id));
      chat.closeSessionSidebar();
    }, id);
  };
  await open(sessions[0].id);
  send({ type: 'session_ready', conversationId, sessionId: sessions[0].id, model: 'test-model' });
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().yeaftConversationIdsByAgent[id], mockAgent.agentId)).toBe(conversationId);
  const broker = createVpStatusBroker({ send });
  const owner = { sessionId: sessions[0].id, vpId: 'error-vp', threadId: 'main', turnId: 'failed-turn' };
  const message = 'Provider request failed\n' + '<script>UNTRUSTED_ERROR</script> ' + 'LongProviderDiagnostic'.repeat(100);
  broker.transition({ ...owner, state: 'error', errorDetail: { message, code: 'PROVIDER_FAILED', statusCode: 503 } });
  const toggle = page.locator('.yeaft-vp-error-toggle');
  const details = page.locator('.yeaft-vp-error-details');
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(details).toContainText('Provider request failed');
  await expect(details).toContainText('failed-turn');
  await expect(details.locator('script')).toHaveCount(0);
  expect(await page.locator('.chat-composer textarea').inputValue()).not.toContain('@error-vp');
  await open(sessions[1].id);
  await expect(toggle).toHaveCount(0);
  await open(sessions[0].id);
  await expect(toggle).toBeVisible();
  await expect(details).toHaveCount(0);
  await toggle.click();
  await expect(details).toContainText('PROVIDER_FAILED');
  await page.screenshot({ path: info.outputPath('vp-error-desktop-light.png'), fullPage: true });
  // No replay of the original live error. Restore from the broker snapshot only.
  await mockAgent.disconnect();
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(agent => agent.id === id && agent.online), mockAgent.agentId)).toBe(false);
  await mockAgent.connect();
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(agent => agent.id === id && agent.online), mockAgent.agentId)).toBe(true);
  await page.evaluate(() => { window.Pinia.useChatStore().vpStatuses = {}; });
  await expect(toggle).toHaveCount(0);
  broker.broadcastSnapshot({ sessionId: owner.sessionId });
  await expect(toggle).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Show Session status', exact: true }).click();
  await toggle.click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await expect(details).toContainText('PROVIDER_FAILED');
    expect(await details.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await details.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`vp-error-${theme}-320.png`), fullPage: true });
  }
  await page.evaluate(() => window.Pinia.useChatStore().changeLocale('zh-CN'));
  await expect(toggle).toContainText('出错');
  await expect(details).toContainText('错误码');
  broker.transition({ ...owner, state: 'thinking', turnId: 'recovery-turn' });
  await expect(toggle).toHaveCount(0);
  await expect(details).toHaveCount(0);
  broker.transition({ ...owner, state: 'error', turnId: 'legacy-failure' });
  await toggle.click();
  await expect(details).toContainText('此 Agent 未保留错误详情');

  // A new user Turn normally gets its own broker thread. Keep the failed
  // thread in the broker (and the earlier response in the transcript).
  const old = { ...owner, turnId: 'legacy-failure' };
  const oldRoot = { userTurnId: 'old-root', startedAt: Date.now() - 10_000, state: 'errored', executions: [{ ...old, state: 'errored' }] };
  const turns = (...rows) => send({ type: 'session_turns', sessionId: owner.sessionId, turns: rows });
  turns(oldRoot);
  mockAgent.send({ type: 'yeaft_output', conversationId, ...old, userTurnId: oldRoot.userTurnId,
    data: { type: 'assistant', message: { content: 'Earlier failure in the transcript' } } });
  const sendCount = mockAgent.messages('yeaft_session_send').length;
  await page.getByRole('button', { name: '关闭 Session 状态', exact: true }).click();
  const composer = page.locator('.chat-composer textarea');
  await composer.fill('Try again as a new Turn');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => mockAgent.messages('yeaft_session_send').length).toBe(sendCount + 1);
  const request = mockAgent.messages('yeaft_session_send').at(-1);
  expect(request.sessionId).toBe(owner.sessionId);
  const next = { ...owner, turnId: 'next-turn', threadId: 'next-thread' };
  const nextRoot = { userTurnId: request.id, startedAt: Date.now(), state: 'running', executions: [{ ...next, state: 'running' }] };
  send({ type: 'user_message_routed', sessionId: owner.sessionId, messageId: request.id, userTurnId: request.id, relation: 'new' });
  turns(oldRoot, nextRoot);
  send({ ...next, type: 'vp_turn_start', userTurnId: nextRoot.userTurnId });
  broker.transition({ ...next, state: 'tool' });
  send({ ...next, type: 'query_progress', revision: 1, stage: 'running', reason: null, lastEvidenceAt: null,
    modelRequests: 1, toolExecutions: 1, reusedCalls: 0, repeatedCalls: 0, failedCalls: 0, stagnantBatches: 0,
    inputTokens: 777, outputTokens: 44 });
  await expect(page.getByText('Earlier failure in the transcript')).toBeVisible();
  await page.evaluate(() => window.Pinia.useChatStore().changeLocale('en'));
  await page.getByRole('button', { name: 'Show Session status', exact: true }).click();
  await expect(toggle).toHaveCount(0);
  await expect(details).toHaveCount(0);
  await expect(page.locator('.yeaft-session-activity')).toContainText('Try again as a new Turn');
  await expect(page.locator('.yeaft-query-progress')).toContainText('777');
  await expect(page.locator('.yeaft-vp-timeline-abort')).toBeVisible();
  send({ ...next, type: 'vp_turn_end', reason: 'end_turn' });
  turns(oldRoot, { ...nextRoot, state: 'completed', executions: [{ ...next, state: 'completed' }] });
  broker.settleIdle(next);
  broker.broadcastSnapshot({ sessionId: owner.sessionId });
  await expect(page.locator('.yeaft-vp-timeline-abort')).toHaveCount(0);
  await expect(toggle).toHaveCount(0);
  expect(broker.snapshot(owner.sessionId)[0].threads).toContainEqual(expect.objectContaining({ state: 'error', turnId: old.turnId }));
});
