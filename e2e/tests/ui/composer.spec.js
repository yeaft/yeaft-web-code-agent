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
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 1280]) {
      test(`quick sends: ${theme}, ${width}px`, async ({ page, serverUrl }, testInfo) => {
        await page.setViewportSize({ width, height: 800 });
        await openYeaftComposer(page, serverUrl);
        await expect(page.locator('.composer-quick-send')).toHaveCount(0);
        await page.evaluate(async theme => {
          document.documentElement.setAttribute('data-theme', theme);
          const store = window.Pinia.useChatStore();
          const { useUserShortcuts } = await import('/utils/user-shortcuts.js');
          const shortcuts = useUserShortcuts();
          const result = shortcuts.save({ showQuickSends: true, bindings: { quickSend1: 'Alt+Shift+1' } });
          if (!result.ok) throw new Error(JSON.stringify(result));
          store.sendWsMessage = msg => { (window.__quickSendWire ||= []).push(msg); };
          store.llmConfig[store.currentAgent] = { loaded: true, agentConfig: {
            quickSends: Array.from({ length: 5 }, (_, i) => ({
              id: `q${i}`, name: `Preset ${i + 1} with a long descriptive name`, model: 'my-proxy/gpt-5.6-sol',
              effort: 'medium', maxOutputTokens: 2048,
            })),
          } };
        }, theme);
        const buttons = page.locator('.composer-quick-send');
        await expect(buttons).toHaveCount(5);
        await expect(buttons.first()).toBeDisabled();
        const input = page.locator('.yeaft-session-input textarea');
        await input.fill('quick message');
        await expect(buttons.first()).toBeEnabled();
        const quickBox = await page.locator('.composer-quick-sends').boundingBox();
        const attachBox = await page.locator('.yeaft-session-input .attach-btn').boundingBox();
        const modelBox = await page.locator('.yeaft-composer-model').boundingBox();
        if (width === 320) {
          expect(quickBox.y + quickBox.height).toBeLessThanOrEqual(attachBox.y + 2);
        } else {
          expect(quickBox.x).toBeGreaterThan(attachBox.x);
          expect(quickBox.x + quickBox.width).toBeLessThanOrEqual(modelBox.x + 2);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await buttons.last().focus();
        await expect(buttons.last()).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath(`quick-sends-${theme}-${width}.png`) });
        await input.focus();
        await page.keyboard.press('Alt+Shift+Digit1');
        await expect(input).toHaveValue('');
        const wire = await page.evaluate(() => window.__quickSendWire.find(msg => msg.type === 'yeaft_session_send'));
        expect(wire.quickSend).toEqual({ model: 'my-proxy/gpt-5.6-sol', effort: 'medium', maxOutputTokens: 2048 });
        await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'reconnecting'; });
        await input.fill('retained while offline');
        await expect(buttons.first()).toBeDisabled();
      });
    }
  }

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
