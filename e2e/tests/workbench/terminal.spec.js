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

test.describe('Workbench', () => {

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

});
