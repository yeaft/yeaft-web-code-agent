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
          capabilities: ['session_auto_route', 'work_center', 'session_scenes', 'session_scene_frontend', 'workbench_session_routes', 'terminal', 'file_editor'],
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
      chat.llmConfig = {
        ...(chat.llmConfig || {}),
        [agentId]: {
          agentConfig: {
            primaryModel: 'copilot/gpt-6.2-sol',
            defaultEffort: 'high',
            availableModels: chat.yeaftAvailableModels,
          },
        },
      };
      const sessionsStore = window.Pinia.useSessionsStore?.();
      sessionsStore?.applySnapshotUpsert?.({
        id: 'sess-earth-1',
        name: 'Planetary Shader Polish',
        agentId,
        sceneId: 'general',
        roster: [{ id: 'vp-1' }],
      }, agentId);
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
      chat.waitingAnimation = 'cat';
      chat.chatHistoryConnectionGeneration = chat.chatHistoryConnectionGeneration || 1;
      const convId = `yeaft_${agentId}`;
      chat.yeaftConversationIdsByAgent = { ...(chat.yeaftConversationIdsByAgent || {}), [agentId]: convId };
      chat.yeaftSessionTurnsBySession = {
        [`${agentId}\u001fsess-earth-1`]: {
          connectionGeneration: chat.chatHistoryConnectionGeneration,
          conversationId: convId,
          turns: [{
            userTurnId: 'ut-earth-1',
            userMessageId: 'm1',
            state: 'running',
            startedAt: now - 12000,
            executions: [{ vpId: 'vp-1', turnId: 'turn-earth-1', threadId: 'th-1', state: 'running' }],
          }],
        },
      };
      chat.activeVpTurns = {
        [`${agentId}\u001fturn-earth-1`]: {
          agentId,
          sessionId: 'sess-earth-1',
          vpId: 'vp-1',
          turnId: 'turn-earth-1',
          threadId: 'th-1',
          userTurnId: 'ut-earth-1',
          conversationId: convId,
          connectionGeneration: chat.chatHistoryConnectionGeneration,
          startedAt: now - 12000,
        },
      };
      chat.yeaftActiveTasksBySession = {
        [`${agentId}\u001fsess-earth-1`]: {
          'bg-task-1': {
            id: 'bg-task-1',
            agentId,
            sessionId: 'sess-earth-1',
            kind: 'sub_agent',
            status: 'running',
            title: 'shader-audit',
            startedAt: new Date(now - 5000).toISOString(),
            updatedAt: new Date(now - 1000).toISOString(),
          },
        },
      };
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

    // Verify unified tuning popover opens strictly ABOVE the Quick Composer without stretching its height,
    // uses localized scene names (never raw English keys), and 1st Escape dismisses ONLY the popover.
    const quickComposer = page.locator('.cosmos-quick-composer');
    await quickComposer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).catch(() => {}));
    const quickLayoutBefore = await quickComposer.evaluate((el) => el.offsetHeight);
    const quickTuneTrigger = quickComposer.locator('.cosmos-tune-trigger');
    await expect(quickTuneTrigger).toBeVisible();
    await quickTuneTrigger.click();
    const quickTunePopover = quickComposer.locator('.cosmos-tune-popover');
    await expect(quickTunePopover).toBeVisible();
    await quickTunePopover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).catch(() => {}));
    const [quickLayoutAfter, quickBoxAfter, quickPopBox] = await Promise.all([
      quickComposer.evaluate((el) => el.offsetHeight),
      quickComposer.boundingBox(),
      quickTunePopover.boundingBox(),
    ]);
    expect(quickBoxAfter).not.toBeNull();
    expect(quickPopBox).not.toBeNull();
    expect(quickLayoutAfter).toBe(quickLayoutBefore);
    expect(quickPopBox.y + quickPopBox.height).toBeLessThanOrEqual(quickBoxAfter.y + 1);
    expect(quickPopBox.x).toBeGreaterThanOrEqual(quickBoxAfter.x - 1);
    expect(quickPopBox.x + quickPopBox.width).toBeLessThanOrEqual(quickBoxAfter.x + quickBoxAfter.width + 1);
    const quickSceneTexts = await quickTunePopover.locator('.cosmos-tune-chip').allTextContents();
    expect(quickSceneTexts.length).toBeGreaterThanOrEqual(4);
    expect(quickSceneTexts).not.toContain('short-video');
    expect(quickSceneTexts).not.toContain('primary-education');
    await page.keyboard.press('Escape');
    await expect(quickTunePopover).toHaveCount(0);
    await expect(quickComposer).toBeVisible();
    await expect(quickTuneTrigger).toBeFocused();

    // Send through the real Web -> Server WebSocket; a receipt, not routing alone,
    // is what clears the draft. The Agent integration test asserts next-loop consumption.
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
    // Verify Project chip appears in header subtitle
    await expect(page.locator('.cosmos-drawer-project-chip')).toContainText('Yeaft');
    // Verify removed redundant elements (no session pill strip, no dashed meta bar, NO header create-session icon, NO waiting cat animation)
    await expect(page.locator('.ap-session-strip')).toHaveCount(0);
    await expect(page.locator('.conv-meta-strip')).toHaveCount(0);
    await expect(page.locator('.cosmos-drawer-head button[aria-label*="New session"], .cosmos-drawer-head button[aria-label*="新建会话"]')).toHaveCount(0);
    await expect(page.locator('.cosmos-drawer .typing-indicator')).toHaveCount(0);

    // Verify NO live Session Status strip renders above the drawer composer (even while running);
    // clicking the header Session Status toggle opens authentic Session Status overlay,
    // dragging the left optical resize handle widens the drawer & docks Session Status side-by-side,
    // 1st Escape dismisses Session Status (restoring toggle focus) without closing drawer, and dblclick resets width.
    await expect(page.locator('.cosmos-drawer .cosmos-status-strip')).toHaveCount(0);
    const statusToggle = page.locator('.cosmos-drawer .cosmos-session-status-btn');
    await expect(statusToggle).toBeVisible();
    await statusToggle.click();
    const statusHost = page.locator('.cosmos-drawer .cosmos-status-host');
    await expect(statusHost).toBeVisible();
    await expect(statusHost).toHaveClass(/is-overlay/);
    await expect(statusHost.locator('.yeaft-vp-timeline')).toBeVisible();
    await expect(statusHost).toContainText('shader-audit');
    await expect(page.locator('.cosmos-drawer-chat')).toHaveAttribute('inert', '');

    const drawerBeforeResize = (await page.locator('.cosmos-drawer').boundingBox()).width;
    const resizeHandle = page.locator('.cosmos-drawer-resize-handle');
    const handleBox = await resizeHandle.boundingBox();
    expect(handleBox).not.toBeNull();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 420, handleBox.y + handleBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(async () => {
      const afterW = (await page.locator('.cosmos-drawer').boundingBox()).width;
      expect(afterW).toBeGreaterThan(drawerBeforeResize + 280);
    }).toPass({ timeout: 2000 });
    // Wide drawer automatically docks Session Status side-by-side so chat becomes interactive again
    await expect(statusHost).toHaveClass(/is-docked/);
    await expect(page.locator('.cosmos-drawer-chat')).not.toHaveAttribute('inert', '');

    // Escape closes Session Status and restores focus to toggle button while keeping drawer open
    await page.keyboard.press('Escape');
    await expect(statusHost).toBeHidden();
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    await expect(page.locator('.cosmos-session-status-btn')).toBeFocused();

    // Double-click resize handle resets drawer width back to default
    const wideHandleBox = await resizeHandle.boundingBox();
    await page.mouse.dblclick(wideHandleBox.x + wideHandleBox.width / 2, wideHandleBox.y + wideHandleBox.height / 2);
    await expect(async () => {
      const resetW = (await page.locator('.cosmos-drawer').boundingBox()).width;
      expect(Math.abs(resetW - drawerBeforeResize)).toBeLessThanOrEqual(8);
    }).toPass({ timeout: 2000 });

    // Verify user message outer wrapper is transparent (no nested double-box background)
    const userMsgBg = await page.locator('.cosmos-drawer .message.user').first().evaluate((el) => {
      const outer = getComputedStyle(el);
      const inner = el.querySelector('.message-user-block') ? getComputedStyle(el.querySelector('.message-user-block')) : null;
      return { outerBg: outer.backgroundColor, outerBorder: outer.borderTopWidth, innerBg: inner?.backgroundColor || '', userSelect: outer.userSelect };
    });
    expect(userMsgBg.outerBg).toBe('rgba(0, 0, 0, 0)');
    expect(userMsgBg.outerBorder).toBe('0px');
    expect(userMsgBg.innerBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(userMsgBg.userSelect).not.toBe('none');

    // Verify conversation text is truly mouse-selectable & copyable (and dragging past left edge does NOT close drawer)
    const assistantMsg = page.locator('.cosmos-drawer').getByText('Procedural textures').first();
    await expect(assistantMsg).toBeVisible();
    const assistantUserSelect = await assistantMsg.evaluate((el) => getComputedStyle(el).userSelect);
    expect(assistantUserSelect).not.toBe('none');
    const textRangeBox = await assistantMsg.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.nodeValue || '').includes('Procedural textures')) {
          const r = document.createRange();
          r.selectNodeContents(node);
          const rect = r.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
        }
      }
      return null;
    });
    expect(textRangeBox).not.toBeNull();
    const drawerEdgeBox = await page.locator('.cosmos-drawer').boundingBox();
    const selY = textRangeBox.top + Math.min(textRangeBox.height / 2, 10);
    await page.mouse.move(textRangeBox.right - 4, selY);
    await page.mouse.down();
    await page.mouse.move(Math.max(4, drawerEdgeBox.x - 24), selY, { steps: 6 });
    await page.mouse.up();
    const selectedText = await page.evaluate(() => window.getSelection()?.toString() || '');
    expect(selectedText.length).toBeGreaterThan(8);
    expect(selectedText).toContain('Procedural');
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    const copiedOnEvent = await page.evaluate(() => {
      let copied = '';
      const onCopy = (ev) => {
        copied = window.getSelection()?.toString() || '';
        ev.clipboardData?.setData('text/plain', copied);
      };
      document.addEventListener('copy', onCopy, { once: true });
      document.execCommand('copy');
      return copied;
    });
    expect(copiedOnEvent).toContain('Procedural');
    await page.evaluate(() => window.getSelection()?.removeAllRanges?.());

    // Dragging the 3D stage outside the drawer applies transient .is-orbiting user-select guard and clears on release
    const emptyCanvasPt = await page.evaluate((maxX) => {
      const candidatesX = [Math.max(120, maxX - 80), Math.max(120, maxX - 180), Math.max(120, maxX - 280), 220];
      const candidatesY = [140, 220, 560, 620, 320];
      for (const y of candidatesY) {
        for (const x of candidatesX) {
          if (x >= maxX - 24) continue;
          const el = document.elementFromPoint(x, y);
          if (el && el.classList?.contains('cosmos-gl-canvas')) return { x, y };
        }
      }
      return null;
    }, drawerEdgeBox.x);
    expect(emptyCanvasPt).not.toBeNull();
    await page.mouse.move(emptyCanvasPt.x, emptyCanvasPt.y);
    await page.mouse.down();
    await expect(page.locator('.cosmos-page')).toHaveClass(/is-orbiting/);
    await page.mouse.move(Math.max(24, emptyCanvasPt.x - 40), emptyCanvasPt.y + 15, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator('.cosmos-page')).not.toHaveClass(/is-orbiting/);
    await expect(page.locator('.cosmos-drawer')).toBeVisible();

    // Verify Drawer unified tuning popover opens strictly ABOVE the Drawer Composer within Drawer bounds
    // (including top containment below header & localized Drawer scene chips), and 1st Escape dismisses ONLY the popover.
    const drawerComposer = page.locator('.cosmos-drawer .input-wrapper.chat-composer');
    const drawerTuneTrigger = page.locator('.cosmos-drawer .cosmos-tune-trigger');
    await expect(drawerTuneTrigger).toBeVisible();
    const drawerComposerHeightBefore = await drawerComposer.evaluate((el) => el.offsetHeight);
    await drawerTuneTrigger.click();
    const drawerTunePopover = page.locator('.cosmos-drawer .cosmos-tune-popover');
    await expect(drawerTunePopover).toBeVisible();
    await drawerTunePopover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).catch(() => {}));
    const drawerSceneTexts = await drawerTunePopover.locator('.cosmos-tune-chip').allTextContents();
    expect(drawerSceneTexts.length).toBeGreaterThanOrEqual(4);
    expect(drawerSceneTexts.some((t) => /^(Frontend|前端开发)$/.test(t.trim()))).toBe(true);
    const [drawerBox, drawerHeadBox, drawerComposerHeightAfter, drawerComposerBoxAfter, drawerPopBox] = await Promise.all([
      page.locator('.cosmos-drawer').boundingBox(),
      page.locator('.cosmos-drawer-head').boundingBox(),
      drawerComposer.evaluate((el) => el.offsetHeight),
      drawerComposer.boundingBox(),
      drawerTunePopover.boundingBox(),
    ]);
    expect(drawerComposerHeightAfter).toBe(drawerComposerHeightBefore);
    expect(drawerPopBox.y).toBeGreaterThanOrEqual(drawerHeadBox.y + drawerHeadBox.height - 1);
    expect(drawerPopBox.y + drawerPopBox.height).toBeLessThanOrEqual(drawerComposerBoxAfter.y + 1);
    expect(drawerPopBox.x).toBeGreaterThanOrEqual(drawerBox.x - 1);
    expect(drawerPopBox.x + drawerPopBox.width).toBeLessThanOrEqual(drawerBox.x + drawerBox.width + 1);
    await page.keyboard.press('Escape');
    await expect(drawerTunePopover).toHaveCount(0);
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    await expect(drawerTuneTrigger).toBeFocused();

    // Open real Workbench inside Cosmos drawer and verify chat becomes inert (cannot reopen tuning behind Workbench)
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.locator('.cosmos-drawer').getByRole('button', { name: /workbench/i }).click();
    const wbHost = page.locator('.cosmos-workbench-host');
    await expect(wbHost).toBeVisible();
    await expect(page.locator('.cosmos-drawer-chat')).toHaveAttribute('inert', '');
    await expect(page.locator('.cosmos-drawer .cosmos-tune-popover')).toHaveCount(0);
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

    // Right-click tab context menu -> clicking Add closes tab context menu mutually exclusively,
    // and Escape closes Add and restores focus to Add (NOT hijacked back to the tab).
    await wbHost.locator('.workbench-item-tab[data-workbench-item-id="browser"]').click({ button: 'right', position: { x: 8, y: 12 } });
    await expect(tabCtx).toBeVisible();
    await addBtn.click();
    await expect(tabCtx).toHaveCount(0);
    await expect(addMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(addMenu).toHaveCount(0);
    await expect(wbHost).toBeVisible();
    await expect(addBtn).toBeFocused();

    // Workbench maximize expands the Cosmos drawer cleanly; keep it maximized so fewer tabs overflow,
    // open Open Tabs menu, THEN shrink BOTH width (forcing extra overflow rows into the open menu)
    // AND height while open, asserting the menu gains rows, re-clamps strictly inside the host,
    // and keeps its final item reachable.
    const initialDrawerW = (await page.locator('.cosmos-drawer').boundingBox()).width;
    await wbHost.locator('.workbench-maximize-btn').click();
    await expect(page.locator('.cosmos-page')).toHaveClass(/is-workbench-maximized/);
    await expect(async () => {
      const widenedW = (await page.locator('.cosmos-drawer').boundingBox()).width;
      expect(widenedW).toBeGreaterThan(initialDrawerW + 120);
    }).toPass({ timeout: 2000 });
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
    const initialOverflowCount = await openItemsMenu.locator('.workbench-menu-item').count();
    expect(initialOverflowCount).toBeGreaterThan(0);

    // Shrink BOTH width (across tab overflow threshold) and height while Open Tabs menu is already open
    const originalViewport = page.viewportSize() || { width: 1280, height: 720 };
    await page.setViewportSize({ width: 520, height: 360 });
    await expect(async () => {
      const afterOverflowCount = await openItemsMenu.locator('.workbench-menu-item').count();
      expect(afterOverflowCount).toBeGreaterThan(initialOverflowCount);
      const [shrunkHostBox, shrunkMenuBox] = await Promise.all([wbHost.boundingBox(), openItemsMenu.boundingBox()]);
      expect(shrunkHostBox).not.toBeNull();
      expect(shrunkMenuBox).not.toBeNull();
      expect(shrunkMenuBox.x).toBeGreaterThanOrEqual(shrunkHostBox.x - 1);
      expect(shrunkMenuBox.x + shrunkMenuBox.width).toBeLessThanOrEqual(shrunkHostBox.x + shrunkHostBox.width + 1);
      expect(shrunkMenuBox.y).toBeGreaterThanOrEqual(shrunkHostBox.y - 1);
      expect(shrunkMenuBox.y + shrunkMenuBox.height).toBeLessThanOrEqual(shrunkHostBox.y + shrunkHostBox.height + 1);
    }).toPass({ timeout: 3000 });
    const lastOverflowItem = openItemsMenu.locator('.workbench-menu-item').last();
    await lastOverflowItem.scrollIntoViewIfNeeded();
    await expect(lastOverflowItem).toBeVisible();
    // 1st Escape closes Open Tabs menu and restores focus to Open Tabs trigger
    await page.keyboard.press('Escape');
    await expect(openItemsMenu).toHaveCount(0);
    await expect(wbHost).toBeVisible();
    await expect(openItemsBtn).toBeFocused();
    await page.setViewportSize(originalViewport);
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

    // 3b. Verify the 3 deep-sky portals (Galaxy, Cosmic Web, Event Horizon) have ZERO overlaid text labels
    const portals = page.locator('.cosmos-sky-anomaly');
    await expect(portals).toHaveCount(3);
    await expect(page.locator('.cosmos-sky-anomaly-label')).toHaveCount(0);
    for (const pText of await portals.allTextContents()) {
      expect(pText.trim()).toBe('');
    }

    // 4. Cosmic Event: open almanac (auto-zoom defaults to OFF for serene distant unfolding), verify toggle,
    // trigger distant event with spatial beacon -> click beacon to zoom in -> verify timeline & telemetry -> stop
    await page.locator('.cosmos-event-main').click();
    await expect(page.locator('.cosmos-event-almanac')).toBeVisible();
    const autoZoomSwitch = page.locator('.cosmos-almanac-pref .cosmos-switch');
    await expect(autoZoomSwitch).toHaveAttribute('aria-checked', 'false');
    await autoZoomSwitch.click();
    await expect(autoZoomSwitch).toHaveAttribute('aria-checked', 'true');
    await autoZoomSwitch.click();
    await expect(autoZoomSwitch).toHaveAttribute('aria-checked', 'false');
    await page.locator('.cosmos-almanac-row').first().click();

    // Auto-zoom is off: no full-screen observation dock yet, distant reticle beacon appears instead
    await expect(page.locator('.cosmos-watch-dock')).toHaveCount(0);
    await expect(page.locator('.cosmos-event-beacon')).toBeVisible({ timeout: 5000 });

    // Click distant beacon -> telescope slews in & opens observation dock with bearing & scrubbable timeline
    await page.locator('.cosmos-event-beacon').click();
    await expect(page.locator('.cosmos-watch-dock')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.cosmos-ewd-bearing')).toBeVisible();
    await expect(page.locator('.cosmos-ewd-timeline')).toBeVisible();

    // Stop immediately via watch dock stop button
    await page.locator('.cosmos-watch-dock .cosmos-ewd-btn.is-stop').click();
    await expect(page.locator('.cosmos-watch-dock')).toHaveCount(0);
    await expect(page.locator('.cosmos-event-beacon')).toHaveCount(0);

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
      const models = [
        { id: 'model-01', label: 'model-01', provider: 'copilot', effortOptions: ['medium', 'high', 'xhigh'] },
        { id: 'model-02', label: 'model-02', provider: 'copilot', effortOptions: ['medium', 'xhigh', 'max'] },
        { id: 'model-03', label: 'model-03', provider: 'copilot', effortOptions: ['low', 'medium', 'high'] },
        { id: 'model-04', label: 'model-04', provider: 'copilot', effortOptions: ['medium', 'high'] },
        { id: 'model-05', label: 'model-05', provider: 'copilot', effortOptions: ['medium', 'high'] },
        { id: 'model-06', label: 'model-06', provider: 'copilot', effortOptions: ['medium', 'high'] },
        { id: 'model-07', label: 'model-07', provider: 'copilot', effortOptions: ['medium', 'high'] },
        { id: 'model-08', label: 'model-08', provider: 'copilot', effortOptions: ['medium', 'high', 'xhigh'] },
      ];
      chat.agents = [
        { id: agentId, name: 'MacBook-Pro', online: true, status: 'ready', workDir: '/Users/dev/yeaft', capabilities: ['session_auto_route', 'session_scenes', 'session_scene_frontend', 'workbench_session_routes', 'terminal', 'file_editor'] },
        { id: 'z-saturn-node', name: 'Cloud-Linux', online: true, status: 'ready', workDir: '/srv/prod', capabilities: ['session_auto_route'] },
      ];
      chat.workbenchRouteProtocolSupported = true;
      chat.yeaftAvailableModels = models;
      chat.yeaftModel = 'copilot/model-08';
      chat.yeaftModelEffort = 'high';
      chat.llmConfig = {
        ...(chat.llmConfig || {}),
        [agentId]: { agentConfig: { primaryModel: 'copilot/model-08', defaultEffort: 'high', availableModels: models } },
      };
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
      const sessionsStore = window.Pinia.useSessionsStore?.();
      sessionsStore?.applySnapshotUpsert?.({
        id: 'sess-mobile-1',
        name: 'Mobile Workbench Check',
        agentId,
        sceneId: 'general',
        config: { model: 'copilot/model-08', modelEffort: 'high' },
        roster: [{ id: 'vp-1' }],
      }, agentId);
      // Record & acknowledge scoped Drawer session update_config writes for this seeded session
      window.__drawerConfigUpdates = [];
      const origCrud = chat.sessionCrudRequest?.bind(chat);
      chat.sessionCrudRequest = async (action, payload, opts) => {
        if (action === 'update_config' && payload?.sessionId === 'sess-mobile-1') {
          window.__drawerConfigUpdates.push({ action, payload, opts });
          const row = sessionsStore?.sessionById?.('sess-mobile-1', opts?.agentId || agentId);
          if (row) {
            row.config = { ...(row.config || {}), ...(payload.config || {}) };
            if (payload.config?.sceneId) row.sceneId = payload.config.sceneId;
          }
          return { ok: true, config: { ...(row?.config || {}), ...(payload.config || {}) } };
        }
        return origCrud ? origCrud(action, payload, opts) : { ok: false };
      };
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

    // Click Earth tag -> opens Quick Composer; verify:
    // 1) Keyboard open (ArrowDown) reveals the 8th selected model inside the scrollable model list & popover without scrolling page
    // 2) Shrinking viewport while open into extreme cramped height (320x250 with multiline draft) keeps the sheet strictly
    //    inside viewport bounds via viewport-contained fallback, with both first & last controls genuinely clickable.
    const earthTagBox = await earthNode.locator('.cosmos-planet-tag').boundingBox();
    expect(earthTagBox).not.toBeNull();
    await page.mouse.click(earthTagBox.x + earthTagBox.width / 2, earthTagBox.y + earthTagBox.height / 2);
    const mobileQuick = page.locator('.cosmos-quick-composer');
    await expect(mobileQuick).toBeVisible();
    await page.setViewportSize({ width: 320, height: 460 });
    await mobileQuick.locator('textarea').fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    const mobileQuickTrigger = mobileQuick.locator('.cosmos-tune-trigger');
    await mobileQuickTrigger.focus();
    await page.keyboard.press('ArrowDown');
    const mobileQuickPop = mobileQuick.locator('.cosmos-tune-popover');
    await expect(mobileQuickPop).toBeVisible();
    await mobileQuickPop.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).catch(() => {}));
    const activeModelRadio = mobileQuickPop.locator('.cosmos-tune-model-row[aria-checked="true"]');
    await expect(activeModelRadio).toBeFocused();
    await expect(activeModelRadio).toContainText('model-08');
    const [mListBox, q320Box, q320PopBox, activeRadioBox] = await Promise.all([
      mobileQuickPop.locator('.cosmos-tune-model-list').boundingBox(),
      mobileQuick.boundingBox(),
      mobileQuickPop.boundingBox(),
      activeModelRadio.boundingBox(),
    ]);
    expect(q320PopBox.y).toBeGreaterThanOrEqual(0);
    expect(q320PopBox.y + q320PopBox.height).toBeLessThanOrEqual(q320Box.y + 1);
    expect(q320PopBox.x).toBeGreaterThanOrEqual(0);
    expect(q320PopBox.x + q320PopBox.width).toBeLessThanOrEqual(320.5);
    expect(activeRadioBox.y).toBeGreaterThanOrEqual(mListBox.y - 1);
    expect(activeRadioBox.y + activeRadioBox.height).toBeLessThanOrEqual(mListBox.y + mListBox.height + 1);
    expect(activeRadioBox.y).toBeGreaterThanOrEqual(q320PopBox.y - 1);
    expect(activeRadioBox.y + activeRadioBox.height).toBeLessThanOrEqual(q320PopBox.y + q320PopBox.height + 1);

    // Shrink viewport WHILE sheet is open into extreme short height (< 48px above multiline composer)
    await page.setViewportSize({ width: 320, height: 250 });
    await expect(async () => {
      const box = await mobileQuickPop.boundingBox();
      expect(box).not.toBeNull();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(250.5);
    }).toPass({ timeout: 2000 });
    const qFirstRadio = mobileQuickPop.locator('button[role="radio"]').first();
    const qLastRadio = mobileQuickPop.locator('button[role="radio"]').last();
    await qFirstRadio.scrollIntoViewIfNeeded();
    await qFirstRadio.click();
    await expect(qFirstRadio).toHaveAttribute('aria-checked', 'true');
    await qLastRadio.scrollIntoViewIfNeeded();
    await qLastRadio.click();
    await expect(qLastRadio).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(mobileQuickPop).toHaveCount(0);

    // Restore 390x844 -> Open Chat -> verify Drawer tuning popover stays below Drawer header with expanded draft,
    // handles shrinking height while open, and real pointer clicks on BOTH first (model) & last (scene) controls trigger scoped updates.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.cosmos-quick-open-btn').click();
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 500 });
    await page.locator('.cosmos-drawer textarea').fill('Drawer line 1\nDrawer line 2\nDrawer line 3\nDrawer line 4');
    await page.locator('.cosmos-drawer .cosmos-tune-trigger').click();
    const mobileDrawerPop = page.locator('.cosmos-drawer .cosmos-tune-popover');
    await expect(mobileDrawerPop).toBeVisible();
    await mobileDrawerPop.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).catch(() => {}));
    const [mHeadBox, mComposerBox, mDrawerPopBox] = await Promise.all([
      page.locator('.cosmos-drawer-head').boundingBox(),
      page.locator('.cosmos-drawer .input-wrapper.chat-composer').boundingBox(),
      mobileDrawerPop.boundingBox(),
    ]);
    expect(mDrawerPopBox.y).toBeGreaterThanOrEqual(mHeadBox.y + mHeadBox.height - 1);
    expect(mDrawerPopBox.y + mDrawerPopBox.height).toBeLessThanOrEqual(mComposerBox.y + 1);
    expect(mDrawerPopBox.x).toBeGreaterThanOrEqual(0);
    expect(mDrawerPopBox.x + mDrawerPopBox.width).toBeLessThanOrEqual(390.5);

    // Shrink Drawer height while popover is open so space above composer collapses -> viewport-contained fallback stays below header
    await page.setViewportSize({ width: 390, height: 260 });
    await expect(async () => {
      const [hBox, pBox] = await Promise.all([
        page.locator('.cosmos-drawer-head').boundingBox(),
        mobileDrawerPop.boundingBox(),
      ]);
      expect(pBox).not.toBeNull();
      expect(pBox.y).toBeGreaterThanOrEqual(hBox.y + hBox.height - 1);
      expect(pBox.y + pBox.height).toBeLessThanOrEqual(260.5);
    }).toPass({ timeout: 2000 });

    // Real pointer clicks on first (model-01) and last (scene) controls inside the Drawer popover
    const dFirstRadio = mobileDrawerPop.locator('.cosmos-tune-model-row').first();
    await dFirstRadio.scrollIntoViewIfNeeded();
    await dFirstRadio.click();
    await expect(dFirstRadio).toHaveAttribute('aria-checked', 'true');
    const dLastScene = mobileDrawerPop.locator('.cosmos-tune-chip').last();
    await dLastScene.scrollIntoViewIfNeeded();
    await dLastScene.click();
    await expect(dLastScene).toHaveAttribute('aria-checked', 'true');
    const drawerUpdates = await page.evaluate(() => window.__drawerConfigUpdates);
    expect(drawerUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'update_config',
        payload: expect.objectContaining({ sessionId: 'sess-mobile-1', config: expect.objectContaining({ model: 'copilot/model-01' }) }),
        opts: expect.objectContaining({ agentId: mockAgent.agentId }),
      }),
      expect.objectContaining({
        action: 'update_config',
        payload: expect.objectContaining({ sessionId: 'sess-mobile-1', config: expect.objectContaining({ sceneId: 'investment' }) }),
        opts: expect.objectContaining({ agentId: mockAgent.agentId }),
      }),
    ]));
    await page.keyboard.press('Escape');
    await expect(mobileDrawerPop).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });

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
