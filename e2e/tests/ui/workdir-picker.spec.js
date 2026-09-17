import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

// Seed only the surrounding inventory/forms. Directory requests and responses
// always traverse the browser -> Server -> mock Agent requestId relay.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

async function openEntry(page, mockAgent, entry) {
  if (entry === 'work-center') {
    await page.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      const settings = { revision: 1, defaultWorkDir: '/tmp/test', startImmediately: false };
      const runtime = { workDir: '/tmp/test', vps: [], models: [] };
      store.workCenterRequest = async op => {
        if (op === 'list') return { items: [] };
        if (op === 'get_settings') return { settings, runtime };
        if (op === 'get_runtime') return runtime;
        throw new Error(`Unexpected Work Center operation: ${op}`);
      };
      store.hydrateWorkCenterBrowserState();
      store.workCenterAgentId = agentId;
      store.workCenterItemsByAgent[agentId] = [];
      store.workCenterLoadedByAgent[agentId] = true;
      store.workCenterSettingsByAgent[agentId] = settings;
      store.workCenterRuntimeByAgent[agentId] = runtime;
      store.workCenterOpen = true;
    }, mockAgent.agentId);
    await page.locator('.work-center-header-create').click();
    return {
      modal: page.locator('.work-center-modal'),
      field: page.locator('.work-center-modal').getByRole('textbox', { name: /Working directory/ }),
      browse: page.locator('.work-center-modal').getByRole('button', { name: 'Choose folder' }),
    };
  }

  const session = {
    id: 'picker-session', name: 'Picker regression', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test',
    createdAt: new Date().toISOString(), metadataUpdatedAt: new Date().toISOString(),
  };
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [session] } });
  await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().sessionCatalog
    .some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === 'picker-session'),
  mockAgent.agentId)).toBe(true);
  await page.evaluate(agentId => {
    const store = window.Pinia.useChatStore();
    store.openCatalogSession(store.sessionCatalog.find(row => row.routeRef.agentId === agentId
      && row.routeRef.sessionId === 'picker-session'));
    store.sessionSidebarOpen = true;
  }, mockAgent.agentId);

  if (entry === 'session-create') {
    await page.locator('.sidebar-primary-action:visible').click();
    const modal = page.locator('.yeaft-session-create-modal');
    return { modal, field: modal.locator('.workdir-input-group input'), browse: modal.locator('.workdir-browse-btn') };
  }
  const row = page.locator('.session-item.active');
  await row.hover();
  await row.locator('.session-dots-btn').click();
  await page.locator('.session-menu-floating .session-menu-item').filter({ hasText: /^Settings$/ }).click();
  const modal = page.locator('.group-settings-modal');
  return { modal, field: modal.locator('#session-settings-workdir'), browse: modal.getByRole('button', { name: 'Browse', exact: true }) };
}

function replyDirectory(mockAgent, request, { path = request.dirPath, entries = [], error } = {}) {
  // Server keeps the public requestId private and restores it on the reply.
  expect(request._workbenchRequestId).toBeTruthy();
  expect(request.conversationId).toBe('_workdir_picker');
  mockAgent.send({
    type: 'directory_listing', conversationId: request.conversationId,
    _workbenchRequestId: request._workbenchRequestId,
    dirPath: path, entries, ...(error ? { error } : {}),
  });
}

async function requestDirectory(mockAgent, action) {
  const pending = (async () => {
    for (;;) {
      const request = await mockAgent.waitForMessage('list_directory');
      if (request.conversationId === '_workdir_picker') return request;
    }
  })();
  await action();
  return pending;
}

