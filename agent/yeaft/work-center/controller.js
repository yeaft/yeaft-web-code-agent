import { randomUUID } from 'node:crypto';
import {
  actionForStage,
  actionInstruction,
  canonicalActionInstruction,
  withoutActionInputContext,
  applyGeneratedPlan,
  getNextStep,
  initialActionFor,
  RUN_OUTCOMES,
} from './workflow.js';
import { renderSessionContextSnapshot } from './session-context.js';
import { normalizeSessionMessageQuote } from '../session-message-quote.js';
import { normalizeEvidence, normalizeOutputs } from './evidence.js';
import { isDynamicWorkItem } from './execution-mode.js';
import { applyAdditivePlanProposal, applyReplanMutation } from './plan-mutation.js';
import { normalizeContractPatch, validateCompletedResult } from './completion-contract.js';

function normalizeTerminalResult(result, action) {
  if (!result || !RUN_OUTCOMES.includes(result.outcome)) {
    throw new Error(`Invalid Work Center outcome: ${result?.outcome || '(missing)'}`);
  }
  const normalized = {
    outcome: result.outcome,
    response: String(result.response || ''),
    summary: String(result.summary || ''),
    evidence: normalizeEvidence(result.evidence),
    outputs: normalizeOutputs(result.outputs),
    waitingReason: result.waitingReason ? String(result.waitingReason) : null,
    error: result.error ? String(result.error) : null,
    failureKind: result.failureKind === 'system_blocked' ? 'system_blocked' : null,
    failureCode: typeof result.failureCode === 'string' ? result.failureCode.slice(0, 128) : null,
    reviewDecision: ['approved', 'changes_requested'].includes(result.reviewDecision)
      ? result.reviewDecision
      : null,
    contractPatch: normalizeContractPatch(result.contractPatch),
    plan: result.plan && typeof result.plan === 'object' && !Array.isArray(result.plan)
      ? result.plan
      : null,
    loopCount: Math.max(0, Number(result.loopCount) || 0),
    toolCount: Math.max(0, Number(result.toolCount) || 0),
    llmRequestCount: Math.max(0, Number(result.llmRequestCount) || 0),
    inputTokens: Math.max(0, Number(result.inputTokens) || 0),
    outputTokens: Math.max(0, Number(result.outputTokens) || 0),
    cacheReadTokens: Math.max(0, Number(result.cacheReadTokens) || 0),
    cacheWriteTokens: Math.max(0, Number(result.cacheWriteTokens) || 0),
    totalTokens: Math.max(0, Number(result.totalTokens) || 0),
    acceptanceChecks: Array.isArray(result.acceptanceChecks) ? result.acceptanceChecks : [],
    checkpoint: result.checkpoint && typeof result.checkpoint === 'object'
      ? result.checkpoint : null,
    planProposal: result.planProposal && typeof result.planProposal === 'object'
      && !Array.isArray(result.planProposal) ? result.planProposal : null,
    replanRequest: result.replanRequest && typeof result.replanRequest === 'object'
      && !Array.isArray(result.replanRequest) ? result.replanRequest : null,
    replanMutation: result.replanMutation && typeof result.replanMutation === 'object'
      && !Array.isArray(result.replanMutation) ? result.replanMutation : null,
  };
  if (normalized.outcome === 'waiting' && !normalized.waitingReason) {
    throw new Error('waiting outcome requires waitingReason');
  }
  if (action.type !== 'triage' && normalized.contractPatch) {
    normalized.outcome = 'failed';
    normalized.error = 'Only triage may submit a WorkItem contractPatch';
    normalized.contractPatch = null;
  }
  if (normalized.outcome !== 'completed') {
    normalized.planProposal = null;
    normalized.replanRequest = null;
    normalized.replanMutation = null;
  }
  if ([normalized.planProposal, normalized.replanRequest, normalized.replanMutation].filter(Boolean).length > 1) {
    normalized.outcome = 'failed';
    normalized.error = 'An Action cannot submit more than one WorkItem plan mutation';
    normalized.planProposal = null;
    normalized.replanRequest = null;
    normalized.replanMutation = null;
  }
  if (action.type === 'review' && normalized.outcome === 'completed' && !normalized.reviewDecision) {
    normalized.outcome = 'failed';
    normalized.error = 'Completed review requires approved or changes_requested';
  }
  return normalized;
}

