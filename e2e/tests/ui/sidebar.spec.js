import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.describe('侧边栏交互', () => {
  /** Helper: create a conversation via modal */
  async function createConversation(chatPage) {
    await chatPage.locator('.session-tab-add-btn').click();
    await chatPage.waitForSelector('.modal-overlay', { timeout: 5000 });
    await chatPage.waitForFunction(() => {
      const sel = document.querySelector('.resume-select');
      return sel && sel.options.length > 1;
    }, { timeout: 5000 });
    await chatPage.locator('.resume-select').first().selectOption({ index: 1 });
    await chatPage.click('.modern-btn');
    await chatPage.waitForSelector('.session-item.active', { timeout: 5000 });
  }

  test('侧边栏默认展开状态', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).not.toHaveClass(/collapsed/);
  });

  test('点击折叠按钮收起侧边栏', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await chatPage.locator('.sidebar-header-row .sidebar-header-actions .sidebar-icon-btn').first().click();
    await expect(sidebar).toHaveClass(/collapsed/, { timeout: 3000 });
    await expect(chatPage.locator('.sidebar-collapsed-bar')).toBeVisible();
  });

  test('折叠后点击展开按钮恢复侧边栏', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await chatPage.locator('.sidebar-header-row .sidebar-header-actions .sidebar-icon-btn').first().click();
    await expect(sidebar).toHaveClass(/collapsed/, { timeout: 3000 });
    await chatPage.locator('.sidebar-collapsed-bar .collapsed-icon-btn').first().click();
    await expect(sidebar).not.toHaveClass(/collapsed/, { timeout: 3000 });
  });

  test('创建会话后显示在侧边栏列表中', async ({ chatPage, mockAgent }) => {
    const before = await chatPage.locator('.session-item').count();
    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 1);
    await expect(chatPage.locator('.session-item.active')).toBeVisible();
  });

  test('会话切换：创建两个会话后可切换', async ({ chatPage, mockAgent }) => {
    const before = await chatPage.locator('.session-item').count();
    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 1);

    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 2, { timeout: 5000 });

    // Click the non-active session to switch
    const sessions = chatPage.locator('.session-item');
    const count = await sessions.count();
    for (let i = 0; i < count; i++) {
      const isActive = await sessions.nth(i).evaluate(el => el.classList.contains('active'));
      if (!isActive) {
        await sessions.nth(i).click();
        break;
      }
    }
    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
  });

  test('删除会话：点击删除按钮移除会话', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);
    const after = await chatPage.locator('.session-item').count();
    expect(after).toBeGreaterThanOrEqual(1);

    // Auto-accept the confirm dialog
    chatPage.on('dialog', dialog => dialog.accept());

    await chatPage.locator('.session-item.active').hover();
    await chatPage.locator('.session-item.active .session-dots-btn').click();
    await chatPage.locator('.session-menu-item.danger').click();
    await expect(chatPage.locator('.session-item')).toHaveCount(after - 1, { timeout: 5000 });
  });
});
