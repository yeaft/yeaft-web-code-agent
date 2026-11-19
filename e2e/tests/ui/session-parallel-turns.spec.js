import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { OTHER_SESSION, SESSION, pane, sessionTurnsFixture } from '../../helpers/session-turns.js';

// Run the actual browser modules, not component stubs or injected message arrays.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

test('one native Session turn retains the ordinary transcript and merges appended tools across replay', async ({ chatPage: page, mockAgent }, info) => {
  const wire = await sessionTurnsFixture(page, mockAgent);
  const turn = await wire.send('Single root question');
  wire.delta(turn, 'Single answer begins');
  await expect(page.locator('.assistant-turn').filter({ hasText: 'Single answer begins' })).toBeVisible();
  await expect(page.locator('.parallel-turn-tabs')).toHaveCount(0);
  wire.tool(turn, 'before-append', 'Read');
  await wire.send('Extra detail for the same turn', turn);
  wire.tool(turn, 'after-append', 'Grep');
  // A new assistant row after a tool loop, not a delta into the old text row.
  wire.delta(turn, 'Appended answer finishes.', 'reply-after-append');
  const answer = page.locator('.assistant-turn');
  await expect(answer).toHaveCount(1);
  await expect(answer).toContainText('Single answer begins');
  await expect(answer).toContainText('Appended answer finishes.');
  await expect(answer.locator('.turn-actions')).toHaveCount(1);
  await answer.getByRole('button', { name: '1 more', exact: true }).click();
  await expect(answer.locator('.tool-line')).toHaveCount(2);
  await expect(page.locator('.vp-turn-block')).toHaveCount(1);
  await expect(page.locator('.message-user-block').filter({ hasText: 'Extra detail for the same turn' })).toHaveCount(1);
  wire.finish(turn);
  await expect(answer).not.toHaveClass(/streaming/);
  await page.reload();
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
  await wire.open();
  await expect(answer).toHaveCount(1);
  await expect(answer).toContainText('Single answer begins');
  await expect(answer).toContainText('Appended answer finishes.');
  await expect(answer.locator('.turn-actions')).toHaveCount(1);
  await answer.getByRole('button', { name: '1 more', exact: true }).click();
  await expect(answer.locator('.tool-line')).toHaveCount(2);
  await expect(page.locator('.message-block')).toHaveCount(1);
  for (const [theme, width] of [['light', 1400], ['dark', 320]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`append-merged-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await expect(page.locator('.parallel-turn-region')).toHaveCount(0);
  await expect(page.locator('.message-user-block').filter({ hasText: 'Single root question' })).toHaveCount(1);
});

test('same-VP concurrent roots isolate interleaved streams, supplement and completion with bounded responsive panes', async ({ chatPage: page, mockAgent }, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const wire = await sessionTurnsFixture(page, mockAgent);
  const a = await wire.send('Root A first');
  wire.delta(a, 'A-only initial');
  // Single-turn mode keeps the user's Workbench choice unchanged.
  await page.evaluate(() => window.Pinia.useChatStore().openWorkbench());
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().workbenchExpanded)).toBe(true);
  const b = await wire.send('Root B second');
  wire.delta(b, 'B-only initial');
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().workbenchExpanded)).toBe(false);
  await page.evaluate(() => window.Pinia.useChatStore().openWorkbench());
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().workbenchExpanded)).toBe(true);
  wire.delta(a, ' A-only continuation');
  wire.delta(b, ' B-only continuation');
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
  expect(await page.evaluate(() => window.Pinia.useChatStore().workbenchExpanded)).toBe(true);
  // Close it again for the full-width responsive geometry assertions below.
  await page.evaluate(() => window.Pinia.useChatStore().toggleWorkbench());
  await expect(pane(page, a)).toContainText('A-only initial A-only continuation');
  await expect(pane(page, b)).toContainText('B-only initial B-only continuation');
  await expect(pane(page, a)).not.toContainText('B-only');
  await expect(pane(page, b)).not.toContainText('A-only');

  wire.tool(a, 'parallel-before', 'Read');
  await wire.send('Supplement belongs to A', a);
  wire.tool(a, 'parallel-after', 'Grep');
  wire.delta(a, 'A response after supplement.', 'parallel-append-reply');
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
  await expect(pane(page, a).locator('.assistant-turn')).toHaveCount(1);
  await expect(pane(page, a).locator('.turn-actions')).toHaveCount(1);
  await pane(page, a).getByRole('button', { name: '1 more', exact: true }).click();
  await expect(pane(page, a).locator('.tool-line')).toHaveCount(2);
  await expect(pane(page, a)).toContainText('Supplement belongs to A');
  await expect(pane(page, b)).not.toContainText('Supplement belongs to A');
  const c = await wire.send('Root C third');
  wire.delta(c, 'C-only response');
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(3);
  const d = await wire.send('Root D fourth');
  const e = await wire.send('Root E fifth');
  wire.delta(d, 'D-only response');
  wire.delta(e, 'E-only response ' + 'long_unbroken_output_'.repeat(30));
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(5);
  const tabs = page.locator('.parallel-turn-tabs').getByRole('tab');
  await expect(tabs).toHaveCount(5);
  const track = page.locator('.parallel-turn-track');
  await expect.poll(() => track.evaluate(el => el.scrollWidth > el.clientWidth + 20)).toBe(true);
  // Five columns must not be squeezed into the viewport; at most three fit.
  await expect.poll(() => track.evaluate(el => {
    const width = el.clientWidth;
    const pane = el.querySelector('.parallel-turn-pane').getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    // Account for both real inter-column gaps rather than a fixed allowance.
    return pane >= (width - 2 * gap) / 3 - 1 && pane <= width + 1;
  })).toBe(true);

  for (const [theme, width] of [['light', 1600], ['dark', 320]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.evaluate(() => window.Pinia.useChatStore().closeSessionSidebar());
    await expect.poll(() => page.locator('.chat-container').evaluate(el => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
    await tabs.last().focus();
    await page.keyboard.press('Enter');
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => track.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(() => pane(page, e).evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= -1 && rect.right <= innerWidth + 1;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 320) {
      const narrowPane = await pane(page, e).evaluate(el => el.getBoundingClientRect().width);
      expect(narrowPane).toBeGreaterThanOrEqual(250);
    }
    await expect(pane(page, e).getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`parallel-five-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
  }

  // B completes before A: only B leaves the live region, while A continues.
  wire.finish(b);
  await expect(pane(page, b)).toHaveCount(0);
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(4);
  const completedB = page.locator('.assistant-turn').filter({ hasText: 'B-only initial B-only continuation' });
  await expect(completedB).toHaveCount(1);
  expect(await completedB.evaluate(el => !el.closest('.parallel-turn-region'))).toBe(true);
  wire.delta(a, ' A survives B completion');
  await expect(pane(page, a)).toContainText('A survives B completion');
  for (const turn of [e, d, c, a]) wire.finish(turn);
  await expect(page.locator('.parallel-turn-region')).toHaveCount(0);
  // Completed history remains virtualized. Read it by scrolling, rather than
  // requiring off-window roots to exist simultaneously in the DOM.
  const scroller = page.locator('.chat-container');
  await scroller.focus();
  await page.keyboard.press('Home');
  const questions = [];
  let foundA = false;
  for (let step = 0; step < 50; step += 1) {
    const sample = await scroller.evaluate(async (el, step) => {
      el.scrollTop = step * el.clientHeight * .65;
      el.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { top: el.scrollTop, end: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
        questions: [...el.querySelectorAll('.message-user-block')].map(row => row.textContent.trim()),
        foundA: [...el.querySelectorAll('.assistant-turn')].some(row => [
          'A-only initial A-only continuation', 'A response after supplement.', 'A survives B completion',
        ].every(text => row.textContent.includes(text))) };
    }, step);
    for (const text of sample.questions) if (!questions.includes(text)) questions.push(text);
    foundA ||= sample.foundA;
    if (sample.end) break;
  }
  // Finished roots read in the order they finished (B, then E, D, C, A).
  expect(questions).toEqual([
    'Root B second', 'Root E fifth', 'Root D fourth', 'Root C third', 'Root A first', 'Supplement belongs to A',
  ]);
  expect(foundA).toBe(true);
});

test('a later root that finishes first settles above the remaining lane, which survives Session navigation and reload', async ({ chatPage: page, mockAgent }, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const wire = await sessionTurnsFixture(page, mockAgent);
  const a = await wire.send('Earlier long question');
  wire.delta(a, 'A is still researching');
  const b = await wire.send('Later quick question');
  wire.delta(b, 'B answered quickly');
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
  // Each lane names its question, and one rule separates the lanes. With both
  // lanes on screen the tab strip would only repeat the headers.
  await expect(pane(page, a).locator('.concurrent-turn-title')).toHaveText('Earlier long question');
  await expect(pane(page, b).locator('.concurrent-turn-state')).toHaveText('Running');
  await expect(page.locator('.parallel-turn-tabs')).toBeHidden();
  expect(await pane(page, b).evaluate(el => getComputedStyle(el, '::before').width)).toBe('1px');
  expect(await pane(page, a).evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
  for (const [theme, width] of [['light', 1400], ['dark', 320]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.evaluate(() => window.Pinia.useChatStore().closeSessionSidebar());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // One lane fits at 320px, so the tab strip returns as navigation.
    await expect(page.locator('.parallel-turn-tabs')).toBeVisible({ visible: width === 320 });
    await page.screenshot({ path: info.outputPath(`lanes-${theme}-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  const settledAboveLane = () => page.evaluate((text) => {
    const region = document.querySelector('.parallel-turn-region');
    const answer = [...document.querySelectorAll('.assistant-turn')]
      .find(el => el.textContent.includes(text) && !el.closest('.parallel-turn-region'));
    return !!region && !!answer && !!(answer.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, 'B answered quickly');
  wire.finish(b);
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(1);
  await expect(pane(page, a)).toContainText('A is still researching');
  await expect.poll(settledAboveLane).toBe(true);
  // Reopening the Session restores the same layout instead of one column with
  // the live answer above the finished one.
  await wire.open(OTHER_SESSION);
  await expect(page.locator('.parallel-turn-region')).toHaveCount(0);
  wire.delta(a, ' while away');
  await wire.open(SESSION);
  await expect(pane(page, a)).toContainText('A is still researching while away');
  await expect.poll(settledAboveLane).toBe(true);
  // The earlier question settles after the answer that finished first.
  wire.finish(a);
  await expect(page.locator('.parallel-turn-region')).toHaveCount(0);
  const questions = () => page.locator('.message-user-block').allTextContents().then(rows => rows.map(row => row.trim()));
  await expect.poll(questions).toEqual(['Later quick question', 'Earlier long question']);
  await page.reload();
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
  await wire.open(SESSION);
  await expect.poll(questions).toEqual(['Later quick question', 'Earlier long question']);
});

test('Session navigation and reconnect snapshots restore roots; stopping one execution leaves its same-VP peer streaming', async ({ chatPage: page, mockAgent }) => {
  test.setTimeout(60000);
  const wire = await sessionTurnsFixture(page, mockAgent);
  const a = await wire.send('Recover root A');
  wire.delta(a, 'Recovery A text');
  const b = await wire.send('Recover root B');
  wire.delta(b, 'Recovery B text');
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
  await wire.open(OTHER_SESSION);
  await expect(page.locator('.parallel-turn-region')).toHaveCount(0);
  await expect(page.locator('.chat-container')).not.toContainText('Recovery A text');
  wire.delta(b, ' while another Session is open');
  await wire.open(SESSION);
  await expect(pane(page, b)).toContainText('Recovery B text while another Session is open');

  const agentId = mockAgent.agentId;
  await mockAgent.disconnect();
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(agent => agent.id === id && agent.online), agentId)).toBe(false);
  await mockAgent.connect();
  expect(mockAgent.agentId).toBe(agentId);
  await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.some(agent => agent.id === id && agent.online), agentId)).toBe(true);
  wire.snapshot();
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
  // A fresh browser store must rebuild ownership from history + snapshots,
  // rather than merely retaining the old component's local state.
  await page.reload();
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), agentId);
  await wire.open(SESSION);
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
  await expect(pane(page, a)).toContainText('Recovery A text');
  await expect(pane(page, b)).toContainText('Recovery B text while another Session is open');
  const before = mockAgent.messages('yeaft_abort_turn').length;
  await pane(page, a).getByRole('button', { name: /stop/i }).click();
  await expect.poll(() => mockAgent.messages('yeaft_abort_turn').length).toBe(before + 1);
  const stop = mockAgent.messages('yeaft_abort_turn').at(-1);
  expect(stop.userTurnId).toBe(a.userTurnId);
  expect(stop.sessionId).toBe(SESSION);
  expect(mockAgent.messages('yeaft_abort_all')).toHaveLength(0);
  wire.finish(a, 'aborted');
  wire.delta(b, ' and survives stopping A');
  await expect(page.locator('.assistant-turn').filter({ hasText: 'Recovery B text while another Session is open and survives stopping A' })).toHaveCount(1);
  wire.finish(b);
  await expect(page.locator('.parallel-turn-region')).toHaveCount(0);
  await expect(page.locator('.assistant-turn.streaming')).toHaveCount(0);
});

test('Delete turn from a saved supplement replays the remaining Session in both tabs', async ({ chatPage: page, context, mockAgent, serverUrl }) => {
  const sessionId = 'session_delete_turn_e2e';
  const name = 'Saved turn deletion';
  const conversationId = 'yeaft-delete-turn-e2e';
  const deletedTurn = { userTurnId: 'm1', turnId: 'execution-a', threadId: 'thread-a' };
  const keptTurn = { userTurnId: 'm7', turnId: 'execution-b', threadId: 'thread-b' };
  const ts = Date.now();
  const user = (seq, content, turn, relation = 'new') => ({ id: `m${seq}`, seq, role: 'user',
    content, sessionId, ts: ts + seq, userTurnId: turn.userTurnId, relation, clientMessageId: `send-${seq}` });
  const assistant = (seq, content, turn, toolCalls) => ({ id: `m${seq}`, seq, role: 'assistant',
    content, sessionId, ts: ts + seq, speakerVpId: 'omni', ...turn, ...(toolCalls ? { toolCalls } : {}) });
  let rows = [
    user(1, 'Prompt to remove', deletedTurn),
    assistant(2, 'First reply to remove', deletedTurn),
    assistant(3, '', deletedTurn, [{ id: 'tool-a', name: 'Read', input: { file_path: 'before.txt' } }]),
    user(4, 'Supplement to remove', deletedTurn, 'supplement'),
    assistant(5, '', deletedTurn, [{ id: 'tool-b', name: 'Grep', input: { pattern: 'after' } }]),
    assistant(6, 'Final reply to remove', deletedTurn),
    user(7, 'Prompt to keep', keptTurn),
    assistant(8, 'Reply to keep', keptTurn),
  ];
  let revision = 1;
  const loads = () => mockAgent.messages('yeaft_load_history').filter(request => request.sessionId === sessionId && request.limit !== 0);
  const replyWithHistory = request => mockAgent.send({
    type: 'yeaft_history_chunk', sessionId, conversationId, mode: 'recent',
    requestId: request.requestId, _requestClientId: request._requestClientId,
    messages: rows, oldestSeq: rows[0].seq, latestSeq: rows.at(-1).seq,
    hasMore: false, streamId: 'delete-e2e-history', revision,
  });
  let holdHistory = false;
  const authorized = () => mockAgent.messages('session_turn_delete_authorized');
  let announcement;
  mockAgent._messageHandlers.push(request => {
    if (request.type === 'yeaft_load_history' && request.sessionId === sessionId && request.limit !== 0 && !holdHistory) {
      replyWithHistory(request);
    }
    if (request.type !== 'session_turn_delete_authorized' || request.sessionId !== sessionId) return;
    const target = rows.find(row => row.role === 'user' && row.id === request.messageId);
    const result = { type: 'yeaft_session_delete_turn_result', sessionId, requestId: request.requestId };
    if (!target) {
      mockAgent.send({ ...result, ok: false, errorCode: 'message_not_found' });
      return;
    }
    const deletedMessageIds = rows.filter(row => row.userTurnId === target.userTurnId).map(row => row.id);
    rows = rows.filter(row => row.userTurnId !== target.userTurnId);
    revision++;
    const deletion = { sessionId, turnId: `deletion-${target.userTurnId}`, deletedMessageIds };
    mockAgent.send({ ...result, ...deletion, ok: true });
    // Release the broadcast separately to prove the requester reacts to the ACK
    // and the other tab reacts to the broadcast, not a shared history response.
    announcement = { type: 'yeaft_session_turn_deleted', ...deletion };
  });
  const openSession = async tab => {
    await tab.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
    mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [
      { id: sessionId, name, roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test' },
    ] } });
    const sidebarToggle = tab.locator('.yeaft-topbar-sidebar-toggle');
    const sessionRow = tab.locator('.sidebar-session-row').filter({ hasText: name });
    if (await sidebarToggle.isVisible() && !await sessionRow.isVisible()) await sidebarToggle.click();
    await sessionRow.click();
  };
  const removedText = rows.filter(row => row.userTurnId === deletedTurn.userTurnId && row.content).map(row => row.content);
  const expectKept = async tab => {
    await expect(tab.getByText('Prompt to keep', { exact: true })).toBeVisible();
    await expect(tab.getByText('Reply to keep', { exact: true })).toBeVisible();
  };
  const expectDeleted = async tab => {
    await expectKept(tab);
    for (const text of removedText) await expect(tab.getByText(text, { exact: true })).toHaveCount(0);
    await expect(tab.locator('.tool-line')).toHaveCount(0);
    await expect(tab.getByRole('button', { name: 'Delete turn', exact: true })).toHaveCount(1);
  };

  await openSession(page);
  for (const text of removedText) await expect(page.getByText(text, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1 more', exact: true }).click();
  await expect(page.locator('.tool-line')).toHaveCount(2);
  await expectKept(page);
  const peer = await context.newPage();
  await peer.goto(serverUrl);
  await openSession(peer);
  await expectKept(peer);
  await expect(peer.getByText('Supplement to remove', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 900 });
  const supplement = page.locator('.message.user').filter({ hasText: 'Supplement to remove' });
  const action = supplement.getByRole('button', { name: 'Delete turn', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Delete turn' });
  const confirm = dialog.getByRole('button', { name: 'Delete turn', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const openDialog = async () => {
    await supplement.hover();
    await action.click();
    await expect(dialog).toContainText(/entire turn.*appended messages.*replies and tool activity.*cannot be undone/i);
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  };
  await openDialog();
  const initialLoadCount = loads().length;
  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(action).toBeFocused();
  await expect(supplement).toBeVisible();
  await expect(page.locator('.tool-line')).toHaveCount(2);
  expect(authorized()).toHaveLength(0);

  holdHistory = true;
  await openDialog();
  await confirm.click();
  await expect.poll(authorized).toHaveLength(1);
  expect(authorized()[0]).toMatchObject({ agentId: mockAgent.agentId, sessionId, messageId: 'm4' });
  expect(mockAgent.messages('yeaft_session_delete_turn')).toHaveLength(0);
  await expect.poll(() => loads().length).toBe(initialLoadCount + 1);
  const requesterReplay = loads().at(-1);
  expect(requesterReplay.afterSeq).toBeUndefined();
  await expect(page.getByRole('status').filter({ hasText: 'Refreshing Session history' })).toBeVisible();
  await expect(supplement).toBeVisible(); // No optimistic splice: wait for authoritative history.
  replyWithHistory(requesterReplay);
  await expectDeleted(page);
  await expect(peer.getByText('Supplement to remove', { exact: true })).toBeVisible();
  mockAgent.send(announcement);
  await expect.poll(() => loads().length).toBe(initialLoadCount + 2);
  const peerReplay = loads().at(-1);
  expect(peerReplay.afterSeq).toBeUndefined();
  expect(requesterReplay._requestClientId).toBeTruthy();
  expect(peerReplay._requestClientId).toBeTruthy();
  expect(peerReplay._requestClientId).not.toBe(requesterReplay._requestClientId);
  await expect(peer.getByText('Supplement to remove', { exact: true })).toBeVisible();
  replyWithHistory(peerReplay);
  await expectDeleted(peer);
  expect(loads()).toHaveLength(initialLoadCount + 2); // ACK and broadcast dedupe in the requester.

  holdHistory = false;
  await peer.reload();
  await openSession(peer);
  await expect.poll(() => loads().length).toBeGreaterThan(initialLoadCount + 2);
  await expectDeleted(peer);
});