for (const entry of ['session-create', 'session-settings', 'work-center']) {
  test(`unified workdir picker: ${entry} navigation, keyboard and responsive themes`, async ({ chatPage: page, mockAgent }, testInfo) => {
    const { modal, field, browse } = await openEntry(page, mockAgent, entry);
    const initial = await requestDirectory(mockAgent, () => browse.click());
    replyDirectory(mockAgent, initial, {
      path: '/tmp/test', entries: [{ name: 'project alpha', type: 'directory' }, { name: 'ignored.txt', type: 'file' }],
    });
    const picker = page.getByRole('dialog', { name: 'Select Work Directory', exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.locator('.folder-picker-item')).toHaveCount(1);
    const path = picker.getByRole('textbox');
    const confirm = picker.getByRole('button', { name: 'Select this directory', exact: true });
    await expect(confirm).toBeEnabled();

    // A single click enters a child; it must not commit the form's directory.
    const originalDirectory = await field.inputValue();
    const child = await requestDirectory(mockAgent, () => picker.getByRole('button', { name: 'project alpha', exact: true }).click());
    expect(child.dirPath).toBe('/tmp/test/project alpha');
    await expect(confirm).toBeDisabled();
    await expect(field).toHaveValue(originalDirectory);
    replyDirectory(mockAgent, child);
    await expect(path).toHaveValue('/tmp/test/project alpha');
    await expect(confirm).toBeEnabled();
    const ancestor = await requestDirectory(mockAgent, () => picker.getByRole('navigation', { name: 'Directory ancestors' })
      .getByRole('button', { name: 'tmp', exact: true }).click());
    expect(ancestor.dirPath).toBe('/tmp');
    replyDirectory(mockAgent, ancestor);
    await expect(path).toHaveValue('/tmp');
    await expect(field).toHaveValue(originalDirectory);

    // Root is one direct request, not repeated parent navigation.
    const root = picker.getByRole('button', { name: 'Root / drives', exact: true });
    await root.focus();
    const rootRequest = await requestDirectory(mockAgent, () => page.keyboard.press('Enter'));
    expect(rootRequest.dirPath).toBe('');
    replyDirectory(mockAgent, rootRequest, { path: '/', entries: [] });
    await expect(path).toHaveValue('/');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(field).toHaveValue('/');
    await expect(modal).toBeVisible();
    await expect(browse).toBeFocused();

    const reopen = await requestDirectory(mockAgent, () => browse.press('Enter'));
    replyDirectory(mockAgent, reopen, { path: '/', entries: [] });
    const deepPath = '/srv/projects/team space/very-long-project-name/packages/deeply/nested/application';
    await path.fill(deepPath);
    await expect(confirm).toBeDisabled();
    const manual = await requestDirectory(mockAgent, () => path.press('Enter'));
    expect(manual.dirPath).toBe(deepPath);
    replyDirectory(mockAgent, manual, {
      entries: Array.from({ length: 24 }, (_, index) => ({ name: `folder ${String(index).padStart(2, '0')} with a long descriptive name`, type: 'directory' })),
    });
    await expect(confirm).toBeEnabled();
    await expect(picker.locator('.folder-picker-item')).toHaveCount(24);
    const list = picker.locator('.folder-picker-list');
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await expect(picker.locator('.folder-picker-item').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(picker.locator('.folder-picker-item').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(picker.locator('.folder-picker-item').first()).toBeFocused();

    for (const view of [
      { width: 1280, theme: 'light' },
      { width: 320, theme: 'light' },
      { width: 320, theme: 'dark' },
    ]) {
      await page.setViewportSize({ width: view.width, height: 800 });
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), view.theme);
      await path.focus();
      await expect(path).toBeFocused();
      const geometry = await picker.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          overflow: element.scrollWidth - element.clientWidth,
          background: style.backgroundColor, color: style.color,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(view.width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(800);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.color).not.toBe(geometry.background);
      await expect(confirm).toBeInViewport();
      const lastFolder = picker.locator('.folder-picker-item').last();
      await lastFolder.scrollIntoViewIfNeeded();
      await expect(lastFolder).toBeInViewport();
      await expect(confirm).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`${entry}-${view.width}-${view.theme}.png`) });
    }
    // The nested dialog contains focus, and Escape closes only the picker.
    await confirm.focus();
    await page.keyboard.press('Tab');
    expect(await picker.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(field).toHaveValue('/');
    await expect(browse).toBeFocused();
  });
}

