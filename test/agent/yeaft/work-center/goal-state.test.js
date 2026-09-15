import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deriveGoalProgress } from '../../../../agent/yeaft/work-center/goal-state.js';
import { normalizeContractPatch } from '../../../../agent/yeaft/work-center/completion-contract.js';
import { coordinatorSnapshot, normalizeCoordinatorResponse } from '../../../../agent/yeaft/work-center/coordinator.js';
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
  it('derives current canonical proof without a manifest and ignores model progress claims', () => {
    const canonical = observation();
    const progress = deriveGoalProgress({ ...detail(canonical), goalProgress: { remainingCriteria: ['model claim'] } });
    const manifestOnly = observation('manifest', { run: { actionGeneration: undefined, actionSpecHash: undefined,
      executionManifest: { actionGeneration: 1, actionSpecHash: 'manifest-hash', contractRevision: 1 } } });
    expect(deriveGoalProgress(detail(manifestOnly)).remainingCriteria).toEqual([]);
    expect(progress).toMatchObject({ contractRevision: 1, completedCriteriaCount: 1, remainingCriteria: [],
      criteria: [{ criterion, status: 'passed', evidenceRunIds: [canonical.run.id] }],
      delivery: { target: 'response', status: 'passed', evidenceRunIds: [canonical.run.id] } });
  });

  it('rejects stale contracts, generations, hashes, noncanonical Runs and closed Actions', () => {
    for (const options of [
      { action: { contractRevision: 2 } }, { action: { generation: 2 } },
      { action: { specHash: 'changed' } }, { action: { resultRunId: 'other' } },
      { action: { status: 'closed' } }, { action: { status: 'superseded' } },
      { run: { workItemId: 'foreign' } },
      { run: { executionManifest: { contractRevision: 2 } } },
      { run: { executionManifest: { actionGeneration: 2 } } },
      { run: { executionManifest: { actionSpecHash: 'stale' } } },
      { run: { contextSnapshot: { contract: { revision: 2 } } } },
      { run: { acceptanceChecks: [{ criterion, status: 'invented', evidence: 'claim' }] } },
      { run: { evidence: [] } },
    ]) {
      expect(deriveGoalProgress(detail(observation('invalid', options))).remainingCriteria).toEqual([criterion]);
    }
  });

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

  it('invalidates proof per criterion and excludes a contradicted response even after correction', () => {
    const otherCriterion = 'Identify the affected cache versions';
    const pass = observation('pass', { run: { acceptanceChecks: [
      { criterion, status: 'passed', evidence: 'Original remedy' },
      { criterion: otherCriterion, status: 'passed', evidence: 'Version list' },
    ] } });
    const fail = observation('fail', { run: { endedAt: 20, acceptanceChecks: [
      { criterion, status: 'failed', evidence: 'Counterexample' },
      { criterion: otherCriterion, status: 'not_applicable', evidence: 'Versions unchanged' },
    ] } });
    const correction = observation('correction', { run: { startedAt: 21, endedAt: 30, acceptanceChecks: [
      { criterion, status: 'passed', evidence: 'Corrected remedy' },
      { criterion: otherCriterion, status: 'deferred', evidence: 'Versions already identified' },
    ] } });
    const progress = deriveGoalProgress({ ...detail(pass, fail, correction), acceptanceCriteria: [criterion, otherCriterion] });
    expect(progress.criteria.map(check => check.evidenceRunIds)).toEqual([[correction.run.id], [pass.run.id]]);
    expect(progress.delivery.evidenceRunIds).toEqual([correction.run.id]);
    for (const startedAt of [15, 20]) {
      correction.run.startedAt = startedAt;
      expect(deriveGoalProgress({ ...detail(pass, fail, correction), acceptanceCriteria: [criterion, otherCriterion] })
        .criteria[0].status).toBe('failed');
    }
  });

  it('retains terminal retryable counterexamples after deferred retries and requires newer proof', () => {
    const pass = observation('pass');
    const retry = observation('retry', { run: { endedAt: 30,
      acceptanceChecks: [{ criterion, status: 'deferred', evidence: 'Did not re-check' }] } });
    const historical = { ...retry.run, id: 'retryable-run', status: 'retryable', endedAt: 20,
      acceptanceChecks: [{ criterion, status: 'failed', evidence: 'Counterexample' }] };
    const source = detail(pass, retry);
    source.runs.push(historical);
    expect(deriveGoalProgress(source).criteria[0]).toMatchObject({ status: 'failed', evidenceRunIds: [],
      conflictingRunIds: [historical.id] });
    retry.run.acceptanceChecks[0].status = 'passed';
    expect(deriveGoalProgress(source).criteria[0]).toMatchObject({ status: 'passed', evidenceRunIds: [retry.run.id] });
  });

  it('invalidates earlier checks after a subsequent write, but not unrelated read-only deferred checks', () => {
    const pass = observation('pass');
    const later = observation('later', { run: { endedAt: 20,
      acceptanceChecks: [{ criterion, status: 'deferred', evidence: 'Not checked in this task' }] } });
    expect(deriveGoalProgress(detail(pass, later)).remainingCriteria).toEqual([]);
    later.action.workspaceMode = 'shared';
    expect(deriveGoalProgress(detail(pass, later)).remainingCriteria).toEqual([criterion]);
    expect(deriveGoalProgress(detail(pass, later)).delivery.status).toBe('passed'); // substantive later response exists
    later.action.status = 'closed';
    expect(deriveGoalProgress(detail(pass, later)).remainingCriteria).toEqual([criterion]); // closing a write is not rollback
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

  it('requires substantive response content and retains typed code delivery gates', () => {
    expect(normalizeContractPatch({ deliveryTarget: 'response' })).toEqual({ deliveryTarget: 'response' });
    expect(deriveGoalProgress(detail(observation('empty', { run: { summary: ' ' } }))).delivery.status).toBe('unmet');
    for (const [target, kind, ref] of [['workspace_files', 'file', 'report.md'], ['pull_request', 'pr', 'https://github.com/a/b/pull/1'], ['merge', 'commit', 'abcdef123456']]) {
      const fixture = detail(observation('code', { run: { outputs: [{ kind, ref, label: 'Delivered' }] } }));
      expect(deriveGoalProgress({ ...fixture, deliveryTarget: target }).delivery.status).toBe('passed');
      fixture.runs[0].outputs[0].status = 'failed';
      expect(deriveGoalProgress({ ...fixture, deliveryTarget: target }).delivery.status).toBe('unmet');
    }
  });

  it('bounds current gaps in snapshots without trusting cached projections', () => {
    const snapshot = coordinatorSnapshot(item({ goalProgress: { remainingCriteria: [] } }));
    expect(snapshot.goalProgress.remainingCriteria).toEqual([criterion]);
    const large = coordinatorSnapshot(item({ acceptanceCriteria: Array.from({ length: 24 }, (_, index) => `${index}${'长'.repeat(2000)}`) }));
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(64 * 1024);
    expect(large.goalProgress.totalCriteriaCount).toBe(24);
  });

  it('validates optional goal references, repeat rationale, and keeps old Action briefs compatible', () => {
    const prepare = (raw, source = item()) => prepareDynamicActionMutation({ workItem: source,
      actions: source.actions, decision: { workItemType: 'diagnosis', actions: [raw] } });
    expect(prepare(brief).createdActions).toHaveLength(1);
    expect(prepare({ ...brief, goalRefs: { criteria: [criterion] } }).createdActions[0].brief.goalRefs.criteria).toEqual([criterion]);
    expect(() => prepare({ ...brief, goalRefs: { criteria: ['unknown'] } })).toThrow(/goalRefs/);
    expect(() => prepare({ ...brief, goalRefs: { criteria: [criterion] } }, detail(observation()))).toThrow(/unmet goal|satisfied/);
    const repeated = item({ actions: [{ id: 'prior', status: 'completed', type: 'diagnose', brief }] });
    expect(() => prepare(brief, repeated)).toThrow(/Repeated Action/);
    const retry = prepare({ ...brief, goalRefs: { criteria: [criterion] }, rationale: 'The prior observation lacks a reproducer for the new versioned cache key.' }, repeated);
    expect(retry.createdActions[0].instruction).toContain('Why this Action:');
    expect(retry.createdActions[0].instruction).toContain('no artificial file');
    expect(() => prepare({ ...brief, goalRefs: { blockerActionIds: ['missing'] } })).toThrow(/blocker/);
    expect(() => prepare(brief, detail(observation()))).toThrow(/already supports completion/);
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
  function userTurn(id, text) {
    const current = store.getWorkItemDetail(id);
    return store.claimStartedCoordinatorTurn(store.beginCoordinatorTurn(id, text, current), 'coordinator');
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

  it('rejects every automatic contract field in decision and mutation, even with a forged authority flag', () => {
    const created = setup();
    const turn = automaticTurn(created.id, 'authority');
    for (const patch of [{ title: 'easier' }, { goal: 'less work' }, { acceptanceCriteria: [] }, { deliveryTarget: 'merge' }, { deliveryTarget: null }]) {
      expect(() => normalizeCoordinatorResponse({ reply: 'Change', decision: { kind: 'request_human', reason: 'Change contract', question: 'Proceed?', contractPatch: patch } }, turn.detail, { automatic: true })).toThrow(/Automatic.*contract/);
      expect(() => normalizeCoordinatorResponse({ reply: 'Change', decision: { kind: 'request_human', reason: 'Recovery', question: 'Proceed?', contractPatch: patch } }, turn.detail, { recovery: true })).toThrow(/Automatic.*contract/);
      expect(() => prepareDynamicActionMutation({ workItem: turn.detail, actions: [], automatic: true,
        decision: { contractPatch: patch, workItemType: 'diagnosis', actions: [brief] } })).toThrow(/Automatic.*contract/);
      for (const envelope of [{ decision: { kind: 'request_human', contractPatch: patch } },
        { decision: { kind: 'create_actions' }, mutation: { contractPatch: patch, createdActions: [brief] } }]) {
        expect(() => store.completeCoordinatorTurn(turn.turnId, { reply: 'Changing', ...envelope }, { ...turn.fence, automatic: false, userOriginated: true })).toThrow(/Automatic.*contract/);
      }
    }
    expect(store.getWorkItem(created.id)).toMatchObject({ title: created.title, goal: created.goal, acceptanceCriteria: [criterion], revision: 1 });
  });

  it('persists user refinement once, binds new Actions to that revision and invalidates old work', () => {
    const created = setup();
    createAction(automaticTurn(created.id, 'create'));
    const user = userTurn(created.id, 'Change the goal to include a verified cache versioning remedy.');
    const patch = { title: 'Versioned cache diagnosis', goal: 'Explain and verify cache versioning' };
    const decision = { kind: 'create_actions', reason: 'User refined the goal', contractPatch: patch, workItemType: 'diagnosis',
      actions: [{ ...brief, objective: 'Verify the versioned cache remedy end to end.' }] };
    const mutation = prepareDynamicActionMutation({ workItem: user.detail, actions: user.detail.actions, decision });
    const refined = store.completeCoordinatorTurn(user.turnId, { reply: 'Updated the goal.', decision, mutation }, user.fence);
    expect(refined).toMatchObject({ ...patch, revision: 2 });
    expect(refined.actions.map(action => [action.status, action.contractRevision])).toEqual([['superseded', 1], ['ready', 2]]);
    expect(refined.actions[1].instruction).toContain(patch.goal);
    const deliveryTurn = userTurn(created.id, 'Return the report as a response, not a file.');
    const answered = store.completeCoordinatorTurn(deliveryTurn.turnId, { reply: 'The report will be returned here.', decision: {
      kind: 'request_human', reason: 'Confirm the user boundary', question: 'Any further constraints?', contractPatch: { deliveryTarget: 'response' },
    } }, deliveryTurn.fence);
    expect(answered.revision).toBe(2); // identical target does not stale proof
  });

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

  it('cannot close a contradictory observation to complete from older passing proof', () => {
    const created = setup();
    createAction(automaticTurn(created.id, 'first-observation'));
    const first = store.claimReadyAction('runner');
    controller.submit(first.run.id, 'runner', first.run.leaseEpoch, { outcome: 'completed', summary: 'Initial report',
      evidence: ['First reproducer'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'First reproducer' }] });
    // A user-provided counterexample arrives as an unfinished verification Action.
    const second = store.createNextAction(created.id, { type: 'diagnose', stageId: 'counterexample', workspaceMode: 'read',
      brief, instruction: 'Check the counterexample', contractRevision: 1 });
    const check = store.claimReadyAction('runner');
    expect(check.action.id).toBe(second.id);
    controller.submit(check.run.id, 'runner', check.run.leaseEpoch, { outcome: 'failed', summary: 'Counterexample fails',
      error: 'Reproducer still fails', evidence: [{ kind: 'test', label: 'Counterexample', status: 'failed' }],
      acceptanceChecks: [{ criterion, status: 'failed', evidence: 'Counterexample' }] });
    const turn = automaticTurn(created.id, 'contradictory-complete');
    const result = completeResult([first.run.id]);
    result.decision.closeActions = [{ actionId: second.id, reason: 'Claim no further work is needed' }];
    expect(() => store.completeCoordinatorTurn(turn.turnId, result, turn.fence)).toThrow(/Completion delivery requires current canonical evidence/);
    expect(store.getWorkItem(created.id).status).not.toBe('done');
    expect(store.getAction(second.id).status).toBe('failed'); // completion transaction rolled back
  });

  it('requires correcting Run citations and never delivers an obsolete response after a counterexample', () => {
    const created = setup();
    createAction(automaticTurn(created.id, 'original-report'));
    const first = store.claimReadyAction('runner');
    controller.submit(first.run.id, 'runner', first.run.leaseEpoch, { outcome: 'completed', summary: 'Obsolete remedy',
      evidence: ['Original check'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Original check' }] });
    const counterexample = store.createNextAction(created.id, { type: 'diagnose', workspaceMode: 'read', brief,
      instruction: 'Check the counterexample', contractRevision: 1 });
    const failed = store.claimReadyAction('runner');
    expect(failed.action.id).toBe(counterexample.id);
    controller.submit(failed.run.id, 'runner', failed.run.leaseEpoch, { outcome: 'completed', summary: 'Counterexample',
      evidence: ['Counterexample reproduction'], acceptanceChecks: [{ criterion, status: 'failed', evidence: 'Remedy fails' }] });
    store.createNextAction(created.id, { type: 'diagnose', workspaceMode: 'read', brief,
      instruction: 'Correct and re-check the remedy', contractRevision: 1 });
    const correction = store.claimReadyAction('runner');
    controller.submit(correction.run.id, 'runner', correction.run.leaseEpoch, { outcome: 'completed', summary: 'Corrected remedy',
      evidence: ['Corrected check'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Corrected check' }] });
    const turn = automaticTurn(created.id, 'corrected-complete');
    expect(() => store.completeCoordinatorTurn(turn.turnId, completeResult([first.run.id]), turn.fence)).toThrow(/Completion delivery/);
    const staleCriterion = completeResult([first.run.id, correction.run.id]);
    staleCriterion.decision.completion.acceptanceResults[0].evidenceRunIds = [first.run.id];
    expect(() => store.completeCoordinatorTurn(turn.turnId, staleCriterion, turn.fence)).toThrow(/criterion lacks a passing canonical Run/);
    expect(store.getWorkItem(created.id).status).not.toBe('done');
    const completed = store.completeCoordinatorTurn(turn.turnId, completeResult([first.run.id, correction.run.id]), turn.fence);
    expect(completed.status).toBe('done');
    expect(completed.finalResult.responses.map(response => [response.runId, response.summary]))
      .toEqual([[correction.run.id, 'Corrected remedy']]);
    expect(completed.goalProgress.criteria[0].evidenceRunIds).toEqual([correction.run.id]);
  });

  it('blocks completion from old proof after a persisted retryable counterexample and a deferred retry', () => {
    const created = setup();
    createAction(automaticTurn(created.id, 'retry-report'));
    const first = store.claimReadyAction('runner');
    controller.submit(first.run.id, 'runner', first.run.leaseEpoch, { outcome: 'completed', summary: 'Initial remedy',
      evidence: ['Original check'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Original check' }] });
    store.createNextAction(created.id, { type: 'diagnose', workspaceMode: 'read', brief, maxAttempts: 2,
      instruction: 'Check the counterexample', contractRevision: 1 });
    const failed = store.claimReadyAction('runner');
    controller.submit(failed.run.id, 'runner', failed.run.leaseEpoch, { outcome: 'retryable', summary: 'Counterexample fails',
      evidence: ['Counterexample'], acceptanceChecks: [{ criterion, status: 'failed', evidence: 'Remedy fails' }] });
    expect(store.getRun(failed.run.id).status).toBe('retryable');
    const retry = store.claimReadyAction('runner');
    expect(retry.action.id).toBe(failed.action.id);
    controller.submit(retry.run.id, 'runner', retry.run.leaseEpoch, { outcome: 'completed', summary: 'Retry deferred verification',
      evidence: ['Retry completed'], acceptanceChecks: [{ criterion, status: 'deferred', evidence: 'Did not re-check' }] });
    store.close();
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    controller = new WorkflowController(store);
    const turn = automaticTurn(created.id, 'retry-complete');
    expect(() => store.completeCoordinatorTurn(turn.turnId, completeResult([first.run.id]), turn.fence)).toThrow(/Completion delivery requires current canonical evidence/);
    expect(() => store.completeCoordinatorTurn(turn.turnId, completeResult([first.run.id, retry.run.id]), turn.fence)).toThrow(/contradictory/);
    expect(store.getWorkItemDetail(created.id).goalProgress.criteria[0]).toMatchObject({ status: 'failed',
      evidenceRunIds: [], conflictingRunIds: [failed.run.id] });
    store.failCoordinatorTurn(turn.turnId, new Error('New verification required'), turn.fence);
    store.createNextAction(created.id, { type: 'diagnose', workspaceMode: 'read', brief,
      instruction: 'Re-check the corrected counterexample', contractRevision: 1 });
    const correction = store.claimReadyAction('runner');
    controller.submit(correction.run.id, 'runner', correction.run.leaseEpoch, { outcome: 'completed', summary: 'Verified correction',
      evidence: ['Corrected reproducer'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Counterexample now passes' }] });
    const finalTurn = automaticTurn(created.id, 'retry-corrected-complete');
    expect(store.completeCoordinatorTurn(finalTurn.turnId, completeResult([correction.run.id]), finalTurn.fence).status).toBe('done');
  });

  it('rebinds attachment guidance to the current contract and hash without accepting stale Run proof', () => {
    const created = setup();
    createAction(automaticTurn(created.id, 'attachment-report'));
    const first = store.claimReadyAction('runner');
    controller.submit(first.run.id, 'runner', first.run.leaseEpoch, { outcome: 'completed', summary: 'Pre-attachment report',
      evidence: ['Original check'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Original check' }] });
    const target = store.createNextAction(created.id, { type: 'diagnose', workspaceMode: 'read', brief,
      instruction: 'Check the attached reproducer', contractRevision: 1 });
    const waiting = store.claimReadyAction('runner');
    controller.submit(waiting.run.id, 'runner', waiting.run.leaseEpoch, { outcome: 'waiting', summary: 'Need reproducer',
      waitingReason: 'Attach the failing input', evidence: [],
      acceptanceChecks: [{ criterion, status: 'deferred', evidence: 'Awaiting attachment' }] });
    const attachment = { id: 'reproducer', name: 'reproducer.txt', mimeType: 'text/plain', size: 20 };
    const turn = store.claimStartedCoordinatorTurn(store.beginCoordinatorTurn(created.id, 'Use this reproducer.',
      store.getWorkItemDetail(created.id), { attachments: [attachment], addedAttachments: [attachment] }), 'coordinator');
    expect(turn.detail.revision).toBe(2);
    const guided = store.completeCoordinatorTurn(turn.turnId, { reply: 'Checking the attached reproducer.', decision: {
      kind: 'guide_actions', reason: 'User supplied the missing input',
      guidance: [{ actionId: target.id, instruction: 'Verify the remedy with the attached reproducer.' }],
    } }, turn.fence);
    const action = guided.actions.find(action => action.id === target.id);
    expect(action).toMatchObject({ status: 'ready', contractRevision: 2, generation: 2, resultRunId: null });
    expect(action.specHash).not.toBe(target.specHash);
    // The same canonical spec inserted independently must produce the same hash,
    // including the newly bound revision, not a hash computed from revision 1.
    const equivalent = store.createNextAction(created.id, { ...action, id: 'hash-check', status: 'closed' });
    expect(equivalent.specHash).toBe(action.specHash);
    expect(guided.goalProgress.remainingCriteria).toEqual([criterion]);
    expect(guided.goalProgress.delivery.evidenceRunIds).toEqual([]);
    const fresh = store.claimReadyAction('runner');
    expect(fresh.action.id).toBe(target.id);
    expect(store.setRunExecutionSnapshots(fresh.run.id, 'runner', fresh.run.leaseEpoch, {
      executionManifest: { actionGeneration: fresh.action.generation, actionSpecHash: fresh.action.specHash,
        contractRevision: fresh.action.contractRevision },
      contextSnapshot: { contract: { revision: guided.revision } },
    })).toBe(true);
    controller.submit(fresh.run.id, 'runner', fresh.run.leaseEpoch, { outcome: 'completed', summary: 'Attachment verified remedy',
      evidence: ['Attached reproducer passed'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Attached input verified' }] });
    const finalTurn = automaticTurn(created.id, 'attachment-complete');
    expect(() => store.completeCoordinatorTurn(finalTurn.turnId, completeResult([first.run.id]), finalTurn.fence)).toThrow(/canonical owned Run/);
    const completed = store.completeCoordinatorTurn(finalTurn.turnId, completeResult([fresh.run.id]), finalTurn.fence);
    expect(completed.status).toBe('done');
    expect(completed.goalProgress).toMatchObject({ contractRevision: 2, evidenceRunIds: [fresh.run.id], remainingCriteria: [] });
  });

  it('rejects completion after contract refinement even when criterion wording is unchanged', () => {
    const created = setup();
    createAction(automaticTurn(created.id, 'stale'));
    const claim = store.claimReadyAction('runner');
    controller.submit(claim.run.id, 'runner', claim.run.leaseEpoch, { outcome: 'completed', summary: 'Report',
      evidence: ['Reproducer'], acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Reproducer' }] });
    const user = userTurn(created.id, 'Also cover the multi-tenant cache.');
    store.completeCoordinatorTurn(user.turnId, { reply: 'Scope updated.', decision: { kind: 'request_human', reason: 'User added scope',
      question: 'Which tenant fixture?', contractPatch: { goal: 'Explain multi-tenant cache behavior' } } }, user.fence);
    const finalTurn = automaticTurn(created.id, 'stale-complete');
    expect(() => store.completeCoordinatorTurn(finalTurn.turnId, completeResult([claim.run.id]), finalTurn.fence)).toThrow(/canonical owned Run/);
    expect(store.getWorkItemDetail(created.id).goalProgress.remainingCriteria).toEqual([criterion]);
  });
});
