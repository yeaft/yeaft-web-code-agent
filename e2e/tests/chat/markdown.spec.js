import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

/** Helper: open modal, select agent, create conversation */
async function createConversation(chatPage) {
  await chatPage.click('.sidebar-nav-item');
  await chatPage.waitForSelector('.modal-overlay', { timeout: 5000 });
  await chatPage.waitForFunction(() => {
    const sel = document.querySelector('.resume-select');
    return sel && sel.options.length > 1;
  }, { timeout: 5000 });
  await chatPage.locator('.resume-select').selectOption({ index: 1 });
  await chatPage.click('.modern-btn');
  await chatPage.waitForSelector('.session-item.active', { timeout: 5000 });
}

test.describe('Markdown 渲染', () => {
  /** Helper: create conv, send user message, mock agent replies with markdown */
  async function sendAndReply(chatPage, mockAgent, markdownText) {
    await createConversation(chatPage);

    await chatPage.fill('.input-area textarea', 'show markdown');
    await chatPage.click('.send-btn');

    const msg = await mockAgent.waitForMessage('execute', 10000);
    const convId = msg.conversationId;

    mockAgent.simulateClaudeOutput(convId, markdownText);
    mockAgent.simulateTurnComplete(convId);

    const assistant = chatPage.locator('.assistant-turn').last();
    await expect(assistant).toBeVisible({ timeout: 5000 });
    return assistant;
  }

  test('代码块渲染正确（含语言标签和 copy 按钮）', async ({ chatPage, mockAgent }) => {
    const markdown = '```javascript\nconst x = 42;\nconsole.log(x);\n```';
    const msg = await sendAndReply(chatPage, mockAgent, markdown);

    const codeBlock = msg.locator('.code-block-wrapper');
    await expect(codeBlock).toBeVisible();

    const langLabel = codeBlock.locator('.code-lang');
    await expect(langLabel).toHaveText('javascript');

    const copyBtn = codeBlock.locator('.code-copy-btn');
    await expect(copyBtn).toBeVisible();

    const code = codeBlock.locator('code');
    await expect(code).toContainText('const x = 42');
  });

  test('链接渲染为可点击 <a> 标签', async ({ chatPage, mockAgent }) => {
    const markdown = 'Visit [Example](https://example.com) for more info.';
    const msg = await sendAndReply(chatPage, mockAgent, markdown);

    const link = msg.locator('.markdown-body a[href="https://example.com"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Example');
  });

  test('无序列表渲染正确', async ({ chatPage, mockAgent }) => {
    const markdown = '- Item one\n- Item two\n- Item three';
    const msg = await sendAndReply(chatPage, mockAgent, markdown);

    const items = msg.locator('.markdown-body ul li');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText('Item one');
    await expect(items.last()).toContainText('Item three');
  });

  test('有序列表渲染正确', async ({ chatPage, mockAgent }) => {
    const markdown = '1. First\n2. Second\n3. Third';
    const msg = await sendAndReply(chatPage, mockAgent, markdown);

    const items = msg.locator('.markdown-body ol li');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText('First');
  });

  test('表格渲染正确', async ({ chatPage, mockAgent }) => {
    const markdown = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
    const msg = await sendAndReply(chatPage, mockAgent, markdown);

    const wrapper = msg.locator('.table-scroll-wrapper');
    await expect(wrapper).toBeVisible();

    const headers = msg.locator('table th');
    await expect(headers).toHaveCount(2);
    await expect(headers.first()).toHaveText('Name');

    const rows = msg.locator('table tbody tr');
    await expect(rows).toHaveCount(2);
  });
});
