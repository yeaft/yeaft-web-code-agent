import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

// Real app/store/components, deterministic histories and CRUD acknowledgements.
// The merge wire is captured at the browser transport boundary so this focused
// UI suite also runs against the pre-merge Server during a rolling upgrade.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

const A = 'branch-a', B = 'branch-b';
const capabilities = ['work_center', 'plaintext-ok', 'session_fork_from_turn', 'session_fork_while_running', 'session_merge'];

async function setup(page, mockAgent) {
  mockAgent._messageHandlers.push(request => {
    if (request.type !== 'yeaft_load_history' || request.limit === 0) return;
    const identity = { sessionId: request.sessionId, speakerVpId: 'omni', ts: Date.now() };
    mockAgent.send({ type: 'yeaft_history_chunk', sessionId: request.sessionId, requestId: request.requestId,
      mode: 'recent', messages: [
        { ...identity, id: 'm1', seq: 1, turnId: 'prior', role: 'user', content: 'Prior question' },
        { ...identity, id: 'm2', seq: 2, turnId: 'prior', role: 'assistant', content: 'Prior completed answer' },
        { ...identity, id: 'm3', seq: 3, turnId: 'current', role: 'user', content: 'Current question' },
        { ...identity, id: 'm4', seq: 4, turnId: 'current', role: 'assistant', content: 'Current unfinished answer' },
      ], oldestSeq: 1, latestSeq: 4, hasMore: false,
    });
  });
  mockAgent.send({ type: 'agent_capabilities_updated', capabilities });
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [
    { id: A, name: 'Initiator', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/branch-a' },
    { id: B, name: 'Other Session with a long title '.repeat(8), roster: ['omni'], defaultVpId: 'omni' },
    { id: 'busy', name: 'Busy Session', roster: ['omni'], defaultVpId: 'omni' },
  ] } });
  await expect.poll(() => page.evaluate(({ agentId, id }) => window.Pinia.useChatStore().sidebarSessionCatalog
    .some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === id), { agentId: mockAgent.agentId, id: A })).toBe(true);
  await page.evaluate(({ agentId, id }) => {
    const chat = window.Pinia.useChatStore();
    chat.openCatalogSession(chat.sidebarSessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === id));
    chat.closeSessionSidebar();
    const send = chat.sendWsMessage.bind(chat);
    window.__branchRequests = [];
    chat.sendWsMessage = message => {
      if (['yeaft_copy_session', 'yeaft_merge_sessions'].includes(message.type)) {
        window.__branchRequests.push(message);
        return true;
      }
      return send(message);
    };
    chat.activeVpTurns['busy-turn'] = { turnId: 'busy-turn', sessionId: 'busy', agentId };
  }, { agentId: mockAgent.agentId, id: A });
  await expect(page.locator('.assistant-turn').filter({ hasText: 'Prior completed answer' })).toBeVisible();
  await expect(page.locator('.yeaft-merge-btn')).toBeVisible();
}

async function result(page, mockAgent, overrides = {}) {
  await page.evaluate(({ agentId, overrides }) => {
    const chat = window.Pinia.useChatStore();
    const request = window.__branchRequests.at(-1);
    chat.handleYeaftOutput({ agentId, event: {
      type: 'session_crud_result', op: request.type === 'yeaft_merge_sessions' ? 'merge' : 'copy',
      requestId: request.requestId, sourceSessionId: request.sessionId, otherSessionId: request.otherSessionId,
      ok: true, session: { id: 'new-session', name: 'Merged Session', roster: ['omni'] }, ...overrides,
    } });
  }, { agentId: mockAgent.agentId, overrides });
}

async function openMerge(page) {
  await page.getByRole('button', { name: 'Merge Sessions', exact: true }).click();
  return page.getByRole('dialog', { name: 'Merge Sessions', exact: true });
}

test('running Session forks require capability and only completed responses expose turn fork', async ({ chatPage: page, mockAgent }) => {
  await setup(page, mockAgent);
  await page.evaluate(agentId => {
    const chat = window.Pinia.useChatStore();
    chat.activeVpTurns.current = { turnId: 'current', sessionId: 'branch-a', agentId };
    chat.agents.find(agent => agent.id === agentId).capabilities = ['work_center', 'session_fork_from_turn'];
  }, mockAgent.agentId);
  const fork = page.locator('.yeaft-session-actions .yeaft-fork-btn:not(.yeaft-merge-btn)');
  const prior = page.locator('.assistant-turn').filter({ hasText: 'Prior completed answer' });
  const current = page.locator('.assistant-turn').filter({ hasText: 'Current unfinished answer' });
  await expect(fork).toBeDisabled();
  await expect(prior.locator('.fork-turn-action-btn')).toBeDisabled();
  await expect(current.locator('.fork-turn-action-btn')).toHaveCount(0);
  await page.evaluate(agentId => window.Pinia.useChatStore().agents.find(agent => agent.id === agentId)
    .capabilities.push('session_fork_while_running'), mockAgent.agentId);
  await expect(fork).toBeEnabled();
  await expect(prior.locator('.fork-turn-action-btn')).toBeEnabled();
  await expect(current.locator('.fork-turn-action-btn')).toHaveCount(0);
  await expect(page.locator('.yeaft-merge-btn')).toBeDisabled();
  await prior.hover();
  await prior.locator('.fork-turn-action-btn').click();
  expect(await page.evaluate(() => window.__branchRequests.at(-1))).toMatchObject({ type: 'yeaft_copy_session', sessionId: A, throughTurnId: 'prior' });
  await result(page, mockAgent, { ok: false, error: { code: 'invalid_fork_boundary' } });
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await fork.click();
  const request = await page.evaluate(() => window.__branchRequests.at(-1));
  expect(request).toMatchObject({ type: 'yeaft_copy_session', sessionId: A });
  expect(request).not.toHaveProperty('throughTurnId');
  await result(page, mockAgent);
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe('new-session');
});

