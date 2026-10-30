import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/scheduled-task-server.js';
import { MockAgent } from '../../fixtures/mock-agent.js';
import { scheduledTaskAgent, taskSession, TASK_CAPABILITIES, TASK_SESSION_ID, CHAT_SESSION_ID } from '../../fixtures/scheduled-task-agent.js';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.SERVE_DIST || 'false' } });
test.setTimeout(60000);

async function boot(page, serverUrl, agent) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en');
    if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'light');
    localStorage.setItem('yeaft-preferred-conversation-view', 'yeaft');
  });
  await page.goto(serverUrl);
  await expect.poll(() => page.evaluate(agentId => window.Pinia?.useChatStore?.().agents
    .some(item => item.id === agentId && item.online && item.capabilities?.includes('work_center')), agent.agentId)).toBe(true);
  await expect(page.locator('.sidebar-navigation')).toHaveAttribute('aria-busy', 'false');
}

async function showSidebar(page) {
  await expect.poll(async () => await page.locator('.sidebar-task-create').isVisible()
    || await page.locator('.yeaft-topbar-sidebar-toggle:visible, .header-sidebar-toggle:visible').first().isVisible()).toBe(true);
  if (!await page.locator('.sidebar-task-create').isVisible()) {
    await page.locator('.yeaft-topbar-sidebar-toggle:visible, .header-sidebar-toggle:visible').first().click();
  }
  await expect(page.locator('.sidebar-task-create')).toBeVisible();
}

async function select(page, scope, label, option) {
  if (label === 'Trigger') {
    await scope.getByRole('group', { name: label, exact: true }).getByRole('button', { name: option, exact: true }).click();
  } else {
    await scope.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  }
}

function taskRow(page, name = 'Daily workspace review') {
  return page.locator('.sidebar-session-row').filter({ has: page.locator('.sidebar-session-title-text', { hasText: name }) });
}

async function openTask(page) {
  await showSidebar(page);
  await taskRow(page).click();
  await expect(page.locator('.scheduled-task-bar')).toBeVisible();
  await expect(page.locator('.yeaft-session-input textarea')).toBeVisible();
}

async function shot(page, testInfo, name) {
  const directory = resolve('.yeaft/verification/mobile-redesign');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function noOverflow(page, selectors) {
  await expect.poll(() => page.evaluate(selectors => ({
    document: document.documentElement.scrollWidth > innerWidth + 1,
    elements: selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      return { selector, overflow: element.scrollWidth > element.clientWidth + 1,
        outside: rect.left < -1 || rect.right > innerWidth + 1 };
    }),
  }), selectors)).toEqual({ document: false,
    elements: selectors.map(selector => ({ selector, overflow: false, outside: false })) });
}

