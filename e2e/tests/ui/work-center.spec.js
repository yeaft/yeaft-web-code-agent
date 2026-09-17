import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { BUILT_IN_ACTION_TYPES } from '../../../agent/yeaft/work-center/workflow.js';

const WORK_CENTER_SETTINGS = {
  settings: {
    version: 1,
    revision: 7,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    maxConcurrentActions: 3,
    defaultWorkDir: '/tmp/test',
    globalInstructions: 'Follow the Agent release policy for every Action.',
    modelTags: { fast: 'provider/primary', balanced: 'provider/primary', ultimate: 'provider/review' },
    modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
    coordinatorModelPolicy: { mode: 'inherit', model: null, effort: 'high' },
    actionModelPolicies: Object.fromEntries(BUILT_IN_ACTION_TYPES.map(type => [type, {
      mode: 'inherit', model: null, effort: ['triage', 'research', 'design', 'diagnose', 'review'].includes(type) ? 'high' : 'medium',
    }])),
    actionInstructions: {
      triage: 'Plan the task', research: 'Research the problem', design: 'Design the solution',
      diagnose: 'Diagnose the root cause', implement: 'Implement the change', migrate: 'Migrate safely',
      test: 'Test the change', review: 'Review independently', integrate: 'Integrate the changes',
      document: 'Document the result',
      operate: 'Operate safely', deliver: 'Deliver the result', write: 'Write the content',
      create_vp: 'Create the requested VP',
      custom: 'Complete the custom Action',
    },
    workflows: [{
      version: 1,
      id: 'software-change',
      name: 'Software change',
      stages: [
        { id: 'triage', name: 'Triage', type: 'triage', instruction: '', assignmentPolicy: { mode: 'auto', capability: 'triage', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] }, modelPolicy: { mode: 'inherit', model: null, effort: null }, maxAttempts: 2 },
        { id: 'implement', name: 'Implement', type: 'implement', instruction: '', assignmentPolicy: { mode: 'auto', capability: 'implement', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] }, modelPolicy: { mode: 'inherit', model: null, effort: null }, maxAttempts: 2 },
        { id: 'review', name: 'Review', type: 'review', instruction: '', assignmentPolicy: { mode: 'auto', capability: 'review', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: ['implement'] }, modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' }, maxAttempts: 2, changesRequestedStageId: 'implement' },
      ],
    }],
  },
  runtime: {
    vps: [
      { id: 'omni', name: 'Omni', role: 'Requirement Lead', traits: ['triage'] },
      { id: 'linus', name: 'Linus', role: 'Systems Engineer', traits: ['implementation'] },
      { id: 'martin', name: 'Martin', role: 'Code Reviewer', traits: ['review'] },
    ],
    models: [
      { id: 'primary', ref: 'provider/primary', provider: 'provider', label: 'primary' },
      { id: 'review', ref: 'provider/review', provider: 'provider', label: 'review', effortOptions: ['medium', 'high'] },
    ],
    primaryModel: 'provider/primary',
    fastModel: null,
    workItemAttachments: true,
    workItemTypes: [{ id: 'software-change', name: 'Software change', actionCount: 3 }],
  },
};

const OPEN_ITEM = {
  id: 'work-item-open',
  title: 'Fix Work Center layout',
  goal: 'Keep the Work Center usable at every supported viewport width.',
  status: 'running',
  boardLane: 'active',
  updatedAt: Date.now(),
  currentAction: { id: 'action-1', type: 'implement', requiredRole: 'developer' },
  coordinatorRevision: 0,
};

const OPEN_ITEM_DETAIL = {
  ...OPEN_ITEM,
  revision: 1,
  currentActionId: 'action-1',
  workDir: '/tmp/project',
  workflowTemplate: 'software-change',
  acceptanceCriteria: ['The Action flow remains readable'],
  planRevision: 2,
  ledgerRevision: 4,
  coordinatorRevision: 0,
  messages: [],
  executionStats: {
    llmRequestCount: 4, loopCount: 3, toolCount: 8,
    inputTokens: 1200, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 50,
    totalTokens: 1750,
  },
  actionCount: 1,
  actionSummary: 'implement',
  actions: [{
    id: 'action-1', generation: 1, sequence: 1, type: 'implement', requiredRole: 'developer', status: 'running',
    assignedVp: { id: 'linus', name: 'Linus' },
    contentSummary: 'Updated the existing layout styles and verified supported breakpoints.',
    brief: {
      objective: 'Make the Work Center layout responsive',
      approach: 'Update the existing layout styles and verify supported breakpoints',
      expectedOutcome: 'The Work Center remains readable without horizontal overflow',
    },
    executionStats: {
      llmRequestCount: 4, loopCount: 3, toolCount: 8,
      inputTokens: 1200, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 50,
      totalTokens: 1750,
    },
    loopCount: 3, toolCount: 8, progressRevision: 4,
    response: 'Updated the existing layout styles and verified supported breakpoints.',
    messages: [{
      id: 'action-1:1', role: 'assistant', status: 'running',
      speaker: { id: 'linus', name: 'Linus' },
      text: 'Updated the existing layout styles and verified supported breakpoints.',
      createdAt: Date.now(), updatedAt: Date.now(),
    }],
  }],
};

function detailWithActions(count) {
  const actions = Array.from({ length: count }, (_, index) => ({
    ...OPEN_ITEM_DETAIL.actions[0],
    id: `action-${index + 1}`,
    sequence: index + 1,
    type: index % 2 ? 'review' : 'implement',
    status: index === count - 1 ? 'ready' : 'completed',
    response: `Action ${index + 1} response`,
    messages: [],
  }));
  return {
    ...OPEN_ITEM_DETAIL,
    actionCount: count,
    currentActionId: actions.at(-1).id,
    actions,
  };
}

const FAILED_ITEM = {
  ...OPEN_ITEM,
  status: 'needs_attention',
  boardLane: 'needs_attention',
  title: 'Local run',
};

const GENERATION_ITEM = {
  ...OPEN_ITEM,
  id: 'work-item-generation',
  title: 'Generation-bound draft',
  updatedAt: Number(OPEN_ITEM.updatedAt) + 10,
};

const GENERATION_ITEM_DETAIL = {
  ...OPEN_ITEM_DETAIL,
  ...GENERATION_ITEM,
  currentActionId: 'action-generation',
  currentAction: { ...OPEN_ITEM.currentAction, id: 'action-generation' },
  actions: [{ ...OPEN_ITEM_DETAIL.actions[0], id: 'action-generation', generation: 1 }],
};

const FAILED_ITEM_DETAIL = {
  ...OPEN_ITEM_DETAIL,
  ...FAILED_ITEM,
  status: 'needs_attention',
  messages: [],
  actions: [{
    ...OPEN_ITEM_DETAIL.actions[0],
    status: 'failed',
    failure: {
      error: 'The implementation produced an unsafe patch and validation could not load its configuration.',
      summary: 'All unverified changes were reverted; the Action still needs implementation.',
      failedAt: Date.now(),
    },
  }],
};

const WAITING_ITEM = {
  ...OPEN_ITEM,
  id: 'work-item-waiting',
  title: 'Choose the database',
  status: 'waiting',
  currentAction: { ...OPEN_ITEM.currentAction, generation: 1, status: 'waiting' },
};

const WAITING_ITEM_DETAIL = {
  ...OPEN_ITEM_DETAIL,
  ...WAITING_ITEM,
  currentActionId: 'action-1',
  messages: [{
    id: 'coordinator-human-request', role: 'assistant', status: 'completed',
    speaker: { id: 'omni', name: 'Omni' },
    text: 'Choose the database so the Work Item can continue.',
    decision: { kind: 'request_human', reason: 'The database target is missing.' },
    recovery: {
      actionId: 'action-1', actionGeneration: 1, stageId: 'implement', attempt: 1,
    },
    createdAt: Date.now(), updatedAt: Date.now(),
  }],
  actions: [{
    ...OPEN_ITEM_DETAIL.actions[0],
    status: 'waiting',
    canonicalResult: {
      waitingReason: 'Choose PostgreSQL or SQLite before the migration continues.',
    },
  }],
};

const ACTION_OVERFLOW_DETAIL = structuredClone(OPEN_ITEM_DETAIL);
ACTION_OVERFLOW_DETAIL.actions[0].status = 'waiting';
ACTION_OVERFLOW_DETAIL.actions[0].canonicalResult = { waitingReason: `waiting-${'w'.repeat(1200)}` };
ACTION_OVERFLOW_DETAIL.actions[0].messages = [
  {
    id: 'action-overflow-message',
    role: 'assistant',
    status: 'completed',
    speaker: { id: `speaker-${'s'.repeat(1200)}` },
    text: 'Action overflow probe',
    attachments: [{ id: 'action-overflow-attachment', name: `attachment-${'a'.repeat(1800)}.txt`, size: 12 }],
    createdAt: Date.now() - 1,
    updatedAt: Date.now() - 1,
  },
  {
    id: 'action-overflow-user',
    role: 'user',
    status: 'completed',
    text: 'Keep the correction small.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

function closedWorkItem(status) {
  const suffix = status === 'done' ? 'done' : 'cancelled';
  return {
    ...OPEN_ITEM,
    id: `work-item-${suffix}`,
    title: status === 'done' ? 'Released layout fix' : 'Cancelled layout experiment',
    status,
    boardLane: 'closed',
    revision: status === 'done' ? 4 : 3,
    currentAction: null,
    actionCount: 1,
    completedActionCount: status === 'done' ? 1 : 0,
  };
}

function closedWorkItemDetail(item) {
  const cancelled = item.status === 'cancelled';
  return {
    ...OPEN_ITEM_DETAIL,
    ...item,
    currentActionId: null,
    messages: [
      {
        id: `${item.id}:user`, role: 'user', status: 'completed',
        text: `Close ${item.title}`, createdAt: Date.now() - 2, updatedAt: Date.now() - 2,
      },
      {
        id: `${item.id}:assistant`, role: 'assistant', status: 'completed',
        text: cancelled ? 'Yeaft recorded the cancellation.' : 'Yeaft confirmed every acceptance criterion.',
        createdAt: Date.now() - 1, updatedAt: Date.now() - 1,
      },
    ],
    actionCount: 1,
    actionSummary: 'implement',
    actions: [{
      ...OPEN_ITEM_DETAIL.actions[0],
      id: `action-${item.status}`,
      status: cancelled ? 'cancelled' : 'completed',
      response: cancelled ? 'Execution stopped without publishing changes.' : 'Verified and released the layout fix.',
      messages: [{
        id: `action-${item.status}:message`, role: 'assistant', status: cancelled ? 'cancelled' : 'completed',
        text: cancelled ? 'Execution stopped without publishing changes.' : 'Verified and released the layout fix.',
        createdAt: Date.now(), updatedAt: Date.now(),
      }],
    }],
  };
}

const DONE_ITEM = closedWorkItem('done');
const CANCELLED_ITEM = closedWorkItem('cancelled');
const DONE_ITEM_DETAIL = closedWorkItemDetail(DONE_ITEM);
const CANCELLED_ITEM_DETAIL = closedWorkItemDetail(CANCELLED_ITEM);

const workCenterTransports = new WeakMap();

async function installWorkCenterTransport(chatPage) {
  if (workCenterTransports.has(chatPage)) return workCenterTransports.get(chatPage);
  await chatPage.evaluate(() => {
    const store = window.Pinia.useChatStore();
    if (store.__workCenterE2ETransportInstalled) return;
    store.__workCenterE2ETransportInstalled = true;
    store.__workCenterE2ERequests = [];
    store.__workCenterE2EWaiters = [];
    store.workCenterRequest = (op, payload = {}, agentId = null) => new Promise((resolve, reject) => {
      if (op === 'list' && payload.status) {
        resolve({ items: (store.__activityItems || []).filter(item => item.status === payload.status) });
        return;
      }
      const request = { op, payload, agentId: agentId || store.workCenterAgentId || store.currentAgent };
      const waiter = store.__workCenterE2EWaiters.shift();
      if (waiter) waiter(request);
      else store.__workCenterE2ERequests.push(request);
      request.resolve = resolve;
      request.reject = reject;
    });
  });
  const transport = {
    async takeNow() {
      return chatPage.evaluate(() => {
        const store = window.Pinia.useChatStore();
        const request = store.__workCenterE2ERequests.shift();
        if (!request) return null;
        const id = `${Date.now()}-${Math.random()}`;
        store.__workCenterE2EInflight ||= {};
        store.__workCenterE2EInflight[id] = request;
        return { id, op: request.op, payload: request.payload, agentId: request.agentId };
      });
    },
    async next() {
      return chatPage.evaluate(() => new Promise(resolve => {
        const store = window.Pinia.useChatStore();
        const request = store.__workCenterE2ERequests.shift();
        if (request) {
          const id = `${Date.now()}-${Math.random()}`;
          store.__workCenterE2EInflight ||= {};
          store.__workCenterE2EInflight[id] = request;
          resolve({ id, op: request.op, payload: request.payload, agentId: request.agentId });
          return;
        }
        store.__workCenterE2EWaiters.push(nextRequest => {
          const id = `${Date.now()}-${Math.random()}`;
          store.__workCenterE2EInflight ||= {};
          store.__workCenterE2EInflight[id] = nextRequest;
          resolve({ id, op: nextRequest.op, payload: nextRequest.payload, agentId: nextRequest.agentId });
        });
      }));
    },
    async resolve(request, data) {
      await chatPage.evaluate(({ id, data: response }) => {
        const store = window.Pinia.useChatStore();
        const pending = store.__workCenterE2EInflight?.[id];
        if (!pending) throw new Error(`Missing Work Center E2E request ${id}`);
        delete store.__workCenterE2EInflight[id];
        pending.resolve(response);
      }, { id: request.id, data });
    },
    async reject(request, message, code = undefined) {
      await chatPage.evaluate(({ id, message: errorMessage, code }) => {
        const store = window.Pinia.useChatStore();
        const pending = store.__workCenterE2EInflight?.[id];
        if (!pending) throw new Error(`Missing Work Center E2E request ${id}`);
        delete store.__workCenterE2EInflight[id];
        pending.reject(Object.assign(new Error(errorMessage), { code }));
      }, { id: request.id, message, code });
    },
  };
  workCenterTransports.set(chatPage, transport);
  return transport;
}

async function respondToWorkCenterRequest(mockAgent, data) {
  if (mockAgent?.__workCenterTransport) {
    const request = await mockAgent.__workCenterTransport.next();
    await mockAgent.__workCenterTransport.resolve(request, data);
    return request;
  }
  const request = await mockAgent.waitForMessage('work_center_request');
  mockAgent.send({
    type: 'work_center_response',
    requestId: request.requestId,
    op: request.op,
    ok: true,
    data,
  });
  return request;
}

async function respondToWorkCenterOp(mockAgent, op, data, listItems = [OPEN_ITEM]) {
  if (mockAgent?.__workCenterTransport) {
    for (;;) {
      const request = await mockAgent.__workCenterTransport.next();
      if (request.op === op) {
        await mockAgent.__workCenterTransport.resolve(request, data);
        return request;
      }
      const fallbackData = request.op === 'list' ? { items: listItems, watcher: { enabled: true } }
        : request.op === 'get_settings' ? WORK_CENTER_SETTINGS
        : request.op === 'get_runtime' ? WORK_CENTER_SETTINGS.runtime
        : request.op === 'get' ? data : null;
      if (!fallbackData) throw new Error(`Expected Work Center ${op}, received ${request.op}`);
      await mockAgent.__workCenterTransport.resolve(request, fallbackData);
    }
  }
  for (;;) {
    const request = await mockAgent.waitForMessage('work_center_request');
    if (request.op === op) {
      mockAgent.send({
        type: 'work_center_response', requestId: request.requestId, op, ok: true, data,
      });
      return request;
    }
    const fallbackData = request.op === 'list'
      ? { items: listItems, watcher: { enabled: true } }
      : request.op === 'get'
        ? data
        : null;
    if (!fallbackData) throw new Error(`Expected Work Center ${op}, received ${request.op}`);
    mockAgent.send({
      type: 'work_center_response',
      requestId: request.requestId,
      op: request.op,
      ok: true,
      data: fallbackData,
    });
  }
}

async function respondByOperation(mockAgent, responses) {
  if (mockAgent?.__workCenterTransport) {
    const request = await mockAgent.__workCenterTransport.next();
    const data = typeof responses[request.op] === 'function' ? responses[request.op](request) : responses[request.op];
    if (data === undefined) throw new Error(`No E2E response configured for Work Center op ${request.op}`);
    await mockAgent.__workCenterTransport.resolve(request, data);
    return request;
  }
  const request = await mockAgent.waitForMessage('work_center_request');
  const data = typeof responses[request.op] === 'function'
    ? responses[request.op](request)
    : responses[request.op];
  if (data === undefined) throw new Error(`No E2E response configured for Work Center op ${request.op}`);
  mockAgent.send({
    type: 'work_center_response', requestId: request.requestId, op: request.op, ok: true, data,
  });
  return request;
}

async function respondUntilOperation(mockAgent, targetOp, responses, limit = 8) {
  for (let index = 0; index < limit; index++) {
    const request = await respondByOperation(mockAgent, responses);
    if (request.op === targetOp) return request;
  }
  throw new Error(`Work Center op ${targetOp} did not arrive within ${limit} requests`);
}

function expectedActionPolicyCount() {
  return BUILT_IN_ACTION_TYPES.length + 1;
}

function expectedModelPolicyCount() {
  // Action policies plus concurrency, three model tags, Coordinator, and all-Actions fallback.
  return BUILT_IN_ACTION_TYPES.length + 6;
}

function workCenterRequestOps(mockAgent) {
  return mockAgent.messages('work_center_request').map(request => request.op);
}

async function openWorkCenter(chatPage, mockAgent, items = [OPEN_ITEM]) {
  const transport = await installWorkCenterTransport(chatPage);
  mockAgent.__workCenterTransport = transport;
  for (;;) {
    const pending = await transport.takeNow();
    if (!pending) break;
    const response = pending.op === 'get_settings' ? WORK_CENTER_SETTINGS
      : pending.op === 'get_runtime' ? WORK_CENTER_SETTINGS.runtime
      : pending.op === 'list' ? { items, watcher: { enabled: true } }
      : null;
    if (response == null) throw new Error(`Unexpected Work Center startup op ${pending.op}`);
    await transport.resolve(pending, response);
  }
  await chatPage.evaluate(({ agentId, items: boardItems, settings, runtime }) => {
    const store = window.Pinia.useChatStore();
    store.hydrateWorkCenterBrowserState();
    store.__activityItems = boardItems;
    store.workCenterAgentId = agentId;
    store.workCenterOpen = true;
    store.workCenterItemsByAgent[agentId] = boardItems;
    store.workCenterLoadedByAgent[agentId] = true;
    store.workCenterLoadingByAgent[agentId] = false;
    store.workCenterSettingsByAgent[agentId] = settings;
    store.workCenterRuntimeByAgent[agentId] = runtime;
  }, {
    agentId: mockAgent.agentId,
    items,
    settings: WORK_CENTER_SETTINGS.settings,
    runtime: WORK_CENTER_SETTINGS.runtime,
  });
  await expect(chatPage.locator('.work-center-main')).toBeVisible();
  await expect(chatPage.locator('.work-center-card')).toHaveCount(items.length);
}

async function ensureActionsOpen(page) {
  const button = page.locator('.work-center-actions-button');
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}

async function returnToSession(page) {
  const button = page.getByRole('button', { name: 'Return to Session', exact: true });
  if (!await button.isVisible()) await page.locator('.work-center-navigation-toggle:visible').click();
  await button.click();
}

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect() || null;
    const main = document.querySelector('.work-center-main');
    const body = document.querySelector('.work-center-body');
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      sidebar: rect('.session-sidebar-shell'),
      main: rect('.work-center-main'),
      list: rect('.work-center-list'),
      detail: rect('.work-center-detail'),
      actionDetail: rect('.work-center-action-detail-pane'),
      mainClientWidth: main?.clientWidth || 0,
      mainScrollWidth: main?.scrollWidth || 0,
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollWidth: body?.scrollWidth || 0,
    };
  });
}

async function resizeViewportForMainWidth(page, targetWidth) {
  const main = page.locator('.work-center-main');
  // Resize the full-screen workspace through the real viewport.
  for (let attempt = 0; attempt < 4; attempt++) {
    const currentWidth = await main.evaluate(element => element.getBoundingClientRect().width);
    const viewport = page.viewportSize();
    await page.setViewportSize({
      ...viewport,
      width: Math.round(viewport.width + targetWidth - currentWidth),
    });
    await main.evaluate(async () => {
      await Promise.all(document.getAnimations()
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const actualWidth = await main.evaluate(element => element.getBoundingClientRect().width);
    if (Math.abs(actualWidth - targetWidth) <= 0.25) return actualWidth;
  }
  await expect.poll(() => main.evaluate(element => element.getBoundingClientRect().width))
    .toBeCloseTo(targetWidth, 1);
}

async function chooseWorkCenterTarget(page, target, label) {
  await target.locator('.modern-select-trigger').click();
  const menu = page.locator('.work-center-composer-target-menu');
  await expect(menu).toBeVisible();
  await menu.locator('.modern-select-option', { hasText: label }).click();
}

async function expectWorkCenterTarget(target, value, label) {
  await expect(target).toHaveAttribute('data-value', value);
  await expect(target.locator('.modern-select-label')).toHaveText(label);
}

async function tabTo(page, selector, limit = 120) {
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(target => document.activeElement?.matches?.(target) === true, selector)) {
      return page.locator(selector);
    }
  }
  throw new Error(`Tab focus did not reach ${selector}`);
}

async function focusIndicator(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
      boxShadow: style.boxShadow,
    };
  });
}

async function expectVisibleFocus(locator) {
  const indicator = await focusIndicator(locator);
  const hasOutline = indicator.outlineStyle !== 'none' && indicator.outlineWidth >= 2;
  const hasShadow = indicator.boxShadow !== 'none';
  expect(hasOutline || hasShadow).toBe(true);
}

async function expectNoHorizontalOverflow(root, selectors) {
  const metrics = await root.evaluate((element, targetSelectors) => Object.fromEntries(
    Object.entries(targetSelectors).map(([name, selector]) => {
      const target = selector === ':scope' ? element : element.querySelector(selector);
      return [name, target ? { clientWidth: target.clientWidth, scrollWidth: target.scrollWidth } : null];
    }),
  ), selectors);
  for (const [name, metric] of Object.entries(metrics)) {
    expect(metric, `${name} overflow probe must exist`).not.toBeNull();
    expect(metric.scrollWidth, `${name} must not overflow horizontally`)
      .toBeLessThanOrEqual(metric.clientWidth + 1);
  }
  return metrics;
}

