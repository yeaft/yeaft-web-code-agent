import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';
import { createConversation } from '../../helpers/conversation.js';

// Delay real catalog packets, not Vue rendering: the final navigation must be
// present throughout a slow initial handshake and a same-owner reconnect.
for (const surface of [
  { view: 'chat', theme: 'light', width: 1400 },
  { view: 'chat', theme: 'dark', width: 320 },
]) {
  test(`stable sidebar first paint / ${surface.view} / ${surface.theme} / ${surface.width}px`, async ({ page, serverUrl, mockAgent }, testInfo) => {
    await page.setViewportSize({ width: surface.width, height: 900 });
    await page.addInitScript(({ view, theme }) => {
      localStorage.setItem('yeaft-preferred-conversation-view', view);
      localStorage.setItem('theme', theme);
      window.__legacySidebarSeen = false;
      const observe = () => {
        const observer = new MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1) continue;
              if (node.matches('.session-tab-solo') || node.querySelector('.session-tab-solo')) {
                window.__legacySidebarSeen = true;
              }
            }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.documentElement) observe();
      else document.addEventListener('DOMContentLoaded', observe, { once: true });
    }, surface);

    let holdCatalog = true;
    const held = [];
    await page.routeWebSocket(/\?type=web/, client => {
      const server = client.connectToServer();
      server.onMessage(message => {
        const packet = JSON.parse(message.toString());
        if (holdCatalog && packet.type === 'session_catalog_snapshot') {
          held.push({ client, message });
        } else {
          client.send(message);
        }
      });
    });
    const release = () => {
      holdCatalog = false;
      for (const { client, message } of held.splice(0)) client.send(message);
    };

    await page.goto(serverUrl);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    if (surface.width <= 600) await page.locator('.header-sidebar-toggle').click();
    const navigation = page.locator('.sidebar-navigation');
    await expect(navigation).toBeVisible();
    await expect(navigation).toHaveAttribute('aria-busy', 'true');
    await expect(navigation.locator('.sidebar-section-toggle')).toHaveCount(2);
    await expect(navigation.locator('.sidebar-primary-action:not(.sidebar-plugins-entry):not(.sidebar-task-create)')).toBeDisabled();
    await expect(navigation.locator('.sidebar-task-create')).toBeDisabled();
    const actions = navigation.locator('.sidebar-primary-actions > button');
    await expect(actions).toHaveCount(3);
    for (const [index, name] of ['New chat', 'New task', 'Plugins'].entries()) {
      await expect(actions.nth(index)).toHaveAccessibleName(name);
      await expect(actions.nth(index)).toHaveAttribute('title', name);
      await expect(actions.nth(index)).toHaveText('');
    }
    const bounds = await actions.evaluateAll(buttons => buttons.map(button => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }));
    expect(new Set(bounds.map(box => box.y)).size).toBe(1);
    for (const [index, box] of bounds.entries()) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBe(44);
      if (index) expect(box.x).toBeGreaterThanOrEqual(bounds[index - 1].x + bounds[index - 1].width);
    }
    expect(await navigation.locator('.sidebar-primary-actions').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(54);
    await expect(navigation.locator('.sidebar-section')).toHaveClass([
      'sidebar-section projects-section', 'sidebar-section recents-section',
    ]);
    await expect(navigation.locator('.sidebar-catalog-loading')).toHaveCount(2);
    await expect(page.locator('.session-tab-solo')).toHaveCount(0);
    await page.evaluate(() => {
      window.__sidebarNavigation = document.querySelector('.sidebar-navigation');
      window.__sidebarHeadings = [...document.querySelectorAll('.sidebar-section-heading')];
    });
    // Keep the snapshot pending across several browser paints.
    await page.screenshot({ path: testInfo.outputPath('sidebar-loading.png') });
    release();
    await expect(navigation).toHaveAttribute('aria-busy', 'false');
    await expect(navigation.locator('.sidebar-primary-action:not(.sidebar-plugins-entry):not(.sidebar-task-create)')).toBeEnabled();
    await actions.nth(0).focus();
    await page.keyboard.press('Tab');
    await expect(actions.nth(1)).toBeFocused();
    expect(await actions.nth(1).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Tab');
    await expect(actions.nth(2)).toBeFocused();
    expect(await page.evaluate(() => window.__sidebarNavigation === document.querySelector('.sidebar-navigation'))).toBe(true);
    expect(await page.evaluate(() => window.__sidebarHeadings.every((node, index) => node === document.querySelectorAll('.sidebar-section-heading')[index]))).toBe(true);

    // Persist through the real browser -> Server -> Agent creation path. The
    // reconnect snapshot must contain the same row, not a store-only fixture.
    await createConversation(page);
    const created = await mockAgent.waitForMessage('create_conversation');
    expect(created.conversationId).toBeTruthy();
    await expect.poll(() => mockAgent.conversations.has(created.conversationId)).toBe(true);
    await expect(navigation.locator('.session-item')).toHaveCount(1);
    const title = await navigation.locator('.sidebar-session-title-text').textContent();
    expect(title.trim()).not.toBe('');
    holdCatalog = true;
    await page.evaluate(() => window.Pinia.useChatStore().ws.close(4999, 'slow reconnect test'));
    await expect(page.locator('.connection-status')).toBeVisible();
    await expect.poll(() => held.length, { timeout: 15000 }).toBeGreaterThan(0);
    await expect(navigation.locator('.session-item')).toHaveCount(1);
    expect(await page.evaluate(() => window.__sidebarNavigation === document.querySelector('.sidebar-navigation'))).toBe(true);
    await expect(navigation.locator('.sidebar-session-title-text')).toHaveText(title);
    expect(held.some(({ message }) => JSON.parse(message.toString()).catalog.some(row => row.routeRef.sessionId === created.conversationId))).toBe(true);
    release();
    await expect(navigation).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.connection-status')).not.toBeVisible();
    await expect(navigation.locator('.session-item')).toHaveCount(1);
    await expect(navigation.locator('.sidebar-session-title-text')).toHaveText(title);
    expect(await page.evaluate(() => window.__sidebarHeadings.every((node, index) => node === document.querySelectorAll('.sidebar-section-heading')[index]))).toBe(true);
    expect(await page.evaluate(() => window.__legacySidebarSeen)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('sidebar-ready.png') });
  });
}