test('creates a task Session in recents with selected Agent, directory and VP', async ({ page, serverUrl, mockAgent }, testInfo) => {
  scheduledTaskAgent(mockAgent, { sessions: [], marker: 'Primary' });
  const other = new MockAgent(serverUrl, 'task-secondary');
  await other.connect();
  const secondary = scheduledTaskAgent(other, { marker: 'Secondary' });
  try {
    await boot(page, serverUrl, mockAgent);
    await expect(page.locator('.sidebar-primary-actions > button')).toHaveCount(3);
    for (const [index, name] of ['New chat', 'New task', 'Plugins'].entries()) {
      await expect(page.locator('.sidebar-primary-actions > button').nth(index)).toHaveAccessibleName(name);
    }
    await expect(page.locator('.sidebar-section-toggle')).toHaveText(['Projects', 'Recents']);
    await page.locator('.sidebar-task-create').click();
    const modal = page.locator('.yeaft-session-create-modal.task-mode');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
    await select(page, modal, 'Agent', 'task-secondary');
    other.send({ type: 'yeaft_output', event: { type: 'yeaft_status', model: 'test/reasoner', catalogEpoch: 'task-effort-e2e', catalogRevision: 1, catalogRefreshedAt: Date.now(), availableModels: [
      { provider: 'test', id: 'reasoner', label: 'Task reasoner', effortOptions: ['low', 'medium', 'high', 'xhigh'] },
      { provider: 'test', id: 'plain', label: 'Plain model' },
    ] } });
    const effort = modal.getByRole('combobox', { name: 'Reasoning effort', exact: true });
    await expect(effort).toBeDisabled();
    await select(page, modal, 'Model', 'Task reasoner');
    await expect(effort).toBeEnabled();
    await select(page, modal, 'Reasoning effort', 'X-High');
    await select(page, modal, 'Model', 'Plain model');
    await expect(effort).toBeDisabled();
    await expect(effort).toHaveText('Default');
    await select(page, modal, 'Model', 'Task reasoner');
    await expect(effort).toHaveText('Default');
    await select(page, modal, 'Reasoning effort', 'High');
    await modal.getByPlaceholder('Task name (optional)').fill('Scheduled review with selected VP');
    await modal.locator('.workdir-browse-btn').click();
    const picker = page.locator('.folder-picker-dialog');
    await expect(picker.locator('.folder-picker-list')).toHaveAttribute('aria-busy', 'false');
    await picker.locator('.folder-picker-item').filter({ hasText: 'review-workspace' }).click();
    await expect(picker.locator('.folder-picker-list')).toHaveAttribute('aria-busy', 'false');
    await picker.locator('.folder-picker-footer .btn-primary').click();
    await expect(picker).not.toBeVisible();
    await expect(modal.locator('.workdir-input-group input')).toHaveValue('/tmp/test/review-workspace');
    await modal.locator('.yeaft-roster-trigger').click();
    await modal.locator('.yeaft-roster-item').filter({ hasText: 'Secondary reviewer' }).getByRole('checkbox').check();
    await modal.locator('.yeaft-roster-item').filter({ hasText: 'Secondary reviewer' }).locator('.yeaft-roster-default-star').click();
    await modal.locator('.yeaft-roster-item').filter({ hasText: 'Omni' }).getByRole('checkbox').uncheck();
    const prompt = 'Review workspace changes and report ownership failures.\n' + 'Include verification evidence. '.repeat(25);
    await modal.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt);
    await select(page, modal, 'Trigger', 'Schedule');
    await select(page, modal, 'Repeat', 'Every day');
    await expect(modal.locator('.work-center-schedule-preview')).toBeVisible();
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [320, 'light'], [320, 'dark']]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width, height: 900 });
      await effort.scrollIntoViewIfNeeded();
      await expect(effort).toBeVisible();
      const modelBounds = await modal.getByRole('combobox', { name: 'Model', exact: true }).boundingBox();
      const effortBounds = await effort.boundingBox();
      expect(Math.abs(modelBounds.y - effortBounds.y)).toBeLessThan(2);
      expect(effortBounds.x).toBeGreaterThan(modelBounds.x + modelBounds.width);
      await noOverflow(page, ['.yeaft-session-create-modal', '.scheduled-task-create-body', '.scheduled-task-editor', '.task-model-fields']);
      await effort.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('option', { name: 'X-High', exact: true })).toBeVisible();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await expect(effort).toBeFocused();
      await expect(effort).toHaveText('X-High');
      await select(page, modal, 'Reasoning effort', 'High');
      await shot(page, testInfo, `task-create-${theme}-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await modal.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(modal).not.toBeVisible();
    const created = await other.waitForMessage('yeaft_create_session');
    expect(created.requestId).toBeTruthy();
    expect(created.payload).toMatchObject({ name: 'Scheduled review with selected VP',
      workDir: '/tmp/test/review-workspace', roster: ['reviewer'], defaultVpId: 'reviewer',
      config: { model: 'test/reasoner', modelEffort: 'high' },
      task: { prompt: prompt.trim(), enabled: true, notify: true, trigger: { type: 'schedule',
        scheduledFor: expect.any(Number), recurrence: { frequency: 'daily', timeZone: expect.any(String) } } } });
    expect(created.payload.task.trigger.scheduledFor).toBeGreaterThan(Date.now());
    expect(mockAgent.messages('yeaft_create_session')).toHaveLength(0);
    expect(other.messages('create_conversation')).toHaveLength(0);
    await expect(page.locator('.scheduled-task-bar')).toContainText('Next run');
    await showSidebar(page);
    await expect(taskRow(page, 'Scheduled review with selected VP')).toHaveCount(1);
    await expect(page.locator('.recents-section .session-item')).toHaveCount(3);
    await expect(page.locator('.recents-section')).toContainText('Scheduled review with selected VP');
    await expect(taskRow(page, 'Scheduled review with selected VP').getByRole('img', { name: 'Task', exact: true })).toBeVisible();
    await expect(page.locator('.tasks-section')).toHaveCount(0);
    for (const section of ['projects', 'recents']) {
      const toggle = page.locator(`.${section}-section .sidebar-section-toggle`);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    await page.locator('.recents-section .session-item').filter({ hasText: 'Ordinary conversation' }).click();
    await expect(page.locator('.scheduled-task-bar')).toHaveCount(0);
    await showSidebar(page);
    await taskRow(page, 'Scheduled review with selected VP').click();
    await expect(page.locator('.assistant-turn')).toContainText('Secondary: persistent conversation for created-task-1');
    const composer = page.locator('.yeaft-session-input textarea');
    await composer.fill('Explain the latest task result');
    await composer.press('Enter');
    const sent = await other.waitForMessage('yeaft_session_send');
    expect(sent).toMatchObject({ sessionId: 'created-task-1', text: 'Explain the latest task result' });
    expect(secondary.sessions.get('created-task-1').task.trigger.type).toBe('schedule');
    expect(secondary.sessions.get('created-task-1').config).toEqual({ model: 'test/reasoner', modelEffort: 'high' });
    await page.reload();
    await expect.poll(() => page.evaluate(({ agentId }) => window.Pinia.useSessionsStore()
      .sessionById('created-task-1', agentId)?.config, { agentId: other.agentId }))
      .toEqual({ model: 'test/reasoner', modelEffort: 'high' });
    expect(mockAgent.messages('yeaft_session_send')).toHaveLength(0);
    await shot(page, testInfo, 'task-session-conversation.png');
  } finally { await other.disconnect(); }
});

test('task rows share pin, drag, Project menu, rename and removal behavior with Sessions', async ({ page, serverUrl, mockAgent }, testInfo) => {
  const state = scheduledTaskAgent(mockAgent);
  await boot(page, serverUrl, mockAgent);
  const recents = page.locator('.recents-section');
  const projects = page.locator('.projects-section');
  const task = taskRow(page);
  const chat = recents.locator('.sidebar-session-row').filter({ hasText: 'Ordinary conversation' });
  await expect(task).toHaveAttribute('draggable', 'true');
  await expect(task.getByRole('img', { name: 'Task', exact: true })).toBeVisible();
  await task.hover();
  await task.getByRole('button', { name: 'Pin to top', exact: true }).click();
  await expect(task.locator('.session-pin-icon')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(window.Pinia.useChatStore().sessionCatalogMutationRequests).length)).toBe(0);
  await task.hover();
  await task.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(task.locator('.session-pin-icon')).toHaveCount(0);
  await task.dragTo(chat, { targetPosition: { x: 80, y: 30 } });
  await expect(recents.locator('.sidebar-session-title-text')).toHaveText(['Ordinary conversation', 'Daily workspace review']);
  await projects.locator('.sidebar-section-heading').hover();
  await projects.getByRole('button', { name: 'New project', exact: true }).click();
  await projects.locator('.sidebar-project-create input').fill('Automation');
  await projects.locator('.sidebar-project-create-confirm').click();
  const project = projects.locator('.sidebar-project').filter({ hasText: 'Automation' });
  await expect(project.locator('.sidebar-project-header')).toBeVisible();
  await task.dragTo(project.locator('.sidebar-project-header'));
  await expect(project.locator('.sidebar-session-row')).toHaveCount(1);
  await expect(recents.locator('.sidebar-session-row')).toHaveCount(1);
  await page.reload();
  await expect(project.locator('.sidebar-session-task')).toBeVisible();
  await task.hover();
  await task.locator('.session-dots-btn').click();
  await page.getByRole('button', { name: 'Remove from project', exact: true }).click();
  await expect(recents.locator('.sidebar-session-task')).toBeVisible();
  await task.hover();
  await task.locator('.session-dots-btn').click();
  await page.getByRole('button', { name: 'Move to Projects', exact: true }).click();
  await page.locator('.session-submenu').getByRole('button', { name: 'Automation', exact: true }).click();
  await expect(project.locator('.sidebar-session-task')).toBeVisible();
  await task.dragTo(recents.locator('.sidebar-section-heading'));
  await expect(recents.locator('.sidebar-session-task')).toBeVisible();
  await expect(project.locator('.sidebar-session-row')).toHaveCount(0);
  await task.hover();
  await task.locator('.session-dots-btn').click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.locator('.app-dialog-input').fill('Review automation — daily workspace checks and delivery summary');
  await page.locator('.app-dialog-confirm').click();
  const renamed = taskRow(page, 'Review automation');
  await expect(renamed).toBeVisible();
  expect(state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(true);
  // The badge remains visible with clipped titles and keyboard focus.
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [320, 'light'], [320, 'dark']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await showSidebar(page);
    await page.mouse.move(0, 0);
    await renamed.focus();
    await expect(renamed.getByRole('img', { name: 'Task', exact: true })).toBeVisible();
    expect(await renamed.locator('.sidebar-session-title-text').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await noOverflow(page, ['.sidebar-navigation', '.recents-section']);
    await shot(page, testInfo, `task-sidebar-${theme}-${width}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await renamed.hover();
  await renamed.getByRole('button', { name: 'Remove from sidebar', exact: true }).click();
  await expect(renamed).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.sidebar-navigation')).toHaveAttribute('aria-busy', 'false');
  await expect(taskRow(page, 'Review automation')).toHaveCount(0);
  await expect(recents.locator('.sidebar-session-row')).toHaveCount(1);
  // Removing a row has exactly the normal Session visibility-only semantics.
  expect(state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(true);
  expect(state.requests.filter(request => request.type === 'yeaft_scheduled_task')).toHaveLength(0);
});

