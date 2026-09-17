import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DYNAMIC_COORDINATION_MODE,
  DYNAMIC_EXECUTION_SCHEMA_VERSION,
  isDynamicWorkItem,
  normalizeDynamicCompletion,
  prepareDynamicActionMutation,
  resolveDynamicActionPolicySnapshot,
} from '../../../../agent/yeaft/work-center/dynamic-coordination.js';
import {
  WorkItemCoordinator,
  coordinatorSnapshot,
  normalizeCoordinatorResponse,
} from '../../../../agent/yeaft/work-center/coordinator.js';
import { Registry } from '../../../../agent/yeaft/vp/registry.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import {
  buildMainlineContextSnapshot,
  buildMainlineProjection,
} from '../../../../agent/yeaft/work-center/mainline-projection.js';
import { WorkItemRunner, parseStructuredResult } from '../../../../agent/yeaft/work-center/runner.js';
import createWorkItemTool from '../../../../agent/yeaft/tools/create-work-item.js';

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

function completedAction(id = 'research-1') {
  return {
    id,
    workItemId: 'work-item-1',
    type: 'research',
    status: 'completed',
    resultRunId: `run-${id}`,
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

  it('builds a policy snapshot without a workflow graph or prebuilt stages', () => {
    const snapshot = resolveDynamicActionPolicySnapshot({}, 'software-change');
    expect(snapshot).toMatchObject({
      planningMode: 'coordinator',
      executionMode: 'dynamic',
      workItemType: 'software-change',
    });
    expect(snapshot).not.toHaveProperty('stages');
    expect(snapshot).not.toHaveProperty('dependsOnStageIds');
    expect(snapshot.actionTemplates).toContainEqual({ type: 'implement' });
    expect(snapshot.actionTemplates).not.toContainEqual({ type: 'triage' });
    expect(isDynamicWorkItem(workItem())).toBe(true);
  });

  it('normalizes only the next runnable Actions and keeps sources as non-scheduling references', () => {
    const source = completedAction();
    const mutation = prepareDynamicActionMutation({
      workItem: workItem(),
      actions: [source],
      availableVpIds: ['linus', 'martin'],
      decision: {
        workItemType: 'software-change',
        contractPatch: null,
        supersedeActionIds: [],
        actions: [{
          type: 'implement',
          objective: 'Implement the Coordinator-driven Action dispatch path.',
          approach: 'Modify the existing Work Center store and add focused regression tests.',
          expectedOutcome: 'A runnable implementation Action with verified tests.',
          capability: 'implement',
          candidateVpIds: ['linus'],
          assignmentReason: 'Linus owns implementation work.',
          sourceActionIds: [source.id],
          workspaceMode: 'shared',
        }],
      },
    });

    expect(mutation.createdActions).toHaveLength(1);
    expect(mutation.createdActions[0]).toMatchObject({
      type: 'implement',
      sourceActionIds: [source.id],
      dependsOnStageIds: [],
      changesRequestedStageId: null,
      workspaceMode: 'shared',
    });
    expect(mutation.createdActions[0].id).toBe(mutation.createdActions[0].stageId);
    expect(mutation.createdActions[0].instruction).toContain('Implement the Coordinator-driven Action dispatch path.');

    const isolatedSource = { ...source, id: 'isolated-source', workspaceMode: 'isolated-write' };
    const integration = prepareDynamicActionMutation({
      workItem: workItem(), actions: [isolatedSource], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'integrate', objective: 'Integrate the completed isolated implementation.',
          approach: 'Apply the canonical isolated commit to the Work Item workspace.',
          expectedOutcome: 'The isolated implementation is present in the main workspace.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns integration.',
          sourceActionIds: [isolatedSource.id], workspaceMode: 'integrate',
        }],
      },
    });
    expect(integration.createdActions[0]).toMatchObject({
      workspaceMode: 'integrate', sourceActionIds: [isolatedSource.id], dependsOnStageIds: [],
    });

    const action = mutation.createdActions[0];
    const { contextSnapshot: snapshot } = buildMainlineContextSnapshot({
      ...workItem(),
      actions: [{ ...source, stageId: source.id, generation: 1, specHash: 'source-hash' }, action],
      runs: [{
        id: source.resultRunId, actionId: source.id, status: 'completed', summary: 'Research complete',
        evidence: [{ kind: 'text', label: 'research evidence' }], endedAt: 10,
      }],
      planRevision: 1,
      ledgerRevision: 1,
      planConflicts: [],
    }, action);
    expect(snapshot).not.toHaveProperty('graph');
    expect(snapshot.actionJournal.entries).toHaveLength(2);
    expect(snapshot.action.spec).toEqual(expect.objectContaining({ sourceActionIds: [source.id] }));
    expect(snapshot.sourceResults).toEqual([
      expect.objectContaining({ sourceActionId: source.id, actionId: source.id }),
    ]);
  });

  it('rejects graph fields, unknown sources, triage Actions, and generic briefs', () => {
    const source = completedAction();
    const base = {
      workItem: workItem(),
      actions: [source],
      availableVpIds: ['linus'],
    };
    const action = {
      type: 'implement',
      objective: 'Implement the dynamic execution path for this Work Item.',
      approach: 'Use focused store and Coordinator changes with regression coverage.',
      expectedOutcome: 'The dynamic execution path is runnable and verified.',
      candidateVpIds: ['linus'],
      assignmentReason: 'Linus implements code changes.',
      sourceActionIds: [source.id],
      workspaceMode: 'shared',
    };

    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{ ...action, dependsOnActionIds: [source.id] }] },
    })).toThrow(/dependency fields/i);
    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{ ...action, sourceActionIds: ['missing'] }] },
    })).toThrow(/unknown source Action/);
    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{ ...action, type: 'triage' }] },
    })).toThrow(/do not create triage Actions/);
    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{
        ...action,
        objective: 'Implement the required change with the smallest correct diff.',
      }] },
    })).toThrow(/task-specific brief/);
  });

  it('normalizes a dynamic Coordinator response without a full graph or replan decision', () => {
    const source = completedAction();
    const detail = workItem({
      goal: 'Implement the dynamic loop and stop after the verified repository files are ready.',
      actions: [source], runs: [],
    });
    const normalized = normalizeCoordinatorResponse({
      reply: 'I will implement the next verified step.',
      decision: {
        kind: 'create_actions',
        reason: 'Research produced enough evidence to implement.',
        workItemType: 'software-change',
        contractPatch: null,
        supersedeActionIds: [],
        actions: [{
          type: 'implement',
          objective: 'Implement the Coordinator-driven dispatch path.',
          approach: 'Modify the existing store and cover the lifecycle with tests.',
          expectedOutcome: 'The dynamic dispatch path runs without a precomputed graph.',
          capability: 'implement',
          candidateVpIds: ['linus'],
          assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [source.id],
          workspaceMode: 'shared',
        }],
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] });
    expect(normalized.decision.kind).toBe('create_actions');
    expect(normalized.mutation.createdActions).toHaveLength(1);

    expect(() => normalizeCoordinatorResponse({
      reply: 'I will only explain the state.',
      decision: { kind: 'answer', reason: 'No execution requested.' },
    }, detail, { automatic: true, availableVpIds: ['linus'] })).toThrow(/decision kind is invalid/);
  });

  it('generates a pending title in the existing Coordinator decision without changing the goal', () => {
    const pending = workItem({
      title: 'Keep this original requirement intact while deriving a short display label',
      titleSource: 'coordinator_pending',
      goal: 'Keep this original requirement intact while deriving a short display label',
      actions: [],
      runs: [],
    });
    expect(coordinatorSnapshot(pending).workItem).toMatchObject({
      titleSource: 'coordinator_pending',
      goal: pending.goal,
    });

    const normalized = normalizeCoordinatorResponse({
      reply: 'The request is ready for coordination.',
      decision: {
        kind: 'request_human',
        reason: 'The delivery boundary still needs confirmation.',
        title: 'Derive a concise WorkItem title',
        question: 'Which delivery target should be used?',
      },
    }, pending, { automatic: true, availableVpIds: ['linus'] });
    expect(normalized.decision.title).toBe('Derive a concise WorkItem title');
    const fallback = normalizeCoordinatorResponse({
      reply: 'The request is ready for coordination.',
      decision: {
        kind: 'request_human',
        reason: 'The delivery boundary still needs confirmation.',
        question: 'Which delivery target should be used?',
      },
    }, pending, { automatic: true, availableVpIds: ['linus'] });
    expect(fallback.decision.title).toBe(pending.goal);
    expect(normalizeCoordinatorResponse({ ...fallback, decision: {
      ...fallback.decision, title: 'x'.repeat(300),
    } }, pending, { automatic: true, availableVpIds: ['linus'] }).decision.title).toHaveLength(200);
  });

  it('persists a generated title without rejecting an otherwise valid decision', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-title-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const originalGoal = 'Preserve this detailed original requirement through Coordinator retries';
    const created = controller.create({
      ...workItem(),
      title: originalGoal,
      titleSource: 'coordinator_pending',
      goal: originalGoal,
      workDir: tempDir,
      workflowTemplate: 'coordinator-driven',
      start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:title:test');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const response = {
      reply: 'Delivery needs confirmation.',
      decision: {
        kind: 'request_human', reason: 'The delivery boundary is ambiguous.',
        question: 'Which delivery target should be used?',
      },
    };
    const titled = store.completeCoordinatorTurn(turn.turnId, response, turn.fence);
    expect(titled).toMatchObject({
      title: originalGoal,
      titleSource: 'coordinator',
      goal: originalGoal,
    });

    const current = store.getWorkItem(created.id);
    const refinement = store.claimStartedCoordinatorTurn(store.beginCoordinatorTurn(
      created.id,
      'Use my explicit title.',
      {
        revision: current.revision,
        planRevision: current.planRevision,
        ledgerRevision: current.ledgerRevision,
        coordinatorRevision: current.coordinatorRevision,
      },
    ), 'coordinator-owner');
    const contractPatch = { title: originalGoal, goal: 'A user-refined goal' };
    const refined = store.completeCoordinatorTurn(refinement.turnId, {
      reply: 'The explicit title is saved.',
      decision: {
        kind: 'request_human', reason: 'Apply the user refinement.',
        question: 'What should happen next?', contractPatch,
      },
      mutation: { contractPatch },
    }, refinement.fence);
    expect(refined).toMatchObject({
      title: originalGoal, titleSource: 'explicit', goal: 'A user-refined goal',
      requirement: originalGoal,
    });
    expect(projectWorkItemDetail(refined)).toMatchObject({ requirement: originalGoal, goal: 'A user-refined goal' });
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

  it('targets dynamic Action input and retries in place without disturbing siblings or contract identity', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-action-input-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:input:test');
    const coordinatorClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: coordinatorClaim.claim_epoch,
    });
    const actionSpec = suffix => ({
      type: 'research', objective: `Research dynamic input path ${suffix}.`,
      approach: `Exercise the durable Action ${suffix} with focused tests.`,
      expectedOutcome: `Dynamic Action ${suffix} preserves its identity.`,
      candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
      sourceActionIds: [], workspaceMode: 'read',
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: { workItemType: 'software-change', actions: [actionSpec('one'), actionSpec('two')] },
    });
    const planned = store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting two independent Actions.',
      decision: { kind: 'create_actions', reason: 'Both Actions are independently runnable.', actions: [] }, mutation,
    }, turn.fence);
    const [target, sibling] = planned.actions;
    const readyInput = controller.input(created.id, {
      text: 'Preserve this ready input.', actionId: sibling.id, generation: sibling.generation,
      revision: planned.revision, clientMessageId: 'dynamic-ready-input',
    });
    const readySibling = readyInput.actions.find(action => action.id === sibling.id);
    expect(readySibling).toMatchObject({ status: 'ready', generation: sibling.generation + 1 });

    const claimed = store.claimReadyAction('runner-owner', 5_000);
    expect(claimed.action.id).toBe(target.id);
    const runningInput = controller.input(created.id, {
      text: 'Preserve this running input.', actionId: target.id, generation: target.generation,
      revision: readyInput.revision, clientMessageId: 'dynamic-running-input',
    });
    expect(runningInput.actions.find(action => action.id === sibling.id)).toMatchObject({
      status: 'ready', generation: readySibling.generation,
    });
    expect(store.listPendingActionInputs(target.id, claimed.run.id, 'runner-owner', claimed.run.leaseEpoch))
      .toHaveLength(1);
    store.db.prepare(`UPDATE pending_action_inputs SET consumed_at = ?
      WHERE action_id = ? AND run_id = ?`).run(now++, target.id, claimed.run.id);

    const claimedSibling = store.claimReadyAction('sibling-owner', 5_000);
    expect(claimedSibling.action.id).toBe(sibling.id);

    const waiting = controller.submit(claimed.run.id, 'runner-owner', claimed.run.leaseEpoch, {
      outcome: 'waiting', summary: 'Need a decision', evidence: [], waitingReason: 'Choose a target.',
    });
    const waitingAction = waiting.actions.find(action => action.id === target.id);
    const terminalRun = store.getRun(claimed.run.id);
    const retried = controller.input(created.id, {
      text: 'Use the supported target.', actionId: target.id, generation: waitingAction.generation,
      revision: waiting.revision, clientMessageId: 'dynamic-waiting-retry',
    });
    const replacement = retried.actions.find(action => action.id === target.id);
    expect(retried.revision).toBe(waiting.revision);
    expect(replacement).toMatchObject({ id: target.id, status: 'ready', generation: waitingAction.generation + 1,
      contractRevision: waitingAction.contractRevision });
    expect(replacement.specHash).not.toBe(waitingAction.specHash);
    expect(replacement.identityHistory).toEqual(expect.arrayContaining([
      { generation: waitingAction.generation, specHash: waitingAction.specHash },
      { generation: replacement.generation, specHash: replacement.specHash },
    ]));
    expect(replacement.context).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input', inputId: 'dynamic-waiting-retry' }),
    ]));
    expect(store.getRun(claimed.run.id)).toEqual(terminalRun);
    expect(retried.actions.find(action => action.id === sibling.id)).toMatchObject({
      status: 'running', generation: readySibling.generation, currentRunId: claimedSibling.run.id,
    });
    expect(controller.input(created.id, {
      text: 'Duplicate.', actionId: target.id, generation: waitingAction.generation,
      revision: waiting.revision, clientMessageId: 'dynamic-waiting-retry',
    }).actions.find(action => action.id === target.id)).toMatchObject({ generation: replacement.generation });
    expect(() => controller.input(created.id, {
      text: 'Stale generation.', actionId: target.id, generation: waitingAction.generation,
      revision: retried.revision, clientMessageId: 'dynamic-stale-generation',
    })).toThrow(expect.objectContaining({ code: 'WORK_CENTER_INPUT_STALE' }));
    expect(() => controller.input(created.id, {
      text: 'Stale revision.', actionId: target.id, generation: replacement.generation,
      revision: retried.revision + 1, clientMessageId: 'dynamic-stale-revision',
    })).toThrow(expect.objectContaining({ code: 'WORK_CENTER_INPUT_STALE' }));

    const failedClaim = store.claimReadyAction('failed-owner', 5_000);
    expect(failedClaim.action.id).toBe(target.id);
    const failed = controller.submit(failedClaim.run.id, 'failed-owner', failedClaim.run.leaseEpoch, {
      outcome: 'failed', error: 'Focused failure', summary: 'Retry is required.', evidence: [],
    });
    const failedAction = failed.actions.find(action => action.id === target.id);
    const failedRetry = controller.input(created.id, {
      text: 'Retry the failed Action.', actionId: target.id, generation: failedAction.generation,
      revision: failed.revision, clientMessageId: 'dynamic-failed-retry',
    });
    const failedReplacement = failedRetry.actions.find(action => action.id === target.id);
    expect(failedReplacement).toMatchObject({
      id: target.id, status: 'ready', generation: replacement.generation + 1,
    });
    expect(failedRetry.actions.find(action => action.id === sibling.id)).toMatchObject({
      status: 'running', generation: readySibling.generation, currentRunId: claimedSibling.run.id,
    });

    const other = controller.create({
      ...workItem({ id: 'work-item-2', title: 'Other dynamic item' }), workDir: tempDir,
      workflowTemplate: 'coordinator-driven', start: true,
    });
    expect(() => controller.input(other.id, {
      text: 'Cross item.', actionId: target.id, generation: replacement.generation + 1,
      revision: other.revision, clientMessageId: 'dynamic-cross-item',
    })).toThrow(expect.objectContaining({ code: 'WORK_CENTER_INPUT_STALE' }));
    // Terminal eligibility can change without changing the Action identity.
    const eventsBefore = store.getWorkItemDetail(created.id).events.length;
    for (const status of ['completed', 'cancelled', 'superseded']) {
      store.db.prepare('UPDATE actions SET status = ? WHERE id = ?').run(status, target.id);
      expect(() => controller.input(created.id, {
        text: 'Late answer.', actionId: target.id, generation: failedReplacement.generation,
        revision: failedRetry.revision, clientMessageId: `terminal-${status}`,
      })).toThrow(expect.objectContaining({ code: 'WORK_CENTER_INPUT_STALE' }));
    }
    store.db.prepare("UPDATE actions SET status = 'waiting' WHERE id = ?").run(target.id);
    const openStatus = store.getWorkItem(created.id).status;
    for (const status of ['done', 'cancelled']) {
      store.db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(status, created.id);
      const expected = { actionId: target.id, generation: failedReplacement.generation, revision: failedRetry.revision };
      expect(() => controller.input(created.id, { ...expected, text: 'Too late.' }))
        .toThrow(expect.objectContaining({ code: 'WORK_CENTER_INPUT_STALE' }));
      expect(() => store.addActionInput(created.id, 'Too late.', expected))
        .toThrow(expect.objectContaining({ code: 'WORK_CENTER_INPUT_STALE' }));
    }
    store.db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(openStatus, created.id);
    expect(store.getWorkItemDetail(created.id).events.length).toBe(eventsBefore);
    controller.cancel(created.id);
    expect(() => controller.input(created.id, {
      text: 'Cancelled.', actionId: target.id, generation: failedReplacement.generation,
      revision: failedRetry.revision, clientMessageId: 'dynamic-cancelled',
    })).toThrow(expect.objectContaining({ code: 'WORK_CENTER_INPUT_STALE' }));
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

  it('persists creation-time delivery authority only for the browser path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-delivery-authority-'));
    const service = new WorkCenterService({
      yeaftDir: tempDir,
      settingsReader: () => ({ startImmediately: false }),
    });
    try {
      const browser = await service.handle('create', {
        title: 'Browser choice', goal: 'Create files', acceptanceCriteria: ['Files exist'],
        workDir: tempDir, deliveryTarget: 'pull_request', start: false,
      }, { userOriginated: true });
      expect(browser.deliveryTarget).toBe('pull_request');

      const producer = await service.handle('create', {
        title: 'Model choice', goal: 'Create files', acceptanceCriteria: ['Files exist'],
        workDir: tempDir, deliveryTarget: 'merge', start: false,
      }, { trustedProducer: true });
      expect(producer.deliveryTarget).toBeNull();
      expect(createWorkItemTool.parameters.properties).not.toHaveProperty('deliveryTarget');
    } finally {
      await service.shutdown();
    }
  });

  it('makes new service-created WorkItems Coordinator-driven while keeping the existing UX DTO', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-service-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const advance = vi.fn(() => null);
    const service = new WorkCenterService({
      yeaftDir: tempDir,
      store,
      coordinator: { advance, shutdown: vi.fn() },
      runner: null,
      settingsReader: () => ({
        startImmediately: true,
        defaultWorkDir: tempDir,
        globalInstructions: '',
        modelPolicy: { mode: 'inherit' },
        coordinatorModelPolicy: { mode: 'inherit' },
        actionInstructions: {},
        actionModelPolicies: {},
        workflows: [],
      }),
    });
    try {
      const originalGoal = 'Preserve the existing Work Center UX without replacing this requirement';
      const created = await service.handle('create', {
        title: 'Legacy display fallback', titleSource: 'coordinator_pending',
        goal: originalGoal,
        acceptanceCriteria: ['The detail DTO stays compatible'],
        workDir: tempDir,
        start: true,
      });
      expect(created).toMatchObject({
        status: 'running',
        title: originalGoal,
        titleSource: 'coordinator_pending',
        goal: originalGoal,
        coordinationMode: 'dynamic',
        workflowSnapshot: { planningMode: 'coordinator', executionMode: 'dynamic' },
        actions: [],
      });
      await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
      expect(advance).toHaveBeenCalledWith(
        expect.any(String), expect.objectContaining({ workItemId: created.id }),
      );
      expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
        expect.objectContaining({ workItemId: created.id, kind: 'work_item_started' }),
      ]);

      const explicit = await service.handle('create', {
        title: 'Keep this explicit title',
        goal: 'This separate requirement must remain unchanged',
        acceptanceCriteria: ['The title is explicit'],
        workDir: tempDir,
        start: false,
      });
      expect(explicit).toMatchObject({
        title: 'Keep this explicit title',
        titleSource: 'explicit',
        goal: 'This separate requirement must remain unchanged',
      });
    } finally {
      await service.shutdown();
    }
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

  it('closes obsolete failed Actions without treating them as acceptance evidence', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-close-failed-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const initialMailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:close');
    const initialClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const initialTurn = store.beginDynamicCoordinatorTurn(initialMailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: initialClaim.claim_epoch,
    });
    const initialMutation = prepareDynamicActionMutation({
      workItem: initialTurn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change', actions: [{
          type: 'research', objective: 'Attempt an obsolete specialist review.',
          approach: 'Run the review once and retain its failure for audit.',
          expectedOutcome: 'The failed Action can be explicitly closed.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus exercises the failed path.',
          sourceActionIds: [], workspaceMode: 'read', maxAttempts: 1,
        }],
      },
    });
    store.completeCoordinatorTurn(initialTurn.turnId, {
      reply: 'Starting the obsolete review.',
      decision: { kind: 'create_actions', reason: 'The failure fixture is runnable.', actions: [] },
      mutation: initialMutation,
    }, initialTurn.fence);
    const failedClaim = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(failedClaim.run.id, 'runner-owner', failedClaim.run.leaseEpoch, {
      outcome: 'failed', summary: '', evidence: [], error: 'No matching specialist is available',
    });
    const failedDetail = store.getWorkItemDetail(created.id);
    const reconciliation = store.listPendingDynamicCoordinatorWakes()[0];
    const closeClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const closeTurn = store.beginDynamicCoordinatorTurn(reconciliation.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: closeClaim.claim_epoch,
    });
    const replacementMutation = prepareDynamicActionMutation({
      workItem: closeTurn.detail, actions: closeTurn.detail.actions, availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change', actions: [{
          type: 'write', objective: 'Produce the canonical verified result.',
          approach: 'Use the available evidence and emit a structured output.',
          expectedOutcome: 'A concrete file output backed by canonical Run evidence.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus can produce the canonical result.',
          sourceActionIds: [failedClaim.action.id], workspaceMode: 'shared',
        }],
      },
    });
    const replanned = store.completeCoordinatorTurn(closeTurn.turnId, {
      reply: 'Closing the obsolete Action and running the viable replacement.',
      decision: { kind: 'create_actions', reason: 'The failed Action is no longer required.', actions: [] },
      mutation: replacementMutation,
    }, closeTurn.fence);
    expect(replanned.actions.find(action => action.id === failedClaim.action.id)).toMatchObject({
      status: 'failed',
    });
    const replacementClaim = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(replacementClaim.run.id, 'runner-owner', replacementClaim.run.leaseEpoch, {
      outcome: 'completed', summary: 'Canonical result produced',
      evidence: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      outputs: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    const finalWake = store.listPendingDynamicCoordinatorWakes().find(entry => entry.workItemId === created.id);
    const finalClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const finalTurn = store.beginDynamicCoordinatorTurn(finalWake.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: finalClaim.claim_epoch,
    });
    const completed = store.completeCoordinatorTurn(finalTurn.turnId, {
      reply: 'The viable work is complete.',
      decision: {
        kind: 'complete', reason: 'All criteria have canonical evidence and obsolete work is closed.',
        closeActions: [{
          actionId: failedClaim.action.id,
          reason: 'The broader evidence Action supersedes this unavailable specialist review.',
        }],
        completion: {
          summary: 'Complete',
          acceptanceResults: workItem().acceptanceCriteria.map(criterion => ({
            criterion, status: 'passed', evidenceRunIds: [replacementClaim.run.id],
          })),
          evidenceRunIds: [replacementClaim.run.id], residualRisks: [],
        },
      },
    }, finalTurn.fence);
    expect(failedDetail.actions.find(action => action.id === failedClaim.action.id).status).toBe('failed');
    expect(completed.actions.find(action => action.id === failedClaim.action.id)).toMatchObject({
      status: 'closed',
      closeReason: 'The broader evidence Action supersedes this unavailable specialist review.',
    });
    expect(completed.status).toBe('done');
    expect(completed.finalResult.evidenceRunIds).toEqual([replacementClaim.run.id]);
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

  it('rejects create_vp without one explicitly assigned existing VP', () => {
    const action = {
      type: 'create_vp', objective: 'Create a specialist for accessibility review.',
      approach: 'Author a focused persistent VP definition using the dedicated tool.',
      expectedOutcome: 'The specialist VP is available for later Work Center Actions.',
      capability: 'vp_authoring', candidateVpIds: [], assignmentReason: '',
      sourceActionIds: [], workspaceMode: 'shared',
    };
    expect(() => prepareDynamicActionMutation({
      workItem: workItem(), actions: [], availableVpIds: ['linus'],
      decision: { workItemType: 'software-change', actions: [action] },
    })).toThrow(/create_vp.*exactly one existing VP.*assignment reason/i);
    expect(() => prepareDynamicActionMutation({
      workItem: workItem(), actions: [], availableVpIds: ['linus', 'martin'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          ...action,
          candidateVpIds: ['linus', 'martin'],
          assignmentReason: 'Either VP could author the specialist.',
        }],
      },
    })).toThrow(/create_vp.*exactly one existing VP/i);
    expect(() => prepareDynamicActionMutation({
      workItem: workItem(), actions: [],
      decision: {
        workItemType: 'software-change',
        actions: [{
          ...action,
          candidateVpIds: ['linus'],
          assignmentReason: 'Linus would author the specialist.',
        }],
      },
    })).toThrow(/create_vp.*available VP inventory/i);
  });

  it('treats create_vp as mutating even when the model labels it read-only', async () => {
    const readCreateVp = {
      type: 'create_vp', objective: 'Create a specialist for accessibility review.',
      approach: 'Persist a focused VP definition in the Agent-global VP library.',
      expectedOutcome: 'The specialist VP is available for later Actions.',
      capability: 'vp_authoring', candidateVpIds: ['linus'],
      assignmentReason: 'Linus owns VP authoring.', sourceActionIds: [], workspaceMode: 'read',
    };
    expect(() => prepareDynamicActionMutation({
      workItem: workItem(), actions: [], availableVpIds: ['linus'],
      decision: { workItemType: 'software-change', actions: [readCreateVp] },
    })).toThrow(/create_vp.*read/i);
    expect(() => normalizeCoordinatorResponse({
      reply: 'Creating a specialist.',
      decision: {
        kind: 'create_actions', reason: 'A specialist is missing.',
        workItemType: 'software-change', actions: [readCreateVp],
      },
    }, workItem({ deliveryTarget: null, actions: [], runs: [] }), {
      automatic: true, availableVpIds: ['linus'],
    })).toThrow(/delivery boundary.*request_human/i);

    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-read-create-vp-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const forgedSpec = {
      type: 'create_vp', stageId: 'read-create-vp', status: 'ready',
      assignmentPolicy: {
        mode: 'planned', capability: 'vp_authoring', candidateVpIds: ['linus'],
        fixedVpId: null, assignmentReason: 'Linus owns VP authoring.', separateFromStageTypes: [],
      },
      modelPolicy: null, sourceActionIds: [], dependsOnStageIds: [], workspaceMode: 'read',
      changesRequestedStageId: null, requiredRole: '', instruction: 'Create a specialist.',
      brief: {
        objective: readCreateVp.objective, approach: readCreateVp.approach,
        expectedOutcome: readCreateVp.expectedOutcome,
      },
      maxAttempts: 1,
    };
    const mailbox = store.enqueueCoordinatorMailbox(
      created.id, 'work_item_created', {}, 'dynamic:create:read-create-vp',
    );
    const coordinatorClaim = store.claimCoordinatorMailbox(created.id, 'read-create-vp-coordinator');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'read-create-vp-coordinator', claimEpoch: coordinatorClaim.claim_epoch,
    });
    expect(() => store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Creating the specialist.',
      decision: { kind: 'create_actions', reason: 'A specialist is missing.', actions: [] },
      mutation: {
        workItemType: 'software-change', contractPatch: null, closeActions: [],
        supersedeActionIds: [], createdActions: [{ ...forgedSpec, id: 'read-create-vp' }],
      },
    }, turn.fence)).toThrow(/create_vp.*read workspace mode/i);

    const forged = store.createNextAction(created.id, { ...forgedSpec, type: 'custom' });
    store.db.prepare(`UPDATE actions SET type = 'create_vp', creation_source = 'dynamic_coordinator',
      workspace_mode = 'read' WHERE id = ?`).run(forged.id);
    store.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ? WHERE id = ?`)
      .run(forged.id, created.id);
    const claim = store.claimReadyAction('read-create-vp-runner', 5_000);
    const registry = new Registry();
    registry.setVp({ id: 'linus', name: 'Linus', role: 'Engineer', traits: ['engineering'], persona: 'Build.' });
    const runner = new WorkItemRunner({
      store, yeaftDir: tempDir, registry,
      runtimeProvider: vi.fn(async () => { throw new Error('provider dispatch must not occur'); }),
    });
    await expect(runner.run({
      ...claim, ownerBootId: 'read-create-vp-runner', signal: new AbortController().signal,
    })).rejects.toThrow(/create_vp.*read workspace mode/i);
    expect(runner.runtimeProvider).not.toHaveBeenCalled();
    expect(store.getRun(claim.run.id).toolPolicySnapshot).toBeNull();
  });

  it('provisions a specialized VP through an assigned VP authoring Action', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-vp-provision-'));
    const registry = new Registry();
    registry.setVp({
      id: 'linus', name: 'Linus', role: 'Systems Engineer', traits: ['systems', 'engineering'],
      persona: 'Build the smallest correct system.',
    });
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:vp-provision');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change', actions: [{
          type: 'create_vp', objective: 'Create a specialist for accessibility review.',
          approach: 'Have Linus author a focused persistent VP definition using the dedicated tool.',
          expectedOutcome: 'The specialist VP is available for later Work Center Actions.',
          capability: 'vp_authoring', candidateVpIds: ['linus'],
          assignmentReason: 'Linus is the best available systems-oriented VP to author the specialist.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Creating the missing specialist.',
      decision: { kind: 'create_actions', reason: 'No existing VP covers the required specialty.', actions: [] },
      mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    let adapterCalls = 0;
    const adapter = {
      async *stream(params) {
        params.onRequestStart?.();
        adapterCalls += 1;
        if (adapterCalls === 1) {
          const tool = params.tools.find(candidate => candidate.name === 'CreateWorkItemVp');
          expect(tool).toBeTruthy();
          yield { type: 'tool_call', id: 'create-vp', name: 'CreateWorkItemVp', input: {
            vpId: 'accessibility-reviewer', displayName: 'Accessibility Reviewer',
            role: 'Accessibility reviewer', area: 'quality', traits: ['accessibility', 'review'],
            persona: 'Review user-facing behavior for accessibility with concrete evidence.',
          } };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: JSON.stringify({
          outcome: 'completed', summary: 'Specialist VP created.',
          evidence: [{ kind: 'text', label: 'VP accessibility-reviewer created' }],
          acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
            criterion, status: 'deferred', evidence: 'Specialist creation is an intermediate step',
          })),
        }) };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const runner = new WorkItemRunner({
      store, yeaftDir: tempDir,
      runtimeProvider: async () => ({
        defaultWorkDir: tempDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter,
      }),
      registry,
    });
    const result = await runner.run({
      ...acquired, ownerBootId: 'runner-owner', signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: 'completed', summary: 'Specialist VP created.' });
    expect(store.getRun(acquired.run.id).toolPolicySnapshot.allowedToolNames)
      .toContain('CreateWorkItemVp');

    store.interruptRun(acquired.run.id, 'runner-owner', acquired.run.leaseEpoch, 'Test cleanup after direct Runner execution');
    const forgedDir = mkdtempSync(join(tmpdir(), 'yeaft-forged-create-vp-'));
    const forgedStore = new WorkItemStore(join(forgedDir, 'work-center.db'));
    const forgedController = new WorkflowController(forgedStore);
    const forged = forgedController.create({
      ...workItem({ id: 'forged-create-vp-work-item' }),
      workDir: forgedDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const forgedSpec = {
      type: 'create_vp', stageId: 'forged-create-vp', status: 'ready',
      assignmentPolicy: {
        mode: 'planned', capability: 'vp_authoring', candidateVpIds: ['linus'],
        fixedVpId: null, assignmentReason: 'Forged outside Coordinator mutation.',
        separateFromStageTypes: [],
      },
      modelPolicy: null, sourceActionIds: [], dependsOnStageIds: [],
      workspaceMode: 'shared', changesRequestedStageId: null, requiredRole: '',
      brief: {
        objective: 'Create an unauthorized specialist VP.',
        approach: 'Attempt to reach the Agent-global VP library.',
        expectedOutcome: 'The Runner rejects the forged Action before tool exposure.',
      },
      instruction: 'Attempt unauthorized VP creation.', maxAttempts: 1,
    };
    expect(() => forgedStore.createNextAction(forged.id, forgedSpec))
      .toThrow(/only be persisted by the dynamic WorkItem Coordinator/i);
    const forgedAction = forgedStore.createNextAction(forged.id, {
      ...forgedSpec, type: 'custom', stageId: 'forged-custom',
    });
    forgedStore.db.prepare(`UPDATE actions SET type = 'create_vp' WHERE id = ?`).run(forgedAction.id);
    forgedStore.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ? WHERE id = ?`)
      .run(forgedAction.id, forged.id);
    const forgedClaim = forgedStore.claimReadyAction('forged-runner-owner', 5_000);
    expect(forgedClaim?.action.id).toBe(forgedAction.id);
    const forgedRunner = new WorkItemRunner({
      store: forgedStore, yeaftDir: forgedDir,
      runtimeProvider: async () => ({
        defaultWorkDir: forgedDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter,
      }),
      registry,
    });
    await expect(forgedRunner.run({
      ...forgedClaim, ownerBootId: 'forged-runner-owner', signal: new AbortController().signal,
    })).rejects.toThrow(/create_vp.*Coordinator provenance/i);
    expect(forgedStore.getRun(forgedClaim.run.id).toolPolicySnapshot).toBeNull();
    forgedStore.db.prepare(`UPDATE actions SET creation_source = 'dynamic_coordinator',
      assignment_policy = ? WHERE id = ?`).run(JSON.stringify({
      mode: 'planned', capability: 'vp_authoring', candidateVpIds: ['missing-vp'],
      fixedVpId: null, assignmentReason: 'The assigned VP no longer exists.',
      separateFromStageTypes: [],
    }), forgedAction.id);
    const unavailableAction = forgedStore.getAction(forgedAction.id);
    await expect(forgedRunner.run({
      workItem: forgedStore.getWorkItem(forged.id), action: unavailableAction,
      run: forgedClaim.run, ownerBootId: 'forged-runner-owner',
      signal: new AbortController().signal,
    })).rejects.toThrow(/one explicit existing VP assignment/i);
    forgedStore.close();
    rmSync(forgedDir, { recursive: true, force: true });
    expect(registry.getVp('accessibility-reviewer')).toMatchObject({
      id: 'accessibility-reviewer', role: 'Accessibility reviewer',
    });
    expect(existsSync(join(tempDir, 'virtual-persons', 'accessibility-reviewer', 'role.md'))).toBe(true);
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

  it('persists an explicit delivery target and lets it authorize mutating Actions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-delivery-target-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), goal: 'Implement the requested change.', deliveryTarget: 'pull_request',
      workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const detail = store.getWorkItemDetail(created.id);
    expect(detail.deliveryTarget).toBe('pull_request');
    expect(() => normalizeCoordinatorResponse({
      reply: 'The pull-request boundary is explicit.',
      decision: {
        kind: 'create_actions', reason: 'Implementation may proceed.',
        workItemType: 'software-change', actions: [{
          type: 'implement', objective: 'Implement the requested change.',
          approach: 'Modify the repository and verify focused tests.',
          expectedOutcome: 'A verified change ready for the requested pull request.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] })).not.toThrow();
  });

  it('rejects unsafe and kind-swapped output references across persistence and projection', () => {
    const userinfoUrl = 'https://user:pass@example.test/private';
    const signedUrl = 'https://downloads.example.test/artifact.zip?X-Amz-Credential=AKIASECRET&X-Amz-Signature=deadbeef';
    const fragmentTokenUrl = 'https://example.test/callback#access_token=secret-token';
    const encodedFragmentUrl = 'https://example.test/callback#state=ok%26access_token%3Dsecret-token';
    const nestedQueryUrl = 'https://example.test/callback?redirect=https%3A%2F%2Fnested.test%2Fcb%3Faccess_token%3Dsecret-token';
    const nestedAssignmentUrl = 'https://example.test/callback?state=access_token%3Dsecret-token';
    const kindSwappedUrls = [
      ['Userinfo', userinfoUrl],
      ['Signed', signedUrl],
      ['Encoded fragment', encodedFragmentUrl],
      ['Nested query', nestedQueryUrl],
    ].flatMap(([label, ref]) => ['file', 'commit'].map(kind => ({
      kind, label: `${label} disguised as ${kind}`, ref,
    })));
    const parsed = parseStructuredResult(JSON.stringify({
      outcome: 'completed', summary: 'Mixed outputs', evidence: ['verified'],
      outputs: [
        { kind: 'file', label: 'Traversal', ref: '../secret.txt' },
        { kind: 'file', label: 'Absolute', ref: '/tmp/secret.txt' },
        { kind: 'link', label: 'Credential URL', ref: userinfoUrl },
        { kind: 'link', label: 'Signed URL', ref: signedUrl },
        { kind: 'link', label: 'Fragment token', ref: fragmentTokenUrl },
        { kind: 'link', label: 'Bare fragment token', ref: 'https://example.test/callback#token' },
        { kind: 'link', label: 'Encoded fragment token', ref: encodedFragmentUrl },
        { kind: 'link', label: 'Nested query token', ref: nestedQueryUrl },
        { kind: 'link', label: 'Nested assignment token', ref: nestedAssignmentUrl },
        ...kindSwappedUrls,
        { kind: 'commit', label: 'Commit', ref: '0123456789abcdef0123456789abcdef01234567' },
        { kind: 'commit', label: 'Commit ref', ref: 'refs/tags/release-1' },
        { kind: 'pr', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1' },
        { kind: 'pr', label: 'Ordinary page disguised as PR', ref: 'https://example.test/artifact' },
        { kind: 'link', label: 'Safe URL', ref: 'https://example.test/artifact?page=1#download' },
        { kind: 'file', label: 'Safe file', ref: './docs/design.md' },
      ],
      acceptanceChecks: [],
    }), 'write');
    expect(parsed.outputs).toEqual([
      { kind: 'commit', label: 'Commit', ref: '0123456789abcdef0123456789abcdef01234567' },
      { kind: 'commit', label: 'Commit ref', ref: 'refs/tags/release-1' },
      { kind: 'pr', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1' },
      { kind: 'link', label: 'Safe URL', ref: 'https://example.test/artifact?page=1#download' },
      { kind: 'file', label: 'Safe file', ref: 'docs/design.md' },
    ]);

    const projected = projectWorkItemDetail({
      ...workItem(),
      revision: 1,
      planRevision: 1,
      ledgerRevision: 1,
      coordinatorRevision: 1,
      status: 'running',
      actions: [{
        id: 'unsafe-output-action', stageId: 'unsafe-output-action', type: 'write',
        status: 'completed', resultRunId: 'unsafe-output-run', generation: 1,
        sourceActionIds: [], dependsOnStageIds: [],
      }],
      runs: [{
        id: 'unsafe-output-run', actionId: 'unsafe-output-action', status: 'completed',
        outputs: [
          { kind: 'link', label: 'Signed URL', ref: signedUrl },
          { kind: 'link', label: 'Fragment token', ref: fragmentTokenUrl },
          { kind: 'link', label: 'Encoded fragment token', ref: encodedFragmentUrl },
          { kind: 'link', label: 'Nested query token', ref: nestedQueryUrl },
          { kind: 'link', label: 'Nested assignment token', ref: nestedAssignmentUrl },
          ...kindSwappedUrls,
        ],
      }],
      messages: [],
      events: [],
      finalResult: {
        summary: 'Unsafe legacy result', acceptanceResults: [], evidenceRunIds: [],
        outputs: [
          { kind: 'link', label: 'Signed URL', ref: signedUrl, runId: 'unsafe-output-run' },
          { kind: 'link', label: 'Encoded fragment token', ref: encodedFragmentUrl, runId: 'unsafe-output-run' },
          { kind: 'link', label: 'Nested query token', ref: nestedQueryUrl, runId: 'unsafe-output-run' },
          { kind: 'link', label: 'Nested assignment token', ref: nestedAssignmentUrl, runId: 'unsafe-output-run' },
          ...kindSwappedUrls.map(output => ({ ...output, runId: 'unsafe-output-run' })),
          { kind: 'file', label: 'Safe legacy output', ref: 'docs/legacy.md', runId: 'safe-output-run' },
        ],
        residualRisks: [],
      },
    });
    expect(projected.outputs).toEqual([]);
    expect(projected.finalResult.outputs).toEqual([{
      kind: 'file', label: 'Safe legacy output', ref: 'docs/legacy.md', runId: 'safe-output-run',
    }]);
    expect(projected.mainline.actions[0].canonicalResult.outputs).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain('AKIASECRET');
    expect(JSON.stringify(projected)).not.toContain('secret-token');

    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-unsafe-output-persistence-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const action = store.createNextAction(created.id, {
      type: 'custom', stageId: 'unsafe-output-action', status: 'ready',
      assignmentPolicy: null, modelPolicy: null, sourceActionIds: [], dependsOnStageIds: [],
      workspaceMode: 'shared', changesRequestedStageId: null, requiredRole: '',
      instruction: 'Produce outputs.', brief: {
        objective: 'Produce outputs.', approach: 'Return structured output references.',
        expectedOutcome: 'Only safe output references persist.',
      }, maxAttempts: 1,
    });
    store.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ? WHERE id = ?`)
      .run(action.id, created.id);
    const claim = store.claimReadyAction('unsafe-output-runner', 5_000);
    controller.submit(claim.run.id, 'unsafe-output-runner', claim.run.leaseEpoch, {
      outcome: 'completed', summary: 'Output normalization complete', evidence: ['verified'],
      outputs: [
        { kind: 'link', label: 'Encoded fragment token', ref: encodedFragmentUrl },
        { kind: 'link', label: 'Nested query token', ref: nestedQueryUrl },
        { kind: 'link', label: 'Nested assignment token', ref: nestedAssignmentUrl },
        ...kindSwappedUrls,
        { kind: 'link', label: 'Safe URL', ref: 'https://example.test/artifact?page=1#download' },
      ],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'verified',
      })),
    });
    expect(store.getRun(claim.run.id).outputs).toEqual([
      { kind: 'link', label: 'Safe URL', ref: 'https://example.test/artifact?page=1#download' },
    ]);
    const mainlineDetail = store.getWorkItemDetail(created.id);
    const mainline = buildMainlineContextSnapshot(mainlineDetail, action).contextSnapshot;
    expect(mainline.canonicalCompletedResultsIndex[action.id]).toMatchObject({ runId: claim.run.id });
    expect(mainlineDetail.runs.find(run => run.id === claim.run.id).outputs).toEqual([
      { kind: 'link', label: 'Safe URL', ref: 'https://example.test/artifact?page=1#download' },
    ]);
    const browser = projectWorkItemDetail(store.getWorkItemDetail(created.id));
    expect(JSON.stringify(browser)).not.toContain('secret-token');
    expect(browser.outputs).toEqual([
      expect.objectContaining({ kind: 'link', ref: 'https://example.test/artifact?page=1#download' }),
    ]);

    const mergeItem = controller.create({
      ...workItem({ id: 'kind-swapped-merge-item', deliveryTarget: 'merge' }),
      workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mergeAction = store.createNextAction(mergeItem.id, {
      type: 'custom', stageId: 'kind-swapped-merge-action', status: 'ready',
      assignmentPolicy: null, modelPolicy: null, sourceActionIds: [], dependsOnStageIds: [],
      workspaceMode: 'shared', changesRequestedStageId: null, requiredRole: '',
      instruction: 'Report the merged commit.', brief: {
        objective: 'Report the merged commit.', approach: 'Return the verified commit identifier.',
        expectedOutcome: 'A canonical commit output identifies the merged revision.',
      }, maxAttempts: 1,
    });
    store.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ? WHERE id = ?`)
      .run(mergeAction.id, mergeItem.id);
    const mergeClaim = store.claimReadyAction('kind-swapped-merge-runner', 5_000);
    controller.submit(mergeClaim.run.id, 'kind-swapped-merge-runner', mergeClaim.run.leaseEpoch, {
      outcome: 'completed', summary: 'Merge reported', evidence: ['merge verified'],
      outputs: [{ kind: 'commit', label: 'Merged commit', ref: encodedFragmentUrl }],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'merge verified',
      })),
    });
    const mergeWake = store.listPendingDynamicCoordinatorWakes()
      .find(entry => entry.workItemId === mergeItem.id);
    const mergeCoordinatorClaim = store.claimCoordinatorMailbox(mergeItem.id, 'merge-coordinator');
    const mergeTurn = store.beginDynamicCoordinatorTurn(mergeWake.id, {
      ownerBootId: 'merge-coordinator', claimEpoch: mergeCoordinatorClaim.claim_epoch,
    });
    expect(() => store.completeCoordinatorTurn(mergeTurn.turnId, {
      reply: 'The merge is complete.',
      decision: {
        kind: 'complete', reason: 'The merged commit is reported.',
        completion: {
          summary: 'Merged',
          acceptanceResults: workItem().acceptanceCriteria.map(criterion => ({
            criterion, status: 'passed', evidenceRunIds: [mergeClaim.run.id],
          })),
          evidenceRunIds: [mergeClaim.run.id], residualRisks: [],
        },
      },
    }, mergeTurn.fence)).toThrow(/canonical commit output/i);
    expect(store.getRun(mergeClaim.run.id).outputs).toEqual([]);
    const mergeDetail = store.getWorkItemDetail(mergeItem.id);
    expect(mergeDetail.status).not.toBe('done');
    expect(buildMainlineProjection(mergeDetail).canonicalActionResults[mergeAction.id].outputs).toEqual([]);
    expect(projectWorkItemDetail(mergeDetail).outputs).toEqual([]);
    expect(JSON.stringify(projectWorkItemDetail(mergeDetail))).not.toContain('secret-token');
  });

  it('canonicalizes Bitbucket Server overview URLs and rejects opaque PR suffixes across every output boundary', () => {
    const canonicalPr = 'https://github.com/example/repo/pull/1';
    const bitbucketServerProjectPr = 'https://stash.example.test/projects/PROJ/repos/repo/pull-requests/17';
    const bitbucketServerUserPr = 'https://stash.example.test/users/alice/repos/repo/pull-requests/18';
    const canonicalPrOutputs = [
      { kind: 'pr', label: 'GitHub pull request', ref: canonicalPr },
      {
        kind: 'pr', label: 'GitLab merge request',
        ref: 'https://gitlab.example.test/group/subgroup/repo/-/merge_requests/2',
      },
      {
        kind: 'pr', label: 'Bitbucket pull request',
        ref: 'https://bitbucket.org/workspace/repo/pull-requests/3',
      },
      {
        kind: 'pr', label: 'Azure pull request',
        ref: 'https://dev.azure.com/org/project/_git/repo/pullrequest/4',
      },
      {
        kind: 'pr', label: 'Bitbucket project pull request',
        ref: bitbucketServerProjectPr,
      },
      {
        kind: 'pr', label: 'Bitbucket user pull request',
        ref: bitbucketServerUserPr,
      },
    ];
    const acceptedPrInputs = [
      ...canonicalPrOutputs.slice(0, 4),
      {
        kind: 'pr', label: 'Bitbucket project pull request',
        ref: `${bitbucketServerProjectPr}/overview`,
      },
      {
        kind: 'pr', label: 'Bitbucket user pull request',
        ref: `${bitbucketServerUserPr}/overview`,
      },
    ];
    const unsafePrUrls = [
      `${canonicalPr}?redirect=https://user:pass@nested.example/private`,
      `${canonicalPr}?redirect=https%3A%2F%2Fuser%3Apass%40nested.example%2Fprivate`,
      `${canonicalPr}?redirect=https%253A%252F%252Fuser%253Apass%2540nested.example%252Fprivate`,
      `${canonicalPr}?payload=%7B%22access_token%22%3A%22secret-token%22%7D`,
      `${canonicalPr}?payload=%7B%22password%22%3A%22secret-password%22%7D`,
      `${canonicalPr}#discussion`,
      'https://github.com/user:pass@nested.example/repo/pull/5',
      'https://github.com/access_token=secret-token/repo/pull/6',
      'https://github.com/user%3Apass%40nested.example/repo/pull/7',
      'https://github.com/user%253Apass%2540nested.example/repo/pull/8',
      'https://github.com/%7B%22access_token%22%3A%22secret-token%22%7D/repo/pull/9',
      'https://gitlab.example.test/group/password=secret/repo/-/merge_requests/10',
      `${bitbucketServerProjectPr}/diff`,
      `${bitbucketServerUserPr}/arbitrary-suffix`,
    ];
    const unsafeOutputs = unsafePrUrls.map((ref, index) => ({
      kind: 'pr', label: `Unsafe pull request ${index + 1}`, ref,
    }));
    const parsed = parseStructuredResult(JSON.stringify({
      outcome: 'completed', summary: 'Pull request reported', evidence: ['verified'],
      outputs: [
        ...unsafeOutputs,
        ...acceptedPrInputs,
        { kind: 'pr', label: 'Canonicalized pull request', ref: `${canonicalPr}/?` },
      ],
      acceptanceChecks: [],
    }), 'write');
    expect(parsed.outputs).toEqual(canonicalPrOutputs);

    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-canonical-pr-output-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const criteria = workItem().acceptanceCriteria;
    const createAction = (itemId, stageId) => {
      const action = store.createNextAction(itemId, {
        type: 'custom', stageId, status: 'ready', assignmentPolicy: null, modelPolicy: null,
        sourceActionIds: [], dependsOnStageIds: [], workspaceMode: 'shared',
        changesRequestedStageId: null, requiredRole: '', instruction: 'Report the pull request.',
        brief: {
          objective: 'Report the pull request.',
          approach: 'Return its canonical delivery identifier.',
          expectedOutcome: 'A canonical pull request URL identifies the delivered change.',
        },
        maxAttempts: 1,
      });
      store.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ? WHERE id = ?`)
        .run(action.id, itemId);
      return action;
    };
    const completion = runId => ({
      summary: 'Pull request delivered',
      acceptanceResults: criteria.map(criterion => ({
        criterion, status: 'passed', evidenceRunIds: [runId],
      })),
      evidenceRunIds: [runId], residualRisks: [],
    });

    const unsafeItem = controller.create({
      ...workItem({ id: 'unsafe-pr-item', deliveryTarget: 'pull_request' }),
      workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const unsafeAction = createAction(unsafeItem.id, 'unsafe-pr-action');
    const unsafeClaim = store.claimReadyAction('unsafe-pr-runner', 5_000);
    controller.submit(unsafeClaim.run.id, 'unsafe-pr-runner', unsafeClaim.run.leaseEpoch, {
      outcome: 'completed', summary: 'Opaque pull request reported', evidence: ['verified'],
      outputs: unsafeOutputs,
      acceptanceChecks: criteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'verified',
      })),
    });
    expect(JSON.parse(store.db.prepare('SELECT outputs FROM runs WHERE id = ?')
      .get(unsafeClaim.run.id).outputs)).toEqual([]);
    expect(store.getRun(unsafeClaim.run.id).outputs).toEqual([]);
    const unsafeDetail = store.getWorkItemDetail(unsafeItem.id);
    expect(buildMainlineProjection(unsafeDetail).canonicalActionResults[unsafeAction.id].outputs).toEqual([]);
    const unsafeSnapshot = buildMainlineContextSnapshot(unsafeDetail, unsafeAction).contextSnapshot;
    expect(unsafeSnapshot.canonicalCompletedResultsIndex[unsafeAction.id]).toMatchObject({
      runId: unsafeClaim.run.id, status: 'completed',
    });
    const unsafeBrowser = projectWorkItemDetail({
      ...unsafeDetail,
      finalResult: {
        summary: 'Legacy unsafe result', acceptanceResults: [], evidenceRunIds: [unsafeClaim.run.id],
        outputs: unsafeOutputs.map(output => ({ ...output, runId: unsafeClaim.run.id })),
        residualRisks: [],
      },
    });
    expect(unsafeBrowser.outputs).toEqual([]);
    expect(unsafeBrowser.finalResult.outputs).toEqual([]);
    for (const ref of unsafePrUrls) expect(JSON.stringify(unsafeBrowser)).not.toContain(ref);

    const unsafeWake = store.listPendingDynamicCoordinatorWakes()
      .find(entry => entry.workItemId === unsafeItem.id);
    const unsafeCoordinatorClaim = store.claimCoordinatorMailbox(unsafeItem.id, 'unsafe-pr-coordinator');
    const unsafeTurn = store.beginDynamicCoordinatorTurn(unsafeWake.id, {
      ownerBootId: 'unsafe-pr-coordinator', claimEpoch: unsafeCoordinatorClaim.claim_epoch,
    });
    expect(() => store.completeCoordinatorTurn(unsafeTurn.turnId, {
      reply: 'The pull request is complete.',
      decision: {
        kind: 'complete', reason: 'The reported pull request is delivery evidence.',
        completion: completion(unsafeClaim.run.id),
      },
    }, unsafeTurn.fence)).toThrow(/canonical pr output/i);
    expect(store.getWorkItemDetail(unsafeItem.id)).toMatchObject({ status: 'running', finalResult: null });

    const canonicalCases = [
      { name: 'project', ref: bitbucketServerProjectPr },
      { name: 'user', ref: bitbucketServerUserPr },
    ];
    for (const canonicalCase of canonicalCases) {
      const canonicalItem = controller.create({
        ...workItem({
          id: `canonical-${canonicalCase.name}-pr-item`, deliveryTarget: 'pull_request',
        }),
        workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
      });
      const canonicalAction = createAction(
        canonicalItem.id, `canonical-${canonicalCase.name}-pr-action`,
      );
      const runnerOwner = `canonical-${canonicalCase.name}-pr-runner`;
      const canonicalClaim = store.claimReadyAction(runnerOwner, 5_000);
      controller.submit(canonicalClaim.run.id, runnerOwner, canonicalClaim.run.leaseEpoch, {
        outcome: 'completed', summary: 'Canonical pull request reported', evidence: ['verified'],
        outputs: [{
          kind: 'pr', label: 'Pull request', ref: `${canonicalCase.ref}/overview`,
        }],
        acceptanceChecks: criteria.map(criterion => ({
          criterion, status: 'passed', evidence: 'verified',
        })),
      });
      expect(store.getRun(canonicalClaim.run.id).outputs).toEqual([
        { kind: 'pr', label: 'Pull request', ref: canonicalCase.ref },
      ]);
      expect(buildMainlineProjection(store.getWorkItemDetail(canonicalItem.id))
        .canonicalActionResults[canonicalAction.id].outputs).toEqual([
        { kind: 'pr', label: 'Pull request', ref: canonicalCase.ref },
      ]);
      expect(projectWorkItemDetail(store.getWorkItemDetail(canonicalItem.id)).outputs).toEqual([
        expect.objectContaining({ kind: 'pr', ref: canonicalCase.ref }),
      ]);
      const canonicalWake = store.listPendingDynamicCoordinatorWakes()
        .find(entry => entry.workItemId === canonicalItem.id);
      const coordinatorOwner = `canonical-${canonicalCase.name}-pr-coordinator`;
      const canonicalCoordinatorClaim = store.claimCoordinatorMailbox(
        canonicalItem.id, coordinatorOwner,
      );
      const canonicalTurn = store.beginDynamicCoordinatorTurn(canonicalWake.id, {
        ownerBootId: coordinatorOwner, claimEpoch: canonicalCoordinatorClaim.claim_epoch,
      });
      const completed = store.completeCoordinatorTurn(canonicalTurn.turnId, {
        reply: 'The pull request is complete.',
        decision: {
          kind: 'complete', reason: 'The canonical pull request is delivery evidence.',
          completion: completion(canonicalClaim.run.id),
        },
      }, canonicalTurn.fence);
      expect(completed).toMatchObject({ status: 'done' });
      expect(completed.finalResult.outputs).toEqual([
        {
          kind: 'pr', label: 'Pull request', ref: canonicalCase.ref,
          runId: canonicalClaim.run.id,
        },
      ]);
      expect(projectWorkItemDetail(completed).finalResult.outputs).toEqual([
        expect.objectContaining({
          kind: 'pr', ref: canonicalCase.ref, runId: canonicalClaim.run.id,
        }),
      ]);
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
