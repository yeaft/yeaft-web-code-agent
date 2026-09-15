import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { __testSetWorkCenterService, handleWorkCenterRequest } from '../../../../agent/yeaft/work-center/bridge.js';
import { projectWorkItemDetail, projectWorkItemSummary } from '../../../../agent/yeaft/work-center/projection.js';
import ctx from '../../../../agent/context.js';
import { agents } from '../../../../server/context.js';
import { handleClientWorkCenter, deliverWorkCenterResponse, __testResetWorkCenterRequests } from '../../../../server/handlers/client-work-center.js';

// Routing tests exercise the real access/correlation boundary, but never open
// Server runtime data through the transport helper's catalog imports.
vi.mock('../../../../server/database.js', () => ({
  sessionDb: {}, yeaftProjectDb: {}, yeaftSessionDb: {}, sessionUiMetadataDb: {},
}));

const fixtures = [];
function fixture(maxAttempts = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'work-center-control-fence-'));
  const path = join(dir, 'work.db');
  const store = new WorkItemStore(path);
  const controller = new WorkflowController(store);
  const item = store.createWorkItem({ title: 'Fenced work', goal: 'Preserve canonical evidence',
    acceptanceCriteria: ['Original contract remains current'], workDir: dir, reuseMemory: false },
  { type: 'implement', maxAttempts });
  const result = { store, controller, item, dir, path };
  fixtures.push(result);
  return result;
}
function resume(controller, store, id) {
  const detail = store.getWorkItemDetail(id);
  return controller.resume(id, { revision: detail.revision, executionControlRevision: detail.executionControl.revision });
}

