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

    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['session_auto_route', 'session_scenes', 'plaintext-ok'] });
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
          capabilities: ['session_auto_route', 'session_scenes', 'session_scene_frontend', 'workbench_session_routes', 'terminal', 'file_editor'],
        },
        {
          id: 'z-agent-cloud',
          name: 'Cloud-Linux',
          online: true,
          status: 'ready',
          workDir: '/srv/yeaft-prod',
          capabilities: ['session_auto_route', 'workbench_session_routes', 'terminal', 'file_editor'],
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
        { id: 'm2', type: 'tool-use', sessionId: 'sess-earth-1', turnId: 'turn-earth-1', toolName: 'FileEdit', toolInput: { file_path: 'web/cosmos/shaders-bodies.js' }, timestamp: now - 35000 },
        { id: 'm3', type: 'assistant', sessionId: 'sess-earth-1', turnId: 'turn-earth-1', content: 'Procedural textures and ray-traced lighting are live with zero external image downloads.', timestamp: now - 15000 },
      ];
      // Seed an unread finished reply on Saturn + a scheduled task completion notice to exercise Signal Stream
      chat.yeaftUnreadSessionKeys = {
        'yeaft:z-agent-cloud:sess-saturn-1': true,
      };
      chat.yeaftSessionReplyPreviewByKey = {
        'yeaft:z-agent-cloud:sess-saturn-1': {
          text: 'Release guard passed across all 508 modules. Tag v1.0.799 is live with zero regressions.',
          at: now - 8000,
          kind: 'assistant',
          askQuestion: '',
          updatedAt: now - 8000,
        },
      };
      chat.scheduledTaskNotifications = [{
        id: JSON.stringify(['z-agent-cloud', 'sess-saturn-nightly', 'run-88']),
        agentId: 'z-agent-cloud',
        sessionId: 'sess-saturn-nightly',
        runId: 'run-88',
        taskName: 'Nightly Telemetry Check',
        status: 'completed',
        error: '',
        createdAt: now - 12000,
      }];
    }, mockAgent.agentId);

    // Wait for planet nodes to bind and render
    const earthTag = page.locator('.cosmos-planet-node[data-planet-id="earth"] .cosmos-planet-tag');
    await expect(earthTag).toContainText('MacBook-Pro', { timeout: 5000 });

    // 0. Stage subtraction & Top-Right Interstellar Signal Stream:
    //    - Zero per-planet .cosmos-live-card elements cluttering the Solar System
    //    - Top-right stream shows unread Saturn reply (2~3 lines), scheduled task notice, and 1-line running Earth card at bottom
    //    - Dismissing one card via ✓ removes it without opening drawer
    //    - Finishing Earth's running turn evolves it in-place into an unread reply card instead of disappearing
    await expect(page.locator('.cosmos-live-card')).toHaveCount(0);
    const signalStreamEl = page.locator('.cosmos-signal-stream');
    await expect(signalStreamEl).toBeVisible();
    const signalCards = signalStreamEl.locator('.cosmos-signal-card');
    await expect(signalCards).toHaveCount(3);
    await expect(signalCards.nth(0)).toHaveAttribute('data-planet-theme', 'saturn');
    await expect(signalCards.nth(0)).toHaveClass(/is-unread/);
    await expect(signalCards.nth(0)).toContainText('Release guard passed across all 508 modules');
    await expect(signalCards.nth(1)).toHaveClass(/is-scheduled/);
    await expect(signalCards.nth(2)).toHaveClass(/is-running/);
    await expect(page.locator('.cosmos-signal-trigger .cosmos-signal-trigger-count')).toHaveText('2');

    // Dismiss the scheduled task card via ✓ without opening drawer
    await signalCards.nth(1).hover();
    await signalCards.nth(1).locator('.cosmos-signal-ack').click();
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);
    await expect(signalCards).toHaveCount(2);
    await expect(page.locator('.cosmos-signal-trigger .cosmos-signal-trigger-count')).toHaveText('1');

    // Clicking the Saturn unread card opens Saturn's drawer, marks it read, and docks remaining signals into left-edge trigger
    await signalCards.nth(0).click();
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    await expect(page.locator('.cosmos-drawer')).toHaveAttribute('data-planet-theme', 'saturn');
    await expect(signalStreamEl).toHaveCount(0);
    // Open the drawer-docked Signal Stream popover via the top-right trigger and close it with 1st Escape (drawer stays open)
    await page.locator('.cosmos-signal-trigger').click();
    const dockedPopover = page.locator('.cosmos-signal-popover.is-drawer-docked');
    await expect(dockedPopover).toBeVisible();
    await expect(dockedPopover.locator('.cosmos-signal-card')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dockedPopover).toHaveCount(0);
    await expect(page.locator('.cosmos-drawer')).toBeVisible();
    // Close drawer back to Saturn focus, then return to full Solar System view so Earth is centered back in-viewport
    await page.keyboard.press('Escape');
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);
    if (await page.locator('.cosmos-pf-return').isVisible()) {
      await page.locator('.cosmos-pf-return').click();
      await expect(page.locator('.cosmos-planet-focus-dock')).toHaveCount(0);
    }
    await expect(signalStreamEl).toBeVisible();
    await expect(signalCards).toHaveCount(1);
    await expect(signalCards.nth(0)).toHaveClass(/is-running/);
    const earthSignalKeyBefore = await signalCards.nth(0).getAttribute('data-signal-key');
    // Dismiss the running card via × -> stays hidden across streaming preview updates until state changes
    await signalCards.nth(0).locator('.cosmos-signal-ack').click();
    await expect(signalStreamEl).toHaveCount(0);
    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      chat.recordYeaftSessionPreview('sess-earth-1', agentId, {
        text: 'Streaming shader pass 2/4…',
        at: Date.now(),
      });
    }, mockAgent.agentId);
    await expect(signalStreamEl).toHaveCount(0);

    // Simulate Earth's background turn completing while drawer is closed (real handleYeaftOutput vp_turn_end):
    // state change (running -> unread) immediately resurfaces the card with its final 2~3 line reply.
    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      chat.handleYeaftOutput({
        agentId,
        conversationId: `yeaft_${agentId}`,
        sessionId: 'sess-earth-1',
        event: { type: 'vp_turn_end', turnId: 'turn-earth-1', sessionId: 'sess-earth-1', vpId: 'vp-1', reason: 'end_turn' },
      });
      chat.yeaftSessionTurnsBySession[`${agentId}\u001fsess-earth-1`].turns = [];
      chat.yeaftProcessingSessions = {};
    }, mockAgent.agentId);
    await expect(signalStreamEl).toBeVisible();
    await expect(signalCards).toHaveCount(1);
    await expect(signalCards.nth(0)).toHaveAttribute('data-signal-key', earthSignalKeyBefore);
    await expect(signalCards.nth(0)).toHaveClass(/is-unread/);
    await expect(signalCards.nth(0)).toContainText('Procedural textures and ray-traced lighting');
    await expect(page.locator('.cosmos-signal-trigger .cosmos-signal-trigger-count')).toHaveText('1');

    // Starting Turn 2 via real mock Agent relay frames while Turn 1's reply exists MUST flip back to Running
    // with a crisp Running chip and live stage text — NEVER showing Turn 1's response as Turn 2's AI reply!
    const relayConvId = `yeaft_${mockAgent.agentId}`;
    const t2Now = Date.now();
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      userTurnId: 'ut-earth-2',
      data: { type: 'user', ts: t2Now, message: { id: 'm4', userTurnId: 'ut-earth-2', content: 'Now profile WebGL shaders' } },
    });
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      event: {
        type: 'session_turns',
        sessionId: 'sess-earth-1',
        turns: [{
          userTurnId: 'ut-earth-2',
          userMessageId: 'm4',
          startedAt: t2Now,
          state: 'running',
          executions: [{ vpId: 'vp-1', turnId: 'turn-earth-2', threadId: 'th-1', state: 'running' }],
        }],
      },
    });
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      event: { type: 'vp_turn_start', sessionId: 'sess-earth-1', vpId: 'vp-1', turnId: 'turn-earth-2', userTurnId: 'ut-earth-2', ts: t2Now + 10 },
    });
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      event: { type: 'vp_status_changed', sessionId: 'sess-earth-1', vpId: 'vp-1', turnId: 'turn-earth-2', state: 'thinking', since: t2Now + 10 },
    });
    await expect(signalCards).toHaveCount(1);
    await expect(signalCards.nth(0)).toHaveClass(/is-running/);
    await expect(signalCards.nth(0).locator('.cosmos-signal-chip.is-running')).toBeVisible();
    await expect(signalCards.nth(0)).not.toContainText('Procedural textures and ray-traced lighting');
    await expect(signalCards.nth(0)).toContainText(/Thinking…|正在思考…/);

    // Complete Turn 2 via real mock Agent relay frames (assistant -> result -> vp_turn_end -> idle),
    // then deliver a late Turn 1 `result` frame -> Turn 2's real reply MUST remain intact!
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      vpId: 'vp-1',
      turnId: 'turn-earth-2',
      userTurnId: 'ut-earth-2',
      data: { type: 'assistant', ts: t2Now + 50, message: { id: 'm5', content: [{ type: 'text', text: 'WebGL shader frame time reduced to 2.1ms.' }] } },
    });
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      vpId: 'vp-1',
      turnId: 'turn-earth-2',
      userTurnId: 'ut-earth-2',
      data: { type: 'result', ts: t2Now + 60, result_text: '' },
    });
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      event: { type: 'vp_turn_end', turnId: 'turn-earth-2', userTurnId: 'ut-earth-2', sessionId: 'sess-earth-1', vpId: 'vp-1', reason: 'end_turn' },
    });
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      event: {
        type: 'session_turns',
        sessionId: 'sess-earth-1',
        turns: [{
          userTurnId: 'ut-earth-2',
          userMessageId: 'm4',
          startedAt: t2Now,
          endedAt: t2Now + 70,
          state: 'completed',
          executions: [{ vpId: 'vp-1', turnId: 'turn-earth-2', threadId: 'th-1', state: 'completed' }],
        }],
      },
    });
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      event: { type: 'vp_status_changed', sessionId: 'sess-earth-1', vpId: 'vp-1', state: 'idle' },
    });
    await expect(signalCards).toHaveCount(1);
    await expect(signalCards.nth(0)).toHaveClass(/is-unread/);
    await expect(signalCards.nth(0)).toContainText('WebGL shader frame time reduced to 2.1ms.');
    await expect(signalCards.nth(0)).not.toContainText('Procedural textures and ray-traced lighting');

    // Late Turn 1 `result` frame arriving AFTER Turn 2 completed MUST NOT replace Turn 2's unread reply!
    // Stamp a sentinel on m3 before sending, then wait for browser consumption of the exact frame before asserting.
    await page.evaluate((convId) => {
      const chat = window.Pinia.useChatStore();
      const m3 = (chat.messagesMap[convId] || []).find((row) => row.id === 'm3');
      if (m3) m3.turnEndAt = 1;
    }, relayConvId);
    mockAgent.send({
      type: 'yeaft_output',
      conversationId: relayConvId,
      sessionId: 'sess-earth-1',
      vpId: 'vp-1',
      turnId: 'turn-earth-1',
      userTurnId: 'ut-earth-1',
      data: { type: 'result', ts: t2Now + 200, result_text: '' },
    });
    await expect.poll(() => page.evaluate((convId) => {
      const chat = window.Pinia.useChatStore();
      const m3 = (chat.messagesMap[convId] || []).find((row) => row.id === 'm3');
      return m3?.turnEndAt || 0;
    }, relayConvId), { timeout: 5000 }).toBeGreaterThan(1);
    await expect(signalCards.nth(0)).toHaveClass(/is-unread/);
    await expect(signalCards.nth(0)).toContainText('WebGL shader frame time reduced to 2.1ms.');
    await expect(signalCards.nth(0)).not.toContainText('Procedural textures and ray-traced lighting');

    // Dismissing a waiting (AskUser) card hides it until a new AskUser / state change arrives
    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      chat.recordYeaftSessionPreview('sess-earth-1', agentId, {
        askQuestion: 'Approve orbital deployment?',
        askRequestId: 'e2e-ask-1',
        askTurnId: 'turn-ask-1',
        at: Date.now(),
      });
    }, mockAgent.agentId);
    await expect(signalCards.nth(0)).toHaveClass(/is-waiting/);
    await signalCards.nth(0).locator('.cosmos-signal-ack').click();
    await expect(signalStreamEl).toHaveCount(0);
    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      chat.recordYeaftSessionPreview('sess-earth-1', agentId, {
        askQuestion: 'Approve orbital deployment?',
        askRequestId: 'e2e-ask-2',
        askTurnId: 'turn-ask-2',
        at: Date.now() + 1000,
      });
    }, mockAgent.agentId);
    await expect(signalStreamEl).toBeVisible();
    await expect(signalCards.nth(0)).toHaveClass(/is-waiting/);
    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      chat.recordYeaftSessionPreview('sess-earth-1', agentId, { clearAsk: true, askRequestId: 'e2e-ask-2' });
    }, mockAgent.agentId);
    // Re-arm running state for subsequent Drawer Session Status & auto-route checks
    await page.evaluate((agentId) => {
      const chat = window.Pinia.useChatStore();
      const now = Date.now();
      const convId = `yeaft_${agentId}`;
      chat.messagesMap[convId] = (chat.messagesMap[convId] || []).filter((row) => row.id !== 'm4' && row.id !== 'm5');
      chat.yeaftProcessingSessions = { [`${agentId}\u001fsess-earth-1`]: true };
      chat.yeaftSessionTurnsBySession[`${agentId}\u001fsess-earth-1`] = {
        connectionGeneration: chat.chatHistoryConnectionGeneration || 1,
        conversationId: convId,
        turns: [{
          userTurnId: 'ut-earth-1',
          userMessageId: 'm1',
          state: 'running',
          startedAt: now - 12000,
          executions: [{ vpId: 'vp-1', turnId: 'turn-earth-1', threadId: 'th-1', state: 'running' }],
        }],
      };
      chat.activeVpTurns[`${agentId}\u001fturn-earth-1`] = {
        agentId,
        sessionId: 'sess-earth-1',
        vpId: 'vp-1',
        turnId: 'turn-earth-1',
        threadId: 'th-1',
        userTurnId: 'ut-earth-1',
        conversationId: convId,
        connectionGeneration: chat.chatHistoryConnectionGeneration || 1,
        startedAt: now - 12000,
      };
    }, mockAgent.agentId);

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

    // 1. Clicking a planet opens Quick Auto-Route Composer (NOT right drawer);
    //    clicking its Close button closes the composer AND returns camera focus to the Sun.
    await expect(async () => {
      const b = await earthTag.boundingBox();
      expect(Boolean(b && b.x > 10 && b.x + b.width < 1270 && b.y > 10 && b.y + b.height < 710)).toBe(true);
    }).toPass({ timeout: 3000 });
    await clickOrbiting(earthTag);
    await expect(page.locator('.cosmos-quick-composer')).toBeVisible();
    await expect(page.locator('.cosmos-planet-focus-dock')).toBeVisible();
    await page.locator('.cosmos-quick-close-btn').click();
    await expect(page.locator('.cosmos-quick-composer')).toHaveCount(0);
    await expect(page.locator('.cosmos-planet-focus-dock')).toHaveCount(0);

    // Re-open Quick Auto-Route Composer on Earth for tuning & send checks
    await expect(async () => {
      const b = await earthTag.boundingBox();
      expect(Boolean(b && b.x > 10 && b.x + b.width < 1270 && b.y > 10 && b.y + b.height < 710)).toBe(true);
    }).toPass({ timeout: 5000 });
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
    // Verify wide drawer has NO excessive dead left whitespace: header, assistant messages, and composer align cleanly along one left rail
    const [wideDrawerBox, wideMsgBox, wideComposerBox] = await Promise.all([
      page.locator('.cosmos-drawer').boundingBox(),
      page.locator('.cosmos-drawer .messages .assistant-turn').first().boundingBox(),
      page.locator('.cosmos-drawer .input-wrapper.chat-composer').boundingBox(),
    ]);
    expect(wideDrawerBox).not.toBeNull();
    expect(wideMsgBox).not.toBeNull();
    expect(wideComposerBox).not.toBeNull();
    expect(wideMsgBox.x - wideDrawerBox.x).toBeLessThanOrEqual(48);
    expect(wideComposerBox.x - wideDrawerBox.x).toBeLessThanOrEqual(48);
    expect(Math.abs(wideMsgBox.x - wideComposerBox.x)).toBeLessThanOrEqual(6);
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

    // Close drawer via Escape -> automatically returns camera focus from planet to Sun center
    await page.keyboard.press('Escape');
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);
    await expect(page.locator('.cosmos-planet-focus-dock')).toHaveCount(0);

    // 3. Hover planet -> click specific session -> opens right planetary drawer;
    //    clicking the drawer Close button closes it AND returns camera focus to the Sun.
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
    await expect(page.locator('.cosmos-planet-focus-dock')).toBeVisible();
    await page.locator('.cosmos-drawer-head .cosmos-icon-btn').last().click();
    await expect(page.locator('.cosmos-drawer')).toHaveCount(0);
    await expect(page.locator('.cosmos-planet-focus-dock')).toHaveCount(0);

    // 3b. Verify the 2 deep-sky portals (Galaxy, Cosmic Web) have ZERO overlaid text labels (Event Horizon is Sun-zoom only)
    const portals = page.locator('.cosmos-sky-anomaly');
    await expect(portals).toHaveCount(2);
    await expect(page.locator('.cosmos-sky-anomaly-label')).toHaveCount(0);
    for (const pText of await portals.allTextContents()) {
      expect(pText.trim()).toBe('');
    }

    // 4. Cosmic Events: open almanac (auto-zoom defaults to OFF for serene distant unfolding), verify toggle,
    // trigger TWO concurrent distant events with ZERO reticle circles -> verify +1 badge -> observe -> stop
    await page.locator('.cosmos-event-main').click();
    await expect(page.locator('.cosmos-event-almanac')).toBeVisible();
    const autoZoomSwitch = page.locator('.cosmos-almanac-pref .cosmos-switch');
    await expect(autoZoomSwitch).toHaveAttribute('aria-checked', 'false');
    await autoZoomSwitch.click();
    await expect(autoZoomSwitch).toHaveAttribute('aria-checked', 'true');
    await autoZoomSwitch.click();
    await expect(autoZoomSwitch).toHaveAttribute('aria-checked', 'false');
    await page.locator('.cosmos-almanac-row').first().click();

    // Auto-zoom is off: no observation dock yet, ZERO distracting circular reticle beacons
    await expect(page.locator('.cosmos-watch-dock')).toHaveCount(0);
    await expect(page.locator('.cosmos-event-beacon')).toHaveCount(0);

    // Trigger a 2nd concurrent event from Almanac -> +1 concurrent badge appears on pill
    await page.locator('.cosmos-event-main').click();
    await expect(page.locator('.cosmos-event-almanac')).toBeVisible();
    await page.locator('.cosmos-almanac-row').nth(2).click();
    await expect(page.locator('.cosmos-event-multi')).toContainText('+1');

    // Click top Watch button -> smoothly approaches on shared canvas & opens observation dock with bearing & timeline
    await page.locator('.cosmos-event-watch-btn').click();
    await expect(page.locator('.cosmos-watch-dock')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.cosmos-ewd-bearing')).toBeVisible();
    await expect(page.locator('.cosmos-ewd-timeline')).toBeVisible();

    // Stop immediately via watch dock stop button
    await page.locator('.cosmos-watch-dock .cosmos-ewd-btn.is-stop').click();
    await expect(page.locator('.cosmos-watch-dock')).toHaveCount(0);
    await expect(page.locator('.cosmos-event-multi')).toHaveCount(0);

    // Silence automatic random cosmic events via stop button
    await page.locator('.cosmos-event-stop-btn').click();
    await expect(page.locator('.cosmos-event-pill')).toHaveClass(/is-auto-off/);

    // 5. Cosmic Constants cloud persistence + authentic Yeaft Settings modal:
    //    Change orbitSpeed + Agent planet binding -> wait deterministically for BOTH PATCH responses ->
    //    verify a brand-new browser context (empty localStorage) hydrates the exact same Cosmos settings
    //    & planet assignment straight from the Server DB!
    const waitPrefPatch = (predicate) => page.waitForResponse((res) => {
      if (!res.url().includes('/api/user/preferences') || res.request().method() !== 'PATCH' || res.status() !== 200) return false;
      try {
        const body = JSON.parse(res.request().postData() || '{}');
        return Boolean(predicate(body));
      } catch {
        return false;
      }
    });
    await page.locator('.cosmos-corner-actions .cosmos-corner-icon').first().click();
    await expect(page.locator('.cosmos-constants-popover')).toBeVisible();
    const orbitRange = page.locator('.cosmos-constants-popover .cosmos-const-range').first();
    const orbitSetPatch = waitPrefPatch((b) => b?.cosmosConfig?.constants?.orbitSpeed === 0.4);
    await orbitRange.fill('0.4');
    await orbitRange.dispatchEvent('input');
    const firstBindingSelect = page.locator('.cosmos-constants-popover .cosmos-binding-row select').first();
    const bindingSetPatch = waitPrefPatch((b) => Object.values(b?.cosmosConfig?.planetBindings || {}).includes('mars'));
    await firstBindingSelect.selectOption('mars');
    await Promise.all([orbitSetPatch, bindingSetPatch]);

    // Fresh second browser context (clean device, empty localStorage) loads same cloud Cosmos config
    const secondContext = await page.context().browser().newContext();
    try {
      const secondPage = await secondContext.newPage();
      await secondPage.goto(serverUrl);
      await expect(secondPage.locator('.cosmos-page')).toBeVisible({ timeout: 15000 });
      await secondPage.waitForFunction((agentId) => {
        const chat = window.Pinia?.useChatStore?.();
        return Boolean(chat && (chat.agents || []).some((a) => a.id === agentId && a.online === true));
      }, mockAgent.agentId, { timeout: 15000 });
      await secondPage.locator('.cosmos-corner-actions .cosmos-corner-icon').first().click();
      await expect(secondPage.locator('.cosmos-constants-popover')).toBeVisible();
      await expect(secondPage.locator('.cosmos-constants-popover .cosmos-const-val').first()).toHaveText('0.4×', { timeout: 5000 });
      await expect(secondPage.locator('.cosmos-planet-node[data-planet-id="mars"] .cosmos-planet-tag')).toContainText(/.+/, { timeout: 5000 });
      await secondPage.close();
    } finally {
      await secondContext.close();
    }

    // Deterministically restore cloud defaults so subsequent tests sharing the worker DB start clean
    const bindingRestorePatch = waitPrefPatch((b) => Object.values(b?.cosmosConfig?.planetBindings || {}).includes('earth'));
    await firstBindingSelect.selectOption('earth');
    const orbitRestorePatch = waitPrefPatch((b) => b?.cosmosConfig?.constants?.orbitSpeed === 1);
    await orbitRange.fill('1');
    await orbitRange.dispatchEvent('input');
    await Promise.all([bindingRestorePatch, orbitRestorePatch]);

    await page.locator('.cosmos-cfg-item').first().click();
    await expect(page.locator('.settings-dialog')).toBeVisible();
    await page.locator('.settings-close').click();
    await expect(page.locator('.settings-dialog')).toHaveCount(0);

    // 6. Scale switching to Galaxy -> Cosmic Web -> Event Horizon -> Solar
    await page.locator('.cosmos-scale-tick').nth(1).click();
    await expect(page.locator('.creation-galaxy-overlay')).toBeVisible({ timeout: 5000 });
    await page.locator('.cosmos-scale-tick').nth(3).click();
    await expect(page.locator('.cosmos-corner-dock')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.cosmos-whisper-note')).toBeVisible({ timeout: 5000 });
    await page.locator('.cosmos-scale-tick').nth(2).click();

    // 7. Abandon Cosmos -> classic Yeaft UI unchanged, persists on reload, and ✦ re-enters Cosmos
    const classicPatch = waitPrefPatch((b) => b?.cosmosConfig?.uiMode === 'classic');
    await page.locator('.cosmos-corner-icon.is-abandon').click();
    await classicPatch;
    await expect(page.locator('.cosmos-page')).toHaveCount(0);
    await expect(page.locator('.yeaft-page, .chat-page').first()).toBeVisible({ timeout: 8000 });

    await page.reload();
    await expect(page.locator('.yeaft-page, .chat-page').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.cosmos-page')).toHaveCount(0);

    const cosmosPatch = waitPrefPatch((b) => b?.cosmosConfig?.uiMode === 'cosmos');
    await page.locator('.sidebar-cosmos-btn').click();
    await cosmosPatch;
    await expect(page.locator('.cosmos-page')).toBeVisible({ timeout: 8000 });
    // Reset cloud preferences to clean defaults for subsequent tests on the shared worker TestServer
    await page.evaluate(async () => {
      await fetch('/api/user/preferences', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cosmosConfig: {
            constants: { orbitSpeed: 1, eventsAutoEnabled: true, renderQuality: 'auto' },
            planetBindings: {},
            drawerWidth: null,
            uiMode: 'cosmos',
          },
        }),
      });
    });

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
      chat.yeaftUnreadSessionKeys = {
        [`yeaft:${agentId}:sess-mobile-1`]: true,
      };
      chat.yeaftSessionReplyPreviewByKey = {
        [`yeaft:${agentId}:sess-mobile-1`]: {
          text: 'Mobile build artifacts verified cleanly on portrait viewport.',
          at: Date.now(),
          kind: 'assistant',
          updatedAt: Date.now(),
        },
      };
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

    // Mobile portrait: zero per-planet micro-lists, no desktop floating card stack, compact signal capsule + banner + mobile sheet
    await expect(page.locator('.cosmos-live-card')).toHaveCount(0);
    await expect(page.locator('.cosmos-signal-stream')).toHaveCount(0);
    await expect(page.locator('.cosmos-signal-mobile-banner')).toBeVisible();
    await expect(page.locator('.cosmos-signal-trigger .cosmos-signal-trigger-count')).toHaveText('1');
    await page.locator('.cosmos-signal-banner-close').click();
    await expect(page.locator('.cosmos-signal-mobile-banner')).toHaveCount(0);
    await page.locator('.cosmos-signal-trigger').click();
    await expect(page.locator('.cosmos-signal-popover.is-mobile')).toBeVisible();
    await expect(page.locator('.cosmos-signal-popover.is-mobile .cosmos-signal-card')).toContainText('Mobile build artifacts verified');
    await page.keyboard.press('Escape');
    await expect(page.locator('.cosmos-signal-popover')).toHaveCount(0);

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
    const resetRenderPatch = page.waitForResponse((res) => {
      if (!res.url().includes('/api/user/preferences') || res.request().method() !== 'PATCH' || res.status() !== 200) return false;
      try {
        const body = JSON.parse(res.request().postData() || '{}');
        return body?.cosmosConfig?.constants?.renderQuality === 'auto';
      } catch {
        return false;
      }
    });
    await rendererSelect.selectOption('auto');
    await resetRenderPatch;

    expect(failedAssets).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('supports interstellar soaring free-flight, star atlas warp to Alpha Centauri & Sgr A*, exoplanet zoom, and return to Sol', async ({ page, serverUrl }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(serverUrl);
    await expect(page.locator('.cosmos-page')).toBeVisible({ timeout: 15000 });

    // 1. Top-left Voyage Bar is visible in Solar System
    const voyageBar = page.locator('.cosmos-voyage-bar');
    await expect(voyageBar).toBeVisible();
    await expect(voyageBar.locator('.cosmos-voyage-sys-btn')).toContainText(/太阳系|Solar System/);

    // 2. Enter Interstellar Soar Mode -> flight dock appears, speed adjusts, floating star beacons project
    await voyageBar.locator('.cosmos-voyage-soar-btn').click();
    await expect(voyageBar).toHaveClass(/is-soaring/);
    const flightDock = page.locator('.cosmos-voyage-dock');
    await expect(flightDock).toBeVisible();
    const initialSpeed = await flightDock.locator('.cosmos-voyage-speed-val').textContent();
    await flightDock.locator('.cosmos-ewd-mini').nth(1).click();
    await expect(flightDock.locator('.cosmos-voyage-speed-val')).not.toHaveText(initialSpeed || '');

    // Poll until soarBlend > 0.32 and floating star beacons project into the 3D skybox
    await expect.poll(async () => page.locator('.cosmos-soar-beacon').evaluateAll(
      (els) => els.filter((el) => el.style.display !== 'none').length,
    ), { timeout: 4000 }).toBeGreaterThan(0);

    // 3. Open Star Atlas, verify Escape closes Star Atlas first (without exiting soar)
    await voyageBar.locator('.cosmos-voyage-sys-btn').click();
    const atlas = page.locator('.cosmos-voyage-atlas');
    await expect(atlas).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(atlas).toHaveCount(0);
    await expect(voyageBar).toHaveClass(/is-soaring/);

    // Re-open Star Atlas and warp to Alpha Centauri (Binary Star System)
    await voyageBar.locator('.cosmos-voyage-sys-btn').click();
    await expect(atlas).toBeVisible();
    await expect(atlas.locator('.cosmos-voyage-atlas-item')).toHaveCount(5);
    await atlas.locator('.cosmos-voyage-atlas-item').nth(1).click();

    // Wait for warp completion into Alpha Centauri
    await expect(voyageBar.locator('.cosmos-voyage-sys-btn')).toContainText(/半人马座|Alpha Centauri/, { timeout: 6000 });
    await expect(voyageBar).not.toHaveClass(/is-warping/, { timeout: 6000 });
    await expect(page.locator('.cosmos-sightseeing-tag').first()).toBeVisible({ timeout: 5000 });

    // 4. Click an exoplanet tag in Alpha Centauri -> centers & opens Planet Focus Inspection Dock
    await page.locator('.cosmos-sightseeing-tag').first().click();
    await expect(page.locator('.cosmos-planet-focus-dock')).toBeVisible();
    await page.locator('.cosmos-pf-return').click();
    await expect(page.locator('.cosmos-planet-focus-dock')).toHaveCount(0);

    // 5. Warp to Sagittarius A* (Galactic Core SMBH + S-stars) and then return home to Sol
    await voyageBar.locator('.cosmos-voyage-sys-btn').click();
    await page.locator('.cosmos-voyage-atlas-item').nth(4).click();
    await expect(voyageBar.locator('.cosmos-voyage-sys-btn')).toContainText(/Sgr A\*|人马座/, { timeout: 7000 });
    await expect(voyageBar).not.toHaveClass(/is-warping/, { timeout: 7000 });

    await page.locator('.cosmos-voyage-home-btn').click();
    await expect(voyageBar.locator('.cosmos-voyage-sys-btn')).toContainText(/太阳系|Solar System/, { timeout: 7000 });
    await expect(voyageBar).not.toHaveClass(/is-warping/, { timeout: 7000 });

    // 6. Verify 390x844 mobile portrait layout: Voyage Bar never overlaps Events pill or Corner Actions
    await page.setViewportSize({ width: 390, height: 844 });
    const vBox = await voyageBar.boundingBox();
    const evBox = await page.locator('.cosmos-event-wrap').boundingBox();
    const cornerBox = await page.locator('.cosmos-corner-actions').boundingBox();
    expect(vBox).not.toBeNull();
    expect(cornerBox).not.toBeNull();
    expect(vBox.x + vBox.width).toBeLessThanOrEqual(cornerBox.x + 2);
    if (evBox) {
      expect(evBox.y).toBeGreaterThanOrEqual(vBox.y + vBox.height - 1);
    }

    expect(errors).toEqual([]);
  });

  test('supports left-drag canvas panning, right-drag 3D orbiting, floating recenter button, and auto-recenter on planet focus', async ({ page, serverUrl }) => {
    test.setTimeout(60000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(serverUrl);
    await expect(page.locator('.cosmos-page')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.cosmos-gl-canvas')).toBeVisible();

    // Pause orbital motion via Cosmic Constants so planet position delta cleanly reflects canvas pan
    await page.locator('.cosmos-corner-actions .cosmos-corner-icon').first().click();
    await expect(page.locator('.cosmos-constants-popover')).toBeVisible();
    const speedSlider = page.locator('.cosmos-constants-popover input[type="range"]').first();
    await speedSlider.fill('0');
    await speedSlider.dispatchEvent('input');
    await page.keyboard.press('Escape');
    await expect(page.locator('.cosmos-constants-popover')).toHaveCount(0);

    const earthNode = page.locator('.cosmos-planet-node[data-planet-id="earth"]');
    await expect(earthNode.locator('.cosmos-planet-tag')).toBeVisible({ timeout: 5000 });

    const getEarthTranslate = () => earthNode.evaluate((el) => {
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform || '');
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    });

    const beforePan = await getEarthTranslate();
    expect(beforePan).not.toBeNull();
    await expect(page.locator('.cosmos-pan-reset-btn')).toHaveCount(0);

    // 1. Left-button drag on open space pans the entire Solar System canvas right & down
    await page.mouse.move(640, 180);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(860, 320, { steps: 10 });
    await page.mouse.up({ button: 'left' });

    const recenterBtn = page.locator('.cosmos-pan-reset-btn');
    await expect(recenterBtn).toBeVisible({ timeout: 3000 });

    await expect.poll(async () => {
      const pos = await getEarthTranslate();
      return pos ? pos.x - beforePan.x : 0;
    }, { timeout: 3000 }).toBeGreaterThan(120);

    await expect.poll(async () => {
      const pos = await getEarthTranslate();
      return pos ? pos.y - beforePan.y : 0;
    }, { timeout: 3000 }).toBeGreaterThan(70);

    // 2. Right-button drag adjusts 3D orbit angle without opening context menu or clearing recenter pill
    await page.mouse.move(640, 180);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(760, 120, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await expect(recenterBtn).toBeVisible();

    // 3. Clicking floating Recenter pill smoothly restores Solar System to center and hides the pill
    await recenterBtn.click();
    await expect(recenterBtn).toHaveCount(0);
    await expect.poll(async () => {
      const pos = await getEarthTranslate();
      return pos ? Math.hypot(pos.x - beforePan.x, pos.y - beforePan.y) : 999;
    }, { timeout: 4000 }).toBeLessThan(40);

    // 4. Pan again, then double-click open canvas to recenter
    await page.mouse.move(640, 180);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(800, 260, { steps: 8 });
    await page.mouse.up({ button: 'left' });
    await expect(recenterBtn).toBeVisible();
    await page.mouse.dblclick(640, 180);
    await expect(recenterBtn).toHaveCount(0);

    // 5. Pan again, then click Earth -> auto-recenters pan and opens Planet Focus dock
    await page.mouse.move(640, 180);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(800, 260, { steps: 8 });
    await page.mouse.up({ button: 'left' });
    await expect(recenterBtn).toBeVisible();
    await page.waitForTimeout(350);
    const pannedEarth = await getEarthTranslate();
    expect(pannedEarth).not.toBeNull();
    await page.mouse.click(pannedEarth.x, pannedEarth.y);
    await expect(recenterBtn).toHaveCount(0);
    await expect(page.locator('.cosmos-planet-focus-dock')).toBeVisible();
    if (await page.locator('.settings-overlay').isVisible()) {
      await page.keyboard.press('Escape');
      await expect(page.locator('.settings-overlay')).toHaveCount(0);
    }
    await page.locator('.cosmos-pf-return').click();
    await expect(page.locator('.cosmos-planet-focus-dock')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
