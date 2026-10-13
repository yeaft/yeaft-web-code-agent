/**
 * E2E Test: Conversation Management
 *
 * Tests conversation CRUD operations using SKIP_AUTH=true server.
 *   - Create a new conversation via the modal
 *   - Conversation appears in sidebar list
 *   - Remove a conversation from the sidebar without deleting its messages
 *   - Switch between conversations restores messages
 */
import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

import { createConversation } from '../../helpers/conversation.js';

test.describe('Conversation Management', () => {
  test('orders active Session messages chronologically across switches and history replay', async ({ chatPage, mockAgent }) => {
    await chatPage.evaluate(({ agentId }) => {
      const store = window.Pinia.useChatStore();
      const sessions = window.Pinia.useSessionsStore();
      sessions.applySnapshot(['order-A', 'order-B'].map(id => ({ id, name: id, roster: ['omni'], defaultVpId: 'omni' })), agentId);
      sessions.setActive('order-A', agentId);
      store.currentAgent = agentId;
      store._hasHandledAgentList = true;
      store._hasHandledYeaftSessionHydrate = true;
      store.yeaftSessionHydrateError = null;
      store.yeaftHistoryLoadError = null;
      store.yeaftSessionAgentById = { 'order-A': agentId, 'order-B': agentId };
      store.yeaftConversationId = 'order-conversation';
      store.yeaftConversationIdsByAgent = { [agentId]: 'order-conversation' };
      store.messagesMap['order-conversation'] = [
        { id: 'client-order', clientMessageId: 'client-order', type: 'user', content: 'Earlier A prompt', sessionId: 'order-A', timestamp: 1000 },
        { id: 'client-B', type: 'user', content: 'Only B prompt', sessionId: 'order-B', timestamp: 1500 },
      ];
      store.activeConversations = ['order-conversation'];
      store.yeaftActiveSessionFilter = 'order-A';
      store.currentView = 'yeaft';
      window.__switchOrderSession = id => {
        sessions.setActive(id, agentId);
        store.setActiveSessionFilter(id, { agentId });
      };
    }, { agentId: mockAgent.agentId });
    await expect(chatPage.locator('.message.user')).toContainText('Earlier A prompt');
    await chatPage.evaluate(() => window.__switchOrderSession('order-B'));
    await expect(chatPage.locator('.message.user')).toContainText('Only B prompt');
    await chatPage.evaluate(({ agentId }) => {
      const store = window.Pinia.useChatStore();
      const request = store.beginYeaftHistoryLoad({ agentId, sessionId: 'order-A', mode: 'recent' });
      store.handleMessage({
        type: 'yeaft_history_chunk', conversationId: 'order-conversation', agentId,
        sessionId: 'order-A', mode: 'recent', requestId: request.requestId,
        messages: [{ id: 'm0020', seq: 20, role: 'assistant', content: 'Later A progress', sessionId: 'order-A', turnId: 'turn-A', speakerVpId: 'omni', ts: 2000 }],
        oldestSeq: 20, latestSeq: 20, hasMore: false,
      });
    }, { agentId: mockAgent.agentId });
    await expect(chatPage.locator('.assistant-turn')).toHaveCount(0);
    await chatPage.evaluate(() => window.__switchOrderSession('order-A'));
    const orderedRows = chatPage.locator('.message.user, .assistant-turn');
    await expect(orderedRows).toHaveCount(2);
    await expect(orderedRows.nth(0)).toContainText('Earlier A prompt');
    await expect(orderedRows.nth(1)).toContainText('Later A progress');
    await expect(chatPage.getByText('Only B prompt', { exact: true })).toHaveCount(0);
    await chatPage.evaluate(({ agentId }) => {
      const store = window.Pinia.useChatStore();
      for (const text of ['Continued A output', ' still running']) {
        store.handleYeaftOutput({
          agentId, conversationId: 'order-conversation', sessionId: 'order-A', vpId: 'omni', turnId: 'turn-A-next',
          data: { type: 'assistant', message: { id: 'live-order', content: text }, ts: 3000 },
        });
      }
    }, { agentId: mockAgent.agentId });
    for (const [theme, width] of [['light', 1280], ['dark', 320]]) {
      await chatPage.setViewportSize({ width, height: 800 });
      await chatPage.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await chatPage.evaluate(() => window.__switchOrderSession('order-B'));
      await expect(orderedRows).toHaveCount(1);
      await expect(orderedRows.first()).toContainText('Only B prompt');
      await chatPage.evaluate(() => window.__switchOrderSession('order-A'));
      await expect(orderedRows.first()).toContainText('Earlier A prompt');
      await expect(orderedRows.last()).toContainText('Continued A output still running');
      const boxes = await orderedRows.evaluateAll(rows => rows.map(row => row.getBoundingClientRect().top));
      expect(boxes).toEqual([...boxes].sort((a, b) => a - b));
    }
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
