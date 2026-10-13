import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AnthropicAdapter } from '../../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../../agent/yeaft/llm/openai-responses.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { WorkItemCoordinator } from '../../../../agent/yeaft/work-center/coordinator.js';
import { resolveDynamicActionPolicySnapshot } from '../../../../agent/yeaft/work-center/dynamic-coordination.js';
import { projectWorkItemDetail, projectWorkItemSummary } from '../../../../agent/yeaft/work-center/projection.js';
import { DEFAULT_EXECUTION_LIMITS, WorkCenterResourceAdapter, estimateRequestTokens, callCoordinatorWithResourceControl } from '../../../../agent/yeaft/work-center/resource-control.js';

const fixtures = [];
function fixture(dynamic = false, executionSchemaVersion = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'work-center-resource-'));
  let now = 1_000;
  const path = join(dir, 'work.db');
  const store = new WorkItemStore(path, { now: () => now });
  const controller = new WorkflowController(store);
  const item = controller.create({ title: 'Bounded work', goal: 'Never dispatch beyond durable budget',
    acceptanceCriteria: ['Admission is persistent'], workflowTemplate: 'software-change', workDir: dir, executionSchemaVersion,
    ...(dynamic ? { coordinationMode: 'dynamic', executionSchemaVersion: 3,
      workflowSnapshot: resolveDynamicActionPolicySnapshot({}, 'software-change') } : {}), start: !dynamic });
  const result = { dir, path, store, controller, item, advance: () => { now += 10_000; } };
  fixtures.push(result);
  return result;
}
function limits(store, id, patch) {
  store.getExecutionControl(id);
  store.db.prepare('UPDATE work_item_execution_controls SET limits_json = ? WHERE work_item_id = ?')
    .run(JSON.stringify({ ...DEFAULT_EXECUTION_LIMITS, ...patch }), id);
}
async function drain(stream) { for await (const _event of stream) { /* exhaust */ } }
function coordinatorTurn(store, id) {
  const detail = store.getWorkItemDetail(id);
  const started = store.beginCoordinatorTurn(id, 'Decide', detail);
  return store.claimStartedCoordinatorTurn(started, 'coordinator');
}

