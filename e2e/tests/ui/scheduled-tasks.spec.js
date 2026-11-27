import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/scheduled-task-server.js';
import { MockAgent } from '../../fixtures/mock-agent.js';
import { scheduledTaskAgent, CHAT_SESSION_ID, TASK_SESSION_ID, taskSession } from '../../fixtures/scheduled-task-agent.js';

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
    .some(item => item.id === agentId && item.online && item.capabilities?.includes('scheduled_tasks')), agent.agentId)).toBe(true);
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

function sessionStatusToggle(page) {
  return page.locator('.yeaft-session-status-toggle');
}

async function showTaskStatus(page) {
  if (!await page.locator('.yeaft-session-status-pane').isVisible()) {
    await sessionStatusToggle(page).click();
  }
  await expect(page.locator('.yeaft-session-status-pane .scheduled-task-bar')).toBeVisible();
}

async function closeMobileTaskStatus(page) {
  if (!await page.evaluate(() => innerWidth <= 1024)) return;
  const pane = page.locator('.yeaft-session-status-pane');
  // CSS updates immediately on resize; wait for Vue's media-query projection
  // before deciding whether the panel still needs closing.
  await expect(pane).toHaveClass(/mobile-session-status/);
  if (await pane.isVisible()) {
    await page.locator('.yeaft-session-status-close').click();
    await expect(pane).toBeHidden();
  }
}

async function configureTask(page) {
  await showTaskStatus(page);
  await page.locator('.scheduled-task-bar').getByRole('button', { name: 'Configure', exact: true }).click();
}

function taskRow(page, name = 'Daily workspace review') {
  return page.locator('.sidebar-session-row').filter({ has: page.locator('.sidebar-session-title-text', { hasText: name }) });
}

async function openTask(page) {
  await showSidebar(page);
  await taskRow(page).click();
  await expect(sessionStatusToggle(page)).toBeVisible();
  await closeMobileTaskStatus(page);
  await expect(page.locator('.yeaft-session-input textarea')).toBeVisible();
}

