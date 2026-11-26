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

    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['session_auto_route', 'work_center', 'session_scenes', 'plaintext-ok'] });
    // Wait for real WebSocket + mockAgent handshake before seeding multi-planet test fixture
    await page.waitForFunction((agentId) => {
      const chat = window.Pinia?.useChatStore?.();
      return Boolean(chat && (chat.agents || []).some(a => a.id === agentId && a.online && a.capabilities?.includes('session_auto_route')));
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

    // Send through the real Web -> Server WebSocket; a receipt, not routing alone,
    // is what clears the draft. The Agent integration test asserts next-loop consumption.
    const quickComposer = page.locator('.cosmos-quick-composer');
    const draft = quickComposer.locator('textarea');
    const followUp = 'Also test on mobile before finishing';
    await draft.fill(followUp);
    await quickComposer.getByRole('button', { name: /^(Send|发送)$/ }).click();
    const send = await mockAgent.waitForMessage('yeaft_auto_route_send');
    expect(send.text).toBe(followUp);
    expect(send.quickSend).toBeUndefined();
    await expect(draft).toHaveValue(followUp);
    mockAgent.send({ type: 'yeaft_session_routed', ok: true, requestId: send.requestId,
      clientMessageId: send.id, _requestClientId: send._requestClientId,
      sessionId: 'sess-earth-1', title: 'Planetary Shader Polish', decision: 'matched', tier: 'running', delivery: 'appended' });
    await expect(quickComposer.locator('.cosmos-quick-status')).toContainText(/Added to the running turn|已补充到/);
    await expect(draft).toHaveValue('');

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
        { id: agentId, name: 'MacBook-Pro', online: true, status: 'ready', workDir: '/Users/dev/yeaft', capabilities: ['session_auto_route'] },
        { id: 'z-saturn-node', name: 'Cloud-Linux', online: true, status: 'ready', workDir: '/srv/prod', capabilities: ['session_auto_route'] },
      ];
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
