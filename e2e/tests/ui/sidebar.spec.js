import { test } from '../../fixtures/test-server.js';
import { expect } from '@playwright/test';

test.describe('侧边栏交互', () => {
  /** Create a Claude Code chat through the catalog modal or legacy fallback. */
  async function createConversation(chatPage) {
    const catalogCreate = chatPage.locator('.sidebar-primary-action');
    if (await catalogCreate.isVisible().catch(() => false)) {
      await catalogCreate.click();
      const modal = chatPage.locator('.yeaft-session-create-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });
      await modal.locator('.resume-control-row').nth(1).locator('.modern-select-trigger').click();
      await chatPage.locator('.yeaft-session-create-select-menu .modern-select-option', {
        hasText: 'Claude Code',
      }).click();
      await modal.locator('.resume-modal-footer .modern-btn').click();
      await expect(modal).not.toBeVisible({ timeout: 5000 });
    } else {
      await chatPage.locator('.session-tab-add-btn').click();
      await chatPage.waitForSelector('.modal-overlay', { timeout: 5000 });
      await chatPage.waitForFunction(() => {
        const sel = document.querySelector('.resume-select');
        return sel && sel.options.length > 1;
      }, { timeout: 5000 });
      await chatPage.locator('.resume-select').first().selectOption({ index: 1 });
      await chatPage.click('.modern-btn');
    }
    await chatPage.waitForSelector('.session-item.active', { timeout: 5000 });
  }

  test('侧边栏默认展开状态', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).not.toHaveClass(/collapsed/);
  });

  test.describe('coarse pointer controls', () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
      isMobile: true,
    });

    test('触屏设备保持 section 展开图标可见且可交互', async ({ page, serverUrl, mockAgent }) => {
      await page.goto(serverUrl);
      await page.waitForSelector('.chat-page', { timeout: 10000 });
      await page.waitForFunction(agentId => {
        const store = window.Pinia?.useChatStore?.();
        return (store?.agents || []).some(agent => agent.id === agentId
          && agent.online === true
          && agent.status === 'ready');
      }, mockAgent.agentId, { timeout: 10000 });

      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      expect(page.viewportSize()).toEqual({ width: 375, height: 667 });
      const chevrons = page.locator('.sidebar-section-chevron');
      await expect(chevrons).toHaveCount(2);
      const computedStyles = await chevrons.evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      }));
      expect(computedStyles).toEqual([
        { opacity: '1', pointerEvents: 'auto' },
        { opacity: '1', pointerEvents: 'auto' },
      ]);
    });
  });

  test('新建聊天使用留白编辑图标，项目创建按钮仅在标题交互时显示', async ({ chatPage, mockAgent }) => {
    await chatPage.evaluate(({ agentId }) => {
      window.Pinia.useChatStore().applySessionCatalogSnapshot([{
        catalogKey: `yeaft:${agentId}:font-reference`,
        runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'font-reference' },
        title: 'Font reference',
        availability: 'online',
        createdAt: '2026-08-03T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-03T00:00:00.000Z',
      }], []);
    }, { agentId: mockAgent.agentId });
    await expect(chatPage.locator('.sidebar-session-title-text')).toHaveCount(1);

    const newChat = chatPage.locator('.sidebar-primary-action');
    const projectHeading = chatPage.locator('.projects-section > .sidebar-section-heading');
    const newProject = projectHeading.locator('.sidebar-project-add-button');
    const recentsHeading = chatPage.locator('.recents-section > .sidebar-section-heading');
    const recentsCreate = recentsHeading.locator('.sidebar-recents-create');

    await expect(newChat).toHaveText('New chat');
    await expect(newChat).toHaveAccessibleName('New chat');
    await expect(newChat).toHaveAttribute('title', 'New chat');
    await expect(newChat.locator('.sidebar-primary-action-icon')).toBeVisible();
    await expect(newProject).toHaveAccessibleName('New project');

    await chatPage.evaluate(() => window.Pinia.useChatStore().changeLocale('zh-CN'));
    await expect(newChat).toHaveText('新建聊天');
    await expect(newChat).toHaveAccessibleName('新建聊天');
    await expect(newProject).toHaveAccessibleName('新建项目');

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      const appearance = await chatPage.evaluate(() => {
        const chatButton = document.querySelector('.sidebar-primary-action');
        const firstSessionTitle = document.querySelector('.sidebar-session-title-text');
        const chatStyle = getComputedStyle(chatButton);
        return {
          height: chatButton.getBoundingClientRect().height,
          chatBackground: chatStyle.backgroundColor,
          chatBorderTopWidth: chatStyle.borderTopWidth,
          chatFontSize: Number.parseFloat(chatStyle.fontSize),
          sessionTitleFontSize: Number.parseFloat(getComputedStyle(firstSessionTitle).fontSize),
          chatFramePath: chatButton.querySelector('.sidebar-primary-action-frame').getAttribute('d'),
          chatPenPath: chatButton.querySelector('.sidebar-primary-action-pen').getAttribute('d'),
          recentsFramePath: document.querySelector('.sidebar-recents-create-frame').getAttribute('d'),
          recentsPenPath: document.querySelector('.sidebar-recents-create-pen').getAttribute('d'),
          projectMarkPath: document.querySelector('.sidebar-project-add-mark').getAttribute('d'),
        };
      });
      expect(appearance.height).toBeGreaterThanOrEqual(34);
      expect(appearance.chatBackground).toBe('rgba(0, 0, 0, 0)');
      expect(appearance.chatBorderTopWidth).toBe('0px');
      expect(appearance.chatFontSize).toBe(appearance.sessionTitleFontSize);
      expect(appearance.chatFramePath).toBe('M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7');
      expect(appearance.chatPenPath).toBe('M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852Z');
      expect(appearance.recentsFramePath).toBe(appearance.chatFramePath);
      expect(appearance.recentsPenPath).toBe(appearance.chatPenPath);
      expect(appearance.projectMarkPath).toBe('M12 5v14M5 12h14');
    }

    await chatPage.mouse.move(0, 0);
    await expect(newProject).toHaveCSS('opacity', '0');
    await expect(newProject).toHaveCSS('pointer-events', 'none');
    const hiddenHitTarget = await newProject.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const target = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hitsButton: target === button || button.contains(target),
      };
    });
    expect(hiddenHitTarget.hitsButton).toBe(false);

    await newProject.focus();
    await expect(newProject).toHaveCSS('opacity', '1');
    await expect(newProject).toHaveCSS('pointer-events', 'auto');
    await newChat.focus();
    await chatPage.mouse.move(0, 0);
    await expect(newProject).toHaveCSS('opacity', '0');
    await expect(newProject).toHaveCSS('pointer-events', 'none');

    const hoverHeadingEdge = async heading => {
      const box = await heading.boundingBox();
      expect(box).not.toBeNull();
      await chatPage.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    };

    await projectHeading.locator('.sidebar-section-toggle').click();
    await chatPage.mouse.move(0, 0);
    await expect(newProject).toHaveCSS('opacity', '0');
    await expect(projectHeading.locator('.sidebar-section-chevron')).toHaveCSS('opacity', '0');
    await hoverHeadingEdge(projectHeading);
    await expect(newProject).toHaveCSS('opacity', '1');
    await expect(newProject).toHaveCSS('pointer-events', 'auto');
    await newProject.click();
    await expect(chatPage.locator('.sidebar-project-create input')).toBeFocused();
    await expect(newProject).toBeDisabled();
    await newChat.hover();
    await expect(newProject).toHaveCSS('opacity', '0');
    await expect(newProject).toHaveCSS('pointer-events', 'none');
    await chatPage.keyboard.press('Escape');
    await expect(chatPage.locator('.sidebar-project-create')).toHaveCount(0);

    await chatPage.mouse.move(0, 0);
    await expect(recentsCreate).toHaveCSS('opacity', '0');
    await expect(recentsCreate).toHaveCSS('pointer-events', 'none');
    const hiddenRecentsHitTarget = await recentsCreate.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const target = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hitsButton: target === button || button.contains(target),
      };
    });
    expect(hiddenRecentsHitTarget.hitsButton).toBe(false);

    await recentsHeading.locator('.sidebar-section-toggle').click();
    await chatPage.mouse.move(0, 0);
    await expect(recentsCreate).toHaveCSS('opacity', '0');
    await expect(recentsHeading.locator('.sidebar-section-chevron')).toHaveCSS('opacity', '0');
    await recentsHeading.locator('.sidebar-section-toggle').click();
    await chatPage.mouse.move(0, 0);
    await hoverHeadingEdge(recentsHeading);
    await expect(recentsCreate).toHaveCSS('opacity', '1');
    await expect(recentsCreate).toHaveCSS('pointer-events', 'auto');
    await recentsCreate.click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toBeVisible();
    await chatPage.locator('.yeaft-session-create-modal .resume-close-btn').click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toHaveCount(0);

    await newChat.click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toBeVisible();
  });

  test('项目较少时最近列表紧随其后，项目较多时项目区半高滚动', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 1400, height: 900 });

    const makeSession = (id, title) => ({
      catalogKey: `yeaft:${mockAgent.agentId}:${id}`,
      runtimeProvider: 'yeaft',
      routeRef: { runtimeProvider: 'yeaft', agentId: mockAgent.agentId, sessionId: id },
      title,
      availability: 'online',
      createdAt: '2026-08-03T00:00:00.000Z',
      metadataUpdatedAt: '2026-08-03T00:00:00.000Z',
    });
    const setSidebarData = async ({ projects, sessions }) => {
      await chatPage.evaluate(({ nextProjects, nextSessions }) => {
        window.Pinia.useChatStore().applySessionCatalogSnapshot(nextSessions, nextProjects);
      }, { nextProjects: projects, nextSessions: sessions });
      await expect(chatPage.locator('.sidebar-project')).toHaveCount(projects.length);
    };
    const readLayout = () => chatPage.evaluate(() => {
      const results = document.querySelector('.sidebar-session-results');
      const projects = document.querySelector('.projects-section');
      const recents = document.querySelector('.recents-section');
      const lastProject = projects.querySelector('.sidebar-project:last-child');
      const recentHeading = recents.querySelector('.sidebar-section-heading');
      const projectStyle = getComputedStyle(projects);
      return {
        availableHeight: results.getBoundingClientRect().height,
        projectHeight: projects.getBoundingClientRect().height,
        projectScrollHeight: projects.scrollHeight,
        projectClientHeight: projects.clientHeight,
        projectOverflowY: projectStyle.overflowY,
        projectScrollTop: projects.scrollTop,
        recentScrollHeight: recents.scrollHeight,
        recentClientHeight: recents.clientHeight,
        recentGap: recentHeading.getBoundingClientRect().top - lastProject.getBoundingClientRect().bottom,
      };
    });

    const recentSessions = [
      makeSession('recent-1', 'Recent one'),
      makeSession('recent-2', 'Recent two'),
      makeSession('recent-3', 'Recent three'),
    ];
    const compactProjects = [
      { id: 'project-one', name: 'Project one', members: [] },
      { id: 'project-two', name: 'Project two', members: [] },
    ];

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await setSidebarData({ projects: compactProjects, sessions: recentSessions });
      const compact = await readLayout();
      expect(compact.projectHeight).toBeLessThan(compact.availableHeight / 2);
      expect(compact.projectScrollHeight).toBe(compact.projectClientHeight);
      expect(compact.recentGap).toBeGreaterThanOrEqual(0);
      expect(compact.recentGap).toBeLessThanOrEqual(12);

      const manyRecents = Array.from({ length: 20 }, (_, index) => (
        makeSession(`recent-${index}`, `Recent ${index}`)
      ));
      await setSidebarData({ projects: compactProjects, sessions: manyRecents });
      const crowdedRecents = await readLayout();
      expect(crowdedRecents.projectHeight).toBe(compact.projectHeight);
      expect(crowdedRecents.projectScrollHeight).toBe(crowdedRecents.projectClientHeight);
      expect(crowdedRecents.recentScrollHeight).toBeGreaterThan(crowdedRecents.recentClientHeight);

      const manyProjects = Array.from({ length: 20 }, (_, index) => ({
        id: `project-${index}`,
        name: `Project ${index}`,
        members: [],
      }));
      await setSidebarData({ projects: manyProjects, sessions: recentSessions });
      const overflowing = await readLayout();
      expect(Math.abs(overflowing.projectHeight - overflowing.availableHeight / 2)).toBeLessThanOrEqual(1);
      expect(overflowing.projectScrollHeight).toBeGreaterThan(overflowing.projectClientHeight);
      expect(overflowing.projectOverflowY).toBe('auto');

      await chatPage.locator('.projects-section').evaluate(element => { element.scrollTop = 80; });
      await expect.poll(async () => (await readLayout()).projectScrollTop).toBeGreaterThan(0);
    }

    const dragSessions = [
      { ...makeSession('project-first', 'Project first'), sortRank: 0 },
      { ...makeSession('project-second', 'Project second'), sortRank: 1 },
      { ...makeSession('recent-drag', 'Recent drag'), sortRank: 2 },
    ];
    const dragProjects = [{
      id: 'project-drag',
      name: 'Project drag',
      sortOrder: 0,
      members: [
        { agentId: mockAgent.agentId, sessionId: 'project-first' },
        { agentId: mockAgent.agentId, sessionId: 'project-second' },
      ],
    }, {
      id: 'project-empty',
      name: 'Project empty',
      sortOrder: 1,
      members: [],
    }];
    await setSidebarData({ projects: dragProjects, sessions: dragSessions });
    await expect(chatPage.locator('.sidebar-session-row[draggable="true"]').first()).toHaveCSS('cursor', 'default');
    const dragResult = await chatPage.evaluate(async ({ agentId }) => {
      const store = window.Pinia.useChatStore();
      const originalMove = store.mutateProject;
      const originalReorder = store.reorderCatalogSessions;
      const calls = { moves: [], orders: [], projectOrders: [] };
      store.mutateProject = async (op, payload, targetAgentId) => {
        if (op === 'reorder') {
          calls.projectOrders.push(payload.projectIds);
          const byId = new Map(store.sessionProjects.map(project => [project.id, project]));
          store.applySessionCatalogSnapshot(
            store.sessionCatalog,
            payload.projectIds.map((id, sortOrder) => ({ ...byId.get(id), sortOrder })),
          );
          return { ok: true };
        }
        calls.moves.push({ op, payload, targetAgentId });
        if (op === 'move_session') {
          const orderedCatalog = payload.catalogOrder.map((item, sortRank) => ({
            ...store.sessionCatalog.find(row => row.catalogKey === item.catalogKey),
            sortRank,
          }));
          const projects = store.sessionProjects.map(project => ({
            ...project,
            members: project.members.filter(member => (
              member.agentId !== targetAgentId || member.sessionId !== payload.sessionId
            )),
          }));
          if (payload.projectId) {
            const project = projects.find(item => item.id === payload.projectId);
            project.members.push({ agentId: targetAgentId, sessionId: payload.sessionId });
          }
          store.applySessionCatalogSnapshot(orderedCatalog, projects);
        }
        return { ok: true };
      };
      store.reorderCatalogSessions = (rows) => {
        calls.orders.push(rows.map(row => row.catalogKey));
        store.applySessionCatalogSnapshot(
          rows.map((row, sortRank) => ({ ...row, sortRank })),
          store.sessionProjects,
        );
        return true;
      };

      const transfer = new DataTransfer();
      const dispatchDrag = (element, type, clientY) => element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientY,
      }));
      const rows = () => [...document.querySelectorAll('.sidebar-project-sessions .session-item')];
      const recent = () => document.querySelector('.recents-section .session-item');
      const titles = selector => [...document.querySelectorAll(selector)]
        .map(row => row.querySelector('.sidebar-session-title-text')?.textContent?.trim());
      const projectNames = () => [...document.querySelectorAll('.sidebar-project-toggle')]
        .map(row => row.textContent.replace(/\d+$/, '').trim());

      const sectionToggles = [...document.querySelectorAll('.sidebar-section-toggle')];
      sectionToggles[1].click();
      await window.Vue.nextTick();
      const recentsCollapsed = document.querySelector('.recents-section').classList.contains('is-collapsed')
        && document.querySelectorAll('.recents-section .session-item').length === 0;
      sectionToggles[1].click();
      await window.Vue.nextTick();

      const firstProjectToggle = document.querySelector('.sidebar-project-toggle');
      const openIconVisible = !!firstProjectToggle.querySelector('.sidebar-project-icon-open');
      firstProjectToggle.click();
      await window.Vue.nextTick();
      const closedIconVisible = !!firstProjectToggle.querySelector('.sidebar-project-icon-closed');
      firstProjectToggle.click();
      await window.Vue.nextTick();

      let projectHeaders = [...document.querySelectorAll('.sidebar-project-header')];
      dispatchDrag(projectHeaders[1], 'dragstart', 0);
      const firstProjectBounds = projectHeaders[0].getBoundingClientRect();
      dispatchDrag(projectHeaders[0], 'dragover', firstProjectBounds.top + 1);
      await window.Vue.nextTick();
      const projectIndicator = projectHeaders[0].classList.contains('project-drag-before');
      dispatchDrag(projectHeaders[0], 'drop', firstProjectBounds.top + 1);
      await new Promise(resolve => setTimeout(resolve, 0));
      await window.Vue.nextTick();
      const projectGroupOrder = projectNames();

      let projectRows = rows();
      dispatchDrag(projectRows[1], 'dragstart', 0);
      const firstBounds = projectRows[0].getBoundingClientRect();
      dispatchDrag(projectRows[0], 'dragover', firstBounds.top + 1);
      await window.Vue.nextTick();
      const indicator = projectRows[0].classList.contains('drag-before');
      dispatchDrag(projectRows[0], 'drop', firstBounds.top + 1);
      await window.Vue.nextTick();
      const sessionOrder = titles('.sidebar-project-sessions .session-item');

      const recentRow = recent();
      projectRows = rows();
      dispatchDrag(recentRow, 'dragstart', 0);
      const secondBounds = projectRows[1].getBoundingClientRect();
      dispatchDrag(projectRows[1], 'dragover', secondBounds.top + 1);
      dispatchDrag(projectRows[1], 'drop', secondBounds.top + 1);
      await new Promise(resolve => setTimeout(resolve, 0));
      await window.Vue.nextTick();
      const crossSectionOrder = titles('.sidebar-project-sessions .session-item');
      const recentOrder = titles('.recents-section .session-item');

      store.mutateProject = originalMove;
      store.reorderCatalogSessions = originalReorder;
      return {
        calls,
        indicator,
        projectIndicator,
        projectGroupOrder,
        recentsCollapsed,
        openIconVisible,
        closedIconVisible,
        sessionOrder,
        crossSectionOrder,
        recentOrder,
        agentId,
      };
    }, { agentId: mockAgent.agentId });
    expect(dragResult.recentsCollapsed).toBe(true);
    expect(dragResult.openIconVisible).toBe(true);
    expect(dragResult.closedIconVisible).toBe(true);
    expect(dragResult.projectIndicator).toBe(true);
    expect(dragResult.projectGroupOrder).toEqual(['Project empty', 'Project drag']);
    expect(dragResult.calls.projectOrders).toEqual([['project-empty', 'project-drag']]);
    expect(dragResult.indicator).toBe(true);
    expect(dragResult.sessionOrder).toEqual(['Project second', 'Project first']);
    expect(dragResult.crossSectionOrder).toEqual(['Project second', 'Recent drag', 'Project first']);
    expect(dragResult.recentOrder).toEqual([]);
    expect(dragResult.calls.moves).toEqual([{
      op: 'move_session',
      payload: {
        sessionId: 'recent-drag',
        projectId: 'project-drag',
        catalogOrder: [
          expect.objectContaining({ catalogKey: `yeaft:${mockAgent.agentId}:project-second` }),
          expect.objectContaining({ catalogKey: `yeaft:${mockAgent.agentId}:recent-drag` }),
          expect.objectContaining({ catalogKey: `yeaft:${mockAgent.agentId}:project-first` }),
        ],
      },
      targetAgentId: mockAgent.agentId,
    }]);
    expect(dragResult.calls.orders).toHaveLength(1);
  });

  test('点击折叠按钮收起侧边栏', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await chatPage.getByTitle('Collapse sidebar').click();
    await expect(sidebar).toHaveClass(/collapsed/, { timeout: 3000 });
    await expect(chatPage.locator('.sidebar-collapsed-bar')).toBeVisible();
  });

  test('折叠后点击展开按钮恢复侧边栏', async ({ chatPage }) => {
    const sidebar = chatPage.locator('.sidebar');
    await chatPage.getByTitle('Collapse sidebar').click();
    await expect(sidebar).toHaveClass(/collapsed/, { timeout: 3000 });
    await chatPage.locator('.sidebar-collapsed-bar .collapsed-icon-btn').first().click();
    await expect(sidebar).not.toHaveClass(/collapsed/, { timeout: 3000 });
  });

  test('创建会话后显示在侧边栏列表中', async ({ chatPage, mockAgent }) => {
    const before = await chatPage.locator('.session-item').count();
    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 1);
    await expect(chatPage.locator('.session-item.active')).toBeVisible();
  });

  test('会话切换：创建两个会话后可切换', async ({ chatPage, mockAgent }) => {
    const before = await chatPage.locator('.session-item').count();
    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 1);

    await createConversation(chatPage);
    await expect(chatPage.locator('.session-item')).toHaveCount(before + 2, { timeout: 5000 });

    // Click the non-active session to switch
    const sessions = chatPage.locator('.session-item');
    const count = await sessions.count();
    for (let i = 0; i < count; i++) {
      const isActive = await sessions.nth(i).evaluate(el => el.classList.contains('active'));
      if (!isActive) {
        await sessions.nth(i).click();
        break;
      }
    }
    await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
  });

  test('移除会话：侧栏图标只隐藏会话而不删除数据', async ({ chatPage, mockAgent }) => {
    await createConversation(chatPage);
    const after = await chatPage.locator('.session-item').count();
    expect(after).toBeGreaterThanOrEqual(1);
    const created = mockAgent._receivedMessages.filter(m => m.type === 'create_conversation').at(-1);
    expect(created?.conversationId).toBeTruthy();
    // Publish the native identity binding as the real CLI provider does.
    const cliSessionId = `cli-${created.conversationId}`;
    mockAgent.send({
      type: 'session_id_update',
      conversationId: created.conversationId,
      claudeSessionId: cliSessionId,
    });
    await expect.poll(() => chatPage.evaluate(id => (
      window.Pinia.useChatStore().conversations.find(conv => conv.id === id)?.claudeSessionId
    ), created.conversationId)).toBe(cliSessionId);

    const activeItem = chatPage.locator('.session-item.active');
    const removeButton = activeItem.locator('.session-quick-action:has(.session-remove-icon)');
    await activeItem.hover();
    await expect(removeButton).toBeVisible({ timeout: 3000 });
    await removeButton.click();
    await expect(chatPage.locator('.session-item')).toHaveCount(after - 1, { timeout: 5000 });
    expect(mockAgent._receivedMessages.filter(m => m.type === 'delete_conversation'
      && m.conversationId === created.conversationId)).toHaveLength(0);

    // Resume history is Agent-owned; only retained conversations can be recovered.
    mockAgent._messageHandlers.push(message => {
      if (message.type === 'resume_conversation') {
        if (message.claudeSessionId !== cliSessionId) return;
        const retained = mockAgent.conversations.get(created.conversationId);
        if (!retained) return;
        mockAgent.send({
          type: 'conversation_resumed',
          conversationId: message.conversationId,
          claudeSessionId: message.claudeSessionId,
          workDir: retained.workDir,
          provider: message.provider,
          historyMessages: [],
        });
        return;
      }
      if (message.type !== 'list_history_sessions') return;
      mockAgent.send({
        type: 'history_sessions_list',
        requestId: message.requestId,
        sessions: [...mockAgent.conversations.entries()]
          .filter(([, session]) => session.workDir === message.workDir)
          .filter(([id]) => id === created.conversationId)
          .map(([, session]) => ({ ...session, sessionId: cliSessionId })),
      });
    });
    await chatPage.locator('.sidebar-primary-action').click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).toBeVisible();
    await chatPage.locator('.yeaft-session-create-modal').getByRole('combobox', { name: 'Provider', exact: true }).click();
    await chatPage.getByRole('option', { name: 'Claude Code', exact: true }).click();
    await chatPage.locator('.yeaft-session-create-modal .workdir-input-group input').fill(created.workDir);
    const hiddenSession = chatPage.locator('.yeaft-session-create-modal .resume-list-item', {
      hasText: cliSessionId.slice(0, 8),
    });
    await expect(hiddenSession).toBeVisible();
    await hiddenSession.click();
    await expect(chatPage.locator('.yeaft-session-create-modal')).not.toBeVisible({ timeout: 5000 });
    await expect.poll(() => chatPage.evaluate(id => {
      const store = window.Pinia.useChatStore();
      return {
        visible: store.sessionCatalog.some(row => row.routeRef?.sessionId === id),
        hidden: store.hiddenSessionCatalog.some(row => row.routeRef?.sessionId === id),
      };
    }, created.conversationId), { timeout: 10000 }).toEqual({ visible: true, hidden: false });
    expect(mockAgent._receivedMessages.filter(m => m.type === 'delete_conversation'
      && m.conversationId === created.conversationId)).toHaveLength(0);
  });
});