test.describe('Work Center responsive UI', () => {
  test('activity is collapsible, chronological and excludes retired actions in both themes and narrow screens', async ({ chatPage, mockAgent }, testInfo) => {
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const statuses = ['running', 'waiting', 'ready', 'failed', 'closed', 'completed', 'superseded', 'cancelled'];
    const actionStats = statuses.map((status, index) => ({
      id: `activity-${status}`, status, sequence: index + 1,
      contentSummary: `${status} · A deliberately long Action description for wrapping checks`,
      assignedVp: { id: 'omni', name: 'Software Engineer' },
      createdAt: Date.UTC(2026, 8, 16, 9, index), updatedAt: Date.UTC(2026, 8, 16, 10, 59 - index),
    }));
    await openWorkCenter(chatPage, mockAgent, [{ ...OPEN_ITEM, actionStats }, DONE_ITEM]);
    const sidebar = chatPage.locator('.work-center-sidebar');
    const children = sidebar.locator('.work-center-activity-actions');
    await expect(children.locator('button')).toHaveCount(3);
    expect(await children.locator('.work-center-status').evaluateAll(rows => rows.map(row => row.dataset.status)))
      .toEqual(['ready', 'waiting', 'running']);
    await expect(children.locator('time')).toHaveCount(3);
    await expect(children.locator('time').first()).toHaveAttribute('datetime', '2026-09-16T09:02:00.000Z');
    const itemToggle = sidebar.locator('.work-center-item-disclosure');
    await itemToggle.press('Enter');
    await expect(itemToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(children).toBeHidden();
    await itemToggle.press('Space');
    await expect(children).toBeVisible();
    const allToggle = sidebar.getByRole('button', { name: 'In progress', exact: true });
    await allToggle.click();
    await expect(children).toBeHidden();
    await allToggle.click();
    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await chatPage.screenshot({ path: testInfo.outputPath(`activity-${theme}.png`) });
      const metrics = await children.locator('button').evaluateAll(rows => rows.map(row => [row.scrollWidth, row.clientWidth]));
      for (const [scroll, width] of metrics) expect(scroll).toBeLessThanOrEqual(width + 1);
    }
    await chatPage.setViewportSize({ width: 320, height: 720 });
    await chatPage.locator('.work-center-navigation-toggle:visible').click();
    await expect(children).toBeVisible();
    await expect.poll(() => chatPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await itemToggle.click();
    await expect(children).toBeHidden();
    await itemToggle.click();
    await chatPage.screenshot({ path: testInfo.outputPath('activity-mobile.png') });
    // A terminal item update clears the entire live subtree, not just its badge.
    await chatPage.evaluate(({ agentId, actionStats, item }) => {
      window.Pinia.useChatStore().applyWorkCenterEvent(agentId, {
        type: 'work_item.updated', workItem: { ...item, actionStats, status: 'done', revision: 10 },
      });
    }, { agentId: mockAgent.agentId, actionStats, item: OPEN_ITEM });
    await expect(sidebar.locator('.work-center-activity-item')).toHaveCount(0);
  });

  test('sidebar owns Agent navigation and live activity without taking over Item detail', async ({ chatPage, mockAgent }, testInfo) => {
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const activityItem = { ...OPEN_ITEM, actionStats: OPEN_ITEM_DETAIL.actions };
    await openWorkCenter(chatPage, mockAgent, [activityItem, DONE_ITEM]);
    const sidebar = chatPage.locator('.work-center-sidebar');
    await expect(sidebar.locator('.work-center-agent-row.active')).toHaveCount(1);
    await expect(sidebar.locator('.work-center-activity-item')).toHaveCount(1);
    await expect(sidebar.locator('.work-center-activity-actions')).toContainText('Linus');
    const agent = await sidebar.locator('.work-center-agent-row').boundingBox();
    const item = await sidebar.locator('.work-center-activity-item-row').boundingBox();
    expect(agent.x).toBe(item.x);
    expect(agent.width).toBe(item.width);
    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await chatPage.screenshot({ path: testInfo.outputPath(`sidebar-board-${theme}.png`) });
    }

    const select = sidebar.locator('.work-center-activity-actions button').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL, [activityItem, DONE_ITEM]);
    await select;
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    await expect(sidebar.locator('.work-center-activity-actions button')).toHaveAttribute('aria-current', 'page');
    await chatPage.locator('.work-center-item-message-input textarea').fill('Keep my Item draft');
    await chatPage.evaluate(({ agentId, summary }) => {
      window.Pinia.useChatStore().applyWorkCenterEvent(agentId, {
        type: 'work_item.updated', workItem: { ...summary, status: 'done', revision: 10 },
      });
    }, { agentId: mockAgent.agentId, summary: activityItem });
    await expect(sidebar.locator('.work-center-activity-item')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();

    await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
    const aligned = await chatPage.evaluate(() => {
      const breadcrumb = document.querySelector('.work-center-detail-breadcrumb').getBoundingClientRect();
      const overview = document.querySelector('.work-center-info-tabs').getBoundingClientRect();
      return { breadcrumb: breadcrumb.x, overview: overview.x };
    });
    expect(aligned.breadcrumb).toBeCloseTo(aligned.overview, 0);
    const agentId = mockAgent.agentId;
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      store.agents.push({ ...store.agents.find(agent => agent.id === agentId), id: 'sidebar-agent-b', name: 'Second Agent' });
      store.__activityItems = [];
    }, agentId);
    const switchAgent = sidebar.getByRole('button', { name: 'Second Agent Online', exact: true }).click();
    const request = await respondToWorkCenterOp(mockAgent, 'list', { items: [] });
    await switchAgent;
    expect(request.agentId).toBe('sidebar-agent-b');
    await expect(chatPage.locator('.work-center-action-detail-pane')).toHaveCount(0);
    await expect(sidebar.locator('.work-center-agent-row.active')).toContainText('Second Agent');
    await expect(sidebar.locator('.work-center-activity-item')).toHaveCount(0);

    await chatPage.setViewportSize({ width: 320, height: 720 });
    const toggle = chatPage.locator('.work-center-navigation-toggle:visible');
    await toggle.click();
    await expect(chatPage.locator('.work-center-shell')).toHaveAttribute('inert', '');
    const back = sidebar.getByRole('button', { name: 'Return to Session', exact: true });
    await expect(back).toBeFocused();
    await back.press('Shift+Tab');
    await expect(sidebar.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
    await chatPage.keyboard.press('Tab');
    await expect(back).toBeFocused();
    await chatPage.screenshot({ path: testInfo.outputPath('sidebar-mobile.png') });
    await chatPage.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(chatPage.locator('.work-center-shell')).not.toHaveAttribute('inert');
    await expect.poll(() => chatPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await returnToSession(chatPage);
    await expect(chatPage.locator('.work-center-main')).toHaveCount(0);
  });

  test('uses one flat header, aligned breadcrumbs and full-height Actions in both themes', async ({ chatPage, mockAgent }, testInfo) => {
    await openWorkCenter(chatPage, mockAgent);
    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await chatPage.setViewportSize({ width: 1600, height: 900 });
      const header = chatPage.locator('.work-center-header');
      await expect(header.locator('h1')).toHaveCount(0);
      const headerBox = await header.boundingBox();
      const searchBox = await chatPage.locator('.work-center-desktop-search').boundingBox();
      await expect(header.locator('.work-center-close-button')).toHaveCount(0);
      const closeBox = await chatPage.locator('.work-center-return').boundingBox();
      expect(searchBox.y).toBeGreaterThanOrEqual(headerBox.y);
      expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
      expect(searchBox.x).toBeGreaterThan(800);
      expect(closeBox.x + closeBox.width).toBeLessThan(headerBox.x);
      expect(await chatPage.locator('.work-center-body').evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('0px');
      const lanes = await chatPage.locator('.work-center-board-lane').all();
      for (const [index, lane] of lanes.entries()) {
        const laneStyle = await lane.evaluate(el => {
          const style = getComputedStyle(el);
          return { background: style.backgroundColor, borderLeftWidth: style.borderLeftWidth };
        });
        expect(laneStyle.background).toBe('rgba(0, 0, 0, 0)');
        expect(laneStyle.borderLeftWidth).toBe(index === 0 ? '0px' : '1px');
      }
      await chatPage.screenshot({ path: testInfo.outputPath(`flat-board-${theme}.png`) });
      const filters = chatPage.getByRole('button', { name: 'Search and filters', exact: true });
      await filters.click();
      await expect(chatPage.getByLabel('Filter by update time')).toHaveValue('week');
      await chatPage.getByLabel('Filter by update time').press('Escape');
      await expect(filters).toBeFocused();
      await expect(filters).toHaveAttribute('aria-expanded', 'false');

      const select = chatPage.locator('.work-center-card').click();
      await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
      await select;
      const breadcrumb = chatPage.locator('.work-center-detail-breadcrumb');
      await expect(breadcrumb).toContainText('Work items');
      await expect(breadcrumb).toContainText(OPEN_ITEM.title);
      const crumbBox = await breadcrumb.boundingBox();
      expect(crumbBox.y).toBeGreaterThanOrEqual(headerBox.y);
      expect(crumbBox.y + crumbBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
      const actionsButton = header.locator('.work-center-actions-button');
      await expect(actionsButton).toBeVisible();
      await expect(actionsButton).toHaveAccessibleName('View Actions');
      await expect(actionsButton).toHaveText('');
      await expect(chatPage.locator('.work-center-detail header')).toHaveCount(0);
      await chatPage.locator('.work-center-item-message-input textarea').fill('Preserve this draft');
      await ensureActionsOpen(chatPage);
      const itemBox = await chatPage.locator('.work-center-conversation-pane').boundingBox();
      const actionsBox = await chatPage.locator('.work-center-content-pane').boundingBox();
      expect(actionsBox.y).toBe(itemBox.y);
      expect(actionsBox.height).toBe(itemBox.height);
      await chatPage.locator('.work-center-action-summary').click();
      const actionHeader = await chatPage.locator('.work-center-header-content').boundingBox();
      expect(actionHeader.y).toBe(headerBox.y);
      expect(actionHeader.height).toBe(headerBox.height);
      expect(actionsBox.y).toBe(headerBox.y + headerBox.height);
      await expect(header.getByRole('button', { name: 'Back to Actions' })).toBeFocused();
      await chatPage.screenshot({ path: testInfo.outputPath(`flat-item-action-${theme}.png`) });
      await chatPage.setViewportSize({ width: 320, height: 720 });
      await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
      await expect(chatPage.locator('.work-center-conversation-pane')).toBeHidden();
      await chatPage.screenshot({ path: testInfo.outputPath(`flat-action-mobile-${theme}.png`) });
      await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
      await expect(chatPage.locator('.work-center-item-message-input textarea')).toHaveValue('Preserve this draft');
      await expect(breadcrumb).toContainText('Work items');
      await chatPage.screenshot({ path: testInfo.outputPath(`flat-item-mobile-${theme}.png`) });
      await chatPage.getByRole('button', { name: 'Work items', exact: true }).click();
      await filters.click();
      await expect(chatPage.locator('.work-center-mobile-search input')).toBeVisible();
      const popover = await chatPage.locator('#work-center-filters').boundingBox();
      expect(popover.x).toBeGreaterThanOrEqual(0);
      expect(popover.x + popover.width).toBeLessThanOrEqual(320);
      await chatPage.locator('.work-center-mobile-search input').press('Escape');
      await chatPage.getByRole('button', { name: 'More actions', exact: true }).click();
      await expect(chatPage.getByRole('button', { name: 'New work item', exact: true })).toBeVisible();
      await chatPage.getByRole('button', { name: 'New work item', exact: true }).press('Escape');
      await expect(chatPage.getByRole('button', { name: 'More actions', exact: true })).toBeFocused();
      await expect.poll(() => chatPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });

  test('shows creation time and execution runtime on Action rows without a header badge', async ({ chatPage, mockAgent }, testInfo) => {
    const now = Date.now();
    const detail = detailWithActions(3);
    detail.actions = detail.actions.map((action, index) => ({
      ...action, status: index === 2 ? 'running' : index === 1 ? 'ready' : 'completed',
      createdAt: now - (3 - index) * 60_000,
      executionDurationMs: index === 1 ? null : 65_000,
      executionStartedAt: index === 2 ? now : null,
    }));
    await chatPage.clock.setFixedTime(now);
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;
    await ensureActionsOpen(chatPage);
    const headerButton = chatPage.locator('.work-center-actions-button');
    await expect(headerButton).toHaveText('');
    await expect(headerButton).toHaveAccessibleName('View Actions');
    await expect(chatPage.locator('.work-center-content-title')).toContainText('3');
    const timing = status => chatPage.locator(`.work-center-action-card[data-status="${status}"] .work-center-action-timing`);
    const timingValues = status => timing(status).locator(':scope > span > span:last-child');
    const created = await chatPage.evaluate(value => new Date(value).toLocaleString(), detail.actions[0].createdAt);
    await expect(timingValues('completed')).toHaveText([created, '1m5s']);
    await expect(timingValues('ready').last()).toHaveText('—');
    await expect(timingValues('running').last()).toHaveText('1m5s');
    await chatPage.clock.setFixedTime(now + 5000);
    await expect(timingValues('running').last()).toHaveText('1m10s');
    await expect(timingValues('completed').last()).toHaveText('1m5s');
    for (const locale of ['en', 'zh-CN']) {
      await chatPage.evaluate(value => window.Pinia.useChatStore().changeLocale(value), locale);
      const labels = locale === 'en' ? ['Created', 'Runtime'] : ['创建于', '执行用时'];
      for (const theme of ['light', 'dark']) {
        await chatPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
        for (const width of [1600, 320]) {
          await chatPage.setViewportSize({ width, height: 900 });
          await ensureActionsOpen(chatPage);
          for (const status of ['completed', 'ready', 'running']) {
            const row = timing(status);
            await expect(row).toBeVisible();
            const values = await timingValues(status).allTextContents();
            expect(values.join(' ')).not.toMatch(/Created|Runtime|创建|用时/);
            const accessibleTiming = `${labels[0]} ${values[0]} ${labels[1]} ${values[1]}`;
            const summary = chatPage.locator(`.work-center-action-card[data-status="${status}"] .work-center-action-summary`);
            await expect(summary).toHaveAccessibleName(new RegExp(accessibleTiming.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            for (const label of await row.locator('.work-center-action-timing-label').all()) {
              await expect(label).toHaveCSS('position', 'absolute');
              await expect(label).toHaveCSS('clip-path', 'inset(50%)');
              await expect(label).toHaveCSS('width', '1px');
              await expect(label).toHaveCSS('height', '1px');
            }
            const bounds = await row.boundingBox();
            const left = await row.locator(':scope > span').first().boundingBox();
            const right = await row.locator(':scope > span').last().boundingBox();
            expect(Math.abs(left.x - bounds.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(right.x + right.width - bounds.x - bounds.width)).toBeLessThanOrEqual(1);
            expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
            expect(left.x + left.width).toBeLessThanOrEqual(right.x);
            expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          }
          await expect.poll(() => chatPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await chatPage.screenshot({ path: testInfo.outputPath(`action-timing-${locale}-${theme}-${width}.png`) });
        }
      }
    }
    mockAgent.send({ type: 'work_center_event', event: {
      type: 'run.progress', workItem: {
        ...OPEN_ITEM, revision: 1, currentActionId: 'action-3',
        actionStats: [{ id: 'action-3', generation: 1, status: 'completed', progressRevision: 5,
          executionDurationMs: 70_000, executionStartedAt: null }],
      },
    } });
    const last = chatPage.locator('.work-center-action-card').filter({ hasText: '1m10s' });
    await expect(last).toHaveAttribute('data-status', 'completed');
    await chatPage.clock.setFixedTime(now + 65_000);
    await expect(last.locator('.work-center-action-timing span').last()).toHaveText('1m10s');
  });

  test('forwards canonical Work Item messages through the real browser-server-Agent wire', async ({ chatPage, mockAgent }) => {
    mockAgent.__workCenterTransport = null;
    const requestPromise = mockAgent.waitForMessage('work_center_request');
    const responsePromise = chatPage.evaluate(async ({ agentId, item }) => {
      const store = window.Pinia.useChatStore();
      store.workCenterAgentId = agentId;
      store.workCenterDetailByAgent[agentId] = item;
      return store.postWorkItemMessage(
        item.id,
        'Real canonical message',
        { kind: 'action', actionId: 'action-1', generation: 1 },
        item.revision,
        [],
        agentId,
        { planRevision: item.planRevision, ledgerRevision: item.ledgerRevision, coordinatorRevision: 0 },
        { id: 'assistant-1', role: 'assistant', author: 'Omni', content: 'Original answer' },
      );
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL });
    const request = await requestPromise;
    expect(request).toMatchObject({
      op: 'post_work_item_message',
      payload: {
        id: OPEN_ITEM.id,
        text: 'Real canonical message',
        target: { kind: 'action', actionId: 'action-1', generation: 1 },
        revision: 1,
        planRevision: 2,
        ledgerRevision: 4,
        coordinatorRevision: 0,
        quote: { id: 'assistant-1', role: 'assistant', author: 'Omni', content: 'Original answer' },
      },
    });
    expect(request.payload.clientMessageId).toEqual(expect.any(String));
    mockAgent.send({
      type: 'work_center_response', requestId: request.requestId,
      op: request.op, ok: true, data: OPEN_ITEM_DETAIL,
    });
    const listRequest = await mockAgent.waitForMessage('work_center_request');
    expect(listRequest.op).toBe('list');
    mockAgent.send({
      type: 'work_center_response', requestId: listRequest.requestId,
      op: listRequest.op, ok: true, data: { items: [OPEN_ITEM], watcher: { enabled: true } },
    });
    await expect(responsePromise).resolves.toMatchObject({ id: OPEN_ITEM.id });
    await expect.poll(() => chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      return Object.keys(store.workCenterMessageOutbox || {}).length;
    })).toBe(0);

    const firstUpload = await chatPage.evaluate(async () => {
      const formData = new FormData();
      formData.append('files', new File(['initial staged bytes'], 'initial-note.txt', { type: 'text/plain' }));
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      return (await response.json()).files[0];
    });
    const lostResponseRequest = mockAgent.waitForMessage('work_center_request');
    chatPage.evaluate(({ agentId, item, attachment }) => {
      const store = window.Pinia.useChatStore();
      store.workCenterAgentId = agentId;
      store.workCenterDetailByAgent[agentId] = item;
      store.postWorkItemMessage(
        item.id,
        'Retry this durable message after reload',
        { kind: 'action', actionId: 'action-1', generation: 1 },
        item.revision,
        [attachment],
        agentId,
        { planRevision: item.planRevision, ledgerRevision: item.ledgerRevision, coordinatorRevision: 0 },
      ).catch(() => {});
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL, attachment: firstUpload });
    const firstAttempt = await lostResponseRequest;
    const durableClientMessageId = firstAttempt.payload.clientMessageId;
    expect(durableClientMessageId).toEqual(expect.any(String));
    expect(firstAttempt.payload.attachments[0].fileId).toBe(firstUpload.fileId);
    await expect.poll(() => chatPage.evaluate(id => {
      const store = window.Pinia.useChatStore();
      return Object.values(store.workCenterMessageOutbox || {})
        .some(envelope => envelope.clientMessageId === id);
    }, durableClientMessageId)).toBe(true);

    await chatPage.reload();
    await chatPage.waitForSelector('.chat-page');
    await chatPage.waitForFunction(agentId => {
      const store = window.Pinia?.useChatStore?.();
      return (store?.agents || []).some(agent => agent.id === agentId && agent.online === true);
    }, mockAgent.agentId);
    const messagesBeforeExpiredRetry = mockAgent.messages('work_center_request').length;
    const expiredRetry = chatPage.evaluate(({ agentId, item }) => {
      const store = window.Pinia.useChatStore();
      store.hydrateWorkCenterBrowserState();
      store.workCenterAgentId = agentId;
      store.workCenterDetailByAgent[agentId] = item;
      const envelope = store.loadWorkCenterMessageEnvelope(agentId, item.id);
      store.replaceWorkCenterMessageEnvelopeAttachments(agentId, item.id, [{
        ...envelope.attachments[0], fileId: 'expired-file-id',
      }]);
      return store.postWorkItemMessage(
        item.id, envelope.text, envelope.target, envelope.revision,
        envelope.attachments, agentId,
        {
          planRevision: envelope.planRevision,
          ledgerRevision: envelope.ledgerRevision,
          coordinatorRevision: envelope.coordinatorRevision,
        },
      );
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL });
    await expect(expiredRetry).rejects.toThrow(/attachment expired/i);
    expect(mockAgent.messages('work_center_request')).toHaveLength(messagesBeforeExpiredRetry);

    const replacement = await chatPage.evaluate(async () => {
      const formData = new FormData();
      formData.append('files', new File(['replacement staged bytes'], 'replacement-note.txt', { type: 'text/plain' }));
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      return (await response.json()).files[0];
    });
    const retryRequestPromise = mockAgent.waitForMessage('work_center_request');
    const retryResponse = chatPage.evaluate(({ agentId, item, attachment }) => {
      const store = window.Pinia.useChatStore();
      const envelope = store.replaceWorkCenterMessageEnvelopeAttachments(
        agentId, item.id, [attachment],
      );
      return store.postWorkItemMessage(
        item.id, envelope.text, envelope.target, envelope.revision,
        envelope.attachments, agentId,
        {
          planRevision: envelope.planRevision,
          ledgerRevision: envelope.ledgerRevision,
          coordinatorRevision: envelope.coordinatorRevision,
        },
      );
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM_DETAIL, attachment: replacement });
    const retryRequest = await retryRequestPromise;
    expect(retryRequest.payload).toMatchObject({
      clientMessageId: durableClientMessageId,
      text: 'Retry this durable message after reload',
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
    });
    expect(retryRequest.payload.attachments[0].fileId).toBe(replacement.fileId);
    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'action.input_added',
        actionId: 'action-1',
        clientMessageId: durableClientMessageId,
        workItem: { ...OPEN_ITEM, revision: 2, updatedAt: Number(OPEN_ITEM.updatedAt) + 1 },
      },
    });
    const retryListRequest = await mockAgent.waitForMessage('work_center_request');
    expect(retryListRequest.op).toBe('list');
    mockAgent.send({
      type: 'work_center_response', requestId: retryListRequest.requestId,
      op: retryListRequest.op, ok: true,
      data: { items: [{ ...OPEN_ITEM, revision: 2 }], watcher: { enabled: true } },
    });
    await expect(retryResponse).resolves.toMatchObject({ id: OPEN_ITEM.id });
    await expect.poll(() => chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      return Object.keys(store.workCenterMessageOutbox || {}).length;
    })).toBe(0);
  });

  test('keeps full-screen content inside tablet and compact desktop viewports', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);

    for (const width of [768, 960, 961, 1024]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.waitForTimeout(350);
      const metrics = await layoutMetrics(chatPage);

      await expect(chatPage.locator('.session-sidebar-shell')).toBeHidden();
      expect(metrics.main.x).toBe(0);
      expect(metrics.main.width).toBe(width);
      expect(metrics.documentScrollWidth, `${width}px document width`).toBeLessThanOrEqual(width);
      expect(metrics.mainScrollWidth, `${width}px main overflow`).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
      expect(metrics.bodyScrollWidth, `${width}px workspace overflow`).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
      expect(metrics.detail.right, `${width}px detail edge`).toBeLessThanOrEqual(width + 1);
    }
  });

  test('keeps Actions at the pane edge, supports resizing and uses compact Session typography', async ({ chatPage, mockAgent }, testInfo) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 2400, height: 1000 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', {
      ...OPEN_ITEM_DETAIL,
      finalResult: { responses: [{ summary: 'Verified the layout at desktop and mobile sizes.' }] },
    });
    await select;
    const toggle = chatPage.locator('.work-center-actions-button');
    const left = chatPage.locator('.work-center-conversation-pane');
    const right = chatPage.locator('.work-center-content-pane');
    const divider = chatPage.getByRole('separator', { name: /Resize Actions panel/ });
    const assertEdge = async () => {
      const a = await toggle.boundingBox();
      const b = await left.boundingBox();
      const headerPane = await chatPage.locator('.work-center-header-main').boundingBox();
      expect(headerPane.x + headerPane.width).toBeCloseTo(b.x + b.width, 0);
      expect(b.x + b.width - a.x - a.width).toBeLessThanOrEqual(await right.count() ? 9 : 47);
    };
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await assertEdge();
    await expect(divider).toBeVisible();
    const dividerStyle = await divider.evaluate(element => ({
      hitWidth: element.getBoundingClientRect().width,
      lineWidth: Number.parseFloat(getComputedStyle(element, '::after').width),
      lineColor: getComputedStyle(element, '::after').backgroundColor,
    }));
    expect(dividerStyle.hitWidth).toBe(8);
    expect(dividerStyle.lineWidth).toBe(1);
    expect(dividerStyle.lineColor).toBe('rgba(0, 0, 0, 0)');
    const breadcrumb = await chatPage.locator('.work-center-detail-breadcrumb').boundingBox();
    const overview = await chatPage.locator('.work-center-info-tabs').boundingBox();
    expect(breadcrumb.x).toBeCloseTo(overview.x, 0);
    await tabTo(chatPage, '.pane-resize-handle');
    expect(await divider.evaluate(element => getComputedStyle(element, '::after').backgroundColor))
      .not.toBe('rgba(0, 0, 0, 0)');
    await expect(chatPage.locator('.work-center-header h1')).toHaveCSS('font-size', '14px');
    await expect(chatPage.locator('.work-center-primary-result .work-center-response-summary')).toHaveCSS('font-size', '14px');
    const initial = await right.boundingBox();
    const grip = await divider.boundingBox();
    await chatPage.mouse.move(grip.x + grip.width / 2, grip.y + 120);
    await chatPage.mouse.down();
    await chatPage.mouse.move(grip.x - 196, grip.y + 120, { steps: 8 });
    await chatPage.mouse.up();
    await expect.poll(async () => (await right.boundingBox()).width).toBeCloseTo(initial.width + 200, 0);
    await assertEdge();
    await divider.press('ArrowRight');
    await expect(divider).toHaveAttribute('aria-valuenow', '584');
    await chatPage.locator('.work-center-action-summary').click();
    await expect(right).toHaveCSS('width', '584px');
    await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(right).toHaveCSS('width', '584px');
    expect(await chatPage.evaluate(() => localStorage.getItem('work-center-actions-width'))).toBe('584');
    await divider.press('End');
    await expect.poll(async () => (await left.boundingBox()).width).toBeGreaterThanOrEqual(360);
    await chatPage.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await left.boundingBox()).width).toBeGreaterThanOrEqual(360);
    await divider.press('Home');
    await expect(right).toHaveCSS('width', '400px');
    for (const theme of ['light', 'dark']) {
      await chatPage.setViewportSize({ width: 1600, height: 900 });
      await chatPage.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await chatPage.screenshot({ path: testInfo.outputPath(`session-density-${theme}.png`) });
    }
    // Hiding or unmounting a divider while dragging must release global cursor/selection.
    const activeGrip = await divider.boundingBox();
    await chatPage.mouse.move(activeGrip.x + 4, activeGrip.y + 100);
    await chatPage.mouse.down();
    await chatPage.setViewportSize({ width: 320, height: 720 });
    await expect(divider).toBeHidden();
    await expect(left).toBeHidden();
    await expect(chatPage.locator('body')).toHaveCSS('cursor', 'auto');
    await chatPage.mouse.up();
    await expectNoHorizontalOverflow(right, { pane: ':scope' });
    await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
    await expect(left).toBeVisible();
    await chatPage.screenshot({ path: testInfo.outputPath('session-density-mobile.png') });
  });

  test('opens Actions beside Conversation by default and lets users close it', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const conversationDetail = {
      ...OPEN_ITEM_DETAIL,
      messages: [
        {
          id: 'conversation-user', role: 'user', status: 'completed',
          text: 'Keep this change small.', createdAt: Date.now() - 1, updatedAt: Date.now() - 1,
        },
        {
          id: 'conversation-assistant', role: 'assistant', status: 'completed',
          speaker: { id: 'omni', name: 'Omni' }, text: 'I will update only the required surfaces.',
          createdAt: Date.now(), updatedAt: Date.now(),
        },
      ],
    };
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', conversationDetail);
    await select;

    const detail = chatPage.locator('.work-center-detail');
    const conversation = detail.locator('.work-center-conversation');
    const content = detail.locator('.work-center-content-pane');
    const actionsButton = chatPage.getByRole('button', { name: 'View Actions', exact: true });
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(detail).toBeVisible();
    await expect(conversation).toBeVisible();
    await expect(content).toBeVisible();
    await expect(actionsButton).toHaveAttribute('aria-expanded', 'true');
    await expect(chatPage).toHaveURL(/workContent=action-list/);
    await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
    await expect(detail.locator('textarea')).toHaveCount(1);
    const userTurn = conversation.locator('.user-turn-block');
    const assistantTurn = conversation.locator('.vp-turn-block');
    await expect(userTurn.locator('.message-user-block')).toContainText('Keep this change small.');
    await expect(userTurn.locator('.message-user-actions')).toHaveCount(1);
    await expect(assistantTurn.locator('.turn-footer')).toHaveCount(1);
    await userTurn.getByRole('button', { name: 'Edit' }).click();
    await expect(conversation.locator('textarea')).toHaveValue('Keep this change small.');
    await conversation.locator('textarea').fill('');
    await assistantTurn.getByRole('button', { name: 'Quote' }).click();
    await expect(conversation.locator('.work-center-message-quote')).toContainText('I will update only the required surfaces.');
    const quotedSend = respondToWorkCenterOp(mockAgent, 'post_work_item_message', {
      accepted: true, turnId: 'quoted-turn',
    });
    await conversation.locator('textarea').fill('Follow this exact context.');
    await conversation.getByRole('button', { name: 'Send to Coordinator' }).click();
    const quotedRequest = await quotedSend;
    expect(quotedRequest.payload.quote).toMatchObject({
      role: 'assistant', author: 'Omni · Coordinator', content: 'I will update only the required surfaces.',
    });
    await expect(conversation.locator('.work-center-message-quote')).toHaveCount(0);

    await actionsButton.click();
    await expect(content).toBeVisible();
    await expect(actionsButton).toHaveAttribute('aria-expanded', 'true');
    await expect(chatPage).toHaveURL(/workContent=action-list/);
    await content.locator('.work-center-action-summary').click();
    const actionDetail = content.locator('.work-center-action-detail-pane');
    await expect(detail).toBeVisible();
    await expect(conversation).toBeVisible();
    await expect(actionDetail).toBeVisible();
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expect(detail.locator('textarea')).toHaveCount(1);
    await chatPage.getByRole('button', { name: 'Back to Actions' }).click();
    await expect(content.locator('.work-center-action-list')).toBeVisible();
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await expect(content).toHaveCount(0);
    await expect(conversation).toBeVisible();
    await expect(actionsButton).toBeFocused();
    await expect(chatPage).toHaveURL(/workContent=none/);

    for (const width of [900, 867, 720]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await actionsButton.click();
      await expect(content).toBeVisible();
      await expect(conversation).toBeHidden();
      const metrics = await layoutMetrics(chatPage);
      expect(metrics.mainScrollWidth, `${width}px main overflow`).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
      expect(metrics.bodyScrollWidth, `${width}px workspace overflow`).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
      await chatPage.getByRole('button', { name: 'Close Actions' }).click();
      await expect(conversation).toBeVisible();
    }
  });

  test('switches to drilldown when viewport resizing reduces the actual Work Center width', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1600, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeHidden();

    await resizeViewportForMainWidth(chatPage, 900);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeHidden();

    const metrics = await layoutMetrics(chatPage);
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    await expect(chatPage).toHaveURL(/workItemId=/);
    await returnToSession(chatPage);
    await expect(chatPage.locator('.work-center-main')).toHaveCount(0);
    await expect(chatPage).not.toHaveURL(/workItemId=|workAgentId=|workContent=/);
    await expect(chatPage.locator('.session-sidebar-shell')).toBeVisible();
  });

  test('switches cleanly across the container breakpoint when the viewport is resized', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1920, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', ACTION_OVERFLOW_DETAIL);
    await select;

    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();
    const actionPane = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionPane).toBeVisible();
    await resizeViewportForMainWidth(chatPage, 1280);
    let metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeGreaterThan(1250);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    await expectNoHorizontalOverflow(actionPane, {
      pane: ':scope',
      scroll: '.work-center-action-detail-scroll',
      column: '.work-center-action-conversation-column',
      waiting: '.work-center-action-waiting',
      waitingText: '.work-center-action-waiting p',
      messageList: '.work-center-action-message-list',
      message: '.work-center-action-message',
      messageHeader: '.work-center-action-message .vp-turn-block-main-header',
      speaker: '.work-center-action-message .vp-turn-block-name',
      attachmentList: '.work-center-attachment-list',
      attachmentChip: '.work-center-attachment-chip',
    });

    await resizeViewportForMainWidth(chatPage, 1200);
    metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeGreaterThan(1160);
    expect(metrics.main.width).toBeLessThanOrEqual(1250);
    await expect(chatPage.locator('.work-center-list')).toBeHidden();
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    await expectNoHorizontalOverflow(actionPane, {
      pane: ':scope',
      scroll: '.work-center-action-detail-scroll',
      column: '.work-center-action-conversation-column',
      waiting: '.work-center-action-waiting',
      waitingText: '.work-center-action-waiting p',
      messageList: '.work-center-action-message-list',
      message: '.work-center-action-message',
      messageHeader: '.work-center-action-message .vp-turn-block-main-header',
      speaker: '.work-center-action-message .vp-turn-block-name',
      attachmentList: '.work-center-attachment-list',
      attachmentChip: '.work-center-attachment-chip',
    });

    await resizeViewportForMainWidth(chatPage, 901);
    metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeGreaterThan(900);
    await expect(chatPage.locator('.work-center-conversation-pane')).toBeVisible();
    await expect(actionPane).toBeVisible();

    await resizeViewportForMainWidth(chatPage, 900);
    metrics = await layoutMetrics(chatPage);
    expect(metrics.main.width).toBeLessThanOrEqual(900);
    await expect(chatPage.locator('.work-center-conversation-pane')).toBeHidden();
    await expect(actionPane).toBeVisible();
    expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
  });

  test('keeps a long Action list reachable in a short workspace', async ({ chatPage, mockAgent }) => {
    const detail = detailWithActions(24);
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1440, height: 520 });
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;

    await ensureActionsOpen(chatPage);
    const actionList = chatPage.locator('.work-center-action-list');
    const cards = actionList.locator('.work-center-action-card');
    const workflow = chatPage.locator('.work-center-workflow');
    await expect(cards).toHaveCount(24);
    const target = chatPage.getByTestId('work-center-composer-target');
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await target.locator('.modern-select-trigger').click();
    const targetMenu = chatPage.locator('.work-center-composer-target-menu');
    const targetList = targetMenu.locator('.modern-select-list');
    await expect(targetMenu).toBeVisible();
    await expect(targetMenu).not.toHaveClass(/ms-pop-enter-(?:from|active|to)/);
    await expect.poll(() => targetMenu.evaluate(element => getComputedStyle(element).transform)).toBe('none');
    const targetMenuHeight = await targetMenu.evaluate(element => element.getBoundingClientRect().height);
    for (let index = 0; index < 8; index += 1) {
      await targetList.evaluate((element, step) => {
        element.scrollTop = step % 2 ? element.scrollHeight : 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, index);
      await expect.poll(() => targetMenu.evaluate(element => element.getBoundingClientRect().height))
        .toBeCloseTo(targetMenuHeight, 0);
    }
    await chatPage.keyboard.press('Escape');
    await ensureActionsOpen(chatPage);
    const paneWidth = await chatPage.locator('.work-center-content-pane')
      .evaluate(element => element.getBoundingClientRect().width);
    expect(paneWidth).toBeGreaterThanOrEqual(380);
    expect(paneWidth).toBeLessThanOrEqual(420);
    await cards.last().scrollIntoViewIfNeeded();
    await expect(cards.last()).toBeInViewport();
    const scroll = await workflow.locator('.work-center-content-scroll').evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.scrollTop).toBeGreaterThan(0);

    const firstCard = cards.first();
    const cardLayout = await firstCard.evaluate(element => {
      const title = element.querySelector('.work-center-action-primary strong');
      const summary = element.querySelector('.work-center-action-description');
      const titleStyle = title ? getComputedStyle(title) : null;
      return {
        cardWidth: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
        titleWidth: title?.getBoundingClientRect().width || 0,
        summaryWidth: summary?.getBoundingClientRect().width || 0,
        titleWritingMode: titleStyle?.writingMode || '',
      };
    });
    expect(cardLayout.scrollWidth).toBeLessThanOrEqual(cardLayout.cardWidth + 1);
    expect(cardLayout.titleWidth).toBeGreaterThan(100);
    expect(cardLayout.summaryWidth).toBeGreaterThan(100);
    expect(cardLayout.titleWritingMode).toBe('horizontal-tb');

    await chatPage.setViewportSize({ width: 520, height: 760 });
    await chatPage.waitForTimeout(350);
    await expect(chatPage.locator('.work-center-conversation-pane')).toBeHidden();
    await expect(chatPage.locator('.work-center-content-pane')).toBeVisible();
    await expect(workflow).toBeVisible();
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await expect(chatPage.locator('.work-center-conversation-pane')).toBeVisible();
  });

  test('uses one composer and changes wire target only after an explicit target choice', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [OPEN_ITEM, GENERATION_ITEM]);
    const select = chatPage.locator('.work-center-card', { hasText: OPEN_ITEM.title }).click();
    const getRequest = await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    expect(getRequest.op).toBe('get');

    const breadcrumb = await tabTo(chatPage, '.work-center-breadcrumb-button');
    await expectVisibleFocus(breadcrumb);
    await expect(chatPage.locator('.work-center-content-pane')).toBeVisible();
    await ensureActionsOpen(chatPage);
    await expect(chatPage.locator('.work-center-content-title')).toContainText('Actions');
    await expect(chatPage.locator('.work-center-content-title span')).toHaveText('1');
    const action = chatPage.locator('.work-center-action-card');
    await expect(action).toHaveCount(1);
    const actionSummary = await tabTo(chatPage, '.work-center-action-summary');
    await expectVisibleFocus(actionSummary);
    await expect(action).toContainText('Linus');
    await expect(action).toContainText('Update the existing layout styles and verify supported breakpoints');
    await expect(action).not.toContainText('LLM requests');
    await expect(action).not.toContainText('loops');
    await expect(action).not.toContainText('tools');
    await expect(action).not.toContainText('tokens');
    await expect(chatPage.locator('.work-center-detail-usage')).toContainText('4 LLM requests');
    await expect(chatPage.locator('.work-center-detail-usage')).toContainText('1.8k tokens');
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    const conversation = chatPage.locator('.work-center-conversation');
    await expect(conversation).toHaveAttribute('aria-label', 'Conversation');
    await expect(conversation.locator('.work-center-coordinator-empty')).toHaveCount(0);
    const workItemComposer = conversation.locator('textarea');
    const target = conversation.getByTestId('work-center-composer-target');
    await expect(chatPage.locator('.work-center-detail textarea')).toHaveCount(1);
    await expectWorkCenterTarget(target, 'coordinator', 'Send to Coordinator');
    const composerControls = await conversation.locator('.chat-composer-actions-start').evaluate(element => (
      [...element.children].map(child => child.className)
    ));
    expect(composerControls[0]).toContain('work-center-attachment-picker');
    expect(composerControls[1]).toContain('work-center-composer-target');
    const targetTrigger = await tabTo(chatPage, '.work-center-composer-target .modern-select-trigger');
    await expectVisibleFocus(targetTrigger);
    await target.locator('.modern-select-trigger').click();
    const targetMenu = chatPage.locator('.work-center-composer-target-menu');
    await expect(targetMenu).toHaveClass(/yeaft-model-dropdown/);
    await expect(targetMenu.locator('.modern-select-option-label')).toHaveText([
      'Send to Coordinator', 'Send to Action 1',
    ]);
    await expect(targetMenu.locator('.modern-select-option-sub')).toHaveText([
      'Work Item planning and coordination', 'Make the Work Center layout responsive',
    ]);
    await expect(targetMenu.locator('.modern-select-badge')).toHaveText('running');
    const menuGeometry = await targetMenu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const trigger = document.querySelector('.work-center-composer-target .modern-select-trigger')
        ?.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        triggerTop: trigger?.top ?? 0,
        viewportWidth: window.innerWidth,
      };
    });
    expect(menuGeometry.left).toBeGreaterThanOrEqual(8);
    expect(menuGeometry.right).toBeLessThanOrEqual(menuGeometry.viewportWidth - 8);
    expect(menuGeometry.bottom).toBeLessThanOrEqual(menuGeometry.triggerTop + 1);
    const darkMenuBackground = await chatPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      return getComputedStyle(document.querySelector('.work-center-composer-target-menu')).backgroundColor;
    });
    expect(darkMenuBackground).not.toBe('rgba(0, 0, 0, 0)');
    await chatPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await chatPage.keyboard.press('Escape');
    await expect(targetMenu).toHaveCount(0);
    await workItemComposer.fill('Change the goal\nand replan the remaining Actions');
    const workItemComposerMetrics = await workItemComposer.evaluate(element => ({
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(workItemComposerMetrics.clientHeight).toBeGreaterThan(workItemComposerMetrics.lineHeight * 1.5);
    expect(workItemComposerMetrics.overflowY).toBe('hidden');
    const workItemInputWidth = await conversation.locator('.work-center-item-message-input')
      .evaluate(element => element.getBoundingClientRect().width);
    const overviewWidth = await chatPage.locator('.work-center-info-tabs')
      .evaluate(element => element.getBoundingClientRect().width);
    expect(workItemInputWidth).toBe(overviewWidth);
    expect(workItemInputWidth).toBeGreaterThan(700);
    expect(workItemInputWidth).toBeLessThanOrEqual(920);
    const conversationResponse = respondToWorkCenterOp(mockAgent, 'post_work_item_message', {
      accepted: true,
      turnId: 'turn-1',
    });
    await conversation.getByRole('button', { name: 'Send to Coordinator' }).click();
    const conversationRequest = await conversationResponse;
    expect(conversationRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'coordinator' },
      text: 'Change the goal\nand replan the remaining Actions',
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
    });
    await expect(workItemComposer).toHaveValue('');

    await workItemComposer.fill('Recover this request after its staged attachment expires');
    await conversation.locator('.work-center-item-message-input input[type="file"]').setInputFiles({
      name: 'expired-note.txt', mimeType: 'text/plain',
      buffer: Buffer.from('expired staged attachment'),
    });
    await expect(conversation.locator('.work-center-message-draft-attachments'))
      .toContainText('expired-note.txt');
    const expiredAttemptPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const expiredAttempt = await expiredAttemptPromise;
    expect(expiredAttempt.op).toBe('post_work_item_message');
    const expiredClientMessageId = expiredAttempt.payload.clientMessageId;
    const expiredFileId = expiredAttempt.payload.attachments[0].fileId;
    expect(expiredClientMessageId).toEqual(expect.any(String));
    await mockAgent.__workCenterTransport.reject(
      expiredAttempt, 'WorkItem attachment expired; upload it again',
    );
    await expect(conversation.locator('.work-center-error'))
      .toContainText('WorkItem attachment expired; upload it again');
    const pendingActions = conversation.locator('.work-center-stale-target', {
      hasText: 'An unconfirmed request is locked to its original identity.',
    });
    await expect(pendingActions).toBeVisible();
    await expect(pendingActions.getByText('Replace attachments')).toBeVisible();
    await expect(pendingActions.getByRole('button', { name: 'Discard pending request' })).toBeVisible();
    await expect(workItemComposer).toBeDisabled();

    await pendingActions.locator('input[type="file"]').setInputFiles({
      name: 'replacement-note.txt', mimeType: 'text/plain',
      buffer: Buffer.from('replacement staged attachment'),
    });
    await expect(conversation.locator('.work-center-message-draft-attachments'))
      .toContainText('replacement-note.txt');
    const retryAttemptPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const retryAttempt = await retryAttemptPromise;
    expect(retryAttempt.op).toBe('post_work_item_message');
    expect(retryAttempt.payload).toMatchObject({
      id: OPEN_ITEM.id,
      clientMessageId: expiredClientMessageId,
      text: 'Recover this request after its staged attachment expires',
      target: { kind: 'coordinator' },
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
    });
    expect(retryAttempt.payload.attachments[0].fileId).not.toBe(expiredFileId);
    expect(retryAttempt.payload.attachments[0].name).toBe('replacement-note.txt');
    await mockAgent.__workCenterTransport.resolve(retryAttempt, {
      accepted: true, turnId: 'turn-replaced-attachment',
    });
    await expect(pendingActions).toHaveCount(0);
    await expect(workItemComposer).toBeEnabled();
    await expect(workItemComposer).toHaveValue('');

    await workItemComposer.fill('Discard this pending request but keep the editable text');
    const discardAttemptPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const discardAttempt = await discardAttemptPromise;
    expect(discardAttempt.payload.clientMessageId).not.toBe(expiredClientMessageId);
    await mockAgent.__workCenterTransport.reject(discardAttempt, 'Response was lost');
    await expect(pendingActions).toBeVisible();
    await pendingActions.getByRole('button', { name: 'Discard pending request' }).click();
    await expect(pendingActions).toHaveCount(0);
    await expect(workItemComposer).toBeEnabled();
    await expect(workItemComposer)
      .toHaveValue('Discard this pending request but keep the editable text');
    await workItemComposer.fill('Discarded request is editable again');
    await expect(workItemComposer).toHaveValue('Discarded request is editable again');
    await workItemComposer.fill('');

    await ensureActionsOpen(chatPage);
    await action.locator('.work-center-action-summary').click();
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('.work-center-action-message')).toContainText('Updated the existing layout styles');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-detail textarea')).toHaveCount(1);
    await expectWorkCenterTarget(target, 'coordinator', 'Send to Coordinator');
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=action-list%2Faction%3Aaction-1`));
    await expect(actionDetail.getByRole('tab')).toHaveCount(0);
    await expect(actionDetail.getByText('Execution', { exact: true })).toHaveCount(0);
    await expect(actionDetail.locator('.work-center-action-overview > p'))
      .toHaveText('Update the existing layout styles and verify supported breakpoints');
    await expect(actionDetail.locator('.work-center-action-context-list')).toContainText('Expected result');

    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'run.progress',
        workItem: {
          ...OPEN_ITEM,
          revision: 1,
          currentActionId: 'action-1',
          updatedAt: Number(OPEN_ITEM.updatedAt) + 1,
          actionStats: [{
            id: 'action-1', status: 'running', progressRevision: 5,
            executionStats: OPEN_ITEM_DETAIL.actions[0].executionStats,
            liveMessage: {
              id: 'run:run-live', role: 'assistant', kind: 'response', status: 'running',
              text: '',
              toolEvents: [{
                id: 'tool-read', name: 'Read', status: 'running', resource: 'src/layout.js', startedAt: Date.now(),
              }],
              attachments: [],
              createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 5,
            },
          }],
        },
      },
    });
    const liveResponse = actionDetail.locator('.work-center-action-message:has(.tool-line)');
    await expect(liveResponse).toHaveCount(1);
    await expect(actionDetail.locator('.work-center-action-empty')).toHaveCount(0);
    await expect(liveResponse.locator('.tool-line')).toContainText('Read src/layout.js');
    await expect(liveResponse.locator('.tool-line')).toHaveClass(/running/);
    await expect(liveResponse.locator('.tool-line-status.running')).toBeVisible();

    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'run.progress',
        workItem: {
          ...OPEN_ITEM,
          revision: 1,
          currentActionId: 'action-1',
          updatedAt: Number(OPEN_ITEM.updatedAt) + 2,
          actionStats: [{
            id: 'action-1', status: 'running', progressRevision: 6,
            executionStats: OPEN_ITEM_DETAIL.actions[0].executionStats,
            liveMessage: {
              id: 'run:run-live', role: 'assistant', kind: 'response', status: 'running',
              text: 'Live AI response from the active Run.',
              toolEvents: [
                { id: 'tool-read', name: 'Read', status: 'completed', resource: 'src/layout.js', startedAt: Date.now() - 10 },
                { id: 'tool-bash', name: 'Bash', status: 'error', startedAt: Date.now() },
              ],
              attachments: [],
              createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 6,
            },
          }],
        },
      },
    });
    await expect(liveResponse.locator('.tool-line').filter({ hasText: 'Bash' })).toHaveClass(/error/);
    await expect(liveResponse.locator('.tool-line-status.error')).toBeVisible();
    await liveResponse.getByRole('button', { name: '1 more' }).click();
    await expect(liveResponse.locator('.tool-line')).toHaveCount(2);
    await expect(liveResponse.locator('.tool-line').filter({ hasText: 'Read src/layout.js' })).toHaveClass(/completed/);

    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await chooseWorkCenterTarget(chatPage, target, 'Send to Action 1');
    await expectWorkCenterTarget(target, 'action:action-1:1', 'Send to Action 1');
    await workItemComposer.focus();
    await workItemComposer.fill('Keep the current implementation\nand verify the narrow layout');
    const actionInputResponse = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: {
            ...OPEN_ITEM_DETAIL,
            actions: [{ ...OPEN_ITEM_DETAIL.actions[0], status: 'running' }],
          },
          list: { items: [OPEN_ITEM, GENERATION_ITEM], watcher: { enabled: true } },
          get: OPEN_ITEM_DETAIL,
        }));
      }
      return operations;
    })();
    await conversation.getByRole('button', { name: /Send to/ }).click();
    const actionInputOps = await actionInputResponse;
    const actionInputRequest = actionInputOps.find(request => request.op === 'post_work_item_message');
    expect(actionInputRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      text: 'Keep the current implementation\nand verify the narrow layout',
    });
    await expect(workItemComposer).toHaveValue('');
    await expect(actionDetail).toHaveCount(0);
    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();

    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'run.finished',
        workItem: {
          ...OPEN_ITEM,
          revision: 2,
          status: 'done',
          currentActionId: null,
          currentAction: null,
          updatedAt: Number(OPEN_ITEM.updatedAt) + 2,
          actionStats: [{
            id: 'action-1', generation: 1, status: 'completed', progressRevision: 6,
            executionStats: OPEN_ITEM_DETAIL.actions[0].executionStats,
            response: 'FINAL REPLY',
            liveMessage: {
              id: 'run:run-live', runId: 'run-live', role: 'assistant', kind: 'response',
              status: 'completed', text: 'FINAL REPLY',
              toolEvents: [{ id: 'tool-read', name: 'Read', status: 'completed', resource: 'src/layout.js', startedAt: Date.now() - 10 }],
              attachments: [],
              generation: 1, attempt: 1,
              createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 6,
            },
          }],
        },
      },
    });
    const finalResponse = actionDetail.locator('.work-center-action-message', { hasText: 'FINAL REPLY' });
    await expect(finalResponse).toHaveCount(1);
    await expect(finalResponse.locator('.tool-line').filter({ hasText: 'Read src/layout.js' })).toHaveClass(/completed/);
    await expect(actionDetail.locator('.work-center-action-message')).toHaveCount(2);

    const terminalDetail = {
      ...OPEN_ITEM_DETAIL,
      revision: 2,
      status: 'done',
      currentActionId: null,
      currentAction: null,
      updatedAt: Number(OPEN_ITEM.updatedAt) + 2,
      actions: [{
        ...OPEN_ITEM_DETAIL.actions[0],
        status: 'completed',
        progressRevision: 6,
        response: 'FINAL REPLY',
        messages: [{
          id: 'run:run-live', runId: 'run-live', role: 'assistant', kind: 'response',
          status: 'completed', text: 'FINAL REPLY',
          toolEvents: [{ id: 'tool-read', name: 'Read', status: 'completed', resource: 'src/layout.js', startedAt: Date.now() - 10 }],
          attachments: [],
          generation: 1, attempt: 1,
          createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 6,
        }],
        liveMessage: {
          id: 'run:run-live', runId: 'run-live', role: 'assistant', kind: 'response',
          status: 'completed', text: 'FINAL REPLY',
          toolEvents: [{ id: 'tool-read', name: 'Read', status: 'completed', resource: 'src/layout.js', startedAt: Date.now() - 10 }],
          attachments: [],
          generation: 1, attempt: 1,
          createdAt: Date.now(), updatedAt: Date.now(), progressRevision: 6,
        },
      }],
    };
    const terminalPage = {
      actionId: 'action-1', generation: 1,
      messages: terminalDetail.actions[0].messages,
      nextCursor: null,
      total: 1,
    };
    const terminalRequestOps = [
      (await respondByOperation(mockAgent, {
        get: terminalDetail,
        get_action_messages: terminalPage,
        list: { items: [terminalDetail, GENERATION_ITEM], watcher: { enabled: true } },
      })).op,
      (await respondByOperation(mockAgent, {
        get: terminalDetail,
        get_action_messages: terminalPage,
        list: { items: [terminalDetail, GENERATION_ITEM], watcher: { enabled: true } },
      })).op,
    ];
    await expect(finalResponse).toHaveCount(1);
    await expect(finalResponse.locator('.tool-line').filter({ hasText: 'Read src/layout.js' })).toHaveClass(/completed/);
    await expect(actionDetail.locator('.work-center-action-message')).toHaveCount(1);
    const readFinalState = () => chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      const agentId = store.workCenterAgentId;
      const detail = store.workCenterDetailByAgent[agentId];
      const action = detail.actions.find(candidate => candidate.id === 'action-1');
      const key = `${agentId}:${detail.id}:action-1:1`;
      return {
        status: detail.status,
        currentActionId: detail.currentActionId,
        messages: action.messages.map(message => message.text),
        cachedMessages: (store.workCenterActionMessages[key]?.messages || []).map(message => message.text),
        nextCursor: store.workCenterActionMessages[key]?.nextCursor,
      };
    });
    expect(terminalRequestOps.sort()).toEqual(['get', 'get_action_messages']);
    await expect.poll(readFinalState).toEqual({
      status: 'done',
      currentActionId: null,
      messages: ['FINAL REPLY'],
      cachedMessages: ['FINAL REPLY'],
      nextCursor: null,
    });

    if (await chatPage.locator('.work-center-content-pane').count()) {
      await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    }
    await chatPage.getByRole('button', { name: 'Work items', exact: true }).click();
    const openFailed = chatPage.locator('.work-center-card', { hasText: GENERATION_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', GENERATION_ITEM_DETAIL, [OPEN_ITEM, GENERATION_ITEM]);
    await openFailed;
    const failedConversation = chatPage.locator('.work-center-conversation');
    const failedTarget = failedConversation.getByTestId('work-center-composer-target');
    const failedComposer = failedConversation.locator('textarea');
    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();
    await chatPage
      .getByRole('button', { name: 'Close Actions' }).click();
    await chooseWorkCenterTarget(chatPage, failedTarget, 'Send to Action 1');
    await expectWorkCenterTarget(failedTarget, 'action:action-generation:1', 'Send to Action 1');
    await failedComposer.fill('Keep this draft bound to Action generation one.');
    const generationUpload = chatPage.waitForResponse(response => (
      response.url().includes('/api/upload') && response.request().method() === 'POST'
    ));
    await failedConversation.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'generation-one.txt', mimeType: 'text/plain', buffer: Buffer.from('generation one evidence'),
    });
    await generationUpload;
    await expect(failedConversation.locator('.work-center-message-draft-attachments'))
      .toContainText('generation-one.txt');
    const generationOneAttemptPromise = mockAgent.__workCenterTransport.next();
    await failedConversation.locator('.send-btn').click();
    const generationOneAttempt = await generationOneAttemptPromise;
    expect(generationOneAttempt.payload).toMatchObject({
      id: GENERATION_ITEM.id,
      target: { kind: 'action', actionId: 'action-generation', generation: 1 },
      text: 'Keep this draft bound to Action generation one.',
      attachments: [expect.objectContaining({ name: 'generation-one.txt' })],
    });
    await mockAgent.__workCenterTransport.reject(generationOneAttempt, 'Response was lost');
    await expect(failedConversation.locator('.work-center-stale-target', {
      hasText: 'An unconfirmed request is locked to its original identity.',
    })).toBeVisible();
    if (await chatPage.locator('.work-center-content-pane').count()) {
      await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    }
    await chatPage.getByRole('button', { name: 'Work items', exact: true }).click();
    const reopenDone = chatPage.locator('.work-center-card', { hasText: OPEN_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', terminalDetail, [OPEN_ITEM, GENERATION_ITEM]);
    await reopenDone;
    mockAgent.send({
      type: 'work_center_event',
      event: {
        type: 'action.retried',
        actionId: 'action-generation',
        workItem: {
          ...GENERATION_ITEM,
          revision: 2,
          currentActionId: 'action-generation',
          updatedAt: Number(GENERATION_ITEM.updatedAt) + 1,
          actionStats: [{ ...GENERATION_ITEM_DETAIL.actions[0], generation: 2, status: 'ready' }],
        },
      },
    });
    await chatPage.getByRole('button', { name: 'Work items', exact: true }).click();
    const generationTwoFailedDetail = {
      ...GENERATION_ITEM_DETAIL,
      revision: 2,
      actions: [{ ...GENERATION_ITEM_DETAIL.actions[0], generation: 2, status: 'ready' }],
    };
    const returnToFailed = chatPage.locator('.work-center-card', { hasText: GENERATION_ITEM.title }).click();
    await respondUntilOperation(mockAgent, 'get', {
      get: generationTwoFailedDetail,
      get_action_messages: {
        actionId: 'action-generation', generation: 2, messages: [], nextCursor: null, total: 0,
      },
    });
    await returnToFailed;
    await expectWorkCenterTarget(failedTarget, 'action:action-generation:1', 'Selected Action is no longer available');
    await expect(failedConversation.locator('.work-center-stale-target[role="alert"]')).toBeVisible();
    await expect(failedComposer).toHaveValue('Keep this draft bound to Action generation one.');
    await expect(failedConversation.locator('.send-btn')).toBeDisabled();
    await chooseWorkCenterTarget(chatPage, failedTarget, 'Send to Action 1');
    await expectWorkCenterTarget(failedTarget, 'action:action-generation:2', 'Send to Action 1');
    await expect(chatPage.locator('.work-center-stale-target')).toHaveCount(0);
    await expect(failedComposer).toHaveValue('Keep this draft bound to Action generation one.');
    await expect(failedConversation.locator('.work-center-message-draft-attachments'))
      .toContainText('generation-one.txt');
    await expect.poll(() => chatPage.evaluate(({ agentId, workItemId }) => (
      window.Pinia.useChatStore().loadWorkCenterMessageEnvelope(agentId, workItemId)
    ), { agentId: mockAgent.agentId, workItemId: GENERATION_ITEM.id })).toBeNull();
    await expect(failedConversation.locator('.send-btn')).toBeEnabled();
    const confirmedGenerationResponse = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: {
            ...generationTwoFailedDetail,
            revision: 3,
            actions: [{ ...GENERATION_ITEM_DETAIL.actions[0], generation: 3, status: 'ready' }],
          },
          list: { items: [OPEN_ITEM, { ...GENERATION_ITEM, revision: 3 }], watcher: { enabled: true } },
          get: generationTwoFailedDetail,
        }));
      }
      return operations;
    })();
    await failedConversation.locator('.send-btn').click();
    const confirmedGenerationOps = await confirmedGenerationResponse;
    expect(confirmedGenerationOps.find(request => request.op === 'post_work_item_message').payload)
      .toMatchObject({
        id: GENERATION_ITEM.id,
        target: { kind: 'action', actionId: 'action-generation', generation: 2 },
        text: 'Keep this draft bound to Action generation one.',
        attachments: [expect.objectContaining({ name: 'generation-one.txt' })],
      });
  });

  test('restores the Work Item and top ContentRef from the URL and browser back', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    if (await chatPage.locator('.work-center-content-pane').count()) {
      await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
    }
    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();

    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=action-list%2Faction%3Aaction-1`));
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();

    await chatPage.reload();
    await chatPage.waitForSelector('.chat-page');
    await chatPage.waitForFunction(agentId => {
      const store = window.Pinia?.useChatStore?.();
      return (store?.agents || []).some(agent => agent.id === agentId && agent.online === true);
    }, mockAgent.agentId);
    workCenterTransports.delete(chatPage);
    mockAgent.__workCenterTransport = null;
    const restoredTransport = await installWorkCenterTransport(chatPage);
    mockAgent.__workCenterTransport = restoredTransport;
    await chatPage.evaluate(({ agentId, item, settings }) => {
      const store = window.Pinia.useChatStore();
      store.workCenterAgentId = agentId;
      store.workCenterOpen = false;
      store.workCenterItemsByAgent[agentId] = [item];
      store.workCenterLoadedByAgent[agentId] = true;
      store.workCenterLoadingByAgent[agentId] = false;
      store.workCenterSettingsByAgent[agentId] = settings;
      store.workCenterRuntimeByAgent[agentId] = settings.runtime;
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM, settings: WORK_CENTER_SETTINGS });
    const getResponse = respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await chatPage.evaluate(() => {
      const store = window.Pinia.useChatStore();
      store.workCenterOpen = true;
    });
    await getResponse;
    await expect(chatPage.locator('.work-center-detail')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
    await expectWorkCenterTarget(chatPage.getByTestId('work-center-composer-target'), 'coordinator', 'Send to Coordinator');

    await chatPage.goBack();
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=action-list`));
    await expect(chatPage.locator('.work-center-action-list')).toBeVisible();
    await expect(chatPage.locator('.work-center-action-detail-pane')).toHaveCount(0);
    await expectWorkCenterTarget(chatPage.getByTestId('work-center-composer-target'), 'coordinator', 'Send to Coordinator');

    await chatPage.goBack();
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=none`));
    await expect(chatPage.locator('.work-center-content-pane')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-conversation')).toBeVisible();

    await chatPage.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('workContent', 'action-list/action:action-1');
      window.history.pushState({ ...window.history.state, workCenterContent: true }, '', url);
    });
    await chatPage.reload();
    await chatPage.waitForSelector('.chat-page');
    await chatPage.waitForFunction(agentId => {
      const store = window.Pinia?.useChatStore?.();
      return (store?.agents || []).some(agent => agent.id === agentId && agent.online === true);
    }, mockAgent.agentId);
    workCenterTransports.delete(chatPage);
    mockAgent.__workCenterTransport = null;
    const raceTransport = await installWorkCenterTransport(chatPage);
    mockAgent.__workCenterTransport = raceTransport;
    await chatPage.evaluate(({ agentId, item, settings }) => {
      const store = window.Pinia.useChatStore();
      store.workCenterAgentId = agentId;
      store.workCenterOpen = false;
      store.workCenterItemsByAgent[agentId] = [item];
      store.workCenterDetailByAgent[agentId] = null;
      store.workCenterLoadedByAgent[agentId] = true;
      store.workCenterLoadingByAgent[agentId] = false;
      store.workCenterSettingsByAgent[agentId] = settings;
      store.workCenterRuntimeByAgent[agentId] = settings.runtime;
    }, { agentId: mockAgent.agentId, item: OPEN_ITEM, settings: WORK_CENTER_SETTINGS });

    const takePendingGet = async () => {
      for (;;) {
        const request = await raceTransport.next();
        if (request.op === 'get') return request;
        const response = request.op === 'list' ? { items: [OPEN_ITEM], watcher: { enabled: true } }
          : request.op === 'get_settings' ? WORK_CENTER_SETTINGS
          : request.op === 'get_runtime' ? WORK_CENTER_SETTINGS.runtime
          : undefined;
        if (response === undefined) throw new Error(`Unexpected Work Center op ${request.op}`);
        await raceTransport.resolve(request, response);
      }
    };

    await chatPage.evaluate(() => {
      window.Pinia.useChatStore().workCenterOpen = true;
    });
    const staleDeepLinkGet = await takePendingGet();
    expect(staleDeepLinkGet.payload).toEqual({ id: OPEN_ITEM.id });

    await chatPage.goBack();
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=none`));
    const currentConversationGet = await takePendingGet();
    expect(currentConversationGet.payload).toEqual({ id: OPEN_ITEM.id });
    await raceTransport.resolve(currentConversationGet, OPEN_ITEM_DETAIL);

    await expect(chatPage.locator('.work-center-conversation')).toBeVisible();
    await expect(chatPage.locator('.work-center-content-pane')).toHaveCount(0);
    await raceTransport.resolve(staleDeepLinkGet, OPEN_ITEM_DETAIL);
    await expect(chatPage.locator('.work-center-conversation')).toBeVisible();
    await expect(chatPage.locator('.work-center-content-pane')).toHaveCount(0);
    await expect(chatPage).toHaveURL(new RegExp(`workItemId=${OPEN_ITEM.id}.*workContent=none`));

    for (const legacyContent of [
      'action-list/action:action-1/run:action-1:run-legacy',
      'action-list/action:action-1/attachment:action-1:attachment-legacy',
    ]) {
      await chatPage.evaluate(content => {
        const url = new URL(window.location.href);
        url.searchParams.set('workContent', content);
        const state = { ...window.history.state, workCenterContent: true };
        window.history.pushState(state, '', url);
        window.dispatchEvent(new PopStateEvent('popstate', { state }));
      }, legacyContent);
      await expect(chatPage.locator('.work-center-action-detail-pane')).toBeVisible();
      await expect(chatPage).toHaveURL(new RegExp(
        `workItemId=${OPEN_ITEM.id}.*workContent=action-list%2Faction%3Aaction-1$`,
      ));
      await chatPage.getByRole('button', { name: 'Back to Actions' }).click();
      await expect(chatPage.locator('.work-center-action-list')).toBeVisible();
      await expect(chatPage.locator('.work-center-action-detail-pane')).toHaveCount(0);
    }
  });

  test('loads one retained conversation when an earlier Action is selected', async ({ chatPage, mockAgent }) => {
    const detail = detailWithActions(2);
    delete detail.actions[0].messages;
    delete detail.actions[0].response;
    detail.actions[0].brief = { ...detail.actions[0].brief, objective: 'Earlier Action' };
    detail.actions[0].messageCount = 3;
    detail.actions[0].messageCursor = '1';
    detail.actions[0].thread = [{
      generation: 1,
      canonical: false,
      messages: [{
        id: 'run:first-execution', role: 'assistant', kind: 'response', status: 'failed',
        text: 'First execution failed.', attachments: [],
        createdAt: Date.now() - 3, updatedAt: Date.now() - 3, progressRevision: 1,
      }],
    }];
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;
    await ensureActionsOpen(chatPage);

    const messagesResponse = respondToWorkCenterOp(mockAgent, 'get_action_messages', {
      actionId: detail.actions[0].id,
      generation: detail.actions[0].generation,
      messages: [
        {
          id: 'event:retry-input', role: 'user', kind: 'input', status: 'sent',
          text: 'Retry with the corrected constraint.', attachments: [],
          createdAt: Date.now() - 2, updatedAt: Date.now() - 2,
        },
        {
          id: 'run:second-execution', role: 'assistant', kind: 'response', status: 'completed',
          text: 'Second execution completed.', attachments: [],
          createdAt: Date.now() - 1, updatedAt: Date.now() - 1, progressRevision: 2,
        },
      ],
      nextCursor: null,
      total: 2,
    });
    await chatPage.locator('.work-center-action-card', { hasText: 'Earlier Action' }).click();
    const request = await messagesResponse;

    expect(request.payload).toEqual({
      id: OPEN_ITEM.id, actionId: detail.actions[0].id,
      generation: 1, cursor: null, limit: 20,
    });
    const messages = chatPage.locator('.work-center-action-message');
    await expect(messages).toHaveCount(3);
    await expect(messages.nth(0)).toContainText('First execution failed.');
    await expect(messages.nth(1)).toContainText('Retry with the corrected constraint.');
    await expect(messages.nth(2)).toContainText('Second execution completed.');
    await expect(chatPage.locator('.work-center-action-generation')).toHaveCount(0);
    await expect(chatPage.getByText('Previous execution')).toHaveCount(0);
  });

  test('explains Action recovery states and exposes the waiting question', async ({ chatPage, mockAgent }) => {
    const items = [FAILED_ITEM, WAITING_ITEM];
    await openWorkCenter(chatPage, mockAgent, items);
    const selectFailure = chatPage.locator('.work-center-card', { hasText: FAILED_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', FAILED_ITEM_DETAIL, items);
    await selectFailure;
    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();

    let actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('Why this Action failed');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('unsafe patch');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('All unverified changes were reverted');
    await expect(actionDetail.locator('.work-center-action-failure')).toContainText('Choose this Action in the Work Item composer');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);

    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await chatPage.getByRole('button', { name: 'Work items', exact: true }).click();
    const selectWaiting = chatPage.locator('.work-center-card', { hasText: WAITING_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', WAITING_ITEM_DETAIL, items);
    await selectWaiting;
    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();

    actionDetail = chatPage.locator('.work-center-action-detail-pane');
    const waitingQuestion = actionDetail.locator('#work-center-action-waiting-question');
    await expect(waitingQuestion).toContainText('Input required');
    await expect(waitingQuestion).toContainText('Choose PostgreSQL or SQLite before the migration continues.');
    const conversation = chatPage.locator('.work-center-conversation');
    await expect(conversation.locator('.work-center-item-message-list .role-assistant .vp-turn-block-name'))
      .toHaveText('Omni · Coordinator');
    await expect(actionDetail.locator('.work-center-action-message .vp-turn-block-name'))
      .toHaveText('Linus · Action 1');
    const composer = conversation.locator('textarea');
    const target = conversation.getByTestId('work-center-composer-target');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expectWorkCenterTarget(target, 'coordinator', 'Send to Coordinator');
    await waitingQuestion.getByRole('button', { name: 'Reply to this Action', exact: true }).click();
    await expect(composer).toBeFocused();
    await expectWorkCenterTarget(target, 'action:action-1:1', 'Send to Action 1');
    await expect(composer).toHaveAttribute('placeholder', 'Message Make the Work Center layout responsive from the Conversation composer');

    await composer.fill('Use PostgreSQL and explain the migration tradeoff.');
    const continuedDetail = {
      ...WAITING_ITEM_DETAIL,
      status: 'ready',
      revision: 2,
      currentAction: { ...WAITING_ITEM.currentAction, generation: 2, status: 'ready' },
      actions: [{ ...WAITING_ITEM_DETAIL.actions[0], generation: 2, status: 'ready' }],
    };
    const actionInputResponse = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: continuedDetail,
          list: { items: [{ ...WAITING_ITEM, status: 'ready' }], watcher: { enabled: true } },
          get: continuedDetail,
        }));
      }
      return operations;
    })();
    await conversation.getByRole('button', { name: /Send to/ }).click();
    const operations = await actionInputResponse;
    expect(operations.find(request => request.op === 'post_work_item_message').payload).toMatchObject({
      id: WAITING_ITEM.id,
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      text: 'Use PostgreSQL and explain the migration tradeoff.',
    });
  });

  test('answers a Coordinator question and recovers a rejected Action reply without locking the draft', async ({ chatPage, mockAgent }) => {
    await chatPage.setViewportSize({ width: 320, height: 800 });
    const detail = structuredClone(WAITING_ITEM_DETAIL);
    detail.currentActionId = null;
    delete detail.currentAction;
    delete detail.messages[0].recovery;
    detail.messages[0].decision.question = 'May we use an isolated worktree and leave the existing diff untouched?';
    await openWorkCenter(chatPage, mockAgent, [WAITING_ITEM]);
    const selecting = chatPage.locator('.work-center-card', { hasText: WAITING_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', detail, [WAITING_ITEM]);
    await selecting;
    await chatPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const conversation = chatPage.locator('.work-center-conversation');
    const composer = conversation.locator('textarea');
    const target = conversation.getByTestId('work-center-composer-target');
    const prompt = chatPage.locator('.work-center-resume');
    await prompt.getByRole('button', { name: 'Reply to Coordinator', exact: true }).click();
    await expect(composer).toBeFocused();
    await expectWorkCenterTarget(target, 'coordinator', 'Send to Coordinator');
    await composer.fill('Use a new worktree; do not touch the existing diff.');
    const coordinatorReply = respondToWorkCenterOp(mockAgent, 'post_work_item_message', { accepted: true });
    await conversation.locator('.send-btn').click();
    expect((await coordinatorReply).payload.target).toEqual({ kind: 'coordinator' });
    await expect(composer).toHaveValue('');

    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();
    await chatPage.locator('#work-center-action-waiting-question').getByRole('button', { name: 'Reply to this Action' }).click();
    await expect(composer).toBeFocused();
    await expectWorkCenterTarget(target, 'action:action-1:1', 'Send to Action 1');
    await composer.fill('Keep all existing changes untouched.');
    await conversation.locator('input[type="file"]').setInputFiles({
      name: 'constraints.txt', mimeType: 'text/plain', buffer: Buffer.from('Preserve existing changes'),
    });
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('constraints.txt');
    const requestPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const rejected = await requestPromise;
    const fresh = { ...detail, revision: 2 };
    const refreshing = respondToWorkCenterOp(mockAgent, 'get', fresh);
    await mockAgent.__workCenterTransport.reject(rejected,
      'Action changed before input was applied; refresh and try again', 'WORK_CENTER_INPUT_STALE');
    await refreshing;
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue('Keep all existing changes untouched.');
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('constraints.txt');
    await expect(conversation.getByText('An unconfirmed request is locked to its original identity.')).toHaveCount(0);
    await expect(conversation.locator('.work-center-error')).toContainText('Your reply was not applied');
    const retryPromise = mockAgent.__workCenterTransport.next();
    await conversation.locator('.send-btn').click();
    const retried = await retryPromise;
    expect(retried.payload.revision).toBe(2);
    expect(retried.payload.clientMessageId).not.toBe(rejected.payload.clientMessageId);
    expect(retried.payload.attachments).toEqual(rejected.payload.attachments);
    const listing = respondToWorkCenterOp(mockAgent, 'list', { items: [WAITING_ITEM] });
    await mockAgent.__workCenterTransport.resolve(retried, fresh);
    await listing;
    await expect(composer).toHaveValue('');
    expect(await chatPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('uses compact stop controls and resumes a stopped Work Item', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [OPEN_ITEM, CANCELLED_ITEM]);
    const selectOpen = chatPage.locator('.work-center-card', { hasText: OPEN_ITEM.title }).click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL, [OPEN_ITEM, CANCELLED_ITEM]);
    await selectOpen;

    const stop = chatPage.getByRole('button', { name: 'Stop work item' });
    await expect(stop).toBeVisible();
    await expect(chatPage.locator('.work-center-danger-zone')).toHaveCount(0);
    const stopBounds = await stop.evaluate(element => {
      const button = element.getBoundingClientRect();
      const heading = element.closest('.work-center-header');
      const title = heading?.querySelector('h1')?.getBoundingClientRect();
      return {
        height: button.height,
        insideHeading: !!heading,
        afterTitle: !!title && button.left >= title.right,
      };
    });
    expect(stopBounds.height).toBeLessThanOrEqual(36);
    expect(stopBounds.insideHeading).toBe(true);
    expect(stopBounds.afterTitle).toBe(true);
    await expect(chatPage.locator('.work-center-detail-controls')).toHaveCount(0);

    await chatPage.setViewportSize({ width: 430, height: 900 });
    await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
    const compactBounds = await stop.evaluate(element => {
      const button = element.getBoundingClientRect();
      const heading = element.closest('.work-center-header')?.getBoundingClientRect();
      const back = element.closest('.work-center-header')
        ?.querySelector('.work-center-breadcrumb-button')?.getBoundingClientRect();
      return {
        insideHeading: !!heading && button.left >= heading.left && button.right <= heading.right,
        clearOfBack: !back || button.left >= back.right || button.bottom <= back.top,
      };
    });
    expect(compactBounds.insideHeading).toBe(true);
    expect(compactBounds.clearOfBack).toBe(true);

    await chatPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    });
    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(stop).toBeVisible();
    const stopColors = await stop.evaluate(element => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--error)';
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(element).color, expected };
    });
    expect(stopColors.actual).toBe(stopColors.expected);

    const cancelResponses = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'cancel')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          cancel: CANCELLED_ITEM_DETAIL,
          list: { items: [CANCELLED_ITEM], watcher: { enabled: true } },
          get: CANCELLED_ITEM_DETAIL,
        }));
      }
      return operations;
    })();
    await stop.click();
    const confirmation = chatPage.getByRole('dialog').filter({
      hasText: 'Stop this work item and its unfinished Actions?',
    });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'OK', exact: true }).click();
    const cancelOps = await cancelResponses;
    expect(cancelOps.some(request => request.op === 'list')).toBe(true);
    expect(cancelOps.find(request => request.op === 'cancel').payload).toEqual({ id: OPEN_ITEM.id });
    await expect(chatPage.getByText('Work item details')).toBeVisible();

    const selectCancelled = chatPage.locator('.work-center-card', { hasText: CANCELLED_ITEM.title })
      .locator('.work-center-card-open').dispatchEvent('click');
    await respondToWorkCenterOp(mockAgent, 'get', CANCELLED_ITEM_DETAIL, [CANCELLED_ITEM]);
    await selectCancelled;
    const resume = chatPage.getByRole('button', { name: 'Resume work item' });
    await expect(resume).toBeVisible();
    const resumedDetail = {
      ...OPEN_ITEM_DETAIL,
      id: CANCELLED_ITEM.id,
      title: CANCELLED_ITEM.title,
      status: 'ready',
      revision: CANCELLED_ITEM_DETAIL.revision,
      actions: [{ ...OPEN_ITEM_DETAIL.actions[0], id: 'action-cancelled', status: 'ready', generation: 2 }],
      currentActionId: 'action-cancelled',
    };
    const resumeResponses = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'resume')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          resume: resumedDetail,
          list: { items: [resumedDetail], watcher: { enabled: true } },
          get: resumedDetail,
        }));
      }
      return operations;
    })();
    await resume.click();
    const resumeOps = await resumeResponses;
    expect(resumeOps.some(request => request.op === 'list')).toBe(true);
    expect(resumeOps.find(request => request.op === 'resume').payload).toEqual({
      id: CANCELLED_ITEM.id,
      revision: CANCELLED_ITEM_DETAIL.revision,
    });
  });

  test('keeps done and cancelled Work Items read-only without sending message wire', async ({ chatPage, mockAgent }) => {
    const closedItems = [DONE_ITEM, CANCELLED_ITEM];
    const closedDetails = new Map([
      [DONE_ITEM.id, DONE_ITEM_DETAIL],
      [CANCELLED_ITEM.id, {
        ...CANCELLED_ITEM_DETAIL,
        actions: [{
          ...CANCELLED_ITEM_DETAIL.actions[0],
          failure: {
            error: 'The cancelled Action did not publish changes.',
            summary: 'The Work Item is closed and cannot accept corrected instructions.',
            failedAt: Date.now(),
          },
        }],
      }],
    ]);
    await openWorkCenter(chatPage, mockAgent, closedItems);

    for (const item of closedItems) {
      const select = chatPage.locator('.work-center-card', { hasText: item.title })
        .locator('.work-center-card-open').click();
      await respondToWorkCenterOp(mockAgent, 'get', closedDetails.get(item.id), closedItems);
      await select;

      const conversation = chatPage.locator('.work-center-conversation');
      await expect(conversation).toContainText(item.status === 'done'
        ? 'Yeaft confirmed every acceptance criterion.'
        : 'Yeaft recorded the cancellation.');
      await expect(conversation.locator('.role-assistant .vp-turn-block-name')).toHaveText('Coordinator');
      await expect(conversation.locator('.work-center-conversation-readonly')).toBeVisible();
      await expect(conversation.locator('.work-center-item-message-input')).toHaveCount(0);
      await expect(conversation.locator('textarea')).toHaveCount(0);
      await expect(conversation.locator('.debug-turn-action-btn, [aria-label="Quote"], [aria-label="Edit as new message"]')).toHaveCount(0);
      await expect(conversation.locator('.copy-full-btn')).not.toHaveCount(0);
      await expect(conversation.locator('.export-md-btn')).not.toHaveCount(0);

      await ensureActionsOpen(chatPage);
      await chatPage.locator('.work-center-action-summary').click();
      const actionDetail = chatPage.locator('.work-center-action-detail-pane');
      await expect(actionDetail).toContainText(item.status === 'done'
        ? 'Verified and released the layout fix.'
        : 'Execution stopped without publishing changes.');
      await expect(actionDetail.locator('.work-center-action-message .vp-turn-block-name')).toHaveText('Action 1');
      await expect(actionDetail.locator('.work-center-action-composer')).toHaveCount(0);
      await expect(actionDetail.locator('textarea')).toHaveCount(0);
      await expect(actionDetail.locator('.debug-turn-action-btn, [aria-label="Quote"], [aria-label="Edit as new message"]')).toHaveCount(0);
      await expect(actionDetail.locator('.copy-full-btn')).not.toHaveCount(0);
      await expect(actionDetail.locator('.export-md-btn')).not.toHaveCount(0);
      await expect(actionDetail).not.toContainText('Choose this Action in the Work Item composer');

      await chatPage.getByRole('button', { name: 'Back to Actions' }).click();
      await chatPage.getByRole('button', { name: 'Close Actions' }).click();
      await chatPage.getByRole('button', { name: 'Work items', exact: true }).click();
      await expect(chatPage.locator('.work-center-list')).toBeVisible();
    }

    const blockedOps = new Set(['post_work_item_message', 'retry_action', 'guide']);
    expect(workCenterRequestOps(mockAgent).filter(op => blockedOps.has(op))).toEqual([]);
  });

  test('keeps Action detail free of retained call data and request loading', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;

    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail).toBeVisible();
    await expect(actionDetail).toContainText('Make the Work Center layout responsive');
    await expect(actionDetail).toContainText('Updated the existing layout styles');
    await expect(actionDetail.getByRole('tab')).toHaveCount(0);
    await expect(actionDetail.getByText('Execution', { exact: true })).toHaveCount(0);
    await expect(actionDetail.locator('.work-center-request-card')).toHaveCount(0);
    await expect(actionDetail.locator('.work-center-request-tool')).toHaveCount(0);
    await expect(actionDetail.getByRole('button', { name: 'Send to this Action' })).toHaveCount(0);
    expect(workCenterRequestOps(mockAgent)).not.toContain('get_action_requests');
    expect(workCenterRequestOps(mockAgent)).not.toContain('get_action_request');
  });

  test('renders read-only Action content in both themes and preserves the Conversation draft on mobile', async ({ chatPage, mockAgent }) => {
    const detail = structuredClone(ACTION_OVERFLOW_DETAIL);
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;

    const workItem = chatPage.locator('.work-center-detail');
    const conversation = workItem.locator('.work-center-conversation');
    const composer = conversation.locator('textarea');
    await composer.fill('Preserve this draft while reviewing the Action');
    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();

    const pane = chatPage.locator('.work-center-action-detail-pane');
    await expect(pane.locator('textarea')).toHaveCount(0);
    await expect(workItem.locator('textarea')).toHaveCount(1);
    await expect(pane.locator('.work-center-action-message')).toHaveCount(2);
    await expect(pane.locator('.work-center-action-waiting')).toBeVisible();
    await expect(pane).toContainText('Action overflow probe');
    await expect(pane).toContainText('Keep the correction small.');
    await expect(pane.locator('.work-center-attachment-chip')).toHaveCount(1);

    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await expect(chatPage.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1200, 760, 390]) {
        await chatPage.setViewportSize({ width, height: 720 });
        await chatPage.waitForTimeout(250);
        const layout = await pane.evaluate(root => {
          const rect = root.getBoundingClientRect();
          const assistant = root.querySelector('.role-assistant');
          const user = root.querySelector('.role-user');
          const userBubble = user.querySelector('.message-user-block');
          return {
            left: rect.left,
            right: rect.right,
            width: rect.width,
            scrollWidth: root.scrollWidth,
            assistantText: getComputedStyle(assistant).color,
            userText: getComputedStyle(userBubble).color,
            userBackground: getComputedStyle(userBubble).backgroundColor,
          };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(width + 1);
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
        await expectNoHorizontalOverflow(pane, {
          pane: ':scope',
          scroll: '.work-center-action-detail-scroll',
          column: '.work-center-action-conversation-column',
          waiting: '.work-center-action-waiting',
          waitingText: '.work-center-action-waiting p',
          messageList: '.work-center-action-message-list',
          message: '.work-center-action-message',
          messageHeader: '.work-center-action-message .vp-turn-block-main-header',
          speaker: '.work-center-action-message .vp-turn-block-name',
          attachmentList: '.work-center-attachment-list',
          attachmentChip: '.work-center-attachment-chip',
        });
        expect(layout.userText).not.toBe(layout.userBackground);
        expect(layout.userBackground).not.toBe('rgba(0, 0, 0, 0)');
        expect(layout.assistantText).not.toBe(layout.userBackground);
        expect(await chatPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }

    await chatPage.setViewportSize({ width: 390, height: 720 });
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await expect(composer).toHaveValue('Preserve this draft while reviewing the Action');
    await expectWorkCenterTarget(workItem.getByTestId('work-center-composer-target'), 'coordinator', 'Send to Coordinator');
  });

  test('keeps Work Item card controls transparent in light and dark themes', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [FAILED_ITEM]);
    const card = chatPage.locator('.work-center-card');
    await expect(card.locator('.work-center-card-open')).toBeVisible();
    await expect(card.locator('.work-center-card-delete')).toBeEnabled();

    const themeColors = {};
    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await expect(chatPage.locator('html')).toHaveAttribute('data-theme', theme);
      if (theme === 'dark') {
        await expect.poll(() => card.evaluate(element => getComputedStyle(element).backgroundColor))
          .not.toBe(themeColors.light.cardBackground);
      }
      themeColors[theme] = await card.evaluate(element => {
        const open = element.querySelector('.work-center-card-open');
        const remove = element.querySelector('.work-center-card-delete');
        const cardStyle = getComputedStyle(element);
        const openStyle = getComputedStyle(open);
        const removeStyle = getComputedStyle(remove);
        return {
          cardBackground: cardStyle.backgroundColor,
          cardText: cardStyle.color,
          openBackground: openStyle.backgroundColor,
          openBorderWidth: openStyle.borderTopWidth,
          openText: openStyle.color,
          deleteBackground: removeStyle.backgroundColor,
          deleteBorderWidth: removeStyle.borderTopWidth,
        };
      });

      expect(themeColors[theme].cardBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(themeColors[theme].cardText).not.toBe(themeColors[theme].cardBackground);
      expect(themeColors[theme].openBackground).toBe('rgba(0, 0, 0, 0)');
      expect(themeColors[theme].openBorderWidth).toBe('0px');
      expect(themeColors[theme].openText).toBe(themeColors[theme].cardText);
      expect(themeColors[theme].deleteBackground).toBe('rgba(0, 0, 0, 0)');
      expect(themeColors[theme].deleteBorderWidth).toBe('0px');
    }

    expect(themeColors.dark.cardBackground).not.toBe(themeColors.light.cardBackground);
    expect(themeColors.dark.cardText).not.toBe(themeColors.light.cardText);

    await chatPage.emulateMedia({ reducedMotion: 'reduce' });
    await card.hover();
    const reducedMotion = await card.evaluate(element => {
      const style = getComputedStyle(element);
      return { transform: style.transform, transitionDuration: style.transitionDuration };
    });
    expect(reducedMotion.transform).toBe('none');
    expect(reducedMotion.transitionDuration).toBe('0s');
  });

  test('keeps read-only Action content visible without overflow in dark theme', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', OPEN_ITEM_DETAIL);
    await select;
    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();

    await chatPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    });
    await expect(chatPage.locator('html')).toHaveAttribute('data-theme', 'dark');
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail).toBeVisible();
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-detail textarea')).toHaveCount(1);

    const metrics = await layoutMetrics(chatPage);
    expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
    const colors = await actionDetail.locator('.work-center-action-detail-scroll').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, text: style.color };
    });
    expect(colors.text).not.toBe(colors.background);
  });

  test('shows delayed directory defaults before sending the create request', async ({ chatPage, mockAgent }) => {
    await installWorkCenterTransport(chatPage).then(transport => { mockAgent.__workCenterTransport = transport; });
    const settingsRequest = (async () => {
      for (;;) {
        const request = mockAgent.__workCenterTransport
          ? await mockAgent.__workCenterTransport.next()
          : await mockAgent.waitForMessage('work_center_request');
        if (request.op === 'get_settings') return request;
        if (request.op !== 'list') throw new Error(`Expected Work Center list or get_settings, received ${request.op}`);
        if (mockAgent.__workCenterTransport) {
          await mockAgent.__workCenterTransport.resolve(request, { items: [OPEN_ITEM], watcher: { enabled: true } });
        } else {
          mockAgent.send({
            type: 'work_center_response', requestId: request.requestId, op: request.op, ok: true,
            data: { items: [OPEN_ITEM], watcher: { enabled: true } },
          });
        }
      }
    })();

    const entered = await chatPage.evaluate(() => window.Pinia.useChatStore().enterWorkCenter());
    expect(entered).toBe(true);
    const pendingSettings = await settingsRequest;
    await expect(chatPage.locator('.work-center-main')).toBeVisible();
    await chatPage.locator('.work-center-header-create').click();
    const createModal = chatPage.locator('.work-center-modal');
    const workDir = createModal.getByRole('textbox', { name: /Working directory/ });
    await expect(workDir).toHaveValue('');
    await expect(createModal.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

    if (mockAgent.__workCenterTransport) {
      await mockAgent.__workCenterTransport.resolve(pendingSettings, WORK_CENTER_SETTINGS);
    } else {
      mockAgent.send({
        type: 'work_center_response', requestId: pendingSettings.requestId, op: pendingSettings.op, ok: true,
        data: WORK_CENTER_SETTINGS,
      });
    }
    await expect(workDir).toHaveValue('/tmp/test');
    await createModal.getByRole('textbox', { name: /Requirement/ })
      .fill('Use the directory shown in the form');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await createModal.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    await respondToWorkCenterOp(mockAgent, 'list', { items: [OPEN_ITEM], watcher: { enabled: true } });
    expect(request.payload.workDir).toBe('/tmp/test');
    expect(request.payload.workItemType).toBe('auto');
    expect(request.payload.titleSource).toBe('coordinator_pending');
    expect(request.payload.goal).toBe('Use the directory shown in the form');
  });

  test('uses the shared workdir picker for Work Center directory selection', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    const createModal = chatPage.locator('.work-center-modal');
    const respondDirectory = (request, path, entries) => mockAgent.send({
      type: 'directory_listing', conversationId: request.conversationId,
      requestId: request.requestId, _workbenchRequestId: request._workbenchRequestId,
      dirPath: path, entries,
    });
    const initial = mockAgent.waitForMessage('list_directory');
    await createModal.getByRole('button', { name: 'Choose folder' }).click();
    respondDirectory(await initial, '/tmp/test', [
      { name: 'project-alpha', type: 'directory' },
      { name: 'project-beta', type: 'directory' },
    ]);

    const picker = chatPage.getByRole('dialog', { name: 'Select Work Directory', exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('textbox', { name: 'Directory path' })).toHaveValue('/tmp/test');
    await expect(picker.locator('.folder-picker-item')).toHaveCount(2);
    await expect(picker.locator('.tree-item')).toHaveCount(0);
    const navigation = mockAgent.waitForMessage('list_directory');
    await picker.getByRole('button', { name: 'project-alpha' }).click();
    const request = await navigation;
    expect(request.dirPath).toBe('/tmp/test/project-alpha');
    const confirm = picker.getByRole('button', { name: 'Select this directory' });
    await expect(confirm).toBeDisabled();
    respondDirectory(request, request.dirPath, []);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(createModal.getByRole('textbox', { name: /Working directory/ }))
      .toHaveValue('/tmp/test/project-alpha');
  });

  test('keeps a create action available on mobile with existing work items', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 720, height: 900 });
    await chatPage.waitForTimeout(350);

    await expect(chatPage.locator('.session-sidebar-shell')).toBeHidden();
    await expect(chatPage.locator('.work-center-return, .work-center-navigation-toggle').filter({ visible: true }).first()).toBeVisible();

    const create = chatPage.locator('.work-center-header-create');
    await expect(create).toBeVisible();
    await expect(create).toHaveAttribute('aria-label', 'New work item');
    await create.click();
    const createModal = chatPage.locator('.work-center-modal');
    await expect(createModal).toBeVisible();
    await expect(createModal.getByRole('textbox', { name: /Working directory/ })).toHaveValue('/tmp/test');
  });

  test('saves Coordinator model policy through the real settings wire contract', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1280, height: 900 });

    const settingsRequest = respondUntilOperation(mockAgent, 'get_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
    });
    await chatPage.getByRole('button', { name: 'More actions', exact: true }).click();
    await chatPage.getByRole('button', { name: 'Work Center settings', exact: true }).click();
    await settingsRequest;
    // Opening the modal starts its own load after the page-level settings load.
    await respondToWorkCenterOp(mockAgent, 'get_settings', WORK_CENTER_SETTINGS);
    const modal = chatPage.locator('.work-center-settings-card');
    await expect(modal).toBeVisible();
    const box = await modal.boundingBox();
    expect(box.width).toBeGreaterThan(850);
    expect(box.height).toBeGreaterThan(650);

    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(expectedActionPolicyCount());
    await expect(chatPage.locator('.work-center-global-policy textarea')).toHaveValue('Follow the Agent release policy for every Action.');
    await expect(chatPage.locator('.work-center-policy-stage textarea').nth(1)).toHaveValue('Plan the task');
    await chatPage.getByRole('button', { name: 'Models', exact: true }).click();
    const modelStages = chatPage.locator('.work-center-model-stage');
    await expect(modelStages).toHaveCount(expectedModelPolicyCount());
    const coordinatorStage = modelStages.filter({ has: chatPage.locator('strong', { hasText: /^Coordinator$/ }) });
    await expect(coordinatorStage).toHaveCount(1);
    const modelStage = modelStages.last();
    await expect(modelStage).toContainText('Fallback for all Actions');
    const effort = modelStage.locator('.work-center-model-effort');
    await expect(effort).toContainText('Reasoning effort');
    await expect(effort.locator('select')).toHaveValue('high');
    await expect(effort.locator('select')).toBeEnabled();
    await expect(effort).toContainText('Overrides the selected model');

    await modelStage.locator('select').first().selectOption('inherit');
    await expect(effort).toBeVisible();
    await expect(effort.locator('select')).toBeEnabled();
    await expect(effort.locator('option')).toContainText(['Model default', 'medium', 'high']);
    await expect(effort).toContainText('Select the Agent primary model');
    await expect(modal.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);

    await coordinatorStage.locator('select').first().selectOption('specific');
    await expect(coordinatorStage.locator('select')).toHaveCount(3);
    await coordinatorStage.locator('select').nth(1).selectOption('provider/review');
    await coordinatorStage.locator('.work-center-model-effort select').selectOption('medium');
    await expect(coordinatorStage.locator('select').first()).toHaveValue('specific');
    await expect(coordinatorStage.locator('select').nth(1)).toHaveValue('provider/review');
    await expect(coordinatorStage.locator('.work-center-model-effort select')).toHaveValue('medium');

    const expectedCoordinatorPolicy = { mode: 'specific', model: 'provider/review', tag: 'ultimate', effort: 'medium' };
    const saveResponse = respondUntilOperation(mockAgent, 'update_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
      update_settings: request => ({
        settings: { ...request.payload.settings, revision: 8 },
        runtime: WORK_CENTER_SETTINGS.runtime,
      }),
    });
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    const saveRequest = await saveResponse;
    expect(saveRequest.payload.settings).toMatchObject({ revision: 7 });
    expect(saveRequest.payload.settings.coordinatorModelPolicy)
      .toEqual(expectedCoordinatorPolicy);
    expect(saveRequest.payload.settings.modelPolicy.mode).toBe('inherit');
    await respondToWorkCenterOp(
      mockAgent, 'list', { items: [OPEN_ITEM], watcher: { enabled: true } }, [OPEN_ITEM],
    );
    await expect(modal).toBeHidden();
    expect(saveRequest.op).toBe('update_settings');
    await expect.poll(() => chatPage.evaluate(agentId => {
      const settings = window.Pinia.useChatStore().workCenterSettingsByAgent[agentId];
      return {
        revision: settings?.revision,
        coordinatorModelPolicy: settings?.coordinatorModelPolicy,
      };
    }, mockAgent.agentId)).toEqual({
      revision: 8,
      coordinatorModelPolicy: expectedCoordinatorPolicy,
    });
  });

  test('opens settings returned by an older Agent without dynamic fields', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const legacySettings = structuredClone(WORK_CENTER_SETTINGS);
    delete legacySettings.settings.actionInstructions;
    delete legacySettings.settings.modelPolicy;
    delete legacySettings.settings.coordinatorModelPolicy;
    delete legacySettings.settings.actionModelPolicies;
    legacySettings.settings.workflows[0].stages[0].instruction = 'Legacy triage prompt.';
    legacySettings.settings.workflows[0].stages[0].modelPolicy = {
      mode: 'specific', model: 'provider/review', effort: 'high',
    };
    legacySettings.runtime.defaultStageInstructions = {
      implement: 'Implement the task.',
      custom: 'Complete the Action.',
    };
    const settingsRequest = respondUntilOperation(mockAgent, 'get_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: legacySettings,
    });

    await chatPage.getByRole('button', { name: 'More actions', exact: true }).click();
    await chatPage.getByRole('button', { name: 'Work Center settings', exact: true }).click();
    await settingsRequest;

    const modal = chatPage.locator('.work-center-settings-card');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.work-center-policy-stage')).toHaveCount(expectedActionPolicyCount());
    const triagePrompt = modal.locator('.work-center-policy-stage textarea').nth(1);
    await expect(triagePrompt).toHaveValue('Legacy triage prompt.');
    await expect(triagePrompt).toBeDisabled();
    await expect(modal.getByText(/cannot save Work Center settings/)).toBeVisible();
    await expect(modal.locator('.work-center-settings-footer .btn-primary')).toBeDisabled();
    await modal.getByRole('button', { name: 'Models', exact: true }).click();
    const globalModelStage = modal.locator('.work-center-model-stage').last();
    await expect(globalModelStage.locator('select').first()).toHaveValue('specific');
    await expect(globalModelStage.locator('select').first()).toBeDisabled();
    await expect(globalModelStage.locator('select').last()).toHaveValue('high');
  });

  test('keeps settings usable in dark theme and mobile viewport', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await chatPage.setViewportSize({ width: 720, height: 780 });
    await expect(chatPage.locator('.session-sidebar-shell')).toBeHidden();
    await expect(chatPage.locator('.work-center-return, .work-center-navigation-toggle').filter({ visible: true }).first()).toBeVisible();
    const settingsRequest = respondUntilOperation(mockAgent, 'get_settings', {
      list: { items: [OPEN_ITEM], watcher: { enabled: true } },
      get_settings: WORK_CENTER_SETTINGS,
    });
    await chatPage.getByRole('button', { name: 'More actions', exact: true }).click();
    await chatPage.getByRole('button', { name: 'Work Center settings', exact: true }).click();
    await settingsRequest;

    const modal = chatPage.locator('.work-center-settings-card');
    await expect(modal).toBeVisible();
    await expect(chatPage.locator('.work-center-policy-stage')).toHaveCount(expectedActionPolicyCount());
    const workflowMetrics = await modal.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const pane = element.querySelector('.work-center-settings-pane');
      const textarea = element.querySelector('.work-center-stage-instruction textarea');
      const save = element.querySelector('.work-center-settings-footer .btn-primary');
      const textareaStyle = getComputedStyle(textarea);
      const saveStyle = getComputedStyle(save);
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        paneScrollable: pane.scrollHeight >= pane.clientHeight,
        background: getComputedStyle(element).backgroundColor,
        textareaBackground: textareaStyle.backgroundColor,
        textareaColor: textareaStyle.color,
        saveBackground: saveStyle.backgroundColor,
        saveColor: saveStyle.color,
      };
    });
    expect(workflowMetrics.left).toBeGreaterThanOrEqual(0);
    expect(workflowMetrics.right).toBeLessThanOrEqual(workflowMetrics.viewportWidth);
    expect(workflowMetrics.top).toBeGreaterThanOrEqual(0);
    expect(workflowMetrics.bottom).toBeLessThanOrEqual(workflowMetrics.viewportHeight);
    expect(workflowMetrics.paneScrollable).toBe(true);
    expect(workflowMetrics.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(workflowMetrics.textareaBackground).not.toBe('rgb(255, 255, 255)');
    expect(workflowMetrics.textareaColor).not.toBe(workflowMetrics.textareaBackground);
    expect(workflowMetrics.saveBackground).not.toBe(workflowMetrics.background);
    expect(workflowMetrics.saveColor).not.toBe(workflowMetrics.saveBackground);

    await modal.getByRole('button', { name: 'Models', exact: true }).click();
    const effort = modal.locator('.work-center-model-stage').last().locator('.work-center-model-effort');
    await expect(effort).toBeVisible();
    await expect(effort.locator('select')).toHaveValue('high');
    const effortStyle = await effort.locator('select').evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(effortStyle.background).not.toBe('rgb(255, 255, 255)');
    expect(effortStyle.color).not.toBe(effortStyle.background);
    await expect(modal.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);
  });

  test('creates from a goal contract and leaves planning to the Coordinator', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    await expect(chatPage.locator('.work-center-plan-preview')).toContainText('Coordinator-driven execution');
    await expect(chatPage.locator('.work-center-plan-preview')).toContainText('The Coordinator chooses the next Actions and executors from the current evidence');
    await expect(chatPage.locator('.work-center-plan-stages')).toHaveCount(0);

    await chatPage.locator('.work-center-modal').getByRole('textbox', { name: /Requirement/ })
      .fill('Fix dynamic planning with the smallest safe flow');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await chatPage.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    expect(request.payload.workItemType).toBe('auto');
    expect(request.payload).not.toHaveProperty('workflowTemplate');
    expect(request.payload).not.toHaveProperty('stageOverrides');
  });

  test('creates a response delivery without requesting code artifacts', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    const modal = chatPage.locator('.work-center-modal');
    await modal.getByRole('textbox', { name: /Requirement/ }).fill('Explain the failure with supporting evidence');
    await modal.getByRole('combobox', { name: /Delivery target/ }).selectOption('response');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await modal.getByRole('button', { name: 'Create', exact: true }).click();
    expect((await createRequest).payload.deliveryTarget).toBe('response');
  });

  test('compact item references open named Actions from attempts, evidence and dependencies', async ({ chatPage, mockAgent }, testInfo) => {
    const source = { ...OPEN_ITEM_DETAIL.actions[0], status: 'completed', messages: [], brief: { objective: 'Review model tags and defaults' } };
    const delivery = { ...source, id: 'action-delivery', sequence: 4, stageId: 'deliver', sourceActionIds: [source.id], brief: { objective: 'Merge approved model policy' } };
    const detail = {
      ...resourceStoppedDetail(), status: 'done', currentActionId: delivery.id, actions: [source, delivery],
      outputs: Array.from({ length: 8 }, (_, index) => ({ kind: 'file', label: `Model policy output ${index + 1}`, ref: `agent/yeaft/work-center/model-policy-${index + 1}.js` })),
      goalProgress: { completedCriteriaCount: 1, totalCriteriaCount: 1, criteria: [{ criterion: 'Verify model tags '.repeat(40), status: 'passed', evidenceRunIds: ['delivery-proof'] }],
        blockers: [], delivery: { target: 'merge', status: 'passed', evidenceRunIds: ['delivery-proof'] } },
      runReferences: [{ id: 'delivery-proof', actionId: delivery.id }],
    };
    detail.executionControl.stopReason = null;
    detail.executionControl.actionAttempts = [
      { actionId: source.id, attempts: 1, effectiveMaxAttempts: 3 },
      { actionId: delivery.id, attempts: 1, effectiveMaxAttempts: 2 },
      { actionId: 'missing-action', attempts: 1, effectiveMaxAttempts: 1 },
    ];
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card-open').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail);
    await select;
    const overview = chatPage.locator('.work-center-work-item-overview');
    await expect(chatPage.locator('#work-item-info-tab-requirement')).toHaveAttribute('aria-selected', 'true');
    await chatPage.locator('#work-item-info-tab-usage').click();
    await overview.locator('.work-center-resource-details > summary').click();
    const attempts = overview.locator('.work-center-resource-attempts');
    await expect(attempts).toContainText('Action 4 · Merge approved model policy');
    await expect(attempts).not.toContainText('action-delivery');
    await expect(attempts.locator('.work-center-reference-unavailable')).toHaveText('Source Action unavailable');
    const reference = attempts.getByRole('button', { name: /Action 4/ });
    await reference.focus();
    await chatPage.keyboard.press('Enter');
    const actionPane = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionPane.locator('h2')).toHaveText(delivery.brief.objective);
    await expect(chatPage).toHaveURL(/workContent=action-list%2Faction%3Aaction-delivery/);
    await expect(chatPage.getByRole('button', { name: 'Back to Actions' })).toBeFocused();
    await actionPane.getByRole('button', { name: /Action 1 · Review model tags/ }).click();
    await expect(actionPane.locator('h2')).toHaveText(source.brief.objective);
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await chatPage.locator('#work-item-info-tab-goals').click();
    await overview.locator('.work-center-goal-delivery > details > summary').click();
    await overview.locator('.work-center-goal-delivery').getByRole('button', { name: /Action 4/ }).click();
    await expect(actionPane.locator('h2')).toHaveText(delivery.brief.objective);
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();
    await chatPage.locator('#work-item-info-tab-outputs').click();
    for (const [theme, locale] of [['light', 'en'], ['dark', 'zh-CN']]) {
      await chatPage.evaluate(({ theme, locale }) => {
        document.documentElement.setAttribute('data-theme', theme);
        window.Pinia.useChatStore().changeLocale(locale);
      }, { theme, locale });
      for (const width of [1440, 320]) {
        await chatPage.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(overview, { outputs: '.work-center-output-list', overview: ':scope' });
        await expect(overview.locator('.work-center-output-list > li')).toHaveCount(8);
        const outputHeight = await overview.locator('.work-center-output-list').evaluate(el => el.getBoundingClientRect().height);
        if (width === 1440) expect(outputHeight).toBeLessThan(330);
        await overview.scrollIntoViewIfNeeded();
        await chatPage.screenshot({ path: testInfo.outputPath(`item-${theme}-${width}.png`) });
      }
    }
    // The reference also opens the narrow-screen content overlay and remains usable after closing it.
    await chatPage.locator('#work-item-info-tab-goals').click();
    await overview.locator('.work-center-goal-delivery').getByRole('button').click();
    await expect(actionPane.locator('h2')).toHaveText(delivery.brief.objective);
    await expect(actionPane).toBeVisible();
  });

  test('shows evidence-based goal progress, blockers and delivery instead of Action completion', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', {
      ...detailWithActions(4),
      completedActionCount: 4,
      deliveryTarget: 'response',
      acceptanceCriteria: ['Explain the cause', 'Verify the fix', 'Document the result'],
      goalProgress: {
        completedCriteriaCount: 1, totalCriteriaCount: 3,
        remainingCriteria: ['Verify the fix', 'Document the result'],
        criteria: [
          { criterion: 'Explain the cause', status: 'passed', evidenceRunIds: ['run-proof'] },
          { criterion: 'Verify the fix', status: 'failed', evidenceRunIds: [] },
          { criterion: 'Document the result', status: 'unmet', evidenceRunIds: [] },
        ],
        blockers: [{ actionId: 'action-4', status: 'waiting', reason: 'Need the reproduction logs' }],
        delivery: { target: 'response', status: 'unmet', evidenceRunIds: [] },
      },
    });
    await select;
    await chatPage.locator('#work-item-info-tab-goals').click();
    const progress = chatPage.locator('.work-center-goal-progress');
    await expect(progress).toContainText('1 / 3 criteria verified');
    await expect(progress).toContainText('2 remaining');
    await expect(progress.locator('[data-status="failed"]')).toContainText('Verify the fix');
    await expect(progress.locator('[data-status="unmet"]').first()).toContainText('Document the result');
    await expect(progress.locator('[data-status="passed"]')).toContainText('Source Action unavailable');
    await chatPage.locator('#work-item-info-tab-progress').click();
    await expect(chatPage.locator('.work-center-goal-blockers')).toContainText('Need the reproduction logs');
    await chatPage.locator('#work-item-info-tab-goals').click();
    await expect(progress).toContainText('Response');
    await expect(progress).toContainText('Not yet verified');
    await expect(chatPage.locator('.work-center-content-panel')).not.toBeVisible();

    // A bounded legacy projection may omit the only unmet row. Counts remain authoritative.
    await chatPage.evaluate(agentId => {
      const item = window.Pinia.useChatStore().workCenterDetailByAgent[agentId];
      item.goalProgress = { ...item.goalProgress, completedCriteriaCount: 100, totalCriteriaCount: 101,
        remainingCriteria: [], omittedCriteriaCount: 1,
        criteria: [{ criterion: 'Visible passed criterion', status: 'passed', evidenceRunIds: [] }] };
    }, mockAgent.agentId);
    await expect(progress).toContainText('100 / 101 criteria verified');
    await expect(progress).toContainText('1 remaining');
    await expect(progress).not.toContainText('All criteria verified');
    await expect(progress).toContainText('1 more criteria omitted');

    // Older Agents must not acquire a fabricated goal percentage from Action counts.
    await chatPage.evaluate(({ agentId, detail }) => {
      window.Pinia.useChatStore().workCenterDetailByAgent[agentId] = detail;
    }, { agentId: mockAgent.agentId, detail: OPEN_ITEM_DETAIL });
    await expect(progress).toHaveCount(0);
    await expect(chatPage.locator('.work-center-acceptance')).toContainText('The Action flow remains readable');
  });

  test('keeps delivered responses and goal evidence readable in both themes at 320px', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    const select = chatPage.locator('.work-center-card').click();
    const criterion = `Explain the result ${'criterion'.repeat(100)}`;
    const runId = `run-${'evidence'.repeat(50)}`;
    await respondToWorkCenterOp(mockAgent, 'get', {
      ...OPEN_ITEM_DETAIL, status: 'done', deliveryTarget: 'response',
      acceptanceCriteria: [criterion],
      goalProgress: {
        completedCriteriaCount: 1, totalCriteriaCount: 1, remainingCriteria: [], blockers: [],
        criteria: [{ criterion, status: 'passed', evidenceRunIds: [runId] }],
        delivery: { target: 'response', status: 'passed', evidenceRunIds: [runId] },
      },
      finalResult: {
        responses: [{ runId, summary: `The answer is supported by logs.\n<script>window.untrustedResponse = true</script>\n${'response'.repeat(200)}`,
          evidence: [{ kind: 'test', label: 'Reproduction confirmed', ref: `logs/${'trace'.repeat(200)}`, status: 'passed' }] }],
      },
    });
    await select;
    const overview = chatPage.locator('.work-center-work-item-overview');
    const result = overview.locator('.work-center-responses');
    const progress = overview.locator('.work-center-goal-progress');
    await expect(chatPage.locator('.work-center-header h1')).toHaveText(OPEN_ITEM_DETAIL.title);
    await expect(chatPage.locator('#work-item-info-tab-requirement')).toHaveAttribute('aria-selected', 'true');
    await expect(result).not.toBeVisible();
    await chatPage.locator('#work-item-info-tab-outputs').click();
    await expect(result).toContainText('The answer is supported by logs.');
    await expect(result).toContainText('Reproduction confirmed');
    await expect(result).toContainText('Source Action unavailable');
    expect(await chatPage.evaluate(() => window.untrustedResponse)).toBeUndefined();
    await result.locator('summary').focus();
    await chatPage.keyboard.press('Enter');
    await expectVisibleFocus(result.locator('summary'));
    await expect(result.locator('details')).toHaveAttribute('open', '');
    await chatPage.locator('#work-item-info-tab-goals').click();
    await expect(progress).toContainText('All criteria verified');
    await chatPage.locator('.work-center-goal-criteria summary').click();
    await chatPage.locator('.work-center-goal-delivery summary').click();
    for (const [theme, locale] of [['light', 'en'], ['light', 'zh-CN'], ['dark', 'en'], ['dark', 'zh-CN']]) {
      await chatPage.evaluate(async ({ theme, locale }) => {
        document.documentElement.setAttribute('data-theme', theme);
        window.Pinia.useChatStore().changeLocale(locale);
      }, { theme, locale });
      await expect(result.locator('h3')).toHaveText(locale === 'zh-CN' ? '交付回复' : 'Delivered response');
      await expect(chatPage.locator('#work-item-info-tab-requirement')).toHaveText(locale === 'zh-CN' ? '需求' : 'Requirement');
      await expect(chatPage.locator('#work-item-info-tab-usage')).toHaveText(locale === 'zh-CN' ? '用量' : 'Usage');
      await expect(chatPage.locator('.work-center-goal-count')).toContainText(locale === 'zh-CN' ? '1 / 1 项验收条件已验证' : '1 / 1 criteria verified');
      await expect(chatPage.locator('.work-center-goal-delivery')).toContainText(locale === 'zh-CN' ? '回复' : 'Response');
      for (const width of [1280, 320]) {
        await chatPage.setViewportSize({ width, height: 720 });
        if (width === 320 && await chatPage.getByRole('button', { name: /Close Actions|关闭 Action/ }).isVisible()) {
          await chatPage.getByRole('button', { name: /Close Actions|关闭 Action/ }).click();
        }
        for (const tab of ['requirement', 'progress', 'outputs', 'goals', 'usage']) {
          await chatPage.locator(`#work-item-info-tab-${tab}`).click();
          await expectNoHorizontalOverflow(overview, { overview: ':scope', panel: `#work-item-info-panel-${tab}` });
          await expect(chatPage.locator('.work-center-conversation-composer')).toBeInViewport();
        }
        const colors = await result.evaluate(element => ({
          text: getComputedStyle(element).color,
          background: getComputedStyle(document.querySelector('.work-center-main')).backgroundColor,
        }));
        expect(colors.text).not.toBe(colors.background);
        expect(await chatPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }
  });

  test('uploads files and binds their references to the Work Item create request', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.locator('.work-center-header-create').click();
    const requirement = chatPage.locator('.work-center-modal').getByRole('textbox', { name: /Requirement/ });
    await requirement.fill('Inspect the uploaded screenshot in every Action');

    const upload = chatPage.waitForResponse(response => response.url().includes('/api/upload') && response.request().method() === 'POST');
    await chatPage.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('fake-image'),
    });
    await upload;
    await expect(chatPage.locator('.work-center-attachment-chip')).toContainText('screen.png');

    const pastedUpload = chatPage.waitForResponse(response => response.url().includes('/api/upload') && response.request().method() === 'POST');
    const pasteResult = await requirement.evaluate(element => {
      const image = new File(['pasted-image'], '', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(image);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented };
    });
    expect(pasteResult.prevented).toBe(true);
    await pastedUpload;
    await expect(chatPage.locator('.work-center-attachment-chip')).toHaveCount(2);
    await expect(chatPage.locator('.work-center-attachment-chip').nth(1)).toContainText(/pasted-image-\d+-1\.png/);

    const mixedUpload = chatPage.waitForResponse(response => response.url().includes('/api/upload') && response.request().method() === 'POST');
    const mixedPasteResult = await requirement.evaluate(element => {
      const image = new File(['mixed-image'], 'mixed.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.setData('text/plain', ' keep this text');
      data.items.add(image);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented, text: data.getData('text/plain') };
    });
    expect(mixedPasteResult).toEqual({ prevented: false, text: ' keep this text' });
    await mixedUpload;
    await expect(chatPage.locator('.work-center-attachment-chip')).toHaveCount(3);

    const createRequest = respondToWorkCenterOp(mockAgent, 'create', {
      ...OPEN_ITEM_DETAIL,
      attachments: [{ id: 'attachment-1', name: 'screen.png', mimeType: 'image/png', size: 10, isImage: true }],
    });
    await chatPage.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    expect(request.payload.attachments).toEqual([
      expect.objectContaining({ fileId: expect.any(String), name: 'screen.png', mimeType: 'image/png', size: 10 }),
      expect.objectContaining({ fileId: expect.any(String), name: expect.stringMatching(/^pasted-image-\d+-1\.png$/), mimeType: 'image/png' }),
      expect.objectContaining({ fileId: expect.any(String), name: 'mixed.png', mimeType: 'image/png' }),
    ]);
  });

  test('keeps Info above an independent Conversation and preserves drafts across tabs', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1600, height: 720 });
    const select = chatPage.locator('.work-center-card').click();
    const longDetail = {
      ...OPEN_ITEM_DETAIL,
      requirement: `Original request ${'r'.repeat(7900)}`,
      goal: `Refined goal ${'g'.repeat(7900)}`,
      acceptanceCriteria: Array.from(
        { length: 30 },
        (_, index) => `Criterion ${index + 1}: ${'c'.repeat(1900)}`,
      ),
      messages: [{
        id: 'long-triage-message', role: 'assistant', status: 'completed',
        text: 'Conversation stays reachable.', createdAt: Date.now(), updatedAt: Date.now(),
      }],
    };
    await respondToWorkCenterOp(mockAgent, 'get', longDetail);
    await select;

    const detail = chatPage.locator('.work-center-detail');
    const stream = detail.locator('.work-center-conversation-scroll');
    const overview = detail.locator('.work-center-work-item-overview');
    const messageList = detail.locator('.work-center-item-message-list');
    const composer = detail.locator('.work-center-conversation-composer');
    await expect(overview).toBeVisible();
    await expect(stream).toBeVisible();
    await expect(messageList).toBeInViewport();
    await expect(composer.locator('textarea')).toBeInViewport();
    await expect(chatPage.locator('#work-item-info-panel-requirement')).toContainText('Original request');
    await composer.locator('textarea').fill('Keep this conversation draft');
    await chatPage.locator('#work-item-info-tab-requirement').focus();
    await chatPage.keyboard.press('ArrowRight');
    await expect(chatPage.locator('#work-item-info-tab-progress')).toBeFocused();
    await expect(chatPage.locator('#work-item-info-tab-progress')).toHaveAttribute('aria-selected', 'true');
    await chatPage.keyboard.press('End');
    await expect(chatPage.locator('#work-item-info-tab-usage')).toBeFocused();
    await chatPage.keyboard.press('Home');
    await expect(chatPage.locator('#work-item-info-tab-requirement')).toBeFocused();
    for (const width of [1600, 320]) {
      await chatPage.setViewportSize({ width, height: 720 });
      if (width === 320 && await chatPage.getByRole('button', { name: 'Close Actions' }).isVisible()) {
        await chatPage.getByRole('button', { name: 'Close Actions' }).click();
      }
      for (const tab of ['requirement', 'progress', 'outputs', 'goals', 'usage']) {
        await chatPage.locator(`#work-item-info-tab-${tab}`).click();
        await expect(chatPage.getByRole('tabpanel')).toHaveCount(1);
        await expect(composer.locator('textarea')).toHaveValue('Keep this conversation draft');
        await expect(composer.locator('textarea')).toBeInViewport();
        const metrics = await detail.evaluate(element => {
          const overview = element.querySelector('.work-center-work-item-overview');
          const conversation = element.querySelector('.work-center-conversation');
          const stream = element.querySelector('.work-center-conversation-scroll');
          return {
            separate: !stream.contains(overview),
            infoBottom: overview.getBoundingClientRect().bottom,
            conversationTop: conversation.getBoundingClientRect().top,
            infoHeight: overview.getBoundingClientRect().height,
            height: element.getBoundingClientRect().height,
          };
        });
        expect(metrics.separate).toBe(true);
        expect(metrics.infoBottom).toBeLessThanOrEqual(metrics.conversationTop + 1);
        expect(metrics.infoHeight).toBeLessThan(metrics.height * 0.5);
      }
    }
    await chatPage.locator('#work-item-info-tab-requirement').click();
    const panel = chatPage.locator('#work-item-info-panel-requirement');
    expect(await panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await panel.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(messageList).toBeInViewport();
    // A refreshed detail must not reset the selected tab or conversation draft.
    await chatPage.locator('#work-item-info-tab-goals').click();
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      store.workCenterDetailByAgent[agentId] = {
        ...store.workCenterDetailByAgent[agentId], title: 'Concise generated title', updatedAt: Date.now(),
      };
    }, mockAgent.agentId);
    await expect(chatPage.locator('#work-item-info-tab-goals')).toHaveAttribute('aria-selected', 'true');
    await expect(composer.locator('textarea')).toHaveValue('Keep this conversation draft');
    await expect(chatPage.locator('.work-center-header h1')).toHaveText('Concise generated title');
    await chatPage.locator('#work-item-info-tab-requirement').click();
    await expect(panel).toContainText(longDetail.requirement);
  });

  test('keeps long Work Item messages fully visible without horizontal clipping', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 1400, height: 900 });
    const select = chatPage.locator('.work-center-card').click();
    const longMessage = `unbroken-${'x'.repeat(1200)}`;
    const longUserMessage = `回归执行发现一个必须在评审前修复的代码级门禁：${'Sandbox 测试文件必须纳入受审测试清单并保持预算策略明确。'.repeat(12)}`;
    const longAttachmentName = `attachment-${'x'.repeat(1800)}.txt`;
    await respondToWorkCenterOp(mockAgent, 'get', {
      ...OPEN_ITEM_DETAIL,
      messages: [
        ...(OPEN_ITEM_DETAIL.messages || []),
        {
          id: 'user-overflow-probe',
          role: 'user',
          text: longUserMessage,
          status: 'completed',
          createdAt: Date.now() - 1,
          updatedAt: Date.now() - 1,
        },
        {
          id: 'overflow-probe',
          role: 'assistant',
          text: longMessage,
          status: 'completed',
          attachments: [{ id: 'probe', name: longAttachmentName, size: 12 }],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    await select;

    const conversation = chatPage.locator('.work-center-conversation');
    const userMessage = conversation.locator('.work-center-item-message-list .role-user');
    await expect(userMessage).toContainText(longUserMessage);
    await expect(userMessage.locator('.message-content')).toHaveText(longUserMessage);
    const sharedComposer = conversation.locator('[data-message-composer]');
    await expect(sharedComposer).toHaveCount(1);
    await expect(sharedComposer.locator('textarea')).toHaveAttribute('rows', '2');
    await expect(sharedComposer.locator('.chat-composer-actions')).toBeVisible();
    const upload = chatPage.waitForResponse(response => (
      response.url().includes('/api/upload') && response.request().method() === 'POST'
    ));
    await conversation.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'work-item-screen.png', mimeType: 'image/png', buffer: Buffer.from('work-item-image'),
    });
    await upload;
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('work-item-screen.png');
    await expect(conversation.locator('textarea')).toHaveValue('');

    const pastedUpload = chatPage.waitForResponse(response => (
      response.url().includes('/api/upload') && response.request().method() === 'POST'
    ));
    const pasteResult = await conversation.locator('textarea').evaluate(element => {
      const image = new File(['pasted-message-image'], '', { type: 'image/png' });
      const data = new DataTransfer();
      data.setData('text/plain', ' keep this message text');
      data.items.add(image);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      element.dispatchEvent(event);
      return { prevented: event.defaultPrevented };
    });
    expect(pasteResult.prevented).toBe(false);
    await pastedUpload;
    await expect(conversation.locator('.work-center-message-draft-attachments .work-center-attachment-chip')).toHaveCount(2);
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText(/pasted-image-\d+-1\.png/);

    const messageResponse = respondToWorkCenterOp(mockAgent, 'post_work_item_message', {
      accepted: true,
      turnId: 'attachment-only-turn',
    });
    await conversation.getByRole('button', { name: 'Send to Coordinator' }).click();
    const messageRequest = await messageResponse;
    expect(messageRequest.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'coordinator' },
      text: '',
      revision: 1,
      planRevision: 2,
      ledgerRevision: 4,
      coordinatorRevision: 0,
      attachments: [
        expect.objectContaining({
          fileId: expect.any(String),
          name: 'work-item-screen.png',
          mimeType: 'image/png',
          size: 15,
        }),
        expect.objectContaining({
          fileId: expect.any(String),
          name: expect.stringMatching(/^pasted-image-\d+-1\.png$/),
          mimeType: 'image/png',
        }),
      ],
    });
    await expect(conversation.locator('.work-center-message-draft-attachments')).toHaveCount(0);

    await ensureActionsOpen(chatPage);
    for (const { width, theme } of [
      { width: 1400, theme: 'light' },
      { width: 1400, theme: 'dark' },
      { width: 1024, theme: 'light' },
      { width: 1024, theme: 'dark' },
      { width: 961, theme: 'light' },
      { width: 961, theme: 'dark' },
      { width: 430, theme: 'light' },
      { width: 430, theme: 'dark' },
    ]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      if (width <= 1024 && await chatPage.locator('.work-center-content-pane').count()) {
        await chatPage.getByRole('button', { name: 'Close Actions' }).click();
      } else if (width > 1024 && await chatPage.locator('.work-center-content-pane').count() === 0) {
        await ensureActionsOpen(chatPage);
      }
      await conversation.locator('textarea').fill('First line\nSecond line\nThird line');
      await chatPage.waitForTimeout(250);

      const metrics = await chatPage.locator('.work-center-detail').evaluate(detail => {
        const layout = detail.querySelector('.work-center-detail-layout');
        const workflow = detail.querySelector('.work-center-workflow');
        const main = detail.querySelector('.work-center-detail-main');
        const conversation = detail.querySelector('.work-center-conversation');
        const messageList = detail.querySelector('.work-center-item-message-list');
        const userArticle = messageList.querySelector('.role-user');
        const userText = userArticle.querySelector('.message-content');
        const overflowArticle = messageList.lastElementChild;
        const renderedAttachmentList = overflowArticle.querySelector('.work-center-message-attachments');
        const renderedAttachmentChip = renderedAttachmentList.querySelector('.work-center-attachment-chip');
        const composer = detail.querySelector('[data-message-composer]');
        const composerActions = composer.querySelector('.chat-composer-actions');
        const textarea = composer.querySelector('textarea');
        const header = document.querySelector('.work-center-header');
        const breadcrumb = header.querySelector('.work-center-breadcrumb-button');
        const actionsButton = header.querySelector('.work-center-actions-button');
        const card = detail.querySelector('.work-center-action-card');
        const content = card?.querySelector('.work-center-action-content');
        const streamColumn = detail.querySelector('.work-center-conversation-column');
        const composerColumn = detail.querySelector('.work-center-composer-column');
        const detailRect = detail.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const mainVisibleRight = mainRect.left + main.clientLeft + main.clientWidth;
        const userArticleRect = userArticle.getBoundingClientRect();
        const userTextRange = document.createRange();
        userTextRange.selectNodeContents(userText);
        const userTextContentRect = userTextRange.getBoundingClientRect();
        const userLastCharacterRange = document.createRange();
        userLastCharacterRange.setStart(userText.firstChild, userText.firstChild.length - 1);
        userLastCharacterRange.setEnd(userText.firstChild, userText.firstChild.length);
        const userLastCharacterRect = userLastCharacterRange.getBoundingClientRect();
        const breadcrumbRect = breadcrumb.getBoundingClientRect();
        const actionsButtonRect = actionsButton.getBoundingClientRect();
        const streamColumnRect = streamColumn.getBoundingClientRect();
        const composerColumnRect = composerColumn.getBoundingClientRect();
        const lineRects = [...(content?.children || [])].map(element => element.getBoundingClientRect());
        const themeProbe = document.createElement('div');
        themeProbe.style.background = 'var(--session-active)';
        document.body.append(themeProbe);
        const sessionActiveBackground = getComputedStyle(themeProbe).backgroundColor;
        themeProbe.remove();
        return {
          layoutDisplay: getComputedStyle(layout).display,
          workflowWidth: workflow?.getBoundingClientRect().width ?? 0,
          cardHeight: card?.getBoundingClientRect().height ?? 0,
          lineCount: lineRects.length,
          distinctLineTops: new Set(lineRects.map(rect => Math.round(rect.top))).size,
          breadcrumbTop: Math.round(breadcrumbRect.top - header.getBoundingClientRect().top),
          actionsRight: Math.round(mainRect.right - actionsButtonRect.right),
          streamColumnLeft: streamColumnRect.left,
          streamColumnRight: streamColumnRect.right,
          composerColumnLeft: composerColumnRect.left,
          composerColumnRight: composerColumnRect.right,
          detailScrollWidth: detail.scrollWidth,
          detailClientWidth: detail.clientWidth,
          mainScrollWidth: main.scrollWidth,
          mainClientWidth: main.clientWidth,
          mainVisibleLeft: mainRect.left + main.clientLeft,
          mainVisibleRight,
          conversationScrollWidth: conversation.scrollWidth,
          conversationClientWidth: conversation.clientWidth,
          messageListScrollWidth: messageList.scrollWidth,
          messageListClientWidth: messageList.clientWidth,
          userArticleLeft: userArticleRect.left,
          userArticleRight: userArticleRect.right,
          userTextContentLeft: userTextContentRect.left,
          userTextContentRight: userTextContentRect.right,
          userLastCharacterLeft: userLastCharacterRect.left,
          userLastCharacterRight: userLastCharacterRect.right,
          mainOverflowX: getComputedStyle(main).overflowX,
          articleScrollWidth: overflowArticle.scrollWidth,
          articleClientWidth: overflowArticle.clientWidth,
          attachmentListScrollWidth: renderedAttachmentList.scrollWidth,
          attachmentListClientWidth: renderedAttachmentList.clientWidth,
          attachmentChipScrollWidth: renderedAttachmentChip.scrollWidth,
          attachmentChipClientWidth: renderedAttachmentChip.clientWidth,
          composerScrollWidth: composer.scrollWidth,
          composerClientWidth: composer.clientWidth,
          composerActionBelowTextarea: composerActions.getBoundingClientRect().top >= textarea.getBoundingClientRect().bottom,
          composerTextareaHeight: textarea.getBoundingClientRect().height,
          composerTextareaLineHeight: Number.parseFloat(getComputedStyle(textarea).lineHeight),
          composerTextareaOverflowY: getComputedStyle(textarea).overflowY,
          composerTextareaRows: textarea.rows,
          composerTextareaClientHeight: textarea.clientHeight,
          composerTextareaScrollHeight: textarea.scrollHeight,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
          workflowBackground: workflow ? getComputedStyle(workflow).backgroundColor : null,
          detailBackground: getComputedStyle(detail).backgroundColor,
          mainBackground: getComputedStyle(main).backgroundColor,
          cardBackground: card ? getComputedStyle(card).backgroundColor : null,
          sessionActiveBackground,
          cardActive: card?.classList.contains('active') ?? false,
          composerPaddingBottom: Number.parseFloat(getComputedStyle(
            detail.querySelector('.work-center-conversation-composer'),
          ).paddingBottom),
        };
      });

      if (width > 1024) {
        expect(metrics.lineCount).toBe(4);
        expect(metrics.distinctLineTops).toBeGreaterThanOrEqual(1);
        // The fourth compact row contains creation time and runtime.
        expect(metrics.cardHeight).toBeLessThanOrEqual(91);
      } else {
        expect(metrics.lineCount).toBe(0);
        expect(metrics.cardHeight).toBe(0);
      }
      expect(metrics.detailScrollWidth).toBeLessThanOrEqual(metrics.detailClientWidth + 1);
      expect(metrics.mainScrollWidth).toBeLessThanOrEqual(metrics.mainClientWidth + 1);
      expect(metrics.conversationScrollWidth).toBeLessThanOrEqual(metrics.conversationClientWidth + 1);
      expect(metrics.messageListScrollWidth).toBeLessThanOrEqual(metrics.messageListClientWidth + 1);
      expect(metrics.userArticleLeft).toBeGreaterThanOrEqual(metrics.mainVisibleLeft - 1);
      expect(metrics.userArticleRight).toBeLessThanOrEqual(metrics.mainVisibleRight + 1);
      expect(metrics.userTextContentLeft).toBeGreaterThanOrEqual(metrics.mainVisibleLeft - 1);
      expect(metrics.userTextContentRight).toBeLessThanOrEqual(metrics.mainVisibleRight + 1);
      expect(metrics.userLastCharacterLeft).toBeGreaterThanOrEqual(metrics.mainVisibleLeft - 1);
      expect(metrics.userLastCharacterRight).toBeLessThanOrEqual(metrics.mainVisibleRight + 1);
      expect(metrics.mainOverflowX).toBe('hidden');
      expect(metrics.articleScrollWidth).toBeLessThanOrEqual(metrics.articleClientWidth + 1);
      expect(metrics.attachmentListScrollWidth).toBeLessThanOrEqual(metrics.attachmentListClientWidth + 1);
      expect(metrics.attachmentChipScrollWidth).toBeLessThanOrEqual(metrics.attachmentChipClientWidth + 1);
      expect(metrics.composerScrollWidth).toBeLessThanOrEqual(metrics.composerClientWidth + 1);
      expect(Math.abs(metrics.streamColumnLeft - metrics.composerColumnLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(metrics.streamColumnRight - metrics.composerColumnRight)).toBeLessThanOrEqual(1);
      expect(metrics.composerActionBelowTextarea).toBe(true);
      expect(metrics.composerPaddingBottom).toBeGreaterThanOrEqual(14);
      expect(metrics.composerTextareaRows).toBe(2);
      expect(metrics.composerTextareaHeight).toBe(width === 430
        ? metrics.composerTextareaLineHeight * 2
        : metrics.composerTextareaLineHeight * 3);
      expect(metrics.composerTextareaOverflowY).toBe(width === 430 ? 'auto' : 'hidden');
      if (width === 430) {
        expect(metrics.composerTextareaScrollHeight).toBeGreaterThan(metrics.composerTextareaClientHeight);
      } else {
        expect(metrics.composerTextareaScrollHeight).toBe(metrics.composerTextareaClientHeight);
      }
      expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
      if (width > 1024) {
        expect(metrics.workflowBackground).toBe(metrics.detailBackground);
        expect(metrics.cardActive).toBe(false);
        expect(metrics.cardBackground).not.toBe(metrics.sessionActiveBackground);
      } else {
        expect(metrics.workflowBackground).toBeNull();
      }
      expect(metrics.mainBackground).toBe('rgba(0, 0, 0, 0)');
      expect(metrics.layoutDisplay).toBe('flex');
      expect(metrics.breadcrumbTop).toBeGreaterThanOrEqual(4);
      expect(metrics.actionsRight).toBe(8);
      if (width === 1400) {
        expect(metrics.workflowWidth).toBeGreaterThanOrEqual(380);
        expect(metrics.workflowWidth).toBeLessThanOrEqual(420);
      } else {
        expect(metrics.workflowWidth).toBe(0);
      }
    }

    const responsiveDraft = Array.from({ length: 28 }, () => 'draft').join(' ');
    const responsiveTextarea = conversation.locator('textarea');
    await chatPage.setViewportSize({ width: 430, height: 900 });
    await responsiveTextarea.fill(responsiveDraft);
    await expect.poll(() => responsiveTextarea.evaluate(element => ({
      visibleHeight: element.getBoundingClientRect().height,
      inlineHeight: Number.parseFloat(element.style.height),
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))).toMatchObject({ visibleHeight: 48, overflowY: 'auto' });
    const mobileDraftMetrics = await responsiveTextarea.evaluate(element => ({
      inlineHeight: Number.parseFloat(element.style.height),
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(mobileDraftMetrics.inlineHeight).toBeGreaterThan(48);
    expect(mobileDraftMetrics.scrollHeight).toBeGreaterThan(mobileDraftMetrics.clientHeight);

    await chatPage.setViewportSize({ width: 1400, height: 900 });
    await expect(responsiveTextarea).toHaveValue(responsiveDraft);
    await expect.poll(() => responsiveTextarea.evaluate(element => {
      const inlineHeight = Number.parseFloat(element.style.height);
      const targetHeight = Math.min(element.scrollHeight, 120);
      return getComputedStyle(element).overflowY === 'hidden'
        && Math.abs(inlineHeight - targetHeight) <= 1;
    })).toBe(true);
    const desktopDraftMetrics = await responsiveTextarea.evaluate(element => ({
      visibleHeight: element.getBoundingClientRect().height,
      inlineHeight: Number.parseFloat(element.style.height),
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(desktopDraftMetrics.inlineHeight).toBe(Math.min(desktopDraftMetrics.scrollHeight, 120));
    expect(desktopDraftMetrics.visibleHeight).toBe(desktopDraftMetrics.clientHeight);
    expect(desktopDraftMetrics.visibleHeight).toBeLessThanOrEqual(120);
    expect(desktopDraftMetrics.overflowY).toBe('hidden');

    await chatPage.setViewportSize({ width: 430, height: 900 });
    await expect(responsiveTextarea).toHaveValue(responsiveDraft);
    await expect.poll(() => responsiveTextarea.evaluate(element => ({
      visibleHeight: element.getBoundingClientRect().height,
      overflowY: getComputedStyle(element).overflowY,
      scrolls: element.scrollHeight > element.clientHeight,
    }))).toEqual({ visibleHeight: 48, overflowY: 'auto', scrolls: true });

    for (const { width, theme } of [
      { width: 1920, theme: 'light' },
      { width: 1920, theme: 'dark' },
      { width: 1200, theme: 'light' },
      { width: 1200, theme: 'dark' },
    ]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);
      await chatPage.waitForTimeout(250);
      await expectNoHorizontalOverflow(chatPage.locator('.work-center-detail'), {
        detail: ':scope',
        main: '.work-center-detail-main',
        conversation: '.work-center-conversation',
        messageList: '.work-center-item-message-list',
        message: '.work-center-item-message-list > :last-child',
        attachmentList: '.work-center-item-message-list > :last-child .work-center-message-attachments',
        attachmentChip: '.work-center-item-message-list > :last-child .work-center-attachment-chip',
        composer: '[data-message-composer]',
      });
    }
  });

  test('keeps the single Conversation attachment draft while viewing Content and sends it to the selected Action', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, [FAILED_ITEM]);
    const select = chatPage.locator('.work-center-card').click();
    await respondToWorkCenterOp(mockAgent, 'get', FAILED_ITEM_DETAIL, [FAILED_ITEM]);
    await select;
    await chatPage.setViewportSize({ width: 430, height: 900 });

    const conversation = chatPage.locator('.work-center-conversation');
    const composer = conversation.locator('textarea');
    await chatPage.getByRole('button', { name: 'Close Actions', exact: true }).click();
    await composer.fill('Retry with the attached evidence');
    const upload = chatPage.waitForResponse(response => response.url().includes('/api/upload') && response.request().method() === 'POST');
    await conversation.locator('.work-center-attachment-picker input').setInputFiles({
      name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('follow up'),
    });
    await upload;
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('follow-up.txt');

    await ensureActionsOpen(chatPage);
    await chatPage.locator('.work-center-action-summary').click();
    const actionDetail = chatPage.locator('.work-center-action-detail-pane');
    await expect(actionDetail.locator('textarea')).toHaveCount(0);
    await chatPage.getByRole('button', { name: 'Close Actions' }).click();

    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue('Retry with the attached evidence');
    await expect(conversation.locator('.work-center-message-draft-attachments')).toContainText('follow-up.txt');
    const target = chatPage.getByTestId('work-center-composer-target');
    await chooseWorkCenterTarget(chatPage, target, 'Send to Action 1');
    await expectWorkCenterTarget(target, 'action:action-1:1', 'Send to Action 1');

    const inputRequests = (async () => {
      const operations = [];
      while (!operations.some(request => request.op === 'post_work_item_message')
        || !operations.some(request => request.op === 'list')) {
        operations.push(await respondByOperation(mockAgent, {
          post_work_item_message: FAILED_ITEM_DETAIL,
          list: { items: [FAILED_ITEM], watcher: { enabled: true } },
          get: FAILED_ITEM_DETAIL,
        }));
      }
      return operations;
    })();
    await conversation.getByRole('button', { name: /Send to/ }).click();
    const requests = await inputRequests;
    const request = requests.find(candidate => candidate.op === 'post_work_item_message');
    expect(request.payload).toMatchObject({
      id: OPEN_ITEM.id,
      target: { kind: 'action', actionId: 'action-1', generation: 1 },
      revision: 1,
      text: 'Retry with the attached evidence',
      attachments: [expect.objectContaining({
        fileId: expect.any(String), name: 'follow-up.txt', mimeType: 'text/plain', size: 9,
      })],
    });
  });

  test('keeps the empty board aligned across desktop, mobile, light, and dark layouts', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, []);
    await chatPage.evaluate(agentId => {
      const store = window.Pinia.useChatStore();
      store.workCenterItemsByAgent[agentId] = [];
      store.workCenterLoadedByAgent[agentId] = true;
      store.workCenterLoadingByAgent[agentId] = false;
    }, mockAgent.agentId);

    for (const { width, theme } of [
      { width: 1400, theme: 'light' },
      { width: 1400, theme: 'dark' },
      { width: 430, theme: 'light' },
      { width: 430, theme: 'dark' },
    ]) {
      await chatPage.setViewportSize({ width, height: 900 });
      await chatPage.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        localStorage.setItem('theme', value);
      }, theme);

      const emptyState = chatPage.locator('.work-center-empty-state');
      await expect(emptyState).toBeVisible();
      await expect(chatPage.locator('.work-center-board-empty')).toHaveCount(0);
      const metrics = await chatPage.evaluate(() => {
        const rect = element => element.getBoundingClientRect();
        const board = document.querySelector('.work-center-board');
        const body = document.querySelector('.work-center-body');
        const empty = document.querySelector('.work-center-empty-state');
        const boardRect = rect(board);
        const emptyRect = rect(empty);
        const laneRects = [...document.querySelectorAll('.work-center-board-lane')]
          .map(rect)
          .filter(laneRect => laneRect.width > 0 && laneRect.height > 0);
        return {
          boardDisplay: getComputedStyle(board).display,
          bodyBorderWidth: getComputedStyle(body).borderTopWidth,
          bodyBorderRadius: getComputedStyle(body).borderTopLeftRadius,
          visibleLaneCount: laneRects.length,
          laneWidths: laneRects.map(laneRect => laneRect.width),
          firstLaneLeft: laneRects[0]?.left || 0,
          lastLaneRight: laneRects.at(-1)?.right || 0,
          boardLeft: boardRect.left,
          boardRight: boardRect.right,
          boardCenter: boardRect.left + boardRect.width / 2,
          emptyCenter: emptyRect.left + emptyRect.width / 2,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentClientWidth: document.documentElement.clientWidth,
        };
      });

      expect(metrics.bodyBorderWidth).toBe('0px');
      expect(metrics.bodyBorderRadius).toBe('0px');
      expect(Math.abs(metrics.emptyCenter - metrics.boardCenter)).toBeLessThanOrEqual(1);
      expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
      if (width === 1400) {
        expect(metrics.boardDisplay).toBe('grid');
        expect(metrics.visibleLaneCount).toBe(3);
        expect(Math.max(...metrics.laneWidths) - Math.min(...metrics.laneWidths)).toBeLessThanOrEqual(1);
        expect(Math.min(...metrics.laneWidths)).toBeGreaterThan(200);
        expect(metrics.firstLaneLeft - metrics.boardLeft).toBeGreaterThanOrEqual(9);
        expect(metrics.boardRight - metrics.lastLaneRight).toBeGreaterThanOrEqual(9);
      } else {
        expect(metrics.boardDisplay).toBe('flex');
        expect(metrics.visibleLaneCount).toBe(1);
      }
    }

    await chatPage.getByRole('button', { name: 'Create first work item' }).click();
    await expect(chatPage.locator('.work-center-modal')).toBeVisible();
  });

  test('uses mobile board lane tabs and lane-specific empty states', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await chatPage.setViewportSize({ width: 720, height: 780 });

    await chatPage.getByRole('tab', { name: /Closed/ }).click();
    const closedLane = chatPage.locator('.work-center-board-lane[data-lane="closed"]');
    await expect(closedLane).toBeVisible();
    await expect(closedLane.locator('.work-center-card')).toHaveCount(0);

    await chatPage.getByRole('tab', { name: /Active/ }).click();
    const activeLane = chatPage.locator('.work-center-board-lane[data-lane="active"]');
    await expect(activeLane).toBeVisible();
    await expect(activeLane.locator('.work-center-card')).toHaveCount(1);
  });
});

