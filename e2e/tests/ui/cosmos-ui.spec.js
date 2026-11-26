import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

// Exercise genuine first-run default Cosmos landing (uiMode: null omits classic pre-seed).
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' }, uiMode: null });

test.describe('Yeaft Cosmos UI', () => {
  test('renders Cosmos by default, routes planet click to Quick Auto-Route, opens translucent planetary drawer on session click, controls random events, and toggles Classic UI cleanly', async ({ page, serverUrl, mockAgent }) => {
    test.setTimeout(60000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

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
          capabilities: ['session_auto_route', 'work_center', 'session_scenes'],
        },
        {
          id: 'z-agent-cloud',
          name: 'Cloud-Linux',
          online: true,
          status: 'ready',
          workDir: '/srv/yeaft-prod',
          capabilities: ['session_auto_route', 'work_center'],
        },
      ];
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
          catalogKey: 'yeaft:z-agent-cloud:sess-saturn-1',
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId: 'z-agent-cloud', sessionId: 'sess-saturn-1' },
          title: 'Production Release Guard',
          workDir: '/srv/yeaft-prod',
          availability: 'online',
          createdAt: new Date(now - 7200000).toISOString(),
          metadataUpdatedAt: new Date(now - 10000).toISOString(),
          sortRank: 1,
        },
      ], []);
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
    // Verify removed redundant elements (no session pill strip, no dashed meta bar)
    await expect(page.locator('.ap-session-strip')).toHaveCount(0);
    await expect(page.locator('.conv-meta-strip')).toHaveCount(0);

    // Toggle embedded sidebar history via top-left ☰ button
    await page.locator('.cosmos-drawer-head-left .cosmos-icon-btn').first().click();
    await expect(page.locator('.cosmos-history-drawer')).toBeVisible();
    await page.locator('.cosmos-drawer-head-left .cosmos-icon-btn').first().click();
    await expect(page.locator('.cosmos-history-drawer')).toHaveCount(0);

    // Close drawer via Escape
    await page.keyboard.press('Escape');
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);

    // 3. Hover planet -> click specific session -> opens right planetary drawer
    const saturnTag = page.locator('.cosmos-planet-node[data-planet-id="saturn"] .cosmos-planet-tag');
    await expect(saturnTag).toBeVisible();
    await hoverOrbiting(saturnTag);
    await expect(page.locator('.cosmos-hover-card')).toBeVisible();
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

    expect(errors).toEqual([]);
  });
});
