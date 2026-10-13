import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DYNAMIC_COORDINATION_MODE, DYNAMIC_EXECUTION_SCHEMA_VERSION, normalizeDynamicCompletion, prepareDynamicActionMutation, resolveDynamicActionPolicySnapshot } from '../../../../agent/yeaft/work-center/dynamic-coordination.js';
import { WorkItemCoordinator, normalizeCoordinatorResponse } from '../../../../agent/yeaft/work-center/coordinator.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';

function workItem(overrides = {}) {
  return {
    id: 'work-item-1',
    coordinationMode: DYNAMIC_COORDINATION_MODE,
    executionSchemaVersion: DYNAMIC_EXECUTION_SCHEMA_VERSION,
    title: 'Ship a durable dynamic loop',
    goal: 'Let the Coordinator create only currently justified Actions',
    acceptanceCriteria: ['Actions are dynamic', 'Completion is evidence-backed'],
    deliveryTarget: 'workspace_files',
    workflowSnapshot: resolveDynamicActionPolicySnapshot({}, 'software-change'),
    ...overrides,
  };
}

describe('Work Center dynamic coordination contract', () => {
  let tempDir;
  let store;

  afterEach(() => {
    try { store?.close(); } catch {}
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    store = null;
    tempDir = null;
  });

  it('persists dynamic Actions and automatically reconciles only after the runnable batch settles', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-loop-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(),
      workDir: tempDir,
      workflowTemplate: 'coordinator-driven',
      start: true,
    });
    expect(created).toMatchObject({ status: 'draft', coordinationMode: 'dynamic' });
    expect(store.claimReadyAction('premature')).toBeNull();

    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:test');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const started = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const source = [];
    const mutation = prepareDynamicActionMutation({
      workItem: started.detail,
      actions: source,
      availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'implement',
          objective: 'Implement the durable dynamic execution loop.',
          approach: 'Change the existing Coordinator and store with focused tests.',
          expectedOutcome: 'A verified dynamic Action loop is available.',
          candidateVpIds: ['linus'],
          assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    const planned = store.completeCoordinatorTurn(started.turnId, {
      reply: 'Starting the next justified Action.',
      decision: {
        kind: 'create_actions', reason: 'The initial contract is actionable.',
        actions: [], guidance: [], contractPatch: null,
      },
      mutation,
    }, started.fence);
    expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0]).toMatchObject({ sourceActionIds: [], dependsOnStageIds: [] });

    const claimedAction = store.claimReadyAction('runner-owner', 5_000);
    expect(claimedAction.action.id).toBe(planned.actions[0].id);
    expect(claimedAction.workItem.currentRunId).toBeNull();
    controller.submit(claimedAction.run.id, 'runner-owner', claimedAction.run.leaseEpoch, {
      outcome: 'completed', summary: 'Dynamic loop implemented',
      evidence: [{ kind: 'text', label: 'focused tests passed' }],
      outputs: [{ kind: 'file', label: 'Implementation', ref: 'src/dynamic-loop.js' }],
      acceptanceChecks: [
        { criterion: 'Actions are dynamic', status: 'passed', evidence: 'focused tests passed' },
        { criterion: 'Completion is evidence-backed', status: 'passed', evidence: 'focused tests passed' },
      ],
    });
    const settled = store.getWorkItemDetail(created.id);
    expect(settled.status).toBe('running');
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
      expect.objectContaining({ workItemId: created.id, kind: 'action_settled' }),
    ]);
    expect(store.claimReadyAction('no-more-work')).toBeNull();

    const reconciliation = store.listPendingDynamicCoordinatorWakes()[0];
    const reconciliationClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const completionTurn = store.beginDynamicCoordinatorTurn(reconciliation.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: reconciliationClaim.claim_epoch,
    });
    const completed = store.completeCoordinatorTurn(completionTurn.turnId, {
      reply: 'The acceptance criteria are verified.',
      decision: {
        kind: 'complete', reason: 'All criteria have canonical Run evidence.',
        completion: {
          summary: 'The dynamic loop is complete.',
          acceptanceResults: [
            { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: [claimedAction.run.id] },
            { criterion: 'Completion is evidence-backed', status: 'passed', evidenceRunIds: [claimedAction.run.id] },
          ],
          evidenceRunIds: [claimedAction.run.id], residualRisks: [],
        },
      },
    }, completionTurn.fence);
    expect(completed).toMatchObject({
      status: 'done', currentActionId: null,
      finalResult: { evidenceRunIds: [claimedAction.run.id] },
    });
    expect(() => store.db.prepare('UPDATE work_items SET final_result = ? WHERE id = ?')
      .run(JSON.stringify({ summary: 'rewritten' }), created.id))
      .toThrow(/WorkItem final result is immutable/);
  });

  it('recovers dynamic Runs and resumes cancelled WorkItems through the Coordinator', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-recovery-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:recovery');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'implement', objective: 'Implement the dynamic recovery path.',
          approach: 'Run a durable Action and simulate an expired lease.',
          expectedOutcome: 'The Action returns to ready without losing the WorkItem.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    const planned = store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting recovery work.',
      decision: { kind: 'create_actions', reason: 'Recovery work is actionable.', actions: [] },
      mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('old-runner', 10);
    expect(acquired.action.id).toBe(planned.actions[0].id);

    now = 2_000;
    expect(store.recoverInterruptedRuns('new-runner')).toBe(1);
    expect(store.getWorkItemDetail(created.id)).toMatchObject({
      status: 'ready',
      actions: [expect.objectContaining({ id: acquired.action.id, status: 'ready' })],
    });

    controller.cancel(created.id);
    const cancelledRevision = store.getWorkItem(created.id).revision;
    const resumed = controller.resume(created.id, { revision: cancelledRevision });
    expect(resumed).toMatchObject({ status: 'running', currentActionId: null });
    expect(resumed.actions).toEqual([
      expect.objectContaining({ id: acquired.action.id, status: 'superseded' }),
    ]);
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItemId: created.id, kind: 'work_item_resumed' }),
    ]));
  });

  it('runs a real dynamic Action and persists an action-journal execution manifest', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-runner-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:runner');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['omni'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'test', objective: 'Execute a real dynamic WorkItem Runner.',
          approach: 'Run the Engine with a terminal structured response.',
          expectedOutcome: 'The dynamic Mainline manifest is persisted.',
          candidateVpIds: ['omni'], assignmentReason: 'Omni is the test executor.',
          sourceActionIds: [], workspaceMode: 'read',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting the real Runner Action.',
      decision: { kind: 'create_actions', reason: 'The Action is runnable.', actions: [] },
      mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    const adapter = {
      async *stream(params) {
        params.onRequestStart?.();
        yield { type: 'text_delta', text: JSON.stringify({
          outcome: 'completed', summary: 'Runner completed.',
          evidence: ['real dynamic runner evidence'],
          acceptanceChecks: [
            { criterion: 'Actions are dynamic', status: 'passed', evidence: 'runner manifest' },
            { criterion: 'Completion is evidence-backed', status: 'deferred', evidence: 'Coordinator verifies' },
          ],
        }) };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const runner = new WorkItemRunner({
      store,
      runtimeProvider: async () => ({
        defaultWorkDir: tempDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter,
      }),
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'tester', traits: ['test'] }],
        getVp: id => id === 'omni'
          ? { id: 'omni', name: 'Omni', role: 'tester', traits: ['test'] } : null,
      },
    });
    const result = await runner.run({
      ...acquired, ownerBootId: 'runner-owner', signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: 'completed', summary: 'Runner completed.' });
    expect(store.getRun(acquired.run.id)?.executionManifest).toMatchObject({
      schemaVersion: 2, planRevision: 1,
    });
  });

  it.each([
    ['unexpired', 1_001],
    ['expired', 2_000],
  ])('requeues an automatic Coordinator wake after a %s pre-dispatch crash', (_lease, reopenAt) => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-coordinator-crash-'));
    let now = 1_000;
    const dbPath = join(tempDir, 'work-center.db');
    store = new WorkItemStore(dbPath, { now: () => now });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, `dynamic:create:${_lease}`);
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-before-crash', 100);
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-before-crash', claimEpoch: claim.claim_epoch,
    });
    expect(turn).not.toBeNull();
    store.close();
    store = null;
    now = reopenAt;
    store = new WorkItemStore(dbPath, { now: () => now });
    expect(store.getWorkItemDetail(created.id).messages.at(-1)).toMatchObject({
      role: 'assistant', status: 'failed',
    });
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
      expect.objectContaining({ id: mailbox.id, workItemId: created.id }),
    ]);
  });

  it('rejects WorkItem completion backed by a canonical Run with no evidence or acceptance checks', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-empty-evidence-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:empty-evidence');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'test', objective: 'Create an invalid canonical completion fixture.',
          approach: 'Persist a completed Run without evidence or acceptance checks.',
          expectedOutcome: 'The final completion gate rejects the Run.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns the fixture.',
          sourceActionIds: [], workspaceMode: 'read',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting invalid evidence fixture.',
      decision: { kind: 'create_actions', reason: 'Fixture is runnable.', actions: [] }, mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    store.closeRunInput(acquired.run.id, 'runner-owner', acquired.run.leaseEpoch);
    store.finalizeRun(acquired.run.id, 'runner-owner', acquired.run.leaseEpoch, {
      outcome: 'completed', summary: 'No proof', evidence: [], acceptanceChecks: [],
    }, () => { throw new Error('legacy transition must not run'); });
    const reconciliation = store.listPendingDynamicCoordinatorWakes()[0];
    const completionClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const completionTurn = store.beginDynamicCoordinatorTurn(reconciliation.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: completionClaim.claim_epoch,
    });
    expect(() => store.completeCoordinatorTurn(completionTurn.turnId, {
      reply: 'Claiming completion without proof.',
      decision: {
        kind: 'complete', reason: 'The invalid Run claims success.',
        completion: {
          summary: 'Invalid completion',
          acceptanceResults: [
            { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: [acquired.run.id] },
            { criterion: 'Completion is evidence-backed', status: 'passed', evidenceRunIds: [acquired.run.id] },
          ],
          evidenceRunIds: [acquired.run.id], residualRisks: [],
        },
      },
    }, completionTurn.fence)).toThrow(/evidence|acceptance/i);
  });

  it('enqueues reconciliation when interrupted recovery exhausts a dynamic Action', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-terminal-recovery-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:terminal-recovery');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'implement', objective: 'Exercise terminal interrupted recovery.',
          approach: 'Expire the only allowed Run attempt.',
          expectedOutcome: 'The Coordinator receives a reconciliation wake.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns recovery.',
          sourceActionIds: [], workspaceMode: 'shared', maxAttempts: 1,
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting terminal recovery fixture.',
      decision: { kind: 'create_actions', reason: 'Fixture is runnable.', actions: [] }, mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('old-runner', 10);
    now = 2_000;
    expect(store.recoverInterruptedRuns('new-runner')).toBe(1);
    expect(store.getAction(acquired.action.id)).toMatchObject({ status: 'failed' });
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
      expect.objectContaining({ workItemId: created.id, kind: 'action_settled' }),
    ]);
  });

  it('keeps canonical Run identity, checks, and outputs in completed Coordinator snapshots', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-coordinator-snapshot-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const initial = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:snapshot');
    const initialClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const initialTurn = store.beginDynamicCoordinatorTurn(initial.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: initialClaim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: initialTurn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'documentation', actions: [{
          type: 'write', objective: 'Produce one canonical document.',
          approach: 'Write the requested file and return structured evidence.',
          expectedOutcome: 'The Coordinator can complete directly from the Run snapshot.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus writes the document.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    store.completeCoordinatorTurn(initialTurn.turnId, {
      reply: 'Writing the document.',
      decision: { kind: 'create_actions', reason: 'The task is actionable.', actions: [] }, mutation,
    }, initialTurn.fence);
    const run = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(run.run.id, 'runner-owner', run.run.leaseEpoch, {
      outcome: 'completed', summary: 'Document ready',
      evidence: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      outputs: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    let snapshot = null;
    const coordinator = new WorkItemCoordinator({
      store,
      registry: { listVps: () => [{ id: 'linus', name: 'Linus', role: 'systems' }] },
      policyProvider: async () => ({ coordinatorModelPolicy: { mode: 'inherit' } }),
      runtimeProvider: async () => ({
        config: { model: 'provider/model', maxOutputTokens: 1_024 },
        adapter: { call: async request => {
          request.onRequestStart?.();
          snapshot = JSON.parse(request.messages[0].content.match(/Current WorkItem snapshot:\n([\s\S]*?)\n\nLatest user message:/)?.[1]);
          return { text: JSON.stringify({
            reply: 'The existing canonical Run is sufficient.',
            decision: {
              kind: 'complete', reason: 'No evidence-packaging Action is required.', closeActions: [],
              completion: {
                summary: 'Complete',
                acceptanceResults: workItem().acceptanceCriteria.map(criterion => ({
                  criterion, status: 'passed', evidenceRunIds: [run.run.id],
                })),
                evidenceRunIds: [run.run.id], residualRisks: [],
              },
            },
          }) };
        } },
      }),
    });
    const existingWake = store.listPendingDynamicCoordinatorWakes()[0];
    const coordinatorClaim = store.claimCoordinatorMailbox(created.id, coordinator.ownerBootId);
    const started = store.beginDynamicCoordinatorTurn(existingWake.id, {
      ownerBootId: coordinator.ownerBootId, claimEpoch: coordinatorClaim.claim_epoch,
    });
    const turn = coordinator.resume(started, {
      text: 'Finish from the existing evidence.',
    });
    const completed = await turn.task;
    expect(snapshot.actions[0].result).toMatchObject({
      runId: run.run.id,
      outputs: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    expect(completed.status).toBe('done');
    expect(completed.actions).toHaveLength(1);
  });

  it('normalizes structured outputs and exposes them on the final WorkItem result', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-outputs-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:outputs');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'documentation', actions: [{
          type: 'write', objective: 'Write the requested design document.',
          approach: 'Create and verify the document in the Work Item workspace.',
          expectedOutcome: 'A structured file output is available to the user.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns the document.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Writing the document.',
      decision: { kind: 'create_actions', reason: 'The file delivery boundary is explicit.', actions: [] }, mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(acquired.run.id, 'runner-owner', acquired.run.leaseEpoch, {
      outcome: 'completed', summary: 'Document written',
      evidence: [{ kind: 'file', label: 'Design document', ref: 'docs/design.md' }],
      outputs: [
        { kind: 'file', label: 'Design document', ref: 'docs/design.md' },
        { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1' },
      ],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    const wake = store.listPendingDynamicCoordinatorWakes()[0];
    const completeClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const completeTurn = store.beginDynamicCoordinatorTurn(wake.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: completeClaim.claim_epoch,
    });
    const completed = store.completeCoordinatorTurn(completeTurn.turnId, {
      reply: 'The requested outputs are ready.',
      decision: {
        kind: 'complete', reason: 'The explicit file delivery boundary is satisfied.',
        completion: {
          summary: 'Outputs ready',
          acceptanceResults: workItem().acceptanceCriteria.map(criterion => ({
            criterion, status: 'passed', evidenceRunIds: [acquired.run.id],
          })),
          evidenceRunIds: [acquired.run.id], residualRisks: [],
        },
      },
    }, completeTurn.fence);
    expect(store.getRun(acquired.run.id).outputs).toEqual([
      { kind: 'file', label: 'Design document', ref: 'docs/design.md' },
      { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1' },
    ]);
    expect(completed.finalResult.outputs).toEqual([
      { kind: 'file', label: 'Design document', ref: 'docs/design.md', runId: acquired.run.id },
      { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1', runId: acquired.run.id },
    ]);
    expect(() => store.db.prepare('UPDATE runs SET outputs = ? WHERE id = ?')
      .run('[{"kind":"file","label":"rewritten","ref":"late.md"}]', acquired.run.id))
      .toThrow(/terminal Run result is immutable/);
    const projected = projectWorkItemDetail(completed);
    expect(projected.outputs).toEqual([
      { kind: 'file', label: 'Design document', ref: 'docs/design.md', actionId: acquired.action.id, runId: acquired.run.id },
      { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1', actionId: acquired.action.id, runId: acquired.run.id },
    ]);
  });

  it('rejects mutating Actions when only contract wording implies a delivery target', () => {
    const detail = workItem({
      goal: 'Fix the merge algorithm without changing public behavior.',
      acceptanceCriteria: ['The merge algorithm remains compatible'],
      deliveryTarget: null,
      actions: [],
      runs: [],
    });
    expect(() => normalizeCoordinatorResponse({
      reply: 'I will fix the merge algorithm.',
      decision: {
        kind: 'create_actions', reason: 'The implementation is clear.',
        workItemType: 'software-change', actions: [{
          type: 'implement', objective: 'Fix the merge algorithm.',
          approach: 'Modify the implementation and run focused tests.',
          expectedOutcome: 'The merge algorithm is corrected without public behavior changes.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] }))
      .toThrow(/delivery target.*request_human/i);
  });

  it('rejects automatic delivery-target patches before they can persist', () => {
    const detail = workItem({ deliveryTarget: null, actions: [], runs: [] });
    for (const decision of [
      {
        kind: 'create_actions', reason: 'I selected the merge boundary.',
        workItemType: 'software-change',
        contractPatch: { deliveryTarget: 'merge' },
        actions: [{
          type: 'implement', objective: 'Implement the requested change.',
          approach: 'Modify the repository and verify focused tests.',
          expectedOutcome: 'A verified change is ready for delivery.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
      {
        kind: 'request_human', reason: 'I inferred the merge boundary.',
        question: 'Proceed with merge?', contractPatch: { deliveryTarget: 'merge' },
      },
    ]) {
      expect(() => normalizeCoordinatorResponse({
        reply: 'I will merge the result.', decision,
      }, detail, { automatic: true, availableVpIds: ['linus'] }))
        .toThrow(/automatic.*delivery target/i);
    }
  });

  it('requires a human decision when the delivery boundary is ambiguous', () => {
    const detail = workItem({ deliveryTarget: null, actions: [], runs: [] });
    expect(() => normalizeCoordinatorResponse({
      reply: 'I will start coding.',
      decision: {
        kind: 'create_actions', reason: 'The technical implementation is clear.',
        workItemType: 'software-change', actions: [{
          type: 'implement', objective: 'Implement the requested change.',
          approach: 'Modify the repository and verify focused tests.',
          expectedOutcome: 'A code change exists, but delivery is unspecified.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] }))
      .toThrow(/delivery boundary.*request_human/i);
    const question = normalizeCoordinatorResponse({
      reply: 'The implementation scope is clear, but the delivery boundary is not.',
      decision: {
        kind: 'request_human', reason: 'File-only, PR, and merged delivery require different authority.',
        question: 'Should this Work Item stop after generating files, open a PR, or merge the approved PR?',
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] });
    expect(question.decision.kind).toBe('request_human');
    expect(() => normalizeCoordinatorResponse({
      reply: 'I inferred a pull request.',
      decision: {
        kind: 'request_human', reason: 'Confirmation is required.',
        question: 'Should I open a pull request?',
        contractPatch: { deliveryTarget: 'pull_request' },
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] }))
      .toThrow(/automatic.*delivery target/i);
    expect(normalizeCoordinatorResponse({
      reply: 'You selected a pull request.',
      decision: {
        kind: 'request_human', reason: 'Persist the user-confirmed boundary.',
        question: 'Proceed with the confirmed pull request boundary?',
        contractPatch: { deliveryTarget: 'pull_request' },
      },
    }, detail, { automatic: false, availableVpIds: ['linus'] }).decision.contractPatch)
      .toEqual({ deliveryTarget: 'pull_request' });
  });

  it('requires canonical owned Run evidence for every completion criterion', () => {
    const completion = normalizeDynamicCompletion({
      summary: 'The Coordinator verified the durable result.',
      acceptanceResults: [
        { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: ['run-research'] },
        { criterion: 'Completion is evidence-backed', status: 'passed', evidenceRunIds: ['run-test'] },
      ],
      evidenceRunIds: ['run-research', 'run-test'],
      residualRisks: [],
    }, workItem().acceptanceCriteria);
    expect(completion.evidenceRunIds).toEqual(['run-research', 'run-test']);

    expect(() => normalizeDynamicCompletion({
      summary: 'Incomplete',
      acceptanceResults: [
        { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: ['run-research'] },
        { criterion: 'Completion is evidence-backed', status: 'deferred', evidenceRunIds: ['run-test'] },
      ],
      evidenceRunIds: ['run-research', 'run-test'],
    }, workItem().acceptanceCriteria)).toThrow(/every criterion to pass/);
  });
});
