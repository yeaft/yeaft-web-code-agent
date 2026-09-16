import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

// The same click journeys run against development modules and the production bundle.
test.use({ serverEnv: { SERVE_DIST: process.env.WC_NAV_PRODUCTION || 'false' } });

async function loadHost(page, serverUrl, host, theme, locale = 'en') {
  await page.addInitScript(({ theme, locale }) => {
    localStorage.setItem('locale', locale);
    localStorage.setItem('theme', theme);
    if (localStorage.getItem('work-center-ui-enabled') === null) {
      localStorage.setItem('work-center-ui-enabled', 'false');
    }
  }, { theme, locale });
  await page.goto(serverUrl);
  await expect(page.locator('.chat-page')).toBeVisible();
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  if (host === 'yeaft') {
    // Select only the host as a fixture; entry and exit below are real clicks.
    await page.evaluate(() => window.Pinia.useChatStore().enterYeaft());
    await expect(page.locator('.yeaft-page')).toBeVisible();
  }
}

async function openGeneral(page) {
  await page.locator('.sidebar-nav-item').filter({ hasText: 'Settings' }).click();
  await page.locator('.settings-nav-item').filter({ hasText: 'General' }).click();
  return page.locator('.sp-row').filter({ has: page.getByRole('switch', { name: /Work Center/ }) });
}