function canonicalReplacementAction(workItem, action, context) {
  const replacement = {
    type: action.type,
    stageId: action.stageId || action.type,
    assignmentPolicy: action.assignmentPolicy,
    modelPolicy: action.modelPolicy,
    requiredRole: action.requiredRole,
    dependsOnStageIds: action.dependsOnStageIds,
    workspaceMode: action.workspaceMode,
    changesRequestedStageId: action.changesRequestedStageId,
    brief: action.brief,
    context,
    maxAttempts: action.maxAttempts || 2,
  };
  replacement.instruction = canonicalActionInstruction(
    workItem,
    { ...action, ...replacement },
    context,
  );
  return replacement;
}

function contextEntry(action, result, run) {
  return {
    type: action.type,
    stageId: action.stageId || action.type,
    vpId: run?.vpSnapshot?.id || action.requiredRole || null,
    role: run?.roleSnapshot?.id || action.requiredRole || null,
    summary: result.summary || '',
    evidence: result.evidence || [],
    reviewDecision: result.reviewDecision || null,
  };
}

export class WorkflowController {
  constructor(store, options = {}) {
    this.store = store;
    this.listAvailableVpIds = typeof options.listAvailableVpIds === 'function'
      ? options.listAvailableVpIds
      : null;
  }

  create(input) {
    const draft = {
      ...input,
      workflowTemplate: input.workflowTemplate || 'software-change',
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [],
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
    };
    let firstAction = input.start !== false && !isDynamicWorkItem(draft) ? initialActionFor(draft) : null;
    if (firstAction) {
      firstAction = {
        ...firstAction,
        instruction: actionInstruction(firstAction, draft, [], renderSessionContextSnapshot(draft.sessionContext)),
      };
    }
    if (firstAction && draft.reuseMemory !== false) {
      const context = this.store.getReusableContext(draft.workDir, draft.id);
      firstAction = {
        ...firstAction,
        context,
        instruction: actionInstruction(firstAction, draft, context, renderSessionContextSnapshot(draft.sessionContext)),
      };
    }
    return this.store.createWorkItem(draft, firstAction);
  }

