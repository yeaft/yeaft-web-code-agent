import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

async function openYeaftComposer(page, serverUrl) {
  await page.goto(serverUrl);
  await page.waitForSelector('.chat-page', { timeout: 10000 });
  await page.waitForFunction(() => {
    const store = window.Pinia?.useChatStore?.();
    return store?.connectionState === 'connected' && store?._hasHandledAgentList === true;
  }, null, { timeout: 10000 });
  await page.evaluate(() => {
    const store = window.Pinia.useChatStore();
    const sessionsStore = window.Pinia.useSessionsStore();
    const agentId = 'composer-menu-agent';
    const sessionId = 'composer-menu-session';
    const conversationId = 'composer-menu-conversation';
    const agent = { id: agentId, name: 'Composer menu agent', online: true, status: 'ready', capabilities: [] };

    sessionsStore.applySnapshot([{
      id: sessionId,
      name: 'Composer menu session',
      roster: ['omni'],
      defaultVpId: 'omni',
      config: { model: 'my-proxy/gpt-5.6-sol', modelEffort: 'high' },
    }], agentId);
    sessionsStore.setActive(sessionId, agentId);

    store.agents = [agent];
    store.currentAgent = agentId;
    store.currentAgentInfo = agent;
    store._hasHandledAgentList = true;
    store._hasHandledYeaftSessionHydrate = true;
    store.yeaftSessionHydrateError = null;
    store.yeaftHistoryLoadError = null;
    store.yeaftActiveSessionFilter = sessionId;
    store.yeaftSessionAgentById = { ...store.yeaftSessionAgentById, [sessionId]: agentId };
    store.yeaftConversationId = conversationId;
    store.yeaftConversationIdsByAgent = { ...store.yeaftConversationIdsByAgent, [agentId]: conversationId };
    store.messagesMap[conversationId] = [];
    store.activeConversations = [conversationId];
    store.yeaftModel = 'my-proxy/gpt-5.6-sol';
    store.yeaftModelEffort = 'high';
    store.yeaftAvailableModels = [{
      id: 'gpt-5.6-sol',
      provider: 'my-proxy',
      ref: 'my-proxy/gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      effortOptions: ['medium', 'high'],
    }];
    store.currentView = 'yeaft';
  });

  await expect(page.locator('.yeaft-session-input')).toBeVisible();
}

test.describe('Yeaft composer menus', () => {
  test('Session shares accessible attachment cards, drag/drop, clipboard and file-only send', async ({ page, serverUrl }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openYeaftComposer(page, serverUrl);
    await page.evaluate(() => {
      window.Pinia.useChatStore().sendWsMessage = msg => { (window.__attachmentWire ||= []).push(msg); };
    });
    const composer = page.locator('.yeaft-session-input');
    await expect(composer.locator('button.attach-btn')).toHaveAccessibleName('Upload file');
    const picker = page.waitForEvent('filechooser');
    await composer.locator('button.attach-btn').focus();
    await page.keyboard.press('Enter');
    await (await picker).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
    await expect(composer.locator('.attachment-status')).toHaveText('5 B');
    await composer.locator('textarea').evaluate(input => {
      const data = new DataTransfer();
      data.items.add(new File(['pasted'], 'pasted.md', { type: 'text/plain' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(composer.locator('.attachment-item')).toHaveCount(2);
    const dropped = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
      return data;
    });
    await composer.locator('[data-message-composer]').dispatchEvent('drop', { dataTransfer: dropped });
    await expect(composer.locator('.attachment-item')).toHaveCount(3);
    await expect(composer.locator('.send-btn')).toBeEnabled();
    await composer.locator('.attachment-remove').nth(1).click();
    await expect(composer.locator('.attachment-item')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await composer.locator('.send-btn').click();
    const wire = await page.evaluate(() => window.__attachmentWire.find(msg => msg.type === 'yeaft_session_send'));
    // Session's existing transport supplies the attachment-only fallback text.
    expect(wire.text).toBe('(attached files)');
    // Names/previews stay local; the existing Session wire sends only fileId/isImage.
    expect(wire.attachments).toEqual([
      { fileId: expect.any(String), isImage: false },
      { fileId: expect.any(String), isImage: false },
    ]);
    await page.locator('.message-user-attachments button').click();
    await expect(page.locator('.user-attachments .file-name')).toHaveText(['notes.txt', 'dropped.txt']);
    await expect(composer.locator('.attachment-item')).toHaveCount(0);
    await dropped.dispose();
  });

});