function resourceStoppedDetail() {
  const usage = { llmRequestCount: 200, totalTokens: 1750, chargedTokens: 18134, reservedTokens: 16384, unknownRequests: 1, inFlightRequests: 1 };
  return {
    ...OPEN_ITEM_DETAIL, status: 'needs_attention', boardLane: 'needs_attention',
    executionControl: {
      revision: 7,
      limits: { maxRequests: 200, maxTokens: 2000000, maxRunRequests: 40, maxActionAttempts: 3, maxCoordinatorFailures: 3 },
      usage, coordinatorFailures: 1,
      breakdown: {
        coordinator: { ...usage, llmRequestCount: 20 },
        actions: { ...usage, llmRequestCount: 180 },
      },
      actionAttempts: [{ actionId: `action-${'long-id-'.repeat(60)}`, attempts: 2, effectiveMaxAttempts: 3 }],
      stopReason: { code: 'work_item_requests_exhausted' },
    },
  };
}

async function openResourceDetail(chatPage, mockAgent) {
  const detail = resourceStoppedDetail();
  await openWorkCenter(chatPage, mockAgent, [detail]);
  const select = chatPage.locator('.work-center-card-open').click();
  await respondToWorkCenterOp(mockAgent, 'get', detail, [detail]);
  await select;
  await expect(chatPage.locator('.work-center-info-resource-alert')).toBeVisible();
  await chatPage.locator('.work-center-info-resource-alert').click();
  await expect(chatPage.locator('.work-center-resources')).toBeVisible();
  return detail;
}

