import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

for (const scenario of [
  { width: 1280, theme: 'light', locale: 'en' },
  { width: 320, theme: 'dark', locale: 'zh-CN' },
]) {
  test(`Plugin inventory states at ${scenario.width}px (${scenario.theme})`, async ({ page, serverUrl }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 760 });
    await page.addInitScript(({ theme, locale }) => {
      localStorage.setItem('theme', theme);
      localStorage.setItem('locale', locale);
    }, scenario);
    await page.goto(serverUrl);
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      const id = 'plugin-cold-agent';
      store.agents = [{ id, name: 'Cold Agent', online: true, capabilities: ['yeaft_plugins'] }];
      store.currentAgent = id;
      store.currentView = 'yeaft';
      store.activePluginSession = () => ({ sessionId: '', agentId: '', workDir: '' });
      store.pluginConfigByAgent = { [id]: { loaded: true, plugins: {} } };
      store.loadPluginConfig = () => Promise.resolve({ loaded: true, plugins: {} });
      store.loadPluginCatalog = () => Promise.resolve();
      store.pluginCatalogByKey = {
        [store.pluginCatalogKey(id, '')]: { loading: true, catalog: { tools: [], skills: [], mcpServers: [] } },
      };
      store.openPluginCenter(id);
    });
    const summary = page.locator('.plugin-center-overview-copy');
    const stats = page.locator('.plugin-center-overview-stats');
    await expect(summary).toContainText(scenario.locale === 'en' ? /Loading/ : /加载/);
    await expect(stats).toHaveCount(0);
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      const record = store.pluginCatalogByKey[store.pluginCatalogKey('plugin-cold-agent', '')];
      record.loading = false;
      record.error = 'catalog-timeout';
    });
    await expect(summary).toContainText('catalog-timeout');
    await expect(stats).toHaveCount(0);
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      store.pluginCatalogByKey[store.pluginCatalogKey('plugin-cold-agent', '')].error = null;
    });
    await expect(summary).not.toContainText('catalog-timeout');
    await expect(stats).toHaveCount(0);
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      store.pluginCatalogByKey[store.pluginCatalogKey('plugin-cold-agent', '')].catalog.tools = [
        { id: 'Bash', label: 'Bash', description: 'Execute a shell command.' },
      ];
    });
    await expect(page.locator('.plugin-center-enabled-count')).toHaveText('1 / 1');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`plugin-inventory-${scenario.width}.png`) });
  });
}
