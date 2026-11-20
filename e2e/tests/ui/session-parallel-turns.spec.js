import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { createSessionFromSpec } from '../../../agent/yeaft/sessions/session-crud.js';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { OTHER_SESSION, SESSION, pane, sessionTurnsFixture } from '../../helpers/session-turns.js';

// Run the actual browser modules, not component stubs or injected message arrays.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.SERVE_DIST || 'false' } });

// Ink on a stage animation's canvas: the scene was drawn, not merely mounted.
const drawnPixels = scene => scene.locator('canvas').evaluate((canvas) => {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
  return count;
});
const drawnFrame = scene => scene.locator('canvas').evaluate(canvas => canvas.toDataURL());

// Check composited pixels, not just the canvas bounds: both ends of a wide
// scene must show the stage rather than the plain chat background.
async function expectVisibleStageEdges(scene, path) {
  const screenshot = await scene.screenshot({ path, scale: 'css', animations: 'disabled' });
  const edgeContrast = await scene.page().evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [1, canvas.width - 2].map((x) => {
      const page = ctx.getImageData(x, 0, 1, 1).data;
      const floor = ctx.getImageData(x, Math.round(canvas.height * 0.7), 1, 1).data;
      return Math.max(...[0, 1, 2].map(channel => Math.abs(floor[channel] - page[channel])));
    });
  }, screenshot.toString('base64'));
  for (const contrast of edgeContrast) expect(contrast, 'the backdrop is visible at each edge').toBeGreaterThan(6);
}