test.describe('Work Center resource budget', () => {
  test('extends explicitly and resumes with latest CAS; refreshes conflicts without replay', async ({ chatPage, mockAgent }) => {
    const detail = await openResourceDetail(chatPage, mockAgent);
    const panel = chatPage.locator('.work-center-resources');
    const transport = mockAgent.__workCenterTransport;
    await expect(panel).toContainText('200 / 200');
    await expect(panel).toContainText('Stopped: lifetime request budget exhausted.');
    await expect(panel).toHaveClass(/work-center-resources-priority/);
    const stoppedStyle = await panel.evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, borderLeftWidth: style.borderLeftWidth };
    });
    expect(stoppedStyle.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(stoppedStyle.borderLeftWidth).toBe('3px');
    await panel.getByRole('button', { name: 'Extend budget', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Confirm budget addition' })).toBeDisabled();
    await panel.locator('[name="maxRequests"]').fill('9007199254740992');
    await expect(panel.getByRole('alert')).toContainText('positive safe integers');
    await expect(panel.getByRole('button', { name: 'Confirm budget addition' })).toBeDisabled();
    for (const key of Object.keys(detail.executionControl.limits)) await panel.locator(`[name="${key}"]`).fill('2');
    await panel.getByRole('button', { name: 'Confirm budget addition' }).click();
    const extension = await transport.next();
    expect(extension.op).toBe('extend_budget');
    expect(extension.agentId).toBe(mockAgent.agentId);
    expect(extension.payload).toEqual({ id: detail.id, executionControlRevision: 7,
      additions: { maxRequests: 2, maxTokens: 2, maxRunRequests: 2, maxActionAttempts: 2, maxCoordinatorFailures: 2 } });
    await expect(panel).toHaveAttribute('aria-busy', 'true');
    await expect(panel.getByRole('button', { name: 'Resume work item' })).toBeDisabled();
    const extended = structuredClone(detail);
    extended.executionControl.revision = 8;
    for (const key of Object.keys(extended.executionControl.limits)) extended.executionControl.limits[key] += 2;
    await transport.resolve(extension, extended);
    await respondToWorkCenterOp(mockAgent, 'list', { items: [extended], watcher: { enabled: true } });
    await expect(panel).toContainText('Execution was not resumed');
    await expect(panel).toContainText('200 / 202');
    expect(await transport.takeNow()).toBeNull();
    await panel.getByRole('button', { name: 'Resume work item' }).click();
    const resume = await transport.next();
    expect(resume.op).toBe('resume');
    expect(resume.payload).toEqual({ id: detail.id, revision: 1, executionControlRevision: 8 });
    await transport.reject(resume, 'Execution control changed; refresh before changing execution budget or resuming');
    const refresh = await transport.next();
    expect(refresh.op).toBe('get');
    expect(refresh.payload).toEqual({ id: detail.id });
    const latest = structuredClone(extended);
    latest.revision = 2;
    latest.executionControl.revision = 10;
    await transport.resolve(refresh, latest);
    await expect(panel.getByRole('alert')).toContainText('Execution control changed');
    await expect(panel).toContainText('confirm a new operation');
    expect(await transport.takeNow()).toBeNull();
    await panel.getByRole('button', { name: 'Resume work item' }).click();
    const explicitResume = await transport.next();
    expect(explicitResume.payload).toEqual({ id: detail.id, revision: 2, executionControlRevision: 10 });
    const resumed = { ...latest, status: 'running', boardLane: 'active',
      executionControl: { ...latest.executionControl, revision: 11, stopReason: null } };
    await transport.resolve(explicitResume, resumed);
    await respondToWorkCenterOp(mockAgent, 'list', { items: [resumed], watcher: { enabled: true } });
    await expect(panel).toContainText('Resume accepted.');
    await expect(panel).not.toHaveClass(/work-center-resources-priority/);
    await expect(panel.getByRole('button', { name: 'Resume work item' })).toHaveCount(0);
  });

  test('resource budget remains readable and keyboard usable in both locales/themes at 320px', async ({ chatPage, mockAgent }) => {
    await openResourceDetail(chatPage, mockAgent);
    const panel = chatPage.locator('.work-center-resources');
    await panel.locator('summary').click();
    await panel.getByRole('button', { name: 'Extend budget', exact: true }).click();
    await expect(panel).toContainText('ALL current and future Actions');
    await expect(panel).toContainText('Reported 1,750 · reserved / unknown 16,384 tokens');
    await expect(panel).toContainText('Unknown usage: 1 requests · in flight: 1');
    for (const locale of ['en', 'zh-CN']) {
      for (const theme of ['light', 'dark']) {
        await chatPage.evaluate(async ({ locale, theme }) => {
          document.documentElement.setAttribute('data-theme', theme);
          window.Pinia.useChatStore().changeLocale(locale);
        }, { locale, theme });
        for (const width of [1280, 320]) {
          await chatPage.setViewportSize({ width, height: 900 });
          if (!await panel.isVisible()) await chatPage.getByRole('button', { name: /Close Actions|关闭 Actions/, exact: true }).click();
          await expectNoHorizontalOverflow(panel, {
            panel: ':scope', totals: '.work-center-resource-totals', breakdown: '.work-center-resource-breakdown',
            form: '.work-center-resource-form', inputs: '.work-center-resource-inputs',
          });
          const metrics = await layoutMetrics(chatPage);
          expect(metrics.documentScrollWidth).toBeLessThanOrEqual(width);
          await expect(panel).not.toContainText('workCenter.resource.');
        }
      }
    }
    await panel.locator('[name="maxRequests"]').focus();
    await expectVisibleFocus(panel.locator('[name="maxRequests"]'));
    await chatPage.keyboard.press('Tab');
    await expect(panel.locator('[name="maxTokens"]')).toBeFocused();
    // Lost connection invalidates editing, including after reconnect, until a user refresh.
    await chatPage.evaluate(() => { window.Pinia.useChatStore().connectionState = 'reconnecting'; });
    await expect(panel.locator('[name="maxRequests"]')).toBeDisabled();
    await chatPage.evaluate(() => { window.Pinia.useChatStore().connectionState = 'connected'; });
    await expect(panel.locator('[name="maxRequests"]')).toBeDisabled();
    await expect(panel).toContainText('请刷新后重新确认');
  });
});

