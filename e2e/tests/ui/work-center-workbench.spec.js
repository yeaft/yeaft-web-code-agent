import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

for (const { width, theme } of [
  { width: 1440, theme: 'light' }, { width: 1440, theme: 'dark' },
  { width: 320, theme: 'light' }, { width: 320, theme: 'dark' },
]) {
  test(`WorkItem files use the shared Workbench without changing chat at ${width}px ${theme}`, async ({ chatPage: page, mockAgent }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const detail = {
      id: 'output-item', title: 'Release evidence', goal: 'Inspect the delivered files',
      status: 'done', boardLane: 'closed', revision: 1, updatedAt: Date.now(),
      workbench: { workDir: '/tmp/work-item-repo' },
      outputs: [
        { kind: 'file', label: 'Release notes', ref: 'docs/release.md' },
        { kind: 'file', label: 'Outside workspace', ref: '../private.txt' },
        { kind: 'link', label: 'Pull request', ref: 'https://example.test/pull/1' },
      ],
      actions: [], messages: [],
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: [
      'work_center', 'work_center_workbench', 'work_center_message_v2',
      'file_editor', 'terminal', 'workbench_session_routes',
      'workbench_request_correlation', 'workbench_terminal_cleanup_fence', 'plaintext-ok',
    ] });
    const respond = message => {
      if (message.type === 'work_center_request') {
        const data = message.op === 'list' ? { items: [detail] }
          : message.op === 'get' ? detail
          : { settings: {}, runtime: { vps: [], models: [] } };
        mockAgent.send({ type: 'work_center_response', requestId: message.requestId, op: message.op, ok: true, data });
      }
      if (message.type === 'list_directory') {
        mockAgent.send({ ...message, type: 'directory_listing', entries: [], dirPath: message.dirPath || message.workDir });
      }
      if (message.type === 'read_file') {
        mockAgent.send({ ...message, type: 'file_content', content: '# Verified delivery\n\nOutput belongs to this WorkItem.\n', binary: false });
      }
      if (message.type === 'terminal_create') {
        mockAgent.send({ ...message, type: 'terminal_created', success: true });
      }
      if (message.type === 'git_status') {
        mockAgent.send({ ...message, type: 'git_status_result', branch: 'main', files: [], ahead: 0, behind: 0 });
      }
    };
    mockAgent._messageHandlers.push(respond);
    await page.waitForFunction(() => window.Pinia.useChatStore().workCenterWorkbenchProtocolSupported === true);
    const before = await page.evaluate(({ agentId, theme }) => {
      document.documentElement.setAttribute('data-theme', theme);
      const store = window.Pinia.useChatStore();
      const state = { currentAgent: store.currentAgent, currentConversation: store.currentConversation,
        route: store.activeSessionRoute, workDir: store.effectiveWorkDir,
        expanded: store.workbenchExpanded, maximized: store.workbenchMaximized };
      store.enterWorkCenter(agentId);
      return state;
    }, { agentId: mockAgent.agentId, theme });
    const card = page.locator('.work-center-card-open');
    // Closed lane is a real mobile tab; desktop shows all lanes.
    if (width === 320) await page.locator('.work-center-board-lane-tabs [role="tab"]').last().click();
    await expect(card).toBeVisible();
    await card.click();
    const toggle = page.locator('.work-center-workbench-toggle');
    await expect(toggle).toBeEnabled();
    await page.evaluate(() => { window.Pinia.useChatStore().workCenterWorkbenchProtocolSupported = false; });
    await expect(toggle).toBeDisabled();
    await expect(page.locator('.work-center-output-file')).toHaveCount(0);
    await page.evaluate(() => { window.Pinia.useChatStore().workCenterWorkbenchProtocolSupported = true; });
    await expect(toggle).toBeEnabled();
    await expect(page.locator('.work-center-output-file')).toHaveCount(1);
    await expect(page.locator('.work-center-output-list a')).toHaveAttribute('href', 'https://example.test/pull/1');
    await page.getByRole('button', { name: 'Open file: Release notes', exact: true }).click();
    const panel = page.locator('.workbench-panel');
    await expect(panel).toHaveClass(/expanded/);
    await expect(panel.locator('.file-content-path')).toContainText('release.md');
    await expect(panel.locator('.file-load-state')).toHaveCount(0);
    await expect(panel.locator('.file-load-error')).toHaveCount(0);
    const read = mockAgent.messages('read_file').at(-1);
    expect(read.workbenchRoute).toEqual({ runtimeProvider: 'work-center', agentId: mockAgent.agentId, workItemId: detail.id });
    expect(read.workDir).toBe('/tmp/work-item-repo');
    expect(read.filePath).toBe('/tmp/work-item-repo/docs/release.md');
    expect(read.workbenchRoute.sessionId).toBeUndefined();
    expect(read._workbenchRequestId).toBeTruthy();
    await expect(panel.getByTitle('Open folder', { exact: true })).toHaveCount(0);
    // The Workbench starts at the page top, never beneath the Work Center header.
    await panel.evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    const mainBounds = await page.locator('.work-center-main').boundingBox();
    const panelBounds = await panel.boundingBox();
    expect(panelBounds.y).toBe(mainBounds.y);
    expect(panelBounds.height).toBe(mainBounds.height);
    expect(await panel.evaluate(element => element.parentElement.classList.contains('work-center-main'))).toBe(true);
    if (width === 320) {
      expect(panelBounds.x).toBe(0);
      expect(panelBounds.width).toBe(width);
      await expect(panel.locator('.workbench-panel-close')).toBeVisible();
    } else {
      const headerBounds = await page.locator('.work-center-header').boundingBox();
      expect(headerBounds.x + headerBounds.width).toBeLessThanOrEqual(panelBounds.x + 1);
      await expect(page.locator('.work-center-close-button')).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`work-center-files-${width}-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.locator('.workbench-panel-close').click();
    await expect(panel).not.toHaveClass(/expanded/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(panel).toHaveClass(/expanded/);
    await panel.locator('.workbench-item-close').click();
    await expect(panel.locator('.file-content-path')).toHaveCount(0);
    await panel.locator('.workbench-panel-close').click();
    await page.getByRole('button', { name: 'Open file: Release notes', exact: true }).click();
    await expect(panel.locator('.file-content-path')).toContainText('release.md');
    // The same launcher mounts the shared Git and Terminal views.
    await panel.locator('.workbench-add-btn').click();
    await panel.locator('.workbench-add-menu [data-workbench-capability="git"]').click();
    await expect(panel.locator('.git-status-tab')).toBeVisible();
    await expect.poll(() => mockAgent.messages('git_status').length).toBeGreaterThan(0);
    expect(mockAgent.messages('git_status').at(-1).workDir).toBe('/tmp/work-item-repo');
    await expect(panel.locator('.git-workdir-input')).toHaveAttribute('readonly', '');
    await panel.locator('.workbench-add-btn').click();
    await panel.locator('.workbench-add-menu [data-workbench-capability="terminal"]').click();
    await expect.poll(() => mockAgent.messages('terminal_create').length).toBeGreaterThan(0);
    const terminal = mockAgent.messages('terminal_create').at(-1);
    expect(terminal.workDir).toBe('/tmp/work-item-repo');
    expect(terminal.workbenchRoute).toEqual(read.workbenchRoute);
    await panel.locator('.workbench-panel-close').click();
    await page.locator('.work-center-close-button').click();
    const after = await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      return { currentAgent: store.currentAgent, currentConversation: store.currentConversation,
        route: store.activeSessionRoute, workDir: store.effectiveWorkDir,
        expanded: store.workbenchExpanded, maximized: store.workbenchMaximized };
    });
    expect(after).toEqual(before);
    expect(errors).toEqual([]);
  });
}