test('task editing preserves failed drafts for retry, then manually runs the same Session', async ({ page, serverUrl, mockAgent }, testInfo) => {
  const state = scheduledTaskAgent(mockAgent);
  const initialRevision = state.sessions.get(TASK_SESSION_ID).task.revision;
  await boot(page, serverUrl, mockAgent);
  await openTask(page);
  await expect(page.locator('.assistant-turn')).toContainText(`persistent conversation for ${TASK_SESSION_ID}`);
  await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
  const settings = page.locator('.scheduled-task-settings');
  await settings.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Retry this edited prompt without losing changes.');
  await settings.locator('.scheduled-task-option-row').filter({ hasText: 'Notify when finished' }).click();
  await expect(settings.getByRole('switch', { name: 'Notify when finished', exact: true })).not.toBeChecked();
  await select(page, settings, 'Trigger', 'Schedule');
  await select(page, settings, 'Trigger', 'Manual');
  state.holdUpdates = true;
  await settings.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect.poll(() => state.heldUpdates.length).toBe(1);
  await expect(settings.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect(settings.getByRole('textbox', { name: 'Prompt', exact: true })).toBeDisabled();
  state.replyUpdate(state.heldUpdates.shift(), 'Agent could not persist the task; retry safely.');
  await expect(settings.getByRole('alert')).toHaveText('Agent could not persist the task; retry safely.');
  await expect(settings.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Retry this edited prompt without losing changes.');
  await expect(settings.getByRole('switch', { name: 'Notify when finished', exact: true })).not.toBeChecked();
  expect(state.sessions.get(TASK_SESSION_ID).task.prompt).toBe('Review ownership and recovery.');
  await shot(page, testInfo, 'task-edit-failure-retry.png');
  state.holdUpdates = false;
  await settings.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'update').length).toBe(2);
  const updates = state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'update');
  expect(updates).toHaveLength(2);
  expect(updates[0].requestId).not.toBe(updates[1].requestId);
  expect(updates[1]).toMatchObject({ sessionId: TASK_SESSION_ID, expectedRevision: initialRevision, task: { prompt: 'Retry this edited prompt without losing changes.',
    enabled: true, notify: false, trigger: { type: 'manual' } } });
  expect(updates[1].task).not.toHaveProperty('lastRun');
  expect(state.sessions.get(TASK_SESSION_ID).task.revision).not.toBe(initialRevision);
  expect(state.sessions.get(TASK_SESSION_ID).task.lastRun).toBeNull();
  await page.locator('.group-settings-close').click();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect.poll(() => state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'run').length).toBe(1);
  const runRequest = state.requests.find(request => request.type === 'yeaft_scheduled_task' && request.op === 'run');
  expect(runRequest).toMatchObject({ sessionId: TASK_SESSION_ID, requestId: expect.any(String) });
  expect(runRequest).not.toHaveProperty('task');
  await expect(page.locator('.scheduled-task-bar')).toContainText('Completed');
  await expect(page.locator('.yeaft-session-input textarea')).toBeVisible();
  await shot(page, testInfo, 'task-manual-run-completed.png');
  // An active attempt must not lock users out of pausing the next schedule.
  const active = state.sessions.get(TASK_SESSION_ID);
  active.task.lastRun = { id: 'ongoing-run', status: 'running', trigger: 'schedule', startedAt: Date.now() };
  state.publish();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
  await settings.locator('.scheduled-task-option-row').filter({ hasText: 'Enabled' }).click();
  await settings.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect.poll(() => state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(false);
  expect(state.sessions.get(TASK_SESSION_ID).task.lastRun.status).toBe('running');
  await page.locator('.group-settings-close').click();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
});

