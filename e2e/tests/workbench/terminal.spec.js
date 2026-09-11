import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

async function openYeaftWorkbench(chatPage, mockAgent) {
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
  const workbenchButton = chatPage.locator('.yeaft-session-actions [aria-label="Workbench"]');
  await expect(workbenchButton).toBeVisible();
  await workbenchButton.click();
  await expect(chatPage.locator('.workbench-panel')).toHaveClass(/expanded/);
}

function capability(panel, id) {
  return panel.locator(`.workbench-add-menu-item[data-workbench-capability="${id}"]`);
}

async function openCapabilityLauncher(panel) {
  const addButton = panel.locator('.workbench-add-btn');
  await expect(addButton).toHaveAttribute('aria-expanded', 'false');
  await addButton.click();
  await expect(addButton).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('.workbench-add-menu')).toBeVisible();
}

async function openCapability(panel, id) {
  await openCapabilityLauncher(panel);
  await capability(panel, id).click();
}

async function closeActiveWorkbenchItem(panel) {
  await panel.locator('.workbench-item-tab.active .workbench-item-close').click();
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
    await openCapabilityLauncher(panel);
    await expect(panel.locator('.workbench-add-menu-item')).toHaveCount(4);
  });

  test('starts on the four-capability chooser without opening a tool', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    const launcher = panel.locator('.workbench-launcher');
    await expect(launcher).toBeVisible();
    await expect(panel.locator('.workbench-capability-card')).toHaveCount(4);
    await expect(panel.locator('.workbench-item-tab')).toHaveCount(0);
    await expect(panel.locator('.workbench-capability-host')).toBeHidden();
    expect(await launcher.evaluate(element => {
      const launcherRect = element.getBoundingClientRect();
      const panelRect = element.closest('.workbench-panel').getBoundingClientRect();
      return Math.abs(launcherRect.bottom - panelRect.bottom) <= 1;
    })).toBe(true);
    await openCapabilityLauncher(panel);
    await expect(panel.locator('.workbench-add-menu-item')).toHaveCount(4);
    await expect(capability(panel, 'terminal')).toBeVisible();
    await expect(capability(panel, 'git')).toBeVisible();
    await expect(capability(panel, 'files')).toBeVisible();
    await expect(capability(panel, 'browser')).toBeVisible();
    await expect(capability(panel, 'browser').locator('small')).toHaveText('Unavailable on this Agent');
    await expect.poll(() => mockAgent.messages().filter(message => [
      'terminal_create', 'git_status', 'list_directory', 'restore_file_tabs',
    ].includes(message.type)).length).toBe(0);

    await capability(panel, 'git').click();
    await expect(panel.locator('.git-status-tab')).toBeVisible();
    await closeActiveWorkbenchItem(panel);
    await expect(launcher).toBeVisible();
    await expect(panel.locator('.workbench-capability-host')).toBeHidden();
    expect(await launcher.evaluate(element => {
      const launcherRect = element.getBoundingClientRect();
      const panelRect = element.closest('.workbench-panel').getBoundingClientRect();
      return Math.abs(launcherRect.bottom - panelRect.bottom) <= 1;
    })).toBe(true);
  });

  test('keeps open-file controls reachable with overflowing tabs and supports batch close actions', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await openCapability(panel, 'files');
    await expect(panel.locator('.files-tab')).toBeVisible();
    const routeKey = `yeaft:${encodeURIComponent(mockAgent.agentId)}:workbench-session`;
    await chatPage.evaluate(({ agentId, routeKey }) => {
      for (let index = 0; index < 12; index++) {
        window.dispatchEvent(new CustomEvent('workbench-open-file-in-active-view', {
          detail: {
            filePath: `docs/section-${index}/a-very-long-open-file-name-${index}.md`,
            agentId,
            conversationId: `_workbench:${routeKey}`,
            workDir: '/tmp/test',
            workbenchRouteKey: routeKey,
          },
        }));
      }
    }, { agentId: mockAgent.agentId, routeKey });

    const tabs = panel.getByRole('tab');
    const overflowButton = panel.locator('.workbench-open-items-btn');
    await expect(panel.getByRole('tablist')).toBeVisible();
    await expect(overflowButton).toBeVisible();
    const addButton = panel.locator('.workbench-add-btn');
    await expect(addButton).toBeVisible();
    await expect.poll(() => tabs.count()).toBeGreaterThan(0);
    await expect.poll(() => tabs.count()).toBeLessThan(12);
    expect(await panel.locator('.workbench-tab-rail').evaluate(element => (
      element.scrollWidth <= element.clientWidth + 1
    ))).toBe(true);
    expect(await addButton.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const headerRect = element.closest('.workbench-header').getBoundingClientRect();
      return rect.right <= headerRect.right
        && rect.left >= headerRect.left
        && Math.abs((rect.top + rect.bottom - headerRect.top - headerRect.bottom) / 2) <= 1;
    })).toBe(true);

    await overflowButton.click();
    const hiddenMenu = panel.locator('.workbench-open-items-menu');
    const hiddenItems = hiddenMenu.getByRole('menuitem');
    await expect.poll(async () => await tabs.count() + await hiddenItems.count()).toBe(12);
    await expect(hiddenItems.first()).toBeFocused();
    await hiddenItems.first().press('Escape');
    await expect(hiddenMenu).toHaveCount(0);
    await expect(overflowButton).toBeFocused();

    await overflowButton.press('ArrowDown');
    await expect(hiddenItems.first()).toBeFocused();
    await hiddenItems.first().press('ArrowUp');
    await expect(hiddenItems.last()).toBeFocused();
    await hiddenItems.last().press('Home');
    await expect(hiddenItems.first()).toBeFocused();
    await hiddenItems.first().press('End');
    await expect(hiddenItems.last()).toBeFocused();
    await hiddenItems.last().press('Escape');
    await expect(hiddenMenu).toHaveCount(0);
    await expect(overflowButton).toBeFocused();

    await overflowButton.press('ArrowDown');
    await expect(hiddenItems.first()).toBeFocused();
    await hiddenItems.first().press('Tab');
    await expect(hiddenMenu).toHaveCount(0);
    await expect(panel.locator('.workbench-maximize-btn')).toBeFocused();

    await overflowButton.focus();
    await overflowButton.press('ArrowUp');
    await expect(hiddenItems.last()).toBeFocused();
    await hiddenItems.last().press('Shift+Tab');
    await expect(hiddenMenu).toHaveCount(0);
    await expect(overflowButton).toBeFocused();

    await overflowButton.press('ArrowUp');
    await expect(hiddenItems.last()).toBeFocused();
    const hiddenLabel = (await hiddenItems.last().locator('.workbench-menu-item-label').textContent()).trim();
    await hiddenItems.last().press('Enter');
    await expect(panel.locator('.workbench-item-tab.active .workbench-item-label')).toHaveText(hiddenLabel.replace(/^●\s*/, ''));

    await panel.locator('.workbench-item-tab.active .workbench-item-close').click();
    if (await overflowButton.isVisible()) {
      await overflowButton.click();
      expect(await tabs.count() + await hiddenItems.count()).toBe(11);
      await overflowButton.click();
    } else {
      await expect(tabs).toHaveCount(11);
    }

    await addButton.focus();
    await addButton.press('ArrowDown');
    const addMenu = panel.locator('.workbench-add-menu');
    await expect(addMenu.getByRole('menuitem').first()).toBeFocused();
    await addMenu.getByRole('menuitem').first().press('End');
    await expect(addMenu.getByRole('menuitem').last()).toBeFocused();
    await addMenu.getByRole('menuitem').last().press('Escape');
    await expect(addMenu).toHaveCount(0);
    await expect(addButton).toBeFocused();
  });

  test('closes Terminal resources and keeps the launcher reachable at 320px', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 320, height: 640 });
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    const addButton = panel.locator('.workbench-add-btn');
    await addButton.focus();
    await addButton.press('ArrowDown');
    const addMenu = panel.locator('.workbench-add-menu');
    await expect(addMenu).toBeVisible();
    await expect(addMenu.getByRole('menuitem').first()).toBeFocused();
    await expect.poll(() => addMenu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth + 1;
    })).toBe(true);
    await addMenu.getByRole('menuitem').first().press('End');
    await expect(addMenu.getByRole('menuitem').last()).toBeFocused();
    await addMenu.getByRole('menuitem').last().press('Home');
    await expect(addMenu.getByRole('menuitem').first()).toBeFocused();
    await addMenu.getByRole('menuitem').first().press('Escape');
    await expect(addMenu).toHaveCount(0);
    await expect(addButton).toBeFocused();

    await addButton.press('ArrowUp');
    await expect(addMenu.getByRole('menuitem').last()).toBeFocused();
    await addMenu.getByRole('menuitem').last().press('ArrowDown');
    await expect(addMenu.getByRole('menuitem').first()).toBeFocused();
    await addMenu.getByRole('menuitem').first().press('Enter');
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    await expect(panel.locator('.workbench-item-tab.active .workbench-item-select')).toContainText('terminal', { ignoreCase: true });

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

    await panel.locator('.workbench-item-tab.active .workbench-item-close').click();
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    const terminalClose = await mockAgent.waitForMessage('terminal_close');
    expect(terminalClose).toMatchObject({ terminalId: terminalRequest.terminalId });

    const createCount = mockAgent.messages('terminal_create').length;
    await panel.locator('.workbench-add-btn').click();
    await capability(panel, 'terminal').press('Enter');
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    await expect.poll(() => mockAgent.messages('terminal_create').length).toBe(createCount + 1);
  });

  test('keeps route terminals alive when switching same-Agent Sessions and scopes Git and Files requests', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await openCapability(panel, 'terminal');
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    const terminalA = await mockAgent.waitForMessage('terminal_create');
    expect(terminalA.workbenchRoute?.sessionId).toBe('workbench-session');

    await openCapability(panel, 'git');
    await expect(panel.locator('.git-status-tab')).toBeVisible();
    const gitRequest = await mockAgent.waitForMessage('git_status');
    expect(gitRequest).toMatchObject({
      workDir: '/tmp/test',
      workbenchRoute: { runtimeProvider: 'yeaft', sessionId: 'workbench-session' },
    });
    await panel.getByRole('tab', { name: /terminal/i }).click();

    const sessionA = {
      id: 'workbench-session', name: 'Workbench session', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test',
    };
    const sessionB = {
      id: 'workbench-session-b', name: 'Workbench session B', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/session-b',
    };
    mockAgent.send({ type: 'session_list_updated', sessions: [sessionA, sessionB] });
    await chatPage.evaluate(({ agentId, sessions, activeId }) => {
      const store = window.Pinia.useChatStore();
      const sessionsStore = window.Pinia.useSessionsStore();
      sessionsStore.applySnapshot(sessions, agentId);
      sessionsStore.setActive(activeId, agentId);
      store.yeaftSessionAgentById = {
        ...store.yeaftSessionAgentById,
        ...Object.fromEntries(sessions.map(session => [session.id, agentId])),
      };
      store.yeaftActiveSessionFilter = activeId;
    }, { agentId: mockAgent.agentId, sessions: [sessionA, sessionB], activeId: sessionB.id });

    await expect(panel).not.toHaveClass(/expanded/);
    await expect(panel.locator('.terminal-tab')).toHaveCount(0);
    await expect.poll(() => mockAgent.messages('terminal_close')
      .filter(message => message.terminalId === terminalA.terminalId).length).toBe(0);

    await chatPage.getByRole('button', { name: 'Workbench' }).click();
    await openCapability(panel, 'terminal');
    const terminalB = await mockAgent.waitForMessage('terminal_create');
    expect(terminalB).toMatchObject({
      workDir: '/tmp/session-b',
      workbenchRoute: { sessionId: 'workbench-session-b' },
    });
    await openCapability(panel, 'files');
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

    await chatPage.evaluate(({ agentId, activeId }) => {
      const store = window.Pinia.useChatStore();
      const sessionsStore = window.Pinia.useSessionsStore();
      sessionsStore.setActive(activeId, agentId);
      store.yeaftActiveSessionFilter = activeId;
    }, { agentId: mockAgent.agentId, activeId: sessionA.id });
    await expect(panel).toHaveClass(/expanded/);
    await expect(panel.locator('.terminal-tab')).toBeVisible();
    await expect(panel.getByRole('tab', { name: /terminal/i })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => mockAgent.messages('terminal_create').length).toBe(2);
    await expect.poll(() => mockAgent.messages('terminal_close')
      .filter(message => [terminalA.terminalId, terminalB.terminalId].includes(message.terminalId)).length).toBe(0);
  });

  test('preserves expanded folders on refresh and removes a folder that disappeared', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);
    const panel = chatPage.locator('.workbench-panel');
    await openCapability(panel, 'files');
    await expect(panel.locator('.files-tab')).toBeVisible();

    const replyListing = (request, entries, error = undefined) => {
      mockAgent.send({
        ...request,
        type: 'directory_listing',
        entries,
        error,
      });
    };
    const rootRequest = await mockAgent.waitForMessage('list_directory');
    replyListing(rootRequest, [
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file', size: 64 },
    ]);

    const srcRow = panel.locator('.tree-item', { hasText: 'src' });
    await expect(srcRow).toBeVisible();
    await srcRow.click();
    const srcRequest = await mockAgent.waitForMessage('list_directory');
    replyListing(srcRequest, [
      { name: 'components', type: 'directory' },
      { name: 'index.js', type: 'file', size: 32 },
    ]);

    const componentsRow = panel.locator('.tree-item', { hasText: 'components' });
    await expect(componentsRow).toBeVisible();
    await componentsRow.click();
    const componentsRequest = await mockAgent.waitForMessage('list_directory');
    replyListing(componentsRequest, [{ name: 'App.js', type: 'file', size: 128 }]);
    await expect(panel.locator('.tree-item', { hasText: 'App.js' })).toBeVisible();

    const refreshButton = panel.getByRole('button', { name: 'Refresh' });
    let listRequestCount = mockAgent.messages('list_directory').length;
    await refreshButton.click();
    await expect.poll(() => mockAgent.messages('list_directory').length).toBe(listRequestCount + 3);
    const firstRefresh = mockAgent.messages('list_directory').slice(listRequestCount);
    const firstByPath = Object.fromEntries(firstRefresh.map(request => [request.dirPath, request]));
    expect(Object.keys(firstByPath).sort()).toEqual(['/tmp/test', '/tmp/test/src', '/tmp/test/src/components']);
    // Respond out of order: open child state must survive until its parents arrive.
    replyListing(firstByPath['/tmp/test/src/components'], [{ name: 'App.js', type: 'file', size: 128 }]);
    replyListing(firstByPath['/tmp/test/src'], [
      { name: 'components', type: 'directory' },
      { name: 'index.js', type: 'file', size: 32 },
    ]);
    replyListing(firstByPath['/tmp/test'], [
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file', size: 64 },
    ]);
    await expect(srcRow).toHaveClass(/tree-expanded/);
    await expect(componentsRow).toHaveClass(/tree-expanded/);
    await expect(panel.locator('.tree-item', { hasText: 'App.js' })).toBeVisible();

    listRequestCount = mockAgent.messages('list_directory').length;
    await refreshButton.click();
    await expect.poll(() => mockAgent.messages('list_directory').length).toBe(listRequestCount + 3);
    const secondRefresh = mockAgent.messages('list_directory').slice(listRequestCount);
    const secondByPath = Object.fromEntries(secondRefresh.map(request => [request.dirPath, request]));
    replyListing(secondByPath['/tmp/test'], [
      { name: 'src', type: 'directory' },
      { name: 'README.md', type: 'file', size: 64 },
    ]);
    replyListing(secondByPath['/tmp/test/src'], [
      { name: 'index.js', type: 'file', size: 32 },
      { name: 'new.js', type: 'file', size: 48 },
    ]);
    // The now-missing child can still finish after its parent removed it.
    replyListing(secondByPath['/tmp/test/src/components'], [], 'Directory does not exist');

    await expect(srcRow).toHaveClass(/tree-expanded/);
    await expect(panel.locator('.tree-item', { hasText: 'new.js' })).toBeVisible();
    await expect(panel.locator('.tree-item', { hasText: 'components' })).toHaveCount(0);
    await expect(panel.locator('.tree-item', { hasText: 'App.js' })).toHaveCount(0);
  });

  for (const theme of ['light', 'dark']) {
    test(`preserves resized Files width across Session switches and reopen (${theme})`, async ({ chatPage, mockAgent }) => {
      await chatPage.setViewportSize({ width: 1440, height: 900 });
      await openYeaftWorkbench(chatPage, mockAgent);
      await chatPage.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      const panel = chatPage.locator('.workbench-panel');
      await openCapability(panel, 'files');
      await expect(panel.locator('.files-tab')).toBeVisible();
      const handle = panel.locator(':scope > .resize-handle');
      // Wait for the opening transition before measuring the drag origin.
      await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBeGreaterThan(300);
      await chatPage.waitForTimeout(400);
      const initial = await panel.boundingBox();
      const grip = await handle.boundingBox();
      await chatPage.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await chatPage.mouse.down();
      await chatPage.mouse.move(grip.x + grip.width / 2 - 180, grip.y + grip.height / 2, { steps: 10 });
      await chatPage.mouse.up();
      await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(initial.width + 100);
      await chatPage.waitForTimeout(400);
      const resized = (await panel.boundingBox()).width;
      const switchSession = async (sessionId) => {
        await chatPage.evaluate(({ agentId, sessionId }) => {
          const store = window.Pinia.useChatStore();
          const sessions = window.Pinia.useSessionsStore();
          sessions.applySnapshot(['workbench-session', 'layout-session-b'].map(id => ({
            id, name: id, roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test',
          })), agentId);
          sessions.setActive(sessionId, agentId);
          store.yeaftSessionAgentById = { ...store.yeaftSessionAgentById, [sessionId]: agentId };
          store.yeaftActiveSessionFilter = sessionId;
        }, { agentId: mockAgent.agentId, sessionId });
      };
      await switchSession('layout-session-b');
      await expect(panel).not.toHaveClass(/expanded/);
      await chatPage.waitForTimeout(400);
      await switchSession('workbench-session');
      await expect(panel.locator('.files-tab')).toBeVisible();
      await expect.poll(async () => Math.abs((await panel.boundingBox()).width - resized)).toBeLessThan(3);
      await chatPage.getByRole('button', { name: 'Workbench', exact: true }).click();
      await expect(panel).not.toHaveClass(/expanded/);
      await chatPage.waitForTimeout(400);
      await chatPage.getByRole('button', { name: 'Workbench', exact: true }).click();
      await expect.poll(async () => Math.abs((await panel.boundingBox()).width - resized)).toBeLessThan(3);
      await chatPage.setViewportSize({ width: 320, height: 640 });
      await expect.poll(async () => (await panel.boundingBox()).width).toBeLessThanOrEqual(320);
      await chatPage.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(async () => Math.abs((await panel.boundingBox()).width - resized)).toBeLessThan(3);
    });
  }

  test('keeps Browser discoverable without exposing a fake viewer when the Agent capability is absent', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await openCapabilityLauncher(panel);
    await capability(panel, 'browser').click();
    await expect(panel.locator('.workbench-browser-view')).toBeVisible();
    await expect(panel.locator('.workbench-browser-view')).toContainText('Browser is disabled by the administrator');
    await expect(panel.locator('video')).toHaveCount(0);
    await expect(panel.locator('iframe')).toHaveCount(0);

    await closeActiveWorkbenchItem(panel);
    await expect(panel.locator('.workbench-launcher')).toBeVisible();
    await panel.locator('.workbench-add-btn').click();
    await expect(panel.locator('.workbench-add-menu')).toBeVisible();
  });

  test('enables Browser once with real progress and opens the viewer automatically', async ({ chatPage, mockAgent }) => {
    mockAgent.pauseBrowserRuntimeInstall();
    await openYeaftWorkbench(chatPage, mockAgent);
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      const agent = store.agents.find(item => item.id === agentId);
      agent.capabilities = [
        ...new Set([
          ...(agent.capabilities || []).filter(capability => ![
            'browser_runtime', 'browser_webrtc', 'browser_capture_tab',
          ].includes(capability)),
          'browser_runtime_setup',
        ]),
      ];
      store.currentAgentInfo = agent;
    }, mockAgent.agentId);

    const panel = chatPage.locator('.workbench-panel');
    await openCapabilityLauncher(panel);
    await expect(capability(panel, 'browser').locator('small')).toHaveText('Enable required');
    const installsBefore = mockAgent.messages('browser_runtime_install').length;
    await capability(panel, 'browser').click();
    const status = await mockAgent.waitForMessage('browser_runtime_status');
    expect(status).toMatchObject({
      agentId: mockAgent.agentId,
      requestId: expect.any(String),
      serverIdentity: expect.objectContaining({ ownerUserId: expect.any(String) }),
    });
    await expect(panel.locator('.browser-setup-stage')).toBeVisible();
    await expect(panel.locator('.browser-setup-stage')).toContainText('Browser needs a pinned Chrome for Testing');
    await expect(panel.locator('.browser-setup-stage')).toContainText('184.3 MiB');
    await expect(panel.locator('.browser-setup-stage .btn-primary')).toContainText('Enable Browser');
    expect(mockAgent.messages('browser_runtime_install')).toHaveLength(installsBefore);

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await chatPage.setViewportSize({ width: 320, height: 720 });
      await expect(chatPage.locator('html')).toHaveAttribute('data-theme', theme);
      const overflow = await panel.locator('.browser-setup-stage').evaluate(element => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
      await expect(panel.locator('.browser-setup-stage .btn-primary')).toBeVisible();
    }

    await panel.locator('.browser-setup-stage .btn-primary').click();
    const install = await mockAgent.waitForMessage('browser_runtime_install');
    expect(install).toMatchObject({
      agentId: mockAgent.agentId,
      confirmedBuildId: '151.0.7922.71',
      confirmedDownloadBytes: 193_285_407,
      serverIdentity: expect.objectContaining({ ownerUserId: expect.any(String) }),
    });
    const progress = panel.locator('.browser-install-progress');
    await expect(progress).toHaveAttribute('aria-valuenow', '50');
    await expect(progress).toHaveAttribute('aria-valuetext', '92.2 MiB of 184.3 MiB');
    await expect(panel.locator('.browser-install-percent')).toHaveText('50%');

    mockAgent.completeBrowserRuntimeInstall();
    await expect(panel.locator('.browser-start-form')).toBeVisible();
    await expect(panel.locator('.browser-setup-stage')).toHaveCount(0);
    expect(mockAgent.messages('browser_runtime_install')).toHaveLength(installsBefore + 1);
    expect(mockAgent.messages('browser_runtime_enable')).toHaveLength(0);
    expect(mockAgent.messages('browser_session_create')).toHaveLength(0);
  });

  test('keeps a failed Browser install visible after automatic status refresh and allows retry', async ({ chatPage, mockAgent }) => {
    const checksumError = 'Managed Chrome archive checksum mismatch for chrome-linux64.zip';
    mockAgent.failBrowserRuntimeInstall(checksumError);
    await openYeaftWorkbench(chatPage, mockAgent);
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      const agent = store.agents.find(item => item.id === agentId);
      agent.capabilities = [
        ...new Set([
          ...(agent.capabilities || []).filter(capability => ![
            'browser_runtime', 'browser_webrtc', 'browser_capture_tab',
          ].includes(capability)),
          'browser_runtime_setup',
        ]),
      ];
      store.currentAgentInfo = agent;
    }, mockAgent.agentId);

    const panel = chatPage.locator('.workbench-panel');
    await openCapabilityLauncher(panel);
    await capability(panel, 'browser').click();
    await mockAgent.waitForMessage('browser_runtime_status');
    const installButton = panel.locator('.browser-setup-stage .btn-primary');
    await expect(installButton).toBeEnabled();
    await installButton.click();
    await mockAgent.waitForMessage('browser_runtime_install');
    const refresh = await mockAgent.waitForMessage('browser_runtime_status');
    expect(refresh).toMatchObject({ agentId: mockAgent.agentId, requestId: expect.any(String) });

    await expect(panel.locator('.browser-setup-error')).toHaveText(checksumError);
    await expect(installButton).toBeEnabled();
    const attempts = mockAgent.messages('browser_runtime_install').length;
    await installButton.click();
    await expect.poll(() => mockAgent.messages('browser_runtime_install').length).toBe(attempts + 1);
  });

  test('creates a Browser Session and mounts the generation-fenced WebRTC viewer', async ({ chatPage, mockAgent }) => {
    mockAgent.browserRuntimeReady = true;
    await openYeaftWorkbench(chatPage, mockAgent);
    await chatPage.evaluate(agentId => {
      class E2EPeerConnection {
        constructor(config) {
          this.config = config;
          this.localDescription = null;
          this.remoteDescription = null;
          this.connectionState = 'new';
          this.onicecandidate = null;
          this.onconnectionstatechange = null;
          this.ontrack = null;
        }
        async setRemoteDescription(description) { this.remoteDescription = description; }
        async createAnswer() { return { type: 'answer', sdp: 'v=0\\r\\no=web-e2e 1 1 IN IP4 127.0.0.1\\r\\ns=Yeaft E2E\\r\\nt=0 0\\r\\n' }; }
        async setLocalDescription(description) { this.localDescription = description; }
        async addIceCandidate() {}
        close() { this.connectionState = 'closed'; }
      }
      window.RTCPeerConnection = E2EPeerConnection;
      const store = window.Pinia.useChatStore();
      const agent = store.agents.find(item => item.id === agentId);
      agent.capabilities = [
        ...new Set([
          ...(agent.capabilities || []),
          'browser_runtime', 'browser_webrtc', 'browser_capture_tab',
        ]),
      ];
      store.currentAgentInfo = agent;
    }, mockAgent.agentId);

    const panel = chatPage.locator('.workbench-panel');
    await openCapabilityLauncher(panel);
    await expect(capability(panel, 'browser').locator('small')).toHaveText('Available');
    await capability(panel, 'browser').click();
    await expect(panel.locator('.browser-panel')).toBeVisible();
    await expect(panel.locator('.browser-start-form')).toBeVisible();
    await panel.locator('.browser-start-form input').fill('https://example.com/');
    await panel.locator('.browser-start-form .btn-primary').click();
    await expect(panel.locator('.browser-video')).toBeVisible();
    await expect(panel.locator('iframe')).toHaveCount(0);

    const list = await mockAgent.waitForMessage('browser_session_list');
    expect(list).toMatchObject({
      agentId: mockAgent.agentId,
      requestId: expect.any(String),
      serverIdentity: expect.objectContaining({ ownerUserId: expect.any(String) }),
    });
    const create = await mockAgent.waitForMessage('browser_session_create');
    expect(create).toMatchObject({
      agentId: mockAgent.agentId,
      requestId: expect.any(String),
      sourceRef: { kind: 'yeaft-session', sessionId: 'workbench-session' },
    });
    expect(create).not.toHaveProperty('_requestClientId');
    const prepare = await mockAgent.waitForMessage('browser_peer_prepare');
    expect(prepare).toMatchObject({
      browserSessionId: expect.any(String),
      peerId: expect.any(String),
      connectionGeneration: 1,
      serverIdentity: expect.objectContaining({ clientId: expect.any(String) }),
    });
    const answer = await mockAgent.waitForMessage('browser_peer_answer');
    expect(answer).toMatchObject({
      browserSessionId: prepare.browserSessionId,
      peerId: prepare.peerId,
      connectionGeneration: prepare.connectionGeneration,
      description: { type: 'answer', sdp: expect.stringContaining('web-e2e') },
    });

    const detachCount = mockAgent.messages('browser_peer_detach').length;
    await panel.locator('.browser-end-button').click();
    const close = await mockAgent.waitForMessage('browser_session_close');
    expect(close.browserSessionId).toBe(prepare.browserSessionId);
    expect(close.expectedRevision).toBe(2);
    expect(mockAgent.messages('browser_peer_detach')).toHaveLength(detachCount);
    await expect(panel.locator('.browser-video')).toHaveCount(0);
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

  test('fits all four launcher entries in one 320px column without scrolling', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 320, height: 720 });
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    const launcher = panel.locator('.workbench-launcher');
    await expect(launcher).toBeVisible();
    await expect(panel.locator('.workbench-capability-card')).toHaveCount(4);
    await expect(panel.locator('.workbench-capability-host')).toBeHidden();
    const launcherGeometry = await launcher.evaluate(element => {
      const launcherRect = element.getBoundingClientRect();
      const panelRect = element.closest('.workbench-panel').getBoundingClientRect();
      return {
        fillsPanel: Math.abs(launcherRect.bottom - panelRect.bottom) <= 1,
        // Four entries are the whole chooser; a phone viewport must show them
        // without a scroll step the user has to discover.
        scrollable: element.scrollHeight > element.clientHeight,
        noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
      };
    });
    expect(launcherGeometry).toEqual({
      fillsPanel: true,
      scrollable: false,
      noHorizontalOverflow: true,
    });
    // Every entry, including the last, must be fully inside the viewport.
    const cards = panel.locator('.workbench-capability-card');
    const cardCount = await cards.count();
    for (let index = 0; index < cardCount; index += 1) {
      const cardBox = await cards.nth(index).boundingBox();
      expect(cardBox).not.toBeNull();
      expect(cardBox.y).toBeGreaterThanOrEqual(0);
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(720);
    }

    await openCapabilityLauncher(panel);
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox.x).toBeLessThanOrEqual(1);
    expect(panelBox.width).toBeGreaterThanOrEqual(318);
    await expect(panel.locator('.workbench-maximize-btn')).toBeVisible();
    await expect(panel.locator('.workbench-panel-close')).toBeVisible();

    const menu = panel.locator('.workbench-add-menu');
    const items = menu.locator('.workbench-add-menu-item');
    await expect(items).toHaveCount(4);
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(321);

    const overflow = await panel.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('opens Files with the tree visible and uses a right-pointing control to hide it', async ({ chatPage, mockAgent }) => {
    await openYeaftWorkbench(chatPage, mockAgent);

    const panel = chatPage.locator('.workbench-panel');
    await openCapability(panel, 'files');
    await expect(panel.locator('.files-tab')).toBeVisible();
    await expect(panel.locator('.file-tree-expand-btn')).toHaveCount(0);

    await expect(panel.locator('.file-col-placeholder')).toBeVisible();
    await expect(panel.locator('.file-col-tree')).toBeVisible();

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
