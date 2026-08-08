import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

async function openYeaftWorkbench(chatPage, mockAgent, { closeSessionStatus = false } = {}) {
  await chatPage.evaluate(({ agentId }) => {
    const store = window.Pinia.useChatStore();
    const sessionsStore = window.Pinia.useSessionsStore();
    const sessionId = 'workbench-session';
    const conversationId = 'workbench-conversation';
    const agent = {
      id: agentId,
      name: 'Workbench agent',
      online: true,
      status: 'ready',
      capabilities: ['terminal', 'file_editor', 'workbench_session_routes', 'work_center'],
    };

    sessionsStore.applySnapshot([{
      id: sessionId,
      name: 'Workbench session',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/test',
    }], agentId);
    sessionsStore.setActive(sessionId, agentId);

    store.agents = [agent];
    store.currentAgent = agentId;
    store.currentAgentInfo = agent;
    store._hasHandledAgentList = true;
    store._hasHandledYeaftSessionHydrate = true;
    store.yeaftSessionHydrateError = null;
    store.yeaftHistoryLoadError = null;
    store.yeaftActiveSessionFilter = sessionId;
    store.yeaftSessionAgentById = { ...store.yeaftSessionAgentById, [sessionId]: agentId };
    store.yeaftConversationId = conversationId;
    store.yeaftConversationIdsByAgent = { ...store.yeaftConversationIdsByAgent, [agentId]: conversationId };
    store.messagesMap[conversationId] = [];
    store.activeConversations = [conversationId];
    store.currentView = 'yeaft';
  }, { agentId: mockAgent.agentId });

  mockAgent.send({
    type: 'session_list_updated',
    sessions: [{
      id: 'workbench-session',
      name: 'Workbench session',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/test',
    }],
  });

  await expect(chatPage.locator('.yeaft-main')).toBeVisible();
  if (closeSessionStatus) {
    const closeButton = chatPage.locator('.yeaft-session-status-close');
    await expect(closeButton).toBeVisible();
    await closeButton.click();
    await expect(closeButton).toHaveCount(0);
  }
  const workbenchButton = chatPage.locator('.yeaft-session-actions [aria-label="Workbench"]');
  await expect(workbenchButton).toBeVisible();
  await workbenchButton.click();
  await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);
}

function capability(panel, id) {
  return panel.locator(`[data-workbench-capability="${id}"]`);
}

async function openChatWorkbench(chatPage, mockAgent) {
  await chatPage.evaluate(({ agentId }) => {
    const store = window.Pinia.useChatStore();
    const conversationId = 'chat-workbench-conversation';
    const agent = {
      id: agentId,
      name: 'Workbench agent',
      online: true,
      status: 'ready',
      capabilities: ['terminal', 'file_editor', 'workbench_session_routes', 'work_center'],
    };
    store.agents = [agent];
    store.currentAgent = agentId;
    store.currentAgentInfo = agent;
    store.conversations = [{
      id: conversationId,
      agentId,
      agentName: agent.name,
      workDir: '/tmp/workbench',
      provider: 'copilot',
      capabilities: { clear: true, mcp: true },
      type: 'chat',
    }];
    store.messagesMap[conversationId] = [];
    store.activeConversations = [conversationId];
    store.currentWorkDir = '/tmp/workbench';
    store.currentView = 'chat';
  }, { agentId: mockAgent.agentId });

  const workbenchButton = chatPage.locator('.chat-header [aria-label="Workbench"]');
  await expect(workbenchButton).toBeVisible();
  await workbenchButton.click();
  await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);
}