async function expectEmptyWorkCenter(page) {
  await expect(page.locator('.work-center-main')).toBeVisible();
  await expect(page.locator('.work-center-main')).toContainText('No online agents');
  await expect(page.locator('.work-center-agent-picker')).toHaveCount(0);
  await expect(page.locator('.work-center-header-actions')).toHaveCount(1);
  await expect(page.locator('.work-center-close-button')).toBeVisible();
  await expect(page.locator('.session-sidebar-shell')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Close Work Center' })).toBeVisible();
  const bounds = await page.locator('.work-center-main').boundingBox();
  expect(bounds.x).toBe(0);
  expect(bounds.width).toBe(page.viewportSize().width);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const host of ['chat', 'yeaft']) {
  for (const theme of ['light', 'dark']) {
    test(`${host} ${theme}: header and rail open a full-screen workspace with a way back`, async ({ page, serverUrl }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const requests = [];
      page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
        if (/work_center/.test(String(payload))) requests.push(String(payload));
      }));
      await loadHost(page, serverUrl, host, theme);
      await expect(page.locator('.sidebar-work-center-trigger')).toHaveCount(0);
      const row = await openGeneral(page);
      const toggle = row.getByRole('switch');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(row.getByRole('button', { name: 'Open Work Center' })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('general-settings.png') });
      await page.locator('.settings-close').click();

      const entry = page.locator('.sidebar-header-actions .sidebar-work-center-trigger');
      await expect(entry).toBeVisible();
      await expect(page.locator('.sidebar-navigation .sidebar-work-center-trigger')).toHaveCount(0);
      const entryRect = await entry.boundingBox();
      const collapseRect = await page.locator('.sidebar-header-actions button[title="Collapse sidebar"]').boundingBox();
      expect(entryRect.x + entryRect.width).toBeLessThanOrEqual(collapseRect.x);
      expect(entryRect.y + entryRect.height / 2).toBe(collapseRect.y + collapseRect.height / 2);
      const icon = await page.locator('.sidebar-primary-action-icon').boundingBox();
      const label = await page.locator('.sidebar-primary-action > span').boundingBox();
      expect(Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath('sidebar-header.png') });
      await entry.click();
      await expectEmptyWorkCenter(page);
      await expect(page.getByRole('button', { name: 'Close Work Center' })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('work-center.png') });
      await page.getByRole('button', { name: 'Close Work Center' }).press('Enter');
      await expect(entry).toBeFocused();
      await expect(page.locator('.work-center-main')).toHaveCount(0);

      await page.locator('.sidebar-header-actions button[title="Collapse sidebar"]').click();
      const railEntry = page.locator('.sidebar-collapsed-bar .sidebar-work-center-trigger');
      await railEntry.focus();
      await railEntry.press('Enter');
      await expectEmptyWorkCenter(page);
      await page.getByRole('button', { name: 'Close Work Center' }).click();
      await expect(railEntry).toBeFocused();
      await expect(page.locator('.session-sidebar-shell')).toHaveClass(/collapsed/);
      await page.locator('.sidebar-collapsed-bar button[title="Expand menu"]').click();

      // Before the catalog arrives there must still be exactly one header entry.
      await page.evaluate(() => { window.Pinia.useChatStore().sessionCatalogLoaded = false; });
      await expect(page.locator('.sidebar-work-center-trigger:visible')).toHaveCount(1);
      await entry.click();
      await expectEmptyWorkCenter(page);
      await page.getByRole('button', { name: 'Close Work Center' }).click();
      expect(requests).toEqual([]);

      await page.reload();
      await expect(page.locator('.sidebar-work-center-trigger:visible')).toHaveCount(1);
      await openGeneral(page);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await page.locator('.settings-close').click();
      await expect(page.locator('.sidebar-work-center-trigger')).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.sidebar-work-center-trigger')).toHaveCount(0);
    });

    test(`${host} ${theme}: 320px switches, full-screen entry and return are usable`, async ({ page, serverUrl }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await loadHost(page, serverUrl, host, theme);
      const drawerButton = page.locator(host === 'chat' ? '.header-sidebar-toggle' : '.yeaft-topbar-sidebar-toggle');
      await drawerButton.click();
      const row = await openGeneral(page);
      const toggle = row.getByRole('switch');
      await toggle.scrollIntoViewIfNeeded();
      const bounds = await toggle.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      await toggle.focus();
      await toggle.press('Space');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await page.screenshot({ path: testInfo.outputPath('general-settings-mobile.png') });
      await page.locator('.settings-close').click();
      await page.locator('.sidebar-work-center-trigger:visible').click();
      await expectEmptyWorkCenter(page);
      await expect(page.locator('.sidebar-overlay, .yeaft-sidebar-overlay')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('work-center-mobile.png') });
      await page.getByRole('button', { name: 'Close Work Center' }).click();
      await expect(page.locator('.work-center-main')).toHaveCount(0);
      await expect(drawerButton).toBeFocused();
      await drawerButton.click();
      await expect(page.locator('.sidebar-work-center-trigger:visible')).toHaveCount(1);
    });
  }
}
for (const width of [1280, 320]) {
  test(`Chinese dark ${width}px: current states and failed telemetry changes stay unambiguous`, async ({ page, serverUrl }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await loadHost(page, serverUrl, 'chat', 'dark', 'zh-CN');
    // Control only the remote telemetry response; exercise the actual Settings controls.
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      store.loadTelemetrySettings = () => Promise.resolve({ enabled: true });
      store.updateTelemetrySettings = () => new Promise((resolve, reject) => {
        window.rejectTelemetrySave = reject;
      });
    });
    if (width === 320) await page.locator('.header-sidebar-toggle').click();
    const icon = await page.locator('.sidebar-primary-action-icon').boundingBox();
    const label = await page.locator('.sidebar-primary-action > span').boundingBox();
    expect(Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2)).toBeLessThanOrEqual(1);
    await page.locator('.sidebar-nav-item').filter({ hasText: '设置' }).click();
    await page.locator('.settings-nav-item').filter({ hasText: '通用' }).click();
    const telemetry = page.getByRole('switch', { name: '性能遥测' });
    const telemetryRow = page.locator('.sp-row').filter({ has: telemetry });
    await expect(telemetry).toHaveAttribute('aria-checked', 'true');
    await expect(telemetryRow.locator('.sp-setting-status')).toHaveText('已开启');
    await expect(page.locator('.sp-custom-select-trigger').filter({ hasText: '当前：深色' })).toBeVisible();
    await expect(page.locator('.sp-custom-select-trigger').filter({ hasText: '当前：中文' })).toBeVisible();
    await telemetry.focus();
    await telemetry.press('Space');
    await expect(telemetry).toBeDisabled();
    await expect(telemetryRow.locator('.sp-setting-status')).toHaveText('保存中…');
    await expect(telemetry).toHaveAttribute('aria-checked', 'true');
    await page.evaluate(() => window.rejectTelemetrySave(new Error('offline')));
    await expect(telemetry).toBeEnabled();
    await expect(telemetry).toHaveAttribute('aria-checked', 'true');
    await expect(telemetryRow.getByRole('alert')).toContainText('无法确认');
    const entry = page.getByRole('switch', { name: '工作中心入口' });
    const entryRow = page.locator('.sp-row').filter({ has: entry });
    await expect(entryRow.locator('.sp-setting-status')).toHaveText('已关闭');
    await entry.click();
    await expect(entry).toHaveAttribute('aria-checked', 'true');
    await expect(entryRow.locator('.sp-setting-status')).toHaveText('已开启');
    await page.screenshot({ path: testInfo.outputPath('general-settings-chinese.png') });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('late Session hydration cannot cover the full-screen Work Center', async ({ page, serverUrl }) => {
  await loadHost(page, serverUrl, 'yeaft', 'dark');
  await page.evaluate(() => {
    window.Pinia.useChatStore().setWorkCenterUiEnabled(true);
    window.Pinia.useChatStore().sessionCatalogLoaded = false;
  });
  await page.locator('.sidebar-work-center-trigger:visible').click();
  await page.evaluate(() => {
    const sessions = window.Pinia.useSessionsStore();
    const key = 'agent-a\u001flate-empty';
    sessions.sessions[key] = { id: 'late-empty', agentId: 'agent-a', name: 'Late Session', roster: [], defaultVpId: null };
    sessions.activeSessionKey = key;
    sessions.activeSessionId = 'late-empty';
  });
  await expect(page.locator('.group-invite-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Work Center' }).click();
  await expect(page.locator('.work-center-main')).toHaveCount(0);
  // The invitation belongs to the conversation, and is still offered on return.
  await expect(page.locator('.group-invite-overlay')).toBeVisible();
});

test('reopening Settings ignores a late older telemetry load', async ({ page, serverUrl }) => {
  await loadHost(page, serverUrl, 'chat', 'light');
  await page.evaluate(() => {
    window.telemetryLoads = [];
    window.Pinia.useChatStore().loadTelemetrySettings = () => new Promise(resolve => window.telemetryLoads.push(resolve));
  });
  await openGeneral(page);
  const telemetry = page.getByRole('switch', { name: 'Performance telemetry' });
  await expect(telemetry).toBeDisabled();
  await page.locator('.settings-close').click();
  await openGeneral(page);
  await page.evaluate(() => window.telemetryLoads[1]({ enabled: false }));
  await expect(telemetry).toBeEnabled();
  await expect(telemetry).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => window.telemetryLoads[0]({ enabled: true }));
  await expect(telemetry).toHaveAttribute('aria-checked', 'false');
});
