import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.describe('Client WS 断线重连', () => {
  test('WS 断开后自动重连并恢复状态', async ({ chatPage, mockAgent }) => {
    // Verify normal connected state
    await expect(chatPage.locator('.connection-status')).not.toBeVisible();

    // Force close WebSocket
    await chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      if (store.ws) store.ws.close(4999, 'Test: simulated disconnect');
    });

    // Reconnecting status appears
    await expect(chatPage.locator('.connection-status')).toBeVisible({ timeout: 5000 });

    // Auto-reconnect restores connection
    await expect(chatPage.locator('.connection-status')).not.toBeVisible({ timeout: 15000 });

    // Agent list restored
    await expect(chatPage.locator('.brand-label')).not.toHaveText('0 Agent', { timeout: 5000 });
  });

});
