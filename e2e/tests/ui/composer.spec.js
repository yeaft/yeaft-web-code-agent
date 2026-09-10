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
        await expect(page.locator('.composer-send-mode-trigger')).toHaveCount(0);
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
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(
          () => requestAnimationFrame(resolve)
        )));
        await expect.poll(() => page.evaluate(async () => {
          const store = window.Pinia.useChatStore();
          const { useUserShortcuts } = await import('/utils/user-shortcuts.js');
          const preferences = useUserShortcuts().preferences.value;
          const quickSends = store.llmConfig?.[store.currentAgent]?.agentConfig?.quickSends || [];
          return { showQuickSends: preferences.showQuickSends, binding: preferences.bindings.quickSend1, count: quickSends.length };
        })).toEqual({ showQuickSends: true, binding: 'Alt+1', count: 5 });
        await expect(page.locator('.composer-send-modes')).toHaveCount(0);
        await expect(page.locator('.composer-send-mode-trigger')).toHaveCount(0);
        await expect(page.locator('.composer-send-mode-menu')).toHaveCount(0);
        const quickBar = page.locator('.mobile-quick-send-bar');
        const quickButtons = quickBar.locator('.mobile-quick-send-button');
        await expect(quickBar).toBeHidden();
        const input = page.locator('.yeaft-session-input textarea');
        await input.fill('quick message');
        if (width === 320) {
          await expect(quickBar).toBeVisible();
          await expect(quickButtons).toHaveCount(5);
          await expect(quickButtons.first()).toHaveText('Preset 1 with a long descriptive name');
        } else {
          await expect(quickBar).toBeHidden();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`quick-sends-${theme}-${width}.png`) });
        if (width === 320) {
          await quickButtons.first().click();
        } else {
          await input.focus();
          await expect(input).toBeFocused();
          await input.press('Alt+Digit1');
        }
        await expect(input).toHaveValue('');
        const wire = await page.evaluate(() => window.__quickSendWire.find(msg => msg.type === 'yeaft_session_send'));
        expect(wire.quickSend).toEqual({ model: 'my-proxy/gpt-5.6-sol', effort: 'medium', maxOutputTokens: 2048 });
        await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'reconnecting'; });
        await input.fill('retained while offline');
        if (width === 320) {
          await expect(quickButtons.first()).toBeDisabled();
          await quickButtons.first().click({ force: true });
        } else {
          await input.focus();
          await input.press('Alt+Digit1');
        }
        await expect(input).toHaveValue('retained while offline');
        await expect.poll(() => page.evaluate(() => window.__quickSendWire.filter(msg => msg.type === 'yeaft_session_send').length)).toBe(1);
      });
    }

    test(`mobile quick sends appear on input and align to the center: ${theme}`, async ({ page, serverUrl }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await openYeaftComposer(page, serverUrl);
      await page.evaluate(async theme => {
        document.documentElement.setAttribute('data-theme', theme);
        const store = window.Pinia.useChatStore();
        const { useUserShortcuts } = await import('/utils/user-shortcuts.js');
        const result = useUserShortcuts().save({ showQuickSends: true });
        if (!result.ok) throw new Error(JSON.stringify(result));
        store.llmConfig[store.currentAgent] = { loaded: true, agentConfig: {
          quickSends: [
            { id: 'fast', name: 'Fast', model: 'my-proxy/gpt-5.6-sol', effort: 'medium' },
            { id: 'deep', name: 'Deep', model: 'my-proxy/gpt-5.6-sol', effort: 'high' },
          ],
        } };
      }, theme);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(
        () => requestAnimationFrame(resolve)
      )));

      const quickBar = page.locator('.mobile-quick-send-bar');
      const quickButtons = quickBar.locator('.mobile-quick-send-button');
      const input = page.locator('.yeaft-session-input textarea');
      await expect(quickBar).toBeHidden();
      await input.focus();
      await expect(quickButtons).toHaveCount(2);
      const [barBox, firstBox, lastBox] = await Promise.all([
        quickBar.boundingBox(), quickButtons.first().boundingBox(), quickButtons.last().boundingBox(),
      ]);
      expect(barBox).not.toBeNull();
      expect(firstBox).not.toBeNull();
      expect(lastBox).not.toBeNull();
      const leftSpace = firstBox.x - barBox.x;
      const rightSpace = (barBox.x + barBox.width) - (lastBox.x + lastBox.width);
      expect(leftSpace).toBeGreaterThan(24);
      expect(Math.abs(leftSpace - rightSpace)).toBeLessThanOrEqual(2);
      await page.screenshot({ path: testInfo.outputPath(`quick-sends-centered-${theme}.png`) });
      await page.locator('.yeaft-conversation-body').click({ position: { x: 8, y: 8 } });
      await expect(quickBar).toBeHidden();
    });
  }

  for (const theme of ['light', 'dark']) {
    for (const width of [320, 900, 1280]) {
      test(`quick-send settings: ${theme}, ${width}px`, async ({ page, serverUrl }, testInfo) => {
        await page.setViewportSize({ width, height: 800 });
        await openYeaftComposer(page, serverUrl);
        await page.evaluate(theme => {
          document.documentElement.setAttribute('data-theme', theme);
          const store = window.Pinia.useChatStore();
          store.ws = { readyState: 1 };
          window.__quickSendConfigRequests = [];
          store.sendWsMessage = message => {
            if (message.type === 'get_llm_config') window.__quickSendConfigRequests.push(message);
          };
        }, theme);
        const statusClose = page.locator('.yeaft-session-status-close:visible');
        if (await statusClose.isVisible()) await statusClose.click();
        if (width === 320) await page.locator('.yeaft-topbar-sidebar-toggle').click();
        await page.locator('.agent-dropdown-trigger:visible').click();
        await page.locator('.agent-dropdown-settings-option:visible').first().click();
        const settings = page.getByRole('dialog', { name: 'Agent settings', exact: true });
        await page.evaluate(() => {
          const store = window.Pinia.useChatStore();
          const agent = { id: 'composer-menu-agent', name: 'Composer menu agent', online: true, status: 'ready', capabilities: [] };
          store.ws = { readyState: 1 };
          store.agents = [agent];
          store.currentAgent = agent.id;
          store.currentAgentInfo = agent;
          window.__quickSendConfigRequests = [];
        });
        await expect(settings.getByRole('combobox', { name: 'Agent', exact: true })).toContainText('Composer menu agent');
        await settings.getByRole('button', { name: 'Quick send', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.__quickSendConfigRequests.length)).toBeGreaterThan(0);
        await page.evaluate(() => {
          const store = window.Pinia.useChatStore();
          const message = window.__quickSendConfigRequests.at(-1);
          store.llmConfig[message.agentId] = { requestId: message.requestId, loaded: true, agentConfig: {
            availableModels: [{ id: 'gpt-5.6-sol', provider: 'my-proxy', ref: 'my-proxy/gpt-5.6-sol', label: 'gpt-5.6-sol', maxOutput: 65536, effortOptions: ['low', 'medium', 'high'] }],
            quickSends: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, name: `Preset ${i + 1}`, model: 'my-proxy/gpt-5.6-sol', effort: 'medium', maxOutputTokens: 2048 })),
          } };
        });
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
      });
    }
  }

  test('keeps history search open while appending a second result page', async ({ page, serverUrl }) => {
    await openYeaftComposer(page, serverUrl);
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      const capabilities = ['session_history_outline', 'session_history_search'];
      store.currentAgentInfo = { ...store.currentAgentInfo, capabilities };
      store.agents = store.agents.map(agent => (
        agent.id === store.currentAgent ? { ...agent, capabilities } : agent
      ));
      let pageNumber = 0;
      store.sendWsMessage = message => {
        if (message.type !== 'yeaft_search_history') return;
        const currentPage = pageNumber++;
        const upper = currentPage === 0 ? 40 : 20;
        const results = Array.from({ length: 20 }, (_, index) => {
          const number = upper - index;
          return {
            entryId: `entry-m${number}`,
            messageId: `m${number}`,
            seq: number,
            entryStartSeq: number,
            role: 'user',
            snippet: `historical prompt ${number}`,
            timestamp: new Date(2026, 8, 1, 0, number).toISOString(),
          };
        });
        setTimeout(() => store.handleYeaftHistorySearchResult({
          agentId: message.agentId,
          sessionId: message.sessionId,
          requestId: message.requestId,
          query: message.query,
          senderKey: message.senderKey,
          results,
          hasMore: currentPage === 0,
          nextCursor: currentPage === 0 ? { beforeSeq: 21, beforeEntryId: 'entry-m21' } : null,
        }), 0);
      };
    });

    await page.locator('.yeaft-search-btn').click();
    const outline = page.locator('.yeaft-conversation-outline');
    await expect(outline).toBeVisible();
    await expect(outline.locator('[role="option"]')).toHaveCount(20);
    await outline.locator('.yeaft-conversation-outline-more').click();

    await expect(outline).toBeVisible();
    await expect(outline.locator('[role="option"]')).toHaveCount(40);
    await expect(outline.locator('.yeaft-conversation-outline-count')).toHaveText('40');
  });

  test('opens LLM configuration from the model menu', async ({ page, serverUrl }) => {
    await openYeaftComposer(page, serverUrl);
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      const agent = { id: 'composer-menu-agent', name: 'Composer menu agent', online: true, status: 'ready', capabilities: [] };
      store.agents = [agent];
      store.currentAgent = agent.id;
      store.currentAgentInfo = agent;
    });
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().agents?.[0]?.id)).toBe('composer-menu-agent');

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