afterEach(() => {
  __testSetWorkCenterService(null);
  ctx.ws = null;
  ctx.outboundSendQueue = [];
  ctx.outboundSendQueueActive = false;
  vi.unstubAllGlobals();
  for (const { store, dir } of fixtures.splice(0)) {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Work Center execution epoch and contract fences', () => {
  it('preserves contract evidence and uses persistent independent CAS for stop, extension and resume', () => {
    const { store, item, controller, path } = fixture();
    const evidenceAction = store.createNextAction(item.id, { type: 'review', status: 'completed', contractRevision: item.revision });
    const initial = store.getExecutionControl(item.id).revision;
    store.stopExecution(item.id, 'run_requests_exhausted');
    store.stopExecution(item.id, 'work_item_tokens_exhausted');
    expect(store.getExecutionControl(item.id).revision).toBe(initial + 1);
    expect(store.getWorkItem(item.id).revision).toBe(item.revision);
    expect(() => store.extendExecutionBudget(item.id, initial, { maxRequests: 1 })).toThrow(/changed/);
    const second = new WorkItemStore(path);
    try {
      const extended = second.extendExecutionBudget(item.id, initial + 1, { maxRequests: 10 });
      expect(extended.revision).toBe(item.revision);
      expect(extended.executionControl.revision).toBe(initial + 2);
      expect(() => store.extendExecutionBudget(item.id, initial + 1, { maxRequests: 10 })).toThrow(/changed/);
      expect(() => controller.resume(item.id, { revision: item.revision, executionControlRevision: initial + 1 })).toThrow(/changed/);
      expect(() => controller.resume(item.id, { revision: item.revision })).toThrow(/changed/);
      const resumed = resume(controller, store, item.id);
      expect(resumed.executionControl.revision).toBe(initial + 3);
      expect(resumed.revision).toBe(item.revision);
      expect(store.getAction(evidenceAction.id)).toMatchObject({ status: 'completed', contractRevision: item.revision });
      const request = store.reserveWorkItemRequest({ workItemId: item.id, kind: 'coordinator', request: { maxTokens: 1 } });
      store.settleWorkItemRequest(request.id, { totalTokens: 1 });
      expect(store.getExecutionControl(item.id).revision).toBe(initial + 3);
      expect(projectWorkItemDetail(store.getWorkItemDetail(item.id)).executionControl.revision).toBe(initial + 3);
      expect(projectWorkItemSummary(store.listWorkItems()[0]).executionControl.revision).toBe(initial + 3);
    } finally { second.close(); }
  });

  it('retires pre-stop Coordinator claims and recovery without incrementing the contract revision', () => {
    const { store, item, controller, path } = fixture();
    const started = store.claimStartedCoordinatorTurn(store.beginCoordinatorTurn(item.id, 'Inspect', store.getWorkItemDetail(item.id)), 'coordinator');
    const turn = store.prepareCoordinatorProviderTurn(item.id, started.turnId, 1, { maxTokens: 100 }, started.fence.claim);
    store.dispatchCoordinatorProviderTurn(turn.id, started.fence.claim);
    const revision = store.getWorkItem(item.id).revision;
    store.stopExecution(item.id, 'run_requests_exhausted');
    expect(() => store.completeCoordinatorTurn(started.turnId, { reply: 'Blocked while stopped' }, started.fence)).toThrow(/stopped/);
    store.extendExecutionBudget(item.id, store.getExecutionControl(item.id).revision, { maxRequests: 1 });
    const resumed = resume(controller, store, item.id);
    expect(resumed.revision).toBe(revision);
    expect(resumed.coordinatorRevision).toBeGreaterThan(started.fence.coordinatorRevision);
    expect(store.completeCoordinatorTurn(started.turnId, { reply: 'Stale guidance' }, started.fence)).toBeNull();
    expect(store.dispatchCoordinatorProviderTurn(turn.id, started.fence.claim)).toBeNull();
    expect(store.resumeCoordinatorTurn(item.id, started.turnId, started.fence.claim)).toBeNull();
    expect(store.failCoordinatorTurn(started.turnId, new Error('late failure'), started.fence)).toBeNull();
    expect(store.getRecoverableCoordinatorTurns()).toEqual([]);
    store.settleCoordinatorRequest(turn.id, { inputTokens: 8, outputTokens: 2 });
    store.settleCoordinatorRequest(turn.id, { totalTokens: 10_000 });
    const reopened = new WorkItemStore(path);
    try {
      expect(reopened.getRecoverableCoordinatorTurns()).toEqual([]);
      expect(reopened.getExecutionControl(item.id).usage).toMatchObject({ llmRequestCount: 1, totalTokens: 10 });
      expect(reopened.getExecutionControl(item.id).coordinatorFailures).toBe(0);
    } finally { reopened.close(); }
  });

  it('keeps maxAttempts=1 across generations and restart, allowing more only with explicit attempt extension', () => {
    const { store, item, controller, path } = fixture(1);
    const first = store.claimReadyAction('first');
    expect(first.action.maxAttempts).toBe(1);
    controller.cancel(item.id);
    resume(controller, store, item.id);
    // Simulate automatic guidance rewriting the current Action policy as well
    // as resetting attempt: the original persisted cap remains authoritative.
    store.db.prepare('UPDATE actions SET max_attempts = 99, attempt = 0 WHERE id = ?').run(first.action.id);
    expect(store.claimReadyAction('automatic')).toBeNull();
    expect(store.getExecutionControl(item.id)).toMatchObject({ stopReason: {
      code: 'action_attempts_exhausted', attempts: 1, originalMaxAttempts: 1, effectiveMaxAttempts: 1,
    } });
    const reopened = new WorkItemStore(path);
    try {
      expect(reopened.claimReadyAction('restart')).toBeNull();
      reopened.extendExecutionBudget(item.id, reopened.getExecutionControl(item.id).revision, { maxTokens: 1 });
      expect(() => resume(controller, store, item.id)).toThrow(/maxActionAttempts/);
      const extended = reopened.extendExecutionBudget(item.id, reopened.getExecutionControl(item.id).revision, { maxActionAttempts: 1 });
      expect(extended.executionControl).toMatchObject({ actionAttemptsExtension: 1,
        actionAttempts: [{ actionId: first.action.id, attempts: 1, originalMaxAttempts: 1, effectiveMaxAttempts: 2 }] });
      resume(controller, store, item.id);
      expect(store.claimReadyAction('user-authorized')).not.toBeNull();
    } finally { reopened.close(); }
    controller.cancel(item.id);
    resume(controller, store, item.id);
    expect(store.claimReadyAction('no-third')).toBeNull();
  });

  it('uses the lower global attempt cap even when the Action originally allowed more', () => {
    const { store, item, controller } = fixture(9);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = store.claimReadyAction(`run-${attempt}`);
      expect(claim).not.toBeNull();
      expect(store.getExecutionControl(item.id).actionAttempts[0]).toMatchObject({
        attempts: attempt, originalMaxAttempts: 9, effectiveMaxAttempts: 3,
      });
      controller.cancel(item.id);
      resume(controller, store, item.id);
    }
    expect(store.claimReadyAction('fourth')).toBeNull();
    expect(store.getExecutionControl(item.id).stopReason).toMatchObject({ code: 'action_attempts_exhausted', attempts: 3 });
  });

  it('carries authenticated extend/resume CAS through the browser bridge and public snapshots', async () => {
    const { store, item, controller, dir } = fixture();
    const service = new WorkCenterService({ store, controller, yeaftDir: dir, runner: null, coordinator: null });
    __testSetWorkCenterService(service);
    const frames = [];
    ctx.ws = { readyState: 1, send: value => frames.push(JSON.parse(value)) };
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    store.stopExecution(item.id, 'run_requests_exhausted');
    const executionControlRevision = store.getExecutionControl(item.id).revision;
    await expect(service.handle('extend_budget', { id: item.id, executionControlRevision, additions: { maxRequests: 1 }, userOriginated: true }))
      .rejects.toThrow(/explicit user/);
    await expect(service.handle('resume', { id: item.id, revision: item.revision }, { userOriginated: true }))
      .rejects.toThrow(/executionControlRevision/);
    await handleWorkCenterRequest({ requestId: 'extend', op: 'extend_budget', payload: {
      id: item.id, executionControlRevision, additions: { maxRequests: 1 }, userOriginated: false,
    } });
    await new Promise(resolve => setImmediate(resolve));
    expect(frames.find(frame => frame.requestId === 'extend')).toMatchObject({ ok: true,
      data: { revision: item.revision, executionControl: { revision: executionControlRevision + 1, stopReason: { code: 'run_requests_exhausted' } } } });
    await handleWorkCenterRequest({ requestId: 'resume', op: 'resume', payload: {
      id: item.id, revision: item.revision, executionControlRevision: executionControlRevision + 1,
    } });
    await new Promise(resolve => setImmediate(resolve));
    expect(frames.find(frame => frame.requestId === 'resume')).toMatchObject({ ok: true,
      data: { revision: item.revision, executionControl: { revision: executionControlRevision + 2, stopReason: null } } });
    expect(store.claimReadyAction('explicit-user')).not.toBeNull();
  });

  it('keeps server Agent-access and response-ownership gates on both explicit budget operations', async () => {
    const agentId = 'resource-control-agent';
    const agentFrames = [];
    const clientFrames = [];
    agents.set(agentId, { capabilities: ['work_center'], encryptOutbound: false,
      ws: { readyState: 1, send: value => agentFrames.push(JSON.parse(value)) } });
    const client = { userId: 'budget-owner', encryptOutbound: false,
      ws: { readyState: 1, send: value => clientFrames.push(JSON.parse(value)) } };
    try {
      for (const op of ['extend_budget', 'resume']) {
        const payload = { id: 'work-item', executionControlRevision: 2,
          ...(op === 'resume' ? { revision: 7 } : { additions: { maxRequests: 1 } }) };
        const message = { type: 'work_center_request', agentId, requestId: `browser-${op}`, op, payload };
        const before = agentFrames.length;
        const deny = vi.fn(async () => false);
        await handleClientWorkCenter(client, message, deny);
        expect(deny).toHaveBeenCalledWith(agentId);
        expect(agentFrames).toHaveLength(before);
        await handleClientWorkCenter(client, message, async () => true);
        const forwarded = agentFrames.at(-1);
        expect(forwarded).toMatchObject({ op, payload });
        expect(forwarded.requestId).not.toBe(message.requestId);
        const response = { type: 'work_center_response', requestId: forwarded.requestId, op,
          ok: true, data: { executionControl: { revision: 3 } } };
        expect(await deliverWorkCenterResponse('wrong-agent', response)).toBe(false);
        expect(await deliverWorkCenterResponse(agentId, response)).toBe(true);
        expect(clientFrames.at(-1)).toMatchObject({ requestId: message.requestId, agentId,
          ok: true, data: { executionControl: { revision: 3 } } });
      }
    } finally {
      __testResetWorkCenterRequests();
      agents.delete(agentId);
    }
  });

  it('additively migrates the original resource ledger schema without rewriting goal revision or usage', () => {
    const { store, item, path } = fixture(1);
    const request = store.reserveWorkItemRequest({ workItemId: item.id, kind: 'coordinator', request: { maxTokens: 10 } });
    store.settleWorkItemRequest(request.id, { totalTokens: 7 });
    store.db.exec(`ALTER TABLE work_item_execution_controls DROP COLUMN revision;
      ALTER TABLE work_item_execution_controls DROP COLUMN action_attempts_extension;
      DROP TRIGGER work_item_action_attempt_limit_insert;
      DROP TABLE work_item_action_attempt_limits;`);
    store.close();
    const reopened = new WorkItemStore(path);
    try {
      expect(reopened.getWorkItem(item.id).revision).toBe(item.revision);
      expect(reopened.getExecutionControl(item.id)).toMatchObject({ revision: 1,
        usage: { llmRequestCount: 1, totalTokens: 7 }, actionAttemptsExtension: 0,
        actionAttempts: [{ originalMaxAttempts: 1, effectiveMaxAttempts: 1 }] });
    } finally { reopened.close(); }
  });
});
