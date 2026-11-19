import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' } });

// Client-side seed for geometry only: Sydney > Parental Control, plus one top-level Session.
async function seedFolderTree(page, agentId) {
  await page.evaluate(agentId => {
    const chat = window.Pinia.useChatStore();
    const now = Date.now();
    const row = (sessionId, title, pinned, rank) => ({
      catalogKey: `yeaft:${agentId}:${sessionId}`, runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId, sessionId }, title, workDir: '/tmp/sidebar-layout',
      availability: 'online', createdAt: new Date(now - 86400000).toISOString(),
      metadataUpdatedAt: new Date(now - rank * 60000).toISOString(), sortRank: rank, pinned,
    });
    const member = sessionId => ({ agentId, sessionId });
    chat.currentView = 'yeaft';
    chat.applySessionCatalogSnapshot([
      row('nested-pinned', 'Parental Control - Security Review', true, 0),
      row('folder-plain', 'Sydney-C1', false, 1),
      row('top-plain', 'Proxy-Server-C1', false, 2),
    ], [
      { id: 'folder-sydney', name: 'Sydney', instruction: '', sortOrder: 0, parentId: null, members: [member('folder-plain')] },
      { id: 'folder-pc', name: 'Parental Control', instruction: '', sortOrder: 0, parentId: 'folder-sydney', members: [member('nested-pinned')] },
    ]);
  }, agentId);
  await expect(page.locator('.sidebar-project-header')).toHaveCount(2);
}

const left = locator => locator.evaluate(el => Math.round(el.getBoundingClientRect().left));
const shellWidth = page => page.locator('.session-sidebar-shell').evaluate(el => el.getBoundingClientRect().width);
const isFocused = locator => locator.evaluate(el => document.activeElement === el);
const folders = page => page.evaluate(() => window.Pinia.useChatStore().sessionProjects
  .map(({ id, name, parentId }) => ({ id, name, parentId: parentId || null })));
const folderRow = (page, name) => page.locator('.sidebar-project-header')
  .filter({ has: page.locator('.sidebar-project-name', { hasText: new RegExp(`^${name}$`) }) });
const folderToggle = (page, name) => folderRow(page, name).locator('.sidebar-project-toggle');

async function openFolderMenu(page, name) {
  await folderRow(page, name).hover();
  await folderRow(page, name).getByRole('button', { name: 'Folder menu' }).click();
}

async function pointerDrag(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  await page.mouse.move(x + 400, y);
}