test('unified workdir picker: Windows drive chooser and current-directory confirmation', async ({ chatPage: page, mockAgent }) => {
  const { field, browse } = await openEntry(page, mockAgent, 'session-settings');
  const initial = await requestDirectory(mockAgent, () => browse.click());
  replyDirectory(mockAgent, initial, { path: 'C:\\Users\\Test User\\project', entries: [] });
  const picker = page.getByRole('dialog', { name: 'Select Work Directory', exact: true });
  const path = picker.getByRole('textbox', { name: 'Directory path' });
  const confirm = picker.getByRole('button', { name: 'Select this directory', exact: true });
  await expect(confirm).toBeEnabled();

  const root = await requestDirectory(mockAgent, () => picker.getByRole('button', { name: 'Root / drives', exact: true }).click());
  expect(root.dirPath).toBe('');
  replyDirectory(mockAgent, root, { path: '', entries: [{ name: 'C:', type: 'directory' }, { name: 'D:', type: 'directory' }] });
  await expect(path).toHaveValue('');
  await expect(picker.locator('.folder-picker-item')).toHaveCount(2);
  await expect(confirm).toBeDisabled(); // The virtual drive chooser is not a directory.
  await expect(picker.getByRole('button', { name: 'Parent Directory', exact: true })).toBeDisabled();

  const drive = await requestDirectory(mockAgent, () => picker.getByRole('button', { name: 'D:', exact: true }).click());
  expect(drive.dirPath).toBe('D:\\');
  replyDirectory(mockAgent, drive, { entries: [{ name: 'team space', type: 'directory' }] });
  await expect(path).toHaveValue('D:\\');
  await expect(confirm).toBeEnabled();
  const child = await requestDirectory(mockAgent, () => picker.getByRole('button', { name: 'team space', exact: true }).press('Enter'));
  expect(child.dirPath).toBe('D:\\team space');
  replyDirectory(mockAgent, child);
  await expect(path).toHaveValue('D:\\team space');
  const ancestor = await requestDirectory(mockAgent, () => picker.getByRole('navigation', { name: 'Directory ancestors' })
    .getByRole('button', { name: 'D:\\', exact: true }).click());
  expect(ancestor.dirPath).toBe('D:\\');
  replyDirectory(mockAgent, ancestor);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(field).toHaveValue('D:\\');
});

test('unified workdir picker: loading, stale relay responses and error recovery', async ({ chatPage: page, mockAgent }) => {
  const { field, browse } = await openEntry(page, mockAgent, 'work-center');
  const initial = await requestDirectory(mockAgent, () => browse.click());
  replyDirectory(mockAgent, initial, { entries: [{ name: 'project', type: 'directory' }] });
  const picker = page.getByRole('dialog', { name: 'Select Work Directory', exact: true });
  const path = picker.getByRole('textbox');
  const confirm = picker.getByRole('button', { name: 'Select this directory', exact: true });
  await expect(confirm).toBeEnabled();

  await path.fill('/old pending path');
  const stale = await requestDirectory(mockAgent, () => picker.getByRole('button', { name: 'Go', exact: true }).click());
  await expect(confirm).toBeDisabled();
  await expect(picker.locator('.folder-picker-item')).toHaveCount(0);
  await path.fill('/new pending path');
  const latest = await requestDirectory(mockAgent, () => path.press('Enter'));
  expect(latest._workbenchRequestId).not.toBe(stale._workbenchRequestId);
  await page.evaluate(() => {
    window.__pickerStaleReplySeen = false;
    const observe = event => {
      if (event.detail?.type !== 'directory_listing' || event.detail.dirPath !== '/old pending path') return;
      window.__pickerStaleReplySeen = true;
      window.removeEventListener('workbench-message', observe);
    };
    window.addEventListener('workbench-message', observe);
  });
  replyDirectory(mockAgent, stale, { entries: [{ name: 'stale folder', type: 'directory' }] });
  // Observe the real relay delivery before checking that a stale response did
  // not clear loading or enable confirmation; no synthetic directory events.
  await expect.poll(() => page.evaluate(() => window.__pickerStaleReplySeen)).toBe(true);
  await expect(picker.locator('.folder-picker-list')).toHaveAttribute('aria-busy', 'true');
  await expect(picker.locator('.folder-picker-item')).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  replyDirectory(mockAgent, latest, { entries: [{ name: 'current folder', type: 'directory' }] });
  await expect(picker.locator('.folder-picker-item > span:first-of-type')).toHaveText(['current folder']);
  await expect(path).toHaveValue('/new pending path');
  await expect(confirm).toBeEnabled();

  for (const [invalidPath, error] of [
    ['/not found', 'ENOENT: no such file or directory'],
    ['/permission denied', 'EACCES: permission denied'],
    ['/file.txt', 'ENOTDIR: not a directory'],
  ]) {
    await path.fill(invalidPath);
    const request = await requestDirectory(mockAgent, () => path.press('Enter'));
    replyDirectory(mockAgent, request, { error });
    await expect(picker.getByRole('alert')).toContainText(error);
    await expect(confirm).toBeDisabled();
    await expect(field).toHaveValue('/tmp/test');
    await expect(picker.locator('.folder-picker-item')).toHaveCount(0);
  }
  await path.fill('/recovered project');
  const recovered = await requestDirectory(mockAgent, () => picker.getByRole('button', { name: 'Go', exact: true }).click());
  expect(recovered.dirPath).toBe('/recovered project');
  replyDirectory(mockAgent, recovered);
  await expect(picker.getByRole('alert')).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(field).toHaveValue('/recovered project');
});
