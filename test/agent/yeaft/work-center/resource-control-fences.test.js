import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { projectWorkItemDetail, projectWorkItemSummary } from '../../../../agent/yeaft/work-center/projection.js';
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

});