test('merge modal filters sources, handles errors and opens only the correlated new Session', async ({ chatPage: page, mockAgent }, info) => {
  await setup(page, mockAgent);
  await page.evaluate(agentId => {
    const chat = window.Pinia.useChatStore();
    // Same bare ID on another Agent must never be selectable or accepted.
    chat.agents.push({ id: 'other-agent', online: true, capabilities: ['session_merge'] });
    window.Pinia.useSessionsStore().applySnapshotUpsert({ id: 'branch-b', name: 'Cross-Agent' }, 'other-agent');
    chat.agents.push({ id: 'offline-agent', online: false, capabilities: ['session_merge'] });
    window.Pinia.useSessionsStore().applySnapshotUpsert({ id: 'offline', name: 'Offline' }, 'offline-agent');
  }, mockAgent.agentId);
  const dialog = await openMerge(page);
  const select = dialog.locator('select');
  await expect(select).toBeFocused();
  await expect(select.locator('option:not(:disabled)')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Merge Sessions', exact: true })).toBeDisabled();
  await select.selectOption(B);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await dialog.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.right <= innerWidth && rect.left >= 0 && rect.height < innerHeight * 0.75;
    })).toBe(true);
    expect(await dialog.locator('h3').evaluate(el => getComputedStyle(el).color)).toBe(await dialog.locator('label').evaluate(el => getComputedStyle(el).color));
    expect(await dialog.getByRole('button', { name: 'Merge Sessions', exact: true }).evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`merge-${theme}-320.png`) });
  }
  await dialog.getByRole('button', { name: 'Merge Sessions', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.locator('.modal-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__branchRequests.at(-1))).toMatchObject({ type: 'yeaft_merge_sessions', agentId: mockAgent.agentId, sessionId: A, otherSessionId: B });
  await result(page, mockAgent, { ok: false, error: { code: 'session_running' } });
  await expect(dialog.getByRole('alert')).toContainText('responding');
  await expect(dialog.getByRole('alert')).toBeFocused();
  await dialog.getByRole('button', { name: 'Merge Sessions', exact: true }).click();
  await result(page, { agentId: 'other-agent' });
  await expect(dialog.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled();
  await result(page, mockAgent, { op: 'rename' });
  await expect(dialog.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled();
  await result(page, mockAgent, { session: { id: 'wrong', agentId: 'other-agent' } });
  await expect(dialog.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled();
  await result(page, mockAgent, { sourceSessionId: 'wrong' });
  await expect(dialog.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled();
  await result(page, mockAgent, { otherSessionId: 'cross' });
  await expect(dialog.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled();
  await result(page, mockAgent, { requestId: 'another-tab' });
  await expect(dialog.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(A);
  await result(page, mockAgent);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe('new-session');
  expect(await page.evaluate(agentId => [ 'branch-a', 'branch-b', 'new-session' ].every(id => !!window.Pinia.useSessionsStore().sessionById(id, agentId)), mockAgent.agentId)).toBe(true);
});

test('merge empty, unsupported and closed or stale operations never steal navigation', async ({ chatPage: page, mockAgent }) => {
  await setup(page, mockAgent);
  await page.evaluate(agentId => {
    const chat = window.Pinia.useChatStore();
    chat.agents.find(agent => agent.id === agentId).capabilities = ['work_center'];
  }, mockAgent.agentId);
  await expect(page.locator('.yeaft-merge-btn')).toBeDisabled();
  await page.evaluate(({ agentId, caps }) => {
    const chat = window.Pinia.useChatStore();
    chat.agents.find(agent => agent.id === agentId).capabilities = caps;
    chat.activeVpTurns.other = { turnId: 'other', sessionId: 'branch-b', agentId };
  }, { agentId: mockAgent.agentId, caps: capabilities });
  let dialog = await openMerge(page);
  await expect(dialog.getByRole('status')).toContainText('No other idle');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.yeaft-merge-btn')).toBeFocused();
  await page.evaluate(() => { delete window.Pinia.useChatStore().activeVpTurns.other; });
  dialog = await openMerge(page);
  await dialog.locator('select').selectOption(B);
  await dialog.getByRole('button', { name: 'Merge Sessions', exact: true }).click();
  await page.keyboard.press('Escape');
  await result(page, mockAgent);
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().sessionMergePendingKey)).toBeNull();
  expect(await page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(A);
  dialog = await openMerge(page);
  await dialog.locator('select').selectOption(B);
  await dialog.getByRole('button', { name: 'Merge Sessions', exact: true }).click();
  await page.evaluate(() => window.Pinia.useChatStore().chatHistoryConnectionGeneration++);
  await expect(dialog).toHaveCount(0);
  await result(page, mockAgent);
  expect(await page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(A);
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().sessionMergePendingKey)).toBeNull();
  // Re-entering the same route must not authorize an abandoned view's result.
  dialog = await openMerge(page);
  await dialog.locator('select').selectOption(B);
  await dialog.getByRole('button', { name: 'Merge Sessions', exact: true }).click();
  await page.evaluate(() => {
    const chat = window.Pinia.useChatStore();
    chat.currentView = 'chat';
  });
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => { window.Pinia.useChatStore().currentView = 'yeaft'; });
  await result(page, mockAgent);
  expect(await page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(A);
});