afterEach(() => {
  for (const entry of fixtures.splice(0)) {
    try { entry.store.close(); } catch {}
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe('Work Center persistent resource control', () => {
  it.each([
    { protocol: 'anthropic', NativeAdapter: AnthropicAdapter },
    { protocol: 'openai-responses', NativeAdapter: OpenAIResponsesAdapter },
  ])('blocks $protocol stream and call entry points before mock fetch', async ({ NativeAdapter }) => {
    const fetch = vi.fn(() => { throw new Error('No request may reach the transport'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const { store, item } = fixture();
      const { run } = store.claimReadyAction('native-boundary');
      limits(store, item.id, { maxTokens: 1 });
      const adapter = new WorkCenterResourceAdapter(new NativeAdapter({
        apiKey: 'fixture-only', baseUrl: 'https://example.invalid',
      }), store, item.id, run.id);
      const request = { model: 'mock', messages: [], maxTokens: 100 };
      await expect(drain(adapter.stream(request))).rejects.toThrow(/execution stopped/);
      await expect(adapter.call(request)).rejects.toThrow(/execution stopped/);
      expect(store.getExecutionControl(item.id).usage.llmRequestCount).toBe(0);
      expect(store.getWorkItem(item.id).status).toBe('needs_attention');
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('atomically combines Coordinator and Action requests, tracks in-flight estimates and settles replay only once', async () => {
    const { store, item, path } = fixture();
    limits(store, item.id, { maxRequests: 3 });
    const run = store.claimReadyAction('runner');
    const started = coordinatorTurn(store, item.id);
    const request = { model: 'mock', maxTokens: 100, messages: [{ role: 'user', content: 'Decide' }] };
    const turn = store.prepareCoordinatorProviderTurn(item.id, started.turnId, 1, request, started.fence.claim);
    expect(store.dispatchCoordinatorProviderTurn(turn.id, started.fence.claim)).not.toBeNull();
    // The provider router's hidden credential-refresh retry is a real second request.
    expect(store.dispatchCoordinatorProviderTurn(turn.id, started.fence.claim)).not.toBeNull();
    const reserved = store.getExecutionControl(item.id);
    expect(reserved.usage).toMatchObject({ llmRequestCount: 2, unknownRequests: 1, inFlightRequests: 1 });
    expect(reserved.usage.chargedTokens).toBe(estimateRequestTokens(request) * 2);
    store.respondCoordinatorProviderTurn(turn.id, turn.requestHash,
      { text: '{}', usage: { input_tokens: 10, output_tokens: 5 } }, started.fence.claim);
    expect(store.respondCoordinatorProviderTurn(turn.id, turn.requestHash,
      { usage: { total_tokens: 900 } }, started.fence.claim)).toBeNull();
    const other = new WorkItemStore(path);
    try {
      const action = other.reserveWorkItemRequest({ workItemId: item.id, kind: 'action', runId: run.run.id, request });
      expect(action.allowed).toBe(true);
      expect(store.reserveWorkItemRequest({ workItemId: item.id, kind: 'coordinator', request }).allowed).toBe(false);
      other.settleWorkItemRequest(action.id, { inputTokens: 20, outputTokens: 7 });
      other.settleWorkItemRequest(action.id, { totalTokens: 90_000 });
      const detail = projectWorkItemDetail(store.getWorkItemDetail(item.id));
      expect(detail.executionStats).toMatchObject({ llmRequestCount: 3, totalTokens: 42 });
      expect(detail.executionControl).toMatchObject({ stopReason: { code: 'work_item_requests_exhausted' },
        breakdown: { coordinator: { llmRequestCount: 2, totalTokens: 15 }, actions: { llmRequestCount: 1, totalTokens: 27 } } });
      expect(projectWorkItemSummary(store.listWorkItems()[0]).executionStats.totalTokens).toBe(42);
    } finally { other.close(); }
  });

  it('rejects before mock provider dispatch, counts hidden retries and retains partial/unknown consumption on abort', async () => {
    const { store, item } = fixture();
    const { run } = store.claimReadyAction('runner');
    limits(store, item.id, { maxRunRequests: 2 });
    let dispatches = 0;
    const upstream = { captureRequest: () => ({ captureStream: async function* (params) {
      params.onRequestStart(); dispatches += 1;
      params.onRequestStart(); dispatches += 1;
      yield { type: 'usage', inputTokens: 12, outputTokens: 4 };
      throw new Error('truncated transport');
    } }) };
    const adapter = new WorkCenterResourceAdapter(upstream, store, item.id, run.id);
    await expect(drain(adapter.stream({ maxTokens: 100 }))).rejects.toThrow('truncated');
    let usage = store.getExecutionControl(item.id).usage;
    expect(usage).toMatchObject({ llmRequestCount: 2, totalTokens: 16, unknownRequests: 2 });
    expect(usage.chargedTokens).toBe(estimateRequestTokens({ maxTokens: 100 }) * 2);
    await expect(drain(adapter.stream({ maxTokens: 100 }))).rejects.toThrow(/execution stopped/);
    expect(dispatches).toBe(2);
    expect(store.getWorkItemDetail(item.id)).toMatchObject({ status: 'needs_attention',
      executionControl: { stopReason: { code: 'run_requests_exhausted' } } });
    // Missing usage is neither free nor a fabricated reported token total.
    usage = store.getExecutionControl(item.id).usage;
    expect(usage.totalTokens).toBe(16);
    expect(usage.chargedTokens).toBeGreaterThan(16);
  });

  it('persists token denial through restart/cancel/update/guidance; only user extension plus resume releases it', async () => {
    const f = fixture();
    const { store, item, controller, path } = f;
    limits(store, item.id, { maxTokens: 10 });
    const denied = store.reserveWorkItemRequest({ workItemId: item.id, kind: 'coordinator', request: { maxTokens: 100 } });
    expect(denied.allowed).toBe(false);
    expect(store.getExecutionControl(item.id).usage.llmRequestCount).toBe(0);
    store.db.prepare("UPDATE work_items SET status = 'ready' WHERE id = ?").run(item.id);
    expect(store.getWorkItem(item.id).status).toBe('needs_attention');
    expect(store.claimReadyAction('blocked')).toBeNull();
    expect(store.claimCoordinatorMailbox(item.id, 'blocked')).toBeNull();
    expect(() => coordinatorTurn(store, item.id)).toThrow(/Explicit user/);
    const reopened = new WorkItemStore(path);
    try { expect(reopened.getExecutionControl(item.id).stopReason.code).toBe('work_item_tokens_exhausted'); }
    finally { reopened.close(); }
    controller.cancel(item.id);
    const service = new WorkCenterService({ store, controller, yeaftDir: f.dir, runner: null });
    const revision = store.getWorkItem(item.id).revision;
    const executionControlRevision = store.getExecutionControl(item.id).revision;
    await expect(service.handle('extend_budget', { id: item.id, executionControlRevision, additions: { maxTokens: 10_000 } }))
      .rejects.toThrow(/explicit user/);
    await expect(service.handle('resume', { id: item.id, revision })).rejects.toThrow(/explicit user/);
    const extended = await service.handle('extend_budget', { id: item.id, executionControlRevision, additions: { maxTokens: 10_000 } }, { userOriginated: true });
    expect(extended.executionControl.stopReason).not.toBeNull();
    expect(extended.revision).toBe(revision);
    expect(extended.executionControl.revision).toBe(executionControlRevision + 1);
    expect(store.claimReadyAction('still-blocked')).toBeNull();
    const resumed = await service.handle('resume', { id: item.id, revision: extended.revision, executionControlRevision: extended.executionControl.revision }, { userOriginated: true });
    expect(resumed.executionControl.stopReason).toBeNull();
    expect(store.claimReadyAction('resumed')).not.toBeNull();
  });

  it('uses persistent bounded Coordinator failure/backoff instead of an infinite automatic wake loop', async () => {
    const f = fixture(true);
    const { store, item, controller } = f;
    controller.start(item.id);
    const runtimeProvider = vi.fn(async () => { throw new Error('runtime unavailable'); });
    const coordinator = new WorkItemCoordinator({ store, runtimeProvider, registry: { listVps: () => [] } });
    const service = new WorkCenterService({ store, controller, coordinator, yeaftDir: f.dir, runner: null });
    for (let count = 1; count <= 3; count += 1) {
      const wake = store.listPendingDynamicCoordinatorWakes()[0];
      const turn = coordinator.advance(wake.id, { workItemId: item.id });
      await turn.task;
      expect(store.getExecutionControl(item.id).coordinatorFailures).toBe(count);
      expect(store.canAutomaticallyCoordinate(item.id)).toBe(false);
      f.advance();
    }
    expect(store.getWorkItem(item.id).status).toBe('needs_attention');
    expect(store.claimCoordinatorMailbox(item.id, 'cannot-recover')).toBeNull();
    service.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runtimeProvider).toHaveBeenCalledTimes(3);
    expect(store.getExecutionControl(item.id).stopReason.code).toBe('coordinator_failures_exhausted');
    await service.shutdown();
  });

  it.each(['stream', 'call'])('rechecks the original Run and EngineTurn at a delayed legacy %s callback after cancel', async mode => {
    const { store, item, controller } = fixture();
    const { action, run } = store.claimReadyAction('runner');
    const turn = store.prepareEngineTurn(action.id, run.id, 'runner', run.leaseEpoch);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const dispatch = vi.fn();
    const invoke = async params => {
      await gate;
      params.onRequestStart();
      dispatch();
      return { usage: { totalTokens: 7 } };
    };
    const adapter = new WorkCenterResourceAdapter({ call: invoke, async *stream(params) {
      const result = await invoke(params);
      yield { type: 'usage', ...result.usage };
    } }, store, item.id, run.id);
    const params = { maxTokens: 100, onRequestStart: () => {
      if (!store.claimEngineTurn(turn.id, 'runner', run.leaseEpoch)) throw new Error('Original Run lease lost');
    } };
    const pending = mode === 'stream' ? drain(adapter.stream(params)) : adapter.call(params);
    expect(store.getEngineTurn(turn.id)).toMatchObject({ status: 'dispatching', dispatchAttempt: 1 });
    controller.cancel(item.id);
    const rejected = expect(pending).rejects.toThrow(/Original Run lease lost/);
    release();
    await rejected;
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getEngineTurn(turn.id).dispatchAttempt).toBe(1);
    expect(store.getExecutionControl(item.id).usage).toMatchObject({ llmRequestCount: 1, unknownRequests: 1 });
  });

  it('rechecks the original Coordinator claim at a delayed legacy callback after stop and resume', async () => {
    const { store, item, controller } = fixture();
    const started = coordinatorTurn(store, item.id);
    const request = { maxTokens: 100 };
    const turn = store.prepareCoordinatorProviderTurn(item.id, started.turnId, 1, request, started.fence.claim);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const dispatch = vi.fn();
    const pending = callCoordinatorWithResourceControl({ call: async params => {
      await gate;
      params.onRequestStart();
      dispatch();
      return { usage: { totalTokens: 7 } };
    } }, store, turn, started.fence.claim, request);
    expect(store.getCoordinatorProviderTurn(turn.id).status).toBe('dispatching');
    store.stopExecution(item.id, 'run_requests_exhausted');
    controller.resume(item.id, { revision: store.getWorkItem(item.id).revision,
      executionControlRevision: store.getExecutionControl(item.id).revision });
    expect(store.isExecutionStopped(item.id)).toBe(false);
    expect(store.getWorkItem(item.id).status).not.toBe('cancelled');
    const rejected = expect(pending).rejects.toThrow(/dispatch fence/);
    release();
    await rejected;
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.getExecutionControl(item.id).usage).toMatchObject({ llmRequestCount: 1, unknownRequests: 1 });
  });
});
