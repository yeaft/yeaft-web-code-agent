import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

/** Helper: create a conversation via modal */
async function createConversation(chatPage) {
  await chatPage.click('.sidebar-nav-item');
  await chatPage.waitForSelector('.modal-overlay', { timeout: 5000 });
  await chatPage.waitForFunction(() => {
    const sel = document.querySelector('.resume-select');
    return sel && sel.options.length > 1;
  }, { timeout: 5000 });
  await chatPage.locator('.resume-select').selectOption({ index: 1 });
  await chatPage.click('.modern-btn');
  await chatPage.waitForSelector('.session-item.active', { timeout: 5000 });
}

test.describe('Agent 断线重连', () => {
  test('agent 断开后重连，已有会话保留', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);

    await chatPage.fill('.input-area textarea', 'test message');
    await chatPage.click('.send-btn');

    const msg = await mockAgent.waitForMessage('execute', 10000);
    const convId = msg.conversationId;
    mockAgent.simulateClaudeOutput(convId, 'response before disconnect');
    mockAgent.simulateTurnComplete(convId);
    await expect(chatPage.locator('.assistant-turn')).toBeVisible({ timeout: 5000 });

    const sessionCount = await chatPage.locator('.session-item').count();

    // Disconnect agent
    await mockAgent.disconnect();

    // Agent offline in UI
    await expect(chatPage.locator('.brand-label')).toHaveText('0 Agent', { timeout: 5000 });

    // Reconnect agent
    await mockAgent.reconnect();

    // Agent back online
    await expect(chatPage.locator('.brand-label')).not.toHaveText('0 Agent', { timeout: 5000 });

    // Sessions preserved
    await expect(chatPage.locator('.session-item')).toHaveCount(sessionCount);
  });
});
