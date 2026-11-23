import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

import { createConversation } from '../../helpers/conversation.js';

test.describe('Server 重启恢复', () => {
  test('server 重启与断网重叠时自动恢复输入，且不会重发草稿', async ({ chatPage, testServer, mockAgent }) => {
    await createConversation(chatPage);

    await chatPage.fill('.input-area textarea', 'hello before restart');
    await chatPage.click('.send-btn');

    const msg = await mockAgent.waitForMessage('execute', 10000);
    mockAgent.simulateClaudeOutput(msg.conversationId, 'I am here');
    mockAgent.simulateTurnComplete(msg.conversationId);
    await expect(chatPage.locator('.assistant-turn')).toBeVisible({ timeout: 5000 });

    const input = chatPage.locator('.input-area textarea');
    const send = chatPage.locator('.input-area .send-btn:not(.stop-btn)');
    await input.fill('draft during restart');
    await chatPage.context().setOffline(true);
    await testServer.kill();

    await expect(chatPage.locator('.connection-status')).toBeVisible({ timeout: 10000 });
    await expect(send).toBeDisabled();
    await input.fill('draft edited while offline');

    // Restart server
    await testServer.restart();

    // Agent reconnects
    await mockAgent.reconnect();

    // No focus/visibility change: reconnect directly from the online event.
    await chatPage.context().setOffline(false);
    await expect(chatPage.locator('.connection-status')).not.toBeVisible({ timeout: 20000 });
    await expect(input).toHaveValue('draft edited while offline');
    await expect(chatPage.getByText('draft edited while offline', { exact: true })).toHaveCount(0);
    await expect(send).toBeEnabled();

    // Agent is back online
    await expect(chatPage.locator('.brand-label')).not.toHaveText('0 Agent', { timeout: 5000 });
  });
});
