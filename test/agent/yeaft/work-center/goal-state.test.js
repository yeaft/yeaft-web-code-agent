import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveGoalProgress } from '../../../../agent/yeaft/work-center/goal-state.js';
import { prepareDynamicActionMutation, resolveDynamicActionPolicySnapshot } from '../../../../agent/yeaft/work-center/dynamic-coordination.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';

const criterion = 'Explain the observed failure and a verified remedy';
const brief = {
  type: 'diagnose', objective: 'Explain the cache invalidation failure with a verified remedy.',
  approach: 'Inspect the cache read path and reproduce the stale value locally.',
  expectedOutcome: 'An evidence-backed explanation with a reproducible remedy.',
  workspaceMode: 'read', sourceActionIds: [],
};
function item(overrides = {}) {
  return {
    id: 'goal-item', revision: 1, title: 'Cache diagnosis', goal: 'Explain the cache failure',
    acceptanceCriteria: [criterion], deliveryTarget: 'response', coordinationMode: 'dynamic', executionSchemaVersion: 3,
    workflowSnapshot: resolveDynamicActionPolicySnapshot({}, 'diagnosis'), actions: [], runs: [], ...overrides,
  };
}
function observation(id = 'observation', options = {}) {
  return {
    action: { id, workItemId: 'goal-item', type: 'diagnose', status: 'completed', generation: 1,
      contractRevision: 1, specHash: `${id}-hash`, resultRunId: `${id}-run`, workspaceMode: 'read', ...options.action },
    run: { id: `${id}-run`, actionId: id, workItemId: 'goal-item', status: 'completed', actionGeneration: 1,
      actionSpecHash: `${id}-hash`, summary: 'Cache key omits version; include the version and re-test.',
      evidence: [{ kind: 'test', label: 'Reproducer passed', status: 'passed' }], endedAt: 10,
      acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Local reproducer' }], ...options.run },
  };
}
function detail(...observations) {
  return item({ actions: observations.map(value => value.action), runs: observations.map(value => value.run) });
}

describe('goal progress from durable Run evidence', () => {
  it('does not cherry-pick passing evidence over a current contradiction and permits newer verified correction', () => {
    const pass = observation('pass');
    const fail = observation('fail', { run: { endedAt: 20,
      acceptanceChecks: [{ criterion, status: 'failed', evidence: 'The cache remains stale' }] } });
    expect(deriveGoalProgress(detail(pass, fail)).criteria[0]).toMatchObject({ status: 'failed', evidenceRunIds: [], conflictingRunIds: [fail.run.id] });
    fail.action.status = 'closed';
    expect(deriveGoalProgress(detail(pass, fail)).criteria[0].status).toBe('failed'); // closure is not new proof
    const correction = observation('correction', { run: { endedAt: 30 } });
    expect(deriveGoalProgress(detail(pass, fail, correction))).toMatchObject({ remainingCriteria: [],
      criteria: [{ status: 'passed', evidenceRunIds: [correction.run.id] }],
      delivery: { evidenceRunIds: [correction.run.id] } });
    const retry = observation('fail', { action: { generation: 2, status: 'completed' }, run: { id: 'retry-run', actionGeneration: 2,
      endedAt: 30, acceptanceChecks: [{ criterion, status: 'deferred', evidence: 'Did not re-check the counterexample' }] } });
    retry.action.resultRunId = retry.run.id;
    const historical = detail(pass, retry);
    historical.runs.push(fail.run);
    expect(deriveGoalProgress(historical).criteria[0].status).toBe('failed');
    for (const run of [{ error: 'Unresolved error' }, { reviewDecision: 'changes_requested' },
      { evidence: [{ kind: 'test', label: 'Reproducer failed', status: 'failed' }] },
      { outputs: [{ kind: 'file', label: 'Report failed', ref: 'report.md', status: 'failed' }] }]) {
      expect(deriveGoalProgress(detail(observation('contradiction', { run }))).criteria[0].status).toBe('failed');
    }
  });

  it('rejects proof overlapping a writer or tied at its completion time', () => {
    const writer = observation('writer', { action: { workspaceMode: 'shared' }, run: { endedAt: 20,
      acceptanceChecks: [{ criterion, status: 'deferred', evidence: 'Implementation only' }] } });
    for (const startedAt of [10, 20]) {
      const verifier = observation('verify', { run: { startedAt, endedAt: 30 } });
      expect(deriveGoalProgress(detail(writer, verifier)).remainingCriteria).toEqual([criterion]);
    }
    expect(deriveGoalProgress(detail(writer, observation('verify', { run: { startedAt: 21, endedAt: 30 } }))).remainingCriteria).toEqual([]);
  });
});

describe('goal contract authority and completion persistence', () => {
  let store;
  let tempDir;
  let controller;
  afterEach(() => { store?.close(); if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });
  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-goal-state-'));
    let now = 1000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    controller = new WorkflowController(store);
    return controller.create({ ...item(), workDir: tempDir, start: true });
  }
  function automaticTurn(id, key) {
    store.enqueueCoordinatorMailbox(id, 'work_item_created', {}, key);
    const claim = store.claimCoordinatorMailbox(id, 'coordinator');
    return store.beginDynamicCoordinatorTurn(claim.id, { ownerBootId: 'coordinator', claimEpoch: claim.claim_epoch });
  }
  function createAction(turn) {
    const decision = { kind: 'create_actions', reason: 'Resolve the unproven cause', workItemType: 'diagnosis', actions: [brief] };
    const mutation = prepareDynamicActionMutation({ workItem: turn.detail, actions: turn.detail.actions, decision });
    return store.completeCoordinatorTurn(turn.turnId, { reply: 'Investigating the cause.', decision, mutation }, turn.fence);
  }
  function completeResult(runIds) {
    return { reply: 'The report is ready.', decision: { kind: 'complete', reason: 'Canonical evidence covers the goal', completion: {
      summary: 'Diagnosis complete', acceptanceResults: [{ criterion, status: 'passed', evidenceRunIds: runIds }], evidenceRunIds: runIds,
    } } };
  }

  it('delivers a non-code report from canonical summary/evidence and survives reopening the database', () => {
    const created = setup();
    const planned = createAction(automaticTurn(created.id, 'report'));
    const claim = store.claimReadyAction('runner');
    const report = 'The cache key omits version. Include version in the key; the local reproducer confirms isolation.';
    controller.submit(claim.run.id, 'runner', claim.run.leaseEpoch, { outcome: 'completed', summary: report,
      evidence: [{ kind: 'test', label: 'Reproducer passed', status: 'passed' }],
      acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Local reproducer with two versions' }] });
    const before = store.getWorkItemDetail(created.id).goalProgress;
    store.close();
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    expect(store.getWorkItemDetail(created.id).goalProgress).toEqual(before);
    const finalTurn = automaticTurn(created.id, 'complete');
    const completed = store.completeCoordinatorTurn(finalTurn.turnId, completeResult([claim.run.id]), finalTurn.fence);
    expect(completed.status).toBe('done');
    expect(completed.actions).toHaveLength(planned.actions.length);
    expect(completed.finalResult.outputs).toEqual([]);
    expect(completed.finalResult.responses).toEqual([{ runId: claim.run.id, summary: report,
      evidence: [{ kind: 'test', label: 'Reproducer passed', status: 'passed' }] }]);
    expect(() => store.db.prepare('UPDATE runs SET summary = ? WHERE id = ?').run('forged', claim.run.id)).toThrow(/immutable/);
  });
});