async function openScheduleForm(page, mockAgent, recurring = true) {
  await openWorkCenter(page, mockAgent, []);
  mockAgent.__recurringSchedules = recurring;
  // Hydrate capability through the real settings action/response rather than patching Pinia.
  await page.evaluate(agentId => {
    const store = window.Pinia.useChatStore();
    store.__scheduleSettingsLoaded = false;
    void store.loadWorkCenterSettings(agentId).then(() => { store.__scheduleSettingsLoaded = true; });
  }, mockAgent.agentId);
  // Mount may already have queued a settings read. Resolve both reads with the
  // advertised response; do not mistake the first response for the latest CAS generation.
  for (let index = 0; index < 8; index++) {
    const request = await mockAgent.__workCenterTransport.takeNow();
    if (!request) break;
    const runtime = { ...WORK_CENTER_SETTINGS.runtime, ...(recurring ? { recurringSchedules: true } : {}) };
    const data = request.op === 'get_settings' ? { ...WORK_CENTER_SETTINGS, runtime }
      : request.op === 'get_runtime' ? runtime
      : request.op === 'list' ? { items: [], watcher: { enabled: true } } : null;
    if (data == null) throw new Error(`Unexpected schedule setup op ${request.op}`);
    await mockAgent.__workCenterTransport.resolve(request, data);
  }
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().__scheduleSettingsLoaded)).toBe(true);
  await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().workCenterSettingsLoadingByAgent[agentId], mockAgent.agentId)).toBe(false);
  await page.locator('.work-center-header-create').click();
  const dialog = page.locator('.work-center-modal');
  await dialog.locator('textarea').fill('Check project health and report changes since the previous run.');
  await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
  // Select a future day using the real calendar, including its keyboard path.
  await dialog.locator('.schedule-date-picker__trigger').click();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('Enter');
  await dialog.getByRole('textbox', { name: 'Time · 24-hour', exact: true }).fill('0930');
  await expect(dialog.getByRole('textbox', { name: 'Time · 24-hour', exact: true })).toHaveValue('09:30');
  return dialog;
}

