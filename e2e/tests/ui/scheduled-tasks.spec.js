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
  return page.locator('.tasks-section .session-item').filter({ has: page.locator('.sidebar-session-title-text', { hasText: name }) });
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

test('creates a scheduled Session with selected Agent, directory and VP, without duplicating it in recents', async ({ page, serverUrl, mockAgent }, testInfo) => {
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
    await expect(page.locator('.sidebar-section-toggle')).toHaveText(['Projects', 'Tasks', 'Recents']);
    await page.locator('.sidebar-task-create').click();
    const modal = page.locator('.yeaft-session-create-modal.task-mode');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Provider', exact: true })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
    await select(page, modal, 'Agent', 'task-secondary');
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
    for (const width of [1440, 320]) {
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page, ['.yeaft-session-create-modal', '.scheduled-task-create-body', '.scheduled-task-editor']);
      await shot(page, testInfo, `task-create-light-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await modal.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(modal).not.toBeVisible();
    const created = await other.waitForMessage('yeaft_create_session');
    expect(created.requestId).toBeTruthy();
    expect(created.payload).toMatchObject({ name: 'Scheduled review with selected VP',
      workDir: '/tmp/test/review-workspace', roster: ['reviewer'], defaultVpId: 'reviewer',
      task: { prompt: prompt.trim(), enabled: true, notify: true, trigger: { type: 'schedule',
        scheduledFor: expect.any(Number), recurrence: { frequency: 'daily', timeZone: expect.any(String) } } } });
    expect(created.payload.task.trigger.scheduledFor).toBeGreaterThan(Date.now());
    expect(mockAgent.messages('yeaft_create_session')).toHaveLength(0);
    expect(other.messages('create_conversation')).toHaveLength(0);
    await expect(page.locator('.scheduled-task-bar')).toContainText('Next run');
    await showSidebar(page);
    await expect(taskRow(page, 'Scheduled review with selected VP')).toHaveCount(1);
    await expect(page.locator('.recents-section .session-item')).toHaveCount(1);
    await expect(page.locator('.recents-section')).not.toContainText('Scheduled review with selected VP');
    for (const section of ['projects', 'tasks', 'recents']) {
      const toggle = page.locator(`.${section}-section .sidebar-section-toggle`);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    await page.locator('.recents-section .session-item').click();
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
    expect(mockAgent.messages('yeaft_session_send')).toHaveLength(0);
    await shot(page, testInfo, 'task-session-conversation.png');
  } finally { await other.disconnect(); }
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
  await expect(page.locator('.tasks-section .session-item')).toHaveCount(0);
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
    const last = element.querySelector('.scheduled-task-options').getBoundingClientRect();
    return { scrollable: element.scrollHeight > element.clientHeight, scrolled: element.scrollTop > 0,
      bodyAboveFooter: body.bottom <= footer.top + 1, lastFieldAboveFooter: last.bottom <= footer.top + 1,
      footerVisible: footer.top >= 0 && footer.bottom <= innerHeight + 1,
      footerTop: footer.top, footerBottom: footer.bottom, viewportHeight: innerHeight };
  }, footerSelector);
  expect.soft(result).toMatchObject({ scrollable: true, scrolled: true, bodyAboveFooter: true, lastFieldAboveFooter: true, footerVisible: true });
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
