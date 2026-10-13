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
