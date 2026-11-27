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

const CANCELLED_ITEM = closedWorkItem('cancelled');

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
        : request.op === 'list_delivery_instructions' ? { values: [] }
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

});
