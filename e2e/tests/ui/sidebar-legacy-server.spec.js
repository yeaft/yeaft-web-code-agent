import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

// Emulate an old Server on the wire: no catalog or capability/completion frames.
// Its successful empty inventory must enable creating the very first Session.
test('legacy empty inventory keeps the final sidebar and permits first Session creation', async ({ page, serverUrl, mockAgent }) => {
  await page.routeWebSocket(/\?type=web/, client => {
    const server = client.connectToServer();
    server.onMessage(message => {
      const packet = JSON.parse(message.toString());
      if (packet.type === 'session_catalog_snapshot' || packet.type === 'yeaft_session_hydrate_complete') return;
      if (packet.type === 'auth_result') {
        delete packet.sessionCatalogProtocol;
        delete packet.yeaftSessionInventoryComplete;
        client.send(JSON.stringify(packet));
      } else client.send(message);
    });
  });
  await page.goto(serverUrl);
  const navigation = page.locator('.sidebar-navigation');
  await expect(navigation).toBeVisible();
  await expect(navigation).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.session-tab-solo')).toHaveCount(0);
  await expect(navigation.locator('.session-item')).toHaveCount(0);
  await expect(navigation.locator('.sidebar-primary-action:not(.sidebar-plugins-entry):not(.sidebar-task-create)')).toBeEnabled();
  await navigation.locator('.sidebar-primary-action:not(.sidebar-plugins-entry):not(.sidebar-task-create)').click();
  const modal = page.locator('.yeaft-session-create-modal');
  await expect(modal).toBeVisible();
  expect(await page.evaluate(() => window.Pinia.useChatStore().sessionCatalogProtocolSupported)).toBe(false);
  await modal.locator('.resume-control-row').nth(1).locator('.modern-select-trigger').click();
  await page.locator('.yeaft-session-create-select-menu .modern-select-option', { hasText: 'Claude Code' }).click();
  await modal.locator('.resume-modal-footer .modern-btn').click();
  await expect(modal).not.toBeVisible();
  await expect(navigation.locator('.session-item')).toHaveCount(1);
  const row = navigation.locator('.session-item');
  await row.hover();
  await row.locator('.session-quick-action').first().click();
  await expect(row.locator('.session-pin-icon')).toHaveCount(1);
  await row.locator('.session-quick-action').first().click();
  await expect(row.locator('.session-pin-icon')).toHaveCount(0);
  await expect(row.locator('.session-remove-icon').locator('..')).toBeDisabled();
  expect(await page.evaluate(() => Object.keys(window.Pinia.useChatStore().sessionCatalogMutationRequests))).toEqual([]);

  const firstId = await page.evaluate(() => {
    const store = window.Pinia.useChatStore();
    const conversation = store.conversations.find(item => item.type === 'chat');
    conversation.createdAt = Date.now() - 60000;
    store.customConversationTitles[conversation.id] = 'First Chat';
    return conversation.id;
  });
  await navigation.locator('.sidebar-primary-action:not(.sidebar-plugins-entry):not(.sidebar-task-create)').click();
  await expect(modal).toBeVisible();
  await modal.locator('.resume-control-row').nth(1).locator('.modern-select-trigger').click();
  await page.locator('.yeaft-session-create-select-menu .modern-select-option', { hasText: 'Claude Code' }).click();
  await modal.locator('.resume-modal-footer .modern-btn').click();
  await expect(modal).not.toBeVisible();
  await expect(navigation.locator('.session-item')).toHaveCount(2);
  const titles = navigation.locator('.sidebar-session-title-text');
  await expect(titles.nth(1)).toHaveText('First Chat');
  await page.evaluate(() => {
    const store = window.Pinia.useChatStore();
    const conversation = store.conversations.find(item => item.type === 'chat' && !store.customConversationTitles[item.id]);
    store.customConversationTitles[conversation.id] = 'Second Chat';
  });
  await expect(titles).toHaveText(['Second Chat', 'First Chat']);
  await page.evaluate(id => {
    const store = window.Pinia.useChatStore();
    store.conversations.find(item => item.id === id).lastMessageAt = Date.now() + 1000;
  }, firstId);
  await expect(titles).toHaveText(['First Chat', 'Second Chat']);
});