test('completion notifications open the owning Agent when two Agents share the same Session id', async ({ page, serverUrl, mockAgent }, testInfo) => {
  scheduledTaskAgent(mockAgent, { marker: 'Agent A' });
  const other = new MockAgent(serverUrl, 'task-notification-agent-b');
  try {
    await boot(page, serverUrl, mockAgent);
    await openTask(page);
    await expect(page.locator('.assistant-turn')).toContainText('Agent A: persistent conversation');
    await other.connect();
    const second = scheduledTaskAgent(other, { marker: 'Agent B', sessions: [taskSession()] });
    await expect(taskRow(page)).toHaveCount(2);
    second.notify({ status: 'failed', error: 'Workspace check needs attention.' });
    const notice = page.locator('.scheduled-task-notification-open');
    await expect(notice).toContainText('Daily workspace review');
    await expect(notice).toContainText('Workspace check needs attention.');
    await page.setViewportSize({ width: 320, height: 900 });
    await noOverflow(page, ['.scheduled-task-notifications']);
    await shot(page, testInfo, 'task-notification-light-320.png');
    await notice.click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.yeaft-topbar-session-title')).toHaveText('Daily workspace review');
    await expect(page.locator('.assistant-turn')).toContainText(`Agent B: persistent conversation for ${TASK_SESSION_ID}`);
    await expect(page.locator('.assistant-turn')).not.toContainText('Agent A: persistent conversation');
    expect(other.messages('yeaft_load_history').some(request => request.sessionId === TASK_SESSION_ID && request.limit !== 0)).toBe(true);
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [320, 'dark']]) {
      if (theme === 'dark' && width === 1440) {
        await page.evaluate(() => localStorage.setItem('theme', 'dark'));
        await page.reload();
        await expect(page.locator('.scheduled-task-bar')).toBeVisible();
      }
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await noOverflow(page, ['.yeaft-main-center', '.scheduled-task-bar', '.yeaft-session-input']);
      await shot(page, testInfo, `task-conversation-${theme}-${width}.png`);
      await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
      await noOverflow(page, ['.group-settings-modal', '.scheduled-task-settings']);
      await shot(page, testInfo, `task-settings-${theme}-${width}.png`);
      await page.locator('.group-settings-close').click();
    }
    await page.locator('.yeaft-session-input textarea').fill('Follow up with the notified task');
    await page.locator('.yeaft-session-input textarea').press('Enter');
    const sent = await other.waitForMessage('yeaft_session_send');
    expect(sent).toMatchObject({ sessionId: TASK_SESSION_ID, text: 'Follow up with the notified task' });
    expect(mockAgent.messages('yeaft_session_send')).toHaveLength(0);
  } finally { await other.disconnect(); }
});