async function shot(page, testInfo, name) {
  const directory = resolve('.yeaft/verification/task-header-controls');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('task editing preserves failed drafts for retry, then manually runs the same Session', async ({ page, serverUrl, mockAgent }, testInfo) => {
  const state = scheduledTaskAgent(mockAgent);
  const initialRevision = state.sessions.get(TASK_SESSION_ID).task.revision;
  await boot(page, serverUrl, mockAgent);
  await openTask(page);
  await expect(page.locator('.assistant-turn')).toContainText(`persistent conversation for ${TASK_SESSION_ID}`);
  await configureTask(page);
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
  await page.getByRole('button', { name: 'Run once', exact: true }).click();
  await expect.poll(() => state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'run').length).toBe(1);
  const runRequest = state.requests.find(request => request.type === 'yeaft_scheduled_task' && request.op === 'run');
  expect(runRequest).toMatchObject({ sessionId: TASK_SESSION_ID, requestId: expect.any(String) });
  expect(runRequest).not.toHaveProperty('task');
  await expect(page.locator('.scheduled-task-bar')).toContainText('Completed');
  await expect(page.locator('.yeaft-session-input textarea')).toBeVisible();
  await shot(page, testInfo, 'task-manual-run-completed.png');
  // Idle and enabled: the header stop pauses the schedule, not the Session.
  const active = state.sessions.get(TASK_SESSION_ID);
  active.task.trigger = { type: 'schedule', scheduledFor: Date.now() + 86400000,
    recurrence: { frequency: 'daily', timeZone: 'UTC', time: '12:00' } };
  active.task.nextRunAt = active.task.trigger.scheduledFor;
  active.task.revision = 'scheduled-task-pause-r1';
  state.publish();
  const savedTask = structuredClone(active.task);
  // The Pause control can already be enabled for the preceding revision.
  // Wait for this Agent-scoped update to reach the client before using it.
  await expect.poll(() => page.evaluate(({ sessionId, agentId }) =>
    window.Pinia.useSessionsStore().sessionById(sessionId, agentId)?.task?.revision,
  { sessionId: TASK_SESSION_ID, agentId: mockAgent.agentId })).toBe(savedTask.revision);
  const stop = page.locator('.scheduled-task-stop');
  await expect(stop).toBeEnabled();
  await expect(stop).toHaveAccessibleName('Pause schedule');
  state.holdUpdates = true;
  await stop.click();
  await expect.poll(() => state.heldUpdates.length).toBe(1);
  await expect(stop).toHaveAccessibleName('Pausing…');
  await expect(stop).toBeDisabled();
  await expect(page.locator('.scheduled-task-run')).toBeDisabled();
  await stop.evaluate(element => element.click());
  expect(state.heldUpdates).toHaveLength(1);
  expect(state.heldUpdates[0]).toMatchObject({ type: 'yeaft_scheduled_task', op: 'update',
    sessionId: TASK_SESSION_ID, expectedRevision: savedTask.revision, task: { enabled: false } });
  expect(state.heldUpdates[0].task).toEqual({ enabled: false });
  state.replyUpdate(state.heldUpdates.shift(), 'Cannot persist pause; retry.');
  await expect(page.locator('.scheduled-task-bar').getByRole('alert')).toHaveText('Cannot persist pause; retry.');
  await expect(stop).toBeEnabled();
  expect(state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(true);
  state.holdUpdates = false;
  await stop.click();
  await expect(stop).toHaveAccessibleName('Pause schedule');
  await expect(stop).toBeDisabled();
  await expect(page.locator('.scheduled-task-runtime')).toContainText('Paused');
  await expect(page.locator('.scheduled-task-run')).toBeEnabled();
  const paused = state.sessions.get(TASK_SESSION_ID).task;
  expect(paused.enabled).toBe(false);
  expect(paused.revision).not.toBe(savedTask.revision);
  for (const key of ['prompt', 'trigger', 'notify', 'lastRun']) expect(paused[key]).toEqual(savedTask[key]);
  expect(state.requests.filter(request => request.type === 'yeaft_abort_all')).toHaveLength(0);
  // Paused state is durable across reload; explicit Run once still never re-enables it.
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.Pinia?.useChatStore?.().scheduledTaskProtocolSupported)).toBe(true);
  await openTask(page);
  await showTaskStatus(page);
  await expect(stop).toBeDisabled();
  await expect(page.locator('.scheduled-task-runtime')).toContainText('Paused');
  const runsBefore = state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'run').length;
  await page.locator('.scheduled-task-run').click();
  await expect.poll(() => state.requests.filter(request => request.type === 'yeaft_scheduled_task' && request.op === 'run').length).toBe(runsBefore + 1);
  await expect(page.locator('.scheduled-task-runtime [role="status"]')).toHaveText('Completed');
  expect(state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(false);
  // Re-enable in settings, then pause during an active run without aborting it.
  await configureTask(page);
  await settings.locator('.scheduled-task-option-row').filter({ has: page.getByRole('switch', { name: 'Enabled', exact: true }) }).click();
  await settings.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect.poll(() => state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(true);
  await page.locator('.group-settings-close').click();
  const runningSession = state.sessions.get(TASK_SESSION_ID);
  runningSession.task.lastRun = { id: 'ongoing-run', status: 'running', trigger: 'schedule', startedAt: Date.now() };
  const runningTask = structuredClone(runningSession.task);
  state.publish();
  await expect(page.locator('.scheduled-task-run')).toBeDisabled();
  await expect(page.locator('.scheduled-task-runtime [role="status"]')).toHaveText('Running');
  await expect(stop).toBeEnabled();
  state.holdUpdates = true;
  await stop.click();
  await expect.poll(() => state.heldUpdates.length).toBe(1);
  // Status changes and closing/reopening the pane cannot unlock an in-flight pause.
  runningSession.task.lastRun = { ...runningSession.task.lastRun, startedAt: Date.now() };
  state.publish();
  await sessionStatusToggle(page).click();
  await showTaskStatus(page);
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAccessibleName('Pausing…');
  await stop.evaluate(element => element.click());
  expect(state.heldUpdates).toHaveLength(1);
  state.replyUpdate(state.heldUpdates.shift());
  await expect(stop).toHaveAccessibleName('Pause schedule');
  await expect(stop).toBeDisabled();
  await expect(page.locator('.scheduled-task-runtime [role="status"]')).toHaveText('Running');
  expect(state.sessions.get(TASK_SESSION_ID).task.lastRun.status).toBe('running');
  expect(state.sessions.get(TASK_SESSION_ID).task.enabled).toBe(false);
  for (const key of ['prompt', 'trigger', 'notify']) expect(state.sessions.get(TASK_SESSION_ID).task[key]).toEqual(runningTask[key]);
  expect(state.requests.filter(request => request.type === 'yeaft_abort_all')).toHaveLength(0);

});