test('one native Session turn shows its waiting indicator, retains the ordinary transcript and merges appended tools across replay', async ({ chatPage: page, mockAgent }, info) => {
  test.setTimeout(60_000); // Includes real canvas, reduced-motion and two viewport transitions.
  const wire = await sessionTurnsFixture(page, mockAgent);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const indicator = page.locator('.typing-indicator');
  const hoops = indicator.locator('.hoops-scene');
  const cat = indicator.locator('.svg-running-cat');
  const dots = indicator.locator('> span:not(.svg-cat-walk)');
  const chooseWaitingAnimation = choice => page.evaluate(value => window.Pinia.useChatStore().setWaitingAnimation(value), choice);
  // The default picks one at random; pin one to assert on it.
  await chooseWaitingAnimation('hoops');
  await page.clock.setFixedTime(Date.now());
  const turn = await wire.send('Single root question');
  // The chosen animation draws its first frame as soon as the wait starts,
  // with no waiting caption, dots, or time needed for an intro to finish.
  await expect(hoops).toHaveAttribute('aria-hidden', 'true');
  await expect(hoops).toHaveText('');
  await expect(hoops.locator('canvas')).toBeVisible();
  await expect(dots).toHaveCount(0);
  await expect(hoops).toHaveAttribute('data-motion', 'live');
  await expect.poll(() => drawnPixels(hoops)).toBeGreaterThan(200);
  await page.clock.setSystemTime(Date.now());
  // Measure against the conversation's actual body text, including the
  // animation's vertical padding in the five-line budget.
  const fiveLines = await indicator.evaluate((el) => {
    const probe = document.createElement('div');
    probe.className = 'markdown-body';
    el.closest('.messages').append(probe);
    const height = 5 * parseFloat(getComputedStyle(probe).lineHeight);
    probe.remove();
    return height;
  });
  const stageBox = scene => scene.evaluate((el) => {
    const stage = el.getBoundingClientRect();
    const canvas = el.querySelector('canvas');
    const picture = canvas.getBoundingClientRect();
    const row = el.parentElement.getBoundingClientRect();
    return { width: stage.width, height: stage.height, rowHeight: row.height,
      canvasHeight: picture.height, backing: canvas.height / canvas.width,
      leftGap: picture.left - row.left, rightGap: row.right - picture.right };
  });
  const expectCompactStage = async (scene) => {
    const box = await stageBox(scene);
    expect(box.rowHeight, 'animation and padding fit within five lines').toBeLessThanOrEqual(fiveLines + 0.02);
    expect(box.canvasHeight).toBeCloseTo(box.height, 1);
    expect(box.leftGap).toBeCloseTo(0, 1);
    expect(box.rightGap).toBeCloseTo(0, 1);
    // The backing store follows the canvas once ResizeObserver has reported.
    await expect.poll(async () => { const current = await stageBox(scene); return Math.abs(current.backing - current.height / current.width); }).toBeLessThan(0.01);
  };
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 1920, height: desktop.height });
  await expectCompactStage(hoops);
  expect((await stageBox(hoops)).width).toBeGreaterThan(960);
  await expectVisibleStageEdges(hoops, info.outputPath('waiting-stage-desktop.png'));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.setViewportSize({ width: 320, height: desktop.height });
  await expect.poll(async () => (await stageBox(hoops)).width).toBeLessThan(300);
  await expectCompactStage(hoops);
  await expectVisibleStageEdges(hoops, info.outputPath('waiting-stage-mobile.png'));
  // A conversation column narrower than the capped picture still uses the
  // original 11:5 aspect ratio instead of stretching or cropping it.
  await indicator.evaluate(el => { el.style.maxWidth = '200px'; });
  const narrow = await stageBox(hoops);
  expect(narrow.width).toBe(200);
  expect(narrow.height).toBeCloseTo(narrow.width * 5 / 11, 1);
  await expectCompactStage(hoops);
  await indicator.evaluate(el => { el.style.removeProperty('max-width'); });
  await page.setViewportSize(desktop);
  // Panels can settle differently after the round trip; wait for the stage to stop resizing.
  await expect.poll(async () => { const before = (await stageBox(hoops)).width; await page.waitForTimeout(250); return (await stageBox(hoops)).width === before; }).toBe(true);
  await expect(cat).toHaveCount(0);
  await expect(page.locator('.yeaft-session-status-pane canvas')).toHaveCount(0);
  // Reduced motion never leaves the wait frozen: the scene's key moments
  // take turns, each held still and dissolved into the next. Without it the
  // play moves on.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(hoops).toHaveAttribute('data-motion', 'calm');
  const firstStill = await hoops.getAttribute('data-still');
  await expect.poll(() => hoops.getAttribute('data-still'), { timeout: 6000, intervals: [100] }).not.toBe(firstStill);
  await page.waitForTimeout(600); // Past the dissolve, the still holds.
  const still = await drawnFrame(hoops);
  await page.waitForTimeout(300);
  expect(await drawnFrame(hoops)).toBe(still);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(hoops).toHaveAttribute('data-motion', 'live');
  await expect.poll(() => drawnFrame(hoops)).not.toBe(still);
  // A new choice applies to the wait on screen. Every animation offered in
  // Settings plays without the dots, off leaves the dots alone, and random
  // settles on exactly one animation.
  await chooseWaitingAnimation('dragon');
  const dragon = indicator.locator('.dragon-scene');
  await expect(dragon).toHaveText('');
  await expect(dragon.locator('canvas')).toBeVisible();
  await expectCompactStage(dragon);
  await expect(hoops).toHaveCount(0);
  await expect(dots).toHaveCount(0);
  await expect.poll(() => drawnPixels(dragon)).toBeGreaterThan(200);
  await expectVisibleStageEdges(dragon, info.outputPath('waiting-stage-dragon.png'));
  await chooseWaitingAnimation('cat');
  await expect(cat).toBeVisible();
  await expect(indicator.locator('.waiting-stage')).toHaveCount(0);
  // With motion reduced the cat stays where it starts but keeps moving.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(600);
  await expect(cat).toHaveClass(/speed-(normal|tired|napping)/);
  expect(await cat.evaluate(el => new DOMMatrix(getComputedStyle(el.parentElement).transform).m41)).toBe(0);
  expect(await cat.evaluate(el => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(dots).toHaveCount(0);
  // A waiting status colours the dots, not an animation standing in their place.
  const setCompacting = on => page.evaluate((compacting) => {
    const store = window.Pinia.useChatStore();
    store.compactStatus = compacting ? { conversationId: store.currentConversation, status: 'compacting' } : null;
  }, on);
  await setCompacting(true);
  await expect(indicator).toHaveClass(/status-compacting/);
  await expect(indicator.locator('.svg-cat-walk')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await chooseWaitingAnimation('off');
  await expect(dots).toHaveCount(3);
  await expect(dots.first()).toHaveCSS('background-color', 'rgba(91, 155, 213, 0.6)');
  await setCompacting(false);
  await expect(indicator).not.toHaveClass(/status-compacting/);
  await expect(indicator.locator('.waiting-stage, .svg-running-cat')).toHaveCount(0);
  await chooseWaitingAnimation('random');
  const candidate = indicator.locator('.waiting-stage, .svg-running-cat');
  await expect(candidate).toHaveCount(1);
  const picked = await candidate.evaluate(element => ['hoops-scene', 'dragon-scene', 'svg-running-cat'].map(name => '.' + name).find(selector => element.matches(selector)));
  wire.delta(turn, 'Single answer begins');
  await expect(page.locator('.assistant-turn').filter({ hasText: 'Single answer begins' })).toBeVisible();
  // Streaming text takes over from the indicator.
  await expect(indicator).toHaveCount(0);
  const runningDot = page.locator('.session-response-running-dot');
  await expect(runningDot).toBeVisible();
  const expectDotAtTextEnd = async (container, { wraps = false } = {}) => {
    await expect(container.locator('.session-response-running-dot')).toBeVisible();
    const geometry = await container.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let text, first, last;
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue;
        first ||= text;
        last = text;
      }
      const range = document.createRange();
      range.setStart(first, first.textContent.search(/\S/));
      range.setEnd(first, range.startOffset + 1);
      const firstTop = range.getBoundingClientRect().top;
      range.setStart(last, last.textContent.trimEnd().length - 1);
      range.setEnd(last, last.textContent.trimEnd().length);
      const end = range.getBoundingClientRect();
      const dot = el.querySelector('.session-response-running-dot').getBoundingClientRect();
      return { gap: dot.left - end.right, center: (dot.top + dot.bottom) / 2,
        firstTop, lastTop: end.top, lastBottom: end.bottom, right: dot.right, viewport: innerWidth };
    });
    expect(geometry.center).toBeGreaterThan(geometry.lastTop);
    expect(geometry.center).toBeLessThan(geometry.lastBottom);
    expect(geometry.gap).toBeGreaterThanOrEqual(2);
    expect(geometry.gap).toBeLessThan(8);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    if (wraps) expect(geometry.lastTop).toBeGreaterThan(geometry.firstTop);
  };
  const setTheme = theme => page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await setTheme('light');
  await expect(runningDot).toHaveCSS('background-color', 'rgb(44, 44, 44)');
  const firstLine = page.locator('.turn-text p').filter({ hasText: 'Single answer begins' });
  await expectDotAtTextEnd(firstLine);
  await firstLine.screenshot({ path: info.outputPath('running-dot-light-desktop.png'), animations: 'disabled' });
  await expect(page.locator('.assistant-turn').getByRole('status')).toHaveText('Running');
  await expect(page.locator('.assistant-turn .cursor-blink')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(runningDot).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(runningDot).toHaveCSS('animation-name', 'session-response-pulse');
  await expect(page.locator('.parallel-turn-tabs')).toHaveCount(0);
  wire.tool(turn, 'before-append', 'Bash', { command: 'printf test\n' });
  // Back after the text, the turn keeps the animation it started with.
  await expect(indicator.locator(picked)).toBeVisible();
  await expect(runningDot).toBeVisible();
  await wire.send('Extra detail for the same turn', turn);
  wire.tool(turn, 'after-append', 'Grep');
  // A new assistant row after a tool loop, not a delta into the old text row.
  wire.delta(turn, 'Appended answer finishes.', 'reply-after-append');
  const answer = page.locator('.assistant-turn');
  await expect(answer).toHaveCount(1);
  await expect(answer).toContainText('Single answer begins');
  await expect(answer).toContainText('Appended answer finishes.');
  // New chunks may replace the Markdown DOM and reflow the final line.
  wire.delta(turn, '\n\n- A longer sentence that wraps onto the next line on a small screen and ends here in **bold.**', 'reply-after-append');
  const lastLine = answer.locator('.turn-text li').filter({ hasText: 'A longer sentence' });
  await page.setViewportSize({ width: 320, height: desktop.height });
  await setTheme('dark');
  await expect(runningDot).toHaveCount(1);
  await expect(runningDot).toHaveCSS('background-color', 'rgb(230, 228, 224)');
  await expectDotAtTextEnd(lastLine, { wraps: true });
  await expect(lastLine.locator('strong')).toHaveText('bold.');
  await expect(lastLine.locator('strong .session-response-running-dot')).toHaveCount(0);
  await answer.screenshot({ path: info.outputPath('running-dot-dark-320.png'), animations: 'disabled' });
  // A trailing code block has no prose baseline: the marker stays outside the code and inside the reply.
  wire.delta(turn, '\n\n```text\nCode stays unchanged\n```', 'reply-after-append');
  await expect(answer.locator('pre code')).toHaveText('Code stays unchanged');
  await expect(answer.locator('.turn-content .session-response-running-dot')).toHaveCount(0);
  expect(await runningDot.evaluate(dot => {
    const rect = dot.getBoundingClientRect();
    const reply = dot.closest('.turn-message-block').getBoundingClientRect();
    const code = dot.closest('.turn-message-block').querySelector('.code-block-wrapper').getBoundingClientRect();
    return rect.left >= code.right && rect.right <= reply.right && rect.bottom <= reply.bottom;
  })).toBe(true);
  await page.setViewportSize(desktop);
  const details = page.locator('.session-tool-details');
  const toolLines = details.locator('.tool-line');
  const statusToggle = page.locator('.yeaft-session-status-toggle');
  const showDetails = async () => {
    if (await statusToggle.getAttribute('aria-expanded') === 'false') await statusToggle.click();
    await details.locator('summary').press('Enter');
  };
  await expect(answer.locator('.tool-line')).toHaveCount(0);
  await expect(toolLines).toHaveCount(0);
  await showDetails();
  await expect(toolLines).toHaveCount(2);
  await expect(toolLines.last()).toContainText('Grep');
  await page.keyboard.press('Tab');
  await expect(toolLines.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(details.locator('.bash-output')).toContainText('before-append evidence');
  await expect(page.locator('.vp-turn-block')).toHaveCount(1);
  await expect(page.locator('.message-user-block').filter({ hasText: 'Extra detail for the same turn' })).toHaveCount(1);
  wire.finish(turn);
  await expect(answer).not.toHaveClass(/streaming/);
  await expect(runningDot).toHaveCount(0);
  await expect(details.locator('.bash-output')).toContainText('before-append evidence');
  // The wait ends with the turn.
  await expect(indicator).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
  await wire.open();
  await expect(answer).toHaveCount(1);
  await expect(answer).toContainText('Single answer begins');
  await expect(answer).toContainText('Appended answer finishes.');
  await expect(answer.locator('.tool-line')).toHaveCount(0);
  await expect(runningDot).toHaveCount(0);
  await showDetails();
  await expect(toolLines).toHaveCount(2);
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

test('stopping a sibling restores the ordinary live Session transcript and completion order', async ({ chatPage: page, mockAgent }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  const wire = await sessionTurnsFixture(page, mockAgent);
  const composer = page.locator('[data-message-composer]');
  const stop = composer.locator('.stop-btn');
  const messages = page.locator('.yeaft-page .messages');
  const region = messages.locator('.parallel-turn-region');
  const activity = page.locator('.yeaft-session-status-toggle');
  const scroller = page.locator('.yeaft-page .virtual-transcript-scroller');
  const status = label => page.locator('.yeaft-vp-timeline-row').filter({ hasText: label });
  if (await activity.getAttribute('aria-expanded') === 'false') await activity.click();
  const a = await wire.send('Earlier long question');
  const ordinaryWidth = () => messages.evaluate(el => getComputedStyle(el).maxWidth);
  const originalWidth = await ordinaryWidth();
  expect(originalWidth).not.toBe('none');
  await expect(stop).toBeVisible();

  await page.evaluate(() => window.Pinia.useChatStore().setWaitingAnimation('cat'));
  wire.tool(a, 'first-work', 'FileRead', { displayResource: 'only A.txt' });
  wire.delta(a, 'A is still researching');
  const b = await wire.send('Later quick question');
  wire.delta(b, 'B partial answer');
  await expect(region.locator('.parallel-turn-pane')).toHaveCount(2);
  await expect(pane(page, a).locator('.concurrent-turn-title')).toHaveText('Earlier long question');
  await expect(pane(page, b).locator('.concurrent-turn-state')).toHaveText('Running');
  await expect(page.locator('.parallel-turn-tabs')).toBeHidden();
  expect(await pane(page, b).evaluate(el => getComputedStyle(el, '::before').width)).toBe('1px');
  expect(await pane(page, a).evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
  expect(await ordinaryWidth()).toBe('none');
  await expect(status('Earlier long question')).toBeVisible();
  await expect(status('Later quick question')).toBeVisible();
  await expect(pane(page, a).locator('.session-response-running-dot')).toBeVisible();
  await expect(pane(page, b).locator('.session-response-running-dot')).toBeVisible();
  wire.tool(b, 'parallel-work', 'FileGrep', { displayResource: 'only B.txt' });
  await expect(pane(page, b).locator('.typing-indicator .svg-running-cat')).toBeVisible();
  await expect(pane(page, a).locator('.typing-indicator')).toHaveCount(0);
  await expect(messages.locator('.tool-line')).toHaveCount(0);
  const details = page.locator('.session-tool-details');
  const toolSelect = details.getByRole('combobox', { name: 'Turn for tool call details' });
  const expectOnlyCallsFor = async (label, resource) => {
    await toolSelect.selectOption({ label: `${label} (1)` });
    await expect(details.locator('.tool-line')).toHaveCount(1);
    await expect(details.locator('.tool-line')).toContainText(resource);
  };
  await details.locator('summary').press('Enter');
  await expect(toolSelect).toBeVisible(); // Native details dispatches toggle asynchronously.
  await page.keyboard.press('Tab');
  await expect(toolSelect).toBeFocused();
  await expectOnlyCallsFor('Earlier long question', 'only A.txt');
  await expectOnlyCallsFor('Later quick question', 'only B.txt');
  await details.locator('summary').press('Enter');
  await page.screenshot({ path: info.outputPath('parallel-desktop.png'), animations: 'disabled' });

  const siblingStop = pane(page, b).getByRole('button', { name: 'Stop', exact: true });
  await siblingStop.press('Enter');
  await expect.poll(() => mockAgent.messages('yeaft_abort_turn')).toEqual([
    expect.objectContaining({ sessionId: SESSION, userTurnId: b.userTurnId }),
  ]);
  wire.cancelling(b);
  await expect(region.locator('.parallel-turn-pane')).toHaveCount(2); // Wait for Agent confirmation.
  await expect(siblingStop).toBeDisabled();
  await expect(pane(page, b).locator('.concurrent-turn-body')).toBeFocused();
  wire.finish(b, 'aborted');
  const questions = () => messages.locator('.message-user-block').allTextContents().then(rows => rows.map(row => row.trim()));
  const expectOrdinaryLive = async (tail, { order, width = originalWidth } = {}) => {
    await expect(region).toHaveCount(0); // No lane header, status, tabs, or inline Stop.
    await expect.poll(ordinaryWidth).toBe(width);
    await expect(messages.locator('.assistant-turn').filter({ hasText: tail })).toBeVisible();
    await expect(stop).toBeEnabled();
    if (order) await expect.poll(questions).toEqual(order);
  };
  const afterStop = ['Later quick question', 'Earlier long question'];
  await expectOrdinaryLive('A is still researching', { order: afterStop });
  await expect(messages.getByText('B partial answer', { exact: true })).toBeVisible();
  await expect(messages.locator('.assistant-turn').filter({ hasText: 'B partial answer' }).locator('.session-response-running-dot')).toHaveCount(0);
  await expect(messages.locator('.session-response-running-dot')).toHaveCount(1);
  await expect(status('Later quick question')).toHaveCount(0);
  await expect(status('Earlier long question').locator('.yeaft-vp-timeline-abort')).toBeEnabled();
  await expect(scroller).toBeFocused();
  await expect(page.locator('.yeaft-page .scroll-to-latest')).toHaveClass(/is-hidden/);
  wire.delta(a, ' after the split');
  await expect(messages.locator('.assistant-turn.streaming')).toContainText('A is still researching after the split');
  await page.screenshot({ path: info.outputPath('single-desktop-after-stop.png'), animations: 'disabled' });

  // Navigation and a fresh page project the same single-column state.
  await wire.open(OTHER_SESSION);
  await expect(region).toHaveCount(0);
  wire.delta(a, ' while away');
  await wire.open(SESSION);
  await expectOrdinaryLive('A is still researching after the split while away', { order: afterStop });
  await page.reload();
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
  await wire.open(SESSION);
  wire.delta(a, ' after reload');
  await expectOrdinaryLive('A is still researching after the split while away after reload', { order: afterStop });
  if (await activity.getAttribute('aria-expanded') === 'false') await activity.click();
  await details.locator('summary').press('Enter');
  await expectOnlyCallsFor('Earlier long question', 'only A.txt');
  await expectOnlyCallsFor('Later quick question', 'only B.txt');
  await details.locator('summary').press('Enter');

  // A new sibling can split the UI again on mobile. Natural completion
  // also returns to single-column rather than waiting for the survivor to end.
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.evaluate(() => window.Pinia.useChatStore().closeSessionSidebar());
  const mobileWidth = await ordinaryWidth();
  const longReply = Array.from({ length: 60 }, (_, i) => `\n\nReading marker ${i}: this part of the continuous response should stay in view when the two layouts change.`).join('');
  wire.delta(a, longReply);
  const c = await wire.send('Mobile sibling');
  wire.delta(c, 'Mobile sibling response that wraps across several lines. '.repeat(64).trim());
  await expect(region.locator('.parallel-turn-pane')).toHaveCount(2);
  await expect(region.getByRole('tablist')).toBeVisible();
  await region.getByRole('tab', { name: 'Earlier long question' }).click();
  const readingPane = pane(page, a).locator('.concurrent-turn-body');
  const scrollTop = () => readingPane.evaluate(node => node.scrollTop);
  await expect.poll(scrollTop).toBeGreaterThan(800);
  await readingPane.hover();
  const priorTop = await scrollTop();
  await page.mouse.wheel(0, -600);
  await expect.poll(scrollTop).toBeLessThan(priorTop - 500);
  const savedLaneTop = await scrollTop();
  const siblingTab = region.getByRole('tab', { name: 'Mobile sibling' });
  await siblingTab.click();
  const siblingBody = pane(page, c).locator('.concurrent-turn-body');
  const siblingTop = () => siblingBody.evaluate(node => node.scrollTop);
  await expect.poll(siblingTop).toBeGreaterThan(240);
  await siblingBody.hover();
  const siblingBottom = await siblingTop();
  await page.mouse.wheel(0, -180);
  await expect.poll(siblingTop).toBeLessThan(siblingBottom - 120);
  await siblingTab.press('ArrowLeft');
  await expect(region.getByRole('tab', { name: 'Earlier long question' })).toBeFocused();
  await expect.poll(scrollTop).toBeCloseTo(savedLaneTop, 0);
  const readingAnchor = await readingPane.evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const paragraph = [...node.querySelectorAll('.turn-text > p')].find(p => p.getBoundingClientRect().bottom > top);
    return { text: paragraph.textContent, offset: paragraph.getBoundingClientRect().top - top };
  });
  const editor = composer.getByRole('textbox');
  await editor.fill('Unsent mobile draft');
  await page.screenshot({ path: info.outputPath('parallel-dark-320.png'), animations: 'disabled' });
  wire.finish(c);
  await expectOrdinaryLive('A is still researching after the split while away after reload', { width: mobileWidth });
  const anchorError = () => messages.getByText(readingAnchor.text, { exact: true }).evaluate((p, offset) => {
    const container = p.closest('.virtual-transcript-scroller');
    const rect = p.getBoundingClientRect();
    const expected = Math.max(-Math.max(0, rect.height - 24), offset);
    return Math.abs(rect.top - container.getBoundingClientRect().top - expected);
  }, readingAnchor.offset);
  await expect.poll(anchorError).toBeLessThan(4);
  wire.delta(a, '\n\nMore streaming text below the reading position.');
  await expect(messages.getByText('More streaming text below the reading position.', { exact: true })).toBeVisible();
  await expect.poll(anchorError).toBeLessThan(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(stop).toBeInViewport();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Unsent mobile draft');
  await page.screenshot({ path: info.outputPath('single-dark-320-after-finish.png'), animations: 'disabled' });

  await page.setViewportSize({ width: 1400, height: 900 });
  if (await activity.getAttribute('aria-expanded') === 'false') await activity.click();
  await page.locator('.yeaft-page .scroll-to-latest').click();
  const wideParagraph = 'Reflow anchor. ' + 'The same reply gains horizontal space after the split, but the paragraph should not disappear from view. '.repeat(30).trim();
  wire.delta(a, `\n\n${wideParagraph}\n\n${longReply.trim()}`.replaceAll('Reading marker', 'Desktop tail marker'));
  const d = await wire.send('Desktop reflow sibling');
  wire.delta(d, 'D quick answer');
  await expect(region.locator('.parallel-turn-pane')).toHaveCount(2);
  const narrowParagraph = pane(page, a).getByText(wideParagraph, { exact: true });
  await expect(narrowParagraph).toBeVisible();
  await readingPane.hover();
  const beforeWheel = await scrollTop();
  await page.mouse.wheel(0, -180);
  await expect.poll(scrollTop).toBeLessThan(beforeWheel - 100);
  const clipped = await narrowParagraph.evaluate(p => {
    const body = p.closest('.concurrent-turn-body');
    const rect = p.getBoundingClientRect();
    const clip = rect.height - 36;
    body.scrollTop += rect.top - body.getBoundingClientRect().top + clip;
    return clip;
  });
  await expect.poll(() => narrowParagraph.evaluate(p => p.getBoundingClientRect().bottom
    - p.closest('.concurrent-turn-body').getBoundingClientRect().top)).toBeCloseTo(36, 0);
  // A terminal frame can arrive before the next root inventory. The lane
  // is still mounted, but must not show a running dot or waiting animation.
  wire.finish(d, 'end_turn', { deferSnapshot: true });
  await expect(pane(page, d).locator('.assistant-turn')).not.toHaveClass(/streaming/);
  await expect(pane(page, d).locator('.session-response-running-dot, .typing-indicator')).toHaveCount(0);
  await expect(pane(page, a).locator('.session-response-running-dot')).toHaveCount(1);
  wire.snapshot();
  await expect(region).toHaveCount(0);
  const restoredParagraph = messages.getByText(wideParagraph, { exact: true });
  expect(await restoredParagraph.evaluate(p => p.getBoundingClientRect().height)).toBeLessThan(clipped);
  await expect(restoredParagraph).toBeInViewport();

  // Jumping to the active question pauses the outer transcript and the lane.
  // The explicitly selected lane still owns the reading position on collapse.
  const e = await wire.send('Desktop navigation sibling');
  wire.delta(e, 'E quick answer');
  await expect(region.locator('.parallel-turn-pane')).toHaveCount(2);
  await page.locator('.yeaft-page .scroll-to-latest').click();
  const origin = page.getByRole('button', { name: 'Back to this turn’s question' });
  await origin.click();
  const question = messages.getByText('Earlier long question', { exact: true });
  await expect(region.locator('.msg-flash').getByText('Earlier long question', { exact: true })).toBeInViewport();
  wire.finish(e);
  await expect(region).toHaveCount(0);
  await expect(question).toBeInViewport();

  await stop.click();
  await expect.poll(() => mockAgent.messages('yeaft_abort_all')).toEqual([expect.objectContaining({ sessionId: SESSION })]);
  wire.finish(a, 'aborted');
  await expect(region).toHaveCount(0);
  await expect(stop).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
  await wire.open(SESSION);
  // Check the ends separately: the long reply virtualizes some rows out of
  // each viewport, but the latest question must still follow the settled ones.
  await expect.poll(async () => (await questions()).at(-1)).toBe('Earlier long question');
  await scroller.focus();
  await scroller.press('Home');
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await expect(messages.getByText('Later quick question', { exact: true })).toBeInViewport();
  await expect.poll(async () => (await questions())[0]).toBe('Later quick question');
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
    await expect(tab.locator('.session-tool-details')).toHaveCount(0);
    await expect(tab.getByRole('button', { name: 'Delete turn', exact: true })).toHaveCount(1);
  };

  await openSession(page);
  for (const text of removedText) await expect(page.getByText(text, { exact: true })).toBeVisible();
  const toolDetails = page.locator('.session-tool-details');
  const statusToggle = page.locator('.yeaft-session-status-toggle');
  if (await statusToggle.getAttribute('aria-expanded') === 'false') await statusToggle.click();
  await toolDetails.locator('summary').click();
  await expect(toolDetails.locator('.tool-line')).toHaveCount(2);
  await expect(page.locator('.messages .tool-line')).toHaveCount(0);
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
  if (await statusToggle.getAttribute('aria-expanded') === 'false') await statusToggle.click();
  await expect(toolDetails.locator('summary')).toBeVisible();
  await page.getByRole('button', { name: 'Close Session status', exact: true }).click();
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

test('Delete turn works without Agent options and is hidden on an older Agent', async ({ page, mockAgent, serverUrl }, info) => {
  const root = await mkdtemp(join(tmpdir(), 'yeaft-delete-default-e2e-'));
  let agent;
  let agentClosed;
  let log = '';
  try {
    // Avoid downloads, live configuration, API keys and provider startup calls.
    const home = join(root, 'home');
    const data = join(root, 'data');
    await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
    await mkdir(data);
    await writeFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{}');
    await writeFile(join(data, 'models_dev_cache.json'), '{}');
    const { id: sessionId } = createSessionFromSpec(data, { name: 'Current Agent Session', roster: ['omni'] });
    const store = new ConversationStore(data);
    store.appendBatch([
      { sessionId, role: 'user', content: 'Delete this turn', clientMessageId: 'remove-me', userTurnId: 'remove-me', relation: 'new' },
      { sessionId, role: 'assistant', content: 'Remove this reply too', speakerVpId: 'omni', turnId: 'remove-reply', userTurnId: 'remove-me' },
      { sessionId, role: 'user', content: 'Keep this turn', clientMessageId: 'keep-me', userTurnId: 'keep-me', relation: 'new' },
    ]);
    agent = spawn(process.execPath, [fileURLToPath(new URL('../../../agent/cli.js', import.meta.url))], {
      cwd: root,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: home, USERPROFILE: home, YEAFT_DIR: data, WORK_DIR: root,
        SERVER_URL: serverUrl.replace(/^http/, 'ws'), AGENT_NAME: 'current-agent',
        YEAFT_LOCAL_RUN: 'true', YEAFT_SKIP_STARTUP_INSTALLS: 'true', DISALLOWED_TOOLS: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    agentClosed = new Promise(resolve => agent.once('close', resolve));
    agent.on('error', error => { log += `${error.message}\n`; });
    for (const stream of [agent.stdout, agent.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-6000); });

    const oldSessionId = 'session_old_agent';
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['file_editor', 'plaintext-ok'] });
    mockAgent._messageHandlers.push(request => {
      if (request.type === 'yeaft_load_history' && request.sessionId === oldSessionId && request.limit !== 0) {
        mockAgent.send({ type: 'yeaft_history_chunk', sessionId: oldSessionId, mode: 'recent', requestId: request.requestId,
          _requestClientId: request._requestClientId, hasMore: false, oldestSeq: 1, latestSeq: 1,
          messages: [{ id: 'm1', seq: 1, role: 'user', sessionId: oldSessionId, content: 'Older Agent question' }] });
      }
    });
    await page.goto(serverUrl);
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents
      .some(agent => agent.id === id && !agent.capabilities?.includes('session_delete_turn')), mockAgent.agentId);
    mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [
      { id: oldSessionId, name: 'Older Agent Session', roster: ['omni'], defaultVpId: 'omni' },
    ] } });
    const open = async name => {
      const row = page.locator('.sidebar-session-row').filter({ hasText: name });
      if (!await row.isVisible()) {
        const toggle = page.locator('.yeaft-topbar-sidebar-toggle');
        if (await toggle.isVisible()) await toggle.click();
      }
      await row.click();
    };
    await open('Older Agent Session');
    await expect(page.getByText('Older Agent question', { exact: true })).toBeVisible();
    await page.locator('.message.user').filter({ hasText: 'Older Agent question' }).hover();
    const buttons = page.locator('.message-delete-turn');
    await expect(buttons).toHaveCount(0); // No disabled or visually hidden trash button either.

    await open('Current Agent Session');
    await expect(page.getByText('Remove this reply too', { exact: true })).toBeVisible();
    const message = page.locator('.message.user').filter({ hasText: 'Delete this turn' });
    await message.hover();
    const action = message.getByRole('button', { name: 'Delete turn', exact: true });
    await expect(action).toBeEnabled();
    await action.click();
    await page.getByRole('dialog', { name: 'Delete turn' }).getByRole('button', { name: 'Delete turn', exact: true }).click();
    await expect(message).toHaveCount(0);
    await expect(page.getByText('Remove this reply too', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Keep this turn', { exact: true })).toBeVisible();
    expect(store.loadAllBySession(sessionId).map(row => row.content)).toEqual(['Keep this turn']);

    await open('Older Agent Session');
    await expect(page.getByText('Older Agent question', { exact: true })).toBeVisible();
    await expect(buttons).toHaveCount(0);
  } finally {
    if (agent) {
      agent.kill('SIGKILL');
      await agentClosed;
      await info.attach('isolated Agent log', { body: log, contentType: 'text/plain' });
    }
    await rm(root, { recursive: true, force: true });
  }
});
