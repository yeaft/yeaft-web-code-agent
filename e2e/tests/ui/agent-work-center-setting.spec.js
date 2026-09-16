import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

async function openDisabledWorkCenter(page, serverUrl, { width, locale }) {
  await page.setViewportSize({ width, height: 760 });
  await page.addInitScript(({ locale }) => {
    localStorage.setItem('locale', locale);
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('work-center-ui-enabled', 'true');
  }, { locale });
  await page.goto(serverUrl);
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
  await page.evaluate(async () => {
    const store = window.Pinia.useChatStore();
    const agentId = 'work-center-setting-agent';
    const record = { enabled: false, effective: false, overridden: false, loaded: true };
    store.currentAgent = agentId;
    store.agents = [{
      id: agentId,
      name: 'Work Center Agent',
      online: true,
      version: '1.0.543',
      workDir: '/workspace/project',
      capabilities: ['work_center_feature_settings'],
    }];
    store.workCenterFeatureSettingsByAgent = { [agentId]: record };
    store.loadTelemetrySettings = () => Promise.resolve({ enabled: true });
    store.loadWorkCenterFeatureSettings = async () => {
      store.workCenterFeatureSettingsByAgent = { [agentId]: { ...record } };
      return { ...record };
    };
    store.updateWorkCenterFeatureSettings = async ({ enabled }) => {
      const next = { enabled, effective: enabled, overridden: false, loaded: true };
      store.workCenterFeatureSettingsByAgent = { [agentId]: next };
      store.agents = store.agents.map(agent => ({
        ...agent,
        capabilities: enabled
          ? ['work_center_feature_settings', 'work_center', 'work_center_message_v2']
          : ['work_center_feature_settings'],
      }));
      return { ...next, persisted: true, sessionTools: enabled ? 'new_sessions_only' : 'disabled_immediately' };
    };
    store.listWorkItems = () => Promise.resolve([]);
    await window.Vue.nextTick();
  });
  if (width <= 680) await page.locator('.header-sidebar-toggle').click();
  await page.locator('.sidebar-work-center-trigger:visible').click();
}

for (const scenario of [
  { width: 1280, locale: 'en', disabledText: 'Work Center is disabled on the online Agent', open: 'Open Agent settings', title: 'Work Center', status: 'Disabled' },
  { width: 320, locale: 'zh-CN', disabledText: '在线 Agent 尚未启用工作中心', open: '打开 Agent 设置', title: '工作中心', status: '已停用' },
]) {
  test(`Agent setting hot-enables Work Center at ${scenario.width}px`, async ({ page, serverUrl }, testInfo) => {
    await openDisabledWorkCenter(page, serverUrl, scenario);
    const workspace = page.locator('.work-center-main');
    await expect(workspace).toContainText(scenario.disabledText);
    await workspace.getByRole('button', { name: scenario.open }).click();

    const dialog = page.getByRole('dialog', { name: /Agent settings|Agent 设置/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.agent-settings-work-center-row strong')).toBeFocused();
    await dialog.locator('.settings-close').focus();
    await dialog.locator('.settings-close').press('Shift+Tab');
    await expect(dialog.locator('.agent-settings-danger-button')).toBeFocused();
    await dialog.locator('.agent-settings-danger-button').press('Tab');
    await expect(dialog.locator('.settings-close')).toBeFocused();
    const toggle = dialog.getByRole('switch', { name: scenario.title, exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeEnabled();
    await expect(dialog.locator('.agent-settings-setting-status')).toHaveText(scenario.status);
    const toggleBounds = await toggle.locator('..').boundingBox();
    expect(toggleBounds.width).toBeGreaterThanOrEqual(44);
    expect(toggleBounds.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`agent-work-center-setting-${scenario.width}.png`) });
    await toggle.focus();
    await toggle.press('Space');
    await expect(dialog).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`work-center-enabled-${scenario.width}.png`) });

    await expect(workspace.locator('.work-center-heading')).toContainText('Work Center Agent');
    await expect(workspace).not.toContainText(scenario.disabledText);
    if (scenario.width <= 1100) {
      const navigation = workspace.locator('.work-center-navigation-toggle:visible');
      await expect(navigation).toBeFocused();
      await navigation.click();
    }
    await expect(workspace.locator('.work-center-agent-list')).toContainText('Work Center Agent');
    await expect(workspace.locator('.work-center-return')).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
