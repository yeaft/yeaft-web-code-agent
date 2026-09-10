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
        await expect(page.locator('.composer-send-modes')).toHaveCount(0);
        await page.evaluate(async theme => {
          document.documentElement.setAttribute('data-theme', theme);
          const store = window.Pinia.useChatStore();
          const { useUserShortcuts } = await import('/utils/user-shortcuts.js');
          const shortcuts = useUserShortcuts();
          const result = shortcuts.save({ showQuickSends: true });
          if (!result.ok) throw new Error(JSON.stringify(result));
          store.sendWsMessage = msg => { (window.__quickSendWire ||= []).push(msg); };
          store.llmConfig[store.currentAgent] = { loaded: true, agentConfig: {
            quickSends: Array.from({ length: 5 }, (_, i) => ({
              id: `q${i}`, name: `Preset ${i + 1} with a long descriptive name`, model: 'my-proxy/gpt-5.6-sol',
              effort: 'medium', maxOutputTokens: 2048,
            })),
          } };
        }, theme);
        const trigger = page.locator('.composer-send-mode-trigger');
        await expect(trigger).toBeDisabled();
        const input = page.locator('.yeaft-session-input textarea');
        await input.fill('quick message');
        await expect(trigger).toBeEnabled();
        const triggerBox = await trigger.boundingBox();
        const sendBox = await page.locator('.yeaft-session-input .send-btn:not(.stop-btn)').boundingBox();
        expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(sendBox.x + 2);
        await trigger.click();
        const options = page.locator('.composer-send-mode-option');
        await expect(options).toHaveCount(5);
        await expect(options.first()).toContainText('Preset 1');
        await expect(options.first()).toContainText('Alt+1');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await options.last().focus();
        await expect(options.last()).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath(`quick-sends-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        await input.focus();
        await page.keyboard.press('Alt+Digit1');
        await expect(input).toHaveValue('');
        const wire = await page.evaluate(() => window.__quickSendWire.find(msg => msg.type === 'yeaft_session_send'));
        expect(wire.quickSend).toEqual({ model: 'my-proxy/gpt-5.6-sol', effort: 'medium', maxOutputTokens: 2048 });
        await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'reconnecting'; });
        await input.fill('retained while offline');
        await expect(trigger).toBeDisabled();
      });
    }
  }

  test('quick-send settings stay compact and styled across themes and widths', async ({ page, serverUrl }, testInfo) => {
    for (const theme of ['light', 'dark']) {
      for (const width of [320, 900, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await openYeaftComposer(page, serverUrl);
        await page.evaluate(theme => {
          document.documentElement.setAttribute('data-theme', theme);
          const store = window.Pinia.useChatStore();
          store.ws = { readyState: 1 };
          const respond = message => queueMicrotask(() => {
            store.llmConfig[message.agentId] = { requestId: message.requestId, loaded: true, agentConfig: {
              availableModels: [{ id: 'gpt-5.6-sol', provider: 'my-proxy', ref: 'my-proxy/gpt-5.6-sol', label: 'gpt-5.6-sol', maxOutput: 65536, effortOptions: ['low', 'medium', 'high'] }],
              quickSends: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, name: `Preset ${i + 1}`, model: 'my-proxy/gpt-5.6-sol', effort: 'medium', maxOutputTokens: 2048 })),
            } };
          });
          store.sendWsMessage = message => {
            if (message.type === 'get_llm_config') respond(message);
          };
        }, theme);
        const statusClose = page.locator('.yeaft-session-status-close:visible');
        if (await statusClose.isVisible()) await statusClose.click();
        if (width === 320) await page.locator('.yeaft-topbar-sidebar-toggle').click();
        await page.locator('.agent-dropdown-trigger:visible').click();
        await page.locator('.agent-dropdown-settings-option:visible').first().click();
        const settings = page.getByRole('dialog', { name: 'Agent settings', exact: true });
        await settings.getByRole('button', { name: 'Quick send', exact: true }).click();
        const entries = settings.locator('.quick-send-entry');
        await expect(entries).toHaveCount(5);
        await expect(entries.first().locator('.modern-select')).toHaveCount(2);
        await entries.first().locator('.quick-send-effort .modern-select-trigger').click();
        await expect(page.locator('.modern-select-menu')).toBeVisible();
        await page.keyboard.press('Escape');
        expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const firstBox = await entries.first().boundingBox();
        const nameBox = await entries.first().locator('.quick-send-name').boundingBox();
        const modelBox = await entries.first().locator('.quick-send-model').boundingBox();
        if (width >= 1280) {
          expect(Math.abs(nameBox.y - modelBox.y)).toBeLessThan(3);
          expect(firstBox.height).toBeLessThan(90);
        } else {
          expect(modelBox.y).toBeGreaterThanOrEqual(nameBox.y);
        }
        await page.screenshot({ path: testInfo.outputPath(`quick-send-settings-${theme}-${width}.png`) });
        await settings.getByRole('button', { name: 'Close', exact: true }).click();
      }
    }
  });

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