test('an older Agent cannot turn New task into an ordinary Session', async ({ page, serverUrl, mockAgent }, testInfo) => {
  scheduledTaskAgent(mockAgent, { capabilities: TASK_CAPABILITIES.filter(capability => capability !== 'scheduled_tasks'),
    sessions: [{ id: CHAT_SESSION_ID, name: 'Legacy Agent conversation', roster: ['omni'], defaultVpId: 'omni' }] });
  await boot(page, serverUrl, mockAgent);
  await page.locator('.sidebar-task-create').click();
  const modal = page.locator('.yeaft-session-create-modal.task-mode');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
  await expect(modal.getByRole('status')).toContainText('Update this Agent to support tasks');
  await modal.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Do not silently create a chat.');
  await expect(modal.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  await modal.getByPlaceholder('Task name (optional)').fill('Blocked task');
  await modal.getByPlaceholder('Task name (optional)').press('Enter');
  await shot(page, testInfo, 'task-legacy-agent-blocked.png');
  expect(mockAgent.messages('yeaft_create_session')).toHaveLength(0);
  expect(mockAgent.messages('create_conversation')).toHaveLength(0);
  await expect(page.locator('.sidebar-session-task')).toHaveCount(0);
});

test('another tab pausing a task fences a dirty draft until reload and never silently re-enables it', async ({ page, context, serverUrl, mockAgent }) => {
  const state = scheduledTaskAgent(mockAgent);
  await boot(page, serverUrl, mockAgent);
  await openTask(page);
  await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
  const settings = page.locator('.scheduled-task-settings');
  await settings.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Unsaved local draft must not revive a paused task.');
  const secondTab = await context.newPage();
  await boot(secondTab, serverUrl, mockAgent);
  await openTask(secondTab);
  await secondTab.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
  const secondSettings = secondTab.locator('.scheduled-task-settings');
  await secondSettings.locator('.scheduled-task-option-row').filter({ hasText: 'Enabled' }).click();
  await expect(secondSettings.getByRole('switch', { name: 'Enabled', exact: true })).not.toBeChecked();
  await secondSettings.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(secondSettings.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
  await expect.poll(() => state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(false);
  await expect(settings.locator('.scheduled-task-stale')).toBeVisible();
  await expect(settings.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Unsaved local draft must not revive a paused task.');
  await expect(settings.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
  expect(state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'update')).toHaveLength(1);
  await settings.locator('.scheduled-task-stale button').click();
  await expect(settings.locator('.scheduled-task-stale')).toHaveCount(0);
  await expect(settings.getByRole('switch', { name: 'Enabled', exact: true })).not.toBeChecked();
  await expect(settings.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Review ownership and recovery.');
  await settings.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Explicit edit after accepting the paused task.');
  await settings.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
  await expect.poll(() => state.sessions.get(TASK_SESSION_ID).task.prompt).toBe('Explicit edit after accepting the paused task.');
  expect(state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(false);
  const updates = state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'update');
  expect(updates).toHaveLength(2);
  expect(updates[0].expectedRevision).toEqual(expect.any(String));
  expect(updates[1].expectedRevision).not.toBe(updates[0].expectedRevision);
  expect(updates[1].task.enabled).toBe(false);
  await secondTab.close();
});

async function touchTargets(scope, selector) {
  const targets = await scope.locator(selector).evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height && getComputedStyle(element).visibility !== 'hidden';
  }).map(element => {
    const rect = element.getBoundingClientRect();
    return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height };
  }));
  expect.soft(targets.filter(target => target.width < 44 || target.height < 44),
    'Every visible task control needs a minimum 44×44px hit target').toEqual([]);
}

async function scrollWithoutFooterOverlap(page, scrollerSelector, footerSelector) {
  const result = await page.locator(scrollerSelector).evaluate((element, footerSelector) => {
    element.scrollTop = element.scrollHeight;
    const footer = document.querySelector(footerSelector).getBoundingClientRect();
    const body = element.getBoundingClientRect();
    const last = element.querySelector('.scheduled-task-editor').getBoundingClientRect();
    return { scrollable: element.scrollHeight > element.clientHeight, scrolled: element.scrollTop > 0,
      bodyAboveFooter: body.bottom <= footer.top + 1, lastFieldAboveFooter: last.bottom <= footer.top + 1,
      footerVisible: footer.top >= 0 && footer.bottom <= innerHeight + 1,
      footerTop: footer.top, footerBottom: footer.bottom, viewportHeight: innerHeight };
  }, footerSelector);
  expect.soft(result).toMatchObject({ bodyAboveFooter: true, lastFieldAboveFooter: true, footerVisible: true });
  if (await page.evaluate(() => innerWidth <= 900)) expect.soft(result).toMatchObject({ scrollable: true, scrolled: true });
}

test('redesigned task surfaces retain usable geometry, scrolling and keyboard controls across mobile themes and desktop', async ({ page, serverUrl, mockAgent }, testInfo) => {
  test.setTimeout(120000);
  const prompt = 'Review the complete workspace and preserve ownership boundaries.\n'.repeat(60);
  const state = scheduledTaskAgent(mockAgent, { sessions: [taskSession({ name: 'Daily workspace review',
    task: { ...taskSession().task, prompt, trigger: { type: 'schedule', scheduledFor: Date.now() + 86400000,
      recurrence: { frequency: 'daily', timeZone: 'UTC' } } } })] });
  await boot(page, serverUrl, mockAgent);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      // MatchMedia changes arrive after setViewportSize. Wait for the rendered
      // sidebar projection, not a transient desktop-visible row on mobile.
      await expect.poll(() => page.locator('.yeaft-sidebar').evaluate(element => ({
        width: innerWidth, collapsed: element.classList.contains('collapsed'),
      }))).toEqual({ width, collapsed: width < 769 });
      await showSidebar(page);
      await page.locator('.sidebar-task-create').click();
      const create = page.locator('.yeaft-session-create-modal.task-mode');
      await expect(create.locator('.task-create-header')).toBeVisible();
      await create.getByRole('textbox', { name: 'Prompt', exact: true }).fill(prompt);
      await select(page, create, 'Trigger', 'Schedule');
      await select(page, create, 'Repeat', 'Every day');
      await noOverflow(page, ['.yeaft-session-create-modal', '.session-create-flow.is-task', '.scheduled-task-create-body', '.scheduled-task-editor']);
      await create.locator('.session-create-flow').evaluate(element => { element.scrollTop = 0; });
      await shot(page, testInfo, `redesign-create-top-${theme}-${width}.png`);
      await scrollWithoutFooterOverlap(page, '.session-create-flow.is-task', '.task-mode .resume-modal-footer');
      await shot(page, testInfo, `redesign-create-schedule-${theme}-${width}.png`);
      const longPrompt = create.getByRole('textbox', { name: 'Prompt', exact: true });
      expect(await longPrompt.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      if (width < 641) await touchTargets(create, 'button');
      await create.locator('.task-create-close').focus();
      await page.keyboard.press('Enter');
      await expect(create).not.toBeVisible();
      await openTask(page);
      state.notify({ runId: `visual-${theme}-${width}`, status: 'failed', error: 'Long task result needs attention: ' + 'verification evidence '.repeat(8) });
      await expect(page.locator('.scheduled-task-notification-open')).toBeVisible();
      await noOverflow(page, ['.yeaft-main-center', '.scheduled-task-bar', '.yeaft-session-input', '.scheduled-task-notifications']);
      await shot(page, testInfo, `redesign-task-notifications-${theme}-${width}.png`);
      if (width < 641) {
        await touchTargets(page.locator('.scheduled-task-bar'), 'button');
        await touchTargets(page.locator('.scheduled-task-notifications'), 'button');
      }
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
      await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
      const settings = page.locator('.task-settings-modal');
      await expect(settings.locator('.task-settings-nav')).toBeVisible();
      await noOverflow(page, ['.task-settings-modal', '.scheduled-task-settings', '.scheduled-task-settings-scroll']);
      await shot(page, testInfo, `redesign-settings-top-${theme}-${width}.png`);
      await scrollWithoutFooterOverlap(page, '.scheduled-task-settings-scroll', '.scheduled-task-settings-footer');
      await shot(page, testInfo, `redesign-settings-schedule-${theme}-${width}.png`);
      if (width < 641) await touchTargets(settings, 'button');
      const tabs = settings.getByRole('tab');
      await settings.locator('.group-settings-close').focus();
      await page.keyboard.press('Tab');
      await expect(tabs.first()).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Tab');
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await settings.locator('.group-settings-close').click();
    }
  }
});


