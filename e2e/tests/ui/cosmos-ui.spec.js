import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

// Exercise genuine first-run default Cosmos landing (uiMode: null omits classic pre-seed).
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' }, uiMode: null });

test.describe('Yeaft Cosmos UI', () => {
  test('renders Cosmos by default, routes planet click to Quick Auto-Route, opens translucent planetary drawer on session click, controls random events, and toggles Classic UI cleanly', async ({ page, serverUrl, mockAgent }) => {
    test.setTimeout(90000);
    const errors = [];
    const failedAssets = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('response', (res) => {
      if (res.url().includes('/assets/cosmos/') && res.status() >= 400) {
        failedAssets.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto(serverUrl);
    await expect(page.locator('.cosmos-page')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.cosmos-gl-canvas')).toBeVisible();

    // Wait for real WebSocket + mockAgent handshake before seeding multi-planet test fixture
    await page.waitForFunction((agentId) => {
      const chat = window.Pinia?.useChatStore?.();
      return Boolean(chat && (chat.agents || []).some((a) => a.id === agentId && a.online === true));
    }, mockAgent.agentId, { timeout: 15000 });

    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      const now = Date.now();
      chat.agents = [
        {
          id: agentId,
          name: 'MacBook-Pro',
          online: true,
          status: 'ready',
          workDir: '/Users/dev/yeaft',
          capabilities: ['session_auto_route', 'work_center', 'session_scenes', 'workbench_session_routes', 'terminal', 'file_editor'],
        },
        {
          id: 'z-agent-cloud',
          name: 'Cloud-Linux',
          online: true,
          status: 'ready',
          workDir: '/srv/yeaft-prod',
          capabilities: ['session_auto_route', 'work_center', 'workbench_session_routes', 'terminal', 'file_editor'],
        },
      ];
      chat.workbenchRouteProtocolSupported = true;
      chat.currentAgent = agentId;
      chat.yeaftAvailableModels = [
        { id: 'copilot/gpt-6.2-sol', label: 'gpt-6.2-sol', provider: 'copilot', effortOptions: ['medium', 'high', 'xhigh'] },
      ];
      chat.yeaftModel = 'copilot/gpt-6.2-sol';
      chat.yeaftModelEffort = 'high';
      chat.applySessionCatalogSnapshot([
        {
          catalogKey: `yeaft:${agentId}:sess-earth-1`,
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'sess-earth-1' },
          title: 'Planetary Shader Polish',
          workDir: '/Users/dev/yeaft',
          availability: 'online',
          createdAt: new Date(now - 3600000).toISOString(),
          metadataUpdatedAt: new Date(now - 20000).toISOString(),
          sortRank: 0,
        },
        {
          catalogKey: `yeaft:${agentId}:sess-earth-2`,
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'sess-earth-2' },
          title: 'Quick Scratchpad',
          workDir: '/Users/dev/yeaft',
          availability: 'online',
          createdAt: new Date(now - 5400000).toISOString(),
          metadataUpdatedAt: new Date(now - 50000).toISOString(),
          sortRank: 1,
        },
        {
          catalogKey: 'yeaft:z-agent-cloud:sess-saturn-1',
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId: 'z-agent-cloud', sessionId: 'sess-saturn-1' },
          title: 'Production Release Guard',
          workDir: '/srv/yeaft-prod',
          availability: 'online',
          createdAt: new Date(now - 7200000).toISOString(),
          metadataUpdatedAt: new Date(now - 10000).toISOString(),
          sortRank: 2,
        },
      ], [
        {
          id: 'proj-yeaft',
          name: 'Yeaft',
          parentId: null,
          sortOrder: 0,
          members: [{ agentId, sessionId: 'sess-earth-1' }],
        },
        {
          id: 'proj-ops',
          name: 'Ops',
          parentId: null,
          sortOrder: 1,
          members: [{ agentId: 'z-agent-cloud', sessionId: 'sess-saturn-1' }],
        },
      ]);
      chat.yeaftProcessingSessions = { [`${agentId}\u001fsess-earth-1`]: true };
      const convId = `yeaft_${agentId}`;
      chat.yeaftConversationIdsByAgent = { ...(chat.yeaftConversationIdsByAgent || {}), [agentId]: convId };
      chat.messagesMap[convId] = [
        { id: 'm1', type: 'user', sessionId: 'sess-earth-1', content: 'Optimize procedural Earth and Saturn rings.', timestamp: now - 40000 },
        { id: 'm2', type: 'tool-use', sessionId: 'sess-earth-1', toolName: 'FileEdit', toolInput: { file_path: 'web/cosmos/shaders-bodies.js' }, timestamp: now - 35000 },
        { id: 'm3', type: 'assistant', sessionId: 'sess-earth-1', content: 'Procedural textures and ray-traced lighting are live with zero external image downloads.', timestamp: now - 15000 },
      ];
    }, mockAgent.agentId);

    // Wait for planet nodes to bind and render
    const earthTag = page.locator('.cosmos-planet-node[data-planet-id="earth"] .cosmos-planet-tag');
    await expect(earthTag).toContainText('MacBook-Pro', { timeout: 5000 });

    // Helper: planets gently orbit in real time, so click/hover at current screen center
    async function clickOrbiting(locator) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    async function hoverOrbiting(locator) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }

    // 1. Clicking a planet opens Quick Auto-Route Composer (NOT right drawer)
    await clickOrbiting(earthTag);
    await expect(page.locator('.cosmos-quick-composer')).toBeVisible();
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);
    await expect(page.locator('.cosmos-quick-open-btn')).toBeVisible();

    // 2. Clicking "Open Chat" (or a live micro-list session) opens the right translucent planetary drawer
    await page.locator('.cosmos-quick-open-btn').click();
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    await expect(page.locator('.cosmos-drawer')).toHaveAttribute('data-planet-theme', 'earth');
    // Verify Project chip appears in header subtitle
    await expect(page.locator('.cosmos-drawer-project-chip')).toContainText('Yeaft');
    // Verify removed redundant elements (no session pill strip, no dashed meta bar)
    await expect(page.locator('.ap-session-strip')).toHaveCount(0);
    await expect(page.locator('.conv-meta-strip')).toHaveCount(0);

    // Verify user message outer wrapper is transparent (no nested double-box background)
    const userMsgBg = await page.locator('.cosmos-drawer .message.user').first().evaluate((el) => {
      const outer = getComputedStyle(el);
      const inner = el.querySelector('.message-user-block') ? getComputedStyle(el.querySelector('.message-user-block')) : null;
      return { outerBg: outer.backgroundColor, outerBorder: outer.borderTopWidth, innerBg: inner?.backgroundColor || '' };
    });
    expect(userMsgBg.outerBg).toBe('rgba(0, 0, 0, 0)');
    expect(userMsgBg.outerBorder).toBe('0px');
    expect(userMsgBg.innerBg).not.toBe('rgba(0, 0, 0, 0)');

    // Open real Workbench inside Cosmos drawer and verify launcher, Add menu positioning, maximize & 2-step Escape under both themes
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.locator('.cosmos-drawer').getByRole('button', { name: /workbench/i }).click();
    const wbHost = page.locator('.cosmos-workbench-host');
    await expect(wbHost).toBeVisible();
    await expect(wbHost.locator('.workbench-content')).toBeVisible();
    await expect(wbHost.locator('.workbench-capability-card').first()).toBeVisible();

    // Open a capability, then open Workbench Add (+) menu and assert it stays inside .cosmos-workbench-host (not shifted offscreen by backdrop-filter!)
    await wbHost.locator('.workbench-capability-card[data-workbench-capability="browser"]').click();
    const addBtn = wbHost.locator('.workbench-add-btn');
    await addBtn.click();
    const addMenu = wbHost.locator('.workbench-add-menu');
    await expect(addMenu).toBeVisible();
    const [hostBox, addMenuBox] = await Promise.all([wbHost.boundingBox(), addMenu.boundingBox()]);
    expect(hostBox).not.toBeNull();
    expect(addMenuBox).not.toBeNull();
    expect(addMenuBox.x).toBeGreaterThanOrEqual(hostBox.x - 1);
    expect(addMenuBox.x + addMenuBox.width).toBeLessThanOrEqual(hostBox.x + hostBox.width + 1);
    expect(addMenuBox.y).toBeGreaterThanOrEqual(hostBox.y - 1);
    expect(addMenuBox.y + addMenuBox.height).toBeLessThanOrEqual(hostBox.y + hostBox.height + 1);

    // 1st Escape closes the Add menu and restores focus to the Add button while keeping Workbench open
    await page.keyboard.press('Escape');
    await expect(addMenu).toHaveCount(0);
    await expect(wbHost).toBeVisible();
    await expect(addBtn).toBeFocused();

    // Click an item inside Add menu to prove it is genuinely clickable in the docked drawer
    await addBtn.click();
    await expect(addMenu).toBeVisible();
    await addMenu.locator('[data-workbench-capability="files"]').click();
    await expect(wbHost.locator('.workbench-item-tab[data-workbench-item-id="files"]')).toBeVisible();

    // Right-click tab context menu stays strictly inside .cosmos-workbench-host bounds
    // AND 1st Escape dismisses the tab context menu & restores tab focus without collapsing Workbench
    const filesTab = wbHost.locator('.workbench-item-tab[data-workbench-item-id="files"]');
    await filesTab.click({ button: 'right' });
    const tabCtx = wbHost.locator('.workbench-tab-context-menu');
    await expect(tabCtx).toBeVisible();
    const tabCtxBox = await tabCtx.boundingBox();
    expect(tabCtxBox).not.toBeNull();
    expect(tabCtxBox.x).toBeGreaterThanOrEqual(hostBox.x - 1);
    expect(tabCtxBox.x + tabCtxBox.width).toBeLessThanOrEqual(hostBox.x + hostBox.width + 1);
    await page.keyboard.press('Escape');
    await expect(tabCtx).toHaveCount(0);
    await expect(wbHost).toBeVisible();
    await expect(filesTab.locator('.workbench-item-select')).toBeFocused();

    // Open Tabs overflow menu in a short host (with ☰ history drawer open above Workbench)
    // must stay bounded inside .cosmos-workbench-host and keep the final overflow tab reachable via scroll.
    await page.locator('.cosmos-drawer-head-left .cosmos-icon-btn').first().click();
    await expect(page.locator('.cosmos-history-drawer')).toBeVisible();
    await page.evaluate(async () => {
      const { workbenchRouteKey, workbenchWorkspaceGeneration } = await import('/utils/workbench-route.js');
      const chat = window.Pinia.useChatStore();
      const routeKey = workbenchRouteKey(chat.activeSessionRoute);
      const workDir = chat.effectiveWorkDir || '';
      const workspaceGeneration = workbenchWorkspaceGeneration(routeKey, workDir);
      const files = Array.from({ length: 14 }, (_, idx) => ({
        path: `${workDir || '/Users/dev/yeaft'}/module-${String(idx + 1).padStart(2, '0')}.js`,
        name: `module-${String(idx + 1).padStart(2, '0')}.js`,
        isDirty: false,
      }));
      window.dispatchEvent(new CustomEvent('workbench-file-items-changed', {
        detail: { routeKey, workspaceGeneration, files, activePath: files[0].path },
      }));
    });
    const openItemsBtn = wbHost.locator('.workbench-open-items-btn');
    await expect(openItemsBtn).toBeVisible();
    await openItemsBtn.click();
    const openItemsMenu = wbHost.locator('.workbench-open-items-menu');
    await expect(openItemsMenu).toBeVisible();
    const [shortHostBox, openMenuBox] = await Promise.all([wbHost.boundingBox(), openItemsMenu.boundingBox()]);
    expect(shortHostBox).not.toBeNull();
    expect(openMenuBox).not.toBeNull();
    expect(openMenuBox.y).toBeGreaterThanOrEqual(shortHostBox.y - 1);
    expect(openMenuBox.y + openMenuBox.height).toBeLessThanOrEqual(shortHostBox.y + shortHostBox.height + 1);
    const lastOverflowItem = openItemsMenu.locator('.workbench-menu-item').last();
    await lastOverflowItem.scrollIntoViewIfNeeded();
    await expect(lastOverflowItem).toBeVisible();
    // 1st Escape closes Open Tabs menu and restores focus to Open Tabs trigger
    await page.keyboard.press('Escape');
    await expect(openItemsMenu).toHaveCount(0);
    await expect(wbHost).toBeVisible();
    await expect(openItemsBtn).toBeFocused();
    // Close ☰ history drawer before maximize check
    await page.locator('.cosmos-drawer-head-left .cosmos-icon-btn').first().click();
    await expect(page.locator('.cosmos-history-drawer')).toHaveCount(0);

    // Workbench maximize expands the Cosmos drawer cleanly and restores
    const initialDrawerW = (await page.locator('.cosmos-drawer').boundingBox()).width;
    await wbHost.locator('.workbench-maximize-btn').click();
    await expect(page.locator('.cosmos-page')).toHaveClass(/is-workbench-maximized/);
    await expect(async () => {
      const widenedW = (await page.locator('.cosmos-drawer').boundingBox()).width;
      expect(widenedW).toBeGreaterThan(initialDrawerW + 120);
    }).toPass({ timeout: 2000 });
    await wbHost.locator('.workbench-maximize-btn').click();
    await expect(page.locator('.cosmos-page')).not.toHaveClass(/is-workbench-maximized/);

    // 2nd Escape (with no menu open) collapses Workbench while keeping the drawer open
    await page.keyboard.press('Escape');
    await expect(wbHost).toBeHidden();
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    // Toggle embedded sidebar history via top-left ☰ button: verify Project tree & current-Agent-only Session search
    await page.locator('.cosmos-drawer-head-left .cosmos-icon-btn').first().click();
    await expect(page.locator('.cosmos-history-drawer')).toBeVisible();
    await expect(page.locator('.cosmos-history-folder-name').first()).toContainText('Yeaft');
    // Current planet session matches cleanly
    await page.locator('.cosmos-history-search-input').fill('Scratchpad');
    await expect(page.locator('.cosmos-history-search-hit')).toHaveCount(1);
    await expect(page.locator('.cosmos-history-search-hit').first()).toContainText('Quick Scratchpad');
    // Other planet session MUST NOT appear (strictly current Agent search)
    await page.locator('.cosmos-history-search-input').fill('Ops');
    await expect(page.locator('.cosmos-history-search-hit')).toHaveCount(0);
    await page.locator('.cosmos-history-search-clear').click();
    await page.locator('.cosmos-drawer-head-left .cosmos-icon-btn').first().click();
    await expect(page.locator('.cosmos-history-drawer')).toHaveCount(0);

    // Close drawer via Escape
    await page.keyboard.press('Escape');
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);

    // 3. Hover planet -> click specific session -> opens right planetary drawer
    // Note: after closing the drawer, camera centerShiftX smoothly lerps back,
    // so track Saturn's live screen position until the hover card opens.
    const saturnTag = page.locator('.cosmos-planet-node[data-planet-id="saturn"] .cosmos-planet-tag');
    await expect(saturnTag).toBeVisible();
    await expect(async () => {
      await hoverOrbiting(saturnTag);
      await expect(page.locator('.cosmos-hover-card')).toBeVisible({ timeout: 600 });
    }).toPass({ timeout: 8000 });
    await page.locator('.cosmos-hover-row').first().click();
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    await expect(page.locator('.cosmos-drawer')).toHaveAttribute('data-planet-theme', 'saturn');
    await page.keyboard.press('Escape');

    // 4. Cosmic Event: open almanac, observe Supernova, then STOP immediately
    await page.locator('.cosmos-event-main').click();
    await expect(page.locator('.cosmos-event-almanac')).toBeVisible();
    await page.locator('.cosmos-almanac-row').first().click();
    await expect(page.locator('.cosmos-watch-dock')).toBeVisible();
    await page.locator('.cosmos-watch-dock .cosmos-ewd-btn.is-stop').click();
    await expect(page.locator('.cosmos-watch-dock')).toHaveCount(0);

    // Silence automatic random cosmic events via stop button
    await page.locator('.cosmos-event-stop-btn').click();
    await expect(page.locator('.cosmos-event-pill')).toHaveClass(/is-auto-off/);

    // 5. Cosmic Constants popover exposes authentic Yeaft Settings modal
    await page.locator('.cosmos-corner-actions .cosmos-corner-icon').first().click();
    await expect(page.locator('.cosmos-constants-popover')).toBeVisible();
    await page.locator('.cosmos-cfg-item').first().click();
    await expect(page.locator('.settings-dialog')).toBeVisible();
    await page.locator('.settings-close').click();
    await expect(page.locator('.settings-dialog')).toHaveCount(0);

    // 6. Scale switching to Galaxy -> Cosmic Web -> Event Horizon -> Solar
    await page.locator('.cosmos-scale-tick').nth(1).click();
    await expect(page.locator('.cosmos-corner-dock')).toBeVisible({ timeout: 5000 });
    await page.locator('.cosmos-scale-tick').nth(3).click();
    await expect(page.locator('.cosmos-whisper-note')).toBeVisible({ timeout: 5000 });
    await page.locator('.cosmos-scale-tick').nth(2).click();

    // 7. Abandon Cosmos -> classic Yeaft UI unchanged, persists on reload, and ✦ re-enters Cosmos
    await page.locator('.cosmos-corner-icon.is-abandon').click();
    await expect(page.locator('.cosmos-page')).toHaveCount(0);
    await expect(page.locator('.yeaft-page, .chat-page').first()).toBeVisible({ timeout: 8000 });

    await page.reload();
    await expect(page.locator('.yeaft-page, .chat-page').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.cosmos-page')).toHaveCount(0);

    await page.locator('.sidebar-cosmos-btn').click();
    await expect(page.locator('.cosmos-page')).toBeVisible({ timeout: 8000 });

    expect(failedAssets).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('fits all planets cleanly in 390x844 mobile portrait mode and switches cleanly between 2D Eco and Ultra 3D WebGL', async ({ page, serverUrl, mockAgent }) => {
    test.setTimeout(90000);
    const errors = [];
    const failedAssets = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('response', (res) => {
      if (res.url().includes('/assets/cosmos/') && res.status() >= 400) {
        failedAssets.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(serverUrl);
    await expect(page.locator('.cosmos-page')).toBeVisible({ timeout: 15000 });

    await page.waitForFunction((agentId) => {
      const chat = window.Pinia?.useChatStore?.();
      return Boolean(chat && (chat.agents || []).some((a) => a.id === agentId && a.online === true));
    }, mockAgent.agentId, { timeout: 15000 });

    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      chat.agents = [
        { id: agentId, name: 'MacBook-Pro', online: true, status: 'ready', workDir: '/Users/dev/yeaft', capabilities: ['session_auto_route', 'workbench_session_routes', 'terminal', 'file_editor'] },
        { id: 'z-saturn-node', name: 'Cloud-Linux', online: true, status: 'ready', workDir: '/srv/prod', capabilities: ['session_auto_route'] },
      ];
      chat.workbenchRouteProtocolSupported = true;
      chat.applySessionCatalogSnapshot([
        {
          catalogKey: `yeaft:${agentId}:sess-mobile-1`,
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'sess-mobile-1' },
          title: 'Mobile Workbench Check',
          workDir: '/Users/dev/yeaft',
          availability: 'online',
          metadataUpdatedAt: new Date().toISOString(),
          sortRank: 0,
        },
      ], []);
    }, mockAgent.agentId);

    const earthNode = page.locator('.cosmos-planet-node[data-planet-id="earth"]');
    const saturnNode = page.locator('.cosmos-planet-node[data-planet-id="saturn"]');
    await expect(earthNode.locator('.cosmos-planet-tag')).toContainText('MacBook-Pro', { timeout: 5000 });
    await expect(saturnNode.locator('.cosmos-planet-tag')).toContainText('Cloud-Linux', { timeout: 5000 });

    // Verify both inner (Earth) and outer (Saturn) planets stay within the 390px phone viewport
    const saturnBox = await saturnNode.locator('.cosmos-planet-tag').boundingBox();
    expect(saturnBox).not.toBeNull();
    expect(saturnBox.x).toBeGreaterThanOrEqual(0);
    expect(saturnBox.x + saturnBox.width).toBeLessThanOrEqual(392);

    // Click Earth tag -> opens Quick Composer -> Open Chat -> full-screen drawer
    const earthTagBox = await earthNode.locator('.cosmos-planet-tag').boundingBox();
    expect(earthTagBox).not.toBeNull();
    await page.mouse.click(earthTagBox.x + earthTagBox.width / 2, earthTagBox.y + earthTagBox.height / 2);
    await expect(page.locator('.cosmos-quick-composer')).toBeVisible();
    await page.locator('.cosmos-quick-open-btn').click();
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    // Open Workbench on 390px phone and verify Add (+) menu stays inside 390px viewport
    await page.locator('.cosmos-drawer').getByRole('button', { name: /workbench/i }).click();
    const mobileWbHost = page.locator('.cosmos-workbench-host');
    await expect(mobileWbHost).toBeVisible();
    await mobileWbHost.locator('.workbench-add-btn').click();
    const mobileMenuBox = await mobileWbHost.locator('.workbench-add-menu').boundingBox();
    expect(mobileMenuBox).not.toBeNull();
    expect(mobileMenuBox.x).toBeGreaterThanOrEqual(0);
    expect(mobileMenuBox.x + mobileMenuBox.width).toBeLessThanOrEqual(390);
    await mobileWbHost.locator('.workbench-panel-close').click();
    await expect(mobileWbHost).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);

    // Switch renderer between Ultra 3D WebGL and 2D Eco cleanly inside Cosmic Constants
    await page.locator('.cosmos-corner-actions .cosmos-corner-icon').first().click();
    await expect(page.locator('.cosmos-constants-popover')).toBeVisible();
    const rendererSelect = page.locator('.cosmos-constants-popover .cosmos-const-select').nth(1);
    await rendererSelect.selectOption('high');
    await expect(page.locator('.cosmos-const-engine-badge')).toContainText(/WebGL/i, { timeout: 5000 });
    await rendererSelect.selectOption('lite');
    await expect(page.locator('.cosmos-const-engine-badge')).toContainText(/2D/i, { timeout: 5000 });

    expect(failedAssets).toEqual([]);
    expect(errors).toEqual([]);
  });
});