async function takeScheduleCreate(mockAgent) {
  for (let index = 0; index < 8; index++) {
    const request = await mockAgent.__workCenterTransport.next();
    if (request.op === 'create') return request;
    const data = request.op === 'list' ? { items: [] }
      : request.op === 'get_settings' ? { ...WORK_CENTER_SETTINGS, runtime: { ...WORK_CENTER_SETTINGS.runtime, recurringSchedules: mockAgent.__recurringSchedules } }
      : request.op === 'get_runtime' ? { ...WORK_CENTER_SETTINGS.runtime, recurringSchedules: mockAgent.__recurringSchedules } : null;
    if (data == null) throw new Error(`Unexpected scheduling op ${request.op}`);
    await mockAgent.__workCenterTransport.resolve(request, data);
  }
  throw new Error('No create request');
}

async function chooseScheduleOption(page, label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test.describe('Work Center scheduling', () => {
  test('recurring schedule submits wall-time rules and retains errors for retry', async ({ chatPage, mockAgent }) => {
    const dialog = await openScheduleForm(chatPage, mockAgent);
    await chooseScheduleOption(chatPage, 'Repeat', 'Every week');
    await dialog.getByRole('button', { name: 'Wednesday', exact: true }).click();
    await chooseScheduleOption(chatPage, 'Ends', 'After a number of runs');
    await dialog.getByRole('spinbutton', { name: 'Total runs · 1–1,000' }).fill('4');
    await expect(dialog.locator('.work-center-schedule-preview')).toBeVisible();
    const submit = dialog.locator('.work-center-modal-footer .btn-primary');
    await submit.click();
    const request = await takeScheduleCreate(mockAgent);
    expect(request.op).toBe('create');
    expect(request.payload.start).toBe(false);
    expect(request.payload.scheduledFor).toBeGreaterThan(Date.now());
    expect(request.payload.recurrence).toMatchObject({ frequency: 'weekly', time: '09:30', weekdays: [1, 3], maxRuns: 4, endsAt: null });
    expect(request.payload.recurrence.timeZone).toBeTruthy();
    await expect(submit).toBeDisabled();
    await mockAgent.__workCenterTransport.reject(request, 'Schedule could not be saved');
    await expect(dialog.getByRole('alert')).toHaveText('Schedule could not be saved');
    await expect(submit).toBeEnabled();
    await expect(dialog.getByRole('combobox', { name: 'Repeat', exact: true })).toContainText('Every week');
  });

  test('time zone search restores focus and the form tab order', async ({ chatPage, mockAgent }) => {
    const dialog = await openScheduleForm(chatPage, mockAgent);
    const trigger = dialog.getByRole('combobox', { name: 'Time zone', exact: true });
    await trigger.focus();
    await chatPage.keyboard.press('Enter');
    const search = chatPage.locator('.modern-select-search input');
    await expect(search).toBeFocused();
    await search.fill('Asia/Shanghai');
    await chatPage.keyboard.press('Enter');
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('Asia/Shanghai');
    await chatPage.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await chatPage.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await chatPage.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await chatPage.keyboard.press('Tab');
    await expect(dialog.locator('.schedule-date-picker__trigger')).toBeFocused();
    await expect(search).toHaveCount(0);
  });

  test('first schedule opened after a long page stay gets a fresh default', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent, []);
    const later = Date.now() + 3 * 3600000;
    await chatPage.clock.setFixedTime(later);
    await chatPage.locator('.work-center-header-create').click();
    const dialog = chatPage.locator('.work-center-modal');
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(dialog.locator('.work-center-schedule-preview')).toBeVisible();
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await dialog.getByRole('textbox', { name: 'Time · 24-hour', exact: true }).fill('2359');
    await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Time · 24-hour', exact: true })).toHaveValue('23:59');
  });

  test('recurring plan is read-only and pause/resume retain its revision', async ({ chatPage, mockAgent }) => {
    let detail = { ...OPEN_ITEM_DETAIL, id: 'recurring-plan', title: 'Weekly check', status: 'draft', actions: [], currentAction: null, currentActionId: null,
      schedule: { status: 'scheduled', scheduledFor: Date.now() + 3600000, recurrence: { frequency: 'weekly', timeZone: 'Asia/Shanghai', time: '09:00', weekdays: [1] }, runCount: 2, lastWorkItemId: 'latest-run',
        lastError: { code: 'schedule_dispatch_failed', message: 'Do not render raw server diagnostics', at: Date.now() } } };
    await openWorkCenter(chatPage, mockAgent, [detail]);
    const select = chatPage.locator('.work-center-card-open').click();
    await respondToWorkCenterOp(mockAgent, 'get', detail, [detail]);
    await select;
    await expect(chatPage.locator('.work-center-conversation-readonly')).toContainText('This is a schedule');
    await expect(chatPage.locator('.work-center-error[role="status"]')).toContainText('It will retry automatically');
    await expect(chatPage.locator('.work-center-main')).not.toContainText('Do not render raw server diagnostics');
    await expect(chatPage.locator('.work-center-item-message-input')).toHaveCount(0);
    await expect(chatPage.locator('.work-center-header-actions').getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
    for (const enabled of [false, true]) {
      await chatPage.getByRole('button', { name: enabled ? 'Resume schedule' : 'Pause schedule', exact: true }).click();
      const request = await mockAgent.__workCenterTransport.next();
      expect(request.op).toBe('update_schedule');
      expect(request.payload).toEqual({ id: detail.id, schedule: { enabled, revision: detail.revision } });
      detail = { ...detail, revision: detail.revision + 1, schedule: { ...detail.schedule, status: enabled ? 'scheduled' : 'paused', lastError: null } };
      await mockAgent.__workCenterTransport.resolve(request, detail);
      await respondToWorkCenterOp(mockAgent, 'list', { items: [detail], watcher: { enabled: true } });
      await expect(chatPage.getByRole('button', { name: enabled ? 'Pause schedule' : 'Resume schedule', exact: true })).toBeEnabled();
    }
  });

  test('older Agent keeps one-time scheduling and disables repetition', async ({ chatPage, mockAgent }) => {
    const dialog = await openScheduleForm(chatPage, mockAgent, false);
    await expect(dialog.locator('.work-center-field-help', { hasText: 'does not advertise recurring schedules' })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Repeat', exact: true }).click();
    await expect(chatPage.getByRole('option', { name: 'Every day', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await chatPage.keyboard.press('Escape');
    const time = dialog.getByRole('textbox', { name: 'Time · 24-hour', exact: true });
    await time.fill('25:99');
    await expect(dialog.getByRole('status')).toContainText('valid date and time');
    await expect(dialog.getByRole('button', { name: 'Create schedule', exact: true })).toBeDisabled();
    await time.fill('09:30');
    await dialog.getByRole('button', { name: 'Create schedule', exact: true }).click();
    const request = await takeScheduleCreate(mockAgent);
    expect(request.op).toBe('create');
    expect(request.payload.recurrence).toBeNull();
    expect(request.payload.start).toBe(false);
    expect(request.payload.scheduledFor).toBeGreaterThan(Date.now());
    await mockAgent.__workCenterTransport.reject(request, 'Test completed');
  });

  test('calendar follows themes, narrow layout, locale and keyboard without native popups', async ({ chatPage, mockAgent }, testInfo) => {
    const errors = [];
    chatPage.on('pageerror', error => errors.push(error.message));
    const dialog = await openScheduleForm(chatPage, mockAgent);
    await chooseScheduleOption(chatPage, 'Repeat', 'Every week');
    const editor = dialog.locator('.work-center-schedule-editor');
    for (const theme of ['light', 'dark']) {
      await chatPage.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const width of [1280, 320]) {
        await chatPage.setViewportSize({ width, height: 900 });
        const trigger = dialog.locator('.schedule-date-picker__trigger').first();
        await trigger.click();
        const panel = dialog.locator('.schedule-date-picker__panel');
        await expect(panel).toBeVisible();
        await expect(panel.locator('button[data-date]:focus')).toHaveCount(1);
        await chatPage.keyboard.press('ArrowRight');
        await expectVisibleFocus(panel.locator('button[data-date]:focus'));
        await panel.scrollIntoViewIfNeeded();
        const metrics = await dialog.evaluate(element => {
          const panel = element.querySelector('.schedule-date-picker__panel');
          const rect = panel.getBoundingClientRect();
          const body = element.querySelector('.work-center-modal-body');
          return { left: rect.left, right: rect.right, width: innerWidth, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth,
            background: getComputedStyle(panel).backgroundColor, expected: getComputedStyle(document.documentElement).getPropertyValue('--bg-subtle').trim() };
        });
        expect(metrics.left).toBeGreaterThanOrEqual(0);
        expect(metrics.right).toBeLessThanOrEqual(width);
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
        if (theme === 'dark') expect(metrics.background).not.toBe('rgb(255, 255, 255)');
        await chatPage.screenshot({ path: testInfo.outputPath(`schedule-${theme}-${width}.png`) });
        await panel.locator('button[data-date]:not(:disabled)').first().focus();
        await chatPage.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(dialog.locator('.work-center-modal-footer')).toBeInViewport();
      }
    }
    await chatPage.evaluate(async () => (await import('/utils/i18n.js')).setLocale('zh-CN'));
    await expect(dialog.locator('.work-center-form-section-heading h3', { hasText: '执行时间' })).toBeVisible();
    await dialog.locator('.schedule-date-picker__trigger').first().click();
    await expect(dialog.locator('.schedule-date-picker__month')).toContainText('月');
    await dialog.locator('.schedule-date-picker__panel').scrollIntoViewIfNeeded();
    await chatPage.screenshot({ path: testInfo.outputPath('schedule-dark-320-zh.png') });
    await expect(editor.locator('input[type="datetime-local"], input[type="date"], input[type="time"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