test('task form prioritizes required prompt and saves weekly or multiple monthly dates without desktop scrolling', async ({ page, serverUrl, mockAgent }, testInfo) => {
  scheduledTaskAgent(mockAgent, { sessions: [] });
  await boot(page, serverUrl, mockAgent);
  await page.locator('.sidebar-task-create').click();
  const modal = page.locator('.task-mode');
  const prompt = modal.getByRole('textbox', { name: 'Prompt', exact: true });
  await expect(prompt).toHaveAttribute('required', '');
  await expect(prompt).toHaveAttribute('aria-required', 'true');
  await expect(modal.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  await modal.getByPlaceholder('Task name (optional)').fill('Multi-date task');
  await prompt.fill('Review selected dates and retain results in this task.');
  const ordering = await modal.evaluate(element => {
    const prompt = element.querySelector('textarea');
    const controls = element.querySelector('.resume-modal-controls');
    return { beforeAgent: !!(prompt.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING),
      aboveAgent: prompt.getBoundingClientRect().top < controls.getBoundingClientRect().top };
  });
  expect(ordering).toEqual({ beforeAgent: true, aboveAgent: true });
  await select(page, modal, 'Trigger', 'Schedule');
  await select(page, modal, 'Repeat', 'Every week');
  const weekdays = modal.locator('.work-center-schedule-weekdays');
  await weekdays.getByRole('button', { name: 'Wednesday', exact: true }).click();
  await weekdays.getByRole('button', { name: 'Friday', exact: true }).click();
  await expect(weekdays.locator('[aria-pressed="true"]')).toHaveCount(3);
  await shot(page, testInfo, 'calendar-weekly-light-desktop.png');
  await select(page, modal, 'Repeat', 'Every month');
  const days = modal.locator('.task-month-days-grid');
  for (const button of await days.locator('[aria-pressed="true"]').all()) await button.click();
  await expect(modal.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  for (const day of ['1', '15', '31']) await days.getByRole('button', { name: day, exact: true }).click();
  await expect(days.locator('[aria-pressed="true"]')).toHaveText(['1', '15', '31']);
  await expect(modal.getByRole('button', { name: 'Create task', exact: true })).toBeEnabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [320, 844]]) {
      await page.setViewportSize({ width, height });
      await noOverflow(page, ['.task-mode', '.scheduled-task-editor', '.task-month-days-grid']);
      if (width > 900) {
        const geometry = await modal.locator('.session-create-flow').evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
        expect(geometry.content, JSON.stringify({ width, height, geometry })).toBeLessThanOrEqual(geometry.height + 1);
        expect((await modal.boundingBox()).width).toBeGreaterThan(1000);
      } else {
        await touchTargets(modal, '.task-month-days-grid button, .scheduled-task-trigger-options button');
      }
      await shot(page, testInfo, `calendar-monthly-${theme}-${width}.png`);
    }
  }
  await page.evaluate(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$locale.value = 'zh-CN'; });
  await expect(modal.locator('.scheduled-task-prompt textarea')).toHaveAttribute('aria-label', '提示词');
  for (const [width, height] of [[1280, 720], [320, 844]]) {
    await page.setViewportSize({ width, height });
    await noOverflow(page, ['.task-mode', '.scheduled-task-editor', '.task-month-days-grid']);
    if (width > 900) expect(await modal.locator('.session-create-flow').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    else await days.scrollIntoViewIfNeeded();
    await shot(page, testInfo, `calendar-monthly-zh-dark-${width}.png`);
  }
  await page.evaluate(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$locale.value = 'en'; });
  await page.setViewportSize({ width: 1440, height: 900 });
  const advanced = modal.locator('.task-schedule-advanced');
  await advanced.locator('summary').click();
  await select(page, modal, 'Time zone', 'Asia/Shanghai');
  await select(page, modal, 'Ends', 'After a number of runs');
  await modal.getByRole('spinbutton').fill('12');
  await modal.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(modal).not.toBeVisible();
  const created = await mockAgent.waitForMessage('yeaft_create_session');
  expect(created.payload.task.trigger.recurrence).toMatchObject({ frequency: 'monthly', daysOfMonth: [1, 15, 31], timeZone: 'Asia/Shanghai', maxRuns: 12 });
  expect(created.payload.task.trigger.recurrence).not.toHaveProperty('dayOfMonth');
  await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
  const settings = page.locator('.scheduled-task-settings');
  await expect(settings.locator('.task-month-days-grid [aria-pressed="true"]')).toHaveText(['1', '15', '31']);
  await settings.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Updated monthly prompt.');
  await settings.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Save task', exact: true })).toBeDisabled();
  const update = mockAgent.messages('yeaft_scheduled_task').find(message => message.op === 'update');
  expect(update.task.trigger.recurrence.daysOfMonth).toEqual([1, 15, 31]);
});

// Shell, footer and the column anchors must not move when changing trigger.
async function taskGeometry(modal) {
  return modal.evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const shell = rect(element);
    const footer = rect(element.querySelector('.resume-modal-footer, .scheduled-task-settings-footer'));
    const left = rect(element.querySelector('.scheduled-task-content'));
    const right = rect(element.querySelector('.scheduled-task-sidebar'));
    const environment = element.querySelector('.scheduled-task-environment');
    return { top: shell.y, height: shell.height, footer, leftX: left.x, rightX: right.x,
      environment: environment ? rect(environment) : null };
  });
}

async function quietAction(page, button) {
  await page.mouse.move(0, 0);
  await expect(button).toBeVisible();
  await expect.poll(() => button.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, framed: style.borderStyle !== 'none'
      && style.borderWidth !== '0px' && style.borderColor !== 'rgba(0, 0, 0, 0)' };
  })).toEqual({ background: 'rgba(0, 0, 0, 0)', framed: false });
  if (await button.isEnabled()) {
    await button.hover();
    await expect.poll(() => button.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    // Keyboard focus is intentionally visible even though the resting box is not.
    await button.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(button).toBeFocused();
    expect(await button.evaluate(element => ({ style: getComputedStyle(element).outlineStyle,
      width: getComputedStyle(element).outlineWidth }))).toEqual({ style: 'solid', width: '2px' });
  }
  await page.mouse.move(0, 0);
}

