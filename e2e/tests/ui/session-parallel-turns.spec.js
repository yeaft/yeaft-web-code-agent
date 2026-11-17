import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { OTHER_SESSION, SESSION, pane, sessionTurnsFixture } from '../../helpers/session-turns.js';

// Run the actual browser modules, not component stubs or injected message arrays.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

test('one native Session turn retains the ordinary transcript without parallel chrome', async ({ chatPage: page, mockAgent }) => {
  const wire = await sessionTurnsFixture(page, mockAgent);
  const turn = await wire.send('Single root question');
  wire.delta(turn, 'Single answer begins');
  await expect(page.locator('.assistant-turn').filter({ hasText: 'Single answer begins' })).toBeVisible();
  await expect(page.locator('.parallel-turn-tabs')).toHaveCount(0);
  wire.delta(turn, ' and finishes.');
  wire.finish(turn);
  const answer = page.locator('.assistant-turn').filter({ hasText: 'Single answer begins and finishes.' });
  await expect(answer).toHaveCount(1);
  await expect(answer).not.toHaveClass(/streaming/);
  await expect(page.locator('.parallel-turn-region')).toHaveCount(0);
  await expect(page.locator('.message-user-block').filter({ hasText: 'Single root question' })).toHaveCount(1);
});

test('same-VP concurrent roots isolate interleaved streams, supplement and completion with bounded responsive panes', async ({ chatPage: page, mockAgent }, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const wire = await sessionTurnsFixture(page, mockAgent);
  const a = await wire.send('Root A first');
  wire.delta(a, 'A-only initial');
  const b = await wire.send('Root B second');
  wire.delta(b, 'B-only initial');
  wire.delta(a, ' A-only continuation');
  wire.delta(b, ' B-only continuation');
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
  await expect(pane(page, a)).toContainText('A-only initial A-only continuation');
  await expect(pane(page, b)).toContainText('B-only initial B-only continuation');
  await expect(pane(page, a)).not.toContainText('B-only');
  await expect(pane(page, b)).not.toContainText('A-only');

  await wire.send('Supplement belongs to A', a);
  await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
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
  const desktopWidth = await track.evaluate(el => el.clientWidth);
  const desktopPane = await pane(page, a).evaluate(el => el.getBoundingClientRect().width);
  expect(desktopPane).toBeGreaterThanOrEqual(desktopWidth / 3 - 10);
  expect(desktopPane).toBeLessThanOrEqual(desktopWidth + 1);

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
  const questions = await page.locator('.message-user-block').allTextContents();
  expect(questions.map(text => text.trim())).toEqual([
    'Root A first', 'Supplement belongs to A', 'Root B second', 'Root C third', 'Root D fourth', 'Root E fifth',
  ]);
  await expect(page.locator('.assistant-turn').filter({ hasText: 'A-only initial A-only continuation A survives B completion' })).toHaveCount(1);
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
