import { expect } from '@playwright/test';
import { test } from '../../fixtures/scheduled-task-server.js';
import { scheduledTaskAgent } from '../../fixtures/scheduled-task-agent.js';

// Own ephemeral Server/SQLite + deterministic Agent boundary; never run a task.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' } });
test.setTimeout(60000);

const projectName = 'Project with a deliberately long title for narrow sidebar controls';
const chatCreate = '.sidebar-project-session-create:not(.sidebar-project-task-create)';
const headingControls = '.sidebar-tool-button, .sidebar-section-toggle';
const recentSessions = Array.from({ length: 30 }, (_, index) => ({
  id: 'controls-session-' + index, name: 'Recent conversation ' + index,
  roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/test',
}));

async function boot(page, serverUrl, agent, { theme = 'light', view = 'chat' } = {}) {
  await page.addInitScript(({ theme, view }) => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('theme', theme);
    localStorage.setItem('yeaft-preferred-conversation-view', view);
  }, { theme, view });
  await page.goto(serverUrl);
  await expect.poll(() => page.evaluate(agentId => window.Pinia?.useChatStore?.().agents
    .some(item => item.id === agentId && item.online && item.capabilities?.includes('scheduled_tasks')), agent.agentId)).toBe(true);
  await expect(page.locator('.sidebar-navigation')).toHaveAttribute('aria-busy', 'false');
}

async function showSidebar(page) {
  if (!await page.locator('.sidebar-navigation').isVisible()) {
    await page.locator('.header-sidebar-toggle:visible, .yeaft-topbar-sidebar-toggle:visible').first().click();
  }
  await expect(page.locator('.sidebar-navigation')).toBeVisible();
}

async function createProject(page) {
  await page.locator('.projects-section > .sidebar-section-heading').hover();
  await page.locator('.sidebar-project-add-button').click();
  await page.locator('.sidebar-project-create input').fill(projectName);
  await page.locator('.sidebar-project-create-confirm').click();
  const project = page.locator('.sidebar-project').filter({ hasText: projectName });
  await expect(project).toHaveCount(1);
  await expect(page.locator('.sidebar-project-create')).toHaveCount(0);
  return project;
}

async function leaveControls(page) {
  await page.evaluate(() => document.activeElement?.blur());
  const viewport = page.viewportSize();
  await page.mouse.move(viewport.width - 2, viewport.height - 2);
}

async function expectRevealed(controls, revealed) {
  // Playwright visibility deliberately ignores opacity: assert the actual CSS
  // hit-testing and paint contract, including all sibling buttons in the area.
  await expect.poll(() => controls.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  }))).toEqual(Array.from({ length: await controls.count() }, () => ({
    opacity: revealed ? '1' : '0', pointerEvents: revealed ? 'auto' : 'none',
  })));
}

const geometry = scope => scope.evaluate(element => [element, ...element.querySelectorAll('button, .sidebar-section-title, .sidebar-project-name')]
  .map(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return [x, y, width, height].map(value => Math.round(value * 100) / 100);
  }));

async function expectChevron(button, expanded) {
  await expect(button).toHaveAttribute('aria-expanded', String(expanded));
  const icon = button.locator('.sidebar-section-chevron');
  await expect(icon.locator('path')).toHaveAttribute('d', 'm8 10 4 4 4-4');
  await expect.poll(() => icon.evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return [matrix.a, matrix.b, matrix.c, matrix.d].map(value => Math.abs(value) < 0.0001 ? 0 : Math.round(value * 1000) / 1000);
  })).toEqual(expanded ? [-1, 0, 0, -1] : [1, 0, 0, 1]);
}