test('task and Settings controls share theme-aware switches, quiet actions and a stable full-height layout', async ({ page, serverUrl, mockAgent }, testInfo) => {
  test.setTimeout(120000);
  scheduledTaskAgent(mockAgent);
  mockAgent._messageHandlers.push(request => {
    if (request.type === 'get_llm_config') mockAgent.send({ type: 'llm_config', requestId: request.requestId,
      _requestClientId: request._requestClientId, agentConfig: { quickSends: [{ id: 'check', name: 'Check', model: 'test/review' }], availableModels: [] } });
  });
  await boot(page, serverUrl, mockAgent);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('.sidebar-bottom .sidebar-nav-item').click();
    const settingsSwitch = page.locator('.sp-setting-switch[aria-labelledby="general-work-center-label"]');
    if (await settingsSwitch.getAttribute('aria-checked') !== 'true') await settingsSwitch.click();
    await expect.poll(() => settingsSwitch.evaluate(element => element.getAnimations().length)).toBe(0);
    const expected = await settingsSwitch.evaluate(element => ({
      track: getComputedStyle(element).backgroundColor,
      knob: getComputedStyle(element.querySelector('.sp-setting-switch-knob')).backgroundColor,
    }));
    expect(expected.track).toBe(theme === 'light' ? 'rgb(74, 124, 201)' : 'rgb(181, 178, 173)');
    const dangerColor = await page.evaluate(() => {
      const marker = document.createElement('span'); marker.style.color = 'var(--error)';
      document.body.append(marker); const color = getComputedStyle(marker).color; marker.remove(); return color;
    });
    await page.locator('.settings-nav-item').filter({ hasText: 'Security' }).click();
    const security = page.locator('.settings-pane:visible');
    await expect(security.locator('.agent-installer-copy svg')).toHaveCount(0);
    await quietAction(page, security.locator('.sp-btn:not(.sp-btn-danger)').first());
    await quietAction(page, security.locator('.sp-btn-danger').first());
    expect(await security.locator('.sp-btn-danger').first().evaluate(element => getComputedStyle(element).color))
      .not.toBe(await security.locator('.sp-btn:not(.sp-btn-danger)').first().evaluate(element => getComputedStyle(element).color));
    await shot(page, testInfo, `settings-quiet-actions-${theme}.png`);
    await page.locator('.settings-close').click();
    await page.locator('.agent-dropdown-trigger:visible').click();
    await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
    const agentSettings = page.locator('.agent-settings-dialog');
    const agentSwitch = agentSettings.getByRole('switch', { name: 'Digital Person', exact: true });
    await page.evaluate(() => window.Pinia.useChatStore().setDigitalPersonUiEnabled(true));
    await expect(agentSwitch).toBeChecked();
    await expect.poll(() => agentSwitch.evaluate(element => ({
      track: getComputedStyle(element.nextElementSibling).backgroundColor,
      knob: getComputedStyle(element.nextElementSibling, '::after').backgroundColor,
    }))).toEqual(expected);
    // Do not invoke real maintenance actions. Inspect enabled/disabled styling only.
    await quietAction(page, agentSettings.locator('.btn-secondary').first());
    await agentSettings.locator('.agent-settings-nav-item').last().click();
    const quickRemove = agentSettings.locator('.quick-send-remove').first();
    await expect(quickRemove).toBeVisible();
    await expect(agentSettings.locator('.quick-send-settings')).toHaveAttribute('aria-busy', 'false');
    await quickRemove.hover();
    await expect.poll(() => quickRemove.evaluate(element => getComputedStyle(element).color))
      .toBe(dangerColor);
    await agentSettings.locator('.agent-settings-close').click();
    await page.evaluate(() => window.Pinia.useChatStore().setDigitalPersonUiEnabled(false));

    await page.locator('.sidebar-task-create').click();
    const modal = page.locator('.task-mode');
    const create = modal.getByRole('button', { name: 'Create task', exact: true });
    await expect(create.locator('svg')).toHaveCount(0);
    await quietAction(page, create); // The disabled state must not become a filled block either.
    await modal.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Summarize workspace changes and report the results.');
    await expect(create).toBeEnabled();
    await quietAction(page, create);
    await quietAction(page, modal.getByRole('button', { name: 'Cancel', exact: true }));
    const switches = modal.locator('.agent-settings-switch input');
    for (const control of await switches.all()) {
      await expect.poll(() => control.evaluate(element => ({
        track: getComputedStyle(element.nextElementSibling).backgroundColor,
        knob: getComputedStyle(element.nextElementSibling, '::after').backgroundColor,
      }))).toEqual(expected);
    }
    await modal.locator('.scheduled-task-option-row').first().click();
    await expect(switches.first()).not.toBeChecked();
    await expect.poll(() => switches.first().evaluate(element => getComputedStyle(element.nextElementSibling).backgroundColor)).not.toBe(expected.track);
    await switches.first().focus();
    await page.keyboard.press('Space');
    await expect(switches.first()).toBeChecked();
    const trigger = modal.getByRole('group', { name: 'Trigger', exact: true });
    const manual = trigger.getByRole('button', { name: 'Manual', exact: true });
    await expect(manual).toHaveAttribute('aria-pressed', 'true');
    await quietAction(page, manual);
    expect(await manual.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe(expected.track);
    const createGeometry = await taskGeometry(modal);
    await select(page, modal, 'Trigger', 'Schedule');
    expect(await taskGeometry(modal)).toEqual(createGeometry);
    await expect(manual).toHaveAttribute('aria-pressed', 'false');
    await quietAction(page, trigger.getByRole('button', { name: 'Schedule', exact: true }));
    await select(page, modal, 'Repeat', 'Every month');
    expect(await taskGeometry(modal)).toEqual(createGeometry);
    await modal.locator('.task-schedule-advanced summary').click();
    expect(await taskGeometry(modal)).toEqual(createGeometry);
    await modal.locator('.task-schedule-advanced summary').click();
    await select(page, modal, 'Trigger', 'Manual');
    expect(await taskGeometry(modal)).toEqual(createGeometry);

    await page.evaluate(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$locale.value = 'zh-CN'; });
    for (const [width, height] of [[1440, 900], [1280, 720], [1440, 480], [1024, 400], [800, 600], [320, 844], [320, 480]]) {
      await page.setViewportSize({ width, height });
      await noOverflow(page, ['.task-mode', '.scheduled-task-create-body', '.scheduled-task-editor']);
      const geometry = await modal.evaluate(element => {
        const shell = element.getBoundingClientRect();
        const editor = element.querySelector('.scheduled-task-editor').getBoundingClientRect();
        const footer = element.querySelector('.resume-modal-footer').getBoundingClientRect();
        return { height: shell.height, top: shell.top, footer: footer.bottom,
          borderBottom: parseFloat(getComputedStyle(element).borderBottomWidth), gap: footer.top - editor.bottom };
      });
      expect(geometry.height).toBe(width <= 640 ? height : height - 48);
      expect(geometry.top).toBe(width <= 640 ? 0 : 24);
      // Footer ends inside the shell's border, not at its outer edge.
      expect(geometry.footer).toBe(height - (width <= 640 ? 0 : 24) - geometry.borderBottom);
      if (width > 900) {
        expect(geometry.gap).toBeLessThan(40);
        expect(await modal.locator('.session-create-flow').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      } else if (width <= 640) await touchTargets(modal, 'button');
      await page.mouse.move(0, 0);
      await shot(page, testInfo, `quiet-task-create-${theme}-${width}.png`);
      if (width === 320) {
        await modal.locator('.scheduled-task-options').scrollIntoViewIfNeeded();
        await shot(page, testInfo, `quiet-task-create-controls-${theme}-${width}.png`);
      }
    }
    await modal.locator('.task-create-close').click();
    await page.evaluate(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$locale.value = 'en'; });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTask(page);
    await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
    const taskSettings = page.locator('.scheduled-task-settings');
    await taskSettings.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Edited prompt for the quiet save action.');
    await quietAction(page, taskSettings.getByRole('button', { name: 'Save task', exact: true }));
    const settingsModal = page.locator('.task-settings-modal');
    const settingsGeometry = await taskGeometry(settingsModal);
    expect(settingsGeometry.height).toBe(852);
    await select(page, taskSettings, 'Trigger', 'Schedule');
    expect(await taskGeometry(settingsModal)).toEqual(settingsGeometry);
    await select(page, taskSettings, 'Repeat', 'Every month');
    expect(await taskGeometry(settingsModal)).toEqual(settingsGeometry);
    const selectedDay = taskSettings.locator('.task-month-days-grid [aria-pressed="true"]').first();
    expect(await selectedDay.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    const advanced = taskSettings.locator('.task-schedule-advanced');
    await advanced.locator('summary').click();
    expect(await taskGeometry(settingsModal)).toEqual(settingsGeometry);
    const dateInput = advanced.locator('.schedule-date-picker__trigger').first();
    await expect(dateInput).toBeVisible();
    expect(await dateInput.evaluate(element => ({ border: getComputedStyle(element).borderWidth,
      background: getComputedStyle(element).backgroundColor, borderColor: getComputedStyle(element).borderColor }))).toMatchObject({ border: '1px', borderColor: expect.not.stringMatching(/rgba\(0, 0, 0, 0\)/) });
    expect(await dateInput.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await advanced.locator('summary').click();
    await shot(page, testInfo, `quiet-task-settings-monthly-${theme}.png`);
    for (const [width, height] of [[1440, 480], [1024, 400], [800, 600], [320, 480]]) {
      await page.setViewportSize({ width, height });
      await noOverflow(page, ['.task-settings-modal', '.scheduled-task-settings-scroll', '.scheduled-task-editor']);
      const shell = await settingsModal.boundingBox();
      expect(shell.height).toBe(width <= 640 ? height : height - 48);
      expect(shell.y).toBe(width <= 640 ? 0 : 24);
      const footer = await taskSettings.locator('.scheduled-task-settings-footer').boundingBox();
      expect(footer.y + footer.height).toBeLessThanOrEqual(height);
      const timing = taskSettings.locator('.scheduled-task-timing');
      if (width > 900) {
        expect(await timing.evaluate(element => element.clientHeight), 'Schedule must retain a usable scroll viewport at low height').toBeGreaterThanOrEqual(80);
      }
      await taskSettings.getByRole('button', { name: 'Schedule', exact: true }).scrollIntoViewIfNeeded();
      await expect(taskSettings.getByRole('button', { name: 'Schedule', exact: true })).toBeInViewport();
      await taskSettings.getByRole('switch', { name: 'Notify when finished', exact: true }).scrollIntoViewIfNeeded();
      await expect(taskSettings.getByRole('switch', { name: 'Notify when finished', exact: true })).toBeInViewport();
      await shot(page, testInfo, `quiet-task-settings-low-height-${theme}-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.task-settings-modal').getByRole('tab', { name: 'Session', exact: true }).click();
    expect(await settingsModal.evaluate(element => ({ height: element.getBoundingClientRect().height, top: element.getBoundingClientRect().top })))
      .toEqual({ height: settingsGeometry.height, top: settingsGeometry.top });
    const sessionPane = page.locator('.group-settings-section-session');
    await sessionPane.locator('.group-settings-input').first().fill('Edited task title');
    await quietAction(page, sessionPane.locator('.group-settings-primary').first());
    await page.locator('.task-settings-modal .group-settings-close').click();
  }
});