test('Task reads synchronize across devices and background runs do not take focus on reload', async ({ browser, page, serverUrl, mockAgent }) => {
  const state = scheduledTaskAgent(mockAgent);
  await boot(page, serverUrl, mockAgent);
  await showSidebar(page);
  await page.locator('.sidebar-session-row').filter({ hasText: 'Ordinary conversation' }).click();
  for (const runId of ['device-old-1', 'device-old-2']) state.notify({ runId });
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().scheduledTaskNotifications.length)).toBe(2);
  state.sessions.get(TASK_SESSION_ID).task.lastRun = { id: 'snapshot-only', status: 'completed', finishedAt: Date.now() };
  state.publish();
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().scheduledTaskNotifications.length)).toBe(3);
  state.sessions.get(TASK_SESSION_ID).task.lastRun = { id: 'device-running', status: 'running', startedAt: Date.now() };
  state.publish();
  // No shared storage/cookies: new device only knows a running latest Run while
  // the first client still has both old notifications. Server expands the read.
  const device = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const second = await device.newPage();
  try {
    await boot(second, serverUrl, mockAgent);
    await second.setViewportSize({ width: 390, height: 844 });
    await second.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await openTask(second);
    await expect(second.locator('.scheduled-task-notification')).toHaveCount(0);
    await expect(page.locator('.scheduled-task-notification')).toHaveCount(0);
    await showSidebar(second);
    await second.locator('.sidebar-session-row').filter({ hasText: 'Ordinary conversation' }).click();
    // New Run must notify both clients. Reading it by clicking either notice
    // clears the other client immediately (not only on refresh).
    state.sessions.get(TASK_SESSION_ID).task.lastRun = { id: 'device-new', status: 'failed', finishedAt: Date.now() };
    state.publish();
    state.notify({ runId: 'device-new', status: 'failed' });
    for (const client of [page, second]) {
      await expect.poll(() => client.evaluate(() => window.Pinia.useChatStore().scheduledTaskNotifications.length)).toBe(1);
    }
    // Same-account HTTP JWT renewal leaves the existing socket valid.
    await second.evaluate(() => { window.Pinia.useAuthStore().token = 'same-account-renewed-token'; });
    await page.locator('.scheduled-task-notification-open').click();
    await expect(second.locator('.scheduled-task-notification')).toHaveCount(0);
    // A brand new browser storage must trust server receipts BEFORE hydration.
    await second.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('yeaft-task-')) localStorage.removeItem(key);
    });
    await second.evaluate(() => { window.Pinia.useAuthStore().token = null; });
    await second.reload();
    await expect(second.locator('.sidebar-navigation')).toHaveAttribute('aria-busy', 'false');
    await expect(second.locator('.yeaft-session-input textarea')).toBeVisible();
    await expect.poll(() => second.evaluate(() => window.Pinia.useChatStore().scheduledTaskReceiptProtocolSupported)).toBe(true);
    await expect(second.locator('.scheduled-task-notification')).toHaveCount(0);
    await showSidebar(page);
    await page.locator('.sidebar-session-row').filter({ hasText: 'Ordinary conversation' }).click();
    // Delayed repeats cannot resurrect old notices, but a later Run still can.
    for (const runId of ['device-old-1', 'device-old-2', 'snapshot-only', 'device-new', 'device-future']) state.notify({ runId });
    for (const client of [page, second]) {
      await expect.poll(() => client.evaluate(() => window.Pinia.useChatStore().scheduledTaskNotifications.map(item => item.runId))).toEqual(['device-future']);
    }
    await second.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await expect(page.locator('.scheduled-task-notification')).toHaveCount(0);
    state.notify({ runId: 'deleted-result' });
    for (const client of [page, second]) await expect(client.locator('.scheduled-task-notification-open')).toHaveCount(1);
    state.sessions.delete(TASK_SESSION_ID);
    state.publish();
    await expect(taskRow(page)).toHaveCount(0);
    await page.locator('.scheduled-task-notification-open').click();
    await expect(second.locator('.scheduled-task-notification')).toHaveCount(0);

    // With two Agents, the other Agent can report a running task before
    // inventory commits, or even use the same local id as the saved Session.
    const backgroundAgent = new MockAgent(serverUrl, 'background-task-agent');
    const route = () => second.evaluate(() => window.Pinia.useChatStore().activeSessionRoute);
    const remembered = () => second.evaluate(() => localStorage.getItem('lastViewedYeaftSession'));
    const ordinaryRoute = { runtimeProvider: 'yeaft', agentId: mockAgent.agentId, sessionId: CHAT_SESSION_ID };
    const savedKey = `${mockAgent.agentId}\u001f${CHAT_SESSION_ID}`;
    await backgroundAgent.connect();
    try {
      scheduledTaskAgent(backgroundAgent, {
        sessions: [taskSession({ id: CHAT_SESSION_ID, name: 'Daily Report', running: true })],
      });
      await expect.poll(remembered).toBe(savedKey);
      const topTitle = second.locator('.yeaft-topbar-session-title');
      const runningStatus = (type) => {
        const status = { sessionId: CHAT_SESSION_ID, vpId: 'omni', state: 'thinking' };
        return { type: 'yeaft_output', agentId: backgroundAgent.agentId,
          event: type === 'vp_status_changed' ? { type, ...status } : { type, statuses: [status] } };
      };
      let releaseInventory;
      let delayInventory = true;
      const delayedLiveLists = [];
      await second.routeWebSocket(/.*/, ws => {
        const server = ws.connectToServer();
        server.onMessage(raw => {
          const msg = JSON.parse(String(raw));
          if (!delayInventory) return ws.send(raw);
          if (msg.type === 'yeaft_output' && (msg.event?.type === 'session_list_updated'
              || (msg.event?.type === 'session_crud_result' && msg.event.op === 'list'))) {
            delayedLiveLists.push(() => ws.send(raw));
            return;
          }
          if (msg.type !== 'yeaft_session_hydrate_complete') return ws.send(raw);
          ws.send(JSON.stringify(runningStatus('vp_status_changed')));
          ws.send(JSON.stringify(runningStatus('vp_status_snapshot')));
          releaseInventory = () => ws.send(raw);
        });
      });
      await second.reload();
      await expect.poll(() => !!releaseInventory).toBe(true);
      // App state observes the status while the final inventory frame is still
      // held. It must not project the foreign task as the visible route.
      await expect.poll(() => second.evaluate(agentId => Object.values(window.Pinia.useChatStore().vpStatuses)
        .some(status => status.agentId === agentId && status.state === 'thinking'), backgroundAgent.agentId)).toBe(true);
      expect(await route()).toBeNull();
      expect(await remembered()).toBe(savedKey);
      delayInventory = false;
      releaseInventory();
      delayedLiveLists.forEach(deliver => deliver());
      await expect(topTitle).toHaveText('Ordinary conversation');
      await expect.poll(route).toEqual(ordinaryRoute);
      await expect(second.locator('.assistant-turn')).toContainText(`${mockAgent.agentName}: persistent conversation for ${CHAT_SESSION_ID}`);
      await expect.poll(remembered).toBe(savedKey);

      const composer = second.locator('.yeaft-session-input textarea');
      await mockAgent.disconnect();
      await expect.poll(() => second.evaluate(agentId => window.Pinia.useChatStore().agents
        .some(row => row.id === agentId && row.online), mockAgent.agentId)).toBe(false);
      await second.reload();
      await expect(second.getByText('Your last Session is temporarily unavailable.', { exact: false })).toBeVisible();
      await expect(composer).toHaveCount(0);
      expect(await route()).toBeNull();
      expect(await remembered()).toBe(savedKey);
      await mockAgent.reconnect();
      state.publish();
      await expect(topTitle).toHaveText('Ordinary conversation');
      await expect.poll(route).toEqual(ordinaryRoute);
      await expect(composer).toBeEditable();
      expect(state.requests.filter(request => request.type === 'yeaft_session_send')).toHaveLength(0);

      // Choosing another Session is deliberate and changes what reload restores.
      await showSidebar(second);
      await taskRow(second, 'Daily Report').click();
      await expect(topTitle).toHaveText('Daily Report');
      await expect.poll(remembered).toBe(`${backgroundAgent.agentId}\u001f${CHAT_SESSION_ID}`);
      await second.reload();
      await expect(topTitle).toHaveText('Daily Report');
      await expect.poll(route).toEqual({ ...ordinaryRoute, agentId: backgroundAgent.agentId });
    } finally { await backgroundAgent.disconnect(); }
  } finally { await device.close(); }
});
