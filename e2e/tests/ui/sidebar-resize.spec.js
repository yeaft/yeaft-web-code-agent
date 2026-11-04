import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

const readRatio = page => page.locator('.sidebar-session-results').evaluate(el => {
  const projects = el.querySelector('.projects-section').getBoundingClientRect().height;
  const recents = el.querySelector('.recents-section').getBoundingClientRect().height;
  return projects / (projects + recents);
});
async function open(page, url, theme = 'light') {
  await page.addInitScript(theme => {
    localStorage.setItem('theme', theme);
    localStorage.setItem('yeaft-preferred-conversation-view', 'chat');
  }, theme);
  await page.goto(url);
  await expect(page.locator('.sidebar-navigation')).toBeVisible();
}

for (const theme of ['light', 'dark']) {
  test(`sidebar ratio drag / keyboard / cross-device persistence / ${theme}`, async ({ page, browser, serverUrl, mockAgent }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await open(page, serverUrl, theme);
    const handle = page.locator('.sidebar-section-resize-handle');
    await expect(handle).toHaveAttribute('aria-disabled', 'false');
    const shortcuts = page.locator('.sidebar-primary-actions');
    const compactToggle = page.locator('.sidebar-actions-toggle');
    await expect(shortcuts).not.toHaveClass(/is-compact/);
    await expect(compactToggle).toHaveCount(0);
    // A borderline list fits only after compacting. Expanding it by keyboard
    // must keep the same focused toggle through the new overflow measurement.
    await handle.dblclick();
    await expect(handle).toHaveAttribute('aria-valuenow', '50');
    await page.setViewportSize({ width: 1400, height: 1200 });
    await page.evaluate(agentId => {
      window.Pinia.useChatStore().sessionCatalog = Array.from({ length: 10 }, (_, index) => ({
        catalogKey: 'borderline-' + index, runtimeProvider: 'yeaft', title: 'Recent session ' + index,
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'borderline-' + index }, availability: 'online',
      }));
    }, mockAgent.agentId);
    await expect(page.locator('.recents-section .session-item')).toHaveCount(10);
    await expect(compactToggle).toHaveCount(0);
    // Derive a four-pixel overflow from real row geometry, rather than a fixed
    // viewport / row-height estimate that breaks when header spacing changes.
    const borderlineHeight = await page.locator('.recents-section').evaluate(el => {
      const last = el.querySelector('.session-item:last-child');
      const contentHeight = last.getBoundingClientRect().bottom - el.getBoundingClientRect().top
        + parseFloat(getComputedStyle(last).marginBottom) + parseFloat(getComputedStyle(el).paddingBottom);
      return Math.round(innerHeight + 2 * (contentHeight - 4 - el.clientHeight));
    });
    await page.setViewportSize({ width: 1400, height: borderlineHeight });
    await expect(compactToggle).toBeVisible();
    await compactToggle.click();
    await expect(shortcuts).toHaveClass(/is-compact/);
    await expect.poll(() => page.locator('.recents-section').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await compactToggle.focus();
    await page.keyboard.press('Enter');
    await expect(shortcuts).not.toHaveClass(/is-compact/);
    await expect(compactToggle).toBeFocused();
    // If the list really becomes short while compact, restore focus to New chat
    // when the now-unnecessary toggle disappears.
    await compactToggle.click();
    await page.evaluate(() => { window.Pinia.useChatStore().sessionCatalog = []; });
    await expect(page.locator('.recents-section .session-item')).toHaveCount(0);
    await compactToggle.focus();
    await page.keyboard.press('Enter');
    await expect(compactToggle).toHaveCount(0);
    await expect(shortcuts.locator('button').first()).toBeFocused();
    await page.setViewportSize({ width: 1400, height: 900 });
    // Layout stress fixture only: preference reads/writes below use the real Server DB.
    await page.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      store.sessionProjects = Array.from({ length: 30 }, (_, index) => ({ id: 'layout-project-' + index, name: 'Long project title ' + index, members: [] }));
      store.sessionCatalog = Array.from({ length: 40 }, (_, index) => ({
        catalogKey: 'layout-session-' + index, runtimeProvider: 'yeaft', title: 'Recent session ' + index,
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'layout-session-' + index }, availability: 'online',
      }));
    }, mockAgent.agentId);
    await expect(page.locator('.sidebar-project')).toHaveCount(30);
    await expect(page.locator('.recents-section .session-item')).toHaveCount(40);
    await expect(compactToggle).toBeVisible();
    await expect(compactToggle).toHaveAttribute('aria-expanded', 'true');
    // The control belongs beside the last shortcut, never at the footer.
    expect(await compactToggle.evaluate(el => {
      const area = el.closest('.sidebar-primary-actions').getBoundingClientRect();
      const last = el.previousElementSibling.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return box.top === last.top && box.bottom <= area.bottom && box.left >= last.left;
    })).toBe(true);
    const expandedHeight = await shortcuts.evaluate(el => el.getBoundingClientRect().height);
    const expandedResultsHeight = await page.locator('.sidebar-session-results').evaluate(el => el.clientHeight);
    await compactToggle.focus();
    await page.keyboard.press('Enter');
    await expect(shortcuts).toHaveClass(/is-compact/);
    await expect(compactToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(compactToggle).toBeFocused();
    expect(await page.locator('.session-sidebar-shell').evaluate(el => {
      const header = el.querySelector('.sidebar-header-row');
      const controlsBottom = Math.max(...[...header.children].map(child => child.getBoundingClientRect().bottom));
      return el.querySelector('.sidebar-primary-action').getBoundingClientRect().top - controlsBottom;
    })).toBe(11);
    expect(await shortcuts.evaluate(el => el.getBoundingClientRect().height)).toBe(expandedHeight - 68);
    expect(await page.locator('.sidebar-session-results').evaluate(el => el.clientHeight)).toBe(expandedResultsHeight + 68);
    expect(await shortcuts.locator('button').evaluateAll(buttons => {
      const boxes = buttons.map(button => button.getBoundingClientRect());
      return boxes.every(box => box.y === boxes[0].y && box.width === 34 && box.height === 34)
        && buttons.every(button => !button.textContent.trim());
    })).toBe(true);
    expect(await shortcuts.locator('.sidebar-primary-action-icon').evaluateAll(icons => icons.every(icon => {
      const box = icon.getBoundingClientRect(); return box.width === 18 && box.height === 18;
    }))).toBe(true);
    expect(await compactToggle.evaluate(el => {
      const previous = el.previousElementSibling.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const area = el.parentElement;
      return box.top === previous.top && box.left > previous.right
        && Math.abs(area.getBoundingClientRect().right - parseFloat(getComputedStyle(area).paddingRight) - box.right) < 1;
    })).toBe(true);
    // All disclosure controls share the existing section glyph, size and rotation.
    expect(await page.locator('.sidebar-section-chevron').evaluateAll(icons => icons.every(icon => {
      const box = icon.getBoundingClientRect();
      return box.width === 14 && box.height === 14
        && icon.querySelector('path').getAttribute('d') === 'm8 10 4 4 4-4';
    }))).toBe(true);
    for (const section of ['projects', 'recents']) {
      const heading = page.locator(`.${section}-section > .sidebar-section-heading`);
      expect(await heading.evaluate(el => {
        const toggle = el.lastElementChild;
        const box = toggle.getBoundingClientRect();
        const previous = toggle.previousElementSibling.getBoundingClientRect();
        return toggle.classList.contains('sidebar-section-toggle') && box.left >= previous.right
          && Math.abs(el.getBoundingClientRect().right - box.right) < 1;
      })).toBe(true);
      await expect(heading.locator('.sidebar-section-chevron')).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath('sidebar-compact.png') });
    await page.keyboard.press('Space');
    await expect(shortcuts).not.toHaveClass(/is-compact/);
    await expect(shortcuts.locator('.sidebar-primary-action')).toHaveText(['New chat', 'New task', 'Plugins']);
    await expect(compactToggle).toHaveAttribute('aria-expanded', 'true');
    for (const selector of ['.projects-section', '.recents-section']) {
      expect(await page.locator(selector).evaluate(el => { el.scrollTop = 100; return el.scrollHeight > el.clientHeight && el.scrollTop > 0; })).toBe(true);
    }
    await page.locator('.projects-section').evaluate(el => { el.scrollTop = 0; });
    const before = await readRatio(page);
    const rect = await handle.boundingBox();
    const resultsHeight = await page.locator('.sidebar-session-results').evaluate(el => el.clientHeight - 10);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + resultsHeight * (0.7 - before), { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await (await page.request.get(serverUrl + '/api/user/preferences')).json()).sidebarProjectsRatio).toBeCloseTo(0.7, 2);
    expect(await readRatio(page)).toBeCloseTo(0.7, 2);
    await page.screenshot({ path: testInfo.outputPath('sidebar-dragged.png') });

    await compactToggle.click();
    await expect.poll(async () => (await (await page.request.get(serverUrl + '/api/user/preferences')).json()).sidebarActionsCompact).toBe(true);
    // A genuinely separate browser context, no copied localStorage/cookies.
    const device = await browser.newContext({ viewport: { width: 1200, height: 700 } });
    try {
      const other = await device.newPage();
      await open(other, serverUrl, theme);
      await expect(other.locator('.sidebar-section-resize-handle')).toHaveAttribute('aria-valuenow', '70');
      await expect(other.locator('.sidebar-primary-actions')).toHaveClass(/is-compact/);
      // Even with a short list on another desktop, the saved layout wins.
      await other.locator('.sidebar-actions-toggle').click();
      await expect.poll(async () => (await (await page.request.get(serverUrl + '/api/user/preferences')).json()).sidebarActionsCompact).toBe(false);
      expect(await readRatio(other)).toBeCloseTo(0.7, 2);
      await other.locator('.sidebar-section-resize-handle').focus();
      await other.keyboard.press('ArrowUp');
      await expect.poll(async () => (await (await page.request.get(serverUrl + '/api/user/preferences')).json()).sidebarProjectsRatio).toBeCloseTo(0.68, 2);
      let pendingRead;
      let readArrived;
      const arrived = new Promise(resolve => { readArrived = resolve; });
      await page.route('**/api/user/preferences', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        pendingRead = route;
        readArrived();
      }, { times: 1 });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await arrived;
      const dragBox = await handle.boundingBox();
      await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2 - 60, { steps: 3 });
      const readCompleted = page.waitForResponse(response => response.url().endsWith('/api/user/preferences') && response.request().method() === 'GET');
      await pendingRead.continue();
      await (await readCompleted).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // Cancel must reveal the latest server value, not the drag's old start value.
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(handle).toHaveAttribute('aria-valuenow', '68');
      await expect(shortcuts).not.toHaveClass(/is-compact/);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(handle).toHaveAttribute('aria-valuenow', '68');
      expect(await readRatio(page)).toBeCloseTo(0.68, 2);
    } finally { await device.close(); }

    // A second Web client can refresh the catalog; restore only the layout
    // stress data after closing it (preferences still use the real Server DB).
    await page.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      store.sessionProjects = Array.from({ length: 30 }, (_, index) => ({ id: 'layout-project-' + index, name: 'Long project title ' + index, members: [] }));
      store.sessionCatalog = Array.from({ length: 40 }, (_, index) => ({
        catalogKey: 'layout-session-' + index, runtimeProvider: 'yeaft', title: 'Recent session ' + index,
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'layout-session-' + index }, availability: 'online',
      }));
    }, mockAgent.agentId);
    await expect(compactToggle).toBeVisible();
    // A failed compact save is disclosed and rolled back too.
    await page.route('**/api/user/preferences', route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, body: '{}' }) : route.continue());
    await compactToggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.sidebar-preferences-error')).toBeVisible();
    await expect(shortcuts).not.toHaveClass(/is-compact/);
    await expect(compactToggle).toBeFocused();
    await page.unroute('**/api/user/preferences');

    // A failed write must be disclosed and rolled back, not look synchronized.
    await page.route('**/api/user/preferences', route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, body: '{}' }) : route.continue());
    await handle.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.sidebar-preferences-error')).toBeVisible();
    await expect(handle).toHaveAttribute('aria-valuenow', '68');
    await page.unroute('**/api/user/preferences');

    const toggles = page.locator('.sidebar-section-toggle');
    await toggles.nth(1).click();
    await expect(handle).toHaveCount(0);
    expect(await readRatio(page)).toBeGreaterThan(0.85);
    await toggles.nth(1).click();
    await expect(handle).toHaveAttribute('aria-valuenow', '68');
    await toggles.nth(0).click();
    await expect(handle).toHaveCount(0);
    expect(await readRatio(page)).toBeLessThan(0.15);
    await toggles.nth(0).click();
    await handle.dblclick();
    await expect(handle).toHaveAttribute('aria-valuenow', '50');
    await expect.poll(async () => (await (await page.request.get(serverUrl + '/api/user/preferences')).json()).sidebarProjectsRatio).toBe(0.5);
    await page.reload();
    await expect(handle).toHaveAttribute('aria-disabled', 'false');
    await expect(handle).toHaveAttribute('aria-valuenow', '50');
    expect(await readRatio(page)).toBeCloseTo(0.5, 2);

    // Saved desktop ratio must not force a fixed split or handle on mobile.
    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator('.header-sidebar-toggle').click();
    await expect(page.locator('.sidebar-navigation')).toBeVisible();
    await expect(handle).not.toBeVisible();
    // Reload above deliberately cleared the store-only stress fixture.
    await page.evaluate(agentId => {
      window.Pinia.useChatStore().sessionCatalog = Array.from({ length: 40 }, (_, index) => ({
        catalogKey: 'mobile-session-' + index, runtimeProvider: 'yeaft', title: 'Recent session ' + index,
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'mobile-session-' + index }, availability: 'online',
      }));
    }, mockAgent.agentId);
    await expect(compactToggle).toBeVisible();
    await compactToggle.click();
    await expect(shortcuts).toHaveClass(/is-compact/);
    expect(await compactToggle.evaluate(el => {
      const box = el.getBoundingClientRect();
      const area = el.parentElement;
      return box.top >= 0 && box.bottom <= innerHeight
        && Math.abs(area.getBoundingClientRect().right - parseFloat(getComputedStyle(area).paddingRight) - box.right) < 1;
    })).toBe(true);
    await expect(page.locator('.recents-section .sidebar-recents-task-create')).toBeVisible();
    expect(await page.locator('.sidebar-section-heading').evaluateAll(headings => headings.every(el => {
      const box = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth && box.right <= innerWidth;
    }))).toBe(true);
    await expect.poll(async () => (await (await page.request.get(serverUrl + '/api/user/preferences')).json()).sidebarActionsCompact).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('sidebar-mobile-compact.png') });
    await page.reload();
    await page.locator('.header-sidebar-toggle').click();
    await expect(shortcuts).toHaveClass(/is-compact/);
    await compactToggle.click();
    await expect(shortcuts).not.toHaveClass(/is-compact/);
    await page.screenshot({ path: testInfo.outputPath('sidebar-mobile.png') });
    for (const height of [460, 350, 300]) {
      await page.setViewportSize({ width: 1400, height });
      await expect(handle).toBeVisible();
      for (const key of ['Home', 'End']) {
        await handle.focus();
        await page.keyboard.press(key);
        const geometry = await page.locator('.sidebar-session-results').evaluate(el => {
          const projects = el.querySelector('.projects-section').getBoundingClientRect();
          const recents = el.querySelector('.recents-section').getBoundingClientRect();
          const bounds = el.getBoundingClientRect();
          el.scrollTop = el.scrollHeight;
          return { height: el.clientHeight, filled: projects.height + recents.height + 10,
            overflow: recents.bottom - bounds.bottom, reachable: el.scrollTop > 0 };
        });
        if (geometry.height >= 106) expect(geometry.filled).toBeCloseTo(geometry.height, 0);
        else expect(geometry.reachable).toBe(true);
        if (geometry.height >= 106) expect(geometry.overflow).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: testInfo.outputPath('sidebar-short-' + height + '.png') });
    }
  });
}
