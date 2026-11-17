import { expect } from '@playwright/test';
import { test } from '../../fixtures/scheduled-task-server.js';
import { scheduledTaskAgent, TASK_CAPABILITIES } from '../../fixtures/scheduled-task-agent.js';
import { MockAgent } from '../../fixtures/mock-agent.js';
import { clickPersonAction } from '../../helpers/person-actions.js';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });
test.setTimeout(60000);

for (const scenario of [{ width: 1400, theme: 'light' }, { width: 320, theme: 'dark' }]) {
  test(`Digital Person all-Agent sidebar availability and priority ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl, mockAgent }, testInfo) => {
    const sessionFor = agent => ({ id: 'ordinary-session', name: `${agent.agentName} conversation`, roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test' });
    scheduledTaskAgent(mockAgent, { sessions: [sessionFor(mockAgent)] }); // Unsupported selected Agent.
    const first = new MockAgent(serverUrl, 'First Person Agent');
    const last = new MockAgent(serverUrl, 'Last Person Agent');
    const connectPerson = async agent => {
      await agent.connect();
      scheduledTaskAgent(agent, { sessions: [sessionFor(agent)], capabilities: [...TASK_CAPABILITIES, 'digital_person'] });
      agent._messageHandlers.push(request => {
        if (request.type !== 'person_request') return;
        const data = {
          status: { configured: true, models: [{ id: 'provider/model' }] }, open: {},
          snapshot: { person: { id: `person-${agent.agentId}`, name: agent.agentName }, state: { version: 1 }, messages: [], busy: false },
          messages: { items: [], nextCursor: null }, traces: { items: [], nextCursor: null },
        };
        agent.send({ type: 'person_response', requestId: request.requestId, op: request.op, ok: true, data: data[request.op] || {} });
      });
    };
    try {
      await connectPerson(first);
      await connectPerson(last);
      await page.setViewportSize({ width: scenario.width, height: 850 });
      await page.addInitScript(({ scenario, ids }) => {
        localStorage.setItem('locale', 'en');
        localStorage.setItem('theme', scenario.theme);
        localStorage.setItem('yeaft-preferred-conversation-view', 'yeaft');
        localStorage.setItem('digital-person-ui-enabled-by-agent', JSON.stringify(Object.fromEntries(ids.map(id => [id, true]))));
      }, { scenario, ids: [first.agentId, last.agentId] });
      await page.goto(serverUrl);
      await expect(page.locator('.sidebar-navigation')).toHaveAttribute('aria-busy', 'false');
      const revealSidebar = async () => {
        if (scenario.width <= 768) await page.locator('.person-header .header-sidebar-toggle:visible, .yeaft-topbar-sidebar-toggle:visible, .header-sidebar-toggle:visible').first().click();
      };
      await revealSidebar();
      const selectSession = async agentId => {
        const agent = [mockAgent, first, last].find(row => row.agentId === agentId);
        await page.locator('.sidebar-session-row').filter({ hasText: sessionFor(agent).name }).click();
        await expect(page.locator('.person-page')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.agentId)).toBe(agentId);
        await revealSidebar();
      };
      await selectSession(mockAgent.agentId);
      const trigger = page.locator('.sidebar-primary-actions .sidebar-person-trigger');
      await expect(trigger).toBeVisible();
      expect(await trigger.evaluate(button => button === button.parentElement.querySelector('button'))).toBe(true);
      await trigger.click();
      await expect(page.locator('#person-input')).toBeEnabled();
      await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().digitalPersonAgentId)).toBe(first.agentId);
      // Header selection records the last Person Agent, independently of Session.
      await page.locator('#person-agent').click();
      await page.getByRole('option', { name: last.agentName, exact: true }).click();
      await expect(page.locator('.person-header h1')).toHaveText(last.agentName);
      await revealSidebar();
      await selectSession(first.agentId);
      await trigger.click();
      await expect(page.locator('.person-header h1')).toHaveText(last.agentName);
      // Stay on the offline Person until explicit re-entry chooses the Session Agent.
      await page.locator('#person-input').fill('Keep Last Agent draft while offline');
      await last.disconnect();
      await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.find(a => a.id === id)?.online === true, last.agentId)).toBe(false);
      await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().digitalPersonAgentId)).toBe(last.agentId);
      await expect(page.locator('#person-input')).toHaveValue('Keep Last Agent draft while offline');
      await expect(page.locator('#person-input')).toBeDisabled();
      await revealSidebar();
      await trigger.click();
      await expect(page.locator('.person-header h1')).toHaveText(first.agentName);
      await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.agentId)).toBe(first.agentId);
      await revealSidebar();
      await selectSession(mockAgent.agentId);
      await trigger.click();
      await expect(page.locator('.person-header h1')).toHaveText(first.agentName);
      await revealSidebar();
      await selectSession(mockAgent.agentId);
      await first.disconnect();
      await expect(trigger).toHaveCount(0);
      expect(mockAgent.messages('person_request')).toEqual([]);
      expect([...first.messages('person_request'), ...last.messages('person_request')].some(r => ['send', 'think', 'dream', 'cancel'].includes(r.op))).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`person-agent-priority-${scenario.width}-${scenario.theme}.png`) });
    } finally {
      await first.disconnect();
      await last.disconnect();
    }
  });
}

for (const scenario of [
  { view: 'chat', width: 1400, theme: 'light' },
  { view: 'yeaft', width: 1400, theme: 'dark' },
  { view: 'chat', width: 320, theme: 'dark' },
  { view: 'yeaft', width: 320, theme: 'light' },
]) {
  test(`Digital Person shared Session sidebar ${scenario.view} ${scenario.width}px ${scenario.theme}`, async ({ page, serverUrl, mockAgent }, testInfo) => {
    scheduledTaskAgent(mockAgent, { capabilities: [...TASK_CAPABILITIES, 'digital_person'] });
    mockAgent._messageHandlers.push(request => {
      if (request.type !== 'person_request') return;
      const data = {
        status: { configured: true, models: [{ id: 'provider/model' }] },
        open: { person: { id: 'person-1' } },
        snapshot: { person: { id: 'person-1', name: 'Ada' }, state: { version: 1 }, messages: [], busy: false },
        messages: { items: [], nextCursor: null }, outputs: { items: [], nextCursor: null },
        traces: { items: [], nextCursor: null }, inspect: { items: [], nextCursor: null },
      };
      mockAgent.send({ type: 'person_response', requestId: request.requestId, op: request.op, ok: true, data: data[request.op] || {} });
    });
    await page.setViewportSize({ width: scenario.width, height: 850 });
    await page.addInitScript(({ scenario, agentId }) => {
      localStorage.setItem('locale', 'en');
      localStorage.setItem('theme', scenario.theme);
      localStorage.setItem('yeaft-preferred-conversation-view', scenario.view);
      localStorage.setItem('digital-person-ui-enabled-by-agent', JSON.stringify({ [agentId]: true }));
    }, { scenario, agentId: mockAgent.agentId });
    await page.goto(serverUrl);
    await expect(page.locator('.sidebar-navigation')).toHaveAttribute('aria-busy', 'false');
    if (scenario.width <= 768) await page.locator('.header-sidebar-toggle:visible, .yeaft-topbar-sidebar-toggle:visible').first().click();
    const navigation = page.locator('.sidebar-navigation');
    const actions = page.locator('.sidebar-primary-actions');
    const person = actions.locator('.sidebar-person-trigger');
    await expect(person).toBeVisible();
    expect(await actions.locator('button').first().getAttribute('class')).toContain('sidebar-person-trigger');
    await expect(actions.locator('button').nth(1)).toHaveAttribute('aria-label', 'New chat');
    await expect(page.locator('.sidebar-header-actions .sidebar-person-trigger')).toHaveCount(0);
    // Capture the actual sidebar DOM: opening Person must not remount it.
    await navigation.evaluate(element => { window.originalSessionSidebar = element; });
    const splitCollapsed = scenario.view === 'chat' && scenario.width > 768;
    if (splitCollapsed) {
      await page.evaluate(() => {
        const store = window.Pinia.useChatStore();
        store.addPanel();
        store.sidebarCollapsed = true;
      });
      await page.locator('.sidebar-collapsed-bar .sidebar-person-trigger').click();
      await expect(page.locator('#person-input')).toBeEnabled();
      // Direct collapsed New chat must leave Person before any create/restore.
      await page.locator('.sidebar-collapsed-bar button[title="Conversation"]').click();
      await expect(page.locator('.person-page')).toHaveCount(0);
      await expect(page.locator('.yeaft-session-create-modal')).toBeVisible();
      await page.locator('.yeaft-session-create-modal .resume-close-btn').click();
      await page.locator('.sidebar-collapsed-bar .sidebar-person-trigger').click();
      await expect(page.locator('#person-input')).toBeEnabled();
      await page.locator('.sidebar-collapsed-bar button[title="Expand menu"]').click();
      await expect(navigation).toBeVisible();
      expect(await page.evaluate(() => window.Pinia.useChatStore().panels.length)).toBe(2);
    } else {
      await person.focus();
      await page.keyboard.press('Enter');
    }
    await expect(page.locator('#person-input')).toBeEnabled();
    expect(await navigation.evaluate(element => element === window.originalSessionSidebar)).toBe(true);
    await expect(person).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.person-navigation button[title="Sessions"]')).toHaveCount(0);
    await expect(page.locator('.yeaft-main:visible, .main-content:visible, .vp-timeline-pane:visible')).toHaveCount(0);
    if (scenario.width > 768) await expect(navigation).toBeVisible();
    else {
      await expect(navigation).not.toBeVisible();
      await page.locator('.person-header .header-sidebar-toggle').click();
      await expect(navigation).toBeVisible();
      await page.locator('.sidebar-overlay:visible, .yeaft-sidebar-overlay:visible').click({ position: { x: scenario.width - 4, y: 750 } });
    }
    let dividerColors;
    if (scenario.width > 768) {
      await clickPersonAction(page, 'inside');
      const panel = page.locator('#person-side-panel');
      const divider = page.getByRole('separator', { name: 'Resize output panel', exact: true });
      dividerColors = await panel.evaluate(el => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--text-secondary)';
        el.append(probe);
        const colors = { border: getComputedStyle(el).borderLeftColor, feedback: getComputedStyle(probe).color };
        probe.remove();
        return colors;
      });
      const color = () => divider.evaluate(el => getComputedStyle(el, '::after').backgroundColor);
      await page.mouse.move(10, 10);
      await expect.poll(color).toBe('rgba(0, 0, 0, 0)');
      await divider.hover();
      await expect.poll(color).toBe(dividerColors.feedback);
      const box = await divider.boundingBox();
      await page.mouse.down();
      await page.mouse.move(box.x - 20, box.y + box.height / 2);
      await expect(divider).toHaveClass(/is-dragging/);
      await expect.poll(color).toBe(dividerColors.feedback);
      await page.mouse.up();
      await expect(divider).not.toHaveClass(/is-dragging/);
      await page.mouse.move(10, 10);
      await page.locator('#person-input').focus();
      await expect.poll(color).toBe('rgba(0, 0, 0, 0)');
      await page.keyboard.press('Tab');
      await divider.focus();
      await expect.poll(() => divider.evaluate(el => el.matches(':focus-visible'))).toBe(true);
      await expect.poll(color).toBe(dividerColors.feedback);
      const width = (await panel.boundingBox()).width;
      await divider.press('ArrowLeft');
      await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(width);
      await page.screenshot({ path: testInfo.outputPath(`person-neutral-divider-${scenario.theme}.png`) });
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(panel).toHaveCount(0);
    }
    // Person modal must block the shared sidebar as well as its own transcript.
    await clickPersonAction(page, 'settings');
    await expect(page.locator('.person-settings-modal')).toBeVisible();
    await expect(page.locator('.session-sidebar-shell')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(page.locator('.person-settings-modal')).toHaveCount(0);
    await expect(page.locator('.session-sidebar-shell')).not.toHaveAttribute('inert', '');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`person-sidebar-${scenario.view}-${scenario.width}-${scenario.theme}.png`) });
    if (scenario.width <= 768) await page.locator('.person-header .header-sidebar-toggle').click();
    const session = page.locator('.sidebar-session-row').filter({ hasText: 'Ordinary conversation' });
    await session.click();
    await expect(page.locator('.person-page')).toHaveCount(0);
    await expect(page.locator('.yeaft-main')).toBeVisible();
    if (dividerColors) {
      await page.evaluate(() => window.Pinia.useChatStore().openWorkbench());
      const workbench = page.locator('.workbench-panel.expanded');
      await expect(workbench).toBeVisible();
      await workbench.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
      expect(await workbench.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe(dividerColors.border);
      const divider = workbench.locator('.resize-handle');
      await divider.hover({ position: { x: 5, y: 50 } });
      await expect.poll(() => divider.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(dividerColors.feedback);
      await page.mouse.down();
      await expect.poll(() => divider.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(dividerColors.feedback);
      await page.mouse.up();
      await page.mouse.move(10, 10);
      await expect.poll(() => divider.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      await page.evaluate(() => window.Pinia.useChatStore().toggleWorkbench());
    }
    // Re-enter through the native sidebar, then create a Session directly.
    if (scenario.width <= 768) await page.locator('.yeaft-topbar-sidebar-toggle').click();
    await person.click();
    await expect(page.locator('#person-input')).toBeEnabled();
    if (scenario.width <= 768) await page.locator('.person-header .header-sidebar-toggle').click();
    await actions.locator('button[aria-label="New chat"]').click();
    await expect(page.locator('.person-page')).toHaveCount(0);
    await expect(page.locator('.yeaft-session-create-modal')).toBeVisible();
    expect(mockAgent.messages('person_request').filter(request => ['send', 'think', 'dream', 'cancel'].includes(request.op))).toEqual([]);
  });
}
