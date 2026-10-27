import { expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { createSessionFromSpec, copySession, mergeSessions, snapshotSessions } from '../../../agent/yeaft/sessions/session-crud.js';
import { test } from '../../fixtures/test-server.js';

// The first case uses real browser/Server/Agent WebSockets and disk CRUD without
// an LLM. The remaining cases intercept the browser transport to inject hostile
// acknowledgements that must never complete another Agent's or view's operation.
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

test('turn fork and divergent merge relay through Server, persist history and inherit the initiating Project', async ({ chatPage: page, mockAgent }) => {
  const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-browser-merge-'));
  const store = new ConversationStore(yeaftDir);
  const source = createSessionFromSpec(yeaftDir, { name: 'Initiator', roster: ['omni'], defaultVpId: 'omni', workDir: yeaftDir });
  const acknowledgements = [];
  const appendTurn = (sessionId, turnId, question, answer, seconds) => {
    const time = `2026-10-27T00:00:0${seconds}.000Z`;
    const user = store.append({ sessionId, role: 'user', content: question, turnId, time });
    store.append({ sessionId, role: 'assistant', content: answer, turnId, time,
      causalRootId: user.id, speakerVpId: 'omni', stopReason: 'end_turn' });
  };
  const publish = () => mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: snapshotSessions(yeaftDir) } });
  const handler = request => {
    if (request.type === 'yeaft_load_history' && request.limit !== 0) {
      const messages = new ConversationStore(yeaftDir).loadAllBySession(request.sessionId)
        .map(row => ({ ...row, seq: Number(row.id.slice(1)), ts: Date.parse(row.time) }));
      mockAgent.send({ type: 'yeaft_history_chunk', sessionId: request.sessionId, requestId: request.requestId,
        mode: 'recent', messages, oldestSeq: messages[0]?.seq ?? null,
        latestSeq: messages.at(-1)?.seq ?? null, hasMore: false });
    }
    if (!['yeaft_copy_session', 'yeaft_merge_sessions'].includes(request.type)) return;
    const op = request.type === 'yeaft_copy_session' ? 'copy' : 'merge';
    let event;
    try {
      const session = op === 'copy'
        ? copySession(yeaftDir, request.sessionId, request)
        : mergeSessions(yeaftDir, request.sessionId, request.otherSessionId, request);
      event = { type: 'session_crud_result', op, ok: true, requestId: request.requestId,
        sourceSessionId: request.sessionId, otherSessionId: request.otherSessionId, session };
    } catch (error) {
      event = { type: 'session_crud_result', op, ok: false, requestId: request.requestId,
        sourceSessionId: request.sessionId, otherSessionId: request.otherSessionId,
        error: { code: error.code, message: error.message } };
    }
    acknowledgements.push(event);
    // No browser sendWsMessage/handleYeaftOutput overrides: the real Server must
    // correlate the response, inherit membership, and publish its catalog.
    mockAgent.send({ type: 'yeaft_output', event });
    publish();
  };
  mockAgent._messageHandlers.push(handler);
  try {
    appendTurn(source.id, 'prior', 'Prior question', 'Prior completed answer', 1);
    appendTurn(source.id, 'current', 'Current question', 'Current unfinished answer', 5);
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities });
    publish();
    const open = async sessionId => {
      await expect.poll(() => page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sidebarSessionCatalog
        .some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId), { agentId: mockAgent.agentId, sessionId })).toBe(true);
      await page.evaluate(({ agentId, sessionId }) => {
        const chat = window.Pinia.useChatStore();
        chat.openCatalogSession(chat.sidebarSessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
        chat.closeSessionSidebar();
      }, { agentId: mockAgent.agentId, sessionId });
    };
    const project = await page.evaluate(async ({ agentId, sessionId }) => {
      const chat = window.Pinia.useChatStore();
      const created = await chat.mutateProject('create', { name: 'Initiating Project' }, agentId);
      const moved = await chat.mutateProject('move_session', { sessionId, projectId: created.result?.id }, agentId);
      return { created, moved };
    }, { agentId: mockAgent.agentId, sessionId: source.id });
    expect(project.created.ok).toBe(true);
    expect(project.moved.ok).toBe(true);
    const projectId = project.created.result.id;
    const inventory = () => page.evaluate(agentId => {
      const chat = window.Pinia.useChatStore();
      return chat.sidebarSessionCatalog.filter(row => row.routeRef.agentId === agentId)
        .map(row => ({ sessionId: row.routeRef.sessionId, projectId: row.projectId }));
    }, mockAgent.agentId);
    await open(source.id);
    await expect.poll(inventory).toContainEqual({ sessionId: source.id, projectId });
    await expect(page.locator('.assistant-turn').filter({ hasText: 'Prior completed answer' })).toBeVisible();
    const expectUnsupported = async (request, code) => {
      mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['work_center', 'plaintext-ok'] });
      await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().agents
        .find(agent => agent.id === agentId)?.capabilities, mockAgent.agentId)).toEqual(['work_center', 'plaintext-ok']);
      // Bypass only the UI capability gate, not transport or response handling:
      // an outdated client must receive a real correlated Server rejection.
      const response = await page.evaluate(({ agentId, request }) => new Promise((resolve, reject) => {
        const chat = window.Pinia.useChatStore();
        const socket = chat.ws;
        const timeout = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('Missing capability rejection')); }, 5000);
        const onMessage = message => {
          const frame = JSON.parse(message.data);
          const event = frame.type === 'yeaft_output' ? frame.event : frame;
          if (event?.type !== 'session_crud_result' || event.requestId !== request.requestId) return;
          clearTimeout(timeout);
          socket.removeEventListener('message', onMessage);
          resolve(event);
        };
        socket.addEventListener('message', onMessage);
        chat.sendWsMessage({ ...request, agentId });
      }), { agentId: mockAgent.agentId, request });
      expect(response).toMatchObject({ ok: false, requestId: request.requestId, error: { code } });
      expect(mockAgent.messages(request.type).some(message => message.requestId === request.requestId)).toBe(false);
      mockAgent.send({ type: 'agent_capabilities_updated', capabilities });
      await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().agents
        .find(agent => agent.id === agentId)?.capabilities, mockAgent.agentId)).toEqual(capabilities);
    };
    await expectUnsupported({ type: 'yeaft_copy_session', requestId: 'unsupported-turn-fork', sessionId: source.id, throughTurnId: 'prior' }, 'session_fork_from_turn_unsupported');
    await page.evaluate(({ agentId, sessionId }) => {
      const chat = window.Pinia.useChatStore();
      chat.activeVpTurns.current = { turnId: 'current', sessionId, agentId };
      chat.agents.find(agent => agent.id === agentId).capabilities = ['work_center', 'session_fork_from_turn'];
    }, { agentId: mockAgent.agentId, sessionId: source.id });
    const fork = page.locator('.yeaft-session-actions .yeaft-fork-btn:not(.yeaft-merge-btn)');
    const prior = page.locator('.assistant-turn').filter({ hasText: 'Prior completed answer' });
    const current = page.locator('.assistant-turn').filter({ hasText: 'Current unfinished answer' });
    await expect(fork).toBeDisabled();
    await expect(prior.locator('.fork-turn-action-btn')).toBeDisabled();
    await expect(current.locator('.fork-turn-action-btn')).toHaveCount(0);
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities });
    await expect(fork).toBeEnabled();
    await expect(prior.locator('.fork-turn-action-btn')).toBeEnabled();
    await expect(current.locator('.fork-turn-action-btn')).toHaveCount(0);
    await expect(page.locator('.yeaft-merge-btn')).toBeDisabled();
    await prior.hover();
    await prior.locator('.fork-turn-action-btn').click();
    const copyRequest = await mockAgent.waitForMessage('yeaft_copy_session');
    expect(copyRequest).toMatchObject({ sessionId: source.id, throughTurnId: 'prior' });
    expect(copyRequest.requestId).toBeTruthy();
    await expect.poll(() => acknowledgements.find(event => event.requestId === copyRequest.requestId)).toMatchObject({ ok: true, op: 'copy' });
    const copied = acknowledgements.find(event => event.requestId === copyRequest.requestId).session;
    expect(copied.copiedMessageCount).toBe(2);
    await expect.poll(inventory).toContainEqual({ sessionId: copied.id, projectId });
    await expectUnsupported({ type: 'yeaft_merge_sessions', requestId: 'unsupported-merge', sessionId: source.id, otherSessionId: copied.id }, 'session_merge_unsupported');
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(copied.id);
    expect(new ConversationStore(yeaftDir).loadAllBySession(copied.id).map(row => row.content)).toEqual(['Prior question', 'Prior completed answer']);
    appendTurn(copied.id, 'branch', 'Branch question', 'Branch completed answer', 3);
    const sourceBefore = new ConversationStore(yeaftDir).loadAllBySession(source.id);
    const copiedBefore = new ConversationStore(yeaftDir).loadAllBySession(copied.id);
    // A conflicting Project on the other branch must not override the initiator.
    const otherProject = await page.evaluate(async ({ agentId, sessionId }) => {
      const chat = window.Pinia.useChatStore();
      delete chat.activeVpTurns.current;
      const created = await chat.mutateProject('create', { name: 'Other Project' }, agentId);
      const moved = await chat.mutateProject('move_session', { sessionId, projectId: created.result?.id }, agentId);
      return { created, moved };
    }, { agentId: mockAgent.agentId, sessionId: copied.id });
    expect(otherProject.created.ok).toBe(true);
    expect(otherProject.moved.ok).toBe(true);
    await open(source.id);
    const dialog = await openMerge(page);
    await dialog.locator('select').selectOption(copied.id);
    await dialog.getByRole('button', { name: 'Merge Sessions', exact: true }).click();
    const mergeRequest = await mockAgent.waitForMessage('yeaft_merge_sessions');
    expect(mergeRequest).toMatchObject({ sessionId: source.id, otherSessionId: copied.id });
    expect(mergeRequest.requestId).toBeTruthy();
    expect(mergeRequest.requestId).not.toBe(copyRequest.requestId);
    await expect.poll(() => acknowledgements.find(event => event.requestId === mergeRequest.requestId)).toMatchObject({ ok: true, op: 'merge' });
    const merged = acknowledgements.find(event => event.requestId === mergeRequest.requestId).session;
    expect(merged).toMatchObject({ copiedMessageCount: 6, sharedTurnCount: 1 });
    expect([source.id, copied.id]).not.toContain(merged.id);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute)).toMatchObject({ agentId: mockAgent.agentId, sessionId: merged.id });
    const expected = ['Prior question', 'Prior completed answer', 'Branch question', 'Branch completed answer', 'Current question', 'Current unfinished answer'];
    const mergedRows = new ConversationStore(yeaftDir).loadAllBySession(merged.id);
    expect(mergedRows.map(row => row.content)).toEqual(expected);
    expect(new Set(mergedRows.map(row => row.id)).size).toBe(6);
    expect(new ConversationStore(yeaftDir).loadAllBySession(source.id)).toEqual(sourceBefore);
    expect(new ConversationStore(yeaftDir).loadAllBySession(copied.id)).toEqual(copiedBefore);
    await expect(page.locator('.assistant-turn')).toHaveCount(3);
    await expect(page.locator('.assistant-turn')).toHaveText(expected.filter((_, index) => index % 2).map(text => new RegExp(text)));
    await expect.poll(inventory).toEqual(expect.arrayContaining([
      { sessionId: source.id, projectId }, { sessionId: copied.id, projectId: otherProject.created.result.id },
      { sessionId: merged.id, projectId },
    ]));
    // Fresh browser state must reconstruct Server-owned membership and history,
    // not merely retain an optimistic CRUD-result projection.
    await page.reload();
    await page.waitForFunction(agentId => window.Pinia?.useChatStore?.().agents
      .some(agent => agent.id === agentId && agent.status === 'ready'), mockAgent.agentId);
    await expect.poll(inventory).toEqual(expect.arrayContaining([
      { sessionId: source.id, projectId }, { sessionId: copied.id, projectId: otherProject.created.result.id },
      { sessionId: merged.id, projectId },
    ]));
    await open(merged.id);
    await expect(page.locator('.assistant-turn')).toHaveCount(3);
    await expect(page.locator('.assistant-turn')).toHaveText(expected.filter((_, index) => index % 2).map(text => new RegExp(text)));
    expect(mockAgent.messages('yeaft_copy_session')).toHaveLength(1);
    expect(mockAgent.messages('yeaft_merge_sessions')).toHaveLength(1);
  } finally {
    mockAgent._messageHandlers = mockAgent._messageHandlers.filter(candidate => candidate !== handler);
    await closeConversationHistoryIndexes();
    rmSync(yeaftDir, { recursive: true, force: true });
  }
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
