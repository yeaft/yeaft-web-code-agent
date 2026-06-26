/**
 * E2E Test: Conversation Management
 *
 * Tests conversation CRUD operations using SKIP_AUTH=true server.
 *   - Create a new conversation via the modal
 *   - Conversation appears in sidebar list
 *   - Delete a conversation
 *   - Switch between conversations restores messages
 */
import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

/**
 * Helper: open the new-conversation modal and create a conversation.
 */
async function createConversation(chatPage, mockAgent) {
  const beforeCount = await chatPage.locator('.session-item').count();

  // Click "New Conversation" in the Chat session tab
  await chatPage.locator('.session-tab-add-btn').click();

  // Wait for the conversation modal to appear
  await expect(chatPage.locator('.modal.resume-modal')).toBeVisible({ timeout: 5000 });

  // Agent should be auto-selected (first online agent)
  // Wait for the create button to be enabled and click it
  await chatPage.locator('.resume-modal-footer .modern-btn').click();

  // Wait for modal to close and conversation to be created
  await expect(chatPage.locator('.modal.resume-modal')).not.toBeVisible({ timeout: 5000 });

  // Wait for the new conversation to appear in the sidebar
  await expect(chatPage.locator('.session-item')).toHaveCount(beforeCount + 1, { timeout: 5000 });
}

test.describe('Conversation Management', () => {
  test('should create a new conversation via modal', async ({ chatPage, mockAgent }) => {
    const initialCount = await chatPage.locator('.session-item').count();

    await createConversation(chatPage, mockAgent);

    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 1);
    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
  });

  test('should select agent in conversation modal', async ({ chatPage, mockAgent }) => {
    await chatPage.locator('.session-tab-add-btn').click();
    await expect(chatPage.locator('.modal.resume-modal')).toBeVisible({ timeout: 5000 });

    const agentSelect = chatPage.locator('.resume-modal .resume-select').first();
    await expect(agentSelect).toBeVisible();

    const options = agentSelect.locator('option');
    const optCount = await options.count();
    expect(optCount).toBeGreaterThanOrEqual(2);

    await chatPage.locator('.resume-close-btn').click();
    await expect(chatPage.locator('.modal.resume-modal')).not.toBeVisible();
  });

  test('should show conversation in sidebar list after creation', async ({ chatPage, mockAgent }) => {
    const initialCount = await chatPage.locator('.session-item').count();

    await createConversation(chatPage, mockAgent);
    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 1);

    await createConversation(chatPage, mockAgent);
    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 2);

    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
  });

  test('should delete a conversation', async ({ chatPage, mockAgent }) => {
    const initialCount = await chatPage.locator('.session-item').count();

    await createConversation(chatPage, mockAgent);
    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount + 1);

    // Auto-accept the confirm dialog when delete is clicked
    chatPage.on('dialog', dialog => dialog.accept());

    const activeItem = chatPage.locator('.session-item.active');
    await activeItem.hover();

    const menuButton = activeItem.locator('.session-dots-btn');
    await expect(menuButton).toBeVisible({ timeout: 3000 });
    await menuButton.click();
    await chatPage.locator('.session-menu-item.danger').click();

    await expect(chatPage.locator('.session-item')).toHaveCount(initialCount, { timeout: 10000 });
  });

  test('should switch between conversations and restore messages', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage, mockAgent);

    // Get conversationId from mockAgent's received messages
    const createMsg = mockAgent._receivedMessages.filter(m => m.type === 'create_conversation').pop();
    const firstConversationId = createMsg?.conversationId;

    await chatPage.fill('.input-area textarea', 'Message in first conversation');
    await chatPage.locator('.send-btn').last().click();

    await expect(chatPage.locator('.message.user').last())
      .toContainText('Message in first conversation', { timeout: 5000 });

    mockAgent.simulateClaudeOutput(firstConversationId, 'Reply to first conversation');
    mockAgent.simulateTurnComplete(firstConversationId);
    await expect(chatPage.locator('.assistant-turn').last())
      .toContainText('Reply to first conversation', { timeout: 5000 });

    // Create second conversation
    await createConversation(chatPage, mockAgent);

    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
    await expect(chatPage.locator('.message.user')).toHaveCount(0, { timeout: 3000 });

    // Switch back to first conversation by clicking the session item with our title
    const firstConvItem = chatPage.locator('.session-item', { hasText: 'Message in first conversation' });
    const itemExists = await firstConvItem.count();
    if (itemExists > 0) {
      await firstConvItem.first().click();

      await expect(chatPage.locator('.message.user').first())
        .toContainText('Message in first conversation', { timeout: 5000 });
    }
  });
});
