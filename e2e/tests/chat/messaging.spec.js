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
import { createConversation } from '../../helpers/conversation.js';

/**
 * Helper: create a conversation and return the conversationId.
 * Gets the conversationId from the mockAgent's received create_conversation message.
 */
async function createConversationAndGetId(chatPage, mockAgent) {
  await createConversation(chatPage);

  // Get the conversationId from the mockAgent's received create_conversation message
  const createMsg = mockAgent._receivedMessages.filter(m => m.type === 'create_conversation').pop();
  return createMsg?.conversationId;
}

test.describe('Messaging', () => {

  test('should display streaming message progressively', async ({ chatPage, mockAgent }) => {
    const convId = await createConversationAndGetId(chatPage, mockAgent);
    expect(convId).toBeTruthy();

    // Send a message
    await chatPage.fill('.input-area textarea', 'Tell me a story');
    await chatPage.locator('.send-btn').last().click();

    // Wait for user message
    await expect(chatPage.locator('.message.user').last())
      .toContainText('Tell me a story', { timeout: 5000 });

    // Confirm the server forwarded the send, not just the optimistic UI row.
    await expect.poll(() => mockAgent.messages('execute').some(message => message.conversationId === convId && message.prompt === 'Tell me a story')).toBe(true);

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

    // Should see both chunks together.
    await expect(chatPage.locator('.assistant-turn').last())
      .toContainText('Once upon a time there was a developer', { timeout: 5000 });

    // Complete the turn
    mockAgent.simulateTurnComplete(convId);

    // Streaming indicator should disappear after turn complete
    await expect(chatPage.locator('.assistant-turn.streaming'))
      .toHaveCount(0, { timeout: 5000 });
  });

});
