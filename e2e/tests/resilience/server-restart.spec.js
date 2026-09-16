import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

import { createConversation } from '../../helpers/conversation.js';

test.describe('Server 重启恢复', () => {
  test('server 重启后 client 自动重连', async ({ chatPage, testServer, mockAgent }) => {
    await createConversation(chatPage);

    await chatPage.fill('.input-area textarea', 'hello before restart');
    await chatPage.click('.send-btn');

    const msg = await mockAgent.waitForMessage('execute', 10000);
    mockAgent.simulateClaudeOutput(msg.conversationId, 'I am here');
    mockAgent.simulateTurnComplete(msg.conversationId);
    await expect(chatPage.locator('.assistant-turn')).toBeVisible({ timeout: 5000 });

    // Kill server
    await testServer.kill();

    // Client shows disconnected status
    await expect(chatPage.locator('.connection-status')).toBeVisible({ timeout: 10000 });

    // Restart server
    await testServer.restart();

    // Agent reconnects
    await mockAgent.reconnect();

    // Client auto-reconnects — connection-status disappears
    await expect(chatPage.locator('.connection-status')).not.toBeVisible({ timeout: 20000 });

    // Agent is back online
    await expect(chatPage.locator('.brand-label')).not.toHaveText('0 Agent', { timeout: 5000 });
  });
});
