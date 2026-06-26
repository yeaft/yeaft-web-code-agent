import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

/** Helper: create a conversation via modal */
async function createConversation(chatPage) {
  await chatPage.locator('.session-tab-add-btn').click();
  await expect(chatPage.locator('.modal.resume-modal')).toBeVisible({ timeout: 5000 });
  await chatPage.locator('.resume-modal-footer .modern-btn').click();
  await expect(chatPage.locator('.modal.resume-modal')).not.toBeVisible({ timeout: 5000 });
  await expect(chatPage.locator('.session-item.active')).toBeVisible({ timeout: 5000 });
}

test.describe('终端功能', () => {
  test('打开 workbench 显示终端 tab', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);

    const workbenchBtn = chatPage.locator('.sidebar-header-actions .sidebar-icon-btn').last();
    await workbenchBtn.click();

    const panel = chatPage.locator('.workbench-panel.expanded');
    await expect(panel).toBeVisible({ timeout: 5000 });

    const terminalTab = panel.locator('.wb-tab', { hasText: 'Terminal' });
    await expect(terminalTab).toBeVisible();
  });

  test('点击 Terminal tab 切换到终端面板', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);

    const workbenchBtn = chatPage.locator('.sidebar-header-actions .sidebar-icon-btn').last();
    await workbenchBtn.click();
    await chatPage.waitForSelector('.workbench-panel.expanded', { timeout: 5000 });

    const terminalTab = chatPage.locator('.wb-tab', { hasText: 'Terminal' });
    await terminalTab.click();
    await expect(terminalTab).toHaveClass(/active/);
  });

  test('workbench 可以最大化和还原', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);

    const workbenchBtn = chatPage.locator('.sidebar-header-actions .sidebar-icon-btn').last();
    await workbenchBtn.click();
    await chatPage.waitForSelector('.workbench-panel.expanded', { timeout: 5000 });

    const maximizeBtn = chatPage.locator('.wb-tab-action').first();
    await maximizeBtn.click();
    await expect(chatPage.locator('.workbench-panel.maximized')).toBeVisible();

    await maximizeBtn.click();
    await expect(chatPage.locator('.workbench-panel.maximized')).not.toBeVisible();
    await expect(chatPage.locator('.workbench-panel.expanded')).toBeVisible();
  });

  test('workbench 可以关闭', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);

    const workbenchBtn = chatPage.locator('.sidebar-header-actions .sidebar-icon-btn').last();
    await workbenchBtn.click();
    await chatPage.waitForSelector('.workbench-panel.expanded', { timeout: 5000 });

    const closeBtn = chatPage.locator('.wb-tab-action').last();
    await closeBtn.click();
    await expect(chatPage.locator('.workbench-panel.expanded')).not.toBeVisible();
  });
});