for (const theme of ['light', 'dark']) {
  test(`sidebar controls reveal only their hovered/focused area without layout shift / ${theme}`, async ({ page, serverUrl, mockAgent }, testInfo) => {
    scheduledTaskAgent(mockAgent, { sessions: recentSessions });
    await page.setViewportSize({ width: 1400, height: 900 });
    await boot(page, serverUrl, mockAgent, { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(true);
    const project = await createProject(page);
    const shortcuts = page.locator('.sidebar-primary-actions');
    const compact = page.locator('.sidebar-actions-toggle');
    await expect(compact).toHaveCount(1);
    const groups = [
      { scope: shortcuts, controls: compact, count: 1 },
      { scope: page.locator('.projects-section > .sidebar-section-heading'), controls: page.locator('.projects-section > .sidebar-section-heading').locator(headingControls), count: 2 },
      { scope: page.locator('.recents-section > .sidebar-section-heading'), controls: page.locator('.recents-section > .sidebar-section-heading').locator(headingControls), count: 3 },
      { scope: project.locator('.sidebar-project-header'), controls: project.locator('.sidebar-project-session-create'), count: 2 },
    ];
    await expect(project.locator(chatCreate)).toHaveCount(1);
    await expect(project.locator('.sidebar-project-task-create')).toHaveClass(/sidebar-project-session-create/);
    // Folder chat uses the same compose glyph as the top-level chat action;
    // task uses a clock, not the removed plus sign.
    const composePaths = await page.locator('.sidebar-primary-action').first().locator('svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d')));
    expect(await project.locator(chatCreate).locator('svg path').evaluateAll(paths => paths.map(path => path.getAttribute('d')))).toEqual(composePaths);
    await expect(project.locator('.sidebar-project-task-create svg circle')).toHaveAttribute('r', '9');
    await expect(project.locator('.sidebar-project-task-create svg path')).toHaveAttribute('d', 'M12 6v6l4 2');
    for (const { controls, count } of groups) await expect(controls).toHaveCount(count);
    await leaveControls(page);
    for (const { controls } of groups) await expectRevealed(controls, false);
    await page.screenshot({ path: testInfo.outputPath('sidebar-hidden-' + theme + '.png') });
    for (const [index, { scope, controls }] of groups.entries()) {
      const before = await geometry(scope);
      await scope.hover();
      await expectRevealed(controls, true);
      expect(await geometry(scope)).toEqual(before);
      for (const [otherIndex, other] of groups.entries()) {
        if (otherIndex !== index) await expectRevealed(other.controls, false);
      }
      await leaveControls(page);
      await expectRevealed(controls, false);
      expect(await geometry(scope)).toEqual(before);
      // Tab to a control after moving the mouse away: focus-within alone
      // reveals the entire area without shifting the reserved action slots.
      await controls.first().focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(controls.first()).toBeFocused();
      await expectRevealed(controls, true);
      expect(await geometry(scope)).toEqual(before);
      await leaveControls(page);
      await expectRevealed(controls, false);
    }
    // Opening the real form disables the add button: revealing the heading
    // must preserve its disabled treatment, rather than overriding it to 1.
    const projectHeading = groups[1].scope;
    const projectAdd = page.locator('.sidebar-project-add-button');
    await projectHeading.hover();
    await projectAdd.click();
    await expect(page.locator('.sidebar-project-create')).toBeVisible();
    await expect(projectAdd).toBeDisabled();
    await expect(projectAdd).toHaveCSS('opacity', '0.45');
    await expect(projectAdd).toHaveCSS('pointer-events', 'auto');
    await leaveControls(page);
    await expectRevealed(groups[1].controls, false);
    await expect(projectAdd).toBeDisabled();
    await projectHeading.locator('.sidebar-section-toggle').focus();
    await expect(projectAdd).toHaveCSS('opacity', '0.45');
    await leaveControls(page);
    await expectRevealed(groups[1].controls, false);
    await page.locator('.sidebar-project-create-cancel').click();
    await expect(projectAdd).toBeEnabled();
    for (const selector of ['.sidebar-actions-toggle', '.projects-section .sidebar-section-toggle', '.recents-section .sidebar-section-toggle']) {
      const button = page.locator(selector);
      await button.focus();
      await expectChevron(button, true);
      await page.keyboard.press('Enter');
      await expectChevron(button, false);
      await expect(button).toBeFocused();
      await page.keyboard.press('Space');
      await expectChevron(button, true);
      await expect(button).toBeFocused();
    }
    await page.locator('.recents-section > .sidebar-section-heading').hover();
    await leaveControls(page);
    await expectRevealed(groups[2].controls, false);
    expect(mockAgent.messages('yeaft_scheduled_task').filter(message => message.op === 'run')).toEqual([]);
  });
}

test('touch controls stay discoverable in light/dark at desktop and 320px widths', async ({ browser, serverUrl, mockAgent }, testInfo) => {
  scheduledTaskAgent(mockAgent, { sessions: recentSessions });
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1400, height: 900 } });
  try {
    const page = await context.newPage();
    await boot(page, serverUrl, mockAgent);
    await showSidebar(page);
    const project = await createProject(page);
    expect(await page.evaluate(() => ({ hover: matchMedia('(hover: none)').matches, coarse: matchMedia('(pointer: coarse)').matches })))
      .toEqual({ hover: true, coarse: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1400, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await showSidebar(page);
        await leaveControls(page);
        const controls = page.locator('.sidebar-actions-toggle, .sidebar-section-heading > .sidebar-tool-button, .sidebar-section-heading > .sidebar-section-toggle, .sidebar-project-header > .sidebar-project-session-create');
        await expect(controls).toHaveCount(8);
        await expectRevealed(controls, true);
        const projectAdd = page.locator('.sidebar-project-add-button');
        await projectAdd.tap();
        await expect(page.locator('.sidebar-project-create')).toBeVisible();
        await expect(projectAdd).toBeDisabled();
        await expect(projectAdd).toHaveCSS('opacity', '0.45');
        await expect(projectAdd).toHaveCSS('pointer-events', 'auto');
        await leaveControls(page);
        await expect(projectAdd).toHaveCSS('opacity', '0.45');
        await expectRevealed(controls.and(page.locator(':enabled')), true);
        await page.locator('.sidebar-project-create-cancel').tap();
        await expect(projectAdd).toBeEnabled();
        await expectRevealed(controls, true);
        expect(await controls.evaluateAll(elements => elements.every(element => {
          const box = element.getBoundingClientRect();
          return box.width >= 28 && box.height >= 28 && box.x >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
        }))).toBe(true);
        expect(await page.locator('.sidebar-section-heading, .sidebar-project-header, .sidebar-primary-actions').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const compact = page.locator('.sidebar-actions-toggle');
        await expectChevron(compact, true);
        await compact.tap();
        await expectChevron(compact, false);
        await expectRevealed(controls, true);
        await compact.tap();
        await expectChevron(compact, true);
        const heading = page.locator('.recents-section .sidebar-section-toggle');
        await heading.tap();
        await expectChevron(heading, false);
        await heading.tap();
        await expectChevron(heading, true);
        await project.locator('.sidebar-project-task-create').tap();
        await expect(page.locator('.yeaft-session-create-modal.task-mode')).toBeVisible();
        await page.locator('.task-create-close').tap();
        await page.screenshot({ path: testInfo.outputPath(`sidebar-touch-${theme}-${width}.png`) });
      }
    }
    expect(mockAgent.messages('yeaft_create_session')).toEqual([]);
    expect(mockAgent.messages('yeaft_scheduled_task').filter(message => message.op === 'run')).toEqual([]);
  } finally { await context.close(); }
});

