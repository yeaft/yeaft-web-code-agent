import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { prepareDynamicActionMutation, resolveDynamicActionPolicySnapshot } from '../../../../agent/yeaft/work-center/dynamic-coordination.js';
import { projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';
import { coordinatorSnapshot } from '../../../../agent/yeaft/work-center/coordinator.js';

const criterion = 'Explain the verified cause';
let store;
let dir;
afterEach(() => { store?.close(); store = null; if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

function turn(id, key) {
  store.enqueueCoordinatorMailbox(id, 'work_item_created', {}, key);
  const claim = store.claimCoordinatorMailbox(id, 'coordinator');
  return store.beginDynamicCoordinatorTurn(claim.id, { ownerBootId: 'coordinator', claimEpoch: claim.claim_epoch });
}

describe('goal, cost and browser projection integration', () => {
  it('retains canonical goal proof through budget stop/extend/resume and delivers its response through the wire', () => {
    dir = mkdtempSync(join(tmpdir(), 'work-center-integrated-'));
    let time = 1000;
    store = new WorkItemStore(join(dir, 'work.db'), { now: () => time++ });
    const controller = new WorkflowController(store);
    const item = controller.create({ title: 'Explain failure', goal: 'Explain the root cause',
      acceptanceCriteria: [criterion], deliveryTarget: 'response', workDir: dir, start: true,
      coordinationMode: 'dynamic', executionSchemaVersion: 3,
      workflowSnapshot: resolveDynamicActionPolicySnapshot({}, 'diagnosis') });
    const initial = turn(item.id, 'plan');
    const decision = { kind: 'create_actions', reason: 'Resolve the cause', workItemType: 'diagnosis', actions: [{
      type: 'diagnose', objective: 'Verify the root cause and return a report',
      approach: 'Inspect the evidence and reproduce the symptom', expectedOutcome: 'A verified explanation',
      workspaceMode: 'read', sourceActionIds: [],
    }] };
    const mutation = prepareDynamicActionMutation({ workItem: initial.detail, actions: initial.detail.actions, decision });
    store.completeCoordinatorTurn(initial.turnId, { reply: 'Investigating.', decision, mutation }, initial.fence);
    const claim = store.claimReadyAction('runner');
    const report = 'The cache key omits the version; the reproducer confirms the fix.';
    controller.submit(claim.run.id, 'runner', claim.run.leaseEpoch, { outcome: 'completed', summary: report,
      evidence: [{ kind: 'test', label: 'Reproducer', status: 'passed' }],
      acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Reproducer' }] });
    const before = store.getWorkItemDetail(item.id);
    expect(before.goalProgress.remainingCriteria).toEqual([]);
    const request = store.reserveWorkItemRequest({ workItemId: item.id, kind: 'coordinator', request: { maxTokens: 50 } });
    store.settleWorkItemRequest(request.id, { inputTokens: 1000, outputTokens: 300 });
    // Admission/settlement must not alter a persisted Coordinator request hash
    // when recovery reconstructs its snapshot after a crash.
    expect(coordinatorSnapshot(store.getWorkItemDetail(item.id))).toEqual(coordinatorSnapshot(before));
    store.stopExecution(item.id, 'work_item_requests_exhausted');
    const extended = store.extendExecutionBudget(item.id, store.getExecutionControl(item.id).revision, { maxRequests: 10 });
    expect(extended.status).toBe('needs_attention');
    expect(extended.goalProgress).toEqual(before.goalProgress);
    const resumed = controller.resume(item.id, { revision: extended.revision, executionControlRevision: extended.executionControl.revision });
    expect(resumed.revision).toBe(before.revision);
    expect(resumed.goalProgress).toEqual(before.goalProgress);
    const final = turn(item.id, 'complete');
    const done = store.completeCoordinatorTurn(final.turnId, { reply: 'Delivered.', decision: {
      kind: 'complete', reason: 'Verified goal', completion: { summary: 'Diagnosis complete',
        acceptanceResults: [{ criterion, status: 'passed', evidenceRunIds: [claim.run.id] }], evidenceRunIds: [claim.run.id] },
    } }, final.fence);
    const wire = projectWorkItemDetail(done);
    expect(wire.status).toBe('done');
    expect(wire.deliveryTarget).toBe('response');
    expect(wire.goalProgress).toMatchObject({ completedCriteriaCount: 1, remainingCriteria: [], delivery: { target: 'response', status: 'passed' } });
    expect(wire.finalResult.responses).toEqual([{ runId: claim.run.id, summary: report,
      evidence: [{ kind: 'test', label: 'Reproducer', status: 'passed' }] }]);
    expect(wire.executionStats.totalTokens).toBe(1300);
    expect(wire.executionControl.breakdown.coordinator.totalTokens).toBe(1300);
    expect(wire.executionControl.stopReason).toBeNull();
  });

  it('bounds browser goal/response projection and preserves old-Agent fallback', () => {
    const legacy = projectWorkItemDetail({ id: 'legacy', revision: 1, acceptanceCriteria: [criterion], actions: [], runs: [] });
    expect(legacy.goalProgress).toBeNull();
    const wire = projectWorkItemDetail({ id: 'large', actions: [], runs: [], goalProgress: {
      criteria: Array.from({ length: 110 }, () => ({ criterion: 'x'.repeat(100000), status: 'invented', evidenceRunIds: Array(100).fill('r') })),
      blockers: [], delivery: { target: 'untrusted', status: 'invented' },
    }, finalResult: { responses: Array(30).fill({ runId: 'r', summary: 'x'.repeat(100000), evidence: [] }) } });
    expect(wire.goalProgress.criteria).toHaveLength(100);
    expect(wire.goalProgress.criteria[0]).toMatchObject({ status: 'unmet' });
    expect(wire.goalProgress.criteria[0].evidenceRunIds).toHaveLength(64);
    expect(wire.goalProgress.criteria[0].criterion.length).toBeLessThan(100000);
    expect(wire.goalProgress.delivery).toMatchObject({ target: null, status: 'unmet' });
    expect(wire.finalResult.responses).toHaveLength(24);
    expect(wire.finalResult.responses[0].summary.length).toBeLessThan(100000);
  });
});
