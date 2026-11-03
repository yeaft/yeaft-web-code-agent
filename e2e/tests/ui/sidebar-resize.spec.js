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

    // A genuinely separate browser context, no copied localStorage/cookies.
    const device = await browser.newContext({ viewport: { width: 1200, height: 700 } });
    try {
      const other = await device.newPage();
      await open(other, serverUrl, theme);
      await expect(other.locator('.sidebar-section-resize-handle')).toHaveAttribute('aria-valuenow', '70');
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
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(handle).toHaveAttribute('aria-valuenow', '68');
      expect(await readRatio(page)).toBeCloseTo(0.68, 2);
    } finally { await device.close(); }

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
