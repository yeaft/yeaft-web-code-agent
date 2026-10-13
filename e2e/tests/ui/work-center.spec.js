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

async function openCreateFromSidebar(page) {
  const button = page.locator('.work-center-sidebar-create');
  if (!await button.isVisible()) await page.locator('.work-center-navigation-toggle:visible').click();
  await button.click();
}

async function ensureActionsOpen(page) {
  const button = page.locator('.work-center-actions-button');
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}

async function expectWorkCenterTarget(target, value, label) {
  await expect(target).toHaveAttribute('data-value', value);
  await expect(target.locator('.modern-select-label')).toHaveText(label);
}

test.describe('Work Center responsive UI', () => {

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

  test('creates from a goal contract and leaves planning to the Coordinator', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await openCreateFromSidebar(chatPage);
    await expect(chatPage.locator('.work-center-plan-preview')).toContainText('Coordinator-driven execution');
    await expect(chatPage.locator('.work-center-plan-preview')).toContainText('The Coordinator chooses the next Actions and executors from the current evidence');
    await expect(chatPage.locator('.work-center-plan-stages')).toHaveCount(0);

    await chatPage.locator('.work-center-modal').getByRole('textbox', { name: /Requirement/ })
      .fill('Fix dynamic planning with the smallest safe flow');
    const createRequest = respondToWorkCenterOp(mockAgent, 'create', OPEN_ITEM_DETAIL);
    await chatPage.getByRole('button', { name: 'Create', exact: true }).click();
    const request = await createRequest;
    expect(request.payload.workItemType).toBe('auto');
    expect(request.payload.reuseMemory).toBe(true);
    expect(request.payload).not.toHaveProperty('workflowTemplate');
    expect(request.payload).not.toHaveProperty('stageOverrides');
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

  test('uploads files and binds their references to the Work Item create request', async ({ chatPage, mockAgent }) => {
    await openWorkCenter(chatPage, mockAgent);
    await openCreateFromSidebar(chatPage);
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
  await openCreateFromSidebar(page);
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
    const data = request.op === 'list_delivery_instructions' ? { values: [] } : request.op === 'list' ? { items: [] }
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

});
