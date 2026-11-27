import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' } });

const capabilities = [
  'digital_person', 'work_center', 'work_center_feature_settings', 'work_center_workbench',
  'workbench_session_routes', 'terminal', 'file_editor', 'scheduled_tasks', 'plaintext-ok',
];
const legacyAgent = { id: 'legacy-agent', name: 'Legacy Agent', online: true, status: 'ready', capabilities };
const legacyLabel = /Digital Person|Work Center|数字人|工作中心/i;

for (const [locale, view, general, runtime] of [
  ['en', 'chat', 'General', 'Runtime'],
  ['zh-CN', 'yeaft', '通用', '运行时'],
]) {
  test(`retired products stay absent with a legacy Agent and enabled preferences (${locale}, ${view})`, async ({ page, serverUrl }) => {
    const personPref = JSON.stringify({ [legacyAgent.id]: true });
    const savedDrafts = JSON.stringify({ ownerId: 'previous-owner', records: { draft: { text: 'Keep this draft' } } });
    await page.addInitScript(({ locale, view, personPref, savedDrafts }) => {
      localStorage.setItem('locale', locale);
      localStorage.setItem('yeaft-preferred-conversation-view', view);
      localStorage.setItem('work-center-ui-enabled', 'true');
      localStorage.setItem('digital-person-ui-enabled-by-agent', personPref);
      localStorage.setItem('yeaft-work-center-composer-drafts-v1', savedDrafts);
    }, { locale, view, personPref, savedDrafts });

    const sent = [];
    let sendFrame;
    let inventories = 0;
    await page.routeWebSocket(/.*/, route => {
      const server = route.connectToServer();
      sendFrame = frame => route.send(JSON.stringify(frame));
      route.onMessage(message => {
        sent.push(JSON.parse(String(message)));
        server.send(message);
      });
      server.onMessage(message => {
        const frame = JSON.parse(String(message));
        if (frame.type === 'agent_list') {
          inventories += 1;
          frame.agents = [legacyAgent];
        }
        if (frame.type === 'client_hello_ack') frame.workCenterWorkbenchProtocol = 1;
        route.send(JSON.stringify(frame));
      });
    });

    // A bookmark from the old board must not open it or start a browse.
    const url = new URL(serverUrl);
    url.search = '?workAgentId=legacy-agent&workItemId=old-item&workContent=none';
    await page.goto(url.href);
    const sidebar = page.locator('#session-sidebar');
    const ready = () => page.evaluate(id => {
      const chat = window.Pinia?.useChatStore?.();
      return chat?.authenticated === true && chat.agents.some(agent => agent.id === id && agent.online);
    }, legacyAgent.id);
    await expect.poll(ready).toBe(true);
    await expect(page.locator(`.${view}-page`)).toBeVisible();
    await expect(sidebar.locator('.agent-dropdown-trigger')).toBeVisible();
    const expectNoEntries = async () => {
      await expect(page.locator('.sidebar-person-trigger, .sidebar-work-center-trigger, .work-center-main, #person-input')).toHaveCount(0);
      await expect(sidebar.getByRole('button', { name: legacyLabel, includeHidden: true })).toHaveCount(0);
    };
    await expectNoEntries();
    await sidebar.locator('.sidebar-header-actions button').click();
    await expect(sidebar.locator('.sidebar-collapsed-bar')).toBeVisible();
    await expectNoEntries();
    await sidebar.locator('.sidebar-collapsed-bar button').first().click();

    await sidebar.locator('.sidebar-nav-item').click();
    const settings = page.locator('.settings-dialog');
    await settings.getByRole('button', { name: general, exact: true }).click();
    await expect(settings.locator('button[aria-labelledby="general-cosmos-ui-label"]')).toBeVisible();
    await expect(settings.getByText(legacyLabel)).toHaveCount(0);
    await settings.locator('.settings-close').click();

    await sidebar.locator('.agent-dropdown-trigger').click();
    await sidebar.locator('.agent-dropdown-settings-option').first().click();
    const agentSettings = page.getByRole('dialog', { name: /Agent settings|Agent 设置/i });
    await expect(agentSettings.getByRole('heading', { name: runtime })).toBeVisible();
    await expect(agentSettings.getByText(legacyLabel)).toHaveCount(0);
    await expect(agentSettings.getByRole('switch', { name: legacyLabel, includeHidden: true })).toHaveCount(0);
    await agentSettings.locator('.settings-close').click();

    const previousInventories = inventories;
    await page.evaluate(() => window.Pinia.useChatStore().manualReconnect());
    await expect.poll(() => inventories).toBeGreaterThan(previousInventories);
    await expect.poll(ready).toBe(true);
    sendFrame({ type: 'work_center_event', agentId: legacyAgent.id, event: {
      type: 'work_item.updated', workItem: { id: 'old-item', title: 'Old work must not render', status: 'running', revision: 1 },
    } });
    // An inventory marker fences event delivery on the same socket.
    const marker = 'Legacy Agent after reconnect';
    sendFrame({ type: 'agent_list', agents: [{ ...legacyAgent, name: marker }] });
    await expect.poll(() => page.evaluate(id => window.Pinia.useChatStore().agents.find(agent => agent.id === id)?.name, legacyAgent.id)).toBe(marker);
    await expectNoEntries();
    await expect(page.getByText('Old work must not render')).toHaveCount(0);
    expect(await page.evaluate(() => window.Pinia.useChatStore().workCenterItemsByAgent)).toEqual({});
    expect(sent.filter(frame => /^(person_|work_center_|(?:get|update)_work_center_)/.test(frame.type))).toEqual([]);
    const hellos = sent.filter(frame => frame.type === 'client_hello');
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    for (const hello of hellos) {
      expect(hello.workbenchRouteProtocol).toBe(1);
      expect(hello).not.toHaveProperty('workCenterWorkbenchProtocol');
    }
    expect(await page.evaluate(() => [
      localStorage.getItem('work-center-ui-enabled'),
      localStorage.getItem('digital-person-ui-enabled-by-agent'),
      localStorage.getItem('yeaft-work-center-composer-drafts-v1'),
    ])).toEqual(['true', personPref, savedDrafts]);
  });
}
