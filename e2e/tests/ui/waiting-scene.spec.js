import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { sessionTurnsFixture } from '../../helpers/session-turns.js';

// Run the actual browser modules, not component stubs.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.SERVE_DIST || 'false' } });

// Ink actually on the canvas, so "visible" means the play was drawn, not just mounted.
const inkedPixels = canvas => canvas.evaluate((element) => {
  const { data } = element.getContext('2d').getImageData(0, 0, element.width, element.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
  return count;
});
const frame = canvas => canvas.evaluate(element => element.toDataURL());

test('a running turn plays one basketball possession on the transcript strip and the status-pane screen', async ({ chatPage: page, mockAgent }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = await sessionTurnsFixture(page, mockAgent);
  const strip = page.locator('.typing-indicator .hoops-scene-court');
  const screen = page.locator('.yeaft-session-status-pane .hoops-scene-broadcast');
  await expect(strip).toHaveCount(0);
  await expect(screen).toHaveCount(0);

  // Close the status pane first: its screen must join the play already in
  // progress when it opens later, which only a shared clock can do.
  await page.getByRole('button', { name: 'Hide Session status', exact: true }).click();
  const turn = await session.send('How long is this going to take?');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('aria-hidden', 'true');
  await expect(strip).toHaveAttribute('data-beat', 'bringup');
  await expect.poll(() => inkedPixels(strip.locator('canvas'))).toBeGreaterThan(200);
  const first = await frame(strip.locator('canvas'));
  await expect.poll(() => frame(strip.locator('canvas'))).not.toBe(first);

  await expect(strip).toHaveAttribute('data-beat', 'sizeup', { timeout: 8000 });
  await page.getByRole('button', { name: 'Show Session status', exact: true }).click();
  await expect(screen).toBeVisible();
  await expect(screen).toHaveAttribute('data-beat', /sizeup|drive/);
  await expect(screen).toHaveAttribute('data-shot', /matchup|handle/);
  await expect.poll(() => inkedPixels(screen.locator('canvas'))).toBeGreaterThan(400);
  // The screen hangs in the lower part of the pane, below every section.
  const layout = await page.locator('.yeaft-session-status-pane').evaluate((pane) => {
    const stage = pane.querySelector('.yeaft-session-status-stage').getBoundingClientRect();
    const sections = [...pane.querySelectorAll('.yeaft-session-status-section')].map(el => el.getBoundingClientRect().bottom);
    const box = pane.getBoundingClientRect();
    return { top: stage.top, bottom: stage.bottom, lastSection: Math.max(...sections), paneTop: box.top, paneBottom: box.bottom };
  });
  expect(layout.top).toBeGreaterThanOrEqual(layout.lastSection);
  expect(layout.top).toBeGreaterThan((layout.paneTop + layout.paneBottom) / 2);
  expect(layout.bottom).toBeLessThan(layout.paneBottom);
  await expect(page.locator('.yeaft-session-status-stage')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: info.outputPath('waiting-scene-desktop-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(400); // let the theme's own colour transitions settle for the screenshot
  await page.screenshot({ path: info.outputPath('waiting-scene-desktop-dark.png') });

  // Reduced motion holds one calm frame on both surfaces.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(strip).toHaveAttribute('data-beat', 'bringup');
  await expect(screen).toHaveAttribute('data-beat', 'bringup');
  const held = await frame(strip.locator('canvas'));
  await page.waitForTimeout(250);
  expect(await frame(strip.locator('canvas'))).toBe(held);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Narrow phones: the strip shrinks with the transcript and never scrolls sideways.
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => window.Pinia.useChatStore().closeSessionSidebar());
  await expect(strip).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const stripBox = await strip.boundingBox();
  expect(stripBox.x).toBeGreaterThanOrEqual(0);
  expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(320);
  await page.waitForTimeout(400); // let the sidebar drawer finish sliding out of the screenshot
  await page.screenshot({ path: info.outputPath('waiting-scene-320-dark.png') });
  // The full-screen mobile pane carries the screen too, capped in height.
  await page.getByRole('button', { name: 'Show Session status', exact: true }).click();
  await expect(screen).toBeVisible();
  expect((await screen.boundingBox()).height).toBeLessThanOrEqual(168);
  await expect(page.locator('.yeaft-session-status-stage')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: info.outputPath('waiting-scene-320-pane-dark.png') });
  await page.getByRole('button', { name: 'Close Session status', exact: true }).click();

  // The play ends with the turn.
  session.finish(turn);
  await expect(strip).toHaveCount(0);
  await expect(screen).toHaveCount(0);
});
