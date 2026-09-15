import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

// Use the real durable owner/catalog path, not ownerless development snapshots.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true' } });

for (const scenario of [
  { entry: 'header', project: false, width: 1280, theme: 'light' },
  { entry: 'sidebar', project: true, width: 1280, theme: 'dark' },
  { entry: 'header', project: true, width: 320, theme: 'light' },
  { entry: 'header', project: true, width: 320, theme: 'dark' },
]) {
  test(`Session fork: ${scenario.entry}, project=${scenario.project}, ${scenario.width}px ${scenario.theme}`, async ({ chatPage: page, mockAgent }, testInfo) => {
    const source = {
      id: 'fork-source', name: 'Original Session with a long title',
      roster: ['omni', 'reviewer'], defaultVpId: 'reviewer',
      announcement: 'Keep this announcement', workDir: '/tmp/test',
      config: { model: 'provider/model', modelEffort: 'high' },
      createdAt: new Date().toISOString(), metadataUpdatedAt: new Date().toISOString(),
    };
    const copied = { ...source, id: 'fork-target', name: `${source.name} copy` };
    const sendSnapshot = sessions => mockAgent.send({
      type: 'yeaft_output', event: { type: 'session_list_updated', sessions },
    });
    sendSnapshot([source]);
    await expect.poll(() => page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sessionCatalog
      .some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId),
    { agentId: mockAgent.agentId, sessionId: source.id })).toBe(true);
    await page.evaluate(({ agentId, sourceId, theme }) => {
      document.documentElement.setAttribute('data-theme', theme);
      const store = window.Pinia.useChatStore();
      store.openCatalogSession(store.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sourceId));
    }, { agentId: mockAgent.agentId, sourceId: source.id, theme: scenario.theme });

    let projectId = null;
    if (scenario.project) {
      projectId = await page.evaluate(async ({ agentId, sourceId }) => {
        const store = window.Pinia.useChatStore();
        const created = await store.mutateProject('create', { name: 'Fork Project' }, agentId);
        if (!created.ok) throw new Error(JSON.stringify(created));
        const projectId = created.result.id;
        const instruction = await store.mutateProject('update_instruction', { projectId, instruction: 'Keep the Project instruction' }, agentId);
        const moved = await store.mutateProject('move_session', { projectId, sessionId: sourceId }, agentId);
        if (!instruction.ok || !moved.ok) throw new Error('Could not prepare Project');
        return projectId;
      }, { agentId: mockAgent.agentId, sourceId: source.id });
    }
    await page.setViewportSize({ width: scenario.width, height: 800 });
    // Close the mobile sidebar through the same state the toggle controls.
    await page.evaluate(() => { window.Pinia.useChatStore().sessionSidebarOpen = false; });
    const headerFork = page.getByRole('button', { name: 'Copy session', exact: true });
    await expect(headerFork).toBeVisible();
    await expect(headerFork).toBeEnabled();
    await headerFork.focus();
    await expect(headerFork).toBeFocused();
    await expect(headerFork.locator('svg')).toBeVisible();
    await expect(headerFork.locator('span')).toHaveCount(0);
    const geometry = await headerFork.evaluate(button => {
      const header = button.closest('.yeaft-topbar');
      const search = header.querySelector('.yeaft-search-btn');
      const rect = button.getBoundingClientRect();
      const searchRect = search.getBoundingClientRect();
      const title = header.querySelector('.yeaft-topbar-context').getBoundingClientRect();
      const styles = getComputedStyle(button);
      return {
        right: rect.right, left: rect.left, width: rect.width, height: rect.height,
        searchWidth: searchRect.width, searchHeight: searchRect.height,
        titleWidth: title.width, overflow: header.scrollWidth - header.clientWidth,
        outlineStyle: styles.outlineStyle, outlineWidth: styles.outlineWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(scenario.width);
    expect(geometry.width).toBe(geometry.searchWidth);
    expect(geometry.height).toBe(geometry.searchHeight);
    expect(geometry.outlineStyle).toBe('solid');
    expect(parseFloat(geometry.outlineWidth)).toBeGreaterThan(0);
    expect(geometry.titleWidth).toBeGreaterThan(80);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('fork-control.png') });

    // Running state is Agent/session-scoped; reconnect disables the action too.
    await page.evaluate(({ agentId, sessionId }) => {
      window.Pinia.useChatStore().yeaftProcessingSessions = { [`${agentId}\u001f${sessionId}`]: true };
    }, { agentId: mockAgent.agentId, sessionId: source.id });
    await expect(headerFork).toBeDisabled();
    await page.evaluate(() => {
      const store = window.Pinia.useChatStore();
      store.yeaftProcessingSessions = {};
      store.connectionState = 'reconnecting';
    });
    await expect(headerFork).toBeDisabled();
    await page.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
    await expect(headerFork).toBeEnabled();

    let observer = null;
    if (scenario.entry === 'sidebar') {
      observer = await page.context().newPage();
      await observer.goto(page.url());
      await expect.poll(() => observer.evaluate(({ agentId, sessionId }) =>
        window.Pinia?.useChatStore().sessionCatalog.some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId),
      { agentId: mockAgent.agentId, sessionId: source.id })).toBe(true);
      await observer.evaluate(({ agentId, sessionId }) => {
        const store = window.Pinia.useChatStore();
        store.openCatalogSession(store.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
      }, { agentId: mockAgent.agentId, sessionId: source.id });
    }
    let trigger = headerFork;
    if (scenario.entry === 'sidebar') {
      const sourceRow = page.locator('.session-item.active');
      await sourceRow.hover();
      await sourceRow.locator('.session-dots-btn').click();
      trigger = page.locator('.session-menu-floating .session-menu-item', { hasText: 'Copy session' });
      await expect(trigger).toBeVisible();
    }
    const requestPromise = mockAgent.waitForMessage('yeaft_copy_session');
    await trigger.click();
    await expect.poll(() => page.evaluate(() => !!window.Pinia.useChatStore().sessionForkPendingKey)).toBe(true);
    expect(await page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().copyCatalogSession({
      routeRef: { runtimeProvider: 'yeaft', agentId, sessionId },
    }), { agentId: mockAgent.agentId, sessionId: source.id })).toMatchObject({ error: { code: 'fork_pending' } });
    const request = await requestPromise;
    expect(request.sessionId).toBe(source.id);
    await expect(headerFork).toBeDisabled();
    await expect(headerFork).toHaveAttribute('aria-busy', 'true');
    expect(mockAgent._messageHistory.filter(msg => msg.type === 'yeaft_copy_session')).toHaveLength(1);
    mockAgent.send({
      type: 'yeaft_output', event: {
        type: 'session_crud_result', op: 'copy', ok: true,
        requestId: request.requestId, sourceSessionId: source.id, session: copied,
      },
    });
    sendSnapshot([source, copied]);
    await expect.poll(() => page.evaluate(() => ({
      route: window.Pinia.useChatStore().activeSessionRoute,
      sessionId: window.Pinia.useSessionsStore().activeSessionId,
    }))).toEqual({
      route: { runtimeProvider: 'yeaft', agentId: mockAgent.agentId, sessionId: copied.id },
      sessionId: copied.id,
    });
    const expected = {
      announcement: source.announcement, roster: source.roster, defaultVpId: source.defaultVpId,
      workDir: source.workDir, config: source.config, projectId,
    };
    const inspectCopy = () => page.evaluate(({ agentId, sessionId }) => {
      const store = window.Pinia.useChatStore();
      const session = window.Pinia.useSessionsStore().sessionById(sessionId, agentId);
      const project = store.sessionProjects.find(row => row.members.some(member => member.agentId === agentId && member.sessionId === sessionId));
      return {
        announcement: session?.announcement, roster: session?.roster, defaultVpId: session?.defaultVpId,
        workDir: session?.workDir, config: session?.config, projectId: project?.id || null,
      };
    }, { agentId: mockAgent.agentId, sessionId: copied.id });
    await expect.poll(inspectCopy).toEqual(expected);
    if (observer) {
      await expect.poll(() => observer.evaluate(({ agentId, sessionId }) => {
        const sessions = window.Pinia.useSessionsStore();
        return { copied: !!sessions.sessionById(sessionId, agentId), active: sessions.activeSessionId };
      }, { agentId: mockAgent.agentId, sessionId: copied.id })).toEqual({ copied: true, active: source.id });
      await observer.close();
    }
    if (projectId) {
      const nextTurn = mockAgent.waitForMessage('yeaft_session_send');
      await page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sendWsMessage({
        type: 'yeaft_session_send', agentId, sessionId, text: 'Continue the fork',
      }), { agentId: mockAgent.agentId, sessionId: copied.id });
      expect((await nextTurn).projectContext).toMatchObject({ projectId, projectInstruction: 'Keep the Project instruction' });
    }
    await page.reload();
    await expect.poll(inspectCopy).toEqual(expected);
  });
}
