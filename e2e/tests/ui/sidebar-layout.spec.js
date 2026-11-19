import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' } });

async function seedProjectSidebar(page, agentId) {
  await page.evaluate(agentId => {
    const chat = window.Pinia.useChatStore();
    const now = Date.now();
    const row = (sessionId, title, pinned, rank) => ({
      catalogKey: `yeaft:${agentId}:${sessionId}`, runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId, sessionId }, title, workDir: '/tmp/sidebar-layout',
      availability: 'online', createdAt: new Date(now - 86400000).toISOString(),
      metadataUpdatedAt: new Date(now - rank * 60000).toISOString(), sortRank: rank, pinned,
    });
    chat.currentView = 'yeaft';
    chat.applySessionCatalogSnapshot([
      row('project-pinned', 'Parental Control - Security Review', true, 0),
      row('project-plain', 'Sydney-C1', false, 1),
      row('recent-plain', 'Proxy-Server-C1', false, 2),
    ], [{ id: 'project-sydney', name: 'Sydney', instruction: '', sortOrder: 0, members: [
      { agentId, sessionId: 'project-pinned' }, { agentId, sessionId: 'project-plain' },
    ] }]);
  }, agentId);
  await expect(page.locator('.sidebar-project-header')).toBeVisible();
}

const left = locator => locator.evaluate(el => Math.round(el.getBoundingClientRect().left));
const shellWidth = page => page.locator('.session-sidebar-shell').evaluate(el => el.getBoundingClientRect().width);
const isFocused = locator => locator.evaluate(el => document.activeElement === el);

async function pointerDrag(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  await page.mouse.move(x + 400, y);
}

test('sidebar width follows pointer and keyboard, persists per browser, and drags leave no focus ring', async ({ chatPage: page, mockAgent }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await seedProjectSidebar(page, mockAgent.agentId);

  // Project children indent one step: a pinned title starts on the project name's edge.
  const projectName = page.locator('.sidebar-project-name').first();
  const projectRows = page.locator('.sidebar-project-sessions .sidebar-session-row .sidebar-session-title-text');
  expect(await left(projectRows.filter({ hasText: 'Security Review' }))).toBe(await left(projectName));
  expect(await left(projectRows.filter({ hasText: 'Sydney-C1' }))).toBeLessThan(await left(projectName));

  // A mouse drag on the Projects/Recents divider does not leave it focused.
  const divider = page.getByRole('separator', { name: /^Resize Projects and Recents/ });
  await expect(divider).toHaveAttribute('aria-disabled', 'false');
  await pointerDrag(page, divider, 0, 40);
  expect(await isFocused(divider)).toBe(false);

  // Pointer resize of the sidebar itself, released focus, browser-local persistence.
  const handle = page.getByRole('separator', { name: /^Resize sidebar/ });
  await expect(handle).toHaveAttribute('aria-controls', 'session-sidebar');
  expect(await shellWidth(page)).toBe(260);
  await pointerDrag(page, handle, 100, 0);
  expect(await shellWidth(page)).toBe(360);
  await expect(handle).toHaveAttribute('aria-valuenow', '360');
  expect(await isFocused(handle)).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('session-sidebar-width'))).toBe('360');

  // The width is applied before first paint on reload (the Chat host this time).
  await page.reload();
  await expect(page.locator('.session-sidebar-shell')).toBeVisible();
  expect(await shellWidth(page)).toBe(360);

  // Keyboard: arrows move the divider the way they point; Home restores the default.
  const reloadedHandle = page.getByRole('separator', { name: /^Resize sidebar/ });
  await reloadedHandle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(reloadedHandle).toHaveAttribute('aria-valuenow', '344');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(reloadedHandle).toHaveAttribute('aria-valuenow', '408');
  await page.keyboard.press('Home');
  // Keyboard steps keep the sidebar's width transition; wait for it to settle.
  await expect.poll(() => shellWidth(page)).toBe(260);
  expect(await page.evaluate(() => localStorage.getItem('session-sidebar-width'))).toBeNull();

  // Phones use the overlay drawer, which has no width handle.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.session-sidebar-resize-handle')).toHaveCount(0);
});
