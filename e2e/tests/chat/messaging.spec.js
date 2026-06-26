/**
 * E2E Test: Messaging
 *
 * Tests message sending, receiving, and streaming display.
 *   - Send a message and receive assistant reply
 *   - Streaming messages appear progressively
 *   - Message list scrolls to bottom on new messages
 */
import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

/**
 * Helper: create a conversation and return the conversationId.
 * Gets the conversationId from the mockAgent's received create_conversation message.
 */
async function createConversationAndGetId(chatPage, mockAgent) {
  const beforeCount = await chatPage.locator('.session-item').count();

  // Click "New Conversation" in the Chat session tab
  await chatPage.locator('.session-tab-add-btn').click();
  await expect(chatPage.locator('.modal.resume-modal')).toBeVisible({ timeout: 5000 });

  // Click create button
  await chatPage.locator('.resume-modal-footer .modern-btn').click();
  await expect(chatPage.locator('.modal.resume-modal')).not.toBeVisible({ timeout: 5000 });

  // Wait for session item to appear (conversation created)
  await expect(chatPage.locator('.session-item')).toHaveCount(beforeCount + 1, { timeout: 5000 });

  // Get the conversationId from the mockAgent's received create_conversation message
  const createMsg = mockAgent._receivedMessages.filter(m => m.type === 'create_conversation').pop();
  return createMsg?.conversationId;
}

test.describe('Messaging', () => {
  test('should send a message and see it in the message list', async ({ chatPage, mockAgent }) => {
    await createConversationAndGetId(chatPage, mockAgent);

    // Type a message
    await chatPage.fill('.input-area textarea', 'Hello Claude');

    // Click the send button
    await chatPage.locator('.send-btn').last().click();

    // User message should appear in the message list
    await expect(chatPage.locator('.message.user').last())
      .toContainText('Hello Claude', { timeout: 5000 });
  });

  test('should receive assistant reply after sending message', async ({ chatPage, mockAgent }) => {
    const convId = await createConversationAndGetId(chatPage, mockAgent);
    expect(convId).toBeTruthy();

    // Send a message
    await chatPage.fill('.input-area textarea', 'Hello Claude');
    await chatPage.locator('.send-btn').last().click();

    // Wait for user message to appear
    await expect(chatPage.locator('.message.user').last())
      .toContainText('Hello Claude', { timeout: 5000 });

    // Mock agent simulates Claude response
    mockAgent.simulateClaudeOutput(convId, 'Hello! How can I help you today?');
    mockAgent.simulateTurnComplete(convId);

    // Assistant reply should appear
    await expect(chatPage.locator('.assistant-turn').last())
      .toContainText('Hello! How can I help you today?', { timeout: 5000 });
  });

  test('should display streaming message progressively', async ({ chatPage, mockAgent }) => {
    const convId = await createConversationAndGetId(chatPage, mockAgent);
    expect(convId).toBeTruthy();

    // Send a message
    await chatPage.fill('.input-area textarea', 'Tell me a story');
    await chatPage.locator('.send-btn').last().click();

    // Wait for user message
    await expect(chatPage.locator('.message.user').last())
      .toContainText('Tell me a story', { timeout: 5000 });

    // Simulate streaming: first chunk
    mockAgent.simulateClaudeOutput(convId, 'Once upon a time');

    // Should see the first chunk
    await expect(chatPage.locator('.assistant-turn').last())
      .toContainText('Once upon a time', { timeout: 5000 });

    // The message should have streaming indicator
    await expect(chatPage.locator('.assistant-turn.streaming').last())
      .toBeVisible({ timeout: 3000 });

    // Simulate streaming: second chunk
    mockAgent.simulateClaudeOutput(convId, ' there was a developer');

    // Should see both chunks together
    await expect(chatPage.locator('.assistant-turn').last())
      .toContainText('Once upon a time', { timeout: 5000 });

    // Complete the turn
    mockAgent.simulateTurnComplete(convId);

    // Streaming indicator should disappear after turn complete
    await expect(chatPage.locator('.assistant-turn.streaming'))
      .toHaveCount(0, { timeout: 5000 });
  });

  test('should scroll to bottom when new messages arrive', async ({ chatPage, mockAgent }) => {
    const convId = await createConversationAndGetId(chatPage, mockAgent);
    expect(convId).toBeTruthy();

    // Send multiple messages to fill the viewport
    for (let i = 0; i < 5; i++) {
      await chatPage.fill('.input-area textarea', `Message number ${i + 1}`);
      await chatPage.locator('.send-btn').last().click();

      // Wait for user message to appear
      await expect(chatPage.locator('.message.user').last())
        .toContainText(`Message number ${i + 1}`, { timeout: 5000 });

      // Mock a long reply to take up space
      mockAgent.simulateClaudeOutput(convId, `Reply ${i + 1}: ${'This is a detailed response. '.repeat(10)}`);
      mockAgent.simulateTurnComplete(convId);

      // Wait for assistant reply
      await expect(chatPage.locator('.assistant-turn').last())
        .toContainText(`Reply ${i + 1}`, { timeout: 5000 });
    }

    // The chat container should be scrolled to the bottom
    const isAtBottom = await chatPage.evaluate(() => {
      const container = document.querySelector('.chat-container');
      if (!container) return false;
      return Math.abs(container.scrollTop + container.clientHeight - container.scrollHeight) < 50;
    });

    expect(isAtBottom).toBeTruthy();
  });

  test('should send message with Enter key', async ({ chatPage, mockAgent }) => {
    await createConversationAndGetId(chatPage, mockAgent);

    // Type a message and press Enter
    await chatPage.fill('.input-area textarea', 'Enter key test');
    await chatPage.locator('.input-area textarea').press('Enter');

    // User message should appear
    await expect(chatPage.locator('.message.user').last())
      .toContainText('Enter key test', { timeout: 5000 });
  });

  test('should not send empty messages', async ({ chatPage, mockAgent }) => {
    await createConversationAndGetId(chatPage, mockAgent);

    // The send button should be disabled when input is empty
    const sendBtn = chatPage.locator('.send-btn:not(.stop-btn)');
    await expect(sendBtn).toBeDisabled();

    // Type spaces only
    await chatPage.fill('.input-area textarea', '   ');

    // Send button should still be disabled (trimmed text is empty)
    await expect(sendBtn).toBeDisabled();
  });
});
