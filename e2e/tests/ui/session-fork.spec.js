import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { copySession, sessionsRoot } from '../../../agent/yeaft/sessions/session-crud.js';

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
    const headerFork = page.locator('.yeaft-fork-btn');
    await expect(headerFork).toBeVisible();
    await expect(headerFork).toHaveAccessibleName('Copy session');
    await expect(headerFork).toBeEnabled();
    await headerFork.focus();
    await expect(headerFork).toBeFocused();
    await expect(headerFork.locator('svg')).toBeVisible();
    await expect(headerFork.locator('.yeaft-fork-icon')).toBeVisible();
    await expect(headerFork.locator('circle')).toHaveCount(3);
    await expect(headerFork.locator('rect')).toHaveCount(0);
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
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().sessionForkState)).toBe('copying');
    expect(await page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().copyCatalogSession({
      routeRef: { runtimeProvider: 'yeaft', agentId, sessionId },
    }), { agentId: mockAgent.agentId, sessionId: source.id })).toMatchObject({ error: { code: 'fork_pending' } });
    const request = await requestPromise;
    expect(request.sessionId).toBe(source.id);
    await expect(headerFork).toBeDisabled();
    await expect(headerFork).toHaveAttribute('aria-busy', 'true');
    await expect(headerFork).toHaveClass(/is-copying/);
    await expect(headerFork).toHaveAccessibleName('Copying session…');
    const composer = page.locator('.yeaft-session-input textarea');
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveAttribute('placeholder', 'Copying session…');
    expect(mockAgent._messageHistory.filter(msg => msg.type === 'yeaft_copy_session')).toHaveLength(1);
    mockAgent.send({
      type: 'yeaft_output', event: {
        type: 'session_crud_result', op: 'copy', ok: true,
        requestId: request.requestId, sourceSessionId: source.id, session: copied,
      },
    });
    await expect(headerFork).toHaveClass(/is-success/);
    await expect(headerFork).toHaveAccessibleName('Session copied');
    await expect(headerFork.locator('.yeaft-fork-success-icon')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId), {
      timeout: 2_000,
    }).toBe(copied.id);
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