test.describe('Workbench', () => {
  test('shows the Chat entry independently of provider capabilities', async ({ chatPage, mockAgent }) => {
    await openChatWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.workbench-capability-card')).toHaveCount(4);
  });

  test('opens a four-capability launcher instead of persistent tabs', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.workbench-capability-card')).toHaveCount(4);
    await expect(capability(panel, 'terminal')).toBeVisible();
    await expect(capability(panel, 'git')).toBeVisible();
    await expect(capability(panel, 'files')).toBeVisible();
    await expect(capability(panel, 'browser')).toBeVisible();
    await expect(panel.locator('.wb-tab')).toHaveCount(0);
    await expect(capability(panel, 'browser').locator('.workbench-capability-status')).toHaveText('Unavailable on this Agent');
    await expect.poll(() => mockAgent.messages().filter(message => [
      'terminal_create', 'git_status', 'list_directory', 'restore_file_tabs',
    ].includes(message.type)).length).toBe(0);
  });

  test('opens Terminal and closes it back to the launcher', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    const terminalCard = capability(panel, 'terminal');
    await terminalCard.focus();
    await terminalCard.press('Enter');
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    await expect(panel.locator('.workbench-header-title')).toHaveText('Terminal');
    await expect(panel.locator('.workbench-launcher')).toHaveCount(0);
    await expect(panel.locator('.workbench-view-close')).toBeFocused();

    const terminalRequest = await mockAgent.waitForMessage('terminal_create');
    expect(terminalRequest).toMatchObject({
      agentId: mockAgent.agentId,
      workDir: '/tmp/test',
      workbenchRoute: {
        runtimeProvider: 'yeaft',
        agentId: mockAgent.agentId,
        sessionId: 'workbench-session',
      },
    });
    expect(terminalRequest.workbenchRouteKey).toBe(`yeaft:${encodeURIComponent(mockAgent.agentId)}:workbench-session`);
    expect(terminalRequest.conversationId).toBe(`_workbench:${terminalRequest.workbenchRouteKey}`);

    await panel.locator('.workbench-view-close').press('Enter');
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.workbench-header-title')).toHaveText('Workbench');
    await expect(capability(panel, 'terminal')).toBeFocused();

    const createCount = mockAgent.messages('terminal_create').length;
    await capability(panel, 'terminal').press('Enter');
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    await expect.poll(() => mockAgent.messages('terminal_create').length).toBe(createCount);
  });

  test('resets route state when switching same-Agent Sessions and scopes Git and Files requests', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await capability(panel, 'terminal').click();
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    const terminalA = await mockAgent.waitForMessage('terminal_create');
    expect(terminalA.workbenchRoute?.sessionId).toBe('workbench-session');
    await panel.locator('.workbench-view-close').click();
    await capability(panel, 'git').click();
    await expect(panel.locator('.git-status-tab')).toBeVisible();
    const gitRequest = await mockAgent.waitForMessage('git_status');
    expect(gitRequest).toMatchObject({
      workDir: '/tmp/test',
      workbenchRoute: { runtimeProvider: 'yeaft', sessionId: 'workbench-session' },
    });

    const sessionB = {
      id: 'workbench-session-b',
      name: 'Workbench session B',
      roster: ['omni'],
      defaultVpId: 'omni',
      workDir: '/tmp/session-b',
    };
    mockAgent.send({
      type: 'session_list_updated',
      sessions: [{
        id: 'workbench-session', name: 'Workbench session', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test',
      }, sessionB],
    });
    await chatPage.evaluate(({ agentId, session }) => {
      const store = window.Pinia.useChatStore();
      const sessionsStore = window.Pinia.useSessionsStore();
      sessionsStore.applySnapshot([
        { id: 'workbench-session', name: 'Workbench session', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test' },
        session,
      ], agentId);
      sessionsStore.setActive(session.id, agentId);
      store.yeaftSessionAgentById = { ...store.yeaftSessionAgentById, [session.id]: agentId };
      store.yeaftActiveSessionFilter = session.id;
    }, { agentId: mockAgent.agentId, session: sessionB });

    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await expect(panel.locator('.git-status-tab')).toHaveCount(0);
    const terminalClose = await mockAgent.waitForMessage('terminal_close');
    expect(terminalClose).toMatchObject({
      terminalId: terminalA.terminalId,
      workbenchRoute: { sessionId: 'workbench-session' },
    });

    await capability(panel, 'terminal').click();
    const terminalB = await mockAgent.waitForMessage('terminal_create');
    expect(terminalB).toMatchObject({
      workDir: '/tmp/session-b',
      workbenchRoute: { sessionId: 'workbench-session-b' },
    });
    await panel.locator('.workbench-view-close').click();
    await capability(panel, 'files').click();
    await expect(panel.locator('.files-tab')).toBeVisible();
    const filesRequest = await mockAgent.waitForMessage('list_directory');
    expect(filesRequest).toMatchObject({
      workDir: '/tmp/session-b',
      workbenchRoute: {
        runtimeProvider: 'yeaft',
        agentId: mockAgent.agentId,
        sessionId: 'workbench-session-b',
      },
    });
    expect(filesRequest.workbenchRouteKey).toBe(`yeaft:${encodeURIComponent(mockAgent.agentId)}:workbench-session-b`);
  });

  test('keeps Browser discoverable without exposing a fake viewer', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await capability(panel, 'browser').click();
    await expect(panel.locator('.workbench-browser-view')).toBeVisible();
    await expect(panel.locator('.workbench-browser-view')).toContainText('Phase 0 runtime does not expose browser sessions');
    await expect(panel.locator('video')).toHaveCount(0);
    await expect(panel.locator('iframe')).toHaveCount(0);

    await panel.locator('.workbench-view-close').click();
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
  });

  test('maximizes across the conversation area and restores it', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const page = chatPage.locator('.yeaft-page');
    const main = chatPage.locator('.yeaft-main');
    const panel = chatPage.locator('.workbench-panel');
    const maximizeButton = panel.locator('.workbench-maximize-btn');
    await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize panel');

    const pageBox = await page.boundingBox();
    const sidebarBox = await chatPage.locator('.yeaft-sidebar').boundingBox();
    expect(pageBox).not.toBeNull();
    expect(sidebarBox).not.toBeNull();

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);

      await expect(panel.locator('.workbench-launcher')).toBeVisible();
      await maximizeButton.click();
      await expect(panel).toHaveClass(/maximized/);
      await expect(maximizeButton).toHaveAttribute('aria-label', 'Restore panel');
      await expect(main).toBeHidden();

      const maximizedBox = await panel.boundingBox();
      expect(maximizedBox).not.toBeNull();
      expect(maximizedBox.x).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1);
      expect(maximizedBox.width).toBeGreaterThanOrEqual(pageBox.width - sidebarBox.width - 2);

      await maximizeButton.click();
      await expect(panel).not.toHaveClass(/maximized/);
      await expect(panel).toHaveClass(/expanded/);
      await expect(maximizeButton).toHaveAttribute('aria-label', 'Maximize panel');
      await expect(main).toBeVisible();
    }
  });

  test('uses one launcher column at 320px without horizontal overflow', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 320, height: 720 });
    await openYeaftWorkbench(chatPage, mockAgent, { closeSessionStatus: true });

    const panel = chatPage.locator('.workbench-panel');
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox.x).toBeLessThanOrEqual(1);
    expect(panelBox.width).toBeGreaterThanOrEqual(318);
    await expect(panel.locator('.workbench-maximize-btn')).toBeVisible();
    await expect(panel.locator('.workbench-panel-close')).toBeVisible();

    const cards = panel.locator('.workbench-capability-card');
    const firstBox = await cards.nth(0).boundingBox();
    const secondBox = await cards.nth(1).boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(secondBox.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height - 1);

    const overflow = await panel.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('enters Files and uses a right-pointing control to hide the file tree', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await capability(panel, 'files').click();
    const showTreeButton = panel.locator('.file-tree-expand-btn');
    await expect(showTreeButton).toBeVisible();
    await showTreeButton.click();

    const hideTreeButton = panel.locator('.file-tree-header:not([style*="display: none"]) .file-tree-collapse-btn').last();
    await expect(hideTreeButton).toBeVisible();
    await expect(hideTreeButton.locator('path')).toHaveAttribute(
      'd',
      'M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z',
    );
  });

  test('closes the Workbench panel', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await panel.locator('.workbench-panel-close').click();
    await expect(panel).not.toHaveClass(/expanded/);
  });
});