test('sidebar is one folder tree with nested folders kept open or closed per user, and its width follows pointer and keyboard', async ({ chatPage: page, mockAgent, browser, serverUrl }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await seedFolderTree(page, mockAgent.agentId);

  // No Projects / Recents headings or split; actions run chat, task, folder, plugins.
  await expect(page.locator('.sidebar-section-heading')).toHaveCount(0);
  await expect(page.getByRole('separator', { name: /Projects and Recents/ })).toHaveCount(0);
  const actions = await page.locator('.sidebar-primary-actions > button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')));
  expect(actions.slice(0, 4)).toEqual(['New chat', 'New task', 'New folder', 'Plugins']);

  // Folders first, each followed by its subfolders and Sessions; top-level Sessions last.
  const order = await page.locator('.sidebar-tree > .sidebar-project-header .sidebar-project-name, .sidebar-tree > .sidebar-session-row .sidebar-session-title-text')
    .allTextContents();
  expect(order).toEqual(['Sydney', 'Parental Control', 'Parental Control - Security Review', 'Sydney-C1', 'Proxy-Server-C1']);

  // One 8px step per level: a folder's subfolders and Sessions share an edge,
  // and a pinned title starts on its own folder's name.
  const sydneyIcon = await left(folderRow(page, 'Sydney').locator('.sidebar-project-icon'));
  const nestedIcon = await left(folderRow(page, 'Parental Control').locator('.sidebar-project-icon'));
  const title = name => left(page.locator('.sidebar-session-title-text', { hasText: name }));
  expect(nestedIcon).toBe(sydneyIcon + 8);
  expect(await title('Sydney-C1')).toBe(nestedIcon);
  expect(await title('Security Review')).toBe(await left(folderRow(page, 'Parental Control').locator('.sidebar-project-name')));
  expect(await title('Proxy-Server-C1')).toBe(sydneyIcon);
  // Screen readers hear the folder path that the indentation shows.
  await expect(page.getByRole('button', { name: /Security Review\s*, in Sydney \/ Parental Control/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Parental Control\s*, in Sydney\b/ })).toHaveCount(1);
  // Folder actions overlay on hover, so a resting name is not cut short for them.
  expect(await folderRow(page, 'Parental Control').locator('.sidebar-project-name')
    .evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  // They stay hidden at rest on touch laptops too (coarse pointer, used with a mouse).
  // Read after the opacity transition settles; a first frame of 0 proves nothing.
  const sydneyActionsState = () => folderRow(page, 'Sydney').locator('.sidebar-folder-actions').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
    const style = getComputedStyle(el);
    return `${style.opacity} ${style.pointerEvents}`;
  });
  await page.mouse.move(900, 400); // rest: the pointer is over the content, not the sidebar
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  expect(await sydneyActionsState()).toBe('0 none');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.detach();
  await folderRow(page, 'Sydney').hover();
  await expect.poll(sydneyActionsState).toBe('1 auto');

  // Real Server folders: create, nest, move to the top level, drag back in, delete.
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('Alpha');
  await page.keyboard.press('Enter');
  await expect.poll(() => folders(page)).toEqual([expect.objectContaining({ name: 'Alpha', parentId: null })]);
  const alphaId = (await folders(page))[0].id;

  await openFolderMenu(page, 'Alpha');
  await page.getByRole('button', { name: 'New subfolder' }).click();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('Beta');
  await page.keyboard.press('Enter');
  await expect.poll(() => folders(page)).toContainEqual(expect.objectContaining({ name: 'Beta', parentId: alphaId }));
  expect(await left(folderRow(page, 'Beta').locator('.sidebar-project-icon')))
    .toBe(await left(folderRow(page, 'Alpha').locator('.sidebar-project-icon')) + 8);

  await openFolderMenu(page, 'Beta');
  await page.getByRole('button', { name: /^Move to\b/ }).click();
  await page.getByRole('button', { name: 'Top level' }).click();
  await expect.poll(() => folders(page)).toContainEqual(expect.objectContaining({ name: 'Beta', parentId: null }));

  // Dropping on the middle of a folder row nests the dragged folder inside it.
  await folderRow(page, 'Beta').dragTo(folderRow(page, 'Alpha'));
  await expect.poll(() => folders(page)).toContainEqual(expect.objectContaining({ name: 'Beta', parentId: alphaId }));

  // A subfolder's chats inherit the parent's instruction; its dialog says how much.
  await page.evaluate(id => window.Pinia.useChatStore()
    .mutateProject('update_instruction', { projectId: id, instruction: 'Ship small PRs.' }), alphaId);
  await openFolderMenu(page, 'Beta');
  await page.getByRole('button', { name: 'Folder instructions' }).click();
  await expect(page.locator('.project-instruction-modal')).toContainText('15 characters of instructions from parent folders');
  await page.keyboard.press('Escape');
  await expect(page.locator('.project-instruction-modal')).toHaveCount(0);

  // Open/closed is a per-user Server preference (checked after the reload below).
  await folderToggle(page, 'Alpha').click();
  await expect(folderToggle(page, 'Alpha')).toHaveAttribute('aria-expanded', 'false');
  await expect(folderRow(page, 'Beta')).toHaveCount(0);

  // Pointer resize of the sidebar itself, released focus, browser-local persistence.
  const handle = page.getByRole('separator', { name: /^Resize sidebar/ });
  await expect(handle).toHaveAttribute('aria-controls', 'session-sidebar');
  expect(await shellWidth(page)).toBe(260);
  await pointerDrag(page, handle, 100, 0);
  expect(await shellWidth(page)).toBe(360);
  await expect(handle).toHaveAttribute('aria-valuenow', '360');
  expect(await isFocused(handle)).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('session-sidebar-width'))).toBe('360');

  // Reload with the preference response slower than the catalog: a closed
  // folder is drawn closed from its first frame, never open and then shut.
  await page.route('**/api/user/preferences', async route => {
    if (route.request().method() === 'GET') await new Promise(resolve => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.addInitScript(() => {
    window.__alphaStates = [];
    new MutationObserver(() => {
      for (const header of document.querySelectorAll('.sidebar-project-header')) {
        if (header.querySelector('.sidebar-project-name')?.textContent !== 'Alpha') continue;
        const state = header.querySelector('.sidebar-project-toggle')?.getAttribute('aria-expanded');
        if (window.__alphaStates.at(-1) !== state) window.__alphaStates.push(state);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded'] });
  });

  // The width is applied before first paint on reload (the Chat host this time).
  await page.reload();
  await expect(page.locator('.session-sidebar-shell')).toBeVisible();
  expect(await shellWidth(page)).toBe(360);
  await expect(folderToggle(page, 'Alpha')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.__alphaStates)).toEqual(['false']);
  await expect(folderRow(page, 'Beta')).toHaveCount(0);
  await page.unroute('**/api/user/preferences');

  // Another client (a fresh browser profile) gets the same state from the Server.
  const otherClient = await browser.newContext();
  try {
    const otherPage = await otherClient.newPage();
    await otherPage.goto(serverUrl);
    await expect(folderToggle(otherPage, 'Alpha')).toHaveAttribute('aria-expanded', 'false');
    await expect(folderRow(otherPage, 'Beta')).toHaveCount(0);
  } finally {
    await otherClient.close();
  }

  await openFolderMenu(page, 'Alpha');
  await page.getByRole('button', { name: 'Delete folder' }).click();
  await expect(page.locator('.app-dialog')).toContainText('along with its subfolders (1)');
  await page.locator('.app-dialog-confirm').click();
  await expect.poll(() => folders(page)).toEqual([]);

  // Keyboard: arrows move the divider the way they point; Home restores the default.
  const reloadedHandle = page.getByRole('separator', { name: /^Resize sidebar/ });
  await reloadedHandle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(reloadedHandle).toHaveAttribute('aria-valuenow', '344');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(reloadedHandle).toHaveAttribute('aria-valuenow', '408');

  // A narrower window keeps 480px for the content; the rendered width, the
  // reported value and the grow key agree instead of the sidebar jumping.
  await page.setViewportSize({ width: 860, height: 860 });
  await expect.poll(() => shellWidth(page)).toBe(380);
  await expect(reloadedHandle).toHaveAttribute('aria-valuenow', '380');
  await page.keyboard.press('ArrowRight');
  await expect(reloadedHandle).toHaveAttribute('aria-valuenow', '380');
  expect(await shellWidth(page)).toBe(380);

  await page.keyboard.press('Home');
  // Keyboard steps keep the sidebar's width transition; wait for it to settle.
  await expect.poll(() => shellWidth(page)).toBe(260);
  expect(await page.evaluate(() => localStorage.getItem('session-sidebar-width'))).toBeNull();

  // Phones use the overlay drawer, which has no width handle.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.session-sidebar-resize-handle')).toHaveCount(0);
});
