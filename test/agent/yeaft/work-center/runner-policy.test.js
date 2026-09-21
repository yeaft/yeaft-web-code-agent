import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { AdapterRouter } from '../../../../agent/yeaft/llm/router.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { resolvePlanningWorkflowSnapshot } from '../../../../agent/yeaft/work-center/workflow.js';
import {
  createProposeWorkItemActionsTool,
  createRequestWorkItemReplanTool,
  createSubmitWorkItemPlanTool,
  createSubmitWorkItemReplanTool,
  createWorkItemToolRegistry,
  parseStructuredResult,
  renderPendingActionInput,
  workItemToolPolicySnapshot,
  resolveWorkItemWorkDir,
  WorkItemRunner,
} from '../../../../agent/yeaft/work-center/runner.js';

describe('Work Center tool policy', () => {
  let workDir;
  let outsideDir;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-policy-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-outside-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });





  it('protects attachment-mode tool policy', async () => {
    const attachmentDir = join(outsideDir, 'attachments');
    mkdirSync(attachmentDir);
    const attachmentPath = join(attachmentDir, 'evidence.txt');
    writeFileSync(attachmentPath, 'evidence');
    const ref = 'work-item-attachment://attachment-1/evidence.txt';
    const registry = createWorkItemToolRegistry({
      workDir,
      attachmentFiles: [{ ref, path: attachmentPath, root: attachmentDir }],
      isRunActive: () => true,
    });
    expect(registry.getAllTools().map(tool => tool.name)).not.toContain('Bash');
    await expect(registry.execute('Bash', {
      command: `find ${JSON.stringify(attachmentDir)} -type f -delete`,
      cwd: workDir,
      background: false,
    }, {})).rejects.toThrow(/Unknown tool: Bash/);
    expect(readFileSync(attachmentPath, 'utf8')).toBe('evidence');
    expect(workItemToolPolicySnapshot(workDir, [ref])).toMatchObject({
      allowedToolNames: expect.not.arrayContaining(['Bash']),
      shell: { enabled: false },
    });
    expect(workItemToolPolicySnapshot(workDir, [])).toMatchObject({
      allowedToolNames: expect.arrayContaining(['Bash']),
      shell: { enabled: true },
    });
  });

  it('requires review decisions on planning control tools and preserves them', async () => {
    const workItem = { planRevision: 3 };
    const currentAction = { id: 'review-id', stageId: 'review-security', type: 'review' };
    const replanCollector = { value: null };
    const replanTool = createRequestWorkItemReplanTool({
      workItem,
      collector: replanCollector,
      isRunActive: () => true,
      currentAction,
    });
    expect(replanTool.parameters.required).toContain('reviewDecision');
    expect(replanTool.parameters.properties.reviewDecision.const).toBe('changes_requested');
    const replanInput = {
      summary: 'The review found blockers.',
      evidence: ['Security finding at runtime.js:42'],
      acceptanceChecks: [],
      proposalId: 'replan-review-findings',
      basePlanRevision: 3,
      reason: 'The unfinished topology needs remediation and another review.',
    };
    await expect(replanTool.execute(replanInput))
      .rejects.toThrow(/reviewDecision.*changes_requested/);
    await expect(replanTool.execute({ ...replanInput, reviewDecision: 'approved' }))
      .rejects.toThrow(/reviewDecision.*changes_requested/);
    expect(replanCollector.value).toBeNull();
    await replanTool.execute({ ...replanInput, reviewDecision: 'changes_requested' });
    expect(replanCollector.value).toMatchObject({
      kind: 'replan',
      input: { reviewDecision: 'changes_requested' },
    });

    const expansionCollector = { value: null };
    const expansionTool = createProposeWorkItemActionsTool({
      vps: [{ id: 'omni', role: 'developer' }],
      workItem: { planRevision: 3 },
      actions: [],
      collector: expansionCollector,
      isRunActive: () => true,
      currentAction,
    });
    expect(expansionTool.parameters.required).toContain('reviewDecision');
    expect(expansionTool.parameters.properties.reviewDecision.const).toBe('changes_requested');

    const nonReviewTool = createRequestWorkItemReplanTool({
      workItem,
      collector: { value: null },
      isRunActive: () => true,
      currentAction: { id: 'implementation-id', stageId: 'implementation', type: 'implement' },
    });
    expect(nonReviewTool.parameters.required).not.toContain('reviewDecision');
    expect(nonReviewTool.parameters.properties).not.toHaveProperty('reviewDecision');

    expect(parseStructuredResult(JSON.stringify({
      outcome: 'completed',
      summary: 'Review complete',
      evidence: ['review evidence'],
      acceptanceChecks: [],
    }), 'review')).toMatchObject({
      outcome: 'failed',
      error: 'Completed review requires approved or changes_requested',
    });
  });

  it('persists review decisions through explicit replan and additive control tools', async () => {
    const createReviewFixture = id => {
      const store = new WorkItemStore(join(workDir, `${id}.db`));
      const controller = new WorkflowController(store, { listAvailableVpIds: () => ['omni'] });
      const criterion = 'Review findings enter an executable remediation path';
      const item = controller.create({
        id,
        title: 'Route review findings',
        goal: 'Preserve explicit review decisions and their plan mutations',
        acceptanceCriteria: [criterion],
        workflowTemplate: 'ai-planned',
        workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
        workDir,
        start: true,
      });
      const triage = store.claimReadyAction(`${id}-triage`, 5_000);
      controller.submit(triage.run.id, `${id}-triage`, triage.run.leaseEpoch, {
        outcome: 'completed',
        summary: 'The review graph is planned.',
        evidence: ['Validated initial review graph'],
        acceptanceChecks: [{ criterion, status: 'passed', evidence: 'Validated initial review graph' }],
        plan: {
          workItemType: 'review-remediation',
          actions: [
            {
              id: 'implementation', name: 'Implement candidate', type: 'implement',
              objective: 'Implement the candidate change',
              approach: 'Edit and test the candidate in the shared workspace',
              expectedOutcome: 'A reviewable candidate exists',
              dependsOnActionIds: [], workspaceMode: 'shared',
            },
            {
              id: 'review', name: 'Review candidate', type: 'review',
              objective: 'Review the candidate independently',
              approach: 'Inspect the diff and verify the acceptance boundary',
              expectedOutcome: 'An explicit review decision is recorded',
              dependsOnActionIds: ['implementation'], workspaceMode: 'read',
              changesRequestedActionId: 'implementation',
            },
            {
              id: 'deliver', name: 'Deliver candidate', type: 'deliver',
              objective: 'Deliver only an approved candidate',
              approach: 'Verify the approved evidence and publish the result',
              expectedOutcome: 'The approved candidate is delivered',
              dependsOnActionIds: ['review'], workspaceMode: 'shared',
            },
          ],
        },
      });
      const implementation = store.claimReadyAction(`${id}-implementation`, 5_000);
      controller.submit(
        implementation.run.id,
        `${id}-implementation`,
        implementation.run.leaseEpoch,
        {
          outcome: 'completed',
          summary: 'The candidate is ready for review.',
          evidence: ['candidate commit'],
          acceptanceChecks: [{ criterion, status: 'deferred', evidence: 'Review remains' }],
        },
      );
      return {
        store,
        controller,
        item,
        criterion,
        review: store.claimReadyAction(`${id}-review`, 5_000),
      };
    };
    const createRunner = (fixture, responses) => new WorkItemRunner({
      store: fixture.store,
      runtimeProvider: async () => ({
        defaultWorkDir: workDir,
        config: { model: 'provider/model', maxOutputTokens: 2_048, projectDocMaxBytes: 0 },
        adapter: {
          async *stream(params) {
            params.onRequestStart?.();
            for (const event of responses.shift()) yield event;
          },
        },
      }),
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'Reviewer', traits: ['review'] }],
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'Reviewer', traits: ['review'] }),
      },
    });

    const replanFixture = createReviewFixture('review-replan-tool');
    try {
      const reviewReplanInput = {
        summary: 'The review found blockers that require a replacement topology.',
        evidence: ['Important finding at runtime.js:42'],
        acceptanceChecks: [{
          criterion: replanFixture.criterion,
          status: 'deferred',
          evidence: 'Remediation and re-review remain',
        }],
        proposalId: 'review-blocker-replan',
        basePlanRevision: replanFixture.review.workItem.planRevision,
        reason: 'The existing future topology cannot represent remediation and re-review.',
        reviewDecision: 'changes_requested',
      };
      const invalidReviewReplanInput = structuredClone(reviewReplanInput);
      delete invalidReviewReplanInput.reviewDecision;
      const replanResponses = [
        [
          { type: 'tool_call', id: 'request-replan-missing-decision', name: 'RequestWorkItemReplan', input: invalidReviewReplanInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'tool_call', id: 'request-replan-corrected', name: 'RequestWorkItemReplan', input: reviewReplanInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
      ];
      const replanRunner = createRunner(replanFixture, replanResponses);
      const result = await replanRunner.run({
        ...replanFixture.review,
        ownerBootId: 'review-replan-tool-review',
        signal: new AbortController().signal,
      });
      expect(replanResponses).toHaveLength(0);
      expect(result).toMatchObject({
        outcome: 'completed',
        reviewDecision: 'changes_requested',
        replanRequest: { proposalId: 'review-blocker-replan' },
      });
      const detail = replanFixture.controller.submit(
        replanFixture.review.run.id,
        'review-replan-tool-review',
        replanFixture.review.run.leaseEpoch,
        result,
      );
      expect(replanFixture.store.getRun(replanFixture.review.run.id)).toMatchObject({
        status: 'completed', reviewDecision: 'changes_requested',
      });
      expect(detail.actions.find(action => action.id === replanFixture.review.action.id))
        .toMatchObject({ status: 'completed' });
      expect(detail.actions.find(action => action.stageId === 'deliver'))
        .toMatchObject({ status: 'superseded' });
      expect(detail.actions.find(action => action.stageId.startsWith('replan-')))
        .toMatchObject({ status: 'ready', type: 'triage' });
      expect(detail.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'workflow.replan_requested' }),
      ]));
      await replanRunner.shutdown();
    } finally {
      replanFixture.store.close();
    }

    const expansionFixture = createReviewFixture('review-expansion-tool');
    try {
      const before = expansionFixture.store.getWorkItemDetail(expansionFixture.item.id);
      const deliver = before.actions.find(action => action.stageId === 'deliver');
      const safeExpansionInput = {
        summary: 'The review found a bounded additive remediation.',
        evidence: ['Important finding at settings.js:84'],
        acceptanceChecks: [{
          criterion: expansionFixture.criterion,
          status: 'deferred',
          evidence: 'Remediation and re-review remain',
        }],
        proposalId: 'review-additive-remediation',
        basePlanRevision: expansionFixture.review.workItem.planRevision,
        reviewDecision: 'changes_requested',
        actions: [
          {
            id: 'remediate-review', name: 'Remediate review finding', type: 'implement',
            objective: 'Fix the bounded review finding',
            approach: 'Apply the focused fix and add a regression test',
            expectedOutcome: 'The review finding is resolved with evidence',
            candidateVpIds: ['omni'], assignmentReason: 'Use the available implementation VP',
            dependsOnActionIds: ['review'], workspaceMode: 'shared',
          },
          {
            id: 'review-remediation', name: 'Review remediation', type: 'review',
            objective: 'Review the remediated candidate independently',
            approach: 'Inspect the focused fix and verify the regression evidence',
            expectedOutcome: 'The remediated candidate has a fresh review decision',
            candidateVpIds: ['omni'], assignmentReason: 'Use the available review VP',
            dependsOnActionIds: ['remediate-review'], workspaceMode: 'read',
            changesRequestedActionId: 'remediate-review',
          },
        ],
        dependencyPatches: [{
          actionId: deliver.id,
          addDependsOnActionIds: ['review-remediation'],
        }],
      };
      const missingDecisionExpansionInput = structuredClone(safeExpansionInput);
      delete missingDecisionExpansionInput.reviewDecision;
      const unsafeExpansionInput = {
        ...structuredClone(safeExpansionInput),
        proposalId: 'review-additive-without-reapproval',
        actions: [structuredClone(safeExpansionInput.actions[0])],
        dependencyPatches: [{
          actionId: deliver.id,
          addDependsOnActionIds: ['remediate-review'],
        }],
      };
      const staleReturnTargetExpansionInput = structuredClone(safeExpansionInput);
      staleReturnTargetExpansionInput.proposalId = 'review-additive-with-stale-return-target';
      staleReturnTargetExpansionInput.actions[1].changesRequestedActionId = 'implementation';
      const partiallyReviewedExpansionInput = {
        ...structuredClone(safeExpansionInput),
        proposalId: 'review-additive-with-unreviewed-side-work',
        actions: [
          ...structuredClone(safeExpansionInput.actions),
          {
            id: 'unreviewed-side-work', name: 'Unreviewed side work', type: 'implement',
            objective: 'Apply a second bounded change',
            approach: 'Edit the independent side path',
            expectedOutcome: 'The side path is changed',
            candidateVpIds: ['omni'], assignmentReason: 'Use the available implementation VP',
            dependsOnActionIds: ['review'], workspaceMode: 'shared',
          },
        ],
        dependencyPatches: [{
          actionId: deliver.id,
          addDependsOnActionIds: ['review-remediation', 'unreviewed-side-work'],
        }],
      };
      const expansionResponses = [
        [
          { type: 'tool_call', id: 'propose-missing-decision', name: 'ProposeWorkItemActions', input: missingDecisionExpansionInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'tool_call', id: 'propose-without-reapproval', name: 'ProposeWorkItemActions', input: unsafeExpansionInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'tool_call', id: 'propose-with-stale-return-target', name: 'ProposeWorkItemActions', input: staleReturnTargetExpansionInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'tool_call', id: 'propose-with-unreviewed-side-work', name: 'ProposeWorkItemActions', input: partiallyReviewedExpansionInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'tool_call', id: 'propose-corrected-remediation', name: 'ProposeWorkItemActions', input: safeExpansionInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
      ];
      const expansionRunner = createRunner(expansionFixture, expansionResponses);
      const result = await expansionRunner.run({
        ...expansionFixture.review,
        ownerBootId: 'review-expansion-tool-review',
        signal: new AbortController().signal,
      });
      expect(expansionResponses).toHaveLength(0);
      expect(result).toMatchObject({
        outcome: 'completed',
        reviewDecision: 'changes_requested',
        planProposal: { proposalId: 'review-additive-remediation' },
      });
      const detail = expansionFixture.controller.submit(
        expansionFixture.review.run.id,
        'review-expansion-tool-review',
        expansionFixture.review.run.leaseEpoch,
        result,
      );
      expect(expansionFixture.store.getRun(expansionFixture.review.run.id)).toMatchObject({
        status: 'completed', reviewDecision: 'changes_requested',
      });
      expect(detail.actions.find(action => action.stageId === 'implementation'))
        .toMatchObject({ status: 'completed' });
      expect(detail.actions.find(action => action.stageId === 'remediate-review'))
        .toMatchObject({ status: 'ready' });
      expect(detail.actions.find(action => action.stageId === 'deliver').dependsOnStageIds)
        .toEqual(['review', 'review-remediation']);
      expect(detail.events.some(event => event.type === 'review.changes_requested')).toBe(false);
      expect(detail.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'workflow.plan_expanded' }),
      ]));
      const remediation = expansionFixture.store.claimReadyAction('review-expansion-remediation', 5_000);
      expect(remediation.action.stageId).toBe('remediate-review');
      expansionFixture.controller.submit(
        remediation.run.id,
        'review-expansion-remediation',
        remediation.run.leaseEpoch,
        {
          outcome: 'completed', summary: 'The finding is remediated.', evidence: ['remediation commit'],
          acceptanceChecks: [{
            criterion: expansionFixture.criterion, status: 'deferred', evidence: 'Fresh review remains',
          }],
        },
      );
      const reReview = expansionFixture.store.claimReadyAction('review-expansion-rereview', 5_000);
      expect(reReview.action.stageId).toBe('review-remediation');
      expect(expansionFixture.store.claimReadyAction('deliver-before-rereview', 5_000)).toBeNull();
      expansionFixture.controller.submit(
        reReview.run.id,
        'review-expansion-rereview',
        reReview.run.leaseEpoch,
        {
          outcome: 'completed', reviewDecision: 'approved', summary: 'The remediation is approved.',
          evidence: ['independent review'], acceptanceChecks: [{
            criterion: expansionFixture.criterion, status: 'passed', evidence: 'Fresh approval recorded',
          }],
        },
      );
      expect(expansionFixture.store.claimReadyAction('review-expansion-deliver', 5_000)?.action.stageId)
        .toBe('deliver');
      await expansionRunner.shutdown();
    } finally {
      expansionFixture.store.close();
    }
  });

  it('persists external side effects and excludes Run-local control tools', async () => {
    const transitions = [];
    const recordLifecycle = (name, input) => {
      transitions.push({ phase: 'start', name, input });
      return { complete: (effectStatus, result) => transitions.push({ phase: 'complete', name, effectStatus, result }) };
    };
    const controlTools = [
      createSubmitWorkItemPlanTool({
        vps: [{ id: 'omni', role: 'developer' }],
        workItem: { title: 'Plan', goal: 'Plan safely', acceptanceCriteria: ['Safe'] },
        collector: { value: null }, isRunActive: () => true,
      }),
      createProposeWorkItemActionsTool({
        vps: [{ id: 'omni', role: 'developer' }],
        workItem: { planRevision: 1 }, actions: [], collector: { value: null }, isRunActive: () => true,
      }),
      createRequestWorkItemReplanTool({
        workItem: { planRevision: 1 }, collector: { value: null }, isRunActive: () => true,
      }),
      createSubmitWorkItemReplanTool({
        vps: [{ id: 'omni', role: 'developer' }],
        workItem: { planRevision: 1 },
        action: { context: [{ type: 'replan-barrier', candidateActionIds: [] }] },
        actions: [], collector: { value: null }, isRunActive: () => true,
      }),
      {
        name: 'FailingWrite', errorOutput: null, sideEffectScope: 'external',
        isReadOnly: () => false, isConcurrencySafe: () => false,
        async execute() { throw new Error('write outcome uncertain'); },
      },
      {
        name: 'ReturnedUnknownWrite', errorOutput: 'json-error-envelope', sideEffectScope: 'external',
        isReadOnly: () => false, isConcurrencySafe: () => false,
        async execute() { return JSON.stringify({ error: 'write may have happened' }); },
      },
    ];
    const mcpTools = [{
      name: 'mcp__test__mutate', errorOutput: null,
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() { return 'mutated'; },
    }];
    const aliasedTool = {
      name: 'AliasedWrite', aliases: ['LegacyWrite'], errorOutput: null, sideEffectScope: 'external',
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() { return 'aliased'; },
    };
    const registry = createWorkItemToolRegistry({
      workDir, isRunActive: () => true, runTools: [...controlTools, aliasedTool],
      mcpTools, operationLifecycle: recordLifecycle,
    });

    await registry.execute('FileWrite', { file_path: 'tracked.txt', content: 'tracked' }, {});
    await registry.execute('FileEdit', {
      file_path: 'tracked.txt', old_string: 'tracked', new_string: 'edited', replace_all: false,
    }, {});
    await registry.execute('FileRead', { file_path: 'tracked.txt' }, {});
    expect(readFileSync(join(workDir, 'tracked.txt'), 'utf8')).toBe('edited');
    const missingEdit = await registry.execute('FileEdit', {
      file_path: 'missing.txt', old_string: 'old', new_string: 'new', replace_all: false,
    }, {});
    expect(JSON.parse(missingEdit)).toMatchObject({ errorEffect: 'none', error: expect.stringMatching(/File not found/) });
    await registry.execute('mcp__test__mutate', {}, {});
    await registry.execute('LegacyWrite', {}, {});
    await expect(registry.execute('FailingWrite', {}, {})).rejects.toThrow(/uncertain/);
    await registry.execute('ReturnedUnknownWrite', {}, {});

    expect(transitions.filter(entry => entry.phase === 'start').map(entry => entry.name)).toEqual([
      'FileWrite', 'FileEdit', 'FileEdit', 'mcp__test__mutate', 'AliasedWrite',
      'FailingWrite', 'ReturnedUnknownWrite',
    ]);
    expect(transitions.filter(entry => entry.phase === 'complete').map(entry => ({
      name: entry.name, effectStatus: entry.effectStatus,
    }))).toEqual([
      { name: 'FileWrite', effectStatus: 'applied' },
      { name: 'FileEdit', effectStatus: 'applied' },
      { name: 'FileEdit', effectStatus: 'failed_no_effect' },
      { name: 'mcp__test__mutate', effectStatus: 'applied' },
      { name: 'AliasedWrite', effectStatus: 'applied' },
      { name: 'FailingWrite', effectStatus: 'unknown' },
      { name: 'ReturnedUnknownWrite', effectStatus: 'unknown' },
    ]);
    expect(controlTools.slice(0, 4).map(tool => tool.sideEffectScope)).toEqual(['run', 'run', 'run', 'run']);

    const adapter = {
      responses: [
        [
          { type: 'tool_call', id: 'missing-edit', name: 'FileEdit', input: {
            file_path: 'engine-missing.txt', old_string: 'old', new_string: 'new', replace_all: false,
          } },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [{ type: 'text_delta', text: 'Handled.' }, { type: 'stop', stopReason: 'end_turn' }],
      ],
      async *stream() {
        for (const event of this.responses.shift()) yield event;
      },
    };
    const engine = new Engine({
      adapter, trace: new NullTrace(), config: { model: 'provider/model', maxOutputTokens: 1_024 },
      toolRegistry: registry,
    });
    const events = [];
    for await (const event of engine.query({ prompt: 'Edit a missing file', workDir })) events.push(event);
    expect(events.find(event => event.type === 'tool_end' && event.id === 'missing-edit'))
      .toMatchObject({ isError: true });

    const store = new WorkItemStore(join(workDir, 'work-center.db'));
    const controller = new WorkflowController(store, { listAvailableVpIds: () => ['omni'] });
    const workItem = controller.create({
      id: 'plan-self-correction',
      title: 'Correct an invalid plan',
      goal: 'Let the planner correct its graph in one Run',
      acceptanceCriteria: ['The corrected plan can execute'],
      workflowTemplate: 'ai-planned',
      workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
      workDir,
      start: true,
    });
    const claim = store.claimReadyAction('planner-boot', 5_000);
    const planAction = (id, type, dependsOnActionIds) => ({
      id, name: id, type,
      objective: `Complete ${id}`,
      approach: `Use repository evidence to complete ${id}`,
      expectedOutcome: `${id} is complete`,
      candidateVpIds: ['omni'], assignmentReason: 'Use the available planner',
      dependsOnActionIds, workspaceMode: type === 'deliver' ? 'shared' : 'read',
    });
    const planInput = {
      summary: 'A corrected plan is ready.',
      evidence: ['The complete graph was validated.'],
      acceptanceChecks: [{
        criterion: 'The corrected plan can execute', status: 'passed', evidence: 'Validated graph',
      }],
      contractPatch: {
        title: 'Correct an invalid plan',
        goal: 'Let the planner correct its graph in one Run',
        acceptanceCriteria: ['The corrected plan can execute'],
      },
      workItemType: 'plan-correction',
      actions: [
        planAction('implement', 'implement', []),
        planAction('deliver', 'deliver', ['implement']),
      ],
    };
    const plannerAdapter = {
      responses: [
        [
          { type: 'tool_call', id: 'invalid-plan', name: 'SubmitWorkItemPlan', input: {
            ...planInput,
            actions: [
              planAction('implement', 'implement', ['missing-dependency']),
              planAction('deliver', 'deliver', ['implement']),
            ],
          } },
          { type: 'stop', stopReason: 'tool_use' },
        ],
        [
          { type: 'tool_call', id: 'valid-plan', name: 'SubmitWorkItemPlan', input: planInput },
          { type: 'stop', stopReason: 'tool_use' },
        ],
      ],
      async *stream(params) {
        params.onRequestStart?.();
        for (const event of this.responses.shift()) yield event;
      },
    };
    const runner = new WorkItemRunner({
      store,
      runtimeProvider: async () => ({
        defaultWorkDir: workDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter: plannerAdapter,
      }),
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'planner', traits: ['triage', 'implement'] }],
        getVp: id => id === 'omni'
          ? { id: 'omni', name: 'Omni', role: 'planner', traits: ['triage', 'implement'] }
          : null,
      },
    });
    const planned = await runner.run({
      ...claim, ownerBootId: 'planner-boot', signal: new AbortController().signal,
    });
    const plannedDetail = controller.submit(
      claim.run.id, 'planner-boot', claim.run.leaseEpoch, planned,
    );
    expect(plannedDetail).toMatchObject({ id: workItem.id, status: 'ready' });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE work_item_id = ?')
      .get(workItem.id).count).toBe(0);
    const executionClaim = store.claimReadyAction('executor-boot', 5_000);
    expect(executionClaim)
      .toMatchObject({ workItem: { id: workItem.id }, action: { stageId: 'implement' } });
    const operationKey = `${executionClaim.run.id}:tool:1`;
    const fencedRegistry = createWorkItemToolRegistry({
      workDir,
      isRunActive: () => store.isActiveRun(
        executionClaim.run.id, 'executor-boot', executionClaim.run.leaseEpoch,
      ),
      runTools: [controlTools[4]],
      operationLifecycle: (name, input) => {
        store.createOperation({
          workItemId: workItem.id,
          actionId: executionClaim.action.id,
          runId: executionClaim.run.id,
          operationType: name,
          idempotencyKey: operationKey,
          replayPolicy: 'never_automatic',
          payload: { input },
        });
        expect(store.claimOperation(
          operationKey, 'executor-boot', executionClaim.run.leaseEpoch, false,
        )).not.toBeNull();
        return {
          complete: (effectStatus, result) => expect(store.completeOperation(
            operationKey, 'executor-boot', executionClaim.run.leaseEpoch, effectStatus, result,
          )).toBe(true),
        };
      },
    });
    await expect(fencedRegistry.execute('FailingWrite', {}, {})).rejects.toThrow(/uncertain/);
    expect(store.getOperationByKey(operationKey)).toMatchObject({
      effectStatus: 'unknown', executionStatus: 'quiescent',
    });
    const afterImplementation = controller.submit(
      executionClaim.run.id, 'executor-boot', executionClaim.run.leaseEpoch,
      {
        outcome: 'completed', response: 'Implementation complete.', summary: 'Implementation complete.',
        evidence: ['implementation evidence'],
        acceptanceChecks: [{
          criterion: 'The corrected plan can execute', status: 'deferred', evidence: 'Delivery verifies it',
        }],
      },
    );
    expect(afterImplementation.actions.find(action => action.stageId === 'deliver'))
      .toMatchObject({ status: 'ready' });
    expect(store.claimReadyAction('blocked-by-unknown-operation', 5_000)).toBeNull();

    const timeoutItem = controller.create({
      id: 'timeout-operation-fence', title: 'Fence late writes',
      goal: 'Do not dispatch a later mutator after timeout',
      acceptanceCriteria: ['Late mutators stay fenced'],
      workflowTemplate: 'software-change', workDir, start: true,
    });
    const timeoutClaim = store.claimReadyAction('timeout-owner', 5_000);
    let fastWriteCalls = 0;
    const slowPath = join(workDir, 'timeout-order.txt');
    const slowWrite = {
      name: 'SlowWrite', timeoutMs: 5, errorOutput: null, sideEffectScope: 'external',
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() {
        await new Promise(resolve => setTimeout(resolve, 60));
        writeFileSync(slowPath, 'slow-old');
        return 'slow';
      },
    };
    const fastWrite = {
      name: 'FastWrite', errorOutput: null, sideEffectScope: 'external',
      isReadOnly: () => false, isConcurrencySafe: () => false,
      async execute() {
        fastWriteCalls += 1;
        writeFileSync(slowPath, 'fast-new');
        return 'fast';
      },
    };
    let timeoutOrdinal = 0;
    const timeoutRegistry = createWorkItemToolRegistry({
      workDir, isRunActive: () => store.isActiveRun(
        timeoutClaim.run.id, 'timeout-owner', timeoutClaim.run.leaseEpoch,
      ),
      runTools: [slowWrite, fastWrite],
      operationLifecycle: (name, input) => {
        timeoutOrdinal += 1;
        const key = `${timeoutClaim.run.id}:tool:${timeoutOrdinal}`;
        const claimedOperation = store.createAndClaimOperation({
          workItemId: timeoutItem.id,
          actionId: timeoutClaim.action.id,
          runId: timeoutClaim.run.id,
          operationType: name,
          idempotencyKey: key,
          replayPolicy: 'never_automatic',
          payload: { input },
        }, 'timeout-owner', timeoutClaim.run.leaseEpoch, false);
        expect(claimedOperation).not.toBeNull();
        return {
          complete: (effectStatus, result) => store.completeOperation(
            key, 'timeout-owner', timeoutClaim.run.leaseEpoch, effectStatus, result,
          ),
        };
      },
    });
    const timeoutAdapter = {
      responses: [[
        { type: 'tool_call', id: 'slow', name: 'SlowWrite', input: {} },
        { type: 'tool_call', id: 'fast', name: 'FastWrite', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ]],
      async *stream() {
        for (const event of this.responses.shift()) yield event;
      },
    };
    const timeoutEngine = new Engine({
      adapter: timeoutAdapter, trace: new NullTrace(),
      config: { model: 'provider/model', maxOutputTokens: 1_024 },
      toolRegistry: timeoutRegistry,
    });
    const timeoutEvents = [];
    for await (const event of timeoutEngine.query({ prompt: 'Run both writes', workDir })) {
      timeoutEvents.push(event);
    }
    expect(timeoutEvents).toContainEqual(expect.objectContaining({
      type: 'tool_end', id: 'slow', isError: true,
    }));
    expect(timeoutEvents).toContainEqual(expect.objectContaining({
      type: 'error', error: expect.objectContaining({ name: 'ToolExecutionTimeoutError' }),
    }));
    expect(timeoutEvents).toContainEqual(expect.objectContaining({
      type: 'turn_end', stopReason: 'error', terminal: true,
    }));
    expect(fastWriteCalls).toBe(0);
    expect(store.interruptRun(
      timeoutClaim.run.id, 'timeout-owner', timeoutClaim.run.leaseEpoch, 'fatal tool timeout',
    )).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(readFileSync(slowPath, 'utf8')).toBe('slow-old');
    expect(store.getOperationByKey(`${timeoutClaim.run.id}:tool:1`)).toMatchObject({
      effectStatus: 'unknown', executionStatus: 'hazardous_orphan',
      effectCutoff: { status: 'stale', closureType: 'late_completion' },
    });
    expect(store.claimReadyAction('blocked-after-timeout', 5_000)).toBeNull();

    const crashItem = controller.create({
      id: 'operation-create-crash', title: 'Recover unclaimed operation',
      goal: 'Do not deadlock after create-before-claim crash', acceptanceCriteria: [],
      workflowTemplate: 'software-change', workDir, start: true,
    });
    const crashClaim = store.claimReadyAction('crash-owner', 5_000);
    store.createOperation({
      workItemId: crashItem.id, actionId: crashClaim.action.id, runId: crashClaim.run.id,
      operationType: 'CrashBeforeClaim', idempotencyKey: 'create-before-claim-crash',
      replayPolicy: 'never_automatic',
    });
    store.close();
    const reopened = new WorkItemStore(join(workDir, 'work-center.db'));
    expect(reopened.getOperationByKey('create-before-claim-crash')).toMatchObject({
      effectStatus: 'failed_no_effect', executionStatus: 'quiescent',
      effectCutoff: { closureType: 'recovered_before_dispatch' },
    });
    expect(reopened.recoverInterruptedRuns('post-crash-owner')).toBeGreaterThanOrEqual(1);
    expect(reopened.claimReadyAction('post-crash-owner', 5_000))
      .toMatchObject({ workItem: { id: crashItem.id } });
    reopened.close();

    for (const tool of controlTools.slice(0, 4)) {
      const controlRegistry = createWorkItemToolRegistry({
        workDir, isRunActive: () => true,
        runTools: [tool], operationLifecycle: recordLifecycle,
      });
      try { await controlRegistry.execute(tool.name, {}, {}); } catch {}
    }
    expect(transitions.filter(entry => entry.phase === 'start').map(entry => entry.name))
      .not.toEqual(expect.arrayContaining(controlTools.slice(0, 4).map(tool => tool.name)));

    const policyRegistry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    await expect(policyRegistry.execute('Bash', {
      command: 'echo nope', cwd: outsideDir, background: false,
    }, {})).rejects.toThrow(/cwd is fixed/);
    await expect(policyRegistry.execute('Bash', {
      command: 'echo nope', cwd: workDir, background: true,
    }, {})).rejects.toThrow(/background Bash/);
  });

  const verifyRunningQuotedActionInput = () => {
    const store = new WorkItemStore(join(workDir, 'running-quote.db'), { now: () => 1_000 });
    const controller = new WorkflowController(store);
    try {
      const item = controller.create({
        id: 'running-quoted-input',
        title: 'Use a live correction',
        goal: 'Deliver the latest user correction to the active executor',
        acceptanceCriteria: ['The correction reaches the active executor'],
        workflowTemplate: 'software-change',
        workDir,
        start: true,
      });
      const claim = store.claimReadyAction('running-quote-owner', 60_000);
      controller.input(item.id, {
        text: 'LATEST RUNNING CORRECTION',
        actionId: claim.action.id,
        generation: claim.action.generation,
        revision: store.getWorkItem(item.id).revision,
        clientMessageId: 'running-large-quote',
        quote: { role: 'assistant', author: 'Reviewer', content: 'Q'.repeat(20_000) },
      });

      const pending = store.listPendingActionInputs(
        claim.action.id,
        claim.run.id,
        'running-quote-owner',
        claim.run.leaseEpoch,
      );
      const rendered = renderPendingActionInput(pending[0]);

      expect(pending).toHaveLength(1);
      expect(rendered).toContain('LATEST RUNNING CORRECTION');
      expect(rendered).toContain('<quoted-message untrusted-reference="true">');
      expect(rendered).toContain('[quoted message truncated to fit the execution context budget]');
      expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(
        Buffer.byteLength('LATEST RUNNING CORRECTION\n\n', 'utf8') + (8 * 1024),
      );
    } finally {
      store.close();
    }
  };

  it('rejects escapes and pins creation-time workspace identity', async () => {
    verifyRunningQuotedActionInput();
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    await expect(registry.execute('FileRead', { file_path: '../secret' }, {}))
      .rejects.toThrow(/escapes/);
    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/file.txt\n+++ ../../secret.txt\n@@ -1 +1 @@\n-old\n+new\n',
    }, {})).rejects.toThrow(/escapes/);

    const safe = join(workDir, 'safe');
    mkdirSync(safe);
    symlinkSync(outsideDir, join(safe, 'link'));
    await expect(registry.execute('FileWrite', {
      file_path: join(safe, 'link', 'escaped.txt'), content: 'nope',
    }, {})).rejects.toThrow(/escapes/);

    const writeTarget = join(outsideDir, 'write-target.txt');
    const patchTarget = join(outsideDir, 'patch-target.txt');
    symlinkSync(writeTarget, join(workDir, 'write-link.txt'));
    symlinkSync(patchTarget, join(workDir, 'patch-link.txt'));

    await expect(registry.execute('FileWrite', {
      file_path: 'write-link.txt', content: 'outside',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(writeTarget)).toBe(false);

    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/patch-link.txt\n+++ b/patch-link.txt\n@@ -0,0 +1 @@\n+outside\n',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(patchTarget)).toBe(false);





    const projectA = join(workDir, 'project-a');
    const projectB = join(workDir, 'project-b');
    const alias = join(workDir, 'current');
    mkdirSync(projectA);
    mkdirSync(projectB);
    symlinkSync(projectA, alias);
    const workItem = { workDir: alias, workspaceKey: projectA };

    unlinkSync(alias);
    symlinkSync(projectB, alias);

    expect(resolveWorkItemWorkDir(workItem, outsideDir)).toBe(projectA);
    expect(() => resolveWorkItemWorkDir({ workDir: alias, workspaceKey: '' }, outsideDir))
      .toThrow(/canonical workspace identity/);
  });



  it('keeps retry EngineTurns uncommitted and fences post-dispatch stops', async () => {
    const store = new WorkItemStore(join(workDir, 'retry-turn-start-close.db'));
    const controller = new WorkflowController(store, { listAvailableVpIds: () => ['omni'] });
    const oldFetch = globalThis.fetch;
    try {
      const item = controller.create({
        id: 'retry-turn-start-close',
        title: 'Close retry at turn boundary',
        goal: 'Do not persist an un-dispatched continuation or EngineTurn',
        acceptanceCriteria: ['No retry request survives a consumer close'],
        workflowTemplate: 'software-change',
        workDir,
        start: true,
      });
      const claim = store.claimReadyAction('retry-boundary-owner', 60_000);
      let providerDispatches = 0;
      globalThis.fetch = async () => {
        providerDispatches += 1;
        if (providerDispatches === 1) {
          return new Response(
            'event: response.output_text.delta\n' +
            'data: {"type":"response.output_text.delta","delta":"visible Work Center partial"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return new Response(
          'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };
      const router = new AdapterRouter({
        providers: [{
          name: 'retry-provider',
          baseUrl: 'https://retry-provider.example/v1',
          apiKey: 'retry-key',
          protocol: 'openai-responses',
          models: ['retry-model'],
        }],
      });
      const runner = new WorkItemRunner({
        store,
        runtimeProvider: async () => ({
          defaultWorkDir: workDir,
          config: {
            model: 'retry-provider/retry-model',
            maxOutputTokens: 1_024,
            projectDocMaxBytes: 0,
            llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
          adapter: router,
        }),
        registry: {
          listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', traits: [] }],
          getVp: id => id === 'omni'
            ? { id: 'omni', name: 'Omni', role: 'developer', traits: [] }
            : null,
        },
      });

      let retryTurnStartSeen = false;
      await expect(runner.run({
        ...claim,
        ownerBootId: 'retry-boundary-owner',
        signal: new AbortController().signal,
        onEngineEvent: event => {
          if (event.type === 'turn_start' && event.turnNumber === 2) {
            retryTurnStartSeen = true;
            return { stop: true };
          }
          return null;
        },
      })).rejects.toMatchObject({ name: 'WorkCenterEngineStoppedError' });

      expect(retryTurnStartSeen).toBe(true);
      expect(providerDispatches).toBe(1);
      // The first request genuinely crossed fetch and therefore remains the
      // expected uncertain turn. The cancelled retry must not create a second
      // prepared/dispatching row.
      expect(store.db.prepare('SELECT status FROM engine_turns WHERE run_id = ? ORDER BY ordinal')
        .all(claim.run.id)).toEqual([{ status: 'unknown' }]);
      expect(store.db.prepare(`SELECT status FROM engine_turns WHERE run_id = ?
        AND status IN ('prepared', 'dispatching')`).all(claim.run.id)).toEqual([]);

      const postDispatchItem = controller.create({
        id: 'post-dispatch-stop',
        title: 'Stop after provider output',
        goal: 'Do not retry a dispatch whose response stream was observed',
        acceptanceCriteria: ['The dispatched run ends terminally'],
        workflowTemplate: 'software-change',
        workDir,
        start: true,
      });
      const postDispatchClaim = store.claimReadyAction('post-dispatch-owner', 60_000);
      let postDispatchFetches = 0;
      globalThis.fetch = async () => {
        postDispatchFetches += 1;
        return new Response(
          'event: response.output_text.delta\n' +
          'data: {"type":"response.output_text.delta","delta":"visible dispatched output"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };
      await expect(runner.run({
        ...postDispatchClaim,
        ownerBootId: 'post-dispatch-owner',
        signal: new AbortController().signal,
        onEngineEvent: event => event.type === 'text_delta' ? { stop: true } : null,
      })).rejects.toMatchObject({
        name: 'WorkCenterEngineStoppedError',
        retryable: false,
        workItemFailureKind: 'provider_dispatch_unknown',
      });
      expect(postDispatchItem.id).toBe('post-dispatch-stop');
      expect(postDispatchFetches).toBe(1);
      expect(store.db.prepare('SELECT status FROM engine_turns WHERE run_id = ? ORDER BY ordinal')
        .all(postDispatchClaim.run.id)).toEqual([{ status: 'unknown' }]);
      expect(store.getRun(postDispatchClaim.run.id)).toMatchObject({ status: 'dispatch_unknown' });
      expect(store.getAction(postDispatchClaim.action.id)).toMatchObject({ status: 'failed' });
    } finally {
      globalThis.fetch = oldFetch;
      store.close();
    }
  });

  it('rejects a replaced canonical target before snapshots or adapter execution', async () => {
    const projectA = join(workDir, 'runner-canonical-a');
    const movedProjectA = join(workDir, 'runner-moved-a');
    const projectB = join(workDir, 'runner-canonical-b');
    mkdirSync(projectA);
    mkdirSync(projectB);
    renameSync(projectA, movedProjectA);
    symlinkSync(projectB, projectA);
    let adapterStarted = false;
    const setRunExecutionSnapshots = vi.fn();
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: outsideDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024 },
        adapter: {
          async *stream() {
            adapterStarted = true;
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: { isActiveRun: () => true, setRunExecutionSnapshots },
      registry: {
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });

    await expect(runner.run({
      workItem: { workDir: projectA, workspaceKey: projectA },
      action: { type: 'triage', requiredRole: 'omni', instruction: 'Inspect workspace' },
      run: { id: 'run-replaced', leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: 'boot-a',
    })).rejects.toThrow(/canonical workspace identity changed/);
    expect(setRunExecutionSnapshots).not.toHaveBeenCalled();
    expect(adapterStarted).toBe(false);

    const engineError = new Error('provider failed inside Work Center');
    const errorStore = {
      isExecutionStopped: () => false,
      reserveWorkItemRequest: () => ({ allowed: true, id: 'mock-request' }),
      settleWorkItemRequest: () => true,
      listCompletedRuns: () => [],
      listActionDependencies: () => [],
      getActionResumeContext: () => null,
      listPendingActionInputs: () => [],
      setRunExecutionSnapshots: () => true,
      isActiveRun: () => true,
      prepareEngineTurn: () => ({ id: 'engine-turn-error' }),
      claimEngineTurn: () => true,
      failEngineTurn: () => ({ allowRetry: true }),
      closeRunInput: () => true,
    };
    const errorRunner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: workDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter: {
          async *stream(params) {
            params.onRequestStart?.();
            throw engineError;
          },
        },
      }),
      store: errorStore,
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', traits: [] }],
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', traits: [] }),
      },
    });
    await expect(errorRunner.run({
      workItem: {
        id: 'work-item-engine-error', title: 'Fail visibly', goal: 'Surface the Engine error',
        acceptanceCriteria: [], workDir, workspaceKey: workDir,
      },
      action: { id: 'action-error', type: 'test', requiredRole: 'omni', instruction: 'Fail' },
      run: { id: 'run-engine-error', leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: 'boot-error',
    })).rejects.toBe(engineError);
  });





  it('keeps Work Center Engine config outside Agent Plugins and retains control-plane tools', async () => {
    const runtimeConfig = {
      model: 'provider/model',
      maxOutputTokens: 1_024,
      projectDocMaxBytes: 0,
      plugins: { tools: [] },
    };
    const capturedRequests = [];
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: workDir,
        config: runtimeConfig,
        adapter: {
          async *stream(request) {
            capturedRequests.push(request);
            yield { type: 'text_delta', text: JSON.stringify({
              outcome: 'completed', summary: 'Plan submitted', evidence: ['planner evidence'],
            }) };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: {
        listCompletedRuns: () => [],
        isActiveRun: () => true,
        setRunExecutionSnapshots: vi.fn(() => true),
        isExecutionStopped: () => false,
        reserveWorkItemRequest: () => ({ allowed: true, id: 'mock-request' }),
        settleWorkItemRequest: () => true,
        prepareEngineTurn: vi.fn(() => ({ id: 'plugin-isolation-provider-turn' })),
        claimEngineTurn: vi.fn(() => true),
        consumeEngineTurn: vi.fn(() => true),
        failEngineTurn: vi.fn(() => ({ allowRetry: true })),
        closeRunInput: () => true,
        listPendingActionInputs: () => [],
      },
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', persona: '' }],
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });
    const workItem = {
      id: 'plugin-isolation',
      title: 'Plan despite an explicit empty tool allowlist',
      goal: 'Keep Work Center control-plane planning outside the MVP policy boundary',
      acceptanceCriteria: ['The plan tool remains available'],
      planRevision: 0,
      workflowSnapshot: { planningMode: 'ai', executionMode: 'graph', globalInstructions: '' },
    };
    const action = {
      id: 'triage-action', stageId: 'triage', type: 'triage', requiredRole: 'omni',
      instruction: 'Plan the WorkItem.', assignmentPolicy: { mode: 'fixed', fixedVpId: 'omni' },
      modelPolicy: { mode: 'inherit' }, workspaceMode: 'read', context: [], maxAttempts: 2,
    };
    const run = { id: 'plugin-isolation-run', leaseEpoch: 1 };

    const result = await runner.run({
      workItem,
      action,
      run,
      signal: new AbortController().signal,
      ownerBootId: 'plugin-isolation-boot',
    });

    expect(runtimeConfig).toEqual(expect.objectContaining({ plugins: { tools: [] } }));
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].tools.map(tool => tool.name)).toContain('SubmitWorkItemPlan');
    expect(result).toMatchObject({ outcome: 'completed', summary: 'Plan submitted' });
  });

  it.each([
    ['legacy', {}],
    ['dynamic', { coordinationMode: 'dynamic' }],
  ])('does not inject archived Dream memory into %s Actions', async (_mode, modeFields) => {
    const yeaftDir = join(workDir, '.yeaft-runtime');
    const memoryDir = join(yeaftDir, 'memory', 'sessions', 'origin-session');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'content.md'), 'ARCHIVED_DREAM_SECRET');
    const search = vi.fn(() => [{ scope: 'sessions/origin-session', body: 'ARCHIVED_DREAM_SECRET' }]);
    const capturedRequests = [];
    const runner = new WorkItemRunner({
      yeaftDir,
      runtimeProvider: async () => ({
        yeaftDir,
        defaultWorkDir: workDir,
        memoryIndex: { search },
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter: {
          async *stream(request) {
            capturedRequests.push(request);
            yield { type: 'text_delta', text: JSON.stringify({
              outcome: 'completed', summary: 'Action complete', evidence: ['runtime evidence'],
              acceptanceChecks: [],
            }) };
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: {
        listCompletedRuns: () => [],
        listActionSources: () => [],
        listActionDependencies: () => [],
        isActiveRun: () => true,
        setRunExecutionSnapshots: () => true,
        isExecutionStopped: () => false,
        reserveWorkItemRequest: () => ({ allowed: true, id: 'memory-disabled-request' }),
        settleWorkItemRequest: () => true,
        prepareEngineTurn: () => ({ id: 'memory-disabled-turn' }),
        claimEngineTurn: () => true,
        consumeEngineTurn: () => true,
        failEngineTurn: () => ({ allowRetry: true }),
        closeRunInput: () => true,
        listPendingActionInputs: () => [],
      },
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', persona: '' }],
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });
    const result = await runner.run({
      workItem: {
        id: `memory-disabled-${_mode}`,
        title: 'Run without Dream',
        goal: 'Do not inject archived memory',
        acceptanceCriteria: [],
        reuseMemory: true,
        origin: { sessionId: 'origin-session', trustedSession: true },
        linkedSessionIds: ['origin-session'],
        ...modeFields,
      },
      action: {
        id: `action-${_mode}`, type: 'implement', requiredRole: 'omni',
        instruction: 'Complete this Action without hidden context.',
        assignmentPolicy: { mode: 'fixed', fixedVpId: 'omni' },
        modelPolicy: { mode: 'inherit' }, sourceActionIds: [], dependsOnStageIds: [],
      },
      run: { id: `run-${_mode}`, leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: `boot-${_mode}`,
    });

    expect(result).toMatchObject({ outcome: 'completed' });
    expect(search).not.toHaveBeenCalled();
    expect(JSON.stringify(capturedRequests)).not.toContain('ARCHIVED_DREAM_SECRET');
    expect(JSON.stringify(capturedRequests)).not.toContain('<work-center-memory>');
  });

  it('fences execution after the Run loses its lease', async () => {
    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
  });




});
