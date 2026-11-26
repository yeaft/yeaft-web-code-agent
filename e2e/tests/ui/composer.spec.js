import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.COMPOSER_UI_PRODUCTION || 'false' } });

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
    store.handleMessage({ type: 'slash_commands_update', commandSet: 'yeaft', agentId,
      conversationId, slashCommands: ['yeaft-skills:daily-brief'],
      slashCommandDescriptions: { 'yeaft-skills:daily-brief': 'Prepare a daily brief' } });
  });

  await expect(page.locator('.yeaft-session-input')).toBeVisible();
}

test.describe('Yeaft composer menus', () => {
  test('mobile composer preserves newlines and draft through network recovery; desktop keeps shortcuts', async ({ page, serverUrl, browser }, testInfo) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 320, height: 800 });
    await openYeaftComposer(page, serverUrl);
    await page.evaluate(() => {
      window.__keyboardWire = [];
      const store = window.Pinia.useChatStore();
      const send = store.sendWsMessage;
      store.sendWsMessage = msg => {
        if (msg.type !== 'yeaft_session_send') return send(msg);
        if (window.__rejectSessionSend) return false;
        window.__keyboardWire.push(msg);
        return true;
      };
    });
    const composer = page.locator('.yeaft-session-input');
    const input = composer.locator('textarea');
    const sends = () => page.evaluate(() => (window.__keyboardWire || []).filter(msg => msg.type === 'yeaft_session_send'));
    await expect(input).toHaveAttribute('enterkeyhint', 'enter');
    // Test autocomplete before the send flow blurs the mobile input.
    await input.fill('/');
    await expect(composer.locator('.slash-autocomplete')).toBeVisible();
    await input.press('Enter');
    await expect(input).toHaveValue('/\n');
    expect(await sends()).toHaveLength(0);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await input.fill('First line');
      await input.press('Enter');
      await input.press('Shift+Enter');
      await page.keyboard.insertText('Second line');
      await expect(input).toHaveValue('First line\n\nSecond line');
      expect(await sends()).toHaveLength(theme === 'light' ? 0 : 1);
      await input.evaluate(el => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
      });
      expect(await sends()).toHaveLength(theme === 'light' ? 0 : 1);
      await page.screenshot({ path: testInfo.outputPath(`mobile-newlines-${theme}.png`) });
      await composer.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(input).toHaveValue('');
      expect((await sends()).at(-1).text).toBe('First line\n\nSecond line');
    }
    // Chromium's offline event leaves an already-open WebSocket half-open.
    // Verify the live socket via actual Server pong when it reports online.
    const sendButton = composer.getByRole('button', { name: 'Send', exact: true });
    const pending = 'Retain the mobile draft';
    await input.fill(pending);
    await page.evaluate(() => { window.__rejectSessionSend = true; });
    await sendButton.click();
    await expect(input).toHaveValue(pending);
    expect(await sends()).toHaveLength(2);
    await page.evaluate(() => { window.__rejectSessionSend = false; });
    // A brief mobile network blip (<2s) must not flash the banner or jump the composer.
    await page.context().setOffline(true);
    await page.waitForTimeout(300);
    await expect(composer.locator('.composer-connection')).toHaveCount(0);
    await page.context().setOffline(false);
    await page.waitForFunction(() => {
      const store = window.Pinia?.useChatStore?.();
      return store && !store.networkOffline && !store.wsVerifying && store.connectionState === 'connected' && store.authenticated;
    }, null, { timeout: 5000 });
    await expect(composer.locator('.composer-connection')).toHaveCount(0);

    // Tapping Send during the grace window preserves the draft and immediately reveals the real status.
    await page.context().setOffline(true);
    await expect(composer.locator('.composer-connection')).toHaveCount(0);
    await sendButton.click();
    await expect(composer.locator('.composer-connection')).toContainText('Offline');
    await expect(sendButton).toBeDisabled();
    await expect(input).toHaveValue(pending);
    expect(await sends()).toHaveLength(2);
    await page.context().setOffline(false);
    await expect(composer.locator('.composer-connection')).toHaveCount(0);
    await expect(sendButton).toBeEnabled();

    // Staying offline past the grace window reveals the notice automatically while keeping the draft editable.
    await page.context().setOffline(true);
    await expect(composer.locator('.composer-connection')).toContainText('Offline');
    await expect(sendButton).toBeDisabled();
    await expect(input).toBeEditable();
    await input.fill(`${pending} (edited offline)`);
    await page.context().setOffline(false);
    await expect(sendButton).toBeEnabled();
    await expect(input).toHaveValue(`${pending} (edited offline)`);
    expect(await sends()).toHaveLength(2);
    await sendButton.click();
    await expect(input).toHaveValue('');
    expect((await sends()).at(-1).text).toBe(`${pending} (edited offline)`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await input.fill('Desktop first');
    await input.press('Shift+Enter');
    await page.keyboard.insertText('Desktop second');
    await expect(input).toHaveValue('Desktop first\nDesktop second');
    await input.press('Enter');
    expect((await sends()).at(-1).text).toBe('Desktop first\nDesktop second');
    await expect(input).toHaveValue('');

    // Wide phone/tablet landscape is touch-only even beyond the mobile breakpoint.
    const touchContext = await browser.newContext({ viewport: { width: 1024, height: 600 }, hasTouch: true, isMobile: true });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.addInitScript(() => localStorage.setItem('yeaft-session-status-visible', '0'));
      await openYeaftComposer(touchPage, serverUrl);
      await touchPage.evaluate(() => {
        window.__keyboardWire = [];
        window.Pinia.useChatStore().sendWsMessage = msg => { window.__keyboardWire.push(msg); };
      });
      expect(await touchPage.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);
      const touchComposer = touchPage.locator('.yeaft-session-input');
      const touchInput = touchComposer.locator('textarea');
      await touchInput.fill('Landscape first'); await touchInput.press('Enter');
      await touchPage.keyboard.insertText('Landscape second');
      await expect(touchInput).toHaveValue('Landscape first\nLandscape second');
      expect(await touchPage.evaluate(() => window.__keyboardWire.filter(msg => msg.type === 'yeaft_session_send'))).toHaveLength(0);
      await touchComposer.locator('.send-btn').click();
      expect(await touchPage.evaluate(() => window.__keyboardWire.find(msg => msg.type === 'yeaft_session_send').text)).toBe('Landscape first\nLandscape second');
    } finally { await touchContext.close(); }
  });
});
