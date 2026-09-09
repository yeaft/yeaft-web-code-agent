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
  test('opens LLM configuration from the model menu', async ({ page, serverUrl }) => {
    await openYeaftComposer(page, serverUrl);

    await page.locator('.yeaft-composer-model').click();
    const modelMenu = page.locator('.yeaft-composer-model-dropdown');
    await expect(modelMenu).toBeVisible();

    await modelMenu.locator('.yeaft-model-config-option').click();

    const settings = page.getByRole('dialog', { name: 'Agent settings', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('button', { name: 'LLM configuration', exact: true })).toHaveClass(/active/);
    await expect(settings.getByRole('combobox', { name: 'Agent', exact: true })).toContainText('Composer menu agent');
    await expect(settings.locator('.agent-settings-llm .llm-tab')).toBeVisible();
    await expect(modelMenu).toHaveCount(0);
  });
});