  start(id) {
    const detail = this.store.startWorkItemAtomic(id, workItem => {
      const action = initialActionFor(workItem);
      if (workItem.reuseMemory === false) return action;
      const context = this.store.getReusableContext(workItem.workDir, workItem.id);
      return {
        ...action,
        context,
        instruction: actionInstruction(action, workItem, context, renderSessionContextSnapshot(workItem.sessionContext)),
      };
    });
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  startScheduled(id, scheduledAt, cloneAttachments = null) {
    return this.store.dispatchScheduledWorkItem(id, scheduledAt, workItem => {
      const action = initialActionFor(workItem);
      if (workItem.reuseMemory === false) return action;
      const context = this.store.getReusableContext(workItem.workDir, workItem.id);
      return {
        ...action,
        context,
        instruction: actionInstruction(action, workItem, context, renderSessionContextSnapshot(workItem.sessionContext)),
      };
    }, cloneAttachments);
  }

  update(id, patch) {
    const updated = this.store.updateWorkItemAtomic(id, patch, initialActionFor);
    if (!updated) throw new Error(`WorkItem not found: ${id}`);
    return this.store.getWorkItemDetail(id);
  }

  cancel(id) {
    const workItem = this.store.cancelWorkItemAtomic(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    return this.store.getWorkItemDetail(id);
  }

  extendBudget(id, input = {}) {
    if (!Number.isSafeInteger(input.executionControlRevision)) {
      throw new Error('executionControlRevision is required to extend execution budget');
    }
    return this.store.extendExecutionBudget(id, input.executionControlRevision, input.additions || {});
  }

  resume(id, input = {}) {
    const revision = Number(input.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new Error('revision is required to resume a WorkItem');
    }
    const detail = this.store.resumeWorkItemAtomic(id, revision, workItem => {
      const action = initialActionFor(workItem);
      if (workItem.reuseMemory === false) return action;
      const context = this.store.getReusableContext(workItem.workDir, workItem.id);
      return {
        ...action,
        context,
        instruction: actionInstruction(
          action,
          workItem,
          context,
          renderSessionContextSnapshot(workItem.sessionContext),
        ),
      };
    }, input.executionControlRevision);
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  guide(id, input = {}) {
    const guidance = typeof input.guidance === 'string' ? input.guidance.trim().slice(0, 8_000) : '';
    const addedAttachmentCount = Math.max(0, Number(input.addedAttachmentCount) || 0);
    if (!guidance && addedAttachmentCount === 0) throw new Error('guidance or attachments are required');
    const guidanceSummary = guidance || `The user added ${addedAttachmentCount} attachment(s) as additional context for this Action.`;
    const expected = {
      actionId: typeof input.actionId === 'string' ? input.actionId : '',
      generation: Number(input.generation),
      revision: Number(input.revision),
    };
    const current = this.store.getWorkItem(id);
    const graphMode = current?.workflowSnapshot?.executionMode === 'graph';
    if (!expected.actionId || !Number.isInteger(expected.revision)
        || (graphMode && (!Number.isInteger(expected.generation) || expected.generation < 1))) {
      throw new Error(`actionId, revision${graphMode ? ', and generation' : ''} are required for guidance`);
    }
    const detail = this.store.addActionGuidance(id, guidanceSummary, expected, (workItem, previous) => {
      const context = [...withoutActionInputContext(previous.context), {
        type: 'guidance',
        role: 'user',
        summary: guidanceSummary,
        evidence: [],
      }];
      return canonicalReplacementAction(workItem, previous, context);
    }, input.attachments, input.addedAttachments);
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  input(id, input = {}) {
    const existingClientMessage = this.store.hasActionInputClientMessage(id, input.actionId, input.clientMessageId);
    if (existingClientMessage) return this.store.getWorkItemDetail(id);
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, 8_000) : '';
    const quote = normalizeSessionMessageQuote(input.quote);
    const addedAttachmentCount = Math.max(0, Number(input.addedAttachmentCount) || 0);
    if (!text && addedAttachmentCount === 0) throw new Error('Action input or attachments are required');
    const workItem = this.store.getWorkItem(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    const targetAction = this.store.getAction(input.actionId);
    const expectedGeneration = Number(input.generation);
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new Error('actionId, revision, and generation are required for Action input');
    }
    const graphMode = workItem.workflowSnapshot?.executionMode === 'graph';
    const concurrentMode = graphMode || workItem.coordinationMode === 'dynamic';
    const targetMatches = targetAction?.workItemId === id
      && targetAction.generation === expectedGeneration
      && (concurrentMode || workItem.currentActionId === input.actionId);
    if (!targetMatches || workItem.revision !== input.revision) {
      const error = new Error('Action changed before input was applied; refresh and try again');
      error.code = 'WORK_CENTER_INPUT_STALE';
      throw error;
    }
    if (['ready', 'running'].includes(targetAction.status)) {
      if (targetAction.status === 'running' && addedAttachmentCount > 0) {
        throw new Error('Files cannot be added while an Action is running; send text now or wait for the next Action boundary');
      }
      const inputSummary = text || `The user added ${addedAttachmentCount} attachment(s) as additional context for this Action.`;
      return this.store.addActionInput(id, inputSummary, {
        actionId: input.actionId,
        generation: expectedGeneration,
        revision: input.revision,
      }, input.attachments, input.addedAttachments, input.clientMessageId, quote);
    }
    if (!['waiting', 'failed'].includes(targetAction.status)) {
      const error = new Error(`Action in ${targetAction.status} cannot accept input`);
      error.code = 'WORK_CENTER_INPUT_STALE';
      throw error;
    }
    return this.retry(id, {
      answer: text,
      addedAttachmentCount,
      expected: { actionId: input.actionId, generation: input.generation, revision: input.revision },
      attachments: input.attachments,
      inputEvent: {
        inputId: input.clientMessageId || randomUUID(),
        clientMessageId: input.clientMessageId || null,
        targetActionId: input.actionId,
        text: text || `The user added ${addedAttachmentCount} attachment(s) as additional context for this Action.`,
        quote,
        attachments: input.addedAttachments,
      },
    });
  }

  retry(id, input = {}) {
    const answer = typeof input.answer === 'string' ? input.answer.trim().slice(0, 8_000) : '';
    const addedAttachmentCount = Math.max(0, Number(input.addedAttachmentCount) || 0);
    const detail = this.store.retryWorkItemAtomic(id, (workItem, previous, previousRun) => {
      if (previous?.status === 'waiting' && !answer && addedAttachmentCount === 0) {
        throw new Error('answer or attachments are required to resume a waiting Action');
      }
      const context = withoutActionInputContext(previous?.context);
      if (previousRun) {
        context.push({
          type: previous.type,
          stageId: previous.stageId || previous.type,
          vpId: previousRun.vpSnapshot?.id || previous.requiredRole || null,
          role: previousRun.roleSnapshot?.id || previous.requiredRole || null,
          summary: previousRun.summary || '',
          evidence: normalizeEvidence(previousRun.evidence),
          waitingReason: previousRun.waitingReason || null,
          answer: answer || (addedAttachmentCount > 0
            ? `The user added ${addedAttachmentCount} attachment(s) as additional context for this Action.`
            : null),
          quote: input.inputEvent?.quote || null,
        });
      }
      if (Number(workItem.executionSchemaVersion) >= 2 && input.inputEvent?.inputId) {
        context.push({
          type: 'input',
          role: 'user',
          inputId: input.inputEvent.inputId,
          summary: input.inputEvent.text || '',
          quote: input.inputEvent.quote || null,
          attachments: Array.isArray(input.inputEvent.attachments) ? input.inputEvent.attachments : [],
          evidence: [],
        });
      }
      return previous
        ? canonicalReplacementAction(workItem, previous, context)
        : { ...initialActionFor(workItem), context };
    }, {
      expected: input.expected || null,
      attachments: input.attachments,
      inputEvent: input.inputEvent || null,
    });
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  submit(runId, ownerBootId, leaseEpoch, rawResult) {
    const activeRun = this.store.getRun(runId);
    const activeAction = activeRun ? this.store.getAction(activeRun.actionId) : null;
    if (!activeRun || !activeAction) throw new Error('Run is stale, cancelled, or already finished');
    const activeWorkItem = this.store.getWorkItem(activeRun.workItemId);
    if (activeRun.acceptingInput !== false
        && !this.store.closeRunInput(runId, ownerBootId, leaseEpoch)) {
      if (!this.store.isActiveRun(runId, ownerBootId, leaseEpoch)) {
        throw new Error('Run is stale, cancelled, expired, or already finished');
      }
      throw new Error('Run has unconsumed Action input and cannot finish yet');
    }
    const result = normalizeTerminalResult(rawResult, activeAction);
    if (isDynamicWorkItem(activeWorkItem)) {
      result.contractPatch = null;
      result.plan = null;
      result.planProposal = null;
      result.replanRequest = null;
      result.replanMutation = null;
      result.nextActions = [];
      result.expandPlan = null;
    }
    if (result.outcome === 'completed'
        && activeAction.stageId?.startsWith('replan-')
        && !result.replanMutation) {
      result.outcome = 'failed';
      result.error = 'Work Center replan triage must submit SubmitWorkItemReplan';
    }
    validateCompletedResult(result, activeAction, activeWorkItem);
    let validatedGeneratedWorkflow = null;
    if (result.outcome === 'completed'
        && activeAction.type === 'triage'
        && !activeAction.stageId?.startsWith('replan-')
        && activeRun
        && this.store.getWorkItem(activeRun.workItemId)?.workflowSnapshot?.planningMode === 'ai') {
      const current = this.store.getWorkItem(activeRun.workItemId);
      const effective = result.contractPatch
        ? {
            ...current,
            title: result.contractPatch.title ?? current.title,
            goal: result.contractPatch.goal ?? current.goal,
            acceptanceCriteria: result.contractPatch.acceptanceCriteria ?? current.acceptanceCriteria,
          }
        : current;
      try {
        const reservedStageIds = activeAction.stageId?.startsWith('replan-')
          ? this.store.getWorkItemDetail(activeWorkItem.id).actions.map(action => action.stageId)
          : [];
        validatedGeneratedWorkflow = applyGeneratedPlan(effective, result.plan, {
          availableVpIds: this.listAvailableVpIds?.(),
          reservedStageIds,
        });
      } catch (error) {
        result.outcome = 'failed';
        result.error = error?.message || String(error);
      }
    }
    let validatedPlanProposal = null;
    if (result.outcome === 'completed' && result.planProposal) {
      try {
        validatedPlanProposal = applyAdditivePlanProposal({
          workItem: activeWorkItem,
          actions: this.store.getWorkItemDetail(activeWorkItem.id).actions,
          proposal: result.planProposal,
          availableVpIds: this.listAvailableVpIds?.(),
          reviewAction: activeAction.type === 'review'
            && result.reviewDecision === 'changes_requested'
            ? activeAction
            : null,
        });
      } catch (error) {
        result.outcome = 'failed';
        result.error = error?.message || String(error);
      }
    }
    let validatedReplanMutation = null;
    let staleReplanMutation = null;
    if (result.outcome === 'completed' && result.replanMutation) {
      const currentWorkItem = this.store.getWorkItem(activeWorkItem.id);
      if (Number(result.replanMutation.basePlanRevision) !== currentWorkItem.planRevision) {
        staleReplanMutation = result.replanMutation;
      } else {
        try {
          validatedReplanMutation = applyReplanMutation({
            workItem: currentWorkItem,
            action: activeAction,
            actions: this.store.getWorkItemDetail(activeWorkItem.id).actions,
            proposal: result.replanMutation,
            availableVpIds: this.listAvailableVpIds?.(),
          });
        } catch (error) {
          result.outcome = 'failed';
          result.error = error?.message || String(error);
        }
      }
    }
    if (result.outcome === 'completed' && result.replanRequest) {
      const basePlanRevision = Number(result.replanRequest.basePlanRevision);
      const proposalId = typeof result.replanRequest.proposalId === 'string'
        ? result.replanRequest.proposalId.trim().slice(0, 128) : '';
      const reason = typeof result.replanRequest.reason === 'string'
        ? result.replanRequest.reason.trim().slice(0, 4_000) : '';
      if (!proposalId || !reason || basePlanRevision !== activeWorkItem.planRevision) {
        result.outcome = 'failed';
        result.error = 'Work Center replan request is missing fields or has a stale basePlanRevision';
      } else {
        result.replanRequest = { proposalId, reason, basePlanRevision };
      }
    }
    const detail = this.store.finalizeRun(
      runId,
      ownerBootId,
      leaseEpoch,
      result,
      ({ action, workItem }) => {
        if (result.outcome === 'waiting') {
          return {
            actionStatus: 'waiting',
            workItemStatus: 'waiting',
            keepCurrentAction: true,
            eventType: 'action.waiting',
            graphAdvance: workItem.workflowSnapshot?.executionMode === 'graph',
            eventData: { reason: result.waitingReason },
          };
        }

        if (result.outcome === 'retryable') {
          const retryable = action.attempt < action.maxAttempts;
          return {
            actionStatus: retryable ? 'ready' : 'failed',
            workItemStatus: retryable ? 'ready' : 'needs_attention',
            keepCurrentAction: true,
            eventType: retryable ? 'action.retry_scheduled' : 'action.retry_exhausted',
            graphAdvance: workItem.workflowSnapshot?.executionMode === 'graph',
            eventData: {
              attempt: action.attempt,
              maxAttempts: action.maxAttempts,
              error: result.error,
            },
          };
        }

        if (result.outcome === 'failed') {
          return {
            actionStatus: 'failed',
            workItemStatus: 'needs_attention',
            keepCurrentAction: true,
            eventType: result.failureKind === 'system_blocked' ? 'action.system_blocked' : 'action.failed',
            graphAdvance: workItem.workflowSnapshot?.executionMode === 'graph',
            eventData: {
              error: result.error,
              failureKind: result.failureKind,
              failureCode: result.failureCode,
            },
          };
        }

        const contractPatch = action.type === 'triage' ? result.contractPatch : null;
        const effectiveWorkItem = contractPatch
          ? {
              ...workItem,
              title: contractPatch.title ?? workItem.title,
              goal: contractPatch.goal ?? workItem.goal,
              acceptanceCriteria: contractPatch.acceptanceCriteria ?? workItem.acceptanceCriteria,
              revision: workItem.revision + 1,
            }
          : workItem;
        const generatedWorkflow = action.type === 'triage'
          && workItem.workflowSnapshot?.planningMode === 'ai'
          ? validatedGeneratedWorkflow
          : null;
        const planProposal = workItem.planRevision === activeWorkItem.planRevision
          ? validatedPlanProposal
          : null;
        if (validatedPlanProposal && !planProposal) {
          throw new Error('Work Center plan revision changed before finalization');
        }
        const plannedWorkItem = generatedWorkflow
          ? { ...effectiveWorkItem, workflowSnapshot: generatedWorkflow }
          : planProposal
            ? { ...effectiveWorkItem, workflowSnapshot: planProposal.workflowSnapshot }
            : effectiveWorkItem;
        const context = [...withoutActionInputContext(action.context), contextEntry(action, result, activeRun)];
        if (plannedWorkItem.workflowSnapshot?.executionMode === 'graph') {
          if (staleReplanMutation) {
            return {
              actionStatus: 'completed', workItemStatus: 'needs_attention', graphAdvance: false,
              keepCurrentAction: true,
              planConflict: {
                kind: 'plan_revision',
                proposalId: staleReplanMutation.proposalId,
                expectedPlanRevision: staleReplanMutation.basePlanRevision,
                actualPlanRevision: workItem.planRevision,
              },
              eventType: 'workflow.plan_conflict',
              eventData: { proposalId: staleReplanMutation.proposalId },
            };
          }
          if (validatedReplanMutation) {
            return {
              actionStatus: 'completed', workItemStatus: 'ready', graphAdvance: true,
              workflowSnapshot: validatedReplanMutation.workflowSnapshot,
              expectedPlanRevision: validatedReplanMutation.basePlanRevision,
              proposalId: validatedReplanMutation.proposalId,
              replanMutation: validatedReplanMutation,
              eventType: 'workflow.replanned',
              eventData: {
                retainedActionCount: validatedReplanMutation.retain.length,
                replacedActionCount: validatedReplanMutation.replace.length,
                removedActionCount: validatedReplanMutation.remove.length,
                addedActionCount: validatedReplanMutation.add.length,
              },
            };
          }
          if (result.replanRequest) {
            const replanStage = {
              ...plannedWorkItem.workflowSnapshot.stages[0],
              id: `replan-${workItem.planRevision + 1}`,
              name: 'Replan',
              type: 'triage',
              objective: 'Replan the unfinished WorkItem graph without changing completed history.',
              approach: `Inspect completed evidence and this replan reason: ${result.replanRequest.reason}`,
              expectedOutcome: 'A validated replacement plan for all unfinished work.',
              dependsOnStageIds: [],
            };
            return {
              actionStatus: 'completed', workItemStatus: 'ready', graphAdvance: true,
              replanBarrier: {
                ...result.replanRequest,
                action: actionForStage(replanStage, plannedWorkItem, context),
              },
              eventType: 'workflow.replan_requested',
              eventData: { reason: result.replanRequest.reason },
            };
          }
          if (action.type === 'review' && result.reviewDecision === 'changes_requested' && !planProposal) {
            const targetStage = plannedWorkItem.workflowSnapshot.stages
              .find(stage => stage.id === action.changesRequestedStageId);
            if (!targetStage) throw new Error('Work Center review return target is missing');
            return {
              actionStatus: 'completed', workItemStatus: 'ready', graphAdvance: true,
              graphResetStageId: action.changesRequestedStageId,
              graphResetAction: actionForStage(targetStage, plannedWorkItem, context),
              eventType: 'review.changes_requested',
              eventData: { targetStageId: action.changesRequestedStageId },
            };
          }
          const nextActions = generatedWorkflow
            ? generatedWorkflow.stages.slice(1).map(stage => actionForStage(stage, plannedWorkItem, context))
            : (planProposal?.nextActions || []);
          const workflowSnapshot = generatedWorkflow || planProposal?.workflowSnapshot || null;
          return {
            actionStatus: 'completed',
            workItemStatus: nextActions.length > 0 ? 'ready' : 'running',
            contractPatch,
            workflowSnapshot,
            expectedPlanRevision: generatedWorkflow ? workItem.planRevision : planProposal?.basePlanRevision,
            proposalId: generatedWorkflow ? `initial:${runId}` : planProposal?.proposalId,
            dependencyPatches: planProposal?.dependencyPatches || [],
            nextActions,
            graphAdvance: true,
            eventType: planProposal ? 'workflow.plan_expanded' : 'action.completed',
            eventData: { nextActionCount: nextActions.length, reviewDecision: result.reviewDecision },
          };
        }

        const nextStep = getNextStep(plannedWorkItem, action.stageId || action.type, result);
        if (!nextStep) {
          return {
            actionStatus: 'completed',
            workItemStatus: 'done',
            contractPatch,
            workflowSnapshot: generatedWorkflow,
            expectedPlanRevision: generatedWorkflow ? workItem.planRevision : undefined,
            proposalId: generatedWorkflow ? `initial:${runId}` : undefined,
            eventType: 'work_item.completed',
            eventData: { summary: result.summary },
          };
        }

        return {
          actionStatus: 'completed',
          workItemStatus: 'ready',
          contractPatch,
          workflowSnapshot: generatedWorkflow,
          expectedPlanRevision: generatedWorkflow ? workItem.planRevision : undefined,
          proposalId: generatedWorkflow ? `initial:${runId}` : undefined,
          nextAction: actionForStage(nextStep, plannedWorkItem, context),
          eventType: 'action.completed',
          eventData: {
            nextActionType: nextStep.type,
            reviewDecision: result.reviewDecision,
          },
        };
      },
    );
    if (!detail) throw new Error('Run is stale, cancelled, expired, or already finished');
    return detail;
  }
}
