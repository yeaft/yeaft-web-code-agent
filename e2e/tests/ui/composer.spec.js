import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.use({ serverEnv: { SERVE_DIST: process.env.COMPOSER_UI_PRODUCTION || 'false' } });

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
  test('mobile Enter inserts newlines; only the send action submits, while desktop keeps shortcuts', async ({ page, serverUrl, browser }, testInfo) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 320, height: 800 });
    await openYeaftComposer(page, serverUrl);
    await page.evaluate(() => {
      window.__keyboardWire = [];
      window.Pinia.useChatStore().sendWsMessage = msg => { window.__keyboardWire.push(msg); };
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
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await composer.locator('.attachment-remove').nth(1).click();
    await expect(composer.locator('.attachment-item')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
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
