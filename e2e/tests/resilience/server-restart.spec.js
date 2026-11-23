import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

import { createConversation } from '../../helpers/conversation.js';
import { SESSION, sessionTurnsFixture } from '../../helpers/session-turns.js';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.COMPOSER_UI_PRODUCTION || 'false' } });

test.describe('Server 重启恢复', () => {
  test('server 重启与断网重叠时恢复 CLI 和原生 Session 的草稿及附件，不自动重发', async ({ chatPage, testServer, mockAgent }) => {
    test.setTimeout(60_000);
    await createConversation(chatPage);

    await chatPage.fill('.input-area textarea', 'hello before restart');
    await chatPage.click('.send-btn');

    const msg = await mockAgent.waitForMessage('execute', 10000);
    mockAgent.simulateClaudeOutput(msg.conversationId, 'I am here');
    mockAgent.simulateTurnComplete(msg.conversationId);
    await expect(chatPage.locator('.assistant-turn')).toBeVisible({ timeout: 5000 });

    const input = chatPage.locator('.input-area textarea');
    const send = chatPage.locator('.input-area .send-btn:not(.stop-btn)');
    await input.fill('draft during restart');
    const upload = { name: 'reconnect.txt', mimeType: 'text/plain', buffer: Buffer.from('keep these bytes') };
    const firstUpload = chatPage.waitForResponse(response => response.url().endsWith('/api/upload') && response.ok());
    await chatPage.locator('.input-area input[type=file]').setInputFiles(upload);
    await firstUpload;
    await expect(send).toBeEnabled();
    await chatPage.context().setOffline(true);
    await testServer.kill();

    await expect(chatPage.locator('.connection-status')).toBeVisible({ timeout: 10000 });
    await expect(send).toBeDisabled();
    await input.fill('draft edited while offline');

    // Restart server
    await testServer.restart();

    // Agent reconnects
    await mockAgent.reconnect();

    // No focus/visibility change: reconnect directly from the online event.
    const reupload = chatPage.waitForResponse(response => response.url().endsWith('/api/upload') && response.ok());
    await chatPage.context().setOffline(false);
    await reupload;
    await expect(chatPage.locator('.connection-status')).not.toBeVisible({ timeout: 20000 });
    await expect(input).toHaveValue('draft edited while offline');
    await expect(chatPage.getByText('draft edited while offline', { exact: true })).toHaveCount(0);
    await expect(send).toBeEnabled();

    // Agent is back online
    await expect(chatPage.locator('.brand-label')).not.toHaveText('0 Agent', { timeout: 5000 });
    expect(mockAgent.messages('transfer_files')).toHaveLength(0);
    await send.click();
    const received = await mockAgent.waitForMessage('transfer_files');
    expect(received).toMatchObject({ prompt: 'draft edited while offline', files: [{
      name: upload.name, mimeType: upload.mimeType, data: upload.buffer.toString('base64'),
    }] });
    await expect(input).toHaveValue('');

    const native = await sessionTurnsFixture(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 390, height: 844 });
    const composer = chatPage.locator('.yeaft-session-input');
    const nativeInput = composer.locator('textarea');
    const nativeSend = composer.locator('.send-btn:not(.stop-btn)');
    await nativeInput.fill('native draft before restart');
    const uploads = Array.from({ length: 11 }, (_, i) => ({
      name: `reconnect-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`keep original attachment ${i}`),
    }));
    const picker = composer.locator('input[type=file]');
    await picker.setInputFiles(uploads.slice(0, 6));
    await expect(nativeSend).toBeEnabled();
    await picker.setInputFiles(uploads.slice(6));
    await picker.setInputFiles({ ...upload, name: 'remove-during-restore.txt' });
    await expect(composer.locator('.attachment-item')).toHaveCount(12);
    await expect(nativeSend).toBeEnabled();
    await chatPage.context().setOffline(true);
    await testServer.kill();
    await expect(composer.locator('.composer-connection')).toContainText('Offline');
    await expect(nativeSend).toBeDisabled();
    await nativeInput.fill('native draft edited offline');
    await testServer.restart();
    await mockAgent.reconnect();
    native.catalog();
    const restoredBatchSizes = [];
    let releaseFirstUpload;
    const firstUploadGate = new Promise(resolve => { releaseFirstUpload = resolve; });
    let firstUploadStarted;
    const firstUploadRequest = new Promise(resolve => { firstUploadStarted = resolve; });
    await chatPage.route('**/api/upload', async route => {
      if (!restoredBatchSizes.length) {
        firstUploadStarted();
        await firstUploadGate;
      }
      const response = await route.fetch();
      if (response.ok()) restoredBatchSizes.push((await response.json()).files.length);
      await route.fulfill({ response });
    });
    try {
      await chatPage.context().setOffline(false);
      await firstUploadRequest;
      await composer.getByRole('button', { name: 'Remove attachment remove-during-restore.txt' }).click();
      await expect(composer.locator('.attachment-item')).toHaveCount(11);
    } finally { releaseFirstUpload(); }
    await expect(nativeInput).toHaveValue('native draft edited offline');
    await expect(nativeSend).toBeEnabled();
    expect(restoredBatchSizes).toEqual([6, 5]);
    await chatPage.unroute('**/api/upload');
    expect(mockAgent.messages('yeaft_session_send')).toHaveLength(0);
    await nativeSend.click();
    expect(await mockAgent.waitForMessage('yeaft_session_send')).toMatchObject({
      sessionId: SESSION, text: 'native draft edited offline', files: uploads.map(({ name, mimeType, buffer }) => ({
        name, mimeType, data: buffer.toString('base64'),
      })),
    });
    await expect(nativeInput).toHaveValue('');
  });
});