for (const view of ['chat', 'yeaft']) {
  test(`project folder creates chat and task in the same project / ${view} surface`, async ({ page, serverUrl, mockAgent }) => {
    const state = scheduledTaskAgent(mockAgent, { sessions: [] });
    await page.setViewportSize({ width: 1400, height: 900 });
    await boot(page, serverUrl, mockAgent, { view });
    await showSidebar(page);
    await expect(page.locator(view === 'yeaft' ? '.yeaft-sidebar' : '.chat-page > .session-sidebar-shell')).toBeVisible();
    const project = await createProject(page);
    for (const [index, taskMode] of [true, false].entries()) {
      await project.locator('.sidebar-project-header').hover();
      await project.locator(taskMode ? '.sidebar-project-task-create' : chatCreate).click();
      const modal = page.locator('.yeaft-session-create-modal');
      await expect(modal).toBeVisible();
      if (taskMode) {
        await expect(modal).toHaveClass(/task-mode/);
        await expect(modal.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
        await modal.locator('.task-name-field input').fill('Folder task');
        await modal.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Fixture-only prompt; do not execute.');
        await modal.getByRole('group', { name: 'Trigger', exact: true }).getByRole('button', { name: 'Manual', exact: true }).click();
      } else {
        await expect(modal).not.toHaveClass(/task-mode/);
        await expect(modal.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
        await modal.locator('.resume-control-row > input[maxlength="60"]').fill('Folder chat');
      }
      await modal.locator('.workdir-input-group input').fill('/tmp/test');
      await expect(modal.locator('.resume-modal-footer .modern-btn')).toBeEnabled();
      await modal.locator('.resume-modal-footer .modern-btn').click();
      await expect(modal).not.toBeVisible();
      await expect.poll(() => state.createdCount).toBe(index + 1);
      const request = mockAgent.messages('yeaft_create_session').at(-1);
      if (taskMode) expect(request.payload.task).toMatchObject({ prompt: 'Fixture-only prompt; do not execute.', trigger: { type: 'manual' } });
      else expect(request.payload).not.toHaveProperty('task');
      await showSidebar(page);
      const name = taskMode ? 'Folder task' : 'Folder chat';
      await expect(project.locator('.sidebar-session-title-text').filter({ hasText: name })).toHaveCount(1);
      await expect(page.locator('.recents-section .sidebar-session-title-text').filter({ hasText: name })).toHaveCount(0);
      const created = [...state.sessions.values()].at(-1);
      await expect.poll(() => page.evaluate(({ agentId, sessionId }) => window.Pinia.useChatStore().sessionProjects
        .find(project => project.name === 'Project with a deliberately long title for narrow sidebar controls')?.members
        .some(member => member.agentId === agentId && member.sessionId === sessionId), { agentId: mockAgent.agentId, sessionId: created.id })).toBe(true);
    }
    // Persisted ownership survives a real Server catalog reload, not merely a
    // local optimistic row move. Creation must never start task execution.
    await page.reload();
    await showSidebar(page);
    await expect.poll(() => project.locator('.sidebar-session-title-text').allTextContents().then(titles => titles.sort()))
      .toEqual(['Folder chat', 'Folder task']);
    await expect(project.locator('.sidebar-session-task')).toHaveCount(1);
    expect(mockAgent.messages('yeaft_scheduled_task').filter(message => message.op === 'run')).toEqual([]);
    expect(mockAgent.messages('yeaft_session_send')).toEqual([]);
  });
}
