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
  expect(questions).toEqual([
    'Root A first', 'Supplement belongs to A', 'Root B second', 'Root C third', 'Root D fourth', 'Root E fifth',
  ]);
  expect(foundA).toBe(true);
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
