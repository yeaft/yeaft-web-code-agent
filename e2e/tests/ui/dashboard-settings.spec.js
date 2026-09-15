import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

test.describe('Dashboard 设置', () => {
  test('renders compact General and filterable Users/Agents details', async ({ page, serverUrl }) => {
    await page.goto(serverUrl);
    await page.waitForSelector('.chat-page', { timeout: 10000 });

    await page.locator('.sidebar-bottom .sidebar-nav-item').click();
    await expect(page.locator('.settings-dialog')).toBeVisible();
    await page.locator('.settings-nav-item', { hasText: 'Dashboard' }).click();

    await expect(page.locator('.db-general-section')).toBeVisible();
    await expect(page.locator('.db-general-row')).toBeVisible();
    await expect(page.locator('.db-stat-card')).toHaveCount(0);
    await expect(page.locator('.db-detail-section')).toBeVisible();
    await expect(page.locator('.db-detail-tab')).toHaveCount(2);
    await expect(page.locator('.db-filter-header')).toBeVisible();
    await expect(page.locator('.db-filter-select select')).toHaveValue('all');

    await page.locator('.db-detail-tab', { hasText: 'Agents' }).click();
    await expect(page.locator('.db-detail-panel')).toBeVisible();
    await expect(page.locator('.db-filter-header')).toBeVisible();
    await expect(page.locator('.db-filter-select select')).toHaveValue('all');

    await page.setViewportSize({ width: 320, height: 720 });
    const layout = await page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      dialogOverflow: document.querySelector('.settings-dialog').scrollWidth
        > document.querySelector('.settings-dialog').clientWidth,
    }));
    expect(layout).toEqual({ documentOverflow: false, dialogOverflow: false });
  });

  test('shows a one-command installer for both target platforms without narrow-screen overflow', async ({ page, serverUrl }) => {
    await page.route('**/api/user/agent-secret', route => route.fulfill({ json: { agentSecret: 'fixture-not-a-real-secret' } }));
    await page.goto(serverUrl);
    await page.waitForSelector('.chat-page', { timeout: 10000 });
    await page.locator('.sidebar-bottom .sidebar-nav-item').click();
    await page.locator('.settings-nav-item', { hasText: 'Security' }).click();

    const installer = page.locator('.settings-dialog .agent-installer');
    await expect(installer).toBeVisible();
    await expect(installer.locator('.agent-installer-tab')).toHaveCount(2);
    await expect(installer.locator('code')).not.toBeVisible();
    await installer.locator('summary').click();
    await expect(installer.locator('code')).toBeVisible();
    await expect(installer.locator('code')).toContainText('/installers/install.sh');
    await expect(installer.locator('code')).toContainText('--secret \'fixture-not-a-real-secret\'');
    await expect(installer.locator('.agent-installer-copy')).toBeEnabled();
    await installer.locator('.agent-installer-tab').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(installer.locator('code')).toContainText('/installers/install.ps1');
    await expect(installer.locator('code')).toContainText('Invoke-WebRequest -UseBasicParsing');

    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 720 });
        const overflow = await installer.evaluate(el => ({
          document: document.documentElement.scrollWidth > innerWidth,
          installer: el.scrollWidth > el.clientWidth,
        }));
        expect(overflow).toEqual({ document: false, installer: false });
      }
    }
    for (const file of ['install.sh', 'install.ps1']) {
      const res = await page.request.get(`${serverUrl}/installers/${file}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toBe('no-store');
      expect(await res.text()).not.toContain('fixture-not-a-real-secret');
    }
  });
});