for (const scenario of [
  { width: 1280, theme: 'light', vp: false },
  { width: 320, theme: 'dark', vp: true },
]) {
  test(`Fork from this turn: durable prefix, ${scenario.width}px ${scenario.theme}, VP=${scenario.vp}`, async ({ chatPage: page, mockAgent }, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-e2e-fork-turn-'));
    try {
      const source = { id: 'turn-fork-source', name: 'Choose an earlier response', roster: [], defaultVpId: null, workDir: '/tmp/test' };
      createSession(sessionsRoot(root), source).close();
      const transcript = new ConversationStore(root);
      const append = row => transcript.append({ sessionId: source.id, ...row });
      append({ role: 'user', content: 'Original question' });
      append({ role: 'assistant', content: 'Keep this first answer', turnId: 'runtime-a', ...(scenario.vp ? { speakerVpId: 'omni' } : {}) });
      append({ role: 'assistant', content: 'Keep the continuation too', turnId: 'runtime-b', ...(scenario.vp ? { speakerVpId: 'omni' } : {}) });
      append({ role: 'assistant', content: 'Keep the complete result', turnId: 'runtime-c', ...(scenario.vp ? { speakerVpId: 'omni' } : {}) });
      append({ role: 'user', content: 'Later question excluded from fork' });
      append({ role: 'assistant', content: 'Later answer excluded from fork', turnId: 'turn-later', ...(scenario.vp ? { speakerVpId: 'omni' } : {}) });
      const originalRows = transcript.loadAllBySession(source.id);
      // The websocket transport is mocked; copying and loading the transcript
      // use the actual durable implementation in a disposable data root.
      const replyHistory = request => {
        const rows = transcript.loadAllBySession(request.sessionId);
        const metadata = { sessionId: request.sessionId, requestId: request.requestId,
          oldestSeq: rows[0]?.seq, latestSeq: rows.at(-1)?.seq, hasMore: false, mode: 'recent' };
        mockAgent.send({ type: 'yeaft_history_chunk', ...metadata, messages: rows });
        mockAgent.send({ type: 'yeaft_output', event: { type: 'history_loaded', ...metadata, count: rows.length } });
      };
      mockAgent._messageHandlers.push(request => {
        if (request.type === 'yeaft_load_history' && request.sessionId) replyHistory(request);
      });
      mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [source] } });
      await expect.poll(() => page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sessionCatalog
        .some(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId),
      { agentId: mockAgent.agentId, sessionId: source.id })).toBe(true);
      await page.setViewportSize({ width: scenario.width, height: 800 });
      await page.evaluate(({ agentId, sessionId, theme }) => {
        document.documentElement.setAttribute('data-theme', theme);
        const store = window.Pinia.useChatStore();
        store.openCatalogSession(store.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
        store.sessionSidebarOpen = false;
      }, { agentId: mockAgent.agentId, sessionId: source.id, theme: scenario.theme });
      const actions = page.locator('.fork-turn-action-btn');
      await expect(actions).toHaveCount(2);
      // Three persisted runtime deliveries form one visible historical reply.
      const sourceReply = page.locator('.assistant-turn').first();
      await expect(sourceReply).toContainText('Keep the continuation too');
      await expect(sourceReply).toContainText('Keep the complete result');
      const first = actions.first();
      await expect(first).toHaveAccessibleName('Fork from this turn');
      await expect(first).toHaveText('');
      await expect(first).toHaveAttribute('title', 'Copy history through this response into a new Session; later messages are excluded.');
      await first.focus();
      await expect(first).toBeFocused();
      await expect(first.locator('svg')).toBeVisible();
      const geometry = await first.evaluate(button => {
        const rect = button.getBoundingClientRect();
        const copyRect = button.parentElement.querySelector('.copy-full-btn').getBoundingClientRect();
        const styles = getComputedStyle(button);
        return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
          copyWidth: copyRect.width, copyHeight: copyRect.height,
          outlineStyle: styles.outlineStyle, outlineWidth: styles.outlineWidth };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(scenario.width);
      expect(geometry.width).toBe(geometry.copyWidth);
      expect(geometry.height).toBe(geometry.copyHeight);
      expect(geometry.outlineStyle).toBe('solid');
      expect(parseFloat(geometry.outlineWidth)).toBeGreaterThan(0);
      await expect.poll(() => first.evaluate(button => getComputedStyle(button.parentElement).opacity)).toBe('1');
      await page.screenshot({ path: testInfo.outputPath('fork-from-turn.png') });

      await page.evaluate(({ agentId, sessionId }) => {
        window.Pinia.useChatStore().yeaftProcessingSessions = { [`${agentId}\u001f${sessionId}`]: true };
      }, { agentId: mockAgent.agentId, sessionId: source.id });
      await expect(first).toBeDisabled();
      await page.evaluate(() => {
        const store = window.Pinia.useChatStore();
        store.yeaftProcessingSessions = {};
        store.connectionState = 'reconnecting';
      });
      await expect(first).toBeDisabled();
      await page.evaluate(() => {
        const store = window.Pinia.useChatStore();
        store.connectionState = 'connected';
        store.agents = store.agents.map(agent => ({ ...agent, capabilities: agent.capabilities.filter(value => value !== 'session_fork_from_turn') }));
      });
      await expect(actions).toHaveCount(0);
      expect(mockAgent._messageHistory.filter(request => request.type === 'yeaft_copy_session')).toHaveLength(0);
      await page.evaluate(() => {
        const store = window.Pinia.useChatStore();
        store.agents = store.agents.map(agent => ({ ...agent, capabilities: [...agent.capabilities, 'session_fork_from_turn'] }));
      });
      await expect(first).toBeEnabled();
      // A merged reply ending in a legacy row without a durable turn identity
      // cannot fall back to runtime-a or runtime-b and silently truncate itself.
      await page.evaluate(() => {
        const row = window.Pinia.useChatStore().messages.find(message => message.turnId === 'runtime-c');
        row.turnId = null;
      });
      await expect(actions).toHaveCount(1);
      await expect(sourceReply.locator('.fork-turn-action-btn')).toHaveCount(0);
      await page.evaluate(() => {
        const row = window.Pinia.useChatStore().messages.find(message => message.content === 'Keep the complete result');
        row.turnId = 'runtime-c';
      });
      await expect(actions).toHaveCount(2);
      const pending = mockAgent.waitForMessage('yeaft_copy_session');
      await first.focus();
      await first.press('Enter');
      const request = await pending;
      expect(request).toMatchObject({ sessionId: source.id, throughTurnId: 'runtime-c' });
      await expect(first).toBeDisabled();
      const copied = copySession(root, request.sessionId, { throughTurnId: request.throughTurnId });
      expect(transcript.loadAllBySession(copied.id).map(row => row.content)).toEqual(['Original question', 'Keep this first answer', 'Keep the continuation too', 'Keep the complete result']);
      expect(transcript.loadAllBySession(source.id)).toEqual(originalRows);
      mockAgent.send({ type: 'yeaft_output', event: { type: 'session_crud_result', op: 'copy', ok: true,
        requestId: request.requestId, sourceSessionId: source.id, session: copied } });
      await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(copied.id);
      await expect(page.locator('.assistant-turn', { hasText: 'Keep this first answer' })).toBeVisible();
      await expect(page.locator('.assistant-turn', { hasText: 'Later answer excluded from fork' })).toHaveCount(0);
      await expect(actions).toHaveCount(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
