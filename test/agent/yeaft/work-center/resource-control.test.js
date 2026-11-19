import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { resolveDynamicActionPolicySnapshot } from '../../../../agent/yeaft/work-center/dynamic-coordination.js';
import { DEFAULT_EXECUTION_LIMITS, WorkCenterResourceAdapter, estimateRequestTokens } from '../../../../agent/yeaft/work-center/resource-control.js';

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

afterEach(() => {
  for (const entry of fixtures.splice(0)) {
    try { entry.store.close(); } catch {}
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe('Work Center persistent resource control', () => {
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

});
