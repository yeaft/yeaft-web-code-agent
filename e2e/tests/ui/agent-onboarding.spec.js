import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

const agentSecret = 'fixture-not-a-real-secret';

async function openHome(page, serverUrl) {
  await page.addInitScript(() => {
    window.__copiedInstaller = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { window.__copiedInstaller = text; } },
    });
  });
  await page.route('**/api/user/agent-secret', route => route.fulfill({ json: { agentSecret } }));
  await page.goto(serverUrl);
  await expect(page.locator('.welcome-setup .agent-installer-copy')).toBeEnabled();
}

for (const theme of ['light', 'dark']) {
  for (const width of [320, 1280]) {
    test(`no-Agent home is compact and usable: ${theme}, ${width}px`, async ({ page, serverUrl }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await openHome(page, serverUrl);
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      const installer = page.locator('.welcome-setup .agent-installer');
      await expect(page.locator('.welcome-content h1')).toHaveText('Connect your Agent');
      await expect(page.locator('.input-container')).toHaveCount(0);
      await expect(page.locator('textarea')).toHaveCount(0);
      await expect(page.locator('.transcript-navigation')).toHaveCount(0);
      await expect(page.locator('.welcome-setup-step')).toHaveCount(0);
      await expect(page.locator('.welcome-content')).not.toContainText('Optional model setup');
      await expect(installer.locator('code')).not.toBeVisible();

      await installer.locator('.agent-installer-copy').focus();
      await expect(installer.locator('.agent-installer-copy')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(installer.locator('.agent-installer-copy')).toHaveText('Copied');
      expect(await page.evaluate(() => window.__copiedInstaller)).toContain(`--secret '${agentSecret}'`);
      expect(await page.evaluate(() => window.__copiedInstaller)).toContain('/installers/install.sh');

      await installer.locator('.agent-installer-tab').nth(1).click();
      await expect(installer.locator('.agent-installer-tab').nth(1)).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: testInfo.outputPath(`home-${theme}-${width}.png`), fullPage: true });
      await page.evaluate(async () => {
        const { setLocale } = await import('/utils/i18n.js');
        setLocale('zh-CN');
      });
      await expect(page.locator('.welcome-content h1')).toHaveText('连接你的 Agent');
      await expect(installer.locator('.agent-installer-copy')).toHaveText('复制安装命令');
      await page.screenshot({ path: testInfo.outputPath(`home-zh-${theme}-${width}.png`), fullPage: true });
      await installer.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(installer.locator('code')).toBeVisible();
      await expect(installer.locator('code')).toContainText('Invoke-WebRequest -UseBasicParsing');
      await installer.locator('.agent-installer-copy').click();
      expect(await page.evaluate(() => window.__copiedInstaller)).toContain('/installers/install.ps1');
      const geometry = await installer.evaluate(el => {
        const copy = el.querySelector('.agent-installer-copy');
        return {
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          installerOverflow: el.scrollWidth > el.clientWidth,
          copyHeight: copy.getBoundingClientRect().height,
          copyRadius: parseFloat(getComputedStyle(copy).borderRadius),
        };
      });
      expect(geometry.pageOverflow).toBe(false);
      expect(geometry.installerOverflow).toBe(false);
      expect(geometry.copyHeight).toBeGreaterThanOrEqual(40);
      expect(geometry.copyHeight).toBeLessThanOrEqual(60);
      expect(geometry.copyRadius).toBeGreaterThan(0);
    });
  }
}

test('loading, unavailable secret and clipboard denial remain actionable', async ({ page, serverUrl }) => {
  let deliverSecret;
  const secretReady = new Promise(resolve => { deliverSecret = resolve; });
  await page.route('**/api/user/agent-secret', async route => {
    await secretReady;
    await route.fulfill({ status: 503, json: { error: 'Unavailable' } });
  });
  await page.goto(serverUrl);
  const installer = page.locator('.welcome-setup .agent-installer');
  await expect(installer.locator('.agent-installer-copy')).toBeDisabled();
  await expect(installer.locator('.agent-installer-status')).toContainText('Preparing');
  deliverSecret();
  await expect(installer.locator('.agent-installer-status')).toContainText('Could not prepare');
  await expect(installer.locator('.agent-installer-settings')).toBeVisible();
  await page.unroute('**/api/user/agent-secret');
  await openHome(page, serverUrl);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
  await installer.locator('.agent-installer-copy').click();
  await expect(installer.locator('.agent-installer-status')).toContainText('Select and copy');
  await expect(installer.locator('code')).toBeVisible();
});

test('Agent reconnect restores the Composer without hiding offline conversations', async ({ page, serverUrl, mockAgent }) => {
  await mockAgent.disconnect();
  await openHome(page, serverUrl);
  await expect(page.locator('textarea')).toHaveCount(0);
  await mockAgent.connect();
  await expect(page.locator('.welcome-status')).toBeVisible();
  await expect(page.locator('.welcome-setup')).toHaveCount(0);
  await expect(page.locator('.welcome-title')).toHaveText('Yeaft');
  await expect(page.locator('textarea')).toBeVisible();

  await mockAgent.disconnect();
  await expect(page.locator('.welcome-setup')).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await page.evaluate(agentId => {
    const store = window.Pinia.useChatStore();
    const id = 'offline-conversation';
    store.conversations = [{ id, agentId, type: 'chat', provider: 'copilot', workDir: '/tmp/example' }];
    store.messagesMap[id] = [];
    store.activeConversations = [id];
    store.currentView = 'chat';
  }, mockAgent.agentId);
  await expect(page.locator('.welcome-setup')).toHaveCount(0);
  await expect(page.locator('textarea')).toBeVisible();
  await expect(page.locator('.transcript-navigation')).toBeVisible();
});

test('native no-session guide has no dead Composer or empty LLM configuration step', async ({ page, serverUrl }) => {
  await openHome(page, serverUrl);
  await page.waitForFunction(() => window.Pinia.useChatStore()._hasHandledAgentList === true);
  await page.evaluate(() => { window.Pinia.useChatStore().currentView = 'yeaft'; });
  const guide = page.locator('.yeaft-onboarding');
  await expect(guide).toBeVisible();
  await expect(guide.locator('.agent-installer')).toBeVisible();
  await expect(guide.locator('.yeaft-onboarding-step')).toHaveCount(1);
  await expect(guide.getByRole('button', { name: 'Open LLM settings' })).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
});
