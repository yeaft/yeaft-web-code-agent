import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

// Run the same real-click journey against the development modules and the bundle.
test.use({ serverEnv: { SERVE_DIST: process.env.WC_NAV_PRODUCTION || 'false' } });

async function loadHost(page, serverUrl, host, theme) {
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('theme', theme);
    if (localStorage.getItem('work-center-ui-enabled') === null) {
      localStorage.setItem('work-center-ui-enabled', 'false');
    }
  }, { theme });
  await page.goto(serverUrl);
  await expect(page.locator('.chat-page')).toBeVisible();
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  if (host === 'yeaft') {
    // Only select the host as a fixture. Never set workCenterOpen or invoke its
    // entry action: General and every Work Center navigation below use clicks.
    await page.evaluate(() => window.Pinia.useChatStore().enterYeaft());
    await expect(page.locator('.yeaft-page')).toBeVisible();
  }
}

function generalRow(page) {
  return page.locator('.sp-row').filter({ has: page.locator('.sp-label', { hasText: /^Work Center$/ }) });
}

async function openGeneral(page, { collapsed = false } = {}) {
  if (collapsed) {
    await page.locator('.sidebar-collapsed-bar button[title="Settings"]').click();
  } else {
    await page.locator('.sidebar-nav-item').filter({ hasText: 'Settings' }).click();
  }
  await page.locator('.settings-nav-item').filter({ hasText: 'General' }).click();
  return generalRow(page);
}

async function expectEmptyWorkCenter(page) {
  await expect(page.locator('.work-center-main')).toBeVisible();
  await expect(page.locator('.work-center-main')).toContainText('No compatible');
  await expect(page.locator('.work-center-agent-picker')).toHaveCount(0);
  await expect(page.locator('.work-center-header-create')).toBeDisabled();
}

for (const host of ['chat', 'yeaft']) {
  for (const theme of ['light', 'dark']) {
    test(`${host} ${theme}: General, expanded and collapsed entries work without Agents`, async ({ page, serverUrl }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const requests = [];
      page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
        if (/work_center/.test(String(payload))) requests.push(String(payload));
      }));
      await loadHost(page, serverUrl, host, theme);
      await expect(page.locator('.sidebar-work-center-trigger')).toHaveCount(0);
      const row = await openGeneral(page);
      await row.getByRole('switch', { name: 'Work Center' }).click();
      await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
      await expect(row.getByRole('button', { name: 'Open Work Center' })).toBeVisible();
      await page.locator('.settings-close').click();
      const visibleEntry = page.locator('.sidebar-work-center-trigger:visible');
      await expect(visibleEntry).toHaveCount(1);
      await visibleEntry.click();
      await expectEmptyWorkCenter(page);

      await page.locator('.sidebar-header-actions button[title="Collapse sidebar"]').click();
      const railEntry = page.locator('.sidebar-collapsed-bar .sidebar-work-center-trigger');
      await expect(railEntry).toBeVisible();
      await expect(visibleEntry).toHaveCount(1);
      await expect(railEntry).toHaveAttribute('aria-pressed', 'true');
      // Chat's rail has no Settings control; expand it using the real menu button.
      if (host === 'chat') await page.locator('.sidebar-collapsed-bar button[title="Expand menu"]').click();
      await openGeneral(page, { collapsed: host === 'yeaft' });
      await row.getByRole('switch').click();
      await expect(page.locator('.sidebar-work-center-trigger')).toHaveCount(0);
      await expect(page.locator('.work-center-main')).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Open Work Center' })).toHaveCount(0);
      await row.getByRole('switch').click();
      await row.getByRole('button', { name: 'Open Work Center' }).click();
      await expect(page.locator('.settings-close')).toHaveCount(0);
      await expectEmptyWorkCenter(page);
      // A collapsed entry must open, not merely remain visible while already open.
      if (host === 'chat') await page.locator('.sidebar-header-actions button[title="Collapse sidebar"]').click();
      await page.evaluate(() => window.Pinia.useChatStore().leaveWorkCenter());
      await railEntry.focus();
      await railEntry.press('Enter');
      await expectEmptyWorkCenter(page);
      await expect(railEntry).toBeFocused();

      // Both pre-catalog legacy surfaces retain the same visible destination.
      await page.evaluate(() => { window.Pinia.useChatStore().sessionCatalogLoaded = false; });
      await expect(visibleEntry).toHaveCount(1);
      await page.locator('.sidebar-collapsed-bar button[title="Expand menu"]').click();
      await expect(visibleEntry).toHaveCount(1);
      await visibleEntry.click();
      await expectEmptyWorkCenter(page);
      expect(requests).toEqual([]);

      // Reload checks persisted preference, not a runtime-only flag.
      await page.reload();
      await expect(page.locator('.sidebar-work-center-trigger:visible')).toHaveCount(1);
      await page.locator('.sidebar-work-center-trigger:visible').click();
      await expectEmptyWorkCenter(page);
    });

    test(`${host} ${theme}: 320px General and drawer navigation reveal the destination`, async ({ page, serverUrl }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await loadHost(page, serverUrl, host, theme);
      await page.locator(host === 'chat' ? '.header-sidebar-toggle' : '.yeaft-topbar-sidebar-toggle').click();
      const row = await openGeneral(page);
      await row.getByRole('switch').click();
      const directEntry = row.getByRole('button', { name: 'Open Work Center' });
      await directEntry.scrollIntoViewIfNeeded();
      const bounds = await directEntry.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      await directEntry.click();
      await expectEmptyWorkCenter(page);
      await expect(page.locator('.sidebar-overlay, .yeaft-sidebar-overlay')).toHaveCount(0);
      await expect(page.locator('.settings-close')).toHaveCount(0);
      await page.locator('.work-center-sidebar-toggle').click();
      await expect(page.locator('.sidebar-overlay, .yeaft-sidebar-overlay')).toBeVisible();
      await page.locator('.sidebar-work-center-trigger:visible').click();
      await expect(page.locator('.sidebar-overlay, .yeaft-sidebar-overlay')).toHaveCount(0);
      await expectEmptyWorkCenter(page);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
